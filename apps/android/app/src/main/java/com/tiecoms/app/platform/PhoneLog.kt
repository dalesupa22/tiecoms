package com.tiecoms.app.platform

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telecom.VideoProfile
import android.util.Log
import androidx.core.content.ContextCompat
import com.tiecoms.app.R
import com.tiecoms.app.container
import com.tiecoms.app.core.Calls171
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Llamadas de Chaggu en el historial del teléfono (CH028, como WhatsApp): cada llamada se registra en Telecom como
 * llamada «self-managed» con EXTRA_LOG_SELF_MANAGED_CALLS, y así sale en Recientes de la app Teléfono (entrante,
 * saliente, perdida o rechazada, con su duración). Solo Android 11+ (antes Telecom no las anota y no vale la pena).
 *
 * La llamada sigue siendo de Chime y de [CallManager]: aquí solo se refleja su estado. Lo que pide el sistema
 * (contestar o colgar desde el reloj, el carro o un auricular Bluetooth) vuelve a [CallManager].
 * Telecom anota la llamada solo al terminar, con la duración desde que pasó a activa.
 */
object PhoneLog {
    private const val TAG = "PhoneLog"
    private const val ACCOUNT_ID = "chaggu"
    const val EXTRA_CALL_ID = "com.tiecoms.app.CALL_ID"
    const val EXTRA_NAME = "com.tiecoms.app.CALL_NAME"
    const val EXTRA_INCOMING = "com.tiecoms.app.CALL_INCOMING"

    /** Lo que se sabe de cada llamada; la conexión llega después (Telecom la crea en [PhoneLogService]). */
    internal class Entry(val callId: String, val name: String, val video: Boolean, val incoming: Boolean) {
        @Volatile var connection: ChagguConnection? = null
        @Volatile var answered = false
        @Volatile var live = false
        /** Terminó antes de que Telecom creara la conexión: se cierra apenas llegue. */
        @Volatile var endCause: Int? = null
        @Volatile var route: Calls171.Route? = null
    }

    internal val entries = ConcurrentHashMap<String, Entry>()
    /** Entrantes ya anotadas: el mismo timbre puede llegar por push y por el socket y no debe salir dos veces. */
    private val rang = java.util.Collections.synchronizedSet(LinkedHashSet<String>())
    @Volatile private var registered = false

