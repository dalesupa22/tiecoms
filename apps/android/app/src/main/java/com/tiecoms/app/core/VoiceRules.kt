package com.tiecoms.app.core

/**
 * Reglas de las notas de voz (1.6.2), sin Android para probarlas en la JVM:
 *  - un toque rápido al micrófono no descarta: pasa a grabación bloqueada (manos libres);
 *  - solo es «demasiado corta» si el audio real grabado dura menos de [MIN_AUDIO_MS];
 *  - la duración sale del archivo grabado (metadatos), no del reloj que empezó antes de que el micrófono capturara;
 *  - un envío fallido deja la nota lista para reintentar, con el mensaje que corresponde (413, red, otro).
 */
object VoiceRules {
    /** Audio mínimo para enviar (medido en el archivo). */
    const val MIN_AUDIO_MS = 500L
    /** Mantener pulsado menos que esto cuenta como toque: se bloquea la grabación en vez de enviarla. */
    const val TAP_MS = 400L

    enum class Release { SEND, LOCK }

    /** Qué hacer al soltar el micrófono tras [heldMs] ms pulsado. */
    fun onRelease(heldMs: Long): Release = if (heldMs < TAP_MS) Release.LOCK else Release.SEND

    /**
     * Duración que se manda (x-duration-ms): la del archivo si se pudo leer; si no, la del reloj.
     * El reloj solo sirve de respaldo: arranca antes de que el micrófono capture y se adelanta.
     */
    fun duration(fileMs: Long?, clockMs: Long): Long = fileMs?.takeIf { it > 0 } ?: clockMs.coerceAtLeast(0)

    sealed interface Finish {
        data class Ok(val durationMs: Long) : Finish
        /** Menos de [MIN_AUDIO_MS] de audio real (o el grabador no escribió nada). */
        data object TooShort : Finish
    }

    /** ¿Se envía lo grabado? [bytes] = tamaño del archivo; [stopped] = el grabador cerró el archivo bien. */
    fun finish(fileMs: Long?, clockMs: Long, bytes: Long, stopped: Boolean): Finish {
        if (!stopped || bytes <= 0L) return Finish.TooShort
        val d = duration(fileMs, clockMs)
        return if (d < MIN_AUDIO_MS) Finish.TooShort else Finish.Ok(d)
    }

    enum class UploadError { TOO_LARGE, NETWORK, OTHER }

    /** Clase del error de subida para el mensaje: 413 del proxy o del API, sin red / tiempo agotado, u otro. */
    fun uploadError(e: Throwable): UploadError = when {
        e is ApiException && (e.status == 413 || e.code == "too_large" || e.code == "payload_too_large") -> UploadError.TOO_LARGE
        e is NetworkException || e is java.io.IOException -> UploadError.NETWORK
        e is ApiException && (e.status == 408 || e.status in 502..504) -> UploadError.NETWORK
        else -> UploadError.OTHER
    }
}
