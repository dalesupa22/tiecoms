package com.tiecoms.app.platform

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import com.tiecoms.app.core.Calls
import java.io.File

/**
 * Transcripción con Groq Whisper (docs/LLAMADAS.md): graba MI micrófono en pedazos de 12–20 s (corte en el primer
 * silencio después de 12 s, 20 s como máximo) y entrega los que tienen ≥ 0,8 s de voz como m4a (AAC mono, ~24 kbps).
 *
 * Es una segunda captura del micrófono mientras Chime también lo usa (AudioRecord concurrente, fuente
 * VOICE_COMMUNICATION con cancelación de eco). Android 10+ permite dos capturas de la MISMA app; si el sistema
 * entrega silencio a esta, el VAD no encuentra voz y no se sube nada (la llamada sigue igual).
 */
class CallRecorder(
    private val ctx: Context,
    /** ¿El micrófono está silenciado en la llamada? (silenciado no cuenta como voz). */
    private val muted: () -> Boolean,
    /** Un pedazo listo: bytes m4a, inicio (ms de reloj) y duración. */
    private val onChunk: (bytes: ByteArray, startedAtMs: Long, durationMs: Long) -> Unit,
) {
    @Volatile private var running = false
    private var thread: Thread? = null

    fun start() {
        if (running) return
        running = true
        thread = Thread({ runCatching { loop() }.onFailure { Log.w("CallRecorder", "grabación detenida", it) }; running = false }, "call-recorder").apply { start() }
    }

    fun stop() { running = false; thread = null }

    @SuppressLint("MissingPermission") // CallManager solo arranca con RECORD_AUDIO concedido
    private fun loop() {
        val rate = 16_000
        val frame = rate / 10 // 100 ms
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, frame * 4))
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return }
        val aec = if (AcousticEchoCanceler.isAvailable()) runCatching { AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true } }.getOrNull() else null
        val ns = if (NoiseSuppressor.isAvailable()) runCatching { NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true } }.getOrNull() else null
        val pcm = ShortArray(frame)
        try {
            rec.startRecording()
            while (running) {
                val file = File(ctx.cacheDir, "call-chunk-${System.nanoTime()}.m4a")
                val enc = AacFile(file, rate)
                val t0 = System.currentTimeMillis()
                var voiced = 0L
                var lastVoice = t0
                var samples = 0L
                while (running) {
                    val n = rec.read(pcm, 0, frame)
                    if (n <= 0) break
                    val now = System.currentTimeMillis()
                    if (!muted() && Calls.rms(pcm, n) > Calls.VOICE_RMS) { voiced += n * 1000L / rate; lastVoice = now }
                    enc.write(pcm, n, samples * 1_000_000L / rate)
                    samples += n
                    if (Calls.shouldCut(now - t0, now - lastVoice)) break
                }
                val durationMs = samples * 1000L / rate
                val ok = enc.finish(samples * 1_000_000L / rate)
                if (ok && Calls.worthSending(voiced) && file.length() > 0) onChunk(file.readBytes(), t0, durationMs)
                file.delete()
            }
        } finally {
            runCatching { rec.stop() }; rec.release(); aec?.release(); ns?.release()
        }
    }

    /** PCM 16 bits mono → AAC LC en un .m4a (MediaCodec + MediaMuxer). */
    private class AacFile(file: File, private val rate: Int) {
        private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
            configure(MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 24_000)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
            }, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            start()
        }
        private val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        private var track = -1
        private var wrote = false
        private val info = MediaCodec.BufferInfo()

        fun write(pcm: ShortArray, n: Int, ptsUs: Long) {
            var off = 0
            while (off < n) {
                val idx = codec.dequeueInputBuffer(10_000)
                if (idx < 0) { drain(false); continue }
                val buf = codec.getInputBuffer(idx)!!
                buf.clear(); buf.order(java.nio.ByteOrder.nativeOrder())
                val count = minOf(n - off, buf.remaining() / 2)
                for (i in 0 until count) buf.putShort(pcm[off + i])
                codec.queueInputBuffer(idx, 0, count * 2, ptsUs + off * 1_000_000L / rate, 0)
                off += count
                drain(false)
            }
        }

        fun finish(ptsUs: Long): Boolean = try {
            val idx = codec.dequeueInputBuffer(10_000)
            if (idx >= 0) codec.queueInputBuffer(idx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            drain(true)
            wrote
        } catch (e: Exception) { false } finally {
            runCatching { codec.stop() }; codec.release()
            runCatching { if (track >= 0) muxer.stop() }; runCatching { muxer.release() }
        }

        private fun drain(eos: Boolean) {
            var tries = 0
            while (true) {
                val out = codec.dequeueOutputBuffer(info, if (eos) 10_000 else 0)
                when {
                    out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> { track = muxer.addTrack(codec.outputFormat); muxer.start() }
                    out >= 0 -> {
                        val buf = codec.getOutputBuffer(out)!!
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0 && track >= 0) { buf.position(info.offset); buf.limit(info.offset + info.size); muxer.writeSampleData(track, buf, info); wrote = true }
                        codec.releaseOutputBuffer(out, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                    }
                    else -> { if (!eos || ++tries > 50) return }
                }
            }
        }
    }
}
