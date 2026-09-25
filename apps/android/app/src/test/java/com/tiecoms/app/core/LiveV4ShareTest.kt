package com.tiecoms.app.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * SPEC-v4 contra el API de pruebas (3043, mobile-feedback e68dbe8) con dos clientes reales A y B: subir foto y
 * miniatura, enviar solo-adjuntos a 2 conversaciones (como la hoja de compartir), descargar con Bearer, reenviar,
 * borrar, lastHumanPreview y límites. Se omite sin fixture:
 *   TIECOMS_FIXTURE=/ruta/fx4.json ./gradlew :app:testDebugUnitTest --tests '*LiveV4Share*'
 */
class LiveV4ShareTest {
    private val fxPath = System.getenv("TIECOMS_FIXTURE").orEmpty()
    private fun log(step: String, detail: String) = println("[v4] $step: $detail")
    private val ok = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()

    private suspend fun until(ms: Long, what: String, cond: () -> Boolean): Long {
        val t0 = System.currentTimeMillis()
        try { withTimeout(ms) { while (!cond()) delay(20) } } catch (e: Exception) { throw AssertionError("No ocurrió en $ms ms: $what") }
        return System.currentTimeMillis() - t0
    }

    private fun tmp(name: String, bytes: ByteArray) = File.createTempFile("tcv4", name).apply { writeBytes(bytes); deleteOnExit() }

