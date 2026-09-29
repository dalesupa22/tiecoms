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
    /** Caracteres por línea con que se estima un teléfono angosto (burbuja al 80 %). */
    private const val CHARS_PER_LINE = 38

    /** Líneas aproximadas en pantalla: cada párrafo ocupa al menos una. Barato: no mide texto. */
    fun estimatedLines(body: String): Int =
        body.split('\n').sumOf { p -> maxOf(1, ceil(p.length / CHARS_PER_LINE.toDouble()).toInt()) }

    /** Candidato a «Ver más»: la medición real (hasVisualOverflow) decide si de verdad se corta. */
    fun collapsible(body: String): Boolean = body.length > 600 && estimatedLines(body) > COLLAPSED_LINES
}

object SwipeReply {
    enum class Decision { UNDECIDED, CLAIM, REJECT }

    /** Umbral para responder al soltar (≈ 60 dp) y tope visual del arrastre. */
    const val THRESHOLD_DP = 60f
    const val MAX_DP = 96f

    /**
     * Solo un movimiento claramente horizontal y hacia la derecha se lleva el gesto; lo vertical es de la lista
     * (se rechaza en cuanto supera el umbral de arrastre), y hacia la izquierda no hace nada.
     */
    fun decide(dx: Float, dy: Float, slop: Float): Decision = when {
        abs(dy) > slop && abs(dy) * 2f >= abs(dx) -> Decision.REJECT
        dx < -slop -> Decision.REJECT
        dx > slop && dx > abs(dy) * 2f -> Decision.CLAIM
        else -> Decision.UNDECIDED
    }

    /** La burbuja sigue al dedo hasta el umbral y luego con resistencia, sin pasar de [max]. */
    fun resist(raw: Float, threshold: Float, max: Float): Float = when {
        raw <= 0f -> 0f
        raw <= threshold -> raw
        else -> minOf(max, threshold + (raw - threshold) * 0.35f)
    }
}
