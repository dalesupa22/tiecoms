package com.tiecoms.app.platform

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.amazonaws.services.chime.sdk.meetings.audiovideo.AttendeeInfo
import com.amazonaws.services.chime.sdk.meetings.audiovideo.AudioVideoObserver
import com.amazonaws.services.chime.sdk.meetings.audiovideo.SignalUpdate
import com.amazonaws.services.chime.sdk.meetings.audiovideo.VolumeUpdate
import com.amazonaws.services.chime.sdk.meetings.audiovideo.audio.activespeakerdetector.ActiveSpeakerObserver
import com.amazonaws.services.chime.sdk.meetings.audiovideo.audio.activespeakerpolicy.DefaultActiveSpeakerPolicy
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.RemoteVideoSource
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.VideoPauseState
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.VideoRenderView
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.VideoTileObserver
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.VideoTileState
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.gl.DefaultEglCoreFactory
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.gl.EglCoreFactory
import com.amazonaws.services.chime.sdk.meetings.device.MediaDeviceType
import com.amazonaws.services.chime.sdk.meetings.realtime.RealtimeObserver
import com.amazonaws.services.chime.sdk.meetings.session.Attendee
import com.amazonaws.services.chime.sdk.meetings.session.CreateAttendeeResponse
import com.amazonaws.services.chime.sdk.meetings.session.CreateMeetingResponse
import com.amazonaws.services.chime.sdk.meetings.session.DefaultMeetingSession
import com.amazonaws.services.chime.sdk.meetings.session.MediaPlacement
import com.amazonaws.services.chime.sdk.meetings.session.Meeting
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSession
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSessionConfiguration
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSessionStatus
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSessionStatusCode
import com.amazonaws.services.chime.sdk.meetings.utils.logger.ConsoleLogger
import com.amazonaws.services.chime.sdk.meetings.utils.logger.LogLevel
import com.tiecoms.app.AppContainer
import com.tiecoms.app.R
import com.tiecoms.app.core.CallDTO
import com.tiecoms.app.core.CallJoinDTO
import com.tiecoms.app.core.Calls
import com.tiecoms.app.core.Calls171
import com.tiecoms.app.core.Calls171Invites
import com.tiecoms.app.core.Caption
import com.tiecoms.app.core.ChimeJoin
import com.tiecoms.app.core.GuestCalls
import com.tiecoms.app.core.TranscriptOutbox
import com.tiecoms.app.core.TranscriptPiece
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * La llamada en curso de este teléfono (una a la vez), con Amazon Chime SDK (apps/web/src/call.ts):
 * - El API crea la reunión y el attendee; aquí se conecta el audio y el video.
 * - Latido cada 30 s: si responde 409 `not_in_call`, se cierra.
 * - Transcripción: el SDK entrega frases parciales (subtítulos) y finales; las finales van al API en lotes (~3 s).
 * - Mientras dura, un servicio en primer plano (micrófono/cámara) la mantiene viva con la app en segundo plano.
 * Con CALLS_PROVIDER=fake la reunión no tiene medios: no se conecta el SDK y se prueba todo lo demás.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class CallManager(private val app: Application, private val container: AppContainer) {
    /** [attendeeId]: el de Chime (para ponerle nombre si el recuadro llega antes que el attendee). */
    data class Tile(val tileId: Int, val local: Boolean, val userId: String?, val paused: Boolean, val attendeeId: String? = null)
    enum class Phase { CONNECTING, LIVE }
    /** 1.7.4: entré como invitado con un enlace (sin cuenta): latido y salida por el API público. */
    data class Guest(val id: String, val secret: String, val token: String, val name: String) {
        val externalId: String get() = GuestCalls.externalId(id)
    }
    /** Cómo terminó mi última llamada como invitado (para «Saliste» / «La llamada terminó» en su pantalla). */
    enum class GuestEnd { LEFT, ENDED }
    data class GuestOutcome(val token: String, val end: GuestEnd)
    data class View(
        val call: CallDTO,
        val phase: Phase = Phase.CONNECTING,
        val muted: Boolean = false,
        val camera: Boolean = false,
        val speaker: Boolean = false,
        val tiles: List<Tile> = emptyList(),
        val captions: List<Caption> = emptyList(),
        /** Quién suena ahora (ids de persona). */
        val speaking: List<String> = emptyList(),
        /** Reunión del proveedor falso: sin audio real. */
        val fake: Boolean = false,
        val expanded: Boolean = true,
        val error: Int? = null,
        /** 1.7.1: salida de audio elegida y las disponibles (auricular, altavoz, Bluetooth, cable). */
        val route: Calls171.Route = Calls171.Route.EARPIECE,
        val routes: List<Calls171.Route> = emptyList(),
        /** Personas con el micrófono silenciado (onAttendeesMuted de Chime). */
        val mutedIds: Set<String> = emptySet(),
        /** Invitados: cuándo los vi por primera vez sin entrar (para «Llamando…» → «No contestó» a los 45 s). */
        val invitedAt: Map<String, Long> = emptyMap(),
        /** 1.7.4: pantallas compartidas por otros (recuadros de contenido de Chime), grandes y sin recortar. */
        val screens: List<Tile> = emptyList(),
        /** 1.7.4: estoy como invitado por enlace (null = llamada normal con mi cuenta). */
        val guest: Guest? = null,
    ) {
        /** Mi id dentro de la llamada: `guest:<id>` como invitado o el de mi cuenta. */
        fun meId(accountId: String?): String? = guest?.externalId ?: accountId
    }
    data class Ring(val call: CallDTO, val callerName: String, val title: String?)

    private val _view = MutableStateFlow<View?>(null)
    val view: StateFlow<View?> = _view.asStateFlow()
    private val _ringing = MutableStateFlow<Ring?>(null)
    val ringing: StateFlow<Ring?> = _ringing.asStateFlow()
    private val _guestOutcome = MutableStateFlow<GuestOutcome?>(null)
    val guestOutcome: StateFlow<GuestOutcome?> = _guestOutcome.asStateFlow()
    /** Colgué yo (no la cerró el servidor): el invitado ve «Saliste» en lugar de «La llamada terminó». */
    @Volatile private var userLeft = false
    @Volatile private var myAttendeeId: String? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    private var session: MeetingSession? = null
    /** El mismo contexto EGL para la sesión y las vistas de video. */
    val egl: EglCoreFactory by lazy { DefaultEglCoreFactory() }
    private var beat: Job? = null
    private var flushJob: Job? = null
    private var ringJob: Job? = null
    private var ringtone: android.media.MediaPlayer? = null
    private val outbox = TranscriptOutbox()
    private val attendees = java.util.concurrent.ConcurrentHashMap<String, String>()
    @Volatile private var leaving = false

    private val client get() = container.client.value
    private fun patch(f: View.() -> View) = _view.update { it?.f() }

    /** Grabación por pedazos para Groq: corre mientras la llamada está viva y se transcribe (syncRecorder de la web). */
    private var recorder: CallRecorder? = null

    init {
        scope.launch {
            _view.map { v -> v?.takeIf { it.guest == null && it.phase == Phase.LIVE && it.call.transcribing }?.call?.id }.distinctUntilChanged().collect { callId ->
                recorder?.stop(); recorder = null
                if (callId != null && hasPermission(Manifest.permission.RECORD_AUDIO)) {
                    val startedAt = _view.value?.call?.startedAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: System.currentTimeMillis()
                    recorder = CallRecorder(app, muted = { _view.value?.muted == true }) { bytes, t0, dur -> uploadChunk(callId, bytes, t0 - startedAt, dur) }.also { it.start() }
                }
            }
        }
        // Estado que llega por el socket (quién está, si transcribe) sin tocar la conexión; terminada → se cierra.
        scope.launch {
            container.client.flatMapLatest { it.state }.map { it.calls }.distinctUntilChanged().collect { calls ->
                val v = _view.value
                // El invitado no tiene socket: su estado llega con el latido.
                if (v != null && v.guest == null && calls.containsKey(v.call.conversationId)) {
                    val c = calls[v.call.conversationId]
                    if (c == null) { if (!leaving) teardown() }
                    else if (c.id == v.call.id && c != v.call) patch { copy(call = c, captions = if (c.transcribing) captions else emptyList(), invitedAt = Calls171Invites.track(invitedAt, c, System.currentTimeMillis())) }
                }
                val r = _ringing.value
                if (r != null && calls.containsKey(r.call.conversationId) && calls[r.call.conversationId]?.id != r.call.id) dismissRing()
            }
        }
    }

    // ---------- Entrar ----------
    /** Llama o entra a la llamada en curso de la conversación. */
    suspend fun start(conversationId: String, kind: String) = lock.withLock {
        val v = _view.value
        if (v != null && v.call.conversationId == conversationId) { patch { copy(expanded = true) }; return@withLock }
        if (v != null) hangUpLocked()
        connect(client.startCall(conversationId, kind), camera = kind == "video")
    }

    /** Entrar desde el aviso «te están llamando», la franja «Unirse» o el historial. */
    suspend fun join(callId: String, camera: Boolean) = lock.withLock {
        dismissRing()
        val v = _view.value
        if (v?.call?.id == callId) { patch { copy(expanded = true) }; return@withLock }
        if (v != null) hangUpLocked()
        connect(client.joinCall(callId), camera)
    }

    /** «Pasar aquí»: entra desde este dispositivo y, ya conectado, saca a mis otros dispositivos de la llamada. */
    suspend fun takeOver(call: CallDTO, myKeys: Set<String>) {
        val others = call.myDevices.orEmpty().map { it.deviceKey }.filter { it !in myKeys }
        join(call.id, camera = false)
        if (_view.value?.call?.id != call.id) return
        scope.launch {
            // Espera a que el audio conecte (o el proveedor falso), como mucho 15 s, y luego suelta los otros.
            val until = System.currentTimeMillis() + 15_000
            while (_view.value?.call?.id == call.id && _view.value?.phase != Phase.LIVE && System.currentTimeMillis() < until) delay(200)
            if (_view.value?.call?.id != call.id) return@launch
            for (k in others) runCatching { client.leaveCallDevice(call.id, k) }
        }
    }

    /** «Ahora no»: deja de sonar aquí y en mis otros dispositivos (POST /calls/:id/decline). */
    fun decline(callId: String? = _ringing.value?.call?.id) {
        callId ?: return
        if (_ringing.value?.call?.id == callId) dismissRing() else CallService.cancelIncoming(app, callId)
        scope.launch { runCatching { client.declineCall(callId) } }
    }

    /** `call.answered` / `call.declined` en otro dispositivo mío: aquí deja de sonar y se quita el aviso. */
    fun onElsewhere(callId: String) {
        if (_ringing.value?.call?.id == callId) dismissRing()
        CallService.cancelIncoming(app, callId)
    }

    /** Invitar de nuevo a quien no contestó (vuelve a sonarle). */
    suspend fun reinvite(userId: String) {
        val v = _view.value ?: return
        patch { copy(invitedAt = invitedAt + (userId to System.currentTimeMillis())) }
        client.inviteToCall(v.call.id, listOf(userId))?.let { c -> patch { copy(call = c) } }
    }

    /**
     * Entrar como invitado con el enlace (/llamada/<token>), con o sin sesión (joinAsGuest de la web).
     * Si estoy en otra llamada, la pantalla ya lo preguntó: aquí se cuelga esa antes de entrar.
     */
    suspend fun joinAsGuest(token: String, name: String, camera: Boolean) = lock.withLock {
        dismissRing()
        val v = _view.value
        if (v?.guest?.token == token) { patch { copy(expanded = true) }; return@withLock }
        if (v != null) hangUpLocked()
        _guestOutcome.value = null
        val j = client.guestCallJoin(token, name)
        val g = Guest(j.guestId, j.secret, token, name)
        connect(CallJoinDTO(GuestCalls.toCall(j.call), j.meeting, j.attendee), camera, g)
    }

    /** «Salir» de la pantalla de invitado sin haber entrado: olvida el «Saliste / terminó» de ese enlace. */
    fun clearGuestOutcome() { _guestOutcome.value = null }

    private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(app, p) == PackageManager.PERMISSION_GRANTED

    private fun connect(j: CallJoinDTO, camera: Boolean, guest: Guest? = null) {
        leaving = false; userLeft = false
        outbox.clear(); attendees.clear()
        val info = ChimeJoin.parse(j.meeting, j.attendee)
        myAttendeeId = info?.attendeeId
        val fake = info == null || info.isFake
        val cam = camera && hasPermission(Manifest.permission.CAMERA)
        val route0 = Calls171.defaultRoute(listOf(Calls171.Route.EARPIECE, Calls171.Route.SPEAKER), video = camera)
        _view.value = View(j.call, phase = if (fake) Phase.LIVE else Phase.CONNECTING, camera = cam && !fake, speaker = route0 == Calls171.Route.SPEAKER, fake = fake,
            error = if (camera && !cam) R.string.call_perm_camera_denied else null, route = route0,
            routes = if (fake) listOf(Calls171.Route.EARPIECE, Calls171.Route.SPEAKER) else emptyList(),
            invitedAt = if (guest != null) emptyMap() else Calls171Invites.track(emptyMap(), j.call, System.currentTimeMillis()), guest = guest)
        CallService.start(app)
        beat = scope.launch {
            while (true) {
                // Los invitados laten cada 15 s (así se enteran de quién entra y sale: no tienen socket).
                delay(if (guest != null) GuestCalls.HEARTBEAT_MS else Calls.HEARTBEAT_MS)
                val cur = _view.value ?: break
                if (guest != null) {
                    if (cur.guest?.id != guest.id) break
                    try {
                        val st = client.guestCallHeartbeat(guest.id, guest.secret)
                        if (_view.value?.guest?.id != guest.id) break
                        if (!st.active) { teardown(); break }
                        patch { copy(call = GuestCalls.toCall(st, call), captions = if (st.transcribing) captions else emptyList()) }
                    } catch (e: Exception) { if (GuestCalls.heartbeatEnds(e)) { teardown(); break } }
                    continue
                }
                try { client.callHeartbeat(cur.call.id) } catch (e: Exception) { if (Calls.heartbeatEnds(e)) { teardown(); break } }
            }
        }
        if (fake || info == null) return
        try {
            val placement = if (info.eventIngestionUrl != null)
                MediaPlacement(info.audioFallbackUrl, info.audioHostUrl, info.signalingUrl, info.turnControlUrl, info.eventIngestionUrl)
            else MediaPlacement(info.audioFallbackUrl, info.audioHostUrl, info.signalingUrl, info.turnControlUrl)
            val cfg = MeetingSessionConfiguration(
                CreateMeetingResponse(Meeting(info.externalMeetingId, placement, info.mediaRegion, info.meetingId)),
                CreateAttendeeResponse(Attendee(info.attendeeId, info.externalUserId, info.joinToken)),
            )
            attendees[info.attendeeId] = Calls171.personOf(info.externalUserId) ?: info.externalUserId
            val s = DefaultMeetingSession(cfg, ConsoleLogger(LogLevel.WARN), app, egl)
            session = s
            val av = s.audioVideo
            av.addAudioVideoObserver(avObserver)
            av.addRealtimeObserver(rtObserver)
            av.addVideoTileObserver(tileObserver)
            av.addActiveSpeakerObserver(DefaultActiveSpeakerPolicy(), speakerObserver)
            av.addDeviceChangeObserver(deviceObserver)
            av.start()
            av.startRemoteVideo()
            if (cam) av.startLocalVideo()
        } catch (t: Throwable) {
            // Sin la librería nativa para este procesador (p. ej. emulador x86_64) o datos de Chime inválidos.
            Log.w("CallManager", "Chime no conectó", t)
            container.toast(app.getString(R.string.call_audio_failed))
            scope.launch { hangUp() }
        }
    }

    // ---------- Controles ----------
    fun toggleMute() {
        val v = _view.value ?: return
        val av = session?.audioVideo
        val ok = if (av == null) true else if (v.muted) av.realtimeLocalUnmute() else av.realtimeLocalMute()
        if (ok) patch { copy(muted = !muted) }
    }

    /** Encender o apagar la cámara (el permiso lo pide la pantalla antes de llamar aquí). */
    fun toggleCamera() {
        val v = _view.value ?: return
        val av = session?.audioVideo
        if (v.camera) { av?.stopLocalVideo(); patch { copy(camera = false, tiles = tiles.filter { !it.local }) }; CallService.start(app); return }
        if (!hasPermission(Manifest.permission.CAMERA)) { patch { copy(error = R.string.call_perm_camera_denied) }; return }
        if (av == null) { patch { copy(error = if (v.fake) R.string.call_fake else R.string.call_no_camera) }; return }
        // En plena llamada de voz: el video sale sin reconectar; el servicio pasa a tipo cámara solo mientras está prendida.
        runCatching { av.startLocalVideo() }.onSuccess { patch { copy(camera = true, error = null) }; CallService.start(app) }.onFailure { patch { copy(error = R.string.call_no_camera) } }
    }

    fun switchCamera() { runCatching { session?.audioVideo?.switchCamera() } }

    /** Altavoz ↔ auricular (con Bluetooth o cable la pantalla abre la lista y llama a [setRoute]). */
    fun toggleSpeaker() {
        val v = _view.value ?: return
        setRoute(Calls171.toggle(v.route, v.routes.ifEmpty { listOf(Calls171.Route.EARPIECE, Calls171.Route.SPEAKER) }))
    }

    /** Elegir la salida de audio con Chime (listAudioDevices / chooseAudioDevice). */
    fun setRoute(r: Calls171.Route) {
        val av = session?.audioVideo
        if (av != null) runCatching {
            av.listAudioDevices().firstOrNull { routeOf(it.type) == r }?.let { av.chooseAudioDevice(it) }
        }
        patch { copy(route = r, speaker = r == Calls171.Route.SPEAKER) }
    }

    private fun routeOf(t: MediaDeviceType): Calls171.Route? = when (t) {
        MediaDeviceType.AUDIO_HANDSET -> Calls171.Route.EARPIECE
        MediaDeviceType.AUDIO_BUILTIN_SPEAKER -> Calls171.Route.SPEAKER
        MediaDeviceType.AUDIO_BLUETOOTH -> Calls171.Route.BLUETOOTH
        MediaDeviceType.AUDIO_WIRED_HEADSET, MediaDeviceType.AUDIO_USB_HEADSET -> Calls171.Route.WIRED
        else -> null
    }

    private fun refreshRoutes(pickDefault: Boolean) {
        val av = session?.audioVideo ?: return
        val list = runCatching { av.listAudioDevices().mapNotNull { routeOf(it.type) }.distinct() }.getOrDefault(emptyList())
        val v = _view.value ?: return
        patch { copy(routes = Calls171.choices(list)) }
        // Al conectar o al enchufar/soltar audífonos o Bluetooth: la salida por defecto (Bluetooth/cable; si no, auricular en voz y altavoz en video).
        if (pickDefault || v.route !in list) setRoute(Calls171.defaultRoute(list, video = v.call.isVideo || v.camera))
    }

    fun setExpanded(on: Boolean) = patch { copy(expanded = on) }
    fun clearError() = patch { copy(error = null) }

    fun bind(tileId: Int, view: VideoRenderView) { runCatching { session?.audioVideo?.bindVideoView(view, tileId) } }
    fun unbind(tileId: Int) { runCatching { session?.audioVideo?.unbindVideoView(tileId) } }

    // ---------- Transcripción ----------
    suspend fun setTranscription(on: Boolean, aiSummary: Boolean = false) {
        val v = _view.value ?: return
        if (!on) flush()
        val call = client.setCallTranscription(v.call.id, on, aiSummary)
        if (call != null) patch { copy(call = call, captions = if (on) captions else emptyList()) }
    }

    /** Sube un pedazo; un reintento (mismo segId: el servidor no duplica) si no hay red o el servidor falla. */
    private fun uploadChunk(callId: String, bytes: ByteArray, offsetMs: Long, durationMs: Long) {
        val segId = java.lang.Long.toString(System.currentTimeMillis(), 36) + java.util.UUID.randomUUID().toString().take(6)
        scope.launch {
            for (attempt in 0 until 2) {
                try { client.sendCallAudio(callId, bytes, "audio/mp4", segId, offsetMs, durationMs); return@launch }
                catch (e: Exception) { if (!Calls.retryBatch(e)) return@launch; delay(2_000) }
            }
        }
    }

    /** «⏳ Procesando…» con el nombre y luego las frases de ese pedazo (eventos de la cuenta). */
    fun onCaption(e: com.tiecoms.app.core.CallCaptionEvent) {
        if (_view.value?.call?.id != e.callId) return
        patch { copy(captions = Calls.applyCaptionEvent(captions, e)) }
    }

    /** Sumar personas a la llamada en curso. */
    suspend fun invite(userIds: List<String>) {
        val v = _view.value ?: return
        client.inviteToCall(v.call.id, userIds)?.let { c -> patch { copy(call = c) } }
    }

    /** Una frase del SDK (parcial o final): subtítulos y, si es final, a la cola de envío. */
    fun onPiece(p: TranscriptPiece) {
        patch { copy(captions = Calls.mergeCaption(captions, p)) }
        val seg = Calls.segmentOf(p) ?: return
        if (outbox.add(seg) && flushJob?.isActive != true) flushJob = scope.launch { delay(Calls.FLUSH_MS); flush() }
    }

    private suspend fun flush() {
        val callId = _view.value?.call?.id ?: return
        while (outbox.size > 0) {
            val batch = outbox.take()
            try { client.sendCallTranscript(callId, batch) }
            catch (e: Exception) {
                // Sin red: se reintenta; apagada o fuera de la llamada: se descarta.
                if (Calls.retryBatch(e)) { outbox.putBack(batch); flushJob = scope.launch { delay(5_000); flush() } }
                return
            }
        }
    }

    // ---------- Colgar ----------
    /** [byUser] = false: la cerró Chime o el servidor (el invitado ve «La llamada terminó», no «Saliste»). */
    suspend fun hangUp(forAll: Boolean = false, byUser: Boolean = true) = lock.withLock { hangUpLocked(forAll, byUser) }

    private suspend fun hangUpLocked(forAll: Boolean = false, byUser: Boolean = true) {
        val v = _view.value ?: return
        val id = v.call.id
        v.guest?.let { g ->
            // Invitado: salir por el API público (sin sesión) y «Saliste de la llamada».
            userLeft = byUser
            teardown()
            runCatching { client.guestCallLeave(g.id, g.secret) }
            return
        }
        runCatching { flush() }
        teardown()
        runCatching { client.leaveCall(id, forAll) }
    }

    private fun teardown() {
        leaving = true
        _view.value?.guest?.let { g -> _guestOutcome.value = GuestOutcome(g.token, if (userLeft) GuestEnd.LEFT else GuestEnd.ENDED) }
        userLeft = false
        myAttendeeId = null
        recorder?.stop(); recorder = null
        beat?.cancel(); beat = null
        flushJob?.cancel(); flushJob = null
        val s = session
        session = null
        if (s != null) runCatching {
            val av = s.audioVideo
            av.removeAudioVideoObserver(avObserver); av.removeRealtimeObserver(rtObserver); av.removeVideoTileObserver(tileObserver)
            av.removeActiveSpeakerObserver(speakerObserver); av.removeDeviceChangeObserver(deviceObserver)
            av.stopLocalVideo(); av.stopRemoteVideo(); av.stop()
        }
        _view.value = null
        CallService.stop(app)
    }

    // ---------- Llamada entrante ----------
    fun ring(call: CallDTO, callerName: String, title: String?) {
        if (_view.value?.call?.id == call.id) return
        _ringing.value = Ring(call, callerName, title)
        ringJob?.cancel()
        // Deja de sonar a los 45 s si nadie contesta.
        ringJob = scope.launch { delay(Calls.RING_MS); dismissRing() }
        if (container.foreground) startRingtone()
        else CallService.notifyIncoming(app, call, callerName, title)
    }

    fun dismissRing() {
        val r = _ringing.value
        _ringing.value = null
        ringJob?.cancel(); ringJob = null
        stopRingtone()
        if (r != null) CallService.cancelIncoming(app, r.call.id)
    }

    /** Mi tono de llamada (docs/SONIDOS.md) en bucle: un ciclo de 2,2 s repetido. No depende del interruptor de sonidos de mensaje. */
    private fun startRingtone() {
        stopRingtone()
        val name = client.state.value.data?.me?.ringtone
        ringtone = runCatching {
            android.media.MediaPlayer().apply {
                setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                app.resources.openRawResourceFd(SoundFiles.ring(name)).use { fd -> setDataSource(fd.fileDescriptor, fd.startOffset, fd.length) }
                isLooping = true
                prepare(); start()
            }
        }.getOrNull()
    }
    private fun stopRingtone() { runCatching { ringtone?.stop(); ringtone?.release() }; ringtone = null }

    // ---------- Observadores del SDK ----------
    private val avObserver = object : AudioVideoObserver {
        override fun onAudioSessionStartedConnecting(reconnecting: Boolean) {}
        override fun onAudioSessionStarted(reconnecting: Boolean) {
            patch { copy(phase = Phase.LIVE) }
            // Por defecto: auricular en voz, altavoz en video (Bluetooth o audífonos si están conectados).
            if (!reconnecting) refreshRoutes(pickDefault = true)
        }
        override fun onAudioSessionDropped() {}
        override fun onAudioSessionStopped(sessionStatus: MeetingSessionStatus) {
            if (leaving) return
            if (sessionStatus.statusCode != MeetingSessionStatusCode.OK && sessionStatus.statusCode != MeetingSessionStatusCode.Left) {
                container.toast(app.getString(R.string.call_audio_failed))
            }
            scope.launch { hangUp(byUser = false) }
        }
        override fun onAudioSessionCancelledReconnect() {}
        override fun onConnectionRecovered() {}
        override fun onConnectionBecamePoor() {}
        override fun onVideoSessionStartedConnecting() {}
        override fun onVideoSessionStarted(sessionStatus: MeetingSessionStatus) {}
        override fun onVideoSessionStopped(sessionStatus: MeetingSessionStatus) {}
        override fun onRemoteVideoSourceUnavailable(sources: List<RemoteVideoSource>) {}
        override fun onRemoteVideoSourceAvailable(sources: List<RemoteVideoSource>) {}
        override fun onCameraSendAvailabilityUpdated(available: Boolean) {}
    }

    private val rtObserver = object : RealtimeObserver {
        override fun onVolumeChanged(volumeUpdates: Array<VolumeUpdate>) {}
        override fun onSignalStrengthChanged(signalUpdates: Array<SignalUpdate>) {}
        override fun onAttendeesJoined(attendeeInfo: Array<AttendeeInfo>) {
            attendeeInfo.forEach { attendees[it.attendeeId] = Calls171.personOf(it.externalUserId) ?: it.externalUserId }
            // Un recuadro (video o pantalla) que llegó antes que su attendee queda sin nombre: se completa aquí.
            fun named(t: Tile) = if (t.userId == null && !t.local && t.attendeeId != null) t.copy(userId = userOf(t.attendeeId)) else t
            patch { if (tiles.none { it.userId == null } && screens.none { it.userId == null }) this else copy(tiles = tiles.map(::named), screens = screens.map(::named)) }
        }
        override fun onAttendeesLeft(attendeeInfo: Array<AttendeeInfo>) {}
        override fun onAttendeesDropped(attendeeInfo: Array<AttendeeInfo>) {}
        override fun onAttendeesMuted(attendeeInfo: Array<AttendeeInfo>) {
            val ids = attendeeInfo.mapNotNull { Calls171.personOf(it.externalUserId) }
            patch { copy(mutedIds = mutedIds + ids) }
        }
        override fun onAttendeesUnmuted(attendeeInfo: Array<AttendeeInfo>) {
            val ids = attendeeInfo.mapNotNull { Calls171.personOf(it.externalUserId) }.toSet()
            patch { copy(mutedIds = mutedIds - ids) }
        }
    }

    private val speakerObserver = object : ActiveSpeakerObserver {
        override val scoreCallbackIntervalMs: Int? get() = null
        override fun onActiveSpeakerDetected(attendeeInfo: Array<AttendeeInfo>) {
            patch { copy(speaking = attendeeInfo.mapNotNull { Calls171.personOf(it.externalUserId) }.distinct()) }
        }
        override fun onActiveSpeakerScoreChanged(scores: Map<AttendeeInfo, Double>) {}
    }

    private val deviceObserver = object : com.amazonaws.services.chime.sdk.meetings.device.DeviceChangeObserver {
        override fun onAudioDeviceChanged(freshAudioDeviceList: List<com.amazonaws.services.chime.sdk.meetings.device.MediaDevice>) { refreshRoutes(pickDefault = false) }
    }

    /** Persona de un attendee (el de una pantalla es `<attendeeId>#content`: se busca también sin el sufijo). */
    private fun userOf(attendeeId: String): String? = attendees[attendeeId] ?: attendees[attendeeId.substringBefore('#')]

    private val tileObserver = object : VideoTileObserver {
        private fun tile(s: VideoTileState) = Tile(s.tileId, s.isLocalTile,
            if (s.isLocalTile) _view.value?.meId(client.myId) else userOf(s.attendeeId),
            s.pauseState != VideoPauseState.Unpaused, s.attendeeId)
        private fun setPaused(id: Int, paused: Boolean) = patch {
            copy(tiles = tiles.map { if (it.tileId == id) it.copy(paused = paused) else it }, screens = screens.map { if (it.tileId == id) it.copy(paused = paused) else it })
        }
        override fun onVideoTileAdded(tileState: VideoTileState) {
            if (tileState.isContent || GuestCalls.isContentAttendee(tileState.attendeeId)) {
                // Pantalla compartida por otra persona (la mía no se mostraría: Android no comparte, pero por si acaso).
                if (GuestCalls.isMyContent(tileState.attendeeId, myAttendeeId)) return
                val t = tile(tileState).copy(local = false)
                patch { copy(screens = screens.filter { it.tileId != t.tileId } + t) }
                return
            }
            val t = tile(tileState)
            patch { copy(tiles = tiles.filter { it.tileId != t.tileId } + t) }
        }
        override fun onVideoTileRemoved(tileState: VideoTileState) {
            unbind(tileState.tileId)
            patch { copy(tiles = tiles.filter { it.tileId != tileState.tileId }, screens = screens.filter { it.tileId != tileState.tileId }) }
        }
        override fun onVideoTilePaused(tileState: VideoTileState) { setPaused(tileState.tileId, true) }
        override fun onVideoTileResumed(tileState: VideoTileState) { setPaused(tileState.tileId, false) }
        override fun onVideoTileSizeChanged(tileState: VideoTileState) {}
    }
}
