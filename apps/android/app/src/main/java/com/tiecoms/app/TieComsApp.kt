package com.tiecoms.app

import android.app.Application
import androidx.compose.ui.graphics.asAndroidBitmap
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import com.tiecoms.app.core.ClientSignal
import com.tiecoms.app.core.SsoCallback
import com.tiecoms.app.core.SsoProvider
import com.tiecoms.app.ui.errorText
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.platform.AppSettings
import com.tiecoms.app.platform.KeystoreSecretStore
import com.tiecoms.app.platform.NoopPushRegistrar
import com.tiecoms.app.platform.Notifier
import com.tiecoms.app.platform.PushSetup
import com.tiecoms.app.platform.PrefsStorage
import com.tiecoms.app.platform.Sound
import com.tiecoms.app.platform.SoundPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class TieComsApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun attachBaseContext(base: Context) { super.attachBaseContext(com.tiecoms.app.platform.AppLocale.wrap(base)) }

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.init()
    }
}

val Context.container: AppContainer get() = (applicationContext as TieComsApp).container

/** Dependencias de la app (una sola instancia por proceso: sobrevive a rotaciones). */
@OptIn(ExperimentalCoroutinesApi::class)
class AppContainer(private val app: Application) {
    val settings = AppSettings(app)
    private val storage = PrefsStorage(app)
    private val secrets = KeystoreSecretStore(app)
    private val meetingStore = KeystoreSecretStore(app, "meeting_attempts", failIfUnreadable = true)
    val notifier = Notifier(app)
    val sounds by lazy { SoundPlayer(app, settings) }
    val push = NoopPushRegistrar()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    val okHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    val deviceName: String = run {
        val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        if (Build.MODEL.startsWith(maker, ignoreCase = true)) Build.MODEL else "$maker ${Build.MODEL}"
    }

    val apiUrl: String get() = if (BuildConfig.DEBUG) settings.debugApiUrl ?: BuildConfig.DEFAULT_API_URL else BuildConfig.DEFAULT_API_URL

    private val _client = MutableStateFlow(newClient(apiUrl))
    val client: StateFlow<TieComsClient> = _client

    /** Enlace pendiente de abrir (llega sin sesión o antes de cargar el snapshot). */
    val pendingLink = MutableStateFlow<DeepLink?>(null)

    /** Splash animado: solo en el arranque en frío (primera actividad del proceso). */
    @Volatile var splashPending = true
    val splashMode = MutableStateFlow<com.tiecoms.app.core.SplashChoreo.Mode?>(null)
    /** Diagnóstico (pruebas): reloj de uptime al primer fotograma del splash y al terminar. */
    @Volatile var splashStartedAt = 0L
    @Volatile var splashEndedAt = 0L
    /** Solo depuración: congela el splash animado en este segundo de la coreografía (capturas). */
    @Volatile var splashFreezeAt: Float? = null
    /** Solo depuración: mantiene el splash del sistema en pantalla (capturas). */
    @Volatile var holdSystemSplash = false

    /** Texto compartido desde otra app, a la espera de elegir conversación. */
    @Volatile var shareDraft: DeepLink.Share? = null

    /** Respuesta en privado en curso: el directo destino y el mensaje original (SPEC-v3 §7). */
    data class PrivateReply(val targetConversationId: String, val source: com.tiecoms.app.core.MessageDTO, val authorName: String?)
    val privateReply = MutableStateFlow<PrivateReply?>(null)

