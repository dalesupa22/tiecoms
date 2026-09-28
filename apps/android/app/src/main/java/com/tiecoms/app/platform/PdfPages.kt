package com.tiecoms.app.platform

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.LruCache
import com.tiecoms.app.core.PageSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Un PDF abierto con PdfRenderer (pdfium del sistema) para el visor de firma.
 *
 * - PdfRenderer no es seguro entre hilos y solo admite una página abierta a la vez: todo pasa por [mutex].
 * - [sizes] vienen en puntos y **ya con la rotación /Rotate aplicada** (pdfium intercambia ancho y alto en páginas
 *   giradas 90/270), y render() sin matriz dibuja la página tal como se ve. Así las proporciones de pantalla son
 *   directamente las que espera el servidor. Lo comprueba PdfRotationTest (androidTest) con una página girada.
 * - Los bitmaps quedan en un LruCache con tope de memoria; al cerrarse se liberan.
 */
class PdfPages private constructor(
    private val fd: ParcelFileDescriptor,
    private val renderer: PdfRenderer,
    val sizes: List<PageSize>,
) {
    private val mutex = Mutex()
    @Volatile private var closed = false
    private val cache = object : LruCache<String, Bitmap>(cacheBytes()) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    val count: Int get() = sizes.size

    private fun key(index: Int, widthPx: Int) = "$index@$widthPx"

    fun cached(index: Int, widthPx: Int): Bitmap? = cache.get(key(index, widthPx))

    /** Dibuja la página [index] (0…n-1) a [widthPx] de ancho; null si el documento ya se cerró o falló. */
    suspend fun render(index: Int, widthPx: Int): Bitmap? {
        cached(index, widthPx)?.let { return it }
        return mutex.withLock {
            withContext(Dispatchers.IO) {
                if (closed) return@withContext null
                cached(index, widthPx)?.let { return@withContext it }
                val size = sizes.getOrNull(index) ?: return@withContext null
                // Nitidez de la pantalla sin pasar de ~12 Mpx por página (hojas muy largas).
                var w = widthPx.coerceIn(64, 2400).toFloat()
                var h = w * size.h / size.w
                val px = w * h
                if (px > 12_000_000f) { val k = sqrt(12_000_000f / px); w *= k; h *= k }
                try {
                    renderer.openPage(index).use { page ->
                        val bmp = Bitmap.createBitmap(w.roundToInt().coerceAtLeast(1), h.roundToInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                        bmp.eraseColor(Color.WHITE)
                        page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        cache.put(key(index, widthPx), bmp)
                        bmp
                    }
                } catch (e: Exception) {
                    null
                } catch (e: OutOfMemoryError) {
                    cache.evictAll(); null
                }
            }
        }
    }

    /** Cierra cuando termine el dibujo en curso (nunca a la mitad de un render). */
    fun close() {
        if (closed) return
        closed = true
        closer.launch {
            mutex.withLock {
                runCatching { renderer.close() }
                runCatching { fd.close() }
                cache.evictAll()
            }
        }
    }

    companion object {
        private val closer = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        private fun cacheBytes(): Int {
            val max = Runtime.getRuntime().maxMemory()
            return (max / 6).coerceIn(16L * 1024 * 1024, 96L * 1024 * 1024).toInt()
        }

        /**
         * Abre [file] y lee el tamaño de cada página. Lanza SecurityException si el PDF tiene contraseña
         * y IOException si no es un PDF válido.
         */
        suspend fun open(file: File): PdfPages = withContext(Dispatchers.IO) {
            val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            val renderer = try { PdfRenderer(fd) } catch (e: Throwable) { runCatching { fd.close() }; throw e }
            try {
                val sizes = (0 until renderer.pageCount).map { i ->
                    renderer.openPage(i).use { p -> PageSize(p.width.toFloat().coerceAtLeast(1f), p.height.toFloat().coerceAtLeast(1f)) }
                }
                if (sizes.isEmpty()) throw java.io.IOException("PDF sin páginas")
                PdfPages(fd, renderer, sizes)
            } catch (e: Throwable) {
                runCatching { renderer.close() }; runCatching { fd.close() }
                throw e
            }
        }
    }
}
