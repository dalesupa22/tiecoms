package com.tiecoms.app

import android.app.Application
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

    /** Texto compartido desde otra app, a la espera de elegir conversación. */
    @Volatile var shareDraft: DeepLink.Share? = null

    /** Avisos breves (equivalente a los «toasts» de la web). */
    val toasts = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 8)
    fun toast(text: String) { toasts.tryEmit(text) }

    /** Conversación visible en pantalla (para decidir entre sonido de recepción o de aviso). */
    @Volatile var openConversationId: String? = null

    val foreground: Boolean get() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    private fun newClient(url: String) = TieComsClient(url, deviceName, storage, secrets, okHttp)

    fun init() {
        notifier.ensureChannel()
        sounds.hashCode() // precarga SoundPool: el sonido del splash debe estar listo en t = 0,3 s
        scope.launch { _client.value.start() }
        scope.launch { client.flatMapLatest { it.signals }.collect { onSignal(it) } }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { client.value.wake() }
        })
        val cm = app.getSystemService(ConnectivityManager::class.java)
        runCatching {
            cm.registerNetworkCallback(
                NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) { client.value.wake(forceReconnect = false) }
                },
            )
        }
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
                val c = client.value
                val data = c.state.value.data
                val conv = c.meta(m.conversationId)
                val author = Names.person(data, m.authorId)?.name ?: app.getString(R.string.former_participant)
                val title = conv?.let {
                    val name = Names.conversationTitle(it, data, app.getString(R.string.internal_default), app.getString(R.string.conversation))
                    if (it.kind == "direct") name else "$author · $name"
                } ?: author
                notifier.showMessage(m.conversationId, title, m.body.take(300), silent = fg || !settings.soundsEnabled)
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
            ClientSignal.SignedOut -> Unit
        }
    }
}
