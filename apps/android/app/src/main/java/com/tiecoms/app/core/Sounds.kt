package com.tiecoms.app.core

import kotlinx.serialization.Serializable

/** Respuesta de PUT /me/sounds. */
@Serializable data class MySounds(val messageSound: String? = null, val ringtone: String? = null)

/**
 * Sonidos (docs/SONIDOS.md; contratos MESSAGE_SOUNDS, RINGTONES y SoundChoice): 10 sonidos de mensaje por chat,
 * el predeterminado de la persona y su tono de llamada. Los archivos son res/raw/<nombre>.ogg (tools/sounds.py).
 */
object Sounds {
    val MESSAGE = listOf("pop", "gota", "campana", "marimba", "burbuja", "cristal", "acorde", "silbido", "tambor", "brisa", "energy", "spark", "portal", "victory")
    const val NONE = "none"
    val RINGTONES = listOf("clasico", "suave", "marimba")
    const val DEFAULT_SOUND = "pop"
    const val DEFAULT_RINGTONE = "clasico"
    const val RING_EVERY_MS = 2_200L

    /** Una elección válida (sonido o "none"); cualquier valor desconocido de un servidor nuevo se trata como no elegido. */
    fun choice(v: String?): String? = v?.takeIf { it == NONE || it in MESSAGE }

    /** El sonido que suena en un chat: el del chat, si no el mío, si no pop. "none" = no suena. */
    fun effective(conversationSound: String?, mySound: String?): String = choice(conversationSound) ?: choice(mySound) ?: DEFAULT_SOUND

    fun ringtone(mine: String?): String = mine?.takeIf { it in RINGTONES } ?: DEFAULT_RINGTONE

    /** Canal de notificación por sonido (Android fija el sonido por canal): msg_<sonido>, o msg_none sin sonido. */
    fun channelId(sound: String): String = "msg_" + (choice(sound) ?: DEFAULT_SOUND)
}
