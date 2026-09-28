package com.tiecoms.app

import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.core.PageSize
import com.tiecoms.app.core.Signing
import com.tiecoms.app.platform.PdfPages
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * PdfRenderer (pdfium del sistema) entrega el tamaño de la página ya girado y la dibuja tal como se ve: las
 * proporciones de pantalla son las que espera el servidor (displayToPdf), también en páginas con /Rotate 90.
 */
@RunWith(AndroidJUnit4::class)
class PdfRotationTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    private fun dark(c: Int) = Color.red(c) < 60 && Color.green(c) < 60 && Color.blue(c) < 60

    @Test
    fun paginaGiradaYaVieneGirada() = runBlocking {
        val f = PdfFixture.write(File(ctx.cacheDir, "rot-test.pdf"), listOf(0, 90, 180, 270))
        val pdf = PdfPages.open(f)
        try {
            assertEquals(PageSize(612f, 792f), pdf.sizes[0])
            assertEquals(PageSize(792f, 612f), pdf.sizes[1])
            assertEquals(PageSize(612f, 792f), pdf.sizes[2])
            assertEquals(PageSize(792f, 612f), pdf.sizes[3])
            assertEquals(Signing.displaySize(612f, 792f, 90), pdf.sizes[1])
            // El cuadrado negro está en el origen del PDF (0..100, 0..100 pt). Donde lo pone el servidor en la vista
            // (inversa de displayToPdf) es donde debe verse al dibujar la página.
            for (i in 0 until 4) {
                val rot = listOf(0, 90, 180, 270)[i]
                val bmp = pdf.render(i, 792)!!
                val size = pdf.sizes[i]
                assertEquals(size.h / size.w, bmp.height.toFloat() / bmp.width, 0.01f)
                // Centro del cuadrado en el PDF: (50, 50). Buscar el punto de la vista que el servidor lleva ahí.
                var hit: Pair<Float, Float>? = null
                loop@ for (gy in 0..40) for (gx in 0..40) {
                    val dx = gx / 40f * size.w; val dy = gy / 40f * size.h
                    val (px, py) = Signing.displayToPdf(612f, 792f, rot, dx, dy)
                    if (kotlin.math.abs(px - 50f) < 12f && kotlin.math.abs(py - 50f) < 12f) { hit = dx / size.w to dy / size.h; break@loop }
                }
                val (fx, fy) = hit!!
                val c = bmp.getPixel((fx * bmp.width).toInt().coerceIn(0, bmp.width - 1), (fy * bmp.height).toInt().coerceIn(0, bmp.height - 1))
                assertTrue("página ${i + 1} (/Rotate $rot): el cuadrado debe verse en ($fx, $fy)", dark(c))
                // Y la esquina opuesta queda blanca.
                val o = bmp.getPixel(((1 - fx) * bmp.width).toInt().coerceIn(0, bmp.width - 1), ((1 - fy) * bmp.height).toInt().coerceIn(0, bmp.height - 1))
                assertTrue("página ${i + 1}: la esquina opuesta es papel", !dark(o))
            }
        } finally { pdf.close() }
    }
}
