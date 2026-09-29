package com.tiecoms.app.platform

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.amazonaws.services.chime.sdk.meetings.audiovideo.AttendeeInfo
import com.amazonaws.services.chime.sdk.meetings.audiovideo.AudioVideoObserver
import com.amazonaws.services.chime.sdk.meetings.audiovideo.SignalUpdate
import com.amazonaws.services.chime.sdk.meetings.audiovideo.Transcript
import com.amazonaws.services.chime.sdk.meetings.audiovideo.TranscriptEvent
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
import com.amazonaws.services.chime.sdk.meetings.realtime.TranscriptEventObserver
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
import com.tiecoms.app.core.Caption
import com.tiecoms.app.core.ChimeJoin
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
    data class Tile(val tileId: Int, val local: Boolean, val userId: String?, val paused: Boolean)
    enum class Phase { CONNECTING, LIVE }
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
    )
    data class Ring(val call: CallDTO, val callerName: String, val title: String?)

    private val _view = MutableStateFlow<View?>(null)
    val view: StateFlow<View?> = _view.asStateFlow()
    private val _ringing = MutableStateFlow<Ring?>(null)
    val ringing: StateFlow<Ring?> = _ringing.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    private var session: MeetingSession? = null
    /** El mismo contexto EGL para la sesión y las vistas de video. */
    val egl: EglCoreFactory by lazy { DefaultEglCoreFactory() }
    private var beat: Job? = null
    private var flushJob: Job? = null
    private var ringJob: Job? = null
    private var ringtone: android.media.Ringtone? = null
    private val outbox = TranscriptOutbox()
    private val attendees = java.util.concurrent.ConcurrentHashMap<String, String>()
    @Volatile private var leaving = false

    private val client get() = container.client.value
    private fun patch(f: View.() -> View) = _view.update { it?.f() }

    init {
        // Estado que llega por el socket (quién está, si transcribe) sin tocar la conexión; terminada → se cierra.
        scope.launch {
            container.client.flatMapLatest { it.state }.map { it.calls }.distinctUntilChanged().collect { calls ->
                val v = _view.value
                if (v != null && calls.containsKey(v.call.conversationId)) {
                    val c = calls[v.call.conversationId]
                    if (c == null) { if (!leaving) teardown() }
                    else if (c.id == v.call.id && c != v.call) patch { copy(call = c, captions = if (c.transcribing) captions else emptyList()) }
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

    private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(app, p) == PackageManager.PERMISSION_GRANTED

    private fun connect(j: CallJoinDTO, camera: Boolean) {
        leaving = false
        outbox.clear(); attendees.clear()
        val info = ChimeJoin.parse(j.meeting, j.attendee)
        val fake = info == null || info.isFake
        val cam = camera && hasPermission(Manifest.permission.CAMERA)
        _view.value = View(j.call, phase = if (fake) Phase.LIVE else Phase.CONNECTING, camera = cam && !fake, speaker = camera, fake = fake,
            error = if (camera && !cam) R.string.call_perm_camera_denied else null)
        CallService.start(app)
        beat = scope.launch {
            while (true) {
                delay(Calls.HEARTBEAT_MS)
                val id = _view.value?.call?.id ?: break
                try { client.callHeartbeat(id) } catch (e: Exception) { if (Calls.heartbeatEnds(e)) { teardown(); break } }
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
            attendees[info.attendeeId] = info.externalUserId
            val s = DefaultMeetingSession(cfg, ConsoleLogger(LogLevel.WARN), app, egl)
            session = s
            val av = s.audioVideo
            av.addAudioVideoObserver(avObserver)
            av.addRealtimeObserver(rtObserver)
            av.addVideoTileObserver(tileObserver)
            av.addActiveSpeakerObserver(DefaultActiveSpeakerPolicy(), speakerObserver)
            av.addRealtimeTranscriptEventObserver(transcriptObserver)
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
        if (v.camera) { av?.stopLocalVideo(); patch { copy(camera = false, tiles = tiles.filter { !it.local }) }; return }
        if (!hasPermission(Manifest.permission.CAMERA)) { patch { copy(error = R.string.call_perm_camera_denied) }; return }
        if (av == null) { patch { copy(error = if (v.fake) R.string.call_fake else R.string.call_no_camera) }; return }
        runCatching { av.startLocalVideo() }.onSuccess { patch { copy(camera = true, error = null) } }.onFailure { patch { copy(error = R.string.call_no_camera) } }
    }

    fun switchCamera() { runCatching { session?.audioVideo?.switchCamera() } }

    /** Altavoz ↔ auricular (o audífonos / Bluetooth si hay). */
    fun toggleSpeaker() {
        val v = _view.value ?: return
        val av = session?.audioVideo
        if (av != null) runCatching {
            val devices = av.listAudioDevices()
            val target = if (v.speaker) devices.firstOrNull { it.type != MediaDeviceType.AUDIO_BUILTIN_SPEAKER }
                else devices.firstOrNull { it.type == MediaDeviceType.AUDIO_BUILTIN_SPEAKER }
            target?.let { av.chooseAudioDevice(it) }
        }
        patch { copy(speaker = !speaker) }
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
    suspend fun hangUp(forAll: Boolean = false) = lock.withLock { hangUpLocked(forAll) }

    private suspend fun hangUpLocked(forAll: Boolean = false) {
        val id = _view.value?.call?.id ?: return
        runCatching { flush() }
        teardown()
        runCatching { client.leaveCall(id, forAll) }
    }

    private fun teardown() {
        leaving = true
        beat?.cancel(); beat = null
        flushJob?.cancel(); flushJob = null
        val s = session
        session = null
        if (s != null) runCatching {
            val av = s.audioVideo
            av.removeAudioVideoObserver(avObserver); av.removeRealtimeObserver(rtObserver); av.removeVideoTileObserver(tileObserver)
            av.removeActiveSpeakerObserver(speakerObserver); av.removeRealtimeTranscriptEventObserver(transcriptObserver)
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

    private fun startRingtone() {
        if (!container.settings.soundsEnabled) return
        runCatching {
            stopRingtone()
            val uri = RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_RINGTONE) ?: return
            ringtone = RingtoneManager.getRingtone(app, uri)?.apply { if (Build.VERSION.SDK_INT >= 28) isLooping = true; play() }
        }
    }
    private fun stopRingtone() { runCatching { ringtone?.stop() }; ringtone = null }

    // ---------- Observadores del SDK ----------
    private val avObserver = object : AudioVideoObserver {
        override fun onAudioSessionStartedConnecting(reconnecting: Boolean) {}
        override fun onAudioSessionStarted(reconnecting: Boolean) {
            patch { copy(phase = Phase.LIVE) }
            // Videollamada: arranca en altavoz, como en cualquier teléfono.
            if (!reconnecting && _view.value?.speaker == true) runCatching {
                val av = session?.audioVideo ?: return@runCatching
                av.listAudioDevices().firstOrNull { it.type == MediaDeviceType.AUDIO_BUILTIN_SPEAKER }?.let { av.chooseAudioDevice(it) }
            }
        }
        override fun onAudioSessionDropped() {}
        override fun onAudioSessionStopped(sessionStatus: MeetingSessionStatus) {
            if (leaving) return
            if (sessionStatus.statusCode != MeetingSessionStatusCode.OK && sessionStatus.statusCode != MeetingSessionStatusCode.Left) {
                container.toast(app.getString(R.string.call_audio_failed))
            }
            scope.launch { hangUp() }
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
        override fun onAttendeesJoined(attendeeInfo: Array<AttendeeInfo>) { attendeeInfo.forEach { attendees[it.attendeeId] = it.externalUserId } }
        override fun onAttendeesLeft(attendeeInfo: Array<AttendeeInfo>) {}
        override fun onAttendeesDropped(attendeeInfo: Array<AttendeeInfo>) {}
        override fun onAttendeesMuted(attendeeInfo: Array<AttendeeInfo>) {}
        override fun onAttendeesUnmuted(attendeeInfo: Array<AttendeeInfo>) {}
    }

    private val speakerObserver = object : ActiveSpeakerObserver {
        override val scoreCallbackIntervalMs: Int? get() = null
        override fun onActiveSpeakerDetected(attendeeInfo: Array<AttendeeInfo>) {
            patch { copy(speaking = attendeeInfo.map { it.externalUserId }) }
        }
        override fun onActiveSpeakerScoreChanged(scores: Map<AttendeeInfo, Double>) {}
    }

    private val tileObserver = object : VideoTileObserver {
        private fun tile(s: VideoTileState) = Tile(s.tileId, s.isLocalTile, if (s.isLocalTile) client.myId else attendees[s.attendeeId],
            s.pauseState != VideoPauseState.Unpaused)
        override fun onVideoTileAdded(tileState: VideoTileState) {
            if (tileState.isContent) return
            val t = tile(tileState)
            patch { copy(tiles = tiles.filter { it.tileId != t.tileId } + t) }
        }
        override fun onVideoTileRemoved(tileState: VideoTileState) {
            unbind(tileState.tileId)
            patch { copy(tiles = tiles.filter { it.tileId != tileState.tileId }) }
        }
        override fun onVideoTilePaused(tileState: VideoTileState) { patch { copy(tiles = tiles.map { if (it.tileId == tileState.tileId) it.copy(paused = true) else it }) } }
        override fun onVideoTileResumed(tileState: VideoTileState) { patch { copy(tiles = tiles.map { if (it.tileId == tileState.tileId) it.copy(paused = false) else it }) } }
        override fun onVideoTileSizeChanged(tileState: VideoTileState) {}
    }

    private val transcriptObserver = object : TranscriptEventObserver {
        override fun onTranscriptEventReceived(transcriptEvent: TranscriptEvent) {
            val t = transcriptEvent as? Transcript ?: return
            for (r in t.results) {
                val alt = r.alternatives.firstOrNull() ?: continue
                val who = alt.items.firstOrNull()?.attendee
                onPiece(TranscriptPiece(r.resultId, r.isPartial, alt.transcript, who?.attendeeId, who?.externalUserId, r.languageCode, r.startTimeMs, r.endTimeMs))
            }
        }
    }
}
