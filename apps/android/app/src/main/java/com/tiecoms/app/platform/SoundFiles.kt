package com.tiecoms.app.platform

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import com.tiecoms.app.R
import com.tiecoms.app.core.Sounds

/**
 * Archivos de sonido (res/raw, generados con tools/sounds.py desde las recetas de la web) y sus nombres visibles.
 * Referencias estáticas a R.raw: así el encogido de recursos del release no los quita.
 */
object SoundFiles {
    private val message = mapOf(
        "pop" to (R.raw.pop to R.raw.pop_mention), "gota" to (R.raw.gota to R.raw.gota_mention),
        "campana" to (R.raw.campana to R.raw.campana_mention), "marimba" to (R.raw.marimba to R.raw.marimba_mention),
        "burbuja" to (R.raw.burbuja to R.raw.burbuja_mention), "cristal" to (R.raw.cristal to R.raw.cristal_mention),
        "acorde" to (R.raw.acorde to R.raw.acorde_mention), "silbido" to (R.raw.silbido to R.raw.silbido_mention),
        "tambor" to (R.raw.tambor to R.raw.tambor_mention), "brisa" to (R.raw.brisa to R.raw.brisa_mention),
    )
    private val rings = mapOf("clasico" to R.raw.ring_clasico, "suave" to R.raw.ring_suave, "marimba" to R.raw.ring_marimba)

    /** null = sin sonido ("none"). */
    fun message(sound: String, mention: Boolean = false): Int? {
        if (sound == Sounds.NONE) return null
        val p = message[sound] ?: message.getValue(Sounds.DEFAULT_SOUND)
        return if (mention) p.second else p.first
    }
    fun ring(name: String?): Int = rings[Sounds.ringtone(name)] ?: R.raw.ring_clasico

    fun uri(ctx: Context, res: Int): Uri = Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${ctx.packageName}/$res")

    fun label(ctx: Context, sound: String): String = ctx.getString(when (sound) {
        "gota" -> R.string.sound_n_gota; "campana" -> R.string.sound_n_campana; "marimba" -> R.string.sound_n_marimba
        "burbuja" -> R.string.sound_n_burbuja; "cristal" -> R.string.sound_n_cristal; "acorde" -> R.string.sound_n_acorde
        "silbido" -> R.string.sound_n_silbido; "tambor" -> R.string.sound_n_tambor; "brisa" -> R.string.sound_n_brisa
        Sounds.NONE -> R.string.sound_none; else -> R.string.sound_n_pop
    })
    fun ringLabel(ctx: Context, name: String): String = ctx.getString(when (name) { "suave" -> R.string.ring_n_suave; "marimba" -> R.string.ring_n_marimba; else -> R.string.ring_n_clasico })
}