    fun supported(ctx: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELECOM) &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.MANAGE_OWN_CALLS) == PackageManager.PERMISSION_GRANTED

    private fun handle(ctx: Context) = PhoneAccountHandle(ComponentName(ctx, PhoneLogService::class.java), ACCOUNT_ID)
    private fun telecom(ctx: Context) = ctx.getSystemService(TelecomManager::class.java)

    /**
     * La «dirección» que el historial muestra en lugar del número: «Nombre@chaggu». Telecom solo anota direcciones
     * sip: o tel:, y sin «@» las reduce a los dígitos (CallLogManager.getLogNumber), así que va como sip.
     */
    fun address(name: String): Uri = Uri.fromParts(PhoneAccount.SCHEME_SIP, label(name) + "@chaggu", null)

    /** El nombre tal como se ve en el historial (sin «@», que separaría el dominio). */
    fun label(name: String): String = name.replace('@', ' ').trim().ifBlank { "Chaggu" }

    private fun ensureAccount(ctx: Context): Boolean {
        if (registered) return true
        return runCatching {
            val account = PhoneAccount.builder(handle(ctx), ctx.getString(R.string.app_name))
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED or PhoneAccount.CAPABILITY_VIDEO_CALLING or PhoneAccount.CAPABILITY_SUPPORTS_VIDEO_CALLING)
                .setIcon(Icon.createWithResource(ctx, R.mipmap.ic_launcher))
                .setSupportedUriSchemes(listOf(PhoneAccount.SCHEME_SIP))
                .setExtras(Bundle().apply { putBoolean(PhoneAccount.EXTRA_LOG_SELF_MANAGED_CALLS, true) })
                .build()
            telecom(ctx).registerPhoneAccount(account)
            registered = true
        }.onFailure { Log.w(TAG, "No se pudo registrar la cuenta de llamadas", it) }.isSuccess
    }

    // ---------- Lo que avisa CallManager ----------

    /** Me están llamando: queda sonando en Telecom (perdida si nadie contesta). */
    fun incoming(ctx: Context, callId: String, name: String, video: Boolean) {
        if (!supported(ctx) || entries.containsKey(callId) || callId in rang || !ensureAccount(ctx)) return
        synchronized(rang) { rang += callId; while (rang.size > 50) rang.remove(rang.first()) }
        val tm = telecom(ctx)
        val h = handle(ctx)
        val entry = Entry(callId, name, video, incoming = true)
        entries[callId] = entry
        runCatching {
            if (!tm.isIncomingCallPermitted(h)) { entries.remove(callId); return }
            tm.addNewIncomingCall(h, Bundle().apply {
                putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, address(name))
                putInt(TelecomManager.EXTRA_INCOMING_VIDEO_STATE, if (video) VideoProfile.STATE_BIDIRECTIONAL else VideoProfile.STATE_AUDIO_ONLY)
                putString(EXTRA_CALL_ID, callId); putString(EXTRA_NAME, name); putBoolean(EXTRA_INCOMING, true)
            })
        }.onFailure { entries.remove(callId); Log.w(TAG, "addNewIncomingCall", it) }
    }

    fun isRinging(callId: String): Boolean = entries[callId]?.let { it.incoming && !it.answered && it.endCause == null } == true

    /** Contesté aquí la que sonaba: pasa a activa (desde aquí cuenta la duración). */
    fun answered(callId: String) {
        val e = entries[callId]?.takeIf { it.endCause == null } ?: return
        e.answered = true
        e.connection?.goActive()
    }

    /** Llamo yo o entro a una en curso (franja «Unirse», historial): saliente. */
    fun outgoing(ctx: Context, callId: String, name: String, video: Boolean) {
        if (!supported(ctx) || entries.containsKey(callId) || !ensureAccount(ctx)) return
        val tm = telecom(ctx)
        val h = handle(ctx)
        val entry = Entry(callId, name, video, incoming = false)
        entries[callId] = entry
        runCatching {
            if (!tm.isOutgoingCallPermitted(h)) { entries.remove(callId); return }
            tm.placeCall(address(name), Bundle().apply {
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, h)
                putInt(TelecomManager.EXTRA_START_CALL_WITH_VIDEO_STATE, if (video) VideoProfile.STATE_BIDIRECTIONAL else VideoProfile.STATE_AUDIO_ONLY)
                putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, Bundle().apply {
                    putString(EXTRA_CALL_ID, callId); putString(EXTRA_NAME, name); putBoolean(EXTRA_INCOMING, false)
                })
            })
        }.onFailure { entries.remove(callId); Log.w(TAG, "placeCall", it) }
    }

    /** El audio de Chime conectó (o el proveedor falso): la llamada está activa. */
    fun live(callId: String) {
        val e = entries[callId]?.takeIf { it.endCause == null } ?: return
        e.live = true
        if (!e.incoming || e.answered) e.connection?.goActive()
    }

    /** La salida de audio que eligió Chime, para que Telecom no la cambie por su cuenta. */
    fun route(callId: String, r: Calls171.Route) {
        val e = entries[callId] ?: return
        e.route = r
        e.connection?.applyRoute(r)
    }

    /**
     * Sonó y no la contesté aquí: perdida (nadie contestó o colgaron antes), rechazada («Ahora no») o
     * contestada en otro dispositivo mío. Si ya la contesté aquí no hace nada (la cierra [ended]).
     */
    fun notAnswered(callId: String, cause: Int) {
        val e = entries[callId] ?: return
        if (!e.incoming || e.answered) return
        finish(e, cause)
    }

    /** La llamada terminó (colgué yo, la cerró el servidor o se cayó el audio). */
    fun ended(callId: String) {
        val e = entries[callId] ?: return
        finish(e, DisconnectCause.LOCAL)
    }

    private fun finish(e: Entry, cause: Int) {
        if (e.endCause != null) return
        e.endCause = cause
        // Sin conexión todavía: queda guardada con su causa hasta que Telecom la cree (attach la cierra y la quita).
        val c = e.connection ?: return
        entries.remove(e.callId)
        c.end(cause)
    }

    /** Telecom creó la conexión de [callId]: se pone al día con lo que ya pasó. */
    internal fun attach(callId: String?, c: ChagguConnection): Entry? {
        val e = callId?.let { entries[it] }
        if (e == null) { c.end(DisconnectCause.LOCAL); return null }
        e.connection = c
        e.endCause?.let { entries.remove(e.callId); c.end(it); return e }
        if (e.incoming && !e.answered) c.setRinging()
        else if (e.live || e.answered) c.goActive()
        else c.setDialing()
        e.route?.let { c.applyRoute(it) }
        return e
    }

    internal fun failed(callId: String?) { callId?.let { entries.remove(it) } }
}

