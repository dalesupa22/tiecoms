package com.tiecoms.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.platform.ImageTools
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Fotos grandes (3200×2400, con grano) del mismo lote con nombres visibles repetidos: cada una queda en su archivo, con su contenido. */
@RunWith(AndroidJUnit4::class)
class ImageBatchTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val dir = File(ctx.cacheDir, "share/" + UUID.randomUUID().toString().take(8)).apply { mkdirs() }

    /** Foto de 3200×2400 con grano por píxel (como una foto real: varios MB también en PNG) de un color dominante. */
    private fun photo(i: Int, name: String, color: Int, png: Boolean = false): Attachments.Shared {
        val w = 3200; val h = 2400
        val r = java.util.Random(i.toLong())
        val px = IntArray(w * h) { color xor (r.nextInt() and 0x1F1F1F) or (0xFF shl 24) }
        val b = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
        val f = File(dir, "$i-$name")
        f.outputStream().use { b.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 98, it) }
        b.recycle()
        return Attachments.Shared(name, if (png) "image/png" else "image/jpeg", f.length(), f.absolutePath)
    }
    private fun center(path: String): Int {
        val b = BitmapFactory.decodeFile(path)
        return b.getPixel(b.width / 2, b.height / 2)
    }
    private fun near(a: Int, b: Int) = listOf(Color.red(a) - Color.red(b), Color.green(a) - Color.green(b), Color.blue(a) - Color.blue(b)).all { kotlin.math.abs(it) < 90 }

    @Test fun mismoNombreYMismaBaseNoSePisan() = runBlocking {
        val items = listOf(photo(0, "IMG_0001.jpg", Color.RED), photo(1, "IMG_0001.jpg", Color.BLUE), photo(2, "foo.png", Color.GREEN, png = true), photo(3, "foo.jpg", Color.YELLOW))
        val out = items.map { ImageTools.prepareForUpload(ctx, it) }
        assertEquals(4, out.map { it.path }.toSet().size)
        out.forEachIndexed { i, o -> assertTrue("salida $i existe: $o", File(o.path).exists()); assertTrue("salida $i convertida: $o (entrada ${items[i].sizeBytes} B)", o.path.endsWith(".jpg") && File(o.path).name.startsWith("up-")); assertEquals("image/jpeg", o.contentType) }
        assertEquals(listOf("IMG_0001.jpg", "IMG_0001.jpg", "foo.jpg", "foo.jpg"), out.map { it.name })
        listOf(Color.RED, Color.BLUE, Color.GREEN, Color.YELLOW).forEachIndexed { i, col -> assertTrue("salida $i con su propio contenido", near(center(out[i].path), col)) }
        assertNotEquals(center(out[0].path), center(out[1].path))
        // Sin temporales sueltos en la carpeta del lote.
        assertTrue(dir.list()!!.none { it.endsWith(".part") })
        dir.deleteRecursively(); Unit
    }
}
