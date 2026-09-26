package com.tiecoms.app.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * Coreografía del splash «Un solo hilo» como función pura del tiempo (segundos desde
 * que se muestra). La misma tabla de tiempos usa iOS (SPEC-v2 §4). Todo lo visual se
 * deriva de [frame]; la vista solo dibuja.
 */
object SplashChoreo {
    enum class Phase { PEOPLE, THREAD, KNOT, LOGO, SLOGAN, EXIT, DONE }
    enum class Mode { FULL, SHORT, REDUCED }

    data class Person(val initials: String, val color: Long, val fx: Float, val fy: Float, val company: String)

    /** Posiciones en fracciones de ancho/alto respecto al centro de la pantalla. */
    val PEOPLE = listOf(
        Person("SR", 0xFF3B7BF6, -0.30f, -0.22f, "Acme"),
        Person("TB", 0xFF5B8DEF, 0.28f, -0.16f, "Acme"),
        Person("LP", 0xFF1E8E5A, -0.26f, 0.06f, "Nova"),
        Person("KA", 0xFF3DAA7F, 0.24f, 0.12f, "Nova"),
        Person("MG", 0xFF8B5CF6, 0.02f, 0.28f, "Lexa"),
    )

    // Tabla de tiempos (s).
    const val NODE_START = 0.0f
    const val NODE_STAGGER = 0.07f
    const val NODE_DUR = 0.45f - 4 * NODE_STAGGER // el último termina en 0.45
    const val ROPE_START = 0.30f
    const val ROPE_END = 1.00f
    const val SOUND_AT = 0.30f
    const val GATHER_START = 1.00f
    const val GATHER_END = 1.35f
    const val HAPTIC_AT = 1.02f
    const val GATHER_ROTATION_DEG = 20f
    const val LOGO_START = 1.30f
    const val PULSE_END = 1.75f
    const val SPARKS_END = 1.95f
    const val ORANGE_END = 1.80f
    const val INK_START = 1.40f
    const val INK_END = 1.95f
    const val SLOGAN_START = 1.85f
    const val SLOGAN_END = 2.40f
    const val EXIT_START = 2.40f
    const val EXIT_END = 2.75f
    const val TOTAL = EXIT_END
    const val MAX_WAIT = 6.0f
    const val SHORT_DURATION = 1.2f
    const val REDUCED_FADE = 0.4f

    /** Posición del nudo (centro de la burbuja mandarina) dentro del wordmark Chaggu (fracción del ancho y alto). */
    const val KNOT_FX = 0.728f
    const val KNOT_FY = 0.474f
    /** Alto / ancho de las imágenes del wordmark (1400 × 563). */
    const val LOGO_ASPECT = 563f / 1400f
    const val SPARKS = 10

    data class Frame(
        val phase: Phase,
        /** Por persona: escala del resorte (0→1 con rebote) y opacidad. */
        val nodeScale: List<Float>,
        val nodeAlpha: List<Float>,
        /** Anillo naranja cuando la punta del hilo llega: escala 1.25→1 (0 = sin anillo). */
        val ringScale: List<Float>,
        /** Fracción dibujada del hilo 0..1 y su opacidad (se desvanece al amarrarse). */
        val rope: Float,
        val ropeAlpha: Float,
        /** Contracción hacia el nudo 0..1 y giro en grados. */
        val gather: Float,
        val rotationDeg: Float,
        /** Pulso: radio relativo 0..1 y opacidad. */
        val pulseRadius: Float,
        val pulseAlpha: Float,
        /** Chispas: progreso 0..1 (0 = no hay). */
        val sparks: Float,
        val orangeScale: Float,
        val orangeAlpha: Float,
        /** Máscara de la tinta de izquierda a derecha 0..1. */
        val inkReveal: Float,
        /** Eslogan: opacidad y desplazamiento (pt) de las tres líneas. */
        val sloganAlpha: List<Float>,
        val sloganOffset: List<Float>,
        /** Punto que late mientras la app termina de cargar. */
        val waitingDot: Float,
        val exitScale: Float,
        val exitAlpha: Float,
    )

    fun clamp01(x: Float) = min(1f, max(0f, x))
    fun progress(t: Float, a: Float, b: Float) = clamp01((t - a) / (b - a))
    fun easeInOut(x: Float) = if (x < 0.5f) 4 * x * x * x else 1 - (-2 * x + 2).pow(3) / 2
    fun easeIn(x: Float) = x * x * x
    fun easeOut(x: Float) = 1 - (1 - x).pow(3)

    /** Resorte subamortiguado normalizado: 0→1 con un rebote suave. */
    fun spring(x: Float): Float {
        if (x <= 0f) return 0f
        if (x >= 1f) return 1f
        val damp = 6.0; val freq = 2.2 * PI
        return (1 - exp(-damp * x) * cos(freq * x)).toFloat()
    }

    fun nodeReachedAt(i: Int): Float {
        // Tiempo en que la punta del hilo pasa por la persona i (el hilo va de la primera a la última).
        val target = i / (PEOPLE.size - 1f)
        var lo = ROPE_START; var hi = ROPE_END
        repeat(30) { val mid = (lo + hi) / 2; if (easeInOut(progress(mid, ROPE_START, ROPE_END)) < target) lo = mid else hi = mid }
        return hi
    }

