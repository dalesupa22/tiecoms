package com.tiecoms.app.core

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Coreografía del splash de «puntitos» como funciones puras del tiempo (segundos desde el primer
 * fotograma). Arranca exactamente como termina el splash del sistema (el símbolo sin rayitas, en el
 * mismo lienzo de [CANVAS_DP] centrado en la pantalla): los tres puntitos de la burbuja papel titilan
 * como escribiendo, luego los de la mandarina, y luego las tres rayitas aparecen ¡pum!.
 *
 * Capas (todas en el mismo lienzo cuadrado): 1b burbuja papel y 2b burbuja mandarina SIN los huecos
 * de los puntos (la separación sí va recortada) y 3 rayitas. Los seis puntos se dibujan encima como
 * círculos tinta ([DOT_R], [DOT_Y], [WHITE_DOTS_X], [ORANGE_DOTS_X]): llenos se ven igual que los huecos.
 * Todo lo visual se deriva de [frame]; la vista solo dibuja.
 */
object SplashChoreo {
    enum class Phase { STILL, TYPING_WHITE, TYPING_ORANGE, PUM, SLOGAN, EXIT, DONE }
    enum class Mode { FULL, SHORT, REDUCED }

    /**
     * Lado del lienzo de las capas en dp. El icono del splash del sistema (lienzo de 288 dp, visible
     * dentro del círculo de 192 dp) lleva el mismo lienzo a este tamaño, centrado: así las burbujas
     * quedan dentro del círculo y el splash animado empieza sin salto.
     */
    const val CANVAS_DP = 176f

    // Puntitos (fracciones del lienzo, de capas-splash/puntitos.txt).
    const val DOT_R = 0.02949f
    const val DOT_Y = 0.33974f
    val WHITE_DOTS_X = listOf(0.14744f, 0.22436f, 0.30128f)
    val ORANGE_DOTS_X = listOf(0.53205f, 0.60897f, 0.68590f)

    // Tabla de tiempos (s).
    const val STILL_END = 0.15f
    const val WHITE_TYPING_START = 0.15f
    const val ORANGE_TYPING_START = 0.85f
    /** El punto i de una burbuja pulsa en start + [DOT_STAGGER]·i + [WAVE_GAP]·k, k < [WAVES]. */
    const val DOT_STAGGER = 0.13f
    const val WAVE_GAP = 0.40f
    const val WAVES = 2
    const val PULSE_DUR = 0.30f
    const val PULSE_MIN_ALPHA = 0.25f
    /** Cuánto sube el punto (en radios) en la mitad del pulso. */
    const val PULSE_LIFT_R = 0.35f
    const val PUM_START = 1.65f
    const val PUM_END = 1.85f
    const val SPARKS_FADE = 0.08f
    const val SPARKS_FROM_SCALE = 0.3f
    const val SPARKS_PEAK_SCALE = 1.15f
    /** Fracción del ¡pum! en la que las rayitas llegan a su escala máxima. */
    const val SPARKS_PEAK_AT = 0.5f
    const val TAP_PEAK_SCALE = 1.04f
    const val TAP_PEAK_AT = 0.4f
    /** Sonido `tc_splash` y vibración corta: con el ¡pum!. */
    const val FEEDBACK_AT = PUM_START
    const val SLOGAN_START = 1.80f
    const val SLOGAN_END = 2.15f
    const val SLOGAN_RISE_DP = 8f
    const val SLOGAN_MAX_ALPHA = 0.8f
    const val EXIT_START = 2.35f
    const val EXIT_END = 2.65f
    const val EXIT_SCALE = 1.06f
    const val TOTAL = EXIT_END
    /** Si la app no está lista, el splash espera en el último cuadro como mucho esto (tiempo real). */
    const val MAX_WAIT = 6.0f
    /** Arranque por enlace: la coreografía empieza aquí (justo antes del ¡pum!). */
    const val SHORT_FROM = 1.55f

    /** Ancla del golpecito: centro de la burbuja mandarina. Ancla de las rayitas. En fracciones del lienzo. */
    const val TAP_PIVOT_X = 0.609f
    const val TAP_PIVOT_Y = 0.340f
    const val SPARKS_PIVOT_X = 0.83f
    const val SPARKS_PIVOT_Y = 0.17f

