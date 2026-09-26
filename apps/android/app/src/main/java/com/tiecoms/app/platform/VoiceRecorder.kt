package com.tiecoms.app.platform

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import com.tiecoms.app.core.VoiceRules
import com.tiecoms.app.core.Waveform
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

/**
 * Grabación de notas de voz (SPEC-v4 §F): AAC en m4a (MPEG_4/AAC), mono, 24 kHz, 32 kbps, como iOS. Muestrea la amplitud
 * cada 80 ms para la onda en vivo, corta a los 15 min y se pausa si otra app (una llamada) toma el audio.
 * 1.6.2: la duración que se manda es la del archivo (MediaMetadataRetriever), y el archivo vive en filesDir/voice
 * para poder reintentar el envío si falla (no en caché, que el sistema puede vaciar).
 */
class VoiceRecorder(private val ctx: Context) {
    data class State(val recording: Boolean = false, val paused: Boolean = false, val elapsedMs: Long = 0, val levels: List<Float> = emptyList())
    data class Result(val file: File, val durationMs: Long, val waveform: List<Float>)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L
    private var pausedAt = 0L
    private var pausedTotal = 0L
    private val samples = mutableListOf<Float>()
    private var ticker: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val audio = ctx.getSystemService(AudioManager::class.java)
    private var focus: AudioFocusRequest? = null
    /** Se llama al llegar al máximo (15 min): la UI envía lo grabado. */
    var onLimit: (() -> Unit)? = null

    fun start(): Boolean {
        if (recorder != null) return true
        val out = File(dir(ctx), "nota-" + UUID.randomUUID().toString().take(8) + ".m4a").apply { parentFile?.mkdirs() }
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
        return try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioChannels(1)
            r.setAudioSamplingRate(24_000)
            r.setAudioEncodingBitRate(32_000)
            r.setMaxDuration(Waveform.MAX_MS.toInt())
            r.setOnInfoListener { _, what, _ -> if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) scope.launch { onLimit?.invoke() } }
            r.setOutputFile(out.absolutePath)
            r.prepare(); r.start()
            recorder = r; file = out; startedAt = SystemClock.elapsedRealtime(); pausedTotal = 0; samples.clear()
            requestFocus()
            _state.value = State(recording = true)
            ticker = scope.launch {
                while (isActive) {
                    val st = _state.value
                    if (!st.paused) {
                        val amp = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)
                        samples += (amp / 32767f).coerceIn(0f, 1f)
                    }
                    _state.value = st.copy(elapsedMs = elapsed(), levels = samples.takeLast(48))
                    delay(80)
                }
            }
            true
        } catch (e: Exception) {
            runCatching { r.release() }; out.delete(); false
        }
    }

    private fun elapsed(): Long {
        val now = if (_state.value.paused) pausedAt else SystemClock.elapsedRealtime()
        return (now - startedAt - pausedTotal).coerceAtLeast(0)
    }

    fun pause() {
        val r = recorder ?: return
        if (_state.value.paused || Build.VERSION.SDK_INT < 24) return
        runCatching { r.pause() }; pausedAt = SystemClock.elapsedRealtime()
        _state.value = _state.value.copy(paused = true)
    }

    fun resume() {
        val r = recorder ?: return
        if (!_state.value.paused) return
        runCatching { r.resume() }; pausedTotal += SystemClock.elapsedRealtime() - pausedAt
        _state.value = _state.value.copy(paused = false)
    }

    /** Termina y devuelve el archivo con su duración real (null si hubo menos de medio segundo de audio o falló). */
    fun stop(): Result? {
        val r = recorder ?: return null
        val clock = elapsed()
        ticker?.cancel(); recorder = null
        val ok = runCatching { r.stop() }.isSuccess
        runCatching { r.release() }
        abandonFocus()
        _state.value = State()
        val f = file ?: return null
        file = null
        return when (val fin = VoiceRules.finish(if (ok) fileDurationMs(f) else null, clock, f.length(), ok)) {
            is VoiceRules.Finish.Ok -> Result(f, fin.durationMs, Waveform.downsample(samples.toList()))
            VoiceRules.Finish.TooShort -> { f.delete(); null }
        }
    }

    /** Descarta lo que se esté grabando. */
    fun cancel() {
        val r = recorder ?: return
        ticker?.cancel(); recorder = null
        runCatching { r.stop() }; runCatching { r.release() }
        abandonFocus()
        _state.value = State()
        file?.delete(); file = null
    }

    val isRecording: Boolean get() = recorder != null

    companion object {
        fun dir(ctx: Context) = File(ctx.filesDir, "voice")

        /** Duración real del m4a grabado; null si no se pudo leer. */
        fun fileDurationMs(f: File): Long? = runCatching {
            val m = MediaMetadataRetriever()
            try { m.setDataSource(f.absolutePath); m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() } finally { runCatching { m.release() } }
        }.getOrNull()

        /** Notas de hace más de 3 días que nadie reintentó: se borran al abrir el grabador. */
        fun sweep(ctx: Context, now: Long = System.currentTimeMillis()) {
            dir(ctx).listFiles()?.filter { now - it.lastModified() > 3L * 86_400_000 }?.forEach { it.delete() }
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> pause()
            AudioManager.AUDIOFOCUS_GAIN -> resume()
        }
    }

    private fun requestFocus() {
        if (Build.VERSION.SDK_INT < 26) return
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener(focusListener).build()
        focus = req
        runCatching { audio.requestAudioFocus(req) }
    }

    private fun abandonFocus() { focus?.let { f -> runCatching { audio.abandonAudioFocusRequest(f) } }; focus = null }
}

/**
 * Notas grabadas que aún no se enviaron, por conversación: el envío falló (413, sin red) o la grabación se cortó al
 * salir del chat, apagar la pantalla o pasar a segundo plano. Se muestran sobre el compositor con Reintentar y Borrar.
 * Viven mientras viva el proceso; el archivo queda en filesDir/voice.
 */
object VoiceDrafts {
    data class Draft(val result: VoiceRecorder.Result, val aiConsent: Boolean? = null, val error: String? = null)
    private val _drafts = MutableStateFlow<Map<String, Draft>>(emptyMap())
    val drafts: StateFlow<Map<String, Draft>> = _drafts
    fun put(conversationId: String, d: Draft) { _drafts.value = _drafts.value + (conversationId to d) }
    fun take(conversationId: String): Draft? = _drafts.value[conversationId]?.also { _drafts.value = _drafts.value - conversationId }
    fun discard(conversationId: String) { take(conversationId)?.result?.file?.delete() }
}
