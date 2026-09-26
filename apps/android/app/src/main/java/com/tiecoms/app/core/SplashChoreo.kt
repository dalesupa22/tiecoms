package com.tiecoms.app.core

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Coreografía del splash de «ignición» como funciones puras del tiempo (segundos desde el
 * primer fotograma). Arranca exactamente como termina el splash del sistema: el símbolo sin
 * rayitas, en el mismo lienzo de [CANVAS_DP] centrado en la pantalla. Todo lo visual se deriva
 * de [frame]; la vista solo dibuja.
 *
 * Capas (todas en el mismo lienzo cuadrado): 1 burbuja papel, 2 burbuja mandarina, 3 rayitas.
 */
object SplashChoreo {
    enum class Phase { STILL, IGNITION, SLOGAN, EXIT, DONE }
    enum class Mode { FULL, SHORT, REDUCED }

    /**
     * Lado del lienzo de las capas en dp. El icono del splash del sistema (lienzo de 288 dp, visible
     * dentro del círculo de 192 dp) lleva el mismo lienzo a este tamaño, centrado: así las burbujas
     * quedan dentro del círculo y el splash animado empieza sin salto.
     */
    const val CANVAS_DP = 176f

    // Tabla de tiempos (s).
    const val STILL_END = 0.25f
    const val POP_START = 0.20f
    const val POP_END = 0.55f
    const val POP_PEAK_SCALE = 1.10f
    /** Fracción del pop en la que se alcanza el máximo. */
    const val POP_PEAK_AT = 0.4f
    const val SPARKS_START = 0.35f
    const val SPARKS_END = 0.70f
    const val SPARKS_FROM_SCALE = 0.4f
    /** Sonido `tc_splash` y vibración corta: cuando aparecen las rayitas. */
    const val FEEDBACK_AT = SPARKS_START
    const val SLOGAN_START = 0.55f
    const val SLOGAN_END = 0.95f
    const val SLOGAN_RISE_DP = 8f
    const val SLOGAN_MAX_ALPHA = 0.8f
    const val EXIT_START = 1.30f
    const val EXIT_END = 1.60f
    const val EXIT_SCALE = 1.06f
    const val TOTAL = EXIT_END
    /** Si la app no está lista, el splash espera en el último cuadro como mucho esto (tiempo real). */
    const val MAX_WAIT = 6.0f
    /** Arranque por enlace: la coreografía empieza aquí (rayitas ya encendidas). */
    const val SHORT_FROM = 0.70f

    /**
     * Ancla del pop: centro de la burbuja mandarina (x 300..630, y 0..250 en el lienzo de 780 u con
     * origen en -10,-140), para que al crecer no tape la separación con la burbuja papel. Y ancla de
     * las rayitas. En fracciones del lienzo.
     */
    const val POP_PIVOT_X = 0.609f
    const val POP_PIVOT_Y = 0.340f
    const val SPARKS_PIVOT_X = 0.83f
    const val SPARKS_PIVOT_Y = 0.17f

    data class Frame(
        val phase: Phase,
        /** Escala de la burbuja mandarina (capa 2), anclada en el centro de la burbuja ([POP_PIVOT_X], [POP_PIVOT_Y]). */
        val orangeScale: Float,
        /** Rayitas (capa 3): opacidad y escala ancladas en [SPARKS_PIVOT_X], [SPARKS_PIVOT_Y]. */
        val sparksAlpha: Float,
        val sparksScale: Float,
        /** Eslogan: opacidad (ya multiplicada por [SLOGAN_MAX_ALPHA]) y desplazamiento hacia abajo en dp. */
        val sloganAlpha: Float,
        val sloganOffsetDp: Float,
        /** Salida: opacidad de todo el splash (fondo incluido) y escala del símbolo. */
        val exitAlpha: Float,
        val exitScale: Float,
    )

    fun clamp01(x: Float) = min(1f, max(0f, x))
    fun progress(t: Float, a: Float, b: Float) = clamp01((t - a) / (b - a))
    fun easeOut(x: Float) = 1 - (1 - x).pow(3)
    fun easeInOut(x: Float) = if (x < 0.5f) 4 * x * x * x else 1 - (-2 * x + 2).pow(3) / 2

    /** Pop 1 → [POP_PEAK_SCALE] → 1 durante [POP_START]..[POP_END]. */
    fun popScale(t: Float): Float {
        val p = progress(t, POP_START, POP_END)
        val up = POP_PEAK_SCALE - 1f
        return if (p <= POP_PEAK_AT) 1f + up * easeOut(p / POP_PEAK_AT)
        else 1f + up * (1f - easeInOut((p - POP_PEAK_AT) / (1f - POP_PEAK_AT)))
    }

    /** Cuadro de la coreografía en el tiempo [t] (ya en tiempo de coreografía, ver [step]). */
    fun frame(t: Float, mode: Mode = Mode.FULL): Frame {
        val reduced = mode == Mode.REDUCED
        val sparksP = easeOut(progress(t, SPARKS_START, SPARKS_END))
        val sloganP = easeOut(progress(t, SLOGAN_START, SLOGAN_END))
        val exitP = easeInOut(progress(t, EXIT_START, EXIT_END))
        val phase = when {
            t < STILL_END -> Phase.STILL
            t < SLOGAN_START -> Phase.IGNITION
            t < EXIT_START -> Phase.SLOGAN
            t < EXIT_END -> Phase.EXIT
            else -> Phase.DONE
        }
        // Con animaciones reducidas: sin escalas, solo fundidos (mismos tiempos).
        return Frame(
            phase = phase,
            orangeScale = if (reduced) 1f else popScale(t),
            sparksAlpha = sparksP,
            sparksScale = if (reduced) 1f else SPARKS_FROM_SCALE + (1f - SPARKS_FROM_SCALE) * sparksP,
            sloganAlpha = SLOGAN_MAX_ALPHA * sloganP,
            sloganOffsetDp = if (reduced) 0f else SLOGAN_RISE_DP * (1f - sloganP),
            exitAlpha = 1f - exitP,
            exitScale = if (reduced) 1f else 1f + (EXIT_SCALE - 1f) * exitP,
        )
    }

    /** Tiempo de coreografía del primer cuadro: el arranque por enlace empieza en [SHORT_FROM]. */
    fun startTime(mode: Mode): Float = if (mode == Mode.SHORT) SHORT_FROM else 0f

    /** La app puede salir: ya cargó o se agotó la espera máxima ([real] = segundos reales mostrando el splash). */
    fun canExit(ready: Boolean, real: Float): Boolean = ready || real >= MAX_WAIT

    /**
     * Avanza el reloj de coreografía [dt] segundos. Tocar ([skip]) salta a la salida. Si la app no
     * puede salir todavía, se queda en el último cuadro ([EXIT_START]).
     */
    fun step(t: Float, dt: Float, canExit: Boolean, skip: Boolean = false): Float {
        val base = if (skip) max(t, EXIT_START) else t
        val next = base + dt
        return if (canExit) next else min(next, max(base, EXIT_START))
    }

    /** El reloj cruzó el instante [at] entre dos cuadros (para disparar sonido y vibración una vez). */
    fun crossed(prev: Float, now: Float, at: Float): Boolean = prev < at && now >= at
}
