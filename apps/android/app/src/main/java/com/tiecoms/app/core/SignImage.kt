package com.tiecoms.app.core

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Firmas como PNG transparentes, en píxeles ARGB (el formato de Bitmap.getPixels): recortar al trazo, quitar el
 * fondo de una foto con el umbral de Otsu y teñir la tinta. Igual que apps/web/src/sign-image.ts; sin Android para
 * poder probarlo en la JVM.
 */
object SignImage {
    data class Bounds(val x: Int, val y: Int, val w: Int, val h: Int)

    private fun alpha(p: Int) = (p ushr 24) and 0xFF
    private fun luma(p: Int): Double = 0.299 * ((p shr 16) and 0xFF) + 0.587 * ((p shr 8) and 0xFF) + 0.114 * (p and 0xFF)

    /** Caja mínima con píxeles visibles (alfa > [minAlpha]); null si está vacía. */
    fun inkBounds(px: IntArray, w: Int, h: Int, minAlpha: Int = 12): Bounds? {
        var x0 = w; var y0 = h; var x1 = -1; var y1 = -1
        for (y in 0 until h) {
            val row = y * w
            for (x in 0 until w) {
                if (alpha(px[row + x]) > minAlpha) {
                    if (x < x0) x0 = x; if (x > x1) x1 = x
                    if (y < y0) y0 = y; if (y > y1) y1 = y
                }
            }
        }
        return if (x1 < 0) null else Bounds(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    }

    /** Recorte con margen [pad] dentro de la imagen; null si el trazo es demasiado pequeño (menos de 4 px). */
    fun trimRect(b: Bounds?, w: Int, h: Int, pad: Int = 8): Bounds? {
        if (b == null || b.w < 4 || b.h < 4) return null
        val x = max(0, b.x - pad); val y = max(0, b.y - pad)
        return Bounds(x, y, min(w - x, b.w + pad * 2), min(h - y, b.h + pad * 2))
    }

    /** Medidas finales para no pasar de [maxW]×[maxH] (nunca agranda), mínimo 8 px por lado (límite del API). */
    fun fit(w: Int, h: Int, maxW: Int, maxH: Int): Pair<Int, Int> {
        val k = min(1.0, min(maxW.toDouble() / w, maxH.toDouble() / h))
        return max(8, (w * k).roundToInt()) to max(8, (h * k).roundToInt())
    }

    /** Umbral de Otsu sobre la luminancia; con dos tonos bien separados se usa el punto medio entre las dos medias. */
    fun otsuThreshold(px: IntArray): Int {
        val hist = IntArray(256)
        for (p in px) hist[luma(p).roundToInt().coerceIn(0, 255)]++
        val n = px.size.toDouble()
        var sum = 0.0
        for (t in 0 until 256) sum += t.toDouble() * hist[t]
        var sumB = 0.0; var wB = 0.0; var best = 0.0; var threshold = 128
        for (t in 0 until 256) {
            wB += hist[t]
            if (wB == 0.0) continue
            val wF = n - wB
            if (wF == 0.0) break
            sumB += t.toDouble() * hist[t]
            val mB = sumB / wB; val mF = (sum - sumB) / wF
            val between = wB * wF * (mB - mF) * (mB - mF)
            if (between > best) { best = between; threshold = ((mB + mF) / 2).roundToInt() }
        }
        return threshold
    }

    /**
     * Foto → tinta: lo más claro que el umbral queda transparente; lo oscuro toma [color] (ARGB; null = conservar el
     * color original) con opacidad según qué tan oscuro es (bordes suaves).
     */
    fun inkify(px: IntArray, threshold: Int, color: Int?): IntArray {
        val out = IntArray(px.size)
        val soft = max(8.0, threshold * 0.25)
        for (i in px.indices) {
            val p = px[i]
            val l = luma(p)
            val a = if (l >= threshold) 0.0 else min(1.0, (threshold - l) / soft)
            val alpha = (a * 255 * (alpha(p) / 255.0)).roundToInt().coerceIn(0, 255)
            val rgb = (color ?: p) and 0xFFFFFF
            out[i] = (alpha shl 24) or rgb
        }
        return out
    }

    /** Umbral inicial para una foto: un poco por encima del automático (como la web). */
    fun photoThreshold(auto: Int): Int = min(235, auto + 10)
    /** Rango del control «Limpiar el fondo». */
    fun sliderRange(auto: Int): IntRange = max(40, auto - 70)..min(250, auto + 70)
}
