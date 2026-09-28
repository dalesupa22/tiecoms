package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Firmar PDFs de punta a punta contra el API de pruebas (3056, rama firmar-pdf): subir una firma, firmar un PDF con
 * una marca en una página girada, ver que el adjunto firmado vuelve con `signing`, que aparece en «Documentos que
 * firmé» y borrar la firma. Se omite sin fixture:
 *   TIECOMS_FIXTURE=/ruta/firmar.json ./gradlew :app:testDebugUnitTest --tests '*LiveSigning*'
 * firmar.json: {"apiUrl":"http://localhost:3056","email":"…","password":"…","conversationId":"…","pdfName":"Contrato Nexo 2026.pdf"}
 */
class LiveSigningTest {
    private val fxPath = System.getenv("TIECOMS_FIXTURE").orEmpty()
    private fun log(step: String, detail: String) = println("[firmar] $step: $detail")

    /** PNG RGBA 420×140 transparente con un trazo azul (codificado a mano: la JVM de Android no trae ImageIO). */
    private fun signaturePng(): ByteArray {
        val w = 420; val h = 140
        val raw = ByteArrayOutputStream()
        for (y in 0 until h) {
            raw.write(0) // filtro «ninguno»
            for (x in 0 until w) {
                val cy = 70 + 40 * kotlin.math.sin(x / 30.0)
                val on = x in 20..400 && kotlin.math.abs(y - cy) < 4
                if (on) { raw.write(23); raw.write(42); raw.write(138); raw.write(255) } else repeat(4) { raw.write(0) }
            }
        }
        fun chunk(out: ByteArrayOutputStream, type: String, data: ByteArray) {
            val len = data.size
            out.write(byteArrayOf((len ushr 24).toByte(), (len ushr 16).toByte(), (len ushr 8).toByte(), len.toByte()))
            val td = type.toByteArray() + data
            out.write(td)
            val crc = java.util.zip.CRC32().apply { update(td) }.value
            out.write(byteArrayOf((crc ushr 24).toByte(), (crc ushr 16).toByte(), (crc ushr 8).toByte(), crc.toByte()))
        }
        val ihdr = java.nio.ByteBuffer.allocate(13).putInt(w).putInt(h).put(8).put(6).put(0).put(0).put(0).array()
        val z = ByteArrayOutputStream().use { b -> java.util.zip.DeflaterOutputStream(b).use { it.write(raw.toByteArray()) }; b.toByteArray() }
        return ByteArrayOutputStream().use { out ->
            out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
            chunk(out, "IHDR", ihdr); chunk(out, "IDAT", z); chunk(out, "IEND", ByteArray(0))
            out.toByteArray()
        }
    }

