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
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
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
    /** Temas por conversación (activos y archivados), en el orden de la fila (docs/TEMAS.md). */
    val topics: Map<String, List<TopicDTO>> = emptyMap(),
    val reminders: List<ReminderDTO> = emptyList(),
    val events: Map<String, CalendarEventDTO> = emptyMap(),
    /** Sube cuando el puente de WhatsApp trae novedades: la pantalla vuelve a pedir la lista. */
    val waRevision: Int = 0,
    /** Sube cuando cambia algún árbol de archivos (`drive.updated`): la pantalla Archivos recarga. */
    val driveRevision: Int = 0,
    val blockedUserIds: Set<String> = emptySet(),
    /** «No molestar» hasta (ISO); null = apagado. Viene del bootstrap, de `me.dnd` o de este dispositivo. */
    val dndUntil: String? = null,
    /** El servidor no conoce PUT /me/dnd (404): «No molestar» vive solo en este dispositivo. */
    val dndLocalOnly: Boolean = false,
    /** Mis mensajes programados pendientes o fallidos (docs/PROGRAMADOS.md). */
    val scheduled: List<ScheduledMessageDTO> = emptyList(),
    /** Mis conexiones con Meet, Teams y Zoom (null = aún no se pidieron). */
    val meetingConnections: List<MeetingConnectionDTO>? = null,
    /**
     * Llamada en curso por conversación (docs/LLAMADAS.md): ausente = no se sabe todavía, null = ninguna.
     * Llega de GET /conversations/:id/call, de `call.updated` y de `call.ringing`.
     */
    val calls: Map<String, CallDTO?> = emptyMap(),
    /** Sube cuando alguna llamada cambia (empezó, terminó, hay transcripción): la pestaña «Llamadas» recarga. */
    val callsRevision: Int = 0,
)

