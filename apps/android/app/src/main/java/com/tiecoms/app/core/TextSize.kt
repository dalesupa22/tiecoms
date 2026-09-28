package com.tiecoms.app.core

/**
 * Tamaño del texto de la app (1.6.4 / 22, en «Tú»): 5 pasos que se multiplican por la escala de fuente
 * del sistema (se suman a la accesibilidad de Android, no la reemplazan).
 */
object TextSize {
    val STEPS = listOf(0.9f, 1.0f, 1.15f, 1.3f, 1.45f)
    const val DEFAULT = 1.0f

    /** Paso más cercano a [factor] (0…4). */
    fun index(factor: Float): Int = STEPS.indices.minBy { kotlin.math.abs(STEPS[it] - factor) }

    /** Valor guardado válido: uno de los pasos; lo demás vuelve a Normal. */
    fun sanitize(factor: Float): Float = STEPS.firstOrNull { kotlin.math.abs(it - factor) < 0.001f } ?: DEFAULT

    /** Escala final de fuente = sistema × factor elegido. */
    fun fontScale(system: Float, factor: Float): Float = system * sanitize(factor)
}
