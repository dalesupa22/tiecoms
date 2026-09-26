package com.tiecoms.app.platform

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * Reproductor único de notas de voz (SPEC-v4 §F): Media3 con Bearer (y Range), velocidad 1× / 1,5× / 2×, y reproducción
 * continua: al terminar una nota sigue con la siguiente de la conversación. Recuerda cuáles ya se escucharon.
 */
@OptIn(UnstableApi::class)
class VoicePlayer(private val ctx: Context, private val okHttp: OkHttpClient, private val settings: AppSettings) {
    data class Item(val id: String, val url: String, val durationMs: Long)
    data class State(val currentId: String? = null, val playing: Boolean = false, val positionMs: Long = 0, val durationMs: Long = 0, val speed: Float = 1f)

    private val _state = MutableStateFlow(State(speed = settings.voiceSpeed))
    val state: StateFlow<State> = _state
    private val _listened = MutableStateFlow(settings.listenedVoice)
    val listened: StateFlow<Set<String>> = _listened
    private var player: ExoPlayer? = null
    private var token: String? = null
    private var queue: List<Item> = emptyList()
    private var ticker: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private fun ensure(bearer: String): ExoPlayer {
        player?.let { p -> if (token == bearer) return p; p.release() }
        token = bearer
        val http = OkHttpDataSource.Factory(okHttp).setDefaultRequestProperties(mapOf("authorization" to "Bearer $bearer"))
        return ExoPlayer.Builder(ctx).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build().also { p ->
            p.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
            p.addListener(object : Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) { _state.value = _state.value.copy(playing = isPlaying) }
                override fun onPlaybackStateChanged(s: Int) { if (s == Player.STATE_ENDED) next() }
            })
            player = p
        }
    }

    /** ExoPlayer solo acepta el hilo principal: quien llame desde otro hilo (una corrutina que volvió en un worker) se pasa a main. */
    private inline fun onMain(crossinline block: () -> Unit) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) block() else scope.launch { block() }
    }

    /** Toca play en [item]; [following] son las notas que vienen después en la conversación (reproducción continua). */
    fun play(item: Item, following: List<Item>, bearer: String, startFraction: Float? = null): Unit = onMain { playOnMain(item, following, bearer, startFraction) }

    private fun playOnMain(item: Item, following: List<Item>, bearer: String, startFraction: Float?) {
        val p = ensure(bearer)
        if (_state.value.currentId == item.id) { if (startFraction != null) seek(startFraction) else if (p.isPlaying) p.pause() else p.play(); return }
        queue = following
        // Empezar en un punto (tocar o arrastrar la onda de una nota que no suena): con la duración conocida de la nota.
        val startMs = startFraction?.let { f -> (item.durationMs * f.coerceIn(0f, 1f)).toLong() } ?: 0L
        p.setMediaItem(MediaItem.fromUri(item.url), startMs); p.prepare()
        p.playbackParameters = PlaybackParameters(_state.value.speed)
        p.play()
        _state.value = _state.value.copy(currentId = item.id, positionMs = startMs, durationMs = item.durationMs)
        markListened(item.id)
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive) {
                val pl = player ?: break
                _state.value = _state.value.copy(positionMs = pl.currentPosition.coerceAtLeast(0),
                    durationMs = pl.duration.takeIf { it > 0 } ?: _state.value.durationMs)
                delay(100)
            }
        }
    }

    private fun next() {
        val n = queue.firstOrNull()
        if (n == null) { _state.value = _state.value.copy(playing = false, positionMs = 0, currentId = null); return }
        token?.let { play(n, queue.drop(1), it) }
    }

    /** Salta a [fraction] de la nota; si el reproductor aún no sabe la duración (nota larga cargando), usa la del mensaje. */
    fun seek(fraction: Float): Unit = onMain { seekOnMain(fraction) }

    private fun seekOnMain(fraction: Float) {
        val p = player ?: return
        val d = p.duration.takeIf { it > 0 } ?: _state.value.durationMs.takeIf { it > 0 } ?: return
        val to = (d * fraction.coerceIn(0f, 1f)).toLong()
        p.seekTo(to)
        _state.value = _state.value.copy(positionMs = to)
    }

    /** 1× → 1,5× → 2× → 1×. */
    fun cycleSpeed() {
        val s = when (_state.value.speed) { 1f -> 1.5f; 1.5f -> 2f; else -> 1f }
        settings.voiceSpeed = s
        player?.playbackParameters = PlaybackParameters(s)
        _state.value = _state.value.copy(speed = s)
    }

    private fun markListened(id: String) {
        if (id in _listened.value) return
        _listened.value = (_listened.value + id).toList().takeLast(500).toSet()
        settings.listenedVoice = _listened.value
    }

    fun stop(): Unit = onMain { stopOnMain() }
    private fun stopOnMain() { player?.stop(); queue = emptyList(); _state.value = _state.value.copy(currentId = null, playing = false, positionMs = 0) }
}