    @Test
    fun firmarEnVivo() = runBlocking {
        assumeTrue("Sin TIECOMS_FIXTURE: se omite", fxPath.isNotBlank() && File(fxPath).exists())
        val fx = TcJson.parseToJsonElement(File(fxPath).readText()).jsonObject
        assumeTrue("El fixture no es de Firmar", fx["pdfName"] != null)
        val api = fx["apiUrl"]!!.jsonPrimitive.content
        assertFalse("Nunca contra producción", api.contains("app.tiecoms.com") || api.contains("app.chaggu.com"))
        val c = TieComsClient(api, "JVM firmar", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build())
        try {
            c.login(fx["email"]!!.jsonPrimitive.content, fx["password"]!!.jsonPrimitive.content)
            val conv = fx["conversationId"]!!.jsonPrimitive.content
            c.openConversation(conv)
            val pdf = c.state.value.conversations[conv]!!.messages.flatMap { it.attachments }
                .last { it.name == fx["pdfName"]!!.jsonPrimitive.content && it.signing == null }
            log("pdf", "${pdf.id} ${pdf.name}")

            val info = c.signInfo(pdf.id)
            assertFalse(info.encrypted)
            log("sign-info", "digital=${info.hasDigitalSignature} historial=${info.history.size}")

            // Firma guardada (PNG transparente recortado en el teléfono; aquí uno hecho en la JVM).
            val sig = c.createSignature(signaturePng(), "signature", "drawn")
            assertEquals(420, sig.width)
            assertTrue(c.listSignatures().any { it.id == sig.id })
            log("firma", "${sig.id} ${sig.width}×${sig.height}")

            try {
                // Página 3 (girada 90°, se ve apaisada 792×612): firma abajo a la derecha, fecha en la 1 y la firma
                // duplicada en la 2 (como en una póliza).
                val sizes = listOf(PageSize(612f, 792f), PageSize(612f, 792f), Signing.displaySize(612f, 792f, 90))
                val (w, h) = Signing.signatureBox(false, sig.width, sig.height, sizes[2])
                val (tw, th) = Signing.textBox(Helvetica.width1("27/09/2026"), sizes[0])
                var marks = listOf(
                    SignMark("a", MarkKind.SIGNATURE, 3, 1 - w - 0.05f, 1 - h - 0.08f, w, h, signatureId = sig.id),
                    SignMark("b", MarkKind.SIGNATURE, 2, 0.1f, 0.6f, 170f / 612f, 170f / 612f * sig.height / sig.width * 612f / 792f, signatureId = sig.id),
                    SignMark("t", MarkKind.DATE, 1, 0.1f, 0.85f, tw, th, text = "27/09/2026"),
                )
                marks = Signing.duplicate(marks, "b", "b2")
                val cmid = "and-" + UUID.randomUUID().toString()
                val input = SignPdfInput(cmid, body = "", placements = Signing.placements(marks), timeZone = "America/Bogota",
                    acceptBreakingSignatures = info.hasDigitalSignature)
                val out = c.signPdf(pdf.id, input)
                assertNotNull(out.signing)
                val signing = out.signing!!
                assertFalse(out.duplicate)
                assertNotNull("El adjunto firmado vuelve con signing", out.attachment?.signing)
                assertEquals(signing.id, out.attachment!!.signing!!.id)
                assertTrue(out.attachment!!.name.isNotBlank())
                assertEquals(64, signing.signedSha256.length)
                log("firmado", "${out.attachment!!.name} ref=${signing.ref} msg=${out.message?.id}")

                // Reintento con el mismo clientMessageId: no firma dos veces.
                val again = c.signPdf(pdf.id, input)
                assertTrue(again.duplicate)
                assertEquals(signing.id, again.signing?.id)

                // El mensaje queda en el hilo con el PDF firmado (decodificado desde el API, campo opcional).
                c.openConversation(conv, force = true)
                val inThread = c.state.value.conversations[conv]!!.messages.flatMap { it.attachments }.firstOrNull { it.id == out.attachment!!.id }
                assertEquals(signing.signerName, inThread?.signing?.signerName)

                // «Documentos que firmé»: aparece, con la referencia del sello, y la búsqueda por referencia la encuentra.
                val page = c.signings(limit = 5)
                val row = page.signings.first { it.id == signing.id }
                assertEquals(signing.ref, row.shownRef)
                assertEquals(4, row.marks) // 3 firmas + 1 fecha
                assertEquals(3, row.signatureMarks)
                assertEquals(3, row.pagesMarked); assertEquals(3, row.pages)
                assertTrue(c.signings(q = signing.ref).signings.any { it.id == signing.id })
                log("historial", "total=${page.total} ref=${row.shownRef} doc=${row.shownName}")

                // El PDF firmado se descarga y es un PDF.
                val f = File.createTempFile("firmado", ".pdf").apply { deleteOnExit() }
                c.downloadAttachment(out.attachment!!.url, f)
                assertEquals("%PDF", f.readBytes().copyOfRange(0, 4).decodeToString())
                log("descarga", "${f.length()} bytes")
            } finally {
                c.deleteSignature(sig.id)
                assertFalse(c.listSignatures().any { it.id == sig.id })
            }
        } finally { c.close() }
    }
}
