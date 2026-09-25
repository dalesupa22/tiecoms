package com.tiecoms.app.core

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Geometría del editor de recorte circular: la imagen [w]×[h] cubre un visor cuadrado de lado [v] px con
 * escala base (cover) × [zoom] (1..[MAX_ZOOM]) y desplazamiento [dx],[dy] del centro. Todo en px.
 */
object CropMath {
    const val MAX_ZOOM = 5f

    fun baseScale(w: Int, h: Int, v: Float) = v / min(w, h).toFloat()

    /** Desplazamiento máximo para que la imagen siga cubriendo todo el círculo. */
    fun clampOffset(w: Int, h: Int, v: Float, zoom: Float, dx: Float, dy: Float): Pair<Float, Float> {
        val s = baseScale(w, h, v) * zoom
        val mx = max(0f, (w * s - v) / 2f); val my = max(0f, (h * s - v) / 2f)
        return dx.coerceIn(-mx, mx) to dy.coerceIn(-my, my)
    }

    data class Square(val left: Int, val top: Int, val side: Int)

    /** Cuadrado de la imagen original que queda dentro del visor. */
    fun cropSquare(w: Int, h: Int, v: Float, zoom: Float, dx: Float, dy: Float): Square {
        val z = zoom.coerceIn(1f, MAX_ZOOM)
        val (cx, cy) = clampOffset(w, h, v, z, dx, dy)
        val s = baseScale(w, h, v) * z
        val side = (v / s).roundToInt().coerceIn(1, min(w, h))
        val left = (w / 2f - (v / 2f + cx) / s).roundToInt().coerceIn(0, w - side)
        val top = (h / 2f - (v / 2f + cy) / s).roundToInt().coerceIn(0, h - side)
        return Square(left, top, side)
    }
}
