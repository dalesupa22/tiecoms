package com.tiecoms.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import java.time.Instant
import java.util.UUID
import kotlin.random.Random

enum class SessionStatus { LOADING, ANONYMOUS, READY, UNREACHABLE }

data class ConversationState(
    val messages: List<MessageDTO> = emptyList(),
    /** Cursor continuo: nunca avanza sobre un hueco. */
    val lastEventSeq: Long = 0,
    val hasMore: Boolean = true,
    val loaded: Boolean = false,
    val loading: Boolean = false,
)

data class TypingEntry(val userId: String, val until: Long)

data class ClientState(
    val status: SessionStatus = SessionStatus.LOADING,
    val connection: ConnectionStatus = ConnectionStatus.OFFLINE,
    val data: BootstrapDTO? = null,
    val conversations: Map<String, ConversationState> = emptyMap(),
    val pending: List<PendingMessage> = emptyList(),
    val typing: Map<String, List<TypingEntry>> = emptyMap(),
    /** Asuntos conocidos por id (se cargan por espacio, conversación o «míos» y se actualizan en vivo). */
    val issues: Map<String, IssueDTO> = emptyMap(),
    /** Mensajes fijados por conversación. */
    val pins: Map<String, List<String>> = emptyMap(),
    val reminders: List<ReminderDTO> = emptyList(),
    val events: Map<String, CalendarEventDTO> = emptyMap(),
    /** Sube cuando el puente de WhatsApp trae novedades: la pantalla vuelve a pedir la lista. */
    val waRevision: Int = 0,
    /** Sube cuando cambia algún árbol de archivos (`drive.updated`): la pantalla Archivos recarga. */
    val driveRevision: Int = 0,
    val blockedUserIds: Set<String> = emptySet(),
)

/** Avisos puntuales para sonidos y notificaciones. */
sealed interface ClientSignal {
    /** Mensaje de otra persona recibido EN VIVO (no en la recuperación masiva). */
    data class Incoming(val message: MessageDTO) : ClientSignal
    /** El servidor confirmó un mensaje propio. */
    data class Sent(val message: MessageDTO) : ClientSignal
    data object SignedOut : ClientSignal
    /** Recordatorio vencido (evento de cuenta `reminder.due`). */
    data class ReminderDue(val reminder: ReminderDTO) : ClientSignal
    /** Reunión nueva, movida o cancelada por otra persona, en vivo. kind: created | moved | cancelled */
    data class CalendarChanged(val event: CalendarEventDTO, val kind: String) : ClientSignal
}

private enum class RefreshOutcome { OK, UNAUTHORIZED, NETWORK }