    /** Avisos breves (equivalente a los «toasts» de la web). */
    val toasts = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 8)
    fun toast(text: String) { toasts.tryEmit(text) }

    /** Conversación visible en pantalla (para decidir entre sonido de recepción o de aviso). */
    @Volatile var openConversationId: String? = null
    /**
     * Saltar a un mensaje del chat que ya está abierto (enlace, notificación): lo hace ese mismo chat, sin abrirlo de nuevo,
     * así el filtro de temas «Todo» se conserva (docs/TEMAS.md).
     */
    val chatJump = kotlinx.coroutines.flow.MutableStateFlow<Pair<String, Long>?>(null)

    val foreground: Boolean get() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    private fun newClient(url: String): TieComsClient {
        lateinit var created: TieComsClient
        created = TieComsClient(url, deviceName, storage, secrets, okHttp, meetingStore = meetingStore,
            onNoticeSessionEnded = { if (_client.value === created) notifier.cancelAll() },
            snapshots = com.tiecoms.app.platform.FileSnapshotCache(app, url))
        return created
    }

    /** Llamadas de voz y video (docs/LLAMADAS.md): una a la vez, con Amazon Chime SDK. */
    val calls by lazy { com.tiecoms.app.platform.CallManager(app, this) }

    /** Notas de voz: un solo reproductor para toda la app (reproducción continua). */
    val voice by lazy { com.tiecoms.app.platform.VoicePlayer(app, okHttp, settings) }

    /** Imágenes remotas (fotos y miniaturas públicas) con caché en memoria y en disco. */
    val images by lazy { com.tiecoms.app.platform.ImageLoader(app, okHttp) }

    /** Última versión publicada (GET /app-version). null = aún no se sabe o falló la red: no se avisa nada. */
    val appVersion = MutableStateFlow<com.tiecoms.app.core.AppVersionDTO?>(null)
    private var appVersionJob: kotlinx.coroutines.Job? = null

    /**
     * Pregunta si hay una versión nueva: al abrir la app y cada vez que vuelve al frente, una sola petición a la vez
     * (fuera del hilo principal). Si falla, se conserva lo que se sabía y se reintenta en la siguiente vuelta al frente.
     */
    fun checkAppVersion() {
        if (appVersionJob?.isActive == true) return
        appVersionJob = scope.launch {
            val v = withContextIO {
                runCatching {
                    val r = client.value.http.exec("GET", com.tiecoms.app.core.AppUpdate.path(java.util.Locale.getDefault().language))
                    if (r.ok) com.tiecoms.app.core.TcJson.decodeFromString(com.tiecoms.app.core.AppVersionDTO.serializer(), r.body) else null
                }.getOrNull()
            }
            if (v != null) appVersion.value = v
        }
    }
    private suspend fun <T> withContextIO(block: suspend () -> T): T = kotlinx.coroutines.withContext(Dispatchers.IO) { block() }

    fun init() {
        // Títulos de chats grupales sin nombre, en el idioma del teléfono (código puro de core/Names).
        Names.labels = Names.Labels(app.getString(R.string.chat_group_chat), app.getString(R.string.chat_and_more), app.getString(R.string.side_default_name),
            app.getString(R.string.common_you_short))
        notifier.ensureChannel()
        sounds.hashCode() // precarga SoundPool: el sonido del splash debe estar listo en t = 0,35 s
        scope.launch { _client.value.start() }
        scope.launch { client.flatMapLatest { c -> c.signals.map { c to it } }.collect { (origin, sig) -> onSignal(origin, sig) } }
        // Direct Share (SPEC-v4 §B): las conversaciones recientes como atajos de la hoja de compartir.
        scope.launch {
            client.flatMapLatest { it.state }
                .map { st -> st.data?.let { d -> com.tiecoms.app.platform.ConversationShortcuts.recent(d).map { c -> Triple(c.id, conversationName(c.id), c.avatarUrl) } } }
                .distinctUntilChanged()
                .collectLatest { recent ->
                    val d = client.value.state.value.data ?: return@collectLatest
                    if (recent.isNullOrEmpty()) return@collectLatest
                    kotlinx.coroutines.delay(1_500)
                    kotlinx.coroutines.withContext(Dispatchers.IO) {
                        com.tiecoms.app.platform.ConversationShortcuts.publish(app, d, { conversationName(it.id) }) { c -> loadAvatar(conversationPhoto(c, d)) }
                    }
                }
        }
        // A token can arrive before login or while restoring a saved session.
        scope.launch {
            client.flatMapLatest { it.state }
                .map { it.status to it.data?.me?.id }
                .distinctUntilChanged()
                .collect { (status, meId) ->
                    if (status != com.tiecoms.app.core.SessionStatus.READY || meId == null) {
                        client.value.cancelMeetingConnect(); meetingConnecting = null
                    }
                    if (status == com.tiecoms.app.core.SessionStatus.READY && meId != null) retryPushRegistration()
                }
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                // Al abrir y al volver al frente, también sin sesión (login): ¿hay una versión nueva?
                checkAppVersion()
                client.value.wake()
                retryPushRegistration()
            }
        })
        val cm = app.getSystemService(ConnectivityManager::class.java)
        runCatching {
            cm.registerNetworkCallback(
                NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        client.value.wake(forceReconnect = false)
                        retryPushRegistration()
                    }
                },
            )
        }
    }

    /** Foto de una conversación: la del grupo o, en un directo, la de la otra persona. */
    fun conversationPhoto(c: com.tiecoms.app.core.ConversationDTO, d: com.tiecoms.app.core.BootstrapDTO): String? =
        c.avatarUrl ?: if (c.kind == "direct") c.memberIds.firstOrNull { it != d.me.id }?.let { Names.person(d, it)?.avatarUrl } else null

    /** Nombre visible de una conversación en notificaciones, burbujas y atajos: «Empresa - Grupo» en los grupos. */
    fun conversationName(id: String): String {
        val c = client.value
        val conv = c.meta(id) ?: return ""
        return Names.notificationTitle(conv, c.state.value.data, app.getString(R.string.internal_default), app.getString(R.string.conversation))
    }

    /** «Empresa - Grupo» de la conversación de una reunión; null en directos y chats. */
    private fun meetingPlace(conversationId: String): String? {
        val c = client.value
        return Names.meetingPlace(c.meta(conversationId), c.state.value.data, app.getString(R.string.internal_default), app.getString(R.string.conversation))
    }

    private suspend fun loadAvatar(path: String?): android.graphics.Bitmap? {
        val url = client.value.mediaUrl(path?.takeIf { it.isNotBlank() }) ?: return null
        return runCatching { images.load(url, 128)?.let { it.asAndroidBitmap() } }.getOrNull()
    }

    /** ¿La conversación está en pantalla, en primer plano y CARGADA? (un chat que falló al cargar no calla avisos). */
    fun openAndLoaded(conversationId: String, messageId: String?): Boolean =
        com.tiecoms.app.core.Notices.openAndLoaded(foreground, openConversationId, conversationId, client.value.state.value, messageId)

    private fun noticeContext(c: TieComsClient, conversationId: String, messageId: String?, authorId: String?) =
        c.noticeContext(conversationId, messageId, authorId, foreground, openConversationId).copy(soundsEnabled = settings.soundsEnabled)

    /**
     * Push de FCM (SPEC-v3 §6). Ya no se descarta en bloque en primer plano con el socket en línea: el socket
     * no avisa de todo (conversación desconocida, hueco/catch-up, mensajes de antes de reconectar tras un
     * despliegue). La decisión se comparte por messageId con el aviso local ([Notices]): lo ya anunciado, o
     * decidido «sin aviso», no se repite; lo no anunciado se muestra con las reglas locales (DND, silencio,
     * chat abierto y cargado).
     */
    fun showPush(p: com.tiecoms.app.core.PushMessage) {
        val c = client.value
        // Llamada entrante con la app cerrada (TC_CALL, docs/LLAMADAS.md): Contestar / Ahora no y mi tono. No es un mensaje:
        // no pasa por el registro de avisos; con «No molestar» o modo sueño no suena.
        if (p.type == "call") {
            val callId = p.callId ?: return
            if (!c.dndActive()) calls.ring(com.tiecoms.app.core.CallDTO(id = callId, conversationId = p.conversationId, kind = p.kind ?: "audio"), p.title, p.subtitle.ifBlank { null })
            return
        }
        val generation = c.noticeGeneration
        c.withNoticeSession(generation) {
            if (client.value !== c) return@withNoticeSession
            com.tiecoms.app.core.Notices.forPush(notifier.ledger, p,
                noticeContext(c, p.conversationId, p.messageId, p.authorId), c to generation,
                ownerChanged = notifier::clearPresented,
                opened = { sounds.play(Sound.RECEIVE) },
                present = { presentPush(p) })
        }
    }

    private fun presentPush(p: com.tiecoms.app.core.PushMessage): Boolean {
        // FCM owns the process only until its callback returns. Post immediately; a remote
        // avatar must never delay the notification or escape into an untracked coroutine.
        return when (p.type) {
            "side" -> {
                // TC_SIDE: Responder (RemoteInput) escribe en el sidechat; tocar abre el origen con el sidechat desplegado
                // si puedo leerlo (si no, el sidechat a pantalla completa con la tarjeta del ancla).
                val author = p.authorName?.takeIf { it.isNotBlank() } ?: p.title
                val origin = p.sideOfConversationId
                val open = if (origin != null) "chaggu://c/$origin?side=${p.conversationId}" else null
                notifier.showConversation(p.conversationId, listOf(p.title, p.subtitle).filter { it.isNotBlank() }.joinToString(" · "), true,
                    p.authorId?.takeIf { it.isNotBlank() } ?: author, author, p.body, cachedPushAvatar(p.authorAvatarUrl),
                    silent = !settings.soundsEnabled, badge = p.badge, messageId = p.messageId, openUri = open)
            }
            "message", "mention" -> {
                val isGroup = p.subtitle.isNotBlank()
                val author = p.authorName?.takeIf { it.isNotBlank() } ?: p.title
                // El servidor manda «Empresa - Grupo» en title; el atajo usa la misma etiqueta local si ya hay snapshot.
                notifier.showConversation(p.conversationId, p.title, isGroup, p.authorId?.takeIf { it.isNotBlank() } ?: author, author, p.body,
                    cachedPushAvatar(p.authorAvatarUrl), silent = !settings.soundsEnabled, badge = p.badge, messageId = p.messageId,
                    shortcutLabel = if (isGroup) conversationName(p.conversationId).ifBlank { p.title } else p.title,
                    // Sonido del chat si ya hay snapshot (el push remoto todavía no trae el nombre: docs/SONIDOS.md › pendiente).
                    sound = client.value.meta(p.conversationId)?.let { com.tiecoms.app.core.Sounds.effective(it.sound, client.value.state.value.data?.me?.messageSound) })
            }
            // «Laura reaccionó 👍» (TC_MESSAGE, collapseId react-<id>): tocar abre la conversación en ese mensaje.
            // «Laura te asignó una tarea»: tocar abre el asunto (y antes el chat, si lo puedo leer).
            "issue" -> notifier.showMessage(p.conversationId, p.title, listOf(p.subtitle, p.body).filter { it.isNotBlank() }.joinToString(" · "),
                silent = !settings.soundsEnabled, tag = "issue:" + (p.issueId ?: p.conversationId),
                openUri = "chaggu://issue/${p.issueId ?: ""}" + if (p.inChat) "?c=${p.conversationId}" else "")
            "reaction" -> notifier.showMessage(p.conversationId, p.title, listOf(p.subtitle, p.body).filter { it.isNotBlank() }.joinToString(" · "),
                silent = !settings.soundsEnabled, tag = "react-" + (p.messageId ?: p.conversationId),
                openUri = "chaggu://c/${p.conversationId}" + (p.messageId?.let { "?mid=$it" } ?: ""))
            else -> notifier.showMessage(p.conversationId, p.title, listOf(p.subtitle, p.body).filter { it.isNotBlank() }.joinToString(" · "),
                silent = !settings.soundsEnabled, tag = p.type + ":" + (if (p.minutes != null) "soon:" else "") + (p.reminderId ?: p.eventId ?: p.messageId))
        }
    }

    private fun cachedPushAvatar(path: String?): android.graphics.Bitmap? {
        val url = client.value.mediaUrl(path?.takeIf { it.isNotBlank() }) ?: return null
        return images.cached(url, 128)?.asAndroidBitmap()
    }

    fun retryPushRegistration() {
        scope.launch(Dispatchers.IO) { PushSetup.register(app) }
    }

    // ---------- SSO ----------
    sealed interface SsoUi {
        data object Idle : SsoUi
        data object Exchanging : SsoUi
        data class Failed(val message: String) : SsoUi
    }

    val sso = MutableStateFlow<SsoUi>(SsoUi.Idle)

    /** Abre el proveedor en Custom Tabs (nunca WebView). El verifier PKCE queda en disco. */
    fun startSso(activity: Context, provider: SsoProvider, orgInviteToken: String? = null, orgName: String? = null) {
        val url = client.value.beginSso(provider, orgInviteToken, orgName)
        sso.value = SsoUi.Idle
        val tabs = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(0xFFFDFAF7.toInt()).build())
            .build()
        try {
            tabs.launchUrl(activity, Uri.parse(url))
        } catch (e: ActivityNotFoundException) {
            client.value.clearSso()
            sso.value = SsoUi.Failed(app.getString(R.string.sso_no_browser))
        }
    }

    // ---------- Reuniones: conectar Meet, Teams o Zoom (docs/TANDA-LECTURA-REUNIONES.md §4) ----------
    /** Proveedor cuya conexión está abierta en el navegador (para el aviso al volver). */
    @Volatile var meetingConnecting: String? = null

    /**
     * «Conectar» / «Reconectar»: pide la URL del proveedor y la abre en Custom Tabs (el navegador del sistema, nunca
     * WebView). Vuelve por chaggu://meetings/connected?provider=…&connected=1 o &error=… ([handleMeetingReturn]).
     */
    fun startMeetingConnect(activity: Context, provider: String) {
        val c = client.value
        val generation = c.sessionGeneration
        scope.launch {
            try {
                val url = c.startMeetingConnect(provider)
                if (client.value !== c || c.sessionGeneration != generation) return@launch
                meetingConnecting = provider
                val tabs = CustomTabsIntent.Builder().setShowTitle(true)
                    .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(0xFFFDFAF7.toInt()).build()).build()
                try { tabs.launchUrl(activity, Uri.parse(url)) } catch (e: ActivityNotFoundException) { cancelMeetingConnect(); toast(app.getString(R.string.sso_no_browser)) }
            } catch (e: Exception) {
                // 503 provider_unavailable: el motivo del servidor, sin inventar un botón que no funciona.
                if (e !is kotlinx.coroutines.CancellationException && client.value === c && c.sessionGeneration == generation) toast(errorText(app, e))
            }
        }
    }

    fun cancelMeetingConnect() { client.value.cancelMeetingConnect(); meetingConnecting = null }

    fun handleMeetingReturn(r: com.tiecoms.app.core.Meetings.Return) {
        val c = client.value
        val generation = c.sessionGeneration
        val provider = r.provider ?: meetingConnecting
        meetingConnecting = null
        val label = provider?.let { p -> client.value.state.value.meetingConnections?.firstOrNull { it.provider == p }?.label ?: com.tiecoms.app.core.Meetings.label(p) } ?: ""
        when (r) {
            is com.tiecoms.app.core.Meetings.Return.Pending -> scope.launch {
                try {
                    c.confirmMeetingConnect(r.provider, r.receipt)
                    c.loadMeetingConnections()
                    if (client.value === c && c.sessionGeneration == generation) toast(app.getString(R.string.meet_connected_toast, label))
                } catch (e: Exception) {
                    if (e !is kotlinx.coroutines.CancellationException && client.value === c && c.sessionGeneration == generation)
                        toast(app.getString(R.string.meet_connect_failed, "meeting_confirmation_invalid"))
                }
            }
            is com.tiecoms.app.core.Meetings.Return.Failed -> {
                c.cancelMeetingConnect()
                toast(if (r.cancelled) app.getString(R.string.meet_connect_cancelled) else app.getString(R.string.meet_connect_failed, r.error))
            }
        }
    }

    // ---------- Correo: conectar Gmail u Outlook (docs/CORREO.md) ----------
    /** Proveedor de correo cuya conexión está abierta en el navegador. */
    @Volatile var mailConnecting: String? = null

    /** «Conectar» Gmail u Outlook en Custom Tabs; vuelve por chaggu://mail/connected ([handleMailReturn]). */
    fun startMailConnect(activity: Context, provider: String) {
        val c = client.value
        val generation = c.sessionGeneration
        scope.launch {
            try {
                val url = c.startMailConnect(provider)
                if (client.value !== c || c.sessionGeneration != generation) return@launch
                mailConnecting = provider
                val tabs = CustomTabsIntent.Builder().setShowTitle(true)
                    .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(0xFFFDFAF7.toInt()).build()).build()
                try { tabs.launchUrl(activity, Uri.parse(url)) } catch (e: ActivityNotFoundException) { c.cancelMailConnect(); mailConnecting = null; toast(app.getString(R.string.sso_no_browser)) }
            } catch (e: Exception) {
                if (e !is kotlinx.coroutines.CancellationException && client.value === c && c.sessionGeneration == generation) toast(errorText(app, e))
            }
        }
    }

    fun handleMailReturn(r: com.tiecoms.app.core.Meetings.Return) {
        val c = client.value
        val generation = c.sessionGeneration
        val provider = r.provider ?: mailConnecting
        mailConnecting = null
        val label = provider?.let { com.tiecoms.app.core.Mail.label(it) } ?: ""
        when (r) {
            is com.tiecoms.app.core.Meetings.Return.Pending -> scope.launch {
                try {
                    c.confirmMailConnect(r.provider, r.receipt)
                    c.loadMailConnections()
                    if (client.value === c && c.sessionGeneration == generation) toast(app.getString(R.string.web_mail_connectedToast, label))
                } catch (e: Exception) {
                    if (e !is kotlinx.coroutines.CancellationException && client.value === c && c.sessionGeneration == generation) toast(errorText(app, e))
                }
            }
            is com.tiecoms.app.core.Meetings.Return.Failed -> {
                c.cancelMailConnect()
                toast(if (r.cancelled) app.getString(R.string.web_mail_cancelledToast) else app.getString(R.string.web_mail_failedToast, r.error))
            }
        }
    }

    fun handleSsoCallback(cb: SsoCallback) {
        val c = client.value
        when (cb) {
            is SsoCallback.Code -> {
                if (sso.value == SsoUi.Exchanging) return
                sso.value = SsoUi.Exchanging
                scope.launch {
                    sso.value = try { c.completeSso(cb.code); SsoUi.Idle } catch (e: Exception) { SsoUi.Failed(errorText(app, e)) }
                }
            }
            is SsoCallback.Error -> {
                c.clearSso()
                // Si la persona canceló no se muestra nada.
                sso.value = if (cb.cancelled) SsoUi.Idle else SsoUi.Failed(com.tiecoms.app.ui.ssoErrorText(app, cb.code, cb.message))
            }
        }
    }

    /** Solo debug: cambia de servidor. La sesión guardada pertenece al anterior, se descarta. */
    fun setDebugApiUrl(url: String?) {
        if (!BuildConfig.DEBUG) return
        val normalized = url?.trim()?.trimEnd('/')?.ifEmpty { null }
        if ((normalized ?: BuildConfig.DEFAULT_API_URL) == client.value.baseUrl) return
        settings.debugApiUrl = normalized
        val old = _client.value
        old.close()
        notifier.cancelAll()
        secrets.set(null)
        val fresh = newClient(apiUrl)
        _client.value = fresh
        scope.launch { fresh.start() }
    }

    private fun onSignal(origin: TieComsClient, sig: ClientSignal) {
        if (client.value !== origin) return
        when (sig) {
            is ClientSignal.Sent -> sounds.play(Sound.SEND)
            is ClientSignal.Incoming -> {
                val m = sig.message
                val c = origin
                c.withNoticeSession(sig.generation) {
                    if (client.value !== c) return@withNoticeSession
                    val ctx = noticeContext(c, m.conversationId, m.id, m.authorId)
                    val data = c.state.value.data
                    val conv = c.meta(m.conversationId)
                    val author = Names.person(data, m.authorId)
                    val authorName = author?.name ?: app.getString(R.string.former_participant)
                    val isGroup = conv != null && conv.kind != "direct"
                    // Sidechat: «💬 Sidechat de <autor>» y, al tocar, el chat de origen con el sidechat desplegado.
                    val side = conv?.takeIf { it.isSide }
                    val mentioned = com.tiecoms.app.core.Mentions.mentionsMe(m, data?.me?.id)
                    val chatTitle = when {
                        mentioned -> app.getString(R.string.mention_mentioned_you, authorName) + (if (isGroup) " · " + conversationName(m.conversationId) else "")
                        side != null -> app.getString(R.string.side_notif_title, authorName)
                        isGroup -> conversationName(m.conversationId)
                        else -> authorName
                    }
                    // Sonido del chat (docs/SONIDOS.md): el del chat, si no mi predeterminado; la mención, más aguda.
                    val chatSound = com.tiecoms.app.core.Sounds.effective(conv?.sound, data?.me?.messageSound)
                    val open = side?.parentId?.let { p -> if (c.meta(p) != null) "chaggu://c/$p?side=${side.id}" else null }
                    val outcome = com.tiecoms.app.core.Notices.forLive(notifier.ledger, m.id, ctx, mentioned,
                        c to sig.generation, ownerChanged = notifier::clearPresented,
                        opened = { sounds.play(Sound.RECEIVE) }, present = {
                            // No avatar request can postpone publication, escape logout, or consume FCM's fallback.
                            notifier.showConversation(m.conversationId, chatTitle, isGroup || side != null,
                                m.authorId ?: "?", authorName, if (m.viewOnce) com.tiecoms.app.core.ViewOnce.preview(m, app.getString(R.string.vo_photo), app.getString(R.string.vo_voice), app.getString(R.string.vo_message)) else m.body.take(300), cachedPushAvatar(author?.avatarUrl),
                                silent = ctx.foreground || !settings.soundsEnabled, badge = c.badge(), messageId = m.id, seq = m.seq, openUri = open,
                                shortcutLabel = if (isGroup && side == null) conversationName(m.conversationId) else chatTitle, sound = chatSound)
                        })
                    when (outcome) {
                        com.tiecoms.app.core.Notices.Outcome.SHOW -> if (ctx.foreground) sounds.playMessage(chatSound, mentioned)
                        else -> Unit
                    }
                }
            }
            // Silenciado o «No molestar»: se registra la decisión para que un FCM tardío tampoco avise.
            is ClientSignal.Silenced -> origin.withNoticeSession(sig.generation) {
                if (client.value === origin) com.tiecoms.app.core.Notices.silenced(notifier.ledger, sig.messageId, origin to sig.generation, notifier::clearPresented)
            }
            is ClientSignal.ReminderDue -> {
                val r = sig.reminder
                val c = client.value
                val conv = c.meta(r.conversationId)
                val name = conv?.let { conversationName(it.id) } ?: ""
                if (foreground) sounds.play(Sound.NOTIFY)
                notifier.showMessage(r.conversationId, "⏰ " + app.getString(R.string.rem_alert), listOf(r.note, name).filter { !it.isNullOrBlank() }.joinToString(" · "),
                    silent = foreground || !settings.soundsEnabled, tag = "rem:" + r.id, seq = r.messageSeq)
            }
            is ClientSignal.CalendarChanged -> {
                val ev = sig.event
                if (foreground) sounds.play(Sound.NOTIFY)
                val title = app.getString(when (sig.kind) { "moved" -> R.string.cal_notif_moved; "cancelled" -> R.string.cal_notif_cancelled; else -> R.string.cal_notif_created }, ev.title)
                val whenText = runCatching {
                    java.time.Instant.parse(ev.startsAt).atZone(java.time.ZoneId.systemDefault())
                        .format(java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM, java.time.format.FormatStyle.SHORT))
                }.getOrDefault("")
                // Reunión de un grupo: «Empresa - Grupo · fecha»; en directos y chats, solo la fecha.
                val where = meetingPlace(ev.conversationId)
                notifier.showMessage(ev.conversationId, "📅 $title", listOfNotNull(where, whenText.ifBlank { null }).joinToString(" · "),
                    silent = foreground || !settings.soundsEnabled, tag = "cal:" + ev.id)
            }
            // Menciones descartadas por el servidor (no participan): aviso sutil con los nombres.
            is ClientSignal.MentionsDropped -> {
                val d = client.value.state.value.data
                val names = sig.userIds.map { id -> if (id == "all") app.getString(R.string.mention_all_label) else Names.person(d, id)?.name ?: "?" }.joinToString(", ")
                toast(app.getString(R.string.mention_dropped, names))
            }
            // Aviso 10 min antes (SPEC-v4 §E): suena con tc_notify aunque la conversación esté silenciada.
            is ClientSignal.EventSoon -> {
                val ev = sig.event
                if (!notifier.firstTime("soon:" + ev.id, origin to origin.noticeGeneration)) return
                if (foreground) sounds.play(Sound.NOTIFY)
                val whenText = runCatching {
                    java.time.Instant.parse(ev.startsAt).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT))
                }.getOrDefault("")
                val where = meetingPlace(ev.conversationId).orEmpty()
                notifier.showMessage(ev.conversationId, "📅 " + app.getString(R.string.cal_soon, sig.minutes, ev.title), listOf(where, whenText).filter { it.isNotBlank() }.joinToString(" · "),
                    silent = !settings.soundsEnabled, tag = "event:soon:" + ev.id)
            }
            // Te están llamando (docs/LLAMADAS.md): aviso con Contestar / Ahora no; deja de sonar a los 45 s.
            is ClientSignal.CallCaption -> calls.onCaption(sig.event)
            // 1.7.1: contesté o rechacé en otro dispositivo: deja de sonar y se quita el aviso de esa llamada.
            is ClientSignal.CallElsewhere -> calls.onElsewhere(sig.info.callId)
            is ClientSignal.CallRinging -> calls.ring(sig.call, sig.callerName.ifBlank { Names.person(client.value.state.value.data, sig.call.startedBy)?.name ?: "" }, sig.conversationTitle)
            // Sin sesión: fuera sugerencias de Direct Share, burbujas y notificaciones de la cuenta anterior.
            is ClientSignal.SignedOut -> {
                notifier.cancelSession(origin to sig.generation)
                origin.clearNoticesIfSignedOut {
                    if (client.value === origin) com.tiecoms.app.platform.ConversationShortcuts.clear(app)
                }
                calls.dismissRing(); scope.launch { runCatching { calls.hangUp() } }
            }
        }
    }
}