    @Test
    fun compartirYAdjuntosEnVivo() = runBlocking {
        assumeTrue("Sin TIECOMS_FIXTURE: se omite", fxPath.isNotBlank() && File(fxPath).exists())
        val fx = TcJson.parseToJsonElement(File(fxPath).readText()).jsonObject
        val api = fx["apiUrl"]!!.jsonPrimitive.content
        assertFalse("Nunca contra producción", api.contains("app.tiecoms.com"))
        val password = fx["password"]!!.jsonPrimitive.content
        val group = fx["conversationId"]!!.jsonPrimitive.content
        val a = TieComsClient(api, "JVM A", MemoryStorage(), MemorySecretStore(), ok)
        val b = TieComsClient(api, "JVM B (par)", MemoryStorage(), MemorySecretStore(), ok)
        val tag = UUID.randomUUID().toString().take(6)
        try {
            a.login((fx["a"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            b.login((fx["b"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            until(10_000, "sockets en vivo") { a.state.value.connection == ConnectionStatus.ONLINE && b.state.value.connection == ConnectionStatus.ONLINE }
            val bId = b.myId!!
            val direct = a.createChat(listOf(bId), null).id
            a.openConversation(group); b.openConversation(group); b.loadBootstrap(); b.openConversation(direct); a.openConversation(direct)

            val jpeg = javaClass.classLoader!!.getResourceAsStream("avatar-test.jpg")!!.use { it.readBytes() }
            val photo = tmp("foto.jpg", jpeg)
            val pdf = tmp("acta.pdf", "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n".toByteArray())

            // 1. Subir foto + miniatura (la genera el cliente) y un PDF, con progreso.
            var progress = 0L
            var t0 = System.currentTimeMillis()
            val img = a.uploadAttachment(group, photo, "foto $tag.jpg", "image/jpeg") { sent, _ -> progress = sent }
            log("subir", "foto ${img.sizeBytes} B en ${System.currentTimeMillis() - t0} ms → ${img.contentType} ${img.width}×${img.height} ${img.url}; progreso visto ${progress} B")
            assertEquals(jpeg.size.toLong(), img.sizeBytes); assertEquals("image/jpeg", img.contentType); assertEquals(192, img.width); assertEquals(192, img.height)
            assertTrue(img.url.startsWith("/api/v1/attachments/")); assertEquals(jpeg.size.toLong(), progress)
            val withThumb = a.uploadThumb(img.id, jpeg)
            assertNotNull("miniatura", withThumb?.thumbUrl)
            log("miniatura", "POST /thumb → ${withThumb?.thumbUrl}")
            val doc = a.uploadAttachment(group, pdf, "acta $tag.pdf", "application/pdf")
            log("subir", "PDF → ${doc.contentType}, ${doc.sizeBytes} B, ancho ${doc.width}")

            // 2. Como la hoja de compartir: mensaje SOLO con adjuntos al grupo y, con otra subida, al directo.
            t0 = System.currentTimeMillis()
            a.send(group, "", attachments = listOf(withThumb!!, doc))
            val imgD = a.uploadAttachment(direct, photo, "foto $tag.jpg", "image/jpeg")
            a.send(direct, "Para ti $tag", attachments = listOf(imgD))
            var dt = until(10_000, "B recibe los dos mensajes con adjuntos") {
                b.state.value.conversations[group]?.messages?.any { m -> m.attachments.any { it.id == img.id } } == true &&
                    b.state.value.conversations[direct]?.messages?.any { m -> m.attachments.any { it.id == imgD.id } } == true
            }
            val mg = b.state.value.conversations[group]!!.messages.first { m -> m.attachments.any { it.id == img.id } }
            assertEquals("", mg.body); assertEquals(listOf(img.id, doc.id), mg.attachments.map { it.id })
            log("enviar a 2", "B recibe el solo-adjuntos del grupo (${mg.attachments.size} adjuntos, orden conservado) y el del directo en ${System.currentTimeMillis() - t0} ms (espera $dt ms)")

            // 3. B descarga con Bearer: original idéntico y miniatura.
            val out = File.createTempFile("tcv4", "dl").apply { deleteOnExit() }
            b.downloadAttachment(mg.attachments[0].url, out)
            assertArrayEquals(jpeg, out.readBytes())
            val th = File.createTempFile("tcv4", "th").apply { deleteOnExit() }
            b.downloadAttachment(mg.attachments[0].thumbUrl!!, th)
            assertTrue(th.length() > 0)
            log("descargar", "B baja la foto (${out.length()} B, idéntica) y la miniatura (${th.length()} B)")

            // 4. Un adjunto de otra conversación no se puede usar aquí.
            val stray = a.uploadAttachment(group, photo, "x.jpg", "image/jpeg")
            val cid = a.send(direct, "no debería salir", attachments = listOf(stray))!!
            until(10_000, "el envío con un adjunto ajeno falla") { a.state.value.pending.any { it.clientMessageId == cid && it.status == "failed" } }
            log("reglas", "adjunto de otra conversación → rechazado: ${a.state.value.pending.first { it.clientMessageId == cid }.error}")
            a.discard(cid)

            // 5. Reenviar el mensaje con adjuntos (forwardAttachmentIds: el servidor copia la referencia).
            val mine = a.state.value.conversations[group]!!.messages.first { m -> m.attachments.any { it.id == img.id } }
            a.forward(mine, listOf(direct), null)
            dt = until(10_000, "B recibe el reenvío con adjuntos") {
                b.state.value.conversations[direct]!!.messages.any { it.forwarded?.source == "tiecoms" && it.attachments.size == 2 }
            }
            val fwd = b.state.value.conversations[direct]!!.messages.first { it.forwarded?.source == "tiecoms" && it.attachments.size == 2 }
            val out2 = File.createTempFile("tcv4", "fw").apply { deleteOnExit() }
            b.downloadAttachment(fwd.attachments[0].url, out2)
            assertArrayEquals(jpeg, out2.readBytes())
            log("reenviar", "B recibe el reenvío con ${fwd.attachments.size} adjuntos en $dt ms (ids ${if (fwd.attachments[0].id == img.id) "iguales" else "nuevos"}) y los descarga")

            // 6. lastHumanPreview: tras un mensaje de sistema, la lista muestra el último mensaje de una persona.
            val tf = a.state.value.conversations[group]!!.messages.last()
            a.createIssue(group, "Revisar la foto $tag", null, null, null)
            until(8_000, "mensaje de sistema del asunto") { b.state.value.conversations[group]!!.messages.last().kind == "system" }
            val boot = b.loadBootstrap().conversations.first { it.id == group }
            log("vista previa", "lastMessagePreview=«${boot.lastMessagePreview}» · lastHumanPreview=${boot.lastHumanPreview}")
            assertNotNull(boot.lastHumanPreview)
            assertEquals(tf.id, boot.lastHumanPreview!!.messageId)
            assertEquals(2, boot.lastHumanPreview!!.attachments?.count)

            // 7. Borrar el mensaje oculta sus adjuntos (404 para quien descarga).
            a.deleteMessage(mine.id)
            try { b.downloadAttachment(img.url, File.createTempFile("tcv4", "del")); fail("debía dar 404") } catch (e: ApiException) { assertEquals(404, e.status) }
            log("borrar", "mensaje borrado → su adjunto da 404")

            // 8. Más de 25 MB: se rechaza antes de subir.
            val big = File.createTempFile("tcv4", "big").apply { deleteOnExit(); RandomAccessFile(this, "rw").use { it.setLength(Attachments.MAX_BYTES + 1) } }
            try { a.uploadAttachment(group, big, "grande.mov", "video/quicktime"); fail("debía rechazar") } catch (e: ApiException) { assertEquals("too_large", e.code) }
            log("límites", "archivo de 25 MB + 1 B → too_large sin subir")

            // 9. §D Nuevo chat → Grupo en un espacio (directivo con B; interno solo de mi empresa).
            val ws = fx["workspaceId"]!!.jsonPrimitive.content
            val g = a.createSpaceGroup(ws, "Pagos $tag", internal = false, directive = true, memberIds = listOf(bId))
            val gm = a.meta(g.id)!!
            assertEquals("group", gm.kind); assertEquals("directivo", gm.level); assertTrue(bId in gm.memberIds)
            b.loadBootstrap(); assertNotNull("B ve el grupo", b.meta(g.id))
            val inner = a.createSpaceGroup(ws, "Equipo $tag", internal = true, directive = true, memberIds = emptyList())
            assertEquals("internal", a.meta(inner.id)!!.kind); assertEquals(null, a.meta(inner.id)!!.level)
            b.loadBootstrap(); assertEquals("B no ve el interno", null, b.meta(inner.id))
            log("grupo en espacio", "directivo con B → kind=group level=directivo, B lo ve; interno → kind=internal sin nivel, B no lo ve")
        } finally {
            runCatching { a.logout() }; runCatching { b.logout() }
        }
    }
}