    /**
     * [t]: segundos de la coreografía (ya traducidos según el modo, ver [timelineTime]).
     * [ready]: la app terminó de cargar; si no, el splash espera en [EXIT_START] con un punto que late.
     * [waited]: segundos esperando en [EXIT_START] (para el latido).
     */
    fun frame(t: Float, ready: Boolean = true, waited: Float = 0f, mode: Mode = Mode.FULL): Frame {
        val n = PEOPLE.size
        if (mode == Mode.REDUCED) {
            // Solo el logo con fundido, sin partículas ni personas.
            val a = progress(t, 0f, REDUCED_FADE)
            val exit = if (ready) progress(t, REDUCED_FADE + 0.5f, REDUCED_FADE + 0.8f) else 0f
            return Frame(
                phase = when { t < REDUCED_FADE -> Phase.LOGO; exit <= 0f -> Phase.SLOGAN; exit < 1f -> Phase.EXIT; else -> Phase.DONE },
                nodeScale = List(n) { 0f }, nodeAlpha = List(n) { 0f }, ringScale = List(n) { 0f },
                rope = 0f, ropeAlpha = 0f, gather = 1f, rotationDeg = 0f, pulseRadius = 0f, pulseAlpha = 0f, sparks = 0f,
                orangeScale = 1f, orangeAlpha = a, inkReveal = 1f,
                sloganAlpha = List(3) { a }, sloganOffset = List(3) { 0f },
                waitingDot = if (!ready) waitingPulse(waited) else 0f,
                exitScale = 1f, exitAlpha = 1f - exit,
            )
        }
        val gather = easeIn(progress(t, GATHER_START, GATHER_END))
        val nodeScale = List(n) { i -> spring(progress(t, NODE_START + i * NODE_STAGGER, NODE_START + i * NODE_STAGGER + NODE_DUR)) }
        val nodeAlpha = List(n) { i -> clamp01(progress(t, NODE_START + i * NODE_STAGGER, NODE_START + i * NODE_STAGGER + 0.12f)) * (1f - gather) }
        val ringScale = List(n) { i ->
            val at = nodeReachedAt(i)
            if (t < at) 0f else 1.25f - 0.25f * easeOut(progress(t, at, at + 0.25f))
        }
        val rope = easeInOut(progress(t, ROPE_START, ROPE_END))
        val pulseP = progress(t, LOGO_START, PULSE_END)
        val orangeP = progress(t, LOGO_START, ORANGE_END)
        val slogan = listOf(
            progress(t, SLOGAN_START, SLOGAN_START + 0.30f),
            progress(t, SLOGAN_START + 0.15f, SLOGAN_START + 0.45f),
            progress(t, SLOGAN_START + 0.25f, SLOGAN_END),
        ).map { easeOut(it) }
        val holding = !ready && t >= EXIT_START
        val exit = if (ready) easeInOut(progress(t, EXIT_START, EXIT_END)) else 0f
        val phase = when {
            t < ROPE_START -> Phase.PEOPLE
            t < GATHER_START -> Phase.THREAD
            t < LOGO_START -> Phase.KNOT
            t < SLOGAN_START -> Phase.LOGO
            t < EXIT_START || holding -> Phase.SLOGAN
            t < EXIT_END -> Phase.EXIT
            else -> Phase.DONE
        }
        return Frame(
            phase = phase,
            nodeScale = nodeScale, nodeAlpha = nodeAlpha, ringScale = ringScale.mapIndexed { i, r -> if (nodeAlpha[i] <= 0f) 0f else r },
            rope = if (gather >= 1f) 0f else rope, ropeAlpha = 1f - gather,
            gather = gather, rotationDeg = GATHER_ROTATION_DEG * gather,
            pulseRadius = easeOut(pulseP), pulseAlpha = if (pulseP <= 0f || pulseP >= 1f) 0f else 0.55f * (1f - pulseP),
            sparks = progress(t, LOGO_START, SPARKS_END).let { if (it >= 1f) 0f else it },
            orangeScale = 0.8f + 0.2f * spring(orangeP), orangeAlpha = easeOut(progress(t, LOGO_START, LOGO_START + 0.25f)),
            inkReveal = easeInOut(progress(t, INK_START, INK_END)),
            sloganAlpha = slogan, sloganOffset = slogan.map { 8f * (1f - it) },
            waitingDot = if (holding) waitingPulse(waited) else 0f,
            exitScale = 1f + 0.06f * exit, exitAlpha = 1f - exit,
        )
    }

    private fun waitingPulse(waited: Float) = (0.5f + 0.5f * sin(2 * PI * waited / 0.9).toFloat())

    /**
     * Traduce el tiempo real a tiempo de coreografía. En modo corto (deep link en frío)
     * salta a la fase 4 y comprime el resto para que dure ≤ [SHORT_DURATION] s.
     */
    fun timelineTime(real: Float, mode: Mode): Float = when (mode) {
        Mode.FULL, Mode.REDUCED -> real
        Mode.SHORT -> LOGO_START + real * (TOTAL - LOGO_START) / SHORT_DURATION
    }

    /** Duración en tiempo real de la coreografía completa en cada modo (sin esperas). */
    fun duration(mode: Mode): Float = when (mode) {
        Mode.FULL -> TOTAL
        Mode.SHORT -> SHORT_DURATION
        Mode.REDUCED -> REDUCED_FADE + 0.8f
    }

    /** Chispa k: ángulo en abanico hacia arriba (rad), velocidad relativa y retraso. */
    fun spark(k: Int): Triple<Float, Float, Float> {
        val a = (-160f + 140f * k / (SPARKS - 1)) * (PI.toFloat() / 180f)
        val speed = 0.55f + 0.35f * ((k * 37) % 10) / 10f
        return Triple(a, speed, (k % 3) * 0.02f)
    }
}