/** Una llamada de Chaggu vista por Telecom. Lo que pide el sistema se lo pasa a CallManager. */
class ChagguConnection(private val ctx: Context, private val callId: String, private val incoming: Boolean) : Connection() {
    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
    }

    @Volatile private var active = false
    @Volatile private var done = false

    fun goActive() { if (!done && !active) { active = true; setActive() } }

    fun end(cause: Int) {
        if (done) return
        done = true
        setDisconnected(DisconnectCause(cause))
        destroy()
    }

    fun applyRoute(r: Calls171.Route) {
        if (done) return
        val route = when (r) {
            Calls171.Route.EARPIECE -> CallAudioState.ROUTE_EARPIECE
            Calls171.Route.SPEAKER -> CallAudioState.ROUTE_SPEAKER
            Calls171.Route.BLUETOOTH -> CallAudioState.ROUTE_BLUETOOTH
            Calls171.Route.WIRED -> CallAudioState.ROUTE_WIRED_HEADSET
        }
        @Suppress("DEPRECATION")
        val current = callAudioState?.route
        if (current != route) runCatching { setAudioRoute(route) }
    }

    private val calls get() = ctx.container.calls

    // Contestar, rechazar o colgar desde el sistema (reloj, carro, Bluetooth).
    override fun onAnswer() { onAnswer(VideoProfile.STATE_AUDIO_ONLY) }
    override fun onAnswer(videoState: Int) {
        ctx.container.scope.launch { runCatching { calls.join(callId, camera = false) } }
    }
    override fun onReject() { calls.decline(callId) }
    override fun onDisconnect() {
        if (done) return
        if (incoming && !active) calls.decline(callId)
        else ctx.container.scope.launch { runCatching { calls.hangUp() } }
    }
    override fun onAbort() = onDisconnect()
    // Sonando: el aviso y el tono son los de Chaggu (CallService / CallManager), no hay pantalla del sistema.
    override fun onShowIncomingCallUi() {}
}

/** Servicio que Telecom usa para crear las conexiones de [PhoneLog]. */
class PhoneLogService : ConnectionService() {
    private fun create(request: ConnectionRequest?, incoming: Boolean): Connection {
        val extras = if (incoming) request?.extras else request?.extras?.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS) ?: request?.extras
        val callId = extras?.getString(PhoneLog.EXTRA_CALL_ID)
            // Rellamar desde el historial del teléfono: no sabemos a qué chat; se cancela (cancelada no se anota) y se abre Chaggu.
            ?: return Connection.createCanceledConnection().also {
                runCatching { startActivity(packageManager.getLaunchIntentForPackage(packageName)!!.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
        val name = extras?.getString(PhoneLog.EXTRA_NAME).orEmpty()
        val c = ChagguConnection(applicationContext, callId, incoming)
        c.setAddress(PhoneLog.address(name), TelecomManager.PRESENTATION_ALLOWED)
        c.setCallerDisplayName(PhoneLog.label(name), TelecomManager.PRESENTATION_ALLOWED)
        c.videoState = request?.videoState ?: VideoProfile.STATE_AUDIO_ONLY
        c.connectionCapabilities = Connection.CAPABILITY_MUTE
        PhoneLog.attach(callId, c)
        return c
    }

    override fun onCreateIncomingConnection(connectionManagerPhoneAccount: PhoneAccountHandle?, request: ConnectionRequest?): Connection = create(request, incoming = true)
    override fun onCreateOutgoingConnection(connectionManagerPhoneAccount: PhoneAccountHandle?, request: ConnectionRequest?): Connection = create(request, incoming = false)

    // Telecom no la aceptó (p. ej. hay una llamada de emergencia): la llamada de Chaggu sigue igual, solo no se anota.
    override fun onCreateIncomingConnectionFailed(connectionManagerPhoneAccount: PhoneAccountHandle?, request: ConnectionRequest?) {
        PhoneLog.failed(request?.extras?.getString(PhoneLog.EXTRA_CALL_ID))
    }
    override fun onCreateOutgoingConnectionFailed(connectionManagerPhoneAccount: PhoneAccountHandle?, request: ConnectionRequest?) {
        PhoneLog.failed(request?.extras?.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS)?.getString(PhoneLog.EXTRA_CALL_ID) ?: request?.extras?.getString(PhoneLog.EXTRA_CALL_ID))
    }
}
