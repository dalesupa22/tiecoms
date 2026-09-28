package com.tiecoms.app.platform

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import com.tiecoms.app.core.Assistant
import java.util.Locale

/**
 * Voz de entrada de gg con [SpeechRecognizer] (es-CO / en-US). Se usa solo desde el hilo principal.
 * [start] con `hold = true` (mantener presionada la burbuja) aguanta pausas largas hasta [stop].
 */
class AssistantListener(private val ctx: Context) {
    private var rec: SpeechRecognizer? = null
    private var heard = ""
    private var partial = ""
    private var onDone: ((String) -> Unit)? = null
    val listening get() = rec != null

    fun start(lang: String, hold: Boolean, onPartial: (String) -> Unit, onDone: (String) -> Unit): Boolean {
        if (rec != null || !available(ctx)) return false
        heard = ""; partial = ""
        this.onDone = onDone
        val r = runCatching { SpeechRecognizer.createSpeechRecognizer(ctx) }.getOrNull() ?: return false
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partialResults: Bundle?) {
                val t = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                if (t.isNotEmpty()) { partial = t; onPartial(t) }
            }
            override fun onResults(results: Bundle?) {
                heard = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                finish()
            }
            // Sin coincidencia o cortado al soltar: se usa lo último que se alcanzó a oír.
            override fun onError(error: Int) = finish()
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, if (lang == "en") "en-US" else "es-CO")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            if (hold) {
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 8_000L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 8_000L)
            }
        }
        rec = r
        return runCatching { r.startListening(intent); true }.getOrElse { release(); false }
    }

    /** «Listo» o soltar la burbuja: termina y entrega lo dicho. */
    fun stop() { runCatching { rec?.stopListening() } }

    private fun finish() {
        val said = heard.ifBlank { partial }.trim()
        val cb = onDone
        release()
        cb?.invoke(said)
    }

    private fun release() {
        runCatching { rec?.destroy() }
        rec = null; onDone = null
    }

    /** Cerrar el panel: se descarta sin enviar. */
    fun cancel() { onDone = null; runCatching { rec?.cancel() }; release() }

    companion object {
        fun available(ctx: Context): Boolean = runCatching { SpeechRecognizer.isRecognitionAvailable(ctx) }.getOrDefault(false)
    }
}

/** Voz de salida de gg con [TextToSpeech]. Antes de leer, «gg» se cambia por «yiyi». */
class AssistantSpeaker(ctx: Context) {
    private var ready = false
    private var queued: Pair<String, String>? = null
    private val tts: TextToSpeech = TextToSpeech(ctx.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        queued?.let { (t, l) -> queued = null; if (ready) speak(t, l) }
    }

    fun speak(text: String, lang: String) {
        if (text.isBlank()) return
        if (!ready) { queued = text to lang; return }
        val locale = if (lang == "en") Locale.US else Locale.forLanguageTag("es-CO")
        val ok = runCatching { tts.setLanguage(locale) }.getOrDefault(TextToSpeech.LANG_NOT_SUPPORTED)
        if (ok < TextToSpeech.LANG_AVAILABLE && lang != "en") runCatching { tts.setLanguage(Locale.forLanguageTag("es")) }
        runCatching { tts.speak(Assistant.spoken(text), TextToSpeech.QUEUE_FLUSH, null, "gg") }
    }

    fun stop() { queued = null; runCatching { tts.stop() } }
    fun shutdown() { stop(); runCatching { tts.shutdown() } }
}
