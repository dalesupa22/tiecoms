package com.tiecoms.app.core

import kotlin.math.abs
import kotlin.math.ceil

/**
 * 1.7.1: mensajes muy largos y «deslizar a la derecha = responder» (igual en iOS y Android).
 * Kotlin puro para probarlo en la JVM.
 */
object LongText {
    /** Plegado, el mensaje enseña estas líneas y «Ver más». */
    const val COLLAPSED_LINES = 30
    /** Se pliega un mensaje de más de estas líneas… */
    const val MAX_LINES = 40
    /** …o de más de estos caracteres (igual en iOS). */
    const val MAX_CHARS = 3000
    /** Caracteres por línea con que se estima un teléfono angosto (burbuja al 80 %). */
    private const val CHARS_PER_LINE = 38

    /** Líneas aproximadas en pantalla: cada párrafo ocupa al menos una. Barato: no mide texto. */
    fun estimatedLines(body: String): Int =
        body.split('\n').sumOf { p -> maxOf(1, ceil(p.length / CHARS_PER_LINE.toDouble()).toInt()) }

    /** «Ver más» (1.7.1, igual en iOS): más de 40 líneas o más de 3 000 caracteres; plegado a [COLLAPSED_LINES]. */
    fun collapsible(body: String): Boolean = body.length > MAX_CHARS || estimatedLines(body) > MAX_LINES
}

object SwipeReply {
    enum class Decision { UNDECIDED, CLAIM, REJECT }

    /** Umbral para responder al soltar (≈ 60 dp) y tope visual del arrastre. */
    const val THRESHOLD_DP = 60f
    const val MAX_DP = 96f

    /**
     * Solo un movimiento claramente horizontal y hacia la derecha se lleva el gesto: al menos dos umbrales de arrastre
     * a la derecha y tres veces más horizontal que vertical. Lo vertical es de la lista (se rechaza en cuanto pasa el
     * umbral), y hacia la izquierda no hace nada. Así la deriva de un pulgar que sube o baja no frena el chat.
     */
    fun decide(dx: Float, dy: Float, slop: Float): Decision = when {
        abs(dy) > slop -> Decision.REJECT
        dx < -slop -> Decision.REJECT
        dx > slop * 2f && dx > abs(dy) * 3f -> Decision.CLAIM
        else -> Decision.UNDECIDED
    }

    /** La burbuja sigue al dedo hasta el umbral y luego con resistencia, sin pasar de [max]. */
    fun resist(raw: Float, threshold: Float, max: Float): Float = when {
        raw <= 0f -> 0f
        raw <= threshold -> raw
        else -> minOf(max, threshold + (raw - threshold) * 0.35f)
    }
}
