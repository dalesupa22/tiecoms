package com.tiecoms.app.core

import kotlin.math.ceil

/** Onda de las notas de voz (SPEC-v4 §F): ≤ 64 valores 0–1, en la cabecera x-waveform separados por comas. */
object Waveform {
    const val MAX_BARS = 64
    const val MAX_MS = 15L * 60_000

    /** Reduce las muestras de amplitud a [bars] barras (máximo de cada tramo) normalizadas a 0–1. */
    fun downsample(samples: List<Float>, bars: Int = MAX_BARS): List<Float> {
        if (samples.isEmpty()) return emptyList()
        val n = minOf(bars, samples.size)
        val step = samples.size.toFloat() / n
        val out = List(n) { i ->
            val from = (i * step).toInt(); val to = minOf(samples.size, ceil((i + 1) * step).toInt()).coerceAtLeast(from + 1)
            samples.subList(from, to).max()
        }
        val peak = out.max().takeIf { it > 0f } ?: return out.map { 0f }
        return out.map { (it / peak).coerceIn(0f, 1f) }
    }

    fun encode(w: List<Float>): String = w.take(MAX_BARS).joinToString(",") { String.format(java.util.Locale.US, "%.2f", it.coerceIn(0f, 1f)) }

    /** «0:42», «12:05». */
    fun clock(ms: Long): String { val s = (ms / 1000).coerceAtLeast(0); return "${s / 60}:${(s % 60).toString().padStart(2, '0')}" }

    /** Gesto del micrófono: dx < 0 a la izquierda, dy < 0 hacia arriba, en dp. */
    enum class Gesture { RECORDING, CANCEL, LOCK }
    fun gesture(dxDp: Float, dyDp: Float, cancelDp: Float = 110f, lockDp: Float = 80f): Gesture = when {
        -dxDp >= cancelDp -> Gesture.CANCEL
        -dyDp >= lockDp -> Gesture.LOCK
        else -> Gesture.RECORDING
    }
}