/**
 * Cliente TieComs independiente de la interfaz (mismo comportamiento que
 * packages/client-core): cola persistente, reintentos idempotentes con
 * clientMessageId, cursores lastEventSeq, catch-up con /events?after= y resetRequired.
 *
 * Todo el estado se muta en un único hilo lógico ([dispatcher]); las llamadas de red
 * son asíncronas y no lo bloquean.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TieComsClient(
    baseUrl: String,
    private val deviceName: String,
    private val storage: KeyValueStorage,
    private val secrets: SecretStore,
    okHttp: OkHttpClient,
    private val now: () -> Long = System::currentTimeMillis,
) {
    val http = HttpApi(baseUrl, okHttp)
    val baseUrl: String get() = http.baseUrl
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val _state = MutableStateFlow(ClientState())
    val state: StateFlow<ClientState> = _state.asStateFlow()
    private val _signals = MutableSharedFlow<ClientSignal>(extraBufferCapacity = 64)
    val signals: SharedFlow<ClientSignal> = _signals.asSharedFlow()

    private var accessToken: String? = null
    private var accessExp = 0L
    private var refreshing: Deferred<RefreshOutcome>? = null
    private var flushJob: Job? = null
    private var bootstrapJob: Job? = null
    private var startRetryJob: Job? = null
    private val readJobs = HashMap<String, Job>()
    private val catchingUp = HashSet<String>()
    private var flushing = false
    private var lastTypingSent = 0L

    /** Diferencia reloj servidor − reloj local (de /bootstrap serverTime). */
    private var serverOffset = 0L
    /** Hora (del servidor) desde la que la conexión actual está en vivo; lo anterior es recuperación. */
    private var liveSince = Long.MAX_VALUE

    /** Contadores de diagnóstico (pruebas): por dónde salió cada mensaje. */
    @Volatile var sentViaSocket = 0; private set
    @Volatile var sentViaHttp = 0; private set

    private val socket = RealtimeSocket(
        okHttp.newBuilder().readTimeout(java.time.Duration.ZERO).build(),
        { http.socketUrl() },
        scope,
        object : RealtimeSocket.Listener {
            override suspend fun accessToken(): String? {
                if (accessToken == null || now() > accessExp - 30_000) refresh()
                return accessToken
            }
            override fun onStatus(status: ConnectionStatus) = setState { copy(connection = status) }
            override fun onEvent(name: String, args: List<JsonElement>) = onSocketEvent(name, args)
            override suspend fun onUnauthorized(): Boolean = when (refresh()) {
                RefreshOutcome.OK -> true
                RefreshOutcome.NETWORK -> true
                RefreshOutcome.UNAUTHORIZED -> { handleSignedOut(); false }
            }
        },
    )

    private inline fun setState(f: ClientState.() -> ClientState) { _state.value = _state.value.f() }
    private val s get() = _state.value

    private fun setConv(id: String, f: ConversationState.() -> ConversationState) = setState {
        copy(conversations = conversations + (id to (conversations[id] ?: ConversationState()).f()))
    }

    private fun patchMeta(id: String, f: ConversationDTO.() -> ConversationDTO) = setState {
        val d = data ?: return@setState this
        copy(data = d.copy(conversations = d.conversations.map { if (it.id == id) it.f() else it }))
    }

    fun meta(id: String): ConversationDTO? = s.data?.conversations?.firstOrNull { it.id == id }
    val myId: String? get() = s.data?.me?.id

    // ---------- HTTP con sesión ----------
    private suspend fun <T> request(method: String, path: String, body: String? = null, serializer: KSerializer<T>, raw: HttpApi.RawBody? = null): T {
        if (accessToken != null && now() > accessExp - 30_000) refresh()
        var r = http.exec(method, path, body, accessToken, raw)
        if (r.code == 401) {
            when (refresh()) {
                RefreshOutcome.OK -> r = http.exec(method, path, body, accessToken, raw)
                RefreshOutcome.UNAUTHORIZED -> { handleSignedOut(); throw HttpApi.parseError(r) }
                RefreshOutcome.NETWORK -> throw HttpApi.parseError(r)
            }
            if (r.code == 401) { handleSignedOut(); throw HttpApi.parseError(r) }
        }
        if (!r.ok) throw HttpApi.parseError(r)
        return TcJson.decodeFromString(serializer, r.body.ifBlank { "{}" })
    }

    private suspend fun requestUnit(method: String, path: String, body: String? = null) {
        request(method, path, body, JsonElement.serializer())
    }

    // ---------- Sesión ----------
    private fun deviceId(): String = storage.get("device:id") ?: UUID.randomUUID().toString().also { storage.set("device:id", it) }
    private fun device() = DeviceInfo(deviceId = deviceId(), name = deviceName.take(120))

    private fun applyAuth(r: AuthResult) {
        accessToken = r.accessToken
        accessExp = runCatching { Instant.parse(r.accessExpiresAt).toEpochMilli() }.getOrElse { now() + 10 * 60_000 }
        r.refreshToken?.let { secrets.set(it) }
    }

    /** Arranque: intenta reanudar la sesión guardada. */
    suspend fun start() = withContext(dispatcher) {
        startRetryJob?.cancel()
        setState { copy(status = SessionStatus.LOADING) }
        if (secrets.get() == null) { setState { copy(status = SessionStatus.ANONYMOUS) }; return@withContext }
        when (refresh()) {
            RefreshOutcome.OK -> try { afterLogin() } catch (e: NetworkException) { unreachable() }
            RefreshOutcome.UNAUTHORIZED -> setState { copy(status = SessionStatus.ANONYMOUS) }
            RefreshOutcome.NETWORK -> unreachable()
        }
    }

    private var startAttempts = 0
    private fun unreachable() {
        setState { copy(status = SessionStatus.UNREACHABLE) }
        val wait = minOf(30_000L, 1000L shl minOf(startAttempts++, 5))
        startRetryJob = scope.launch { delay(wait); start() }
    }

    suspend fun login(email: String, password: String) = withContext(dispatcher) {
        val body = TcJson.encodeToString(LoginBody.serializer(), LoginBody(email.trim(), password, device()))
        val r = http.exec("POST", "$AUTH_BASE_PATH/login", body)
        if (!r.ok) throw HttpApi.parseError(r)
        applyAuth(TcJson.decodeFromString(AuthResult.serializer(), r.body))
        afterLogin()
    }

    suspend fun signup(name: String, email: String, password: String, orgName: String?, orgInviteToken: String?, title: String?) = withContext(dispatcher) {
        val body = TcJson.encodeToString(
            SignupBody.serializer(),
            SignupBody(name.trim(), email.trim(), password, orgName?.trim()?.ifEmpty { null }, orgInviteToken, title?.trim()?.ifEmpty { null }, device()),
        )
        val r = http.exec("POST", "$AUTH_BASE_PATH/signup", body)
        if (!r.ok) throw HttpApi.parseError(r)
        applyAuth(TcJson.decodeFromString(AuthResult.serializer(), r.body))
        afterLogin()
    }

    // ---------- SSO (Google / Microsoft) con PKCE ----------
    /** Prepara el intento (verifier guardado en disco) y devuelve la URL a abrir en Custom Tabs. */
    fun beginSso(provider: SsoProvider, orgInviteToken: String? = null, orgName: String? = null): String {
        val verifier = Pkce.newVerifier()
        storage.set(SSO_KEY, TcJson.encodeToString(SsoAttempt.serializer(), SsoAttempt(provider.path, verifier, now())))
        return Sso.startUrl(baseUrl, provider, deviceId(), Pkce.challenge(verifier), orgInviteToken, orgName)
    }

    fun hasSsoAttempt(): Boolean = storage.get(SSO_KEY) != null

    /** Canjea el código de un solo uso (60 s) por la misma sesión que devuelve el login. */
    suspend fun completeSso(code: String) = withContext(dispatcher) {
        val attempt = storage.get(SSO_KEY)?.let { runCatching { TcJson.decodeFromString(SsoAttempt.serializer(), it) }.getOrNull() }
        storage.set(SSO_KEY, null)
        if (attempt == null || now() - attempt.startedAt > 15 * 60_000) throw ApiException(400, "sso_expired", "")
        val body = TcJson.encodeToString(SsoExchangeBody.serializer(), SsoExchangeBody(code, attempt.verifier, device()))
        val r = http.exec("POST", "$AUTH_BASE_PATH/sso/exchange", body)
        if (!r.ok) throw HttpApi.parseError(r)
        applyAuth(TcJson.decodeFromString(AuthResult.serializer(), r.body))
        afterLogin()
    }

    fun clearSso() = storage.set(SSO_KEY, null)

    /** Refresco con vuelo único; rota el refresh token. */
    private suspend fun refresh(): RefreshOutcome {
        refreshing?.let { return it.await() }
        val d = scope.async {
            val stored = secrets.get() ?: return@async RefreshOutcome.UNAUTHORIZED
            val r = try {
                http.exec("POST", "$AUTH_BASE_PATH/refresh", TcJson.encodeToString(RefreshBody.serializer(), RefreshBody(stored)))
            } catch (e: NetworkException) { return@async RefreshOutcome.NETWORK }
            when {
                r.ok -> { applyAuth(TcJson.decodeFromString(AuthResult.serializer(), r.body)); RefreshOutcome.OK }
                r.code == 401 || r.code == 400 || r.code == 403 -> { accessToken = null; secrets.set(null); RefreshOutcome.UNAUTHORIZED }
                else -> RefreshOutcome.NETWORK
            }
        }
        refreshing = d
        try { return d.await() } finally { if (refreshing === d) refreshing = null }
    }

    suspend fun logout() = withContext(dispatcher) {
        try { requestUnit("POST", "$AUTH_BASE_PATH/logout", "{}") } catch (_: Exception) {}
        handleSignedOut()
    }

    private fun handleSignedOut() {
        val me = s.data?.me?.id
        socket.stop()
        flushJob?.cancel(); bootstrapJob?.cancel(); startRetryJob?.cancel()
        readJobs.values.forEach { it.cancel() }; readJobs.clear()
        accessToken = null
        secrets.set(null)
        if (me != null) storage.clearPrefix("u:$me:")
        val wasSignedIn = s.status != SessionStatus.ANONYMOUS
        _state.value = ClientState(status = SessionStatus.ANONYMOUS)
        if (wasSignedIn) _signals.tryEmit(ClientSignal.SignedOut)
    }

    private suspend fun afterLogin() {
        startAttempts = 0
        loadBootstrapInternal()
        // Load safety preferences before showing content or starting realtime.
        loadBlocks()
        val me = s.data!!.me.id
        val saved = storage.get("u:$me:outbox")?.let { runCatching { TcJson.decodeFromString(ListSerializer(PendingMessage.serializer()), it) }.getOrNull() } ?: emptyList()
        setState { copy(status = SessionStatus.READY, pending = saved.map { if (it.status == "sending") it.copy(status = "pending") else it }) }
        socket.start()
        scheduleFlush(0)
        scope.launch { runCatching { loadRemindersInternal() } }
    }

    // ---------- Snapshot ----------
    suspend fun loadBootstrap(): BootstrapDTO = withContext(dispatcher) { loadBootstrapInternal() }

    private suspend fun loadBootstrapInternal(): BootstrapDTO {
        val data = request("GET", "/bootstrap", null, BootstrapDTO.serializer())
        runCatching { Instant.parse(data.serverTime).toEpochMilli() }.getOrNull()?.let { serverOffset = it - now() }
        val sorted = data.copy(conversations = data.conversations.sortedByDescending { it.lastMessageAt ?: "" })
        // Conversaciones que ya no están en mi alcance: se purgan de la caché local.
        val allowed = sorted.conversations.map { it.id }.toSet()
        setState { copy(data = sorted, conversations = conversations.filterKeys { it in allowed }) }
        return sorted
    }

    private fun scheduleBootstrap() {
        if (bootstrapJob?.isActive == true) return
        bootstrapJob = scope.launch { delay(250); runCatching { loadBootstrapInternal() } }
    }

    // ---------- Tiempo real ----------
    private fun onSocketEvent(name: String, args: List<JsonElement>) {
        val payload = args.firstOrNull() ?: return
        when (name) {
            "ready" -> { liveSince = now() + serverOffset; scope.launch { resyncInternal() } }
            "conv.event" -> decodeConversationEvent(payload)?.let { onConversationEvent(it) }
            "account.event" -> onAccountEvent(decodeAccountEvent(payload))
            "typing" -> {
                val o = payload as? JsonObject ?: return
                val conv = (o["conversationId"] as? JsonPrimitive)?.contentOrNull ?: return
                val user = (o["userId"] as? JsonPrimitive)?.contentOrNull ?: return
                if (user == myId) return
                val t = now()
                setState {
                    val list = (typing[conv] ?: emptyList()).filter { it.until > t && it.userId != user } + TypingEntry(user, t + 4000)
                    copy(typing = typing + (conv to list))
                }
                scope.launch {
                    delay(4100)
                    val t2 = now()
                    setState { copy(typing = typing.mapValues { (_, l) -> l.filter { it.until > t2 } }.filterValues { it.isNotEmpty() }) }
                }
            }
        }
    }

    /** Tras reconectar o volver a primer plano: snapshot + recuperación de huecos + cola. */
    suspend fun resync() = withContext(dispatcher) { resyncInternal() }

    private suspend fun resyncInternal() {
        if (s.status != SessionStatus.READY) return
        try {
            loadBootstrapInternal()
            runCatching { loadBlocks() }
            for (c in s.data?.conversations ?: emptyList()) {
                val local = s.conversations[c.id]
                if (local?.loaded == true && c.lastEventSeq > local.lastEventSeq) scope.launch { catchUp(c.id) }
            }
        } catch (_: Exception) {}
        scheduleFlush(0)
    }

    /** Volver a primer plano o recuperar la red. */
    fun wake(forceReconnect: Boolean = false) {
        scope.launch {
            when (s.status) {
                SessionStatus.READY -> {
                    if (s.connection == ConnectionStatus.ONLINE && !forceReconnect) resyncInternal()
                    else socket.reconnectNow(force = forceReconnect)
                    scheduleFlush(0)
                }
                SessionStatus.UNREACHABLE -> start()
                else -> Unit
            }
        }
    }

    private fun onAccountEvent(e: AccountEvent) {
        when (e) {
            is AccountEvent.ScopeChanged -> {
                scope.launch { runCatching { loadBlocks() }; scheduleBootstrap() }
            }
            is AccountEvent.ReadUpdated -> {
                val c = meta(e.conversationId) ?: return
                if (e.seq > c.lastReadSeq) patchMeta(c.id) {
                    copy(lastReadSeq = e.seq, unread = maxOf(0L, lastMessageSeq - maxOf(e.seq, historyFromSeq)).toInt())
                }
            }
            is AccountEvent.ReminderDue -> {
                setState { copy(reminders = (reminders.filter { it.id != e.reminder.id } + e.reminder).sortedBy { it.remindAt }) }
                _signals.tryEmit(ClientSignal.ReminderDue(e.reminder))
            }
            is AccountEvent.PrefsUpdated -> scheduleBootstrap()
            is AccountEvent.WhatsAppUpdated -> setState { copy(waRevision = waRevision + 1) }
            is AccountEvent.DriveUpdated -> setState { copy(driveRevision = driveRevision + 1) }
            is AccountEvent.Unknown -> Unit
        }
    }

    private fun onConversationEvent(e: ConversationEvent) {
        val meta = meta(e.conversationId)
        if (meta == null) { scheduleBootstrap(); return }
        val muted = meta.mutedAt(now())
        // Asuntos, fijados y reuniones se actualizan aunque la conversación no esté abierta.
        when (e) {
            is ConversationEvent.IssueUpdated -> { putIssues(listOf(e.issue)); recountIssues(e.conversationId) }
            is ConversationEvent.PinsChanged -> setState { copy(pins = pins + (e.conversationId to e.messageIds)) }
            is ConversationEvent.CalendarUpdated -> {
                val prev = s.events[e.event.id]
                putEvents(listOf(e.event))
                val ev = e.event
                val invited = ev.invitees.any { it.userId == myId }
                val kind = when {
                    prev == null && ev.cancelledAt == null -> "created"
                    prev != null && prev.cancelledAt == null && ev.cancelledAt != null -> "cancelled"
                    prev != null && prev.startsAt != ev.startsAt -> "moved"
                    else -> null
                }
                val fresh = runCatching { Instant.parse(ev.updatedAt).toEpochMilli() }.getOrDefault(0L) >= liveSince
                if (kind != null && invited && ev.organizerId != myId && !muted && fresh) _signals.tryEmit(ClientSignal.CalendarChanged(ev, kind))
            }
            else -> Unit
        }
        if (e is ConversationEvent.MessageCreated) {
            val fresh = bumpMeta(e.message)
            // Solo suena lo creado con la conexión ya en vivo: si el despacho del servidor llega tarde
            // con mensajes escritos mientras estábamos desconectados, eso cuenta como recuperación.
            val createdAt = runCatching { Instant.parse(e.message.createdAt).toEpochMilli() }.getOrDefault(Long.MAX_VALUE)
            // Silenciada: sin sonido ni notificación.
            if (fresh && !muted && e.message.authorId != myId && e.message.authorId !in s.blockedUserIds && e.message.kind != "system" && createdAt >= liveSince) _signals.tryEmit(ClientSignal.Incoming(e.message))
        }
        val local = s.conversations[e.conversationId]
        if (local?.loaded != true) {
            patchMeta(e.conversationId) { copy(lastEventSeq = maxOf(lastEventSeq, e.eventSeq)) }
            return
        }
        if (e.eventSeq <= local.lastEventSeq) return // duplicado de transporte
        if (e.eventSeq > local.lastEventSeq + 1) { scope.launch { catchUp(e.conversationId) }; return } // hueco
        applyEvent(e)
    }

    /** Actualiza la vista previa y los no leídos. Devuelve true si el mensaje es nuevo. */
    private fun bumpMeta(m: MessageDTO): Boolean {
        val c = meta(m.conversationId) ?: return false
        if (m.seq <= c.lastMessageSeq) return false
        val mine = m.authorId == myId
        val lastRead = if (mine) m.seq else c.lastReadSeq
        patchMeta(c.id) {
            copy(
                lastMessageSeq = m.seq, lastMessageAt = m.createdAt, lastMessagePreview = m.body.take(140), lastReadSeq = lastRead,
                unread = maxOf(0L, m.seq - maxOf(lastRead, historyFromSeq)).toInt(),
            )
        }
        setState { copy(data = data?.copy(conversations = data.conversations.sortedByDescending { it.lastMessageAt ?: "" })) }
        return true
    }

    private fun applyEvent(e: ConversationEvent) {
        val local = s.conversations[e.conversationId] ?: return
        var messages = local.messages
        when (e) {
            is ConversationEvent.MessageCreated -> messages = upsertMessage(messages, e.message)
            is ConversationEvent.MessageUpdated -> { messages = upsertMessage(messages, e.message); patchPreviewIfLast(e.message) }
            is ConversationEvent.MembersChanged -> { patchMeta(e.conversationId) { copy(memberIds = e.memberIds) }; scheduleBootstrap() }
            is ConversationEvent.IssueUpdated -> putIssues(listOf(e.issue))
            is ConversationEvent.PinsChanged -> setState { copy(pins = pins + (e.conversationId to e.messageIds)) }
            is ConversationEvent.CalendarUpdated -> putEvents(listOf(e.event))
            is ConversationEvent.CursorOnly -> Unit
        }
        setConv(e.conversationId) { copy(messages = messages, lastEventSeq = maxOf(lastEventSeq, e.eventSeq)) }
        if (e is ConversationEvent.MessageCreated) dropPending(e.message)
    }

    private suspend fun catchUp(conversationId: String) {
        if (!catchingUp.add(conversationId)) return
        try {
            while (true) {
                val local = s.conversations[conversationId] ?: return
                val page = request("GET", "/conversations/$conversationId/events?after=${local.lastEventSeq}&limit=200", null, EventsPageRaw.serializer())
                if (page.resetRequired) { catchingUp.remove(conversationId); openInternal(conversationId, force = true); return }
                val events = page.events.mapNotNull { decodeConversationEvent(it) }.sortedBy { it.eventSeq }
                for (e in events) {
                    val cur = s.conversations[conversationId] ?: return
                    if (e.eventSeq > cur.lastEventSeq) applyEvent(e)
                }
                if (page.events.size < 200) return
            }
        } catch (_: Exception) {
        } finally { catchingUp.remove(conversationId) }
    }

    // ---------- Conversaciones ----------
    suspend fun openConversation(id: String, force: Boolean = false) = withContext(dispatcher) { openInternal(id, force) }

    private suspend fun openInternal(id: String, force: Boolean) {
        val local = s.conversations[id]
        if (local?.loaded == true && !force) { scope.launch { catchUp(id) }; return }
        if (local?.loading == true) return
        setConv(id) { copy(loading = true) }
        try {
            val page = request("GET", "/conversations/$id/messages?limit=50", null, MessagesPage.serializer())
            setConv(id) { copy(messages = page.messages.sortedBy { it.seq }, hasMore = page.hasMore, lastEventSeq = page.lastEventSeq, loaded = true, loading = false) }
            // Eventos que llegaron mientras cargábamos.
            scope.launch { catchUp(id) }
        } catch (e: Exception) {
            setConv(id) { copy(loading = false) }
            throw e
        }
    }

    suspend fun loadOlder(id: String) = withContext(dispatcher) {
        val local = s.conversations[id] ?: return@withContext
        if (!local.loaded || !local.hasMore || local.loading) return@withContext
        val before = local.messages.firstOrNull()?.seq ?: return@withContext
        setConv(id) { copy(loading = true) }
        try {
            val page = request("GET", "/conversations/$id/messages?before=$before&limit=50", null, MessagesPage.serializer())
            setConv(id) {
                val known = messages.map { it.id }.toSet()
                copy(messages = (page.messages.filter { it.id !in known } + messages).sortedBy { it.seq }, hasMore = page.hasMore, loading = false)
            }
        } catch (_: Exception) { setConv(id) { copy(loading = false) } }
    }

    /** Marca leído hasta el último mensaje (con debounce). */
    fun markRead(id: String) {
        scope.launch {
            val c = meta(id) ?: return@launch
            if (c.lastMessageSeq <= c.lastReadSeq && c.unread == 0) return@launch
            patchMeta(id) { copy(lastReadSeq = lastMessageSeq, unread = 0) }
            readJobs[id]?.cancel()
            readJobs[id] = scope.launch {
                delay(400)
                val seq = meta(id)?.lastReadSeq ?: 0
                runCatching { requestUnit("POST", "/conversations/$id/read", TcJson.encodeToString(ReadBody.serializer(), ReadBody(seq))) }
            }
        }
    }

    /** Aviso de escritura: como máximo uno cada 2 s. */
    fun typing(conversationId: String) {
        scope.launch {
            val t = now()
            if (t - lastTypingSent < 2000) return@launch
            lastTypingSent = t
            socket.emit("typing", buildJsonObject { put("conversationId", JsonPrimitive(conversationId)) })
        }
    }

    // ---------- Envío con cola persistente ----------
    fun send(conversationId: String, body: String, replyTo: String? = null, forwarded: ForwardedInfo? = null): String? {
        val text = body.trim()
        if (text.isEmpty()) return null
        val p = PendingMessage(
            clientMessageId = UUID.randomUUID().toString(), conversationId = conversationId, body = text,
            replyTo = replyTo, forwarded = forwarded, createdAt = Instant.ofEpochMilli(now()).toString(),
        )
        // Primero se guarda localmente: si la app se cierra, el mensaje sigue en la cola.
        scope.launch {
            savePending(s.pending + p)
            scheduleFlush(0)
        }
        return p.clientMessageId
    }

    fun retry(clientMessageId: String) {
        scope.launch {
            savePending(s.pending.map { if (it.clientMessageId == clientMessageId) it.copy(status = "pending", nextAttemptAt = 0, error = null) else it })
            scheduleFlush(0)
        }
    }

    fun discard(clientMessageId: String) {
        scope.launch { savePending(s.pending.filter { it.clientMessageId != clientMessageId }) }
    }

    private fun savePending(list: List<PendingMessage>) {
        setState { copy(pending = list) }
        val me = myId ?: return
        storage.set("u:$me:outbox", TcJson.encodeToString(ListSerializer(PendingMessage.serializer()), list))
    }

    private fun dropPending(m: MessageDTO) {
        if (m.authorId != myId || m.clientMessageId == null) return
        if (s.pending.any { it.clientMessageId == m.clientMessageId }) savePending(s.pending.filter { it.clientMessageId != m.clientMessageId })
    }

    private fun scheduleFlush(ms: Long) {
        flushJob?.cancel()
        flushJob = scope.launch { delay(ms); flush() }
    }

    private suspend fun flush() {
        if (flushing || s.status != SessionStatus.READY) return
        flushing = true
        try {
            // En orden: dentro de una conversación, los mensajes salen uno tras otro.
            for (p in s.pending.toList()) {
                if (p.status == "failed" || p.nextAttemptAt > now()) continue
                if (s.pending.none { it.clientMessageId == p.clientMessageId }) continue
                updatePending(p.clientMessageId) { copy(status = "sending") }
                try {
                    val message = deliver(p)
                    if (s.conversations[p.conversationId]?.loaded == true) setConv(p.conversationId) { copy(messages = upsertMessage(messages, message)) }
                    bumpMeta(message)
                    savePending(s.pending.filter { it.clientMessageId != p.clientMessageId })
                    _signals.tryEmit(ClientSignal.Sent(message))
                } catch (e: Exception) {
                    if (s.status != SessionStatus.READY) return
                    val permanent = e is ApiException && e.permanent
                    val attempts = p.attempts + 1
                    val backoff = (minOf(30_000.0, 500.0 * (1 shl minOf(attempts, 6))) * (0.5 + Random.nextDouble())).toLong()
                    updatePending(p.clientMessageId) {
                        if (permanent) copy(status = "failed", attempts = attempts, error = e.message)
                        else copy(status = "pending", attempts = attempts, nextAttemptAt = now() + backoff)
                    }
                    if (!permanent) { flushing = false; savePending(s.pending); scheduleFlush(backoff); return }
                }
            }
        } finally {
            flushing = false
            if (s.status == SessionStatus.READY) savePending(s.pending)
        }
    }

    private fun updatePending(id: String, f: PendingMessage.() -> PendingMessage) =
        setState { copy(pending = pending.map { if (it.clientMessageId == id) it.f() else it }) }

    /** Socket con ACK si está conectado; HTTP como respaldo. Mismo clientMessageId = idempotente. */
    private suspend fun deliver(p: PendingMessage): MessageDTO {
        if (socket.connected) {
            try {
                val payload = TcJson.encodeToJsonElement(SocketSendBody.serializer(), SocketSendBody(p.conversationId, p.clientMessageId, p.body, p.replyTo, p.forwarded))
                val r = socket.emitWithAck("message.send", payload, 8000).firstOrNull() as? JsonObject
                if ((r?.get("ok") as? JsonPrimitive)?.booleanOrNull == true) {
                    val m = r["message"]?.let { runCatching { TcJson.decodeFromJsonElement(MessageDTO.serializer(), it) }.getOrNull() }
                    if (m != null && m.id.isNotEmpty()) { sentViaSocket++; return m }
                } else if (r != null) {
                    val err = r["error"] as? JsonObject
                    val code = (err?.get("code") as? JsonPrimitive)?.contentOrNull ?: "error"
                    val status = when (code) { "forbidden" -> 403; "not_found" -> 404; "conflict" -> 409; "bad_request" -> 400; else -> 503 }
                    throw ApiException(status, code, (err?.get("message") as? JsonPrimitive)?.contentOrNull ?: "No se pudo enviar")
                }
            } catch (e: ApiException) {
                throw e
            } catch (_: TimeoutCancellationException) {
                // Timeout del ACK: se reintenta por HTTP con el mismo identificador.
            } catch (_: SocketNotConnected) {
            }
        }
        val r = request(
            "POST", "/conversations/${p.conversationId}/messages",
            TcJson.encodeToString(SendBody.serializer(), SendBody(p.clientMessageId, p.body, p.replyTo, p.forwarded)), SendResult.serializer(),
        )
        sentViaHttp++
        return r.message ?: throw ApiException(500, "internal", "Respuesta sin mensaje")
    }

    // ---------- JSON genérico ----------
    private suspend fun <T> req(method: String, path: String, body: JsonElement?, ser: KSerializer<T>): T =
        request(method, path, body?.toString() ?: if (method == "GET" || method == "DELETE") null else "{}", ser)

    private fun q(vararg pairs: Pair<String, String?>): String =
        pairs.filter { it.second != null }.joinToString("&", prefix = "?") { "${it.first}=${enc(it.second!!)}" }.let { if (it == "?") "" else it }

    // ---------- Asuntos ----------
    private fun putIssues(list: List<IssueDTO>) {
        if (list.isEmpty()) return
        setState { copy(issues = issues + list.associateBy { it.id }) }
    }
    private fun recountIssues(conversationId: String) {
        val n = s.issues.values.count { it.conversationId == conversationId && !it.closed }
        patchMeta(conversationId) { copy(openIssues = n) }
    }
    suspend fun loadIssues(workspaceId: String? = null, conversationId: String? = null, mine: Boolean = false, open: Boolean = false): List<IssueDTO> = withContext(dispatcher) {
        val r = req("GET", "/issues" + q("workspaceId" to workspaceId, "conversationId" to conversationId, "mine" to if (mine) "1" else null, "open" to if (open) "1" else null), null, IssuesPage.serializer())
        putIssues(r.issues); r.issues
    }
    suspend fun createIssue(conversationId: String, title: String, ownerId: String?, dueDate: String?, originMessageId: String?): IssueDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            put("title", JsonPrimitive(title)); put("ownerId", ownerId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("dueDate", dueDate?.let { JsonPrimitive(it) } ?: JsonNull); put("originMessageId", originMessageId?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        val i = req("POST", "/conversations/$conversationId/issues", body, IssueDTO.serializer())
        putIssues(listOf(i)); recountIssues(conversationId); i
    }
    /** patch: title, status, ownerId, dueDate, waitingOnOrgId (null explícito = borrar). */
    suspend fun updateIssue(id: String, patch: JsonObject): IssueDTO = withContext(dispatcher) {
        val i = req("PATCH", "/issues/$id", patch, IssueDTO.serializer())
        putIssues(listOf(i)); recountIssues(i.conversationId); i
    }
    suspend fun issueDetail(id: String): IssueDetail = withContext(dispatcher) {
        val r = req("GET", "/issues/$id", null, IssueDetail.serializer()); putIssues(listOf(r.issue)); r
    }
    suspend fun commentIssue(id: String, body: String): IssueDTO = withContext(dispatcher) {
        val i = req("POST", "/issues/$id/comments", buildJsonObject { put("body", JsonPrimitive(body)) }, IssueDTO.serializer()); putIssues(listOf(i)); i
    }

    // ---------- Preferencias, fijados, no leído, edición ----------
    /** pinned null = no cambia. mutedUntil: [UNCHANGED] = no cambia, null = reactivar. */
    suspend fun setConversationPrefs(id: String, pinned: Boolean? = null, mutedUntil: String? = UNCHANGED) = withContext(dispatcher) {
        val body = buildJsonObject {
            pinned?.let { put("pinned", JsonPrimitive(it)) }
            if (mutedUntil !== UNCHANGED) put("mutedUntil", mutedUntil?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        val before = meta(id)
        patchMeta(id) {
            var c = this
            if (pinned != null) c = c.copy(pinnedAt = if (pinned) Instant.ofEpochMilli(now()).toString() else null)
            if (mutedUntil !== UNCHANGED) c = c.copy(mutedUntil = mutedUntil)
            c
        }
        try { req("PUT", "/conversations/$id/prefs", body, JsonElement.serializer()) } catch (e: Exception) {
            before?.let { b -> patchMeta(id) { copy(pinnedAt = b.pinnedAt, mutedUntil = b.mutedUntil) } }; throw e
        }
        Unit
    }
    suspend fun setWorkspacePinned(id: String, pinned: Boolean) = withContext(dispatcher) {
        setState { copy(data = data?.copy(workspaces = data.workspaces.map { if (it.id == id) it.copy(pinnedAt = if (pinned) Instant.ofEpochMilli(now()).toString() else null) else it })) }
        req("PUT", "/workspaces/$id/prefs", buildJsonObject { put("pinned", JsonPrimitive(pinned)) }, JsonElement.serializer()); Unit
    }
    suspend fun markUnread(conversationId: String, seq: Long) = withContext(dispatcher) {
        val r = req("POST", "/conversations/$conversationId/unread", buildJsonObject { put("seq", JsonPrimitive(seq)) }, ReadResult.serializer())
        readJobs[conversationId]?.cancel()
        patchMeta(conversationId) { copy(lastReadSeq = r.lastReadSeq, unread = maxOf(0L, lastMessageSeq - maxOf(r.lastReadSeq, historyFromSeq)).toInt()) }
    }
    suspend fun markConversationRead(conversationId: String) = withContext(dispatcher) {
        val c = meta(conversationId) ?: return@withContext
        patchMeta(conversationId) { copy(lastReadSeq = lastMessageSeq, unread = 0) }
        req("POST", "/conversations/$conversationId/read", buildJsonObject { put("seq", JsonPrimitive(c.lastMessageSeq)) }, JsonElement.serializer()); Unit
    }
    private fun patchPreviewIfLast(m: MessageDTO) {
        val c = meta(m.conversationId) ?: return
        if (c.lastMessageSeq == m.seq) patchMeta(c.id) { copy(lastMessagePreview = m.body.take(140)) }
    }
    private fun upsertLocal(m: MessageDTO) {
        if (s.conversations[m.conversationId]?.loaded == true) setConv(m.conversationId) { copy(messages = upsertMessage(messages, m)) }
        patchPreviewIfLast(m)
    }
    suspend fun editMessage(id: String, body: String): MessageDTO = withContext(dispatcher) {
        req("PATCH", "/messages/$id", buildJsonObject { put("body", JsonPrimitive(body)) }, MessageDTO.serializer()).also { upsertLocal(it) }
    }
    suspend fun deleteMessage(id: String): MessageDTO = withContext(dispatcher) {
        req("DELETE", "/messages/$id", null, MessageDTO.serializer()).also { upsertLocal(it) }
    }
    suspend fun setMessagePinned(m: MessageDTO, pinned: Boolean) = withContext(dispatcher) {
        val r = req(if (pinned) "POST" else "DELETE", "/messages/${m.id}/pin", null, PinsResult.serializer())
        setState { copy(pins = pins + (m.conversationId to r.messageIds)) }
    }
    suspend fun loadPins(conversationId: String): List<MessageDTO> = withContext(dispatcher) {
        val r = req("GET", "/conversations/$conversationId/pins", null, PinnedMessages.serializer())
        setState { copy(pins = pins + (conversationId to r.messages.map { it.id })) }
        r.messages
    }

    // ---------- Recordatorios ----------
    private suspend fun loadRemindersInternal(): List<ReminderDTO> {
        val r = req("GET", "/reminders", null, RemindersPage.serializer()); setState { copy(reminders = r.reminders.sortedBy { it.remindAt }) }; return r.reminders
    }
    suspend fun loadReminders(): List<ReminderDTO> = withContext(dispatcher) { loadRemindersInternal() }
    suspend fun createReminder(conversationId: String, messageId: String?, note: String?, remindAt: Instant): ReminderDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            put("conversationId", JsonPrimitive(conversationId)); put("messageId", messageId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("note", note?.let { JsonPrimitive(it.take(300)) } ?: JsonNull); put("remindAt", JsonPrimitive(remindAt.toString()))
        }
        val r = req("POST", "/reminders", body, ReminderDTO.serializer())
        setState { copy(reminders = (reminders.filter { it.id != r.id } + r).sortedBy { it.remindAt }) }; r
    }
    suspend fun completeReminder(id: String) = withContext(dispatcher) {
        req("POST", "/reminders/$id/done", buildJsonObject {}, JsonElement.serializer()); setState { copy(reminders = reminders.filter { it.id != id }) }
    }
    suspend fun snoozeReminder(id: String, until: Instant) = withContext(dispatcher) {
        req("POST", "/reminders/$id/snooze", buildJsonObject { put("until", JsonPrimitive(until.toString())) }, JsonElement.serializer())
        setState { copy(reminders = reminders.map { if (it.id == id) it.copy(remindAt = until.toString(), firedAt = null) else it }.sortedBy { it.remindAt }) }
    }

    // ---------- Agenda ----------
    private fun putEvents(list: List<CalendarEventDTO>) { if (list.isNotEmpty()) setState { copy(events = events + list.associateBy { it.id }) } }
    suspend fun loadEvents(from: Instant, to: Instant, conversationId: String? = null): List<CalendarEventDTO> = withContext(dispatcher) {
        val r = req("GET", "/events" + q("from" to from.toString(), "to" to to.toString(), "conversationId" to conversationId), null, CalendarPage.serializer())
        putEvents(r.events); r.events
    }
    suspend fun getEvent(id: String): CalendarEventDTO = withContext(dispatcher) { req("GET", "/events/$id", null, CalendarEventDTO.serializer()).also { putEvents(listOf(it)) } }
    /** input: title, description, location, startsAt, endsAt, timezone, inviteeIds, originMessageId */
    suspend fun createEvent(conversationId: String, input: JsonObject): CalendarEventDTO = withContext(dispatcher) {
        req("POST", "/conversations/$conversationId/events", input, CalendarEventDTO.serializer()).also { putEvents(listOf(it)) }
    }
    suspend fun updateEvent(id: String, patch: JsonObject): CalendarEventDTO = withContext(dispatcher) { req("PATCH", "/events/$id", patch, CalendarEventDTO.serializer()).also { putEvents(listOf(it)) } }
    suspend fun cancelEvent(id: String): CalendarEventDTO = withContext(dispatcher) { req("DELETE", "/events/$id", null, CalendarEventDTO.serializer()).also { putEvents(listOf(it)) } }
    /** answer: yes | no | maybe */
    suspend fun rsvp(id: String, answer: String): CalendarEventDTO = withContext(dispatcher) {
        req("POST", "/events/$id/rsvp", buildJsonObject { put("rsvp", JsonPrimitive(answer)) }, CalendarEventDTO.serializer()).also { putEvents(listOf(it)) }
    }

    // ---------- Bifurcaciones ----------
    suspend fun derive(conversationId: String, messageId: String, kind: String, name: String?, reason: String?): String = withContext(dispatcher) {
        val body = buildJsonObject {
            put("messageId", JsonPrimitive(messageId)); put("kind", JsonPrimitive(kind))
            name?.takeIf { it.isNotBlank() }?.let { put("name", JsonPrimitive(it)) }; reason?.takeIf { it.isNotBlank() }?.let { put("reason", JsonPrimitive(it)) }
        }
        val r = req("POST", "/conversations/$conversationId/derive", body, IdResult.serializer()); loadBootstrapInternal(); r.id
    }
    suspend fun returnResult(conversationId: String, summary: String): ReturnResult = withContext(dispatcher) {
        val r = req("POST", "/conversations/$conversationId/return", buildJsonObject { put("summary", JsonPrimitive(summary)) }, ReturnResult.serializer())
        loadBootstrapInternal(); r
    }
    /** Carga hacia atrás hasta tener el mensaje con ese seq (para saltar a un mensaje de origen). */
    suspend fun ensureMessage(conversationId: String, seq: Long): Boolean {
        openConversation(conversationId)
        repeat(40) {
            val c = state.value.conversations[conversationId] ?: return false
            if (!c.loaded) return false
            if (c.messages.any { it.seq == seq }) return true
            if (!c.hasMore || (c.messages.firstOrNull()?.seq ?: 0) <= seq) return false
            loadOlder(conversationId)
        }
        return false
    }

    // ---------- Reenviar a otros chats ----------
    /**
     * Reenvía un mensaje a varios chats (hasta [MAX_FORWARD_TARGETS]). Todo va por la cola persistente:
     * cada envío recibe su clientMessageId al encolarse y los reintentos lo reutilizan (idempotente).
     * Devuelve cuántos destinos quedaron en cola.
     */
    fun forward(source: MessageDTO, targets: List<String>, comment: String?): Int {
        val author = Names.person(s.data, source.authorId)?.name
        val plan = Forwarding.plan(source, targets, comment, author)
        plan.forEach { send(it.conversationId, it.body, null, it.forwarded) }
        return plan.map { it.conversationId }.distinct().size
    }

    // ---------- Foto del grupo (SPEC-v3 §1) ----------
    /** POST /conversations/:id/avatar con los bytes (JPEG 512×512 ya recortado). Devuelve la ruta relativa. */
    suspend fun setConversationAvatar(conversationId: String, jpeg: ByteArray): String? = withContext(dispatcher) {
        if (jpeg.size > MAX_AVATAR_BYTES) throw ApiException(413, "too_large", "La foto pesa más de 3 MB.")
        val r = request("POST", "/conversations/$conversationId/avatar", null, AvatarResult.serializer(), HttpApi.RawBody(jpeg, "image/jpeg"))
        patchMeta(conversationId) { copy(avatarUrl = r.avatarUrl) }
        r.avatarUrl
    }
    suspend fun removeConversationAvatar(conversationId: String) = withContext(dispatcher) {
        req("DELETE", "/conversations/$conversationId/avatar", null, AvatarResult.serializer())
        patchMeta(conversationId) { copy(avatarUrl = null) }
    }

    // ---------- Conversaciones laterales (SPEC-v3 §4) ----------
    /**
     * POST /conversations/:id/side: consulta privada sobre un mensaje. 403 side_outsider trae en
     * details.userIds a quienes no se pueden sumar (ver [SideOutsiders.from]).
     */
    suspend fun startSide(conversationId: String, messageId: String, userIds: List<String>, question: String?): String = withContext(dispatcher) {
        val body = buildJsonObject {
            put("messageId", JsonPrimitive(messageId))
            put("userIds", kotlinx.serialization.json.JsonArray(userIds.distinct().map { JsonPrimitive(it) }))
            question?.trim()?.takeIf { it.isNotEmpty() }?.let { put("question", JsonPrimitive(it.take(4000))) }
        }
        val r = req("POST", "/conversations/$conversationId/side", body, IdResult.serializer()); loadBootstrapInternal(); r.id
    }

    // ---------- Push (SPEC-v3 §6) ----------
    /** PUT /push/token de esta sesión (reemplaza el anterior). */
    suspend fun registerPushToken(token: String, lang: String?) = withContext(dispatcher) {
        if (accessToken == null) return@withContext
        val body = buildJsonObject {
            put("provider", JsonPrimitive("fcm")); put("token", JsonPrimitive(token)); put("environment", JsonPrimitive("production"))
            lang?.takeIf { it == "es" || it == "en" }?.let { put("lang", JsonPrimitive(it)) }
        }
        req("PUT", "/push/token", body, JsonElement.serializer()); Unit
    }
    suspend fun unregisterPushToken() = withContext(dispatcher) { runCatching { req("DELETE", "/push/token", null, JsonElement.serializer()) }; Unit }

    /** Badge local = suma de no leídos de las conversaciones no silenciadas (igual que el servidor). */
    fun badge(): Int = s.data?.conversations?.sumOf { if (it.mutedAt(now())) 0 else it.unread } ?: 0

    // ---------- Espacios ----------
    /** POST /workspaces: crea un espacio (tema de trabajo) con su grupo general. */
    suspend fun createWorkspace(name: String, department: String?): IdResult = withContext(dispatcher) {
        val body = buildJsonObject {
            put("name", JsonPrimitive(name.trim().take(120)))
            department?.trim()?.takeIf { it.isNotEmpty() }?.let { put("department", JsonPrimitive(it.take(160))) }
        }
        val r = req("POST", "/workspaces", body, IdResult.serializer()); loadBootstrapInternal(); r
    }

    // ---------- Chats (directos y grupales entre empresas) ----------
    /** POST /chats: con una persona devuelve el directo; con varias, un chat `multi`. Recarga el snapshot. */
    suspend fun createChat(userIds: List<String>, name: String?): CreateChatResult = withContext(dispatcher) {
        val n = name?.trim().orEmpty()
        val body = buildJsonObject {
            put("userIds", kotlinx.serialization.json.JsonArray(userIds.distinct().map { JsonPrimitive(it) }))
            if (userIds.size > 1 && n.length >= 2) put("name", JsonPrimitive(n.take(120)))
        }
        val r = req("POST", "/chats", body, CreateChatResult.serializer())
        loadBootstrapInternal(); r
    }

    /** Suma personas a una conversación; ven desde ahora (history 'now'). */
    suspend fun addMembers(conversationId: String, userIds: List<String>) = withContext(dispatcher) {
        val body = buildJsonObject {
            put("userIds", kotlinx.serialization.json.JsonArray(userIds.distinct().map { JsonPrimitive(it) })); put("history", JsonPrimitive("now"))
        }
        req("POST", "/conversations/$conversationId/members", body, JsonElement.serializer()); loadBootstrapInternal(); Unit
    }

    // ---------- Perfil ----------
    /** PATCH /me: nombre, cargo y área (vacío = null, para borrarlos). */
    suspend fun updateProfile(name: String, title: String?, area: String?) = withContext(dispatcher) {
        fun clean(v: String?) = v?.trim()?.take(120)?.ifEmpty { null }?.let { JsonPrimitive(it) } ?: JsonNull
        val body = buildJsonObject { put("name", JsonPrimitive(name.trim().take(120))); put("title", clean(title)); put("area", clean(area)) }
        req("PATCH", "/me", body, UserDTO.serializer()); loadBootstrapInternal(); Unit
    }

    /** Sube la foto ya recortada (JPEG 512×512) como cuerpo crudo image/jpeg. */
    suspend fun uploadAvatar(jpeg: ByteArray) = withContext(dispatcher) {
        if (jpeg.size > MAX_AVATAR_BYTES) throw ApiException(413, "too_large", "La foto pesa más de 3 MB.")
        request("POST", "/me/avatar", null, UserDTO.serializer(), HttpApi.RawBody(jpeg, "image/jpeg")); loadBootstrapInternal(); Unit
    }

    suspend fun removeAvatar() = withContext(dispatcher) { req("DELETE", "/me/avatar", null, JsonElement.serializer()); loadBootstrapInternal(); Unit }

    /** Ruta relativa del API (fotos, miniaturas) → URL absoluta. */
    fun mediaUrl(path: String?): String? = Media.absolute(path, baseUrl)

    // ---------- Archivos ----------
    suspend fun driveTree(workspaceId: String?): DriveTreeDTO = withContext(dispatcher) {
        req("GET", "/drive/tree" + q("workspaceId" to workspaceId), null, DriveTreeDTO.serializer())
    }
    suspend fun createDriveFolder(workspaceId: String?, parentId: String?, name: String): DriveFolderDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            put("workspaceId", workspaceId?.let { JsonPrimitive(it) } ?: JsonNull); put("parentId", parentId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("name", JsonPrimitive(name.trim().take(120)))
        }
        req("POST", "/drive/folders", body, DriveFolderDTO.serializer())
    }
    /** POST /drive/files?name=&workspaceId=&folderId=: siempre octet-stream; el tipo real va en x-file-type. */
    suspend fun uploadDriveFile(workspaceId: String?, folderId: String?, name: String, contentType: String?, bytes: ByteArray): DriveFileDTO = withContext(dispatcher) {
        if (bytes.size > MAX_DRIVE_FILE_BYTES) throw ApiException(413, "too_large", "El archivo pesa más de 25 MB.")
        val type = contentType?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        request("POST", "/drive/files" + q("name" to name.take(400), "workspaceId" to workspaceId, "folderId" to folderId), null, DriveFileDTO.serializer(),
            HttpApi.RawBody(bytes, "application/octet-stream", mapOf("x-file-type" to type)))
    }
    /** Enlace firmado (unos minutos) para abrir o descargar un archivo. */
    suspend fun driveFileLink(id: String): String = withContext(dispatcher) { req("GET", "/drive/files/$id/link", null, LinkResult.serializer()).url }

    // ---------- Personas y grupos ----------
    suspend fun openDirect(userId: String): String = withContext(dispatcher) {
        val r = req("POST", "/directs", buildJsonObject { put("userId", JsonPrimitive(userId)) }, IdResult.serializer()); loadBootstrapInternal(); r.id
    }
    suspend fun removeMember(conversationId: String, userId: String) = withContext(dispatcher) {
        req("DELETE", "/conversations/$conversationId/members/$userId", null, JsonElement.serializer()); loadBootstrapInternal(); Unit
    }

    // ---------- Seguridad de la comunidad ----------
    suspend fun loadBlocks() = withContext(dispatcher) {
        val result = req("GET", "/blocks", null, BlocksResult.serializer())
        setState { copy(blockedUserIds = result.userIds.toSet()) }
    }

    suspend fun setUserBlocked(userId: String, blocked: Boolean) = withContext(dispatcher) {
        req(if (blocked) "PUT" else "DELETE", "/blocks/${enc(userId)}", if (blocked) buildJsonObject {} else null, JsonElement.serializer())
        setState { copy(blockedUserIds = if (blocked) blockedUserIds + userId else blockedUserIds - userId) }
        loadBootstrapInternal()
    }

    suspend fun reportContent(userId: String?, messageId: String?, reason: String) = withContext(dispatcher) {
        require(userId != null || messageId != null)
        require(reason.trim().length in 5..2000)
        req("POST", "/reports", buildJsonObject {
            userId?.let { put("userId", JsonPrimitive(it)) }
            messageId?.let { put("messageId", JsonPrimitive(it)) }
            put("reason", JsonPrimitive(reason.trim()))
        }, IdResult.serializer()).id
    }

    // ---------- Eliminar la cuenta ----------
    /** DELETE /account {confirmEmail, password?}. 400: el correo no coincide · 403: contraseña incorrecta. */
    suspend fun deleteAccount(confirmEmail: String, password: String?) = withContext(dispatcher) {
        val body = buildJsonObject {
            put("confirmEmail", JsonPrimitive(confirmEmail.trim().lowercase()))
            password?.takeIf { it.isNotEmpty() }?.let { put("password", JsonPrimitive(it)) }
        }
        req("DELETE", "/account", body, JsonElement.serializer())
        handleSignedOut()
    }

    // ---------- Dominios de empresa ----------
    suspend fun listDomains(orgId: String): List<OrgDomainDTO> = withContext(dispatcher) { req("GET", "/organizations/$orgId/domains", null, DomainsPage.serializer()).domains }
    suspend fun addDomain(orgId: String, domain: String): OrgDomainDTO = withContext(dispatcher) {
        req("POST", "/organizations/$orgId/domains", buildJsonObject { put("domain", JsonPrimitive(domain)) }, OrgDomainDTO.serializer())
    }
    suspend fun verifyDomain(orgId: String, domain: String): OrgDomainDTO = withContext(dispatcher) {
        req("POST", "/organizations/$orgId/domains/${enc(domain)}/verify", buildJsonObject {}, OrgDomainDTO.serializer()).also { runCatching { loadBootstrapInternal() } }
    }

    // ---------- WhatsApp ----------
    suspend fun waAccounts(): WaAccountsPage = withContext(dispatcher) { req("GET", "/whatsapp/accounts", null, WaAccountsPage.serializer()) }
    suspend fun waCreate(label: String, kind: String, pairPhone: String?): WaAccountDTO = withContext(dispatcher) {
        req("POST", "/whatsapp/accounts", buildJsonObject {
            put("label", JsonPrimitive(label)); put("kind", JsonPrimitive(kind)); put("pairPhone", pairPhone?.let { JsonPrimitive(it) } ?: JsonNull)
        }, WaAccountDTO.serializer())
    }
    suspend fun waRelink(id: String, pairPhone: String?): WaAccountDTO = withContext(dispatcher) {
        req("POST", "/whatsapp/accounts/$id/relink", buildJsonObject { put("pairPhone", pairPhone?.let { JsonPrimitive(it) } ?: JsonNull) }, WaAccountDTO.serializer())
    }
    suspend fun waRemove(id: String) = withContext(dispatcher) { req("DELETE", "/whatsapp/accounts/$id", null, JsonElement.serializer()); Unit }
    suspend fun waChats(accountId: String?, category: String?, groups: Boolean?, hidden: Boolean, search: String?): WaChatsPage = withContext(dispatcher) {
        req("GET", "/whatsapp/chats" + q("accountId" to accountId, "category" to category, "groups" to groups?.let { if (it) "1" else "0" }, "hidden" to if (hidden) "1" else null, "q" to search?.takeIf { it.isNotBlank() }), null, WaChatsPage.serializer())
    }
    suspend fun waPatchChat(c: WaChatDTO, patch: JsonObject): WaChatDTO = withContext(dispatcher) {
        req("PATCH", "/whatsapp/chats/${c.accountId}/${enc(c.jid)}", patch, WaChatDTO.serializer())
    }
    suspend fun waMessages(c: WaChatDTO): List<WaMessageDTO> = withContext(dispatcher) {
        req("GET", "/whatsapp/chats/${c.accountId}/${enc(c.jid)}/messages?limit=80", null, WaMessagesPage.serializer()).messages
    }
    suspend fun waOrganize(): WaOrganizeResult = withContext(dispatcher) { req("POST", "/whatsapp/organize", buildJsonObject {}, WaOrganizeResult.serializer()) }

    // ---------- Invitaciones ----------
    suspend fun previewInvitation(token: String): InvitationPreviewDTO = withContext(dispatcher) {
        val r = http.exec("GET", "/invitations/${enc(token)}")
        if (!r.ok) throw HttpApi.parseError(r)
        TcJson.decodeFromString(InvitationPreviewDTO.serializer(), r.body)
    }

    suspend fun acceptInvitation(token: String): AcceptInvitationResult = withContext(dispatcher) {
        val r = request("POST", "/invitations/${enc(token)}/accept", "{}", AcceptInvitationResult.serializer())
        loadBootstrapInternal()
        r
    }

    suspend fun previewOrgInvitation(token: String): OrgInvitationPreviewDTO = withContext(dispatcher) {
        val r = http.exec("GET", "/org-invitations/${enc(token)}")
        if (!r.ok) throw HttpApi.parseError(r)
        TcJson.decodeFromString(OrgInvitationPreviewDTO.serializer(), r.body)
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    // ---------- Pruebas / ciclo de vida ----------
    /** Corta el socket sin cerrar la sesión (pruebas de recuperación). */
    fun debugDisconnect() { scope.launch { socket.stop() } }
    fun debugReconnect() { scope.launch { socket.start() } }

    fun close() {
        socket.stop()
        scope.cancel()
    }
}

private const val SSO_KEY = "sso:attempt"

/** Personas que no se pueden sumar a una lateral (403 side_outsider → error.details.userIds). */
object SideOutsiders {
    fun from(e: Throwable): Set<String> {
        val a = e as? ApiException ?: return emptySet()
        if (a.code != "side_outsider") return emptySet()
        val d = a.details as? JsonObject ?: return emptySet()
        return (d["userIds"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.toSet() ?: emptySet()
    }
}

/** Marcador de «no cambiar» para parámetros anulables. */
@JvmField val UNCHANGED: String = String(charArrayOf('\u0000'))

internal fun upsertMessage(list: List<MessageDTO>, m: MessageDTO): List<MessageDTO> {
    val i = list.indexOfFirst { it.id == m.id }
    if (i >= 0) return list.toMutableList().also { it[i] = m }
    if (list.isEmpty() || list.last().seq < m.seq) return list + m
    return (list + m).sortedBy { it.seq }
}
