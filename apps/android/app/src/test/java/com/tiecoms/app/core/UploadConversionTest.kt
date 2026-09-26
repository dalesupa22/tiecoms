package com.tiecoms.app.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

/** Lote de fotos reducidas: nombres visibles repetidos no comparten archivo; un fallo no toca a los demás. */
class UploadConversionTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Como ShareIntake.copyToCache: todo el lote en una carpeta, archivo «$i-$nombre», nombre visible sin índice. */
    private fun batch(vararg items: Pair<String, ByteArray>): List<Attachments.Shared> {
        val dir = tmp.newFolder("share", "lote")
        return items.mapIndexed { i, (name, bytes) ->
            val f = File(dir, "$i-$name").apply { writeBytes(bytes) }
            Attachments.Shared(name, "image/jpeg", f.length(), f.absolutePath)
        }
    }
    private fun big(seed: Int) = ByteArray(20_000) { (it * 31 + seed).toByte() }
    /** «Reduce» el original a su primera mitad: la salida depende solo de su propia fuente. */
    private fun halve(src: Attachments.Shared): (File) -> Boolean = { out -> out.writeBytes(File(src.path).readBytes().copyOf(10_000)); true }
    private fun sha(f: File) = MessageDigest.getInstance("SHA-256").digest(f.readBytes())

    @Test fun `dos fotos con el mismo nombre visible dan dos archivos distintos`() {
        val a = big(1); val b = big(2)
        val (s1, s2) = batch("IMG_0001.jpg" to a, "IMG_0001.jpg" to b)
        val o1 = UploadConversion.convert(s1, UploadConversion.jpgName(s1.name), "image/jpeg", halve(s1))
        val o2 = UploadConversion.convert(s2, UploadConversion.jpgName(s2.name), "image/jpeg", halve(s2))
        assertNotEquals(o1.path, o2.path)
        assertEquals("IMG_0001.jpg", o1.name); assertEquals("IMG_0001.jpg", o2.name)
        assertArrayEquals(sha(File(o1.path)), MessageDigest.getInstance("SHA-256").digest(a.copyOf(10_000)))
        assertArrayEquals(sha(File(o2.path)), MessageDigest.getInstance("SHA-256").digest(b.copyOf(10_000)))
    }

    @Test fun `foo png y foo jpg no se pisan`() {
        val a = big(3); val b = big(4)
        val (s1, s2) = batch("foo.png" to a, "foo.jpg" to b)
        val o1 = UploadConversion.convert(s1, UploadConversion.jpgName(s1.name), "image/jpeg", halve(s1))
        val o2 = UploadConversion.convert(s2, UploadConversion.jpgName(s2.name), "image/jpeg", halve(s2))
        assertNotEquals(o1.path, o2.path)
        assertEquals("foo.jpg", o1.name); assertEquals("foo.jpg", o2.name)
        assertTrue(File(o1.path).readBytes().contentEquals(a.copyOf(10_000)))
        assertTrue(File(o2.path).readBytes().contentEquals(b.copyOf(10_000)))
    }

    @Test fun `si la segunda falla la primera sigue intacta y la segunda usa su original`() {
        val a = big(5); val b = big(6)
        val (s1, s2) = batch("foto.jpg" to a, "foto.jpg" to b)
        val o1 = UploadConversion.convert(s1, "foto.jpg", "image/jpeg", halve(s1))
        val before = sha(File(o1.path))
        // Falla a mitad de escribir.
        val o2 = UploadConversion.convert(s2, "foto.jpg", "image/jpeg") { out -> out.writeBytes(ByteArray(10)); throw IllegalStateException("sin memoria") }
        assertEquals(s2, o2)
        assertTrue(File(s2.path).readBytes().contentEquals(b))
        assertArrayEquals(before, sha(File(o1.path)))
        // Descartada por no ser más liviana: igual, sin tocar nada.
        val o3 = UploadConversion.convert(s2, "foto.jpg", "image/jpeg") { out -> out.writeBytes(ByteArray(30_000)); true }
        assertEquals(s2, o3)
        assertArrayEquals(before, sha(File(o1.path)))
        // Sin temporales sueltos: solo la salida de la primera y el original de la segunda.
        assertEquals(setOf(File(o1.path).name, File(s2.path).name), File(s1.path).parentFile!!.list()!!.toSet())
    }
}