/** Avisos puntuales para sonidos y notificaciones. */
sealed interface ClientSignal {
    /** Mensaje de otra persona recibido EN VIVO (no en la recuperación masiva). */
    data class Incoming(val message: MessageDTO, val generation: Long = 0) : ClientSignal
    /** Mensaje de otra persona recibido EN VIVO que no avisa (chat silenciado o «No molestar»). */
    data class Silenced(val messageId: String, val generation: Long = 0) : ClientSignal
    /** El servidor confirmó un mensaje propio. */
    data class Sent(val message: MessageDTO) : ClientSignal
    data class SignedOut(val generation: Long) : ClientSignal
    /** Recordatorio vencido (evento de cuenta `reminder.due`). */
    data class ReminderDue(val reminder: ReminderDTO) : ClientSignal
    /** Reunión nueva, movida o cancelada por otra persona, en vivo. kind: created | moved | cancelled */
    data class CalendarChanged(val event: CalendarEventDTO, val kind: String) : ClientSignal
    /** El servidor descartó menciones (no participan en la conversación): se avisa sutilmente. */
    data class MentionsDropped(val conversationId: String, val userIds: List<String>) : ClientSignal
    /** La reunión empieza pronto (evento de cuenta `event.soon`). */
    data class EventSoon(val event: CalendarEventDTO, val minutes: Int) : ClientSignal
    /** «⏳ Procesando…» o las frases de un pedazo de audio de la llamada (Groq). */
    data class CallCaption(val event: CallCaptionEvent) : ClientSignal
    /** Me están llamando (`call.ringing`), salvo con «No molestar» o modo sueño. */
    data class CallRinging(val call: CallDTO, val callerName: String, val conversationTitle: String?) : ClientSignal
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
    private val meetingStore: SecretStore = MemorySecretStore(),
    /** Synchronous local cleanup, before a new session can present notices; never await network here. */
    private val onNoticeSessionEnded: () -> Unit = {},
    /** Velocidad (1.7.0): copia local de la sesión por usuario (en Android, un archivo privado sin respaldo). */
    private val snapshots: SnapshotCache = NoSnapshotCache,
) {
    val http = HttpApi(baseUrl, okHttp)
    val baseUrl: String get() = http.baseUrl
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val _state = MutableStateFlow(ClientState())
    val state: StateFlow<ClientState> = _state.asStateFlow()
    private val _signals = MutableSharedFlow<ClientSignal>(extraBufferCapacity = 64)
    val signals: SharedFlow<ClientSignal> = _signals.asSharedFlow()

    /** Velocidad (1.7.0): la sesión se pintó desde la caché local antes de hablar con el servidor. */
    @Volatile var paintedFromCache = false; private set
    /** La sesión ya habló con el servidor (bootstrap fresco, tiempo real encendido). Antes solo se ve la copia local. */
    @Volatile private var live = false
    /** Primer fotograma de la app: lo no crítico del arranque (tareas, recordatorios, programados) espera a esto. */
    private val firstFrame = kotlinx.coroutines.CompletableDeferred<Unit>()
    fun firstFrameDrawn() { firstFrame.complete(Unit) }
    private suspend fun afterFirstFrame() { kotlinx.coroutines.withTimeoutOrNull(Speed.FIRST_FRAME_WAIT_MS) { firstFrame.await() } }
    private val snapshotLock = Any()
    private var prefetchJob: Job? = null

    init {
        // Copia local: tras cada ráfaga de cambios (lista, mensajes, bloqueos), fuera del hilo del cliente.
        @OptIn(kotlinx.coroutines.FlowPreview::class)
        if (snapshots !== NoSnapshotCache) scope.launch(Dispatchers.IO) {
            state.map { st -> if (st.status == SessionStatus.READY) Triple(st.data, st.conversations, st.blockedUserIds) else null }
                .distinctUntilChanged()
                .debounce(Speed.SAVE_DEBOUNCE_MS)
                .collect { if (it != null) saveSnapshot() }
        }
    }
    private var accessToken: String? = null
    private var accessExp = 0L
    private var authSessionId: String? = null
    @Volatile var sessionGeneration: Long = 0; private set
    /** Unlike request generation, first cold refresh preserves decisions already made by FCM. */
    @Volatile var noticeGeneration: Long = 0; private set
    /** Shared runtime policy context for socket and FCM, with the same clock and safety preferences. */
    fun noticeContext(conversationId: String, messageId: String?, authorId: String?, foreground: Boolean, openConversationId: String?): Notices.PushContext {
        val state = s
        val conv = state.data?.conversations?.firstOrNull { it.id == conversationId }
        return Notices.PushContext(foreground,
            state.status == SessionStatus.READY && state.connection == ConnectionStatus.ONLINE,
            dndActive(), conv != null, conv?.mutedUntil,
            Notices.openAndLoaded(foreground, openConversationId, conversationId, state, messageId), now(),
            authorId != null && authorId in state.blockedUserIds)
    }
    private val noticeSessionLock = Any()
    fun clearNoticesIfSignedOut(action: () -> Unit) = synchronized(noticeSessionLock) {
        if (s.status == SessionStatus.ANONYMOUS) action()
    }
    /** Publication and session invalidation must not pass one another. Cold restoration remains valid. */
    fun <T> withNoticeSession(generation: Long, action: () -> T): T? = synchronized(noticeSessionLock) {
        if (generation != noticeGeneration || s.status == SessionStatus.ANONYMOUS) null else action()
    }
    @Volatile private var meetingProof: MeetingProof? = null
    private val meetingAttempts = java.util.concurrent.ConcurrentHashMap<String, MeetingAttempt>()
    private var meetingOwner: String? = null
    private var meetingStorageFailed = false
    fun meetingAttempt(conversationId: String): MeetingAttempt = meetingAttempts.getOrPut(conversationId) { newMeetingAttempt() }
    private fun newMeetingAttempt(saved: SavedMeetingAttempt? = null): MeetingAttempt {
        val generation = sessionGeneration
        return MeetingAttempt().also { attempt ->
            saved?.let(attempt::restore)
            attempt.persist = { if (generation == sessionGeneration) persistMeetingAttempts() }
        }
    }
    @Synchronized private fun persistMeetingAttempts() {
        check(!meetingStorageFailed) { "Saved meeting must be recovered before another can be created" }
        val owner = meetingOwner ?: return
        val snapshots = meetingAttempts.mapNotNull { (id, attempt) -> attempt.snapshot()?.let { id to it } }.toMap()
        meetingStore.set(if (snapshots.isEmpty()) null else TcJson.encodeToString(SavedMeetingAttempts.serializer(), SavedMeetingAttempts(owner, snapshots)))
    }
    @Synchronized private fun restoreMeetingAttempts(userId: String) {
        if (meetingOwner == userId) return
        meetingAttempts.clear(); meetingOwner = userId
        meetingStorageFailed = false
        val saved = try { meetingStore.get()?.let { TcJson.decodeFromString(SavedMeetingAttempts.serializer(), it) } }
        catch (_: Exception) { meetingStorageFailed = true; return }
        if (saved?.userId == userId) saved.attempts.forEach { (id, value) -> meetingAttempts[id] = newMeetingAttempt(value) }
        else meetingStore.set(null)
    }
    fun cancelMeetingConnect() { meetingProof = null }
    private fun requireSession(generation: Long) {
        if (generation != sessionGeneration) throw kotlinx.coroutines.CancellationException("Session changed")
    }
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
        // Con la copia local a la vista, la sesión se está recuperando (el primer refresh cambia la generación):
        // se espera ese refresh para no descartar lo que la persona hace en el primer segundo.
        if (accessToken == null && refreshing != null) runCatching { refresh() }
        val generation = sessionGeneration
        if (accessToken != null && now() > accessExp - 30_000) refresh()
        requireSession(generation)
        var r = http.exec(method, path, body, accessToken, raw)
        requireSession(generation)
        if (r.code == 401) {
            val outcome = refresh()
            requireSession(generation)
            when (outcome) {
                RefreshOutcome.OK -> r = http.exec(method, path, body, accessToken, raw)
                RefreshOutcome.UNAUTHORIZED -> { handleSignedOut(); throw HttpApi.parseError(r) }
                RefreshOutcome.NETWORK -> throw HttpApi.parseError(r)
            }
            requireSession(generation)
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

    private fun applyAuth(r: AuthResult, refreshingSession: Boolean = false): Unit = synchronized(noticeSessionLock) {
        if (authSessionId != r.sessionId) {
            if (!refreshingSession || authSessionId != null) {
                onNoticeSessionEnded()
                noticeGeneration++
            }
            sessionGeneration++; authSessionId = r.sessionId
            cancelMeetingConnect(); meetingAttempts.clear(); meetingOwner = null
        }
        accessToken = r.accessToken
        accessExp = runCatching { Instant.parse(r.accessExpiresAt).toEpochMilli() }.getOrElse { now() + 10 * 60_000 }
        r.refreshToken?.let { secrets.set(it) }
        Unit
    }

    /** Arranque: intenta reanudar la sesión guardada. */
    suspend fun start() = withContext(dispatcher) {
        // Una sola a la vez (al abrir, wake() de primer plano llega mientras el primer start() refresca).
        if (starting) return@withContext
        starting = true
        try { startInternal() } finally { starting = false }
    }

    private var starting = false

    private suspend fun startInternal() {
        startRetryJob?.cancel()
        if (secrets.get() == null) { handleSignedOut(); return }
        // Velocidad (1.7.0): con copia local se pinta ya la lista y los chats recientes; el servidor revalida detrás.
        if (s.data == null && !paintFromCache()) setState { copy(status = SessionStatus.LOADING) }
        when (refresh()) {
            RefreshOutcome.OK -> try { afterLogin() } catch (e: NetworkException) { unreachable() }
            RefreshOutcome.UNAUTHORIZED -> handleSignedOut()
            RefreshOutcome.NETWORK -> unreachable()
        }
    }

    /** Pinta la sesión guardada del último usuario (si la hay): lista, chats recientes, bloqueos y cola de salida. */
    private fun paintFromCache(): Boolean {
        val userId = storage.get(LAST_USER_KEY) ?: return false
        val snap = Speed.decode(runCatching { snapshots.read(userId) }.getOrNull(), userId, now()) ?: return false
        val saved = storage.get("u:$userId:outbox")?.let { runCatching { TcJson.decodeFromString(ListSerializer(PendingMessage.serializer()), it) }.getOrNull() } ?: emptyList()
        setState {
            copy(status = SessionStatus.READY, data = snap.data, conversations = Speed.restore(snap), blockedUserIds = snap.blockedUserIds.toSet(),
                pending = saved.map { if (it.status == "sending") it.copy(status = "pending") else it },
                dndUntil = storage.get(DND_KEY), dndLocalOnly = storage.get(DND_LOCAL_KEY) == "1")
        }
        paintedFromCache = true
        return true
    }

    private fun saveSnapshot() {
        val st = s
        if (!live || st.status != SessionStatus.READY) return
        val snap = Speed.snapshot(st, now()) ?: return
        val json = Speed.encode(snap)
        synchronized(snapshotLock) {
            // Se cerró la sesión mientras se armaba la copia: no se escribe.
            if (!live || s.data?.me?.id != snap.userId) return
            runCatching { snapshots.write(snap.userId, json) }
        }
    }

    private var startAttempts = 0
    private fun unreachable() {
        // Con la copia local a la vista, sin red se sigue mostrando (desconectado) y se reintenta detrás.
        if (!(s.status == SessionStatus.READY && s.data != null)) setState { copy(status = SessionStatus.UNREACHABLE) }
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
            val generation = sessionGeneration
            val stored = secrets.get() ?: return@async RefreshOutcome.UNAUTHORIZED
            val r = try {
                http.exec("POST", "$AUTH_BASE_PATH/refresh", TcJson.encodeToString(RefreshBody.serializer(), RefreshBody(stored)))
            } catch (e: NetworkException) { return@async RefreshOutcome.NETWORK }
            requireSession(generation)
            when {
                r.ok -> { applyAuth(TcJson.decodeFromString(AuthResult.serializer(), r.body), refreshingSession = true); RefreshOutcome.OK }
                r.code == 401 || r.code == 400 || r.code == 403 -> { accessToken = null; secrets.set(null); RefreshOutcome.UNAUTHORIZED }
                else -> RefreshOutcome.NETWORK
            }
        }
        refreshing = d
        try { return d.await() } finally { if (refreshing === d) refreshing = null }
    }

    suspend fun logout() = withContext(dispatcher) {
        // Salir mientras la sesión pintada desde la copia se recupera: primero termina ese refresh.
        refreshing?.let { runCatching { it.await() } }
        val generation = sessionGeneration
        try { requestUnit("POST", "$AUTH_BASE_PATH/logout", "{}") } catch (_: Exception) {}
        if (generation == sessionGeneration) handleSignedOut()
    }

    private fun handleSignedOut(): Unit = synchronized(noticeSessionLock) {
        val previousNoticeGeneration = noticeGeneration
        onNoticeSessionEnded()
        sessionGeneration++; noticeGeneration++; authSessionId = null
        cancelMeetingConnect(); meetingAttempts.clear(); meetingOwner = null; meetingStore.set(null)
        val me = s.data?.me?.id
        socket.stop()
        flushJob?.cancel(); bootstrapJob?.cancel(); startRetryJob?.cancel()
        readJobs.values.forEach { it.cancel() }; readJobs.clear()
        accessToken = null
        secrets.set(null)
        if (me != null) storage.clearPrefix("u:$me:")
        synchronized(snapshotLock) { live = false; paintedFromCache = false; runCatching { snapshots.clear(me ?: storage.get(LAST_USER_KEY)) } }
        prefetchJob?.cancel()
        storage.set(LAST_USER_KEY, null)
        // gg: el historial vive solo en el dispositivo y se borra al cerrar sesión (docs/ASISTENTE.md).
        Assistant.clear(storage)
        storage.set(DND_KEY, null); storage.set(DND_LOCAL_KEY, null)
        val wasSignedIn = s.status != SessionStatus.ANONYMOUS
        _state.value = ClientState(status = SessionStatus.ANONYMOUS)
        if (wasSignedIn) _signals.tryEmit(ClientSignal.SignedOut(previousNoticeGeneration))
        Unit
    }

    private suspend fun afterLogin() {
        startAttempts = 0
        val cached = paintedFromCache && s.status == SessionStatus.READY
        // Load safety preferences before showing content or starting realtime. Van en paralelo con el bootstrap
        // (antes iban una tras otra); con la copia local, los bloqueos guardados ya están aplicados y se revalidan detrás.
        val blocks = scope.async { runCatching { loadBlocks() } }
        loadBootstrapInternal()
        if (!cached) blocks.await().getOrThrow()
        val me = s.data!!.me.id
        storage.set(LAST_USER_KEY, me)
        val fromDisk = storage.get("u:$me:outbox")?.let { runCatching { TcJson.decodeFromString(ListSerializer(PendingMessage.serializer()), it) }.getOrNull() } ?: emptyList()
        // Lo que ya estaba en pantalla (copia local) puede traer mensajes nuevos en la cola: se conserva.
        val saved = if (cached) (s.pending + fromDisk).distinctBy { it.clientMessageId } else fromDisk
        setState { copy(status = SessionStatus.READY, pending = saved.map { if (it.status == "sending") it.copy(status = "pending") else it }) }
        live = true
        socket.start()
        scheduleFlush(0)
        prefetchJob?.cancel()
        prefetchJob = scope.launch { afterFirstFrame(); prefetch() }
        // No crítico: después del primer fotograma.
        scope.launch { afterFirstFrame(); runCatching { loadRemindersInternal() } }
        scope.launch { afterFirstFrame(); runCatching { loadScheduled() } }
        // Asuntos abiertos bajo cada grupo (docs/GRUPOS.md); luego llegan por issue.updated.
        scope.launch { afterFirstFrame(); runCatching { loadOpenIssues() } }
        saveSnapshot()
    }

    /** Velocidad (1.7.0): mensajes de los chats con no leídos o fijados, como mucho 8, de a 2 a la vez. */
    private suspend fun prefetch() {
        val d = s.data ?: return
        val targets = Speed.prefetchTargets(d, s.conversations, now())
        val gate = kotlinx.coroutines.sync.Semaphore(Speed.PREFETCH_PARALLEL)
        kotlinx.coroutines.coroutineScope {
            for (id in targets) launch {
                gate.acquire()
                try {
                    if (s.conversations[id]?.loaded == true) catchUp(id) else runCatching { openInternal(id, false) }
                } finally { gate.release() }
            }
        }
    }

    // ---------- Snapshot ----------
    suspend fun loadBootstrap(): BootstrapDTO = withContext(dispatcher) { loadBootstrapInternal() }

    private suspend fun loadBootstrapInternal(): BootstrapDTO {
        val raw = request("GET", "/bootstrap", null, JsonElement.serializer())
        val data = TcJson.decodeFromJsonElement(BootstrapDTO.serializer(), raw)
        runCatching { Instant.parse(data.serverTime).toEpochMilli() }.getOrNull()?.let { serverOffset = it - now() }
        val sorted = data.copy(conversations = data.conversations.sortedByDescending { it.lastMessageAt ?: "" })
        // Conversaciones que ya no están en mi alcance: se purgan de la caché local.
        val allowed = sorted.conversations.map { it.id }.toSet()
        // «No molestar»: si el servidor manda me.dndUntil (aunque sea null), manda él; si no lo conoce, queda el del dispositivo.
        val serverKnowsDnd = ((raw as? JsonObject)?.get("me") as? JsonObject)?.containsKey("dndUntil") == true
        val dnd = if (serverKnowsDnd) data.me.dndUntil else storage.get(DND_KEY)
        if (serverKnowsDnd) { storage.set(DND_KEY, dnd); storage.set(DND_LOCAL_KEY, null) }
        val localOnly = !serverKnowsDnd && storage.get(DND_LOCAL_KEY) == "1"
        setState { copy(data = sorted, conversations = conversations.filterKeys { it in allowed }, dndUntil = dnd, dndLocalOnly = localOnly) }
        restoreMeetingAttempts(sorted.me.id)
        sorted.me.sleep?.let { rememberSleep(it); syncSleepTz(it) }
        return sorted
    }

    // ---------- Modo sueño («No molestar todas las noches») ----------
    private fun rememberSleep(sl: SleepDTO) { storage.set(SLEEP_KEY, TcJson.encodeToString(SleepDTO.serializer(), sl)) }
    /** Mi horario (estado o, antes del bootstrap —push con la app cerrada—, el guardado). */
    fun mySleep(): SleepDTO? = s.data?.me?.sleep ?: storage.get(SLEEP_KEY)?.let { runCatching { TcJson.decodeFromString(SleepDTO.serializer(), it) }.getOrNull() }
    private fun applySleep(sl: SleepDTO) {
        rememberSleep(sl)
        setState { copy(data = data?.let { d -> d.copy(me = d.me.copy(sleep = sl)) }) }
    }
    /** PUT /me/sleep; responde { sleep } y llega también como me.sleep a mis otras sesiones. */
    suspend fun setSleep(on: Boolean? = null, start: String? = null, end: String? = null, tz: String? = null, tzAuto: Boolean? = null): SleepDTO = withContext(dispatcher) {
        val b = buildJsonObject {
            on?.let { put("on", JsonPrimitive(it)) }; start?.let { put("start", JsonPrimitive(it)) }; end?.let { put("end", JsonPrimitive(it)) }
            tz?.let { put("tz", JsonPrimitive(it)) }; tzAuto?.let { put("tzAuto", JsonPrimitive(it)) }
        }
        val r = req("PUT", "/me/sleep", b, JsonObject.serializer())
        val sl = TcJson.decodeFromJsonElement(SleepDTO.serializer(), r["sleep"] ?: r)
        applySleep(sl); sl
    }
    /** Mientras la zona no se fije a mano (tzAuto), sigue la del teléfono (viajes). */
    private fun syncSleepTz(sl: SleepDTO) {
        if (!sl.tzAuto) return
        val tz = java.time.ZoneId.systemDefault().id
        if (tz != sl.tz) scope.launch { runCatching { setSleep(tz = tz, tzAuto = true) } }
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
        if (s.status != SessionStatus.READY || !live) return
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
                    // Solo la copia local a la vista: primero la sesión.
                    if (!live) { if (startRetryJob?.isActive != true) start(); return@launch }
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
                scope.launch { runCatching { loadBlocks() }; scheduleBootstrap(); runCatching { loadOpenIssues() }; runCatching { loadScheduled() } }
            }
            is AccountEvent.ReadUpdated -> {
                val c = meta(e.conversationId) ?: return
                if (e.seq > c.lastReadSeq) patchMeta(c.id) {
                    copy(lastReadSeq = e.seq, unread = maxOf(0L, lastMessageSeq - maxOf(e.seq, historyFromSeq)).toInt(), unreadMentions = if (e.seq >= lastMessageSeq) 0 else unreadMentions)
                }
            }
            is AccountEvent.ReminderDue -> {
                setState { copy(reminders = (reminders.filter { it.id != e.reminder.id } + e.reminder).sortedBy { it.remindAt }) }
                // «No molestar»: el recordatorio queda en la lista, sin aviso.
                if (!dndActive()) _signals.tryEmit(ClientSignal.ReminderDue(e.reminder))
            }
            is AccountEvent.EventSoon -> {
                setState { copy(events = events + (e.event.id to e.event)) }
                if (!dndActive()) _signals.tryEmit(ClientSignal.EventSoon(e.event, e.minutes))
            }
            is AccountEvent.PrefsUpdated -> scheduleBootstrap()
            is AccountEvent.WhatsAppUpdated -> setState { copy(waRevision = waRevision + 1) }
            is AccountEvent.DriveUpdated -> setState { copy(driveRevision = driveRevision + 1) }
            AccountEvent.RemindersChanged -> scope.launch { runCatching { loadRemindersInternal() } }
            is AccountEvent.DndUpdated -> applyDnd(e.dndUntil, localOnly = false)
            is AccountEvent.SleepUpdated -> applySleep(e.sleep)
            is AccountEvent.IssueUpdated -> { putIssues(listOf(e.issue)); recountIssues(e.issue.conversationId) }
            // Asunto personal (solo mío): no cuenta en ninguna conversación.
            is AccountEvent.IssuePersonal -> putIssues(listOf(e.issue))
            is AccountEvent.IssueHidden -> { setState { copy(issues = issues - e.issueId) }; if (e.conversationId.isNotEmpty()) recountIssues(e.conversationId) }
            is AccountEvent.ScheduledUpdated -> setState { copy(scheduled = Scheduling.apply(scheduled, e.scheduled)) }
            is AccountEvent.CallUpdated -> putCall(e.call)
            is AccountEvent.CallCaption -> _signals.tryEmit(ClientSignal.CallCaption(e.event))
            is AccountEvent.CallRinging -> {
                putCall(e.call)
                if (e.call.startedBy != myId && !dndActive()) _signals.tryEmit(ClientSignal.CallRinging(e.call, e.callerName, e.conversationTitle))
            }
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
            is ConversationEvent.TopicsChanged -> putTopics(e.conversationId, e.topics)
            is ConversationEvent.CallUpdated -> putCall(e.call)
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
                if (kind != null && invited && ev.organizerId != myId && !muted && !dndActive() && fresh) _signals.tryEmit(ClientSignal.CalendarChanged(ev, kind))
            }
            else -> Unit
        }
        var messageNotice: ClientSignal? = null
        if (e is ConversationEvent.MessageCreated) {
            val fresh = bumpMeta(e.message)
            // Solo suena lo creado con la conexión ya en vivo: si el despacho del servidor llega tarde
            // con mensajes escritos mientras estábamos desconectados, eso cuenta como recuperación.
            val createdAt = runCatching { Instant.parse(e.message.createdAt).toEpochMilli() }.getOrDefault(Long.MAX_VALUE)
            // Silenciada: sin sonido ni notificación. Una mención a mí (o @todos) avisa aunque esté silenciada,
            // salvo el silencio «siempre» (como el push del servidor). «No molestar» apaga todo (SPEC-silencio).
            val mentioned = Mentions.mentionsMe(e.message, myId)
            if (fresh && e.message.authorId != myId && e.message.kind != "system" && createdAt >= liveSince) {
                // La decisión «sin aviso» también se anuncia: un FCM tardío del mismo mensaje no debe aparecer (Notices).
                messageNotice = if (e.message.authorId !in s.blockedUserIds && !dndActive() && Silence.notifies(meta.mutedUntil, mentioned, null, now()))
                    ClientSignal.Incoming(e.message, noticeGeneration) else ClientSignal.Silenced(e.message.id, noticeGeneration)
            }
        }
        val local = s.conversations[e.conversationId]
        if (local?.loaded != true) {
            patchMeta(e.conversationId) { copy(lastEventSeq = maxOf(lastEventSeq, e.eventSeq)) }
            messageNotice?.let { _signals.tryEmit(it) }
            return
        }
        if (e.eventSeq <= local.lastEventSeq) return // duplicado de transporte
        if (e.eventSeq > local.lastEventSeq + 1) {
            scope.launch { catchUp(e.conversationId) }
            messageNotice?.let { _signals.tryEmit(it) } // Not applied: the notification remains a fallback.
            return
        }
        applyEvent(e)
        // A synchronous collector must see the applied message before deciding OPEN/receive sound.
        messageNotice?.let { _signals.tryEmit(it) }
    }

    /** Actualiza la vista previa y los no leídos. Devuelve true si el mensaje es nuevo. */
    private fun bumpMeta(m: MessageDTO): Boolean {
        val c = meta(m.conversationId) ?: return false
        if (m.seq <= c.lastMessageSeq) return false
        val mine = m.authorId == myId
        val readThroughPrevious = maxOf(c.lastReadSeq, c.historyFromSeq) >= c.lastMessageSeq && m.seq == c.lastMessageSeq + 1
        val lastRead = if (mine && readThroughPrevious) m.seq else c.lastReadSeq
        patchMeta(c.id) {
            copy(
                lastMessageSeq = m.seq, lastMessageAt = m.createdAt, lastMessagePreview = if (m.viewOnce) "①" else m.body.take(140), lastReadSeq = lastRead,
                unread = maxOf(0L, m.seq - maxOf(lastRead, historyFromSeq)).toInt(),
                unreadMentions = if (mine && readThroughPrevious) 0 else unreadMentions + if (!mine && Mentions.mentionsMe(m, myId)) 1 else 0,
                lastHumanPreview = if (m.kind == "system") lastHumanPreview else LastHumanPreviewDTO(m.id, m.seq, m.authorId, m.body,
                    m.attachments.takeIf { it.isNotEmpty() }?.let { a -> AttachmentSummaryDTO(a.size, a.count { it.isImage }, a.count { it.isVideo }, a.count { !it.isImage && !it.isVideo && !it.isVoice },
                        a.firstOrNull()?.name, a.count { it.isVoice }, a.firstOrNull { it.isVoice }?.durationMs) }, m.createdAt, viewOnce = m.viewOnce),
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
            is ConversationEvent.MembersChanged -> { patchMeta(e.conversationId) { copy(memberIds = e.memberIds, adminIds = e.adminIds ?: adminIds) }; scheduleBootstrap() }
            is ConversationEvent.IssueUpdated -> putIssues(listOf(e.issue))
            is ConversationEvent.PinsChanged -> setState { copy(pins = pins + (e.conversationId to e.messageIds)) }
            is ConversationEvent.CalendarUpdated -> putEvents(listOf(e.event))
            is ConversationEvent.TopicsChanged -> putTopics(e.conversationId, e.topics)
            is ConversationEvent.CallUpdated -> Unit // ya se aplicó en onConversationEvent (también con el chat cerrado)
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

    suspend fun loadOlder(id: String): Boolean = withContext(dispatcher) {
        val generation = sessionGeneration
        val local = s.conversations[id] ?: return@withContext false
        if (!local.loaded || !local.hasMore || local.loading) return@withContext false
        val before = local.messages.firstOrNull()?.seq ?: return@withContext false
        setConv(id) { copy(loading = true) }
        try {
            val page = request("GET", "/conversations/$id/messages?before=$before&limit=50", null, MessagesPage.serializer())
            setConv(id) {
                val known = messages.map { it.id }.toSet()
                copy(messages = (page.messages.filter { it.id !in known } + messages).sortedBy { it.seq }, hasMore = page.hasMore, loading = false)
            }
            page.messages.any { it.seq < before } || !page.hasMore
        } catch (e: Exception) {
            if (generation == sessionGeneration) setConv(id) { copy(loading = false) }
            if (e is kotlinx.coroutines.CancellationException) throw e
            false
        }
    }

    /** Only the visible contiguous prefix; local counters change after server acknowledgement. */
    suspend fun markRead(id: String, throughSeq: Long) = withContext(dispatcher) {
        val c = meta(id) ?: return@withContext
        val seq = minOf(throughSeq, c.lastMessageSeq)
        if (seq <= c.lastReadSeq) return@withContext
        requestUnit("POST", "/conversations/$id/read", TcJson.encodeToString(ReadBody.serializer(), ReadBody(seq)))
        patchMeta(id) { ReadTree.applyRead(this, seq) }
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
    /** Con [attachments] (ya subidos con [uploadAttachment]) el texto puede ir vacío (SPEC-v4). */
    fun send(
        conversationId: String, body: String, replyTo: String? = null, forwarded: ForwardedInfo? = null,
        attachments: List<AttachmentDTO> = emptyList(), forwardAttachments: List<AttachmentDTO> = emptyList(),
        mentions: List<MentionDTO> = emptyList(),
        /** Banderita elegida (docs/TEMAS.md): el mensaje sale con ese tema. */
        topicId: String? = null,
        /** Una sola vista (tanda 1.7): solo texto, imágenes o nota de voz. */
        viewOnce: Boolean = false,
    ): String? {
        // El servidor recorta el body: se recorta aquí y se corren los offsets de las menciones y de las #etiquetas
        // (que llegan del compositor como tokens con prefijo, ver [Refs]).
        val (text, ments, refs) = Refs.split(body, mentions)
        if (text.isEmpty() && attachments.isEmpty() && forwardAttachments.isEmpty()) return null
        val fwd = forwardAttachments.take((Attachments.MAX_PER_MESSAGE - attachments.size).coerceAtLeast(0))
        val p = PendingMessage(
            clientMessageId = UUID.randomUUID().toString(), conversationId = conversationId, body = text,
            replyTo = replyTo, forwarded = forwarded, createdAt = Instant.ofEpochMilli(now()).toString(),
            attachments = attachments.take(Attachments.MAX_PER_MESSAGE), forwardAttachments = fwd, mentions = ments, topicId = topicId,
            refs = refs, viewOnce = viewOnce && forwarded == null && fwd.isEmpty() && ViewOnce.allowed(attachments),
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
                val payload = TcJson.encodeToJsonElement(SocketSendBody.serializer(), SocketSendBody(p.conversationId, p.clientMessageId, p.body, p.replyTo, p.forwarded,
                    p.attachments.map { it.id }.ifEmpty { null }, p.forwardAttachments.map { it.id }.ifEmpty { null }, p.mentions.ifEmpty { null }, p.topicId,
                    p.refs.ifEmpty { null }, p.viewOnce.takeIf { it }))
                val r = socket.emitWithAck("message.send", payload, 8000).firstOrNull() as? JsonObject
                if ((r?.get("ok") as? JsonPrimitive)?.booleanOrNull == true) {
                    val m = r["message"]?.let { runCatching { TcJson.decodeFromJsonElement(MessageDTO.serializer(), it) }.getOrNull() }
                    val dropped = (r["droppedMentions"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
                    if (dropped.isNotEmpty()) _signals.tryEmit(ClientSignal.MentionsDropped(p.conversationId, dropped))
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
            TcJson.encodeToString(SendBody.serializer(), SendBody(p.clientMessageId, p.body, p.replyTo, p.forwarded,
                p.attachments.map { it.id }.ifEmpty { null }, p.forwardAttachments.map { it.id }.ifEmpty { null }, p.mentions.ifEmpty { null }, p.topicId,
                p.refs.ifEmpty { null }, p.viewOnce.takeIf { it })), SendResult.serializer(),
        )
        sentViaHttp++
        if (r.droppedMentions.isNotEmpty()) _signals.tryEmit(ClientSignal.MentionsDropped(p.conversationId, r.droppedMentions))
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
    private fun recountIssues(conversationId: String?) {
        if (conversationId.isNullOrEmpty()) return // personal: no cuenta en ninguna conversación
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
    /**
     * Asunto personal (POST /issues, contrato 2026-09-28): sin conversación y solo para mí. El servidor lo impone:
     * nadie más lo ve (404 por id), no cuenta en los contadores, no manda push y no admite tareas ni reasignarse.
     */
    suspend fun createPersonalIssue(title: String, dueDate: String?): IssueDTO = withContext(dispatcher) {
        val body = buildJsonObject { put("title", JsonPrimitive(title)); put("dueDate", dueDate?.let { JsonPrimitive(it) } ?: JsonNull) }
        val i = req("POST", "/issues", body, IssueDTO.serializer()).let { if (it.conversationId == "") it.copy(conversationId = null) else it }
        putIssues(listOf(i)); i
    }
    /** patch: title, status, ownerId, dueDate, waitingOnOrgId (null explícito = borrar). */
    /**
     * Tarea derivada (POST /issues/:id/children): en el chat del asunto o, con [conversationId], en un sidechat que
     * salió de él. [visibility] all | org | private; [viewerIds] personas con acceso (pueden no estar en el chat).
     */
    suspend fun createChildIssue(parentId: String, title: String, ownerId: String?, dueDate: String? = null, visibility: String? = null,
                                 viewerIds: List<String> = emptyList(), conversationId: String? = null): IssueDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            put("title", JsonPrimitive(title)); put("ownerId", ownerId?.let { JsonPrimitive(it) } ?: JsonNull)
            dueDate?.let { put("dueDate", JsonPrimitive(it)) }; visibility?.let { put("visibility", JsonPrimitive(it)) }
            if (viewerIds.isNotEmpty()) put("viewerIds", kotlinx.serialization.json.JsonArray(viewerIds.map { JsonPrimitive(it) }))
            conversationId?.let { put("conversationId", JsonPrimitive(it)) }
        }
        val i = req("POST", "/issues/$parentId/children", body, IssueDTO.serializer())
        putIssues(listOf(i)); recountIssues(i.conversationId); i
    }
    suspend fun updateIssue(id: String, patch: JsonObject): IssueDTO = withContext(dispatcher) {
        val i = req("PATCH", "/issues/$id", patch, IssueDTO.serializer())
        putIssues(listOf(i)); recountIssues(i.conversationId); i
    }
    /**
     * Cambia el estado de un asunto al instante (pulsación larga en Grupos y Asuntos): el asunto se actualiza
     * en local y el conteo del grupo baja de una vez; si el PATCH falla, vuelve como estaba y se lanza el error.
     */
    suspend fun setIssueStatus(id: String, status: String): IssueDTO = withContext(dispatcher) {
        val generation = sessionGeneration
        val prev = s.issues[id] ?: throw ApiException(404, "not_found", "Tarea no encontrada")
        if (prev.status == status) return@withContext prev
        putIssues(listOf(prev.copy(status = status))); recountIssues(prev.conversationId)
        try {
            val i = req("PATCH", "/issues/$id", buildJsonObject { put("status", JsonPrimitive(status)) }, IssueDTO.serializer())
            putIssues(listOf(i)); recountIssues(i.conversationId); i
        } catch (e: Exception) {
            if (generation == sessionGeneration) { putIssues(listOf(prev)); recountIssues(prev.conversationId) }
            throw e
        }
    }
    /** Pone o quita (null) el tema de una tarea (docs/TEMAS.md): PATCH /issues/:id {topicId}. */
    suspend fun setIssueTopic(id: String, topicId: String?): IssueDTO = withContext(dispatcher) {
        val i = req("PATCH", "/issues/$id", buildJsonObject { put("topicId", topicId?.let { JsonPrimitive(it) } ?: JsonNull) }, IssueDTO.serializer())
        putIssues(listOf(i)); i
    }
    suspend fun issueDetail(id: String): IssueDetail = withContext(dispatcher) {
        val r = req("GET", "/issues/$id", null, IssueDetail.serializer()); putIssues(listOf(r.issue) + r.children); r
    }
    suspend fun commentIssue(id: String, body: String): IssueDTO = withContext(dispatcher) {
        val i = req("POST", "/issues/$id/comments", buildJsonObject { put("body", JsonPrimitive(body)) }, IssueDTO.serializer()); putIssues(listOf(i)); i
    }

    // ---------- Reuniones con Meet, Teams o Zoom (docs/TANDA-LECTURA-REUNIONES.md §4) ----------
    suspend fun loadMeetingConnections(): List<MeetingConnectionDTO> = withContext(dispatcher) {
        val l = req("GET", "/meetings/connections", null, MeetingConnectionsPage.serializer()).connections
        setState { copy(meetingConnections = l) }; l
    }
    /** URL del proveedor para abrir en el navegador del sistema (Custom Tabs); vuelve por chaggu://meetings/connected. */
    suspend fun startMeetingConnect(provider: String): String = withContext(dispatcher) {
        val userId = myId ?: throw ApiException(401, "unauthorized", "")
        val proof = MeetingProof(provider, userId, sessionGeneration, now())
        meetingProof = proof
        try {
            val url = req("POST", "/meetings/connect/${enc(provider)}", buildJsonObject {
                put("platform", JsonPrimitive(PLATFORM)); put("redirectScheme", JsonPrimitive(DeepLinks.SCHEME)); put("proofChallenge", JsonPrimitive(proof.challenge))
            }, MeetingConnectResult.serializer()).url
            if (meetingProof !== proof) throw kotlinx.coroutines.CancellationException("Connection cancelled")
            url
        } catch (e: Exception) { if (meetingProof === proof) meetingProof = null; throw e }
    }
    /** Receipt alone cannot connect an account: confirm with this session's one-use browser proof. */
    suspend fun confirmMeetingConnect(provider: String, receipt: String): MeetingConfirmResult = withContext(dispatcher) {
        val proof = meetingProof
        meetingProof = null
        if (proof == null || proof.provider != provider || proof.userId != myId || proof.session != sessionGeneration || now() - proof.startedAt > 15 * 60_000)
            throw ApiException(409, "meeting_confirmation_invalid", "")
        val result = req("POST", "/meetings/connect/confirm", buildJsonObject {
            put("receipt", JsonPrimitive(receipt)); put("proofVerifier", JsonPrimitive(proof.verifier))
        }, MeetingConfirmResult.serializer())
        if (!result.ok || result.provider != provider) throw ApiException(409, "meeting_confirmation_invalid", "")
        result
    }
    suspend fun disconnectMeeting(provider: String) = withContext(dispatcher) {
        cancelMeetingConnect()
        req("DELETE", "/meetings/connections/${enc(provider)}", null, JsonElement.serializer())
        setState { copy(meetingConnections = meetingConnections?.map { if (it.provider == provider) it.copy(status = "none", accountEmail = null) else it }) }
        Unit
    }
    suspend fun meetingStatus(id: String): MeetingDTO = withContext(dispatcher) {
        req("GET", "/meetings/${enc(id)}", null, MeetingDTO.serializer())
    }
    /** Read first, then recover the exact reserved operation; the server controls safe provider retries. */
    suspend fun resolveMeetingAttempt(payload: MeetingRequest, key: String, meetingId: String?): MeetingDTO = withContext(dispatcher) {
        meetingId?.let { id -> meetingStatus(id).takeIf { it.usableUrl != null }?.let { return@withContext it } }
        createMeeting(payload.provider, payload.conversationId, key, payload.title, payload.startsAt?.let(Instant::parse),
            payload.durationMin, payload.timezone, payload.share)
    }
    /**
     * Crea la reunión con el proveedor (POST /meetings). Sin [startsAt] es ahora. [idempotencyKey]: la misma en el
     * reintento devuelve la misma reunión. Con [share], y solo si el proveedor confirma, el servidor publica el enlace
     * en la conversación y crea la reunión del calendario (location = joinUrl).
     */
    suspend fun createMeeting(provider: String, conversationId: String?, idempotencyKey: String, title: String, startsAt: Instant?, durationMin: Int,
                              timezone: String, share: Boolean = true): MeetingDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            put("provider", JsonPrimitive(provider)); put("conversationId", conversationId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("idempotencyKey", JsonPrimitive(idempotencyKey)); put("title", JsonPrimitive(title))
            put("startsAt", startsAt?.let { JsonPrimitive(it.toString()) } ?: JsonNull)
            put("durationMin", JsonPrimitive(durationMin)); put("timezone", JsonPrimitive(timezone)); put("share", JsonPrimitive(share))
        }
        val m = req("POST", "/meetings", body, MeetingDTO.serializer())
        // Un 409/502 ya dejó la conexión en «reconectar» en el servidor: la lista se refresca aparte.
        m
    }

    // ---------- gg, el asistente (docs/ASISTENTE.md) ----------
    /** Un turno: los últimos 20 mensajes (con el resumen de acciones) → respuesta y tarjetas. */
    suspend fun assistantTurn(messages: List<AssistantMessage>, timezone: String, lang: String, aiConsent: Boolean = false): AssistantTurnDTO = withContext(dispatcher) {
        if (!aiConsent) throw ApiException(403, "ai_consent_required", "AI consent required")
        val body = buildJsonObject {
            put("aiConsent", JsonPrimitive(true))
            put("messages", TcJson.encodeToJsonElement(ListSerializer(AssistantMessage.serializer()), messages))
            put("timezone", JsonPrimitive(timezone)); put("lang", JsonPrimitive(lang))
        }
        req("POST", "/assistant/turn", body, AssistantTurnDTO.serializer())
    }
    /** Confirma una acción pendiente (token) o deshace una hecha (undoToken); [text] = mensaje editado. */
    suspend fun assistantRun(token: String, text: String? = null): AssistantActionDTO = withContext(dispatcher) {
        val body = buildJsonObject { put("token", JsonPrimitive(token)); if (text != null) put("text", JsonPrimitive(text)) }
        req("POST", "/assistant/run", body, AssistantActionDTO.serializer())
    }
    /** Historial local de gg de la persona con sesión (el de otra cuenta se descarta). */
    fun assistantHistory(): List<AssistantTurn> = myId?.let { Assistant.load(storage, it) } ?: emptyList()
    fun saveAssistantHistory(turns: List<AssistantTurn>) { myId?.let { Assistant.save(storage, it, turns) } }
    fun assistantSpeak(): Boolean = storage.get(Assistant.SPEAK_KEY) != "0"
    fun setAssistantSpeak(on: Boolean) = storage.set(Assistant.SPEAK_KEY, if (on) "1" else "0")

    // ---------- «No molestar» (SPEC-silencio §3) ----------
    /** Valor vigente (estado o, antes del primer bootstrap —p. ej. un push con la app cerrada—, el guardado). */
    fun dndUntil(): String? = if (s.data != null) s.dndUntil else storage.get(DND_KEY)
    /** «No molestar» manual o dentro de mi horario de descanso (todas las noches). */
    fun dndActive(): Boolean = Silence.active(dndUntil(), now()) || SleepMode.sleepingNow(SleepMode.of(mySleep()), Instant.ofEpochMilli(now()))

    private fun applyDnd(until: String?, localOnly: Boolean) {
        val v = until?.takeIf { Silence.active(it, now()) }
        storage.set(DND_KEY, v); storage.set(DND_LOCAL_KEY, if (localOnly) "1" else null)
        setState { copy(dndUntil = v, dndLocalOnly = localOnly) }
    }

    /**
     * PUT /me/dnd `{ until }` (null apaga). Devuelve true si quedó en el servidor; false si el servidor no conoce
     * la ruta (404) y quedó solo en este dispositivo. Otros errores deshacen el cambio y se lanzan.
     */
    suspend fun setDnd(until: String?): Boolean = withContext(dispatcher) {
        val before = s.dndUntil to s.dndLocalOnly
        applyDnd(until, s.dndLocalOnly)
        try {
            val r = req("PUT", "/me/dnd", buildJsonObject { put("until", until?.let { JsonPrimitive(it) } ?: JsonNull) }, JsonElement.serializer())
            val v = ((r as? JsonObject)?.get("dndUntil") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            applyDnd(v, localOnly = false)
            true
        } catch (e: ApiException) {
            if (e.status == 404 || e.status == 405) { applyDnd(until, localOnly = true); false }
            else { applyDnd(before.first, before.second); throw e }
        } catch (e: Exception) {
            applyDnd(before.first, before.second); throw e
        }
    }

    // ---------- Mensajes programados (docs/PROGRAMADOS.md) ----------
    suspend fun loadScheduled(conversationId: String? = null): List<ScheduledMessageDTO> = withContext(dispatcher) {
        val r = req("GET", "/scheduled" + q("conversationId" to conversationId), null, ScheduledPage.serializer())
        if (conversationId == null) setState { copy(scheduled = r.scheduled.sortedBy { it.sendAt }) }
        else setState { copy(scheduled = (scheduled.filter { it.conversationId != conversationId } + r.scheduled).sortedBy { it.sendAt }) }
        r.scheduled
    }
    private fun putScheduled(s0: ScheduledMessageDTO): ScheduledMessageDTO { setState { copy(scheduled = Scheduling.apply(scheduled, s0)) }; return s0 }
    suspend fun scheduleMessage(conversationId: String, body: String, sendAt: Instant, mentions: List<MentionDTO> = emptyList(), replyTo: String? = null): ScheduledMessageDTO = withContext(dispatcher) {
        val b = buildJsonObject {
            put("body", JsonPrimitive(body)); put("sendAt", JsonPrimitive(sendAt.toString()))
            if (mentions.isNotEmpty()) put("mentions", TcJson.encodeToJsonElement(ListSerializer(MentionDTO.serializer()), mentions))
            replyTo?.let { put("replyTo", JsonPrimitive(it)) }
        }
        putScheduled(req("POST", "/conversations/$conversationId/scheduled", b, ScheduledMessageDTO.serializer()))
    }
    suspend fun updateScheduled(id: String, body: String? = null, sendAt: Instant? = null): ScheduledMessageDTO = withContext(dispatcher) {
        val b = buildJsonObject { body?.let { put("body", JsonPrimitive(it)) }; sendAt?.let { put("sendAt", JsonPrimitive(it.toString())) } }
        putScheduled(req("PATCH", "/scheduled/$id", b, ScheduledMessageDTO.serializer()))
    }
    suspend fun cancelScheduled(id: String): ScheduledMessageDTO = withContext(dispatcher) { putScheduled(req("DELETE", "/scheduled/$id", null, ScheduledMessageDTO.serializer())) }
    suspend fun sendScheduledNow(id: String): ScheduledMessageDTO = withContext(dispatcher) { putScheduled(req("POST", "/scheduled/$id/send", buildJsonObject {}, ScheduledMessageDTO.serializer())) }

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
    /** Sonido de un chat (docs/SONIDOS.md): null = mi predeterminado; "none" = sin sonido. */
    suspend fun setConversationSound(id: String, sound: String?) = withContext(dispatcher) {
        val before = meta(id)?.sound
        patchMeta(id) { copy(sound = sound) }
        try { req("PUT", "/conversations/$id/prefs", buildJsonObject { put("sound", sound?.let { JsonPrimitive(it) } ?: JsonNull) }, JsonElement.serializer()) }
        catch (e: Exception) { patchMeta(id) { copy(sound = before) }; throw e }
        Unit
    }
    /** Mi sonido predeterminado y mi tono de llamada (PUT /me/sounds). Solo se manda lo que cambia; null = el de fábrica. */
    suspend fun setMySounds(messageSound: String? = UNCHANGED, ringtone: String? = UNCHANGED) = withContext(dispatcher) {
        val body = buildJsonObject {
            if (messageSound !== UNCHANGED) put("messageSound", messageSound?.let { JsonPrimitive(it) } ?: JsonNull)
            if (ringtone !== UNCHANGED) put("ringtone", ringtone?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        val r = req("PUT", "/me/sounds", body, MySounds.serializer())
        setState { copy(data = data?.copy(me = data.me.copy(messageSound = r.messageSound, ringtone = r.ringtone))) }
        r
    }
    suspend fun setWorkspacePinned(id: String, pinned: Boolean) = withContext(dispatcher) {
        setState { copy(data = data?.copy(workspaces = data.workspaces.map { if (it.id == id) it.copy(pinnedAt = if (pinned) Instant.ofEpochMilli(now()).toString() else null) else it })) }
        req("PUT", "/workspaces/$id/prefs", buildJsonObject { put("pinned", JsonPrimitive(pinned)) }, JsonElement.serializer()); Unit
    }
    suspend fun markUnread(conversationId: String, seq: Long) = withContext(dispatcher) {
        val r = req("POST", "/conversations/$conversationId/unread", buildJsonObject { put("seq", JsonPrimitive(seq)) }, ReadResult.serializer())
        readJobs[conversationId]?.cancel()
        patchMeta(conversationId) { copy(lastReadSeq = r.lastReadSeq, unread = maxOf(0L, lastMessageSeq - maxOf(r.lastReadSeq, historyFromSeq)).toInt(), unreadMentions = if (r.lastReadSeq >= lastMessageSeq) 0 else unreadMentions) }
    }
    suspend fun markConversationRead(conversationId: String): Boolean = withContext(dispatcher) {
        val c = meta(conversationId) ?: return@withContext false
        markRead(conversationId, c.lastMessageSeq)
        true
    }
    /**
     * «Marcar como leído» desde la lista (docs/TANDA-LECTURA-REUNIONES.md §1): el grupo y sus derivadas pendientes,
     * cada una hasta el lastMessageSeq que este cliente conoce (POST /conversations/:id/read-tree). Es una acción
     * explícita: marca lo que la lista mostraba; lo que llegue mientras tanto (seq mayor) sigue sin leer.
     * Sólo aplica los cursores confirmados; un rechazo deja todos los pendientes intactos.
     * Devuelve cuántas conversaciones marcó el servidor.
     */
    suspend fun markTreeRead(rootId: String): Int = withContext(dispatcher) {
        val d = s.data ?: return@withContext 0
        val root = d.conversations.firstOrNull { it.id == rootId } ?: return@withContext 0
        val items = ReadTree.items(d, root, now())
        val r = request("POST", "/conversations/$rootId/read-tree", TcJson.encodeToString(ReadTreeBody.serializer(), ReadTreeBody(items)), ReadTreeResult.serializer())
        // El servidor puede tener un cursor más adelante (otro dispositivo): se aplica sin retroceder.
        for (m in r.marked) patchMeta(m.conversationId) { ReadTree.applyRead(this, m.lastReadSeq) }
        r.marked.size
    }

    private fun patchPreviewIfLast(m: MessageDTO) {
        val c = meta(m.conversationId) ?: return
        if (c.lastMessageSeq == m.seq) patchMeta(c.id) { copy(lastMessagePreview = m.body.take(140)) }
    }
    private fun upsertLocal(m: MessageDTO) {
        if (s.conversations[m.conversationId]?.loaded == true) setConv(m.conversationId) { copy(messages = upsertMessage(messages, m)) }
        patchPreviewIfLast(m)
    }
    /** Siempre manda las menciones (con mentions reemplaza las anteriores; sin ellas se quitarían al cambiar el texto). */
    suspend fun editMessage(id: String, body: String, mentions: List<MentionDTO> = emptyList()): MessageDTO = withContext(dispatcher) {
        val (text, ments, refs) = Refs.split(body, mentions)
        val payload = buildJsonObject {
            put("body", JsonPrimitive(text))
            put("mentions", TcJson.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(MentionDTO.serializer()), ments))
            put("refs", TcJson.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(RefInput.serializer()), refs))
        }
        req("PATCH", "/messages/$id", payload, MessageDTO.serializer()).also { upsertLocal(it) }
    }

    /** Bandeja «Menciones»: mis menciones recientes; para paginar, before = createdAt de la última. */
    suspend fun loadMentions(before: String? = null, limit: Int = 30): MentionsPage = withContext(dispatcher) {
        req("GET", "/mentions" + q("before" to before, "limit" to limit.toString()), null, MentionsPage.serializer())
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

    // ---------- Temas (docs/TEMAS.md) ----------
    // ---------- Tanda 1.7 (docs/TANDA-1.7.md) ----------
    /** Buscar dentro del chat: sin mayúsculas ni tildes, también adjuntos y transcripciones; before = seq del último resultado. */
    suspend fun searchConversation(conversationId: String, query: String, before: Long? = null, limit: Int = 30): ChatSearchPageDTO = withContext(dispatcher) {
        req("GET", "/conversations/${enc(conversationId)}/search" + q("q" to query.trim(), "before" to before?.toString(), "limit" to limit.toString()), null, ChatSearchPageDTO.serializer())
    }
    /** Abrir un mensaje de una sola vista (una vez por persona; 410 already_opened la segunda). */
    suspend fun openViewOnce(m: MessageDTO): ViewOnceOpenDTO = withContext(dispatcher) {
        try {
            req("POST", "/messages/${m.id}/open", buildJsonObject {}, ViewOnceOpenDTO.serializer())
        } finally {
            // Abierto (o ya abierto antes): queda «Abierto» aunque el evento llegue después.
            upsertLocal(m.copy(viewOnceState = "opened"))
        }
    }
    suspend fun eventComments(eventId: String): List<EventCommentDTO> = withContext(dispatcher) {
        decodeEventComments(req("GET", "/events/${enc(eventId)}/comments", null, JsonElement.serializer()))
    }
    suspend fun commentEvent(eventId: String, body: String) = withContext(dispatcher) {
        req("POST", "/events/${enc(eventId)}/comments", buildJsonObject { put("body", JsonPrimitive(body.trim())) }, JsonElement.serializer())
        runCatching { getEventInternal(eventId) }
        Unit
    }

    // ---------- Llamadas (docs/LLAMADAS.md) ----------
    private fun putCall(call: CallDTO) = setState { copy(calls = Calls.put(calls, call), callsRevision = callsRevision + 1) }
    private fun callsPath(id: String, tail: String) = "/calls/${enc(id)}/$tail"

    /** GET /conversations/:id/call: la llamada en curso (o null). */
    suspend fun loadCall(conversationId: String): CallDTO? = withContext(dispatcher) {
        val r = req("GET", "/conversations/${enc(conversationId)}/call", null, CallEnvelope.serializer())
        setState { copy(calls = calls + (conversationId to r.call?.takeIf { !it.ended })) }
        r.call
    }
    /** Empieza la llamada o entra a la que está en curso (dos que llaman a la vez caen en la misma). */
    suspend fun startCall(conversationId: String, kind: String): CallJoinDTO = withContext(dispatcher) {
        req("POST", "/conversations/${enc(conversationId)}/call", buildJsonObject { put("kind", JsonPrimitive(kind)) }, CallJoinDTO.serializer()).also { putCall(it.call) }
    }
    suspend fun joinCall(callId: String): CallJoinDTO = withContext(dispatcher) {
        req("POST", callsPath(callId, "join"), buildJsonObject {}, CallJoinDTO.serializer()).also { putCall(it.call) }
    }
    /** Sumar personas a la llamada en curso (les suena aunque no estén en el chat). */
    suspend fun inviteToCall(callId: String, userIds: List<String>): CallDTO? = withContext(dispatcher) {
        req("POST", callsPath(callId, "invite"), buildJsonObject { put("userIds", kotlinx.serialization.json.JsonArray(userIds.map { JsonPrimitive(it) })) }, CallInviteResult.serializer()).call?.also { putCall(it) }
    }
    /** Un pedazo del micrófono propio para Groq Whisper; reintentar con el mismo [segId] no duplica. */
    suspend fun sendCallAudio(callId: String, bytes: ByteArray, fileType: String, segId: String, offsetMs: Long, durationMs: Long): CallAudioResult = withContext(dispatcher) {
        request("POST", callsPath(callId, "audio"), null, CallAudioResult.serializer(), HttpApi.RawBody(bytes, "application/octet-stream", mapOf(
            "x-file-type" to fileType, "x-seg-id" to segId, "x-offset-ms" to maxOf(0L, offsetMs).toString(), "x-duration-ms" to maxOf(0L, durationMs).toString())))
    }
    suspend fun callHeartbeat(callId: String) = withContext(dispatcher) { req("POST", callsPath(callId, "heartbeat"), buildJsonObject {}, JsonElement.serializer()); Unit }
    /** Colgar (o terminarla para todos con [forAll]). */
    suspend fun leaveCall(callId: String, forAll: Boolean = false): CallDTO? = withContext(dispatcher) {
        req("POST", callsPath(callId, if (forAll) "end" else "leave"), buildJsonObject {}, CallEnvelope.serializer()).call?.also { putCall(it) }
    }
    /** Prender o apagar la transcripción; [aiSummary]: quien la prende autoriza el resumen con IA al colgar. */
    suspend fun setCallTranscription(callId: String, on: Boolean, aiSummary: Boolean = false): CallDTO? = withContext(dispatcher) {
        req("POST", callsPath(callId, "transcription"), buildJsonObject { put("on", JsonPrimitive(on)); put("aiSummary", JsonPrimitive(aiSummary)) }, CallEnvelope.serializer()).call?.also { putCall(it) }
    }
    suspend fun sendCallTranscript(callId: String, segments: List<CallTranscriptSegmentInput>): Int = withContext(dispatcher) {
        req("POST", callsPath(callId, "transcript"), TcJson.encodeToJsonElement(CallTranscriptBody.serializer(), CallTranscriptBody(segments)), CallTranscriptSaved.serializer()).saved
    }
    suspend fun callTranscript(callId: String): CallTranscriptDTO = withContext(dispatcher) { req("GET", callsPath(callId, "transcript"), null, CallTranscriptDTO.serializer()) }
    suspend fun callHistory(before: String? = null, limit: Int = 30): CallHistoryPage = withContext(dispatcher) {
        req("GET", "/calls" + q("limit" to limit.toString(), "before" to before), null, CallHistoryPage.serializer())
    }
    /** Compartir en otro chat (sale como mensaje mío). what: summary | transcript | both. */
    suspend fun shareCall(callId: String, conversationId: String, what: String): MessageDTO? = withContext(dispatcher) {
        req("POST", callsPath(callId, "share"), buildJsonObject { put("conversationId", JsonPrimitive(conversationId)); put("what", JsonPrimitive(what)) }, CallShareResult.serializer()).message
    }

    private fun putTopics(conversationId: String, topics: List<TopicDTO>) = setState { copy(topics = this.topics + (conversationId to topics)) }

    suspend fun loadTopics(conversationId: String): List<TopicDTO> = withContext(dispatcher) {
        req("GET", "/conversations/$conversationId/topics", null, TopicsPage.serializer()).topics.also { putTopics(conversationId, it) }
    }

    /** 409 si el nombre está repetido o se llega al tope técnico ([Topics.LIMIT]): la interfaz muestra el mensaje del servidor. */
    suspend fun createTopic(conversationId: String, name: String, color: String?, icon: String?): TopicDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            put("name", JsonPrimitive(name.trim().take(40)))
            color?.let { put("color", JsonPrimitive(it)) }
            icon?.let { put("icon", JsonPrimitive(it)) }
        }
        val r = req("POST", "/conversations/$conversationId/topics", body, TopicCreated.serializer())
        putTopics(conversationId, r.topics)
        r.topic
    }

    /** Renombrar, cambiar color o ícono, archivar (archived = true) o restaurar (false; también respeta el tope). */
    suspend fun updateTopic(t: TopicDTO, name: String? = null, color: String? = null, icon: String? = null, archived: Boolean? = null): List<TopicDTO> = withContext(dispatcher) {
        val body = buildJsonObject {
            name?.let { put("name", JsonPrimitive(it.trim().take(40))) }
            color?.let { put("color", JsonPrimitive(it)) }
            icon?.let { put("icon", JsonPrimitive(it)) }
            archived?.let { put("archived", JsonPrimitive(it)) }
        }
        req("PATCH", "/topics/${t.id}", body, TopicsPage.serializer()).topics.also { putTopics(t.conversationId, it) }
    }

    /** Quitar un tema: sus mensajes quedan sin tema (no se borra ninguno). Devuelve cuántos quedaron sin tema. */
    suspend fun deleteTopic(t: TopicDTO): Int = withContext(dispatcher) {
        val r = req("DELETE", "/topics/${t.id}", null, TopicsPage.serializer())
        putTopics(t.conversationId, r.topics)
        if (s.conversations[t.conversationId]?.loaded == true) setConv(t.conversationId) { copy(messages = Topics.clear(messages, t.id)) }
        r.cleared
    }

    /** Etiquetar cualquier mensaje del chat con un tema activo; null lo deja sin tema. */
    suspend fun setMessageTopic(m: MessageDTO, topicId: String?): MessageDTO = withContext(dispatcher) {
        // topicId: null debe viajar explícito (TcJson omite los nulos).
        val body = buildJsonObject { put("topicId", topicId?.let { JsonPrimitive(it) } ?: JsonNull) }
        req("PUT", "/messages/${m.id}/topic", body, MessageDTO.serializer()).also { upsertLocal(it.copy(conversationId = it.conversationId.ifEmpty { m.conversationId })) }
    }

    // ---------- Reacciones (docs/REACCIONES_ENLACES.md) ----------
    /**
     * Pone o quita mi reacción, optimista: el chip cambia al instante y, si el API falla, vuelve como estaba.
     * [remindAt]: hora del recordatorio de 👀 (solo con reacciones con acción). Aplica el mensaje que devuelve
     * el servidor y los recordatorios creados o cerrados. 409 = ya hay 20 emojis distintos.
     */
    suspend fun react(message: MessageDTO, rawEmoji: String, on: Boolean, remindAt: Instant? = null): ReactResult = withContext(dispatcher) {
        val emoji = Reactions.normalize(rawEmoji) ?: throw ApiException(400, "invalid_emoji", "Emoji inválido")
        val me = myId ?: throw ApiException(401, "unauthorized", "Sin sesión")
        fun current() = s.conversations[message.conversationId]?.messages?.firstOrNull { it.id == message.id } ?: message
        val prev = current().reactions
        upsertLocal(current().copy(reactions = Reactions.toggle(prev, emoji, me, on)))
        try {
            val path = "/messages/${message.id}/reactions/${enc(emoji)}"
            val r = if (on) req("PUT", path, buildJsonObject { remindAt?.let { put("remindAt", JsonPrimitive(it.toString())) } }, ReactResult.serializer())
                else req("DELETE", path, null, ReactResult.serializer())
            r.message?.let { upsertLocal(it) }
            if (r.reminder != null || r.closedReminderIds.isNotEmpty()) {
                val closed = r.closedReminderIds.toSet()
                setState { copy(reminders = (reminders.filter { it.id !in closed && it.id != r.reminder?.id } + listOfNotNull(r.reminder)).sortedBy { it.remindAt }) }
            }
            r
        } catch (e: Exception) {
            upsertLocal(current().copy(reactions = prev)); throw e
        }
    }

    /** Busca un mensaje por id en lo cargado, pidiendo páginas viejas si hace falta (push de reacción). Devuelve su seq. */
    suspend fun ensureMessageId(conversationId: String, messageId: String): Long? {
        openConversation(conversationId)
        while (true) {
            val c = state.value.conversations[conversationId] ?: return null
            if (!c.loaded) return null
            c.messages.firstOrNull { it.id == messageId }?.let { return it.seq }
            if (!c.hasMore) return null
            if (!loadOlder(conversationId)) return null
        }
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
    suspend fun getEvent(id: String): CalendarEventDTO = withContext(dispatcher) { getEventInternal(id) }
    private suspend fun getEventInternal(id: String): CalendarEventDTO = req("GET", "/events/$id", null, CalendarEventDTO.serializer()).also { putEvents(listOf(it)) }
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
        while (true) {
            val c = state.value.conversations[conversationId] ?: return false
            if (!c.loaded) return false
            if (c.messages.any { it.seq == seq }) return true
            if (!c.hasMore || (c.messages.firstOrNull()?.seq ?: 0) <= seq) return false
            if (!loadOlder(conversationId)) return false
        }
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
        plan.forEach { send(it.conversationId, it.body, null, it.forwarded, forwardAttachments = it.forwardAttachments) }
        return plan.map { it.conversationId }.distinct().size
    }

    // ---------- Adjuntos (SPEC-v4 §A) ----------
    /**
     * POST /conversations/:id/attachments con el archivo en crudo (se transmite desde disco). Queda pendiente en el
     * servidor hasta que un mensaje lo use con [send]. [onProgress] recibe (enviados, total).
     */
    suspend fun uploadAttachment(
        conversationId: String, file: java.io.File, name: String, contentType: String,
        voice: Voice? = null, onProgress: ((Long, Long) -> Unit)? = null,
    ): AttachmentDTO =
        withContext(dispatcher) {
            if (file.length() > Attachments.MAX_BYTES) throw ApiException(413, "too_large", "El archivo pesa más de 25 MB.")
            val type = contentType.ifBlank { "application/octet-stream" }
            val raw = HttpApi.RawBody(ByteArray(0), "application/octet-stream",
                mapOf("x-file-name" to java.net.URLEncoder.encode(name.ifBlank { "archivo" }, "UTF-8").replace("+", "%20"), "x-file-type" to type) +
                    (voice?.headers() ?: emptyMap()) +
                    // Idioma de la transcripción: el de la app.
                    mapOf("accept-language" to java.util.Locale.getDefault().toLanguageTag()),
                file = file, onProgress = onProgress)
            request("POST", "/conversations/$conversationId/attachments", null, AttachmentDTO.serializer(), raw)
        }

    /** Resumen sugerido para «Llevar al hilo» (DeepSeek si hay llave; si no, las últimas respuestas). */
    suspend fun suggestReturn(sideId: String, aiConsent: Boolean = false): ReturnSuggestion = withContext(dispatcher) {
        val raw = HttpApi.RawBody("{\"aiConsent\":$aiConsent}".toByteArray(), "application/json", mapOf("accept-language" to java.util.Locale.getDefault().toLanguageTag()))
        request("POST", "/conversations/$sideId/return/suggest", null, ReturnSuggestion.serializer(), raw)
    }

    /** Nota de voz (SPEC-v4 §F): cabeceras x-voice-note, x-duration-ms y x-waveform (≤ 64 valores 0–1). */
    data class Voice(val durationMs: Long, val waveform: List<Float>, val aiConsent: Boolean = false) {
        fun headers(): Map<String, String> = mapOf(
            "x-voice-note" to "1", "x-duration-ms" to durationMs.toString(),
            "x-waveform" to Waveform.encode(waveform),
        ) + if (aiConsent) mapOf("x-ai-consent" to "1") else emptyMap()
    }

    /** Reintento manual de la transcripción (autor o miembros). */
    suspend fun retranscribe(attachmentId: String, aiConsent: Boolean = false): AttachmentDTO = withContext(dispatcher) {
        request("POST", "/attachments/$attachmentId/transcribe", "{\"aiConsent\":$aiConsent}", AttachmentDTO.serializer())
    }

    /** POST /attachments/:id/thumb: miniatura JPEG ≤ 512 KB que genera el cliente (solo mientras está pendiente). */
    suspend fun uploadThumb(attachmentId: String, jpeg: ByteArray): AttachmentDTO? = withContext(dispatcher) {
        if (jpeg.isEmpty() || jpeg.size > 512 * 1024) return@withContext null
        runCatching { request("POST", "/attachments/$attachmentId/thumb", null, AttachmentDTO.serializer(), HttpApi.RawBody(jpeg, "application/octet-stream", mapOf("x-file-type" to "image/jpeg"))) }.getOrNull()
    }

    /** Descarga autenticada de un adjunto (o su miniatura) a [dest]; renueva el token si hace falta. */
    suspend fun downloadAttachment(path: String, dest: java.io.File, onProgress: ((Long, Long) -> Unit)? = null) = withContext(dispatcher) {
        if (accessToken != null && now() > accessExp - 30_000) refresh()
        var code = http.download(path, accessToken, dest, onProgress)
        if (code == 401 && refresh() == RefreshOutcome.OK) code = http.download(path, accessToken, dest, onProgress)
        if (code !in 200..299) throw ApiException(code, if (code == 403) "forbidden" else if (code == 404) "not_found" else "http_$code", "HTTP $code")
    }

    /** Token vigente para cargar imágenes protegidas (miniaturas de adjuntos). */
    suspend fun bearer(): String? = withContext(dispatcher) {
        if (accessToken != null && now() > accessExp - 30_000) refresh()
        accessToken
    }

    // ---------- Firmar PDFs ----------
    /** Mis firmas guardadas (firma e iniciales), la más nueva primero. */
    suspend fun listSignatures(): List<SignatureDTO> = withContext(dispatcher) {
        req("GET", "/me/signatures", null, SignaturesPage.serializer()).signatures
    }

    /** POST /me/signatures: PNG crudo, recortado y transparente; kind signature|initials, source drawn|typed|uploaded. */
    suspend fun createSignature(png: ByteArray, kind: String, source: String): SignatureDTO = withContext(dispatcher) {
        if (png.size > Signing.MAX_PNG_BYTES) throw ApiException(413, "too_large", "La firma pesa más de 512 KB")
        request("POST", "/me/signatures", null, SignatureDTO.serializer(),
            HttpApi.RawBody(png, "image/png", mapOf("x-signature-kind" to kind, "x-signature-source" to source)))
    }

    suspend fun deleteSignature(id: String) = withContext(dispatcher) { req("DELETE", "/me/signatures/$id", null, JsonElement.serializer()); Unit }

    /** Lo que el servidor sabe del PDF: firma digital, contraseña y firmas hechas en Chaggu. 422 not_pdf si no es PDF. */
    suspend fun signInfo(attachmentId: String): SignInfoDTO = withContext(dispatcher) {
        req("GET", "/attachments/$attachmentId/sign-info", null, SignInfoDTO.serializer())
    }

    /**
     * Estampa las marcas en el servidor, que responde en el hilo con el PDF firmado (201; 200 si es un reintento del
     * mismo clientMessageId). 409 has_digital_signature: repetir con acceptBreakingSignatures tras confirmarlo.
     */
    suspend fun signPdf(attachmentId: String, input: SignPdfInput): SignPdfResult = withContext(dispatcher) {
        val r = request("POST", "/attachments/$attachmentId/sign", TcJson.encodeToString(SignPdfInput.serializer(), input), SignPdfResult.serializer())
        // El mensaje también llega por el socket; así se ve de inmediato.
        r.message?.let { if (it.id.isNotBlank() && it.conversationId.isNotBlank()) upsertLocal(it) }
        r
    }

    /** «Documentos que firmé»: páginas hacia atrás con [before] (nextBefore de la anterior) y búsqueda [q]. */
    suspend fun signings(before: String? = null, q: String? = null, limit: Int = 30): SigningHistoryPage = withContext(dispatcher) {
        req("GET", "/me/signings" + q("limit" to limit.toString(), "before" to before, "q" to q?.trim()?.takeIf { it.isNotEmpty() }), null, SigningHistoryPage.serializer())
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

    /** «💬 Hablar aparte» desde un asunto (docs/TAREAS.md): el sidechat queda con sideIssueId y sus tareas cuelgan del asunto. */
    suspend fun startSideFromIssue(conversationId: String, issueId: String, userIds: List<String>, question: String?): String = withContext(dispatcher) {
        val body = buildJsonObject {
            put("issueId", JsonPrimitive(issueId))
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

    /**
     * POST /workspaces/:id/conversations (SPEC-v4 §D «Grupo en un espacio»): kind group | internal,
     * level directivo | null, miembros del espacio. Recarga el snapshot para abrir el grupo.
     */
    suspend fun createSpaceGroup(workspaceId: String, name: String, internal: Boolean, directive: Boolean, memberIds: List<String>): IdResult = withContext(dispatcher) {
        val body = buildJsonObject {
            put("name", JsonPrimitive(name.trim().take(120)))
            put("kind", JsonPrimitive(if (internal) "internal" else "group"))
            put("level", if (directive && !internal) JsonPrimitive("directivo") else JsonNull)
            put("memberIds", kotlinx.serialization.json.JsonArray(memberIds.distinct().map { JsonPrimitive(it) }))
        }
        val r = req("POST", "/workspaces/$workspaceId/conversations", body, IdResult.serializer()); loadBootstrapInternal(); r
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

    /** Suma personas a una conversación: [history] 'now' (ven solo lo nuevo) o 'all' (ven el historial). */
    suspend fun addMembers(conversationId: String, userIds: List<String>, history: String = "now") = withContext(dispatcher) {
        val body = buildJsonObject {
            put("userIds", kotlinx.serialization.json.JsonArray(userIds.distinct().map { JsonPrimitive(it) }))
            put("history", JsonPrimitive(if (history == "all") "all" else "now"))
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
    suspend fun removeMember(conversationId: String, userId: String, expectedSession: Long = sessionGeneration) = withContext(dispatcher) {
        requireSession(expectedSession)
        req("DELETE", "/conversations/$conversationId/members/$userId", null, JsonElement.serializer())
        requireSession(expectedSession)
        loadBootstrapInternal(); Unit
    }

    /** Nombrar o quitar admin del grupo (también «Dejar de ser admin» sobre mí). Devuelve los admins vigentes. */
    suspend fun setMemberAdmin(conversationId: String, userId: String, admin: Boolean, expectedSession: Long = sessionGeneration): List<String> = withContext(dispatcher) {
        requireSession(expectedSession)
        val r = req("PUT", "/conversations/$conversationId/members/$userId/admin", buildJsonObject { put("admin", JsonPrimitive(admin)) }, AdminIdsResult.serializer())
        requireSession(expectedSession)
        patchMeta(conversationId) { copy(adminIds = r.adminIds) }
        loadBootstrapInternal(); r.adminIds
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

    // ---------- Grupos, invitaciones con enlace y supervisión (docs/GRUPOS.md) ----------
    /** Destino del «+» de Grupos: grupo interno, grupo en una relación existente o relación nueva. */
    sealed interface GroupTarget {
        data class Org(val orgId: String? = null) : GroupTarget
        data class Workspace(val workspaceId: String) : GroupTarget
        data class Company(val companyName: String, val orgId: String? = null) : GroupTarget
    }

    /** POST /groups; después refresca el snapshot para poder abrir el grupo. */
    suspend fun createGroup(
        name: String, target: GroupTarget, memberIds: List<String>, inviteEmails: List<String>,
        inviteRole: String, shareLink: Boolean, lang: String,
    ): CreateGroupResultDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            put("name", JsonPrimitive(name.trim().take(120)))
            put("target", buildJsonObject {
                when (target) {
                    is GroupTarget.Org -> { put("kind", JsonPrimitive("org")); target.orgId?.let { put("orgId", JsonPrimitive(it)) } }
                    is GroupTarget.Workspace -> { put("kind", JsonPrimitive("workspace")); put("workspaceId", JsonPrimitive(target.workspaceId)) }
                    is GroupTarget.Company -> {
                        put("kind", JsonPrimitive("company")); put("companyName", JsonPrimitive(target.companyName.trim().take(120)))
                        target.orgId?.let { put("orgId", JsonPrimitive(it)) }
                    }
                }
            })
            put("memberIds", kotlinx.serialization.json.JsonArray(memberIds.distinct().map { JsonPrimitive(it) }))
            put("inviteEmails", kotlinx.serialization.json.JsonArray(inviteEmails.distinct().map { JsonPrimitive(it) }))
            put("inviteRole", JsonPrimitive(inviteRole))
            put("shareLink", JsonPrimitive(shareLink))
            put("lang", JsonPrimitive(lang))
        }
        val r = req("POST", "/groups", body, CreateGroupResultDTO.serializer())
        loadBootstrapInternal(); r
    }

    /**
     * POST /workspaces/:id/invitations a un grupo (o al espacio, sin [conversationId]): con [email] es una
     * invitación por correo; sin correo, un enlace con código para varias personas (multiUse, 14 días).
     */
    suspend fun inviteToGroup(
        workspaceId: String, conversationId: String?, role: String, email: String?, lang: String,
        history: String = "all",
    ): InvitationCreatedDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            email?.let { put("email", JsonPrimitive(it.trim())) }
            put("role", JsonPrimitive(role))
            put("conversationIds", kotlinx.serialization.json.JsonArray(listOfNotNull(conversationId).map { JsonPrimitive(it) }))
            if (email == null) { put("multiUse", JsonPrimitive(true)); put("expiresInDays", JsonPrimitive(14)) }
            put("history", JsonPrimitive(if (history == "now") "now" else "all"))
            put("lang", JsonPrimitive(lang))
        }
        req("POST", "/workspaces/$workspaceId/invitations", body, InvitationCreatedDTO.serializer())
    }

    /** POST /organizations/:id/invitations: invitar a una colega a mi empresa por correo («Invitar a la empresa…»). */
    suspend fun inviteToOrg(orgId: String, email: String, lang: String) = withContext(dispatcher) {
        val body = buildJsonObject { put("email", JsonPrimitive(email.trim())); put("lang", JsonPrimitive(lang)) }
        req("POST", "/organizations/$orgId/invitations", body, JsonElement.serializer()); Unit
    }

    /**
     * «De {mi empresa}» desde «Agregar al grupo» (SPEC-invitar): invitación a mi organización que además lleva al
     * grupo ([workspaceId], [conversationId], [history]). Con [email] va por correo; sin él es un enlace con código
     * de varios usos por 14 días. Un servidor sin esos campos crea la invitación a la empresa y el enlace se arma
     * con el token (/signup?org=…).
     */
    suspend fun inviteColleagueToGroup(
        orgId: String, workspaceId: String, conversationId: String, email: String?, history: String, lang: String,
    ): InvitationCreatedDTO = withContext(dispatcher) {
        val body = buildJsonObject {
            email?.let { put("email", JsonPrimitive(it.trim())) }
            if (email == null) put("multiUse", JsonPrimitive(true))
            put("expiresInDays", JsonPrimitive(14))
            put("workspaceId", JsonPrimitive(workspaceId))
            put("conversationIds", kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive(conversationId))))
            put("history", JsonPrimitive(if (history == "now") "now" else "all"))
            put("lang", JsonPrimitive(lang))
        }
        val r = req("POST", "/organizations/$orgId/invitations", body, InvitationCreatedDTO.serializer())
        if (r.url.isNotBlank() || r.token.isBlank()) r else r.copy(url = baseUrl.trimEnd('/') + "/signup?org=" + enc(r.token))
    }

    /** Pendientes con correo de un espacio o una empresa ([scope] = workspaces | organizations). */
    suspend fun pendingInvitations(scope: String, id: String): List<PendingInvitationDTO> = withContext(dispatcher) {
        require(scope == "workspaces" || scope == "organizations")
        req("GET", "/$scope/$id/invitations", null, PendingInvitationsPage.serializer()).invitations.map { it.copy(scope = scope, scopeId = id) }
    }

    /** Reenvía el correo con un enlace nuevo (429 resend_too_soon si se acaba de enviar). */
    suspend fun resendInvitation(inv: PendingInvitationDTO) = withContext(dispatcher) {
        req("POST", "/${inv.scope}/${inv.scopeId}/invitations/${inv.id}/resend", buildJsonObject {}, JsonElement.serializer()); Unit
    }

    /** Anula la invitación: el enlace deja de servir. */
    suspend fun revokeInvitation(inv: PendingInvitationDTO) = withContext(dispatcher) {
        req("DELETE", "/${inv.scope}/${inv.scopeId}/invitations/${inv.id}", null, JsonElement.serializer()); Unit
    }

    /** POST /conversations/:id/archive (solo quien administra el grupo); luego refresca el snapshot. */
    suspend fun archiveConversation(id: String): ArchiveResult = withContext(dispatcher) {
        val r = req("POST", "/conversations/$id/archive", buildJsonObject {}, ArchiveResult.serializer()); loadBootstrapInternal(); r
    }

    /** Asuntos abiertos de todo mi alcance (se muestran bajo cada grupo). */
    suspend fun loadOpenIssues(): List<IssueDTO> = loadIssues(open = true)

    /** GET /organizations/:id/oversight (solo owner/admin de esa empresa). */
    suspend fun oversight(orgId: String): OversightDTO = withContext(dispatcher) {
        req("GET", "/organizations/$orgId/oversight", null, OversightDTO.serializer())
    }

    /**
     * Mensajes de un grupo en solo lectura (supervisión): no pasa por la caché de conversaciones porque
     * el grupo no está en mi snapshot. [before] = seq más antigua ya cargada.
     */
    suspend fun readOnlyMessages(conversationId: String, before: Long? = null): MessagesPage = withContext(dispatcher) {
        request("GET", "/conversations/$conversationId/messages?limit=50" + (before?.let { "&before=$it" } ?: ""), null, MessagesPage.serializer())
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

    fun close(): Unit = synchronized(noticeSessionLock) {
        onNoticeSessionEnded()
        sessionGeneration++; noticeGeneration++; cancelMeetingConnect(); meetingAttempts.clear()
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
/** «No molestar» guardado en el dispositivo (espejo del servidor o, con un servidor viejo, el único). */
internal const val DND_KEY = "dnd:until"
internal const val SLEEP_KEY = "sleep:me"
internal const val DND_LOCAL_KEY = "dnd:local"
/** Último usuario con sesión en este dispositivo: de quién es la copia local que se pinta al abrir. */
internal const val LAST_USER_KEY = "speed:lastUser"

@JvmField val UNCHANGED: String = String(charArrayOf('\u0000'))

internal fun upsertMessage(list: List<MessageDTO>, m: MessageDTO): List<MessageDTO> {
    val i = list.indexOfFirst { it.id == m.id }
    if (i >= 0) return list.toMutableList().also { it[i] = m }
    if (list.isEmpty() || list.last().seq < m.seq) return list + m
    return (list + m).sortedBy { it.seq }
}