    data class Frame(
        val phase: Phase,
        /** Por punto (0..2) de cada burbuja: opacidad del punto tinta y cuánto sube, en radios. */
        val whiteDotAlpha: List<Float>,
        val whiteDotLift: List<Float>,
        val orangeDotAlpha: List<Float>,
        val orangeDotLift: List<Float>,
        /** Golpecito de la burbuja mandarina (con sus puntos), anclado en [TAP_PIVOT_X], [TAP_PIVOT_Y]. */
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

    /** Pulso de un punto que empieza en [start]: 0 → 1 (en la mitad) → 0, ease in-out; 0 fuera del pulso. */
    fun pulse(t: Float, start: Float): Float {
        val p = (t - start) / PULSE_DUR
        if (p <= 0f || p >= 1f) return 0f
        return if (p < 0.5f) easeInOut(p * 2f) else easeInOut((1f - p) * 2f)
    }

    /** Intensidad del «escribiendo» del punto [i] de una burbuja cuya ola empieza en [typingStart]. */
    fun dotPulse(t: Float, typingStart: Float, i: Int): Float =
        (0 until WAVES).maxOf { k -> pulse(t, typingStart + DOT_STAGGER * i + WAVE_GAP * k) }

    /** Subida y bajada entre 1 y [peak] durante [a]..[b], con el máximo en la fracción [peakAt]. */
    fun bump(t: Float, a: Float, b: Float, peak: Float, peakAt: Float): Float {
        val p = progress(t, a, b)
        val up = peak - 1f
        return if (p <= peakAt) 1f + up * easeOut(p / peakAt) else 1f + up * (1f - easeInOut((p - peakAt) / (1f - peakAt)))
    }

    /** Escala de las rayitas en el ¡pum!: [SPARKS_FROM_SCALE] → [SPARKS_PEAK_SCALE] → 1. */
    fun sparksScale(t: Float): Float {
        val p = progress(t, PUM_START, PUM_END)
        return if (p <= SPARKS_PEAK_AT) SPARKS_FROM_SCALE + (SPARKS_PEAK_SCALE - SPARKS_FROM_SCALE) * easeOut(p / SPARKS_PEAK_AT)
        else SPARKS_PEAK_SCALE - (SPARKS_PEAK_SCALE - 1f) * easeInOut((p - SPARKS_PEAK_AT) / (1f - SPARKS_PEAK_AT))
    }

    /** Cuadro de la coreografía en el tiempo [t] (ya en tiempo de coreografía, ver [step]). */
    fun frame(t: Float, mode: Mode = Mode.FULL): Frame {
        val reduced = mode == Mode.REDUCED
        val white = List(3) { dotPulse(t, WHITE_TYPING_START, it) }
        val orange = List(3) { dotPulse(t, ORANGE_TYPING_START, it) }
        val sloganP = easeOut(progress(t, SLOGAN_START, SLOGAN_END))
        val exitP = easeInOut(progress(t, EXIT_START, EXIT_END))
        val phase = when {
            t < STILL_END -> Phase.STILL
            t < ORANGE_TYPING_START -> Phase.TYPING_WHITE
            t < PUM_START -> Phase.TYPING_ORANGE
            t < SLOGAN_START -> Phase.PUM
            t < EXIT_START -> Phase.SLOGAN
            t < EXIT_END -> Phase.EXIT
            else -> Phase.DONE
        }
        // Con animaciones reducidas: los puntos solo cambian de opacidad, las rayitas se funden y no hay escalas.
        return Frame(
            phase = phase,
            whiteDotAlpha = white.map { 1f - (1f - PULSE_MIN_ALPHA) * it },
            whiteDotLift = white.map { if (reduced) 0f else PULSE_LIFT_R * it },
            orangeDotAlpha = orange.map { 1f - (1f - PULSE_MIN_ALPHA) * it },
            orangeDotLift = orange.map { if (reduced) 0f else PULSE_LIFT_R * it },
            orangeScale = if (reduced) 1f else bump(t, PUM_START, PUM_END, TAP_PEAK_SCALE, TAP_PEAK_AT),
            sparksAlpha = if (reduced) easeInOut(progress(t, PUM_START, PUM_END)) else progress(t, PUM_START, PUM_START + SPARKS_FADE),
            sparksScale = if (reduced) 1f else sparksScale(t),
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
