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

    val foreground: Boolean get() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    private fun newClient(url: String) = TieComsClient(url, deviceName, storage, secrets, okHttp)

    /** Notas de voz: un solo reproductor para toda la app (reproducción continua). */
    val voice by lazy { com.tiecoms.app.platform.VoicePlayer(app, okHttp, settings) }

    /** Imágenes remotas (fotos y miniaturas públicas) con caché en memoria y en disco. */
    val images by lazy { com.tiecoms.app.platform.ImageLoader(app, okHttp) }

    fun init() {
        // Títulos de chats grupales sin nombre, en el idioma del teléfono (código puro de core/Names).
        Names.labels = Names.Labels(app.getString(R.string.chat_group_chat), app.getString(R.string.chat_and_more), app.getString(R.string.side_default_name))
        notifier.ensureChannel()
        sounds.hashCode() // precarga SoundPool: el sonido del splash debe estar listo en t = 0,35 s
        scope.launch { _client.value.start() }
        scope.launch { client.flatMapLatest { it.signals }.collect { onSignal(it) } }
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
                    if (status == com.tiecoms.app.core.SessionStatus.READY && meId != null) retryPushRegistration()
                }
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
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

    /** Nombre visible de una conversación (para notificaciones). */
    fun conversationName(id: String): String {
        val c = client.value
        val conv = c.meta(id) ?: return ""
        return Names.conversationTitle(conv, c.state.value.data, app.getString(R.string.internal_default), app.getString(R.string.conversation))
    }

    private suspend fun loadAvatar(path: String?): android.graphics.Bitmap? {
        val url = client.value.mediaUrl(path?.takeIf { it.isNotBlank() }) ?: return null
        return runCatching { images.load(url, 128)?.let { it.asAndroidBitmap() } }.getOrNull()
    }

    /**
     * Push de FCM (SPEC-v3 §6). Si la app está en primer plano con el socket en línea, el socket ya avisó;
     * si el mensaje ya se mostró (socket o push repetido), no se duplica.
     */
    fun showPush(p: com.tiecoms.app.core.PushMessage) {
        val c = client.value
        if (foreground && c.state.value.status == com.tiecoms.app.core.SessionStatus.READY && c.state.value.connection == com.tiecoms.app.core.ConnectionStatus.ONLINE) return
        // Aviso de reunión (minutes) vs. convocatoria: claves distintas para no taparse entre sí.
        val dedupe = if (p.type == "event" && p.minutes != null) "soon:" + p.eventId else p.messageId
        if (!notifier.firstTime(dedupe)) return
        // FCM owns the process only until its callback returns. Post immediately; a remote
        // avatar must never delay the notification or escape into an untracked coroutine.
        when (p.type) {
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
                notifier.showConversation(p.conversationId, p.title, isGroup, p.authorId?.takeIf { it.isNotBlank() } ?: author, author, p.body,
                    cachedPushAvatar(p.authorAvatarUrl), silent = !settings.soundsEnabled, badge = p.badge, messageId = p.messageId)
            }
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
        secrets.set(null)
        val fresh = newClient(apiUrl)
        _client.value = fresh
        scope.launch { fresh.start() }
    }

    private fun onSignal(sig: ClientSignal) {
        when (sig) {
            is ClientSignal.Sent -> sounds.play(Sound.SEND)
            is ClientSignal.Incoming -> {
                val m = sig.message
                val fg = foreground
                if (fg && openConversationId == m.conversationId) { sounds.play(Sound.RECEIVE); return }
                if (fg) sounds.play(Sound.NOTIFY)
                if (!notifier.firstTime(m.id)) return // ya llegó por push
                val c = client.value
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
                val open = side?.parentId?.let { p -> if (c.meta(p) != null) "chaggu://c/$p?side=${side.id}" else null }
                scope.launch {
                    val icon = loadAvatar(author?.avatarUrl)
                    notifier.showConversation(m.conversationId, chatTitle, isGroup || side != null,
                        m.authorId ?: "?", authorName, m.body.take(300), icon, silent = fg || !settings.soundsEnabled, badge = c.badge(), messageId = m.id, seq = m.seq, openUri = open)
                }
            }
            is ClientSignal.ReminderDue -> {
                val r = sig.reminder
                val c = client.value
                val conv = c.meta(r.conversationId)
                val name = conv?.let { Names.conversationTitle(it, c.state.value.data, app.getString(R.string.internal_default), app.getString(R.string.conversation)) } ?: ""
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
                notifier.showMessage(ev.conversationId, "📅 $title", whenText, silent = foreground || !settings.soundsEnabled, tag = "cal:" + ev.id)
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
                if (!notifier.firstTime("soon:" + ev.id)) return
                if (foreground) sounds.play(Sound.NOTIFY)
                val whenText = runCatching {
                    java.time.Instant.parse(ev.startsAt).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT))
                }.getOrDefault("")
                val conv = client.value.meta(ev.conversationId)
                val where = conv?.takeIf { it.kind != "direct" }?.let { conversationName(it.id) }.orEmpty()
                notifier.showMessage(ev.conversationId, "📅 " + app.getString(R.string.cal_soon, sig.minutes, ev.title), listOf(where, whenText).filter { it.isNotBlank() }.joinToString(" · "),
                    silent = !settings.soundsEnabled, tag = "event:soon:" + ev.id)
            }
            // Sin sesión: fuera sugerencias de Direct Share, burbujas y notificaciones de la cuenta anterior.
            ClientSignal.SignedOut -> { com.tiecoms.app.platform.ConversationShortcuts.clear(app); notifier.cancelAll() }
        }
    }
}
