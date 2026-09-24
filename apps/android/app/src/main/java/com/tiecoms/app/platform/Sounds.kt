package com.tiecoms.app.platform

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import com.tiecoms.app.R

enum class Sound { SEND, RECEIVE, NOTIFY, SPLASH }

/**
 * Sonidos cortos de la app con SoundPool. Usa el flujo de notificaciones
 * (USAGE_NOTIFICATION_EVENT), así que respeta el volumen de notificaciones y el
 * modo silencio / vibración del teléfono, además del interruptor de Ajustes.
 */
class SoundPlayer(context: Context, private val settings: AppSettings) {
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val pool = SoundPool.Builder()
        .setMaxStreams(3)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        ).build()
    private val loaded = HashSet<Int>()
    private val ids: Map<Sound, Int>

    init {
        pool.setOnLoadCompleteListener { _, id, status -> if (status == 0) synchronized(loaded) { loaded += id } }
        ids = mapOf(
            Sound.SEND to pool.load(context, R.raw.tc_send, 1),
            Sound.RECEIVE to pool.load(context, R.raw.tc_receive, 1),
            Sound.NOTIFY to pool.load(context, R.raw.tc_notify, 1),
            Sound.SPLASH to pool.load(context, R.raw.tc_splash, 1),
        )
    }

    fun play(sound: Sound) {
        if (!settings.soundsEnabled) return
        if (audio.ringerMode != AudioManager.RINGER_MODE_NORMAL) return
        val id = ids[sound] ?: return
        if (synchronized(loaded) { id !in loaded }) return
        val volume = if (sound == Sound.SEND) 0.6f else 0.9f
        pool.play(id, volume, volume, 1, 0, 1f)
    }
}
