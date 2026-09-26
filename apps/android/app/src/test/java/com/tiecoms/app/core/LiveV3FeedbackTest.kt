package com.tiecoms.app.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * SPEC-v3 (feedback de TestFlight) contra el API de pruebas de mobile-feedback (http://localhost:3043) con dos
 * clientes reales A y B. Se omite sin fixture:
 *   TIECOMS_FIXTURE=/ruta/fx3043.json ./gradlew :app:testDebugUnitTest --tests '*LiveV3Feedback*'
 */
class LiveV3FeedbackTest {
    private val fxPath = System.getenv("TIECOMS_FIXTURE").orEmpty()
    private fun log(step: String, detail: String) = println("[v3fb] $step: $detail")
    private val ok = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()

    private suspend fun until(ms: Long, what: String, cond: () -> Boolean): Long {
        val t0 = System.currentTimeMillis()
        try { withTimeout(ms) { while (!cond()) delay(20) } } catch (e: Exception) { throw AssertionError("No ocurrió en $ms ms: $what") }
        return System.currentTimeMillis() - t0
    }

    /** JPEG real (ícono de la app 192×192) desde los recursos de prueba. */
    private fun jpeg(): ByteArray = javaClass.classLoader!!.getResourceAsStream("avatar-test.jpg")!!.use { it.readBytes() }

    private fun sys(c: TieComsClient, conv: String, k: String) =
        c.state.value.conversations[conv]?.messages.orEmpty().any { it.kind == "system" && it.body.contains("\"k\":\"$k\"") }

    private suspend inline fun expectApi(status: Int, code: String? = null, block: () -> Unit): ApiException {
        try { block(); fail("Se esperaba HTTP $status") } catch (e: ApiException) {
            assertEquals("HTTP de ${e.code}", status, e.status); if (code != null) assertEquals(code, e.code); return e
        }
        throw IllegalStateException()
    }

    @Test
    fun feedbackV3EnVivo() = runBlocking {
        assumeTrue("Sin TIECOMS_FIXTURE: se omite", fxPath.isNotBlank() && File(fxPath).exists())
        val fx = TcJson.parseToJsonElement(File(fxPath).readText()).jsonObject
        val api = fx["apiUrl"]!!.jsonPrimitive.content
        assertFalse("Nunca contra producción", (api.contains("app.tiecoms.com") || api.contains("app.chaggu.com")))
        val password = fx["password"]!!.jsonPrimitive.content
        val conv = fx["conversationId"]!!.jsonPrimitive.content
        val a = TieComsClient(api, "JVM A", MemoryStorage(), MemorySecretStore(), ok)
        val b = TieComsClient(api, "JVM B (par)", MemoryStorage(), MemorySecretStore(), ok)
        try {
            a.login((fx["a"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            b.login((fx["b"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            until(10_000, "sockets en vivo") { a.state.value.connection == ConnectionStatus.ONLINE && b.state.value.connection == ConnectionStatus.ONLINE }
            a.openConversation(conv); b.openConversation(conv)
            val aId = a.myId!!; val bId = b.myId!!
            val tag = UUID.randomUUID().toString().take(6)

            // Mensaje de B que servirá de ancla (lateral) y de origen (respuesta en privado).
            val anchorBody = "ancla $tag: ¿quién aprueba el presupuesto?"
            b.send(conv, anchorBody)
            until(10_000, "A recibe el ancla") { a.state.value.conversations[conv]!!.messages.any { it.body == anchorBody } }
            val anchor = a.state.value.conversations[conv]!!.messages.first { it.body == anchorBody }

            // §1 Foto del grupo: subir, el par ve el sistema group.photo_changed, descargar, quitar.
            val canManage = a.meta(conv)!!.canManage
            if (canManage) {
                val url = a.setConversationAvatar(conv, jpeg())
                assertNotNull(url); assertTrue("ruta relativa: $url", url!!.startsWith("/api/v1/avatars/"))
                assertEquals(url, a.meta(conv)!!.avatarUrl)
                var dt = until(8_000, "B ve group.photo_changed") { sys(b, conv, "group.photo_changed") }
                val img = ok.newCall(Request.Builder().url(Media.absolute(url, api)!!).build()).execute().use { it.code to (it.body?.bytes()?.size ?: 0) }
                log("foto grupo", "POST avatar → $url; par ve sistema en $dt ms; GET ${img.first} (${img.second} B)")
                a.loadBootstrap(); assertEquals(url, a.meta(conv)!!.avatarUrl)
                a.removeConversationAvatar(conv)
                assertNull(a.meta(conv)!!.avatarUrl)
                dt = until(8_000, "B ve group.photo_removed") { sys(b, conv, "group.photo_removed") }
                log("foto grupo", "DELETE → avatarUrl null; par ve group.photo_removed en $dt ms")
            } else log("foto grupo", "A no administra el grupo: se prueba solo el 403")
            if (!b.meta(conv)!!.canManage) {
                val e = expectApi(403) { b.setConversationAvatar(conv, jpeg()) }
                log("foto grupo", "B sin canManage → 403 ${e.code}")
            }
            val direct = a.createChat(listOf(bId), null)
            assertEquals("direct", direct.kind)
            val e400 = expectApi(400) { a.setConversationAvatar(direct.id, jpeg()) }
            log("foto grupo", "en un directo → 400 ${e400.code}")

            // §4 Conversación lateral sobre el mensaje de B.
            expectApi(400) { a.startSide(conv, anchor.id, listOf(aId), null) }
            val out = try { a.startSide(conv, anchor.id, listOf(UUID.randomUUID().toString()), null); null } catch (e: ApiException) { e }
            log("lateral", "userIds solo yo → 400; persona inexistente → ${out?.status} ${out?.code} ${SideOutsiders.from(out ?: Exception())}")
            val sideId = a.startSide(conv, anchor.id, listOf(bId), "¿Lo vemos en privado? $tag")
            val side = a.meta(sideId)!!
            assertTrue(side.isSide); assertEquals(conv, side.parentId); assertEquals(anchor.id, side.parentMessageId)
            b.loadBootstrap()
            assertTrue("B es miembro de la lateral", b.meta(sideId)?.isSide == true)
            b.openConversation(sideId)
            val started = b.state.value.conversations[sideId]!!.messages.firstOrNull { it.kind == "system" && it.body.contains("side.started") }
                ?: a.state.value.conversations[conv]!!.messages.firstOrNull { it.kind == "system" && it.body.contains("side.started") }
            log("lateral", "creada $sideId; ancla ${side.parentMessageId}; sistema: ${started?.body}")
            assertNotNull("mensaje de sistema side.started", started)
            val sj = TcJson.parseToJsonElement(started!!.body).jsonObject
            assertEquals("side.started", sj["k"]!!.jsonPrimitive.content)
            // Pantalla de Inicio: la lateral cuelga de su origen.
            val tree = HomeTree.build(a.state.value.data!!, "", null, emptySet(), { it.name ?: it.id })
            val iOrigin = tree.indexOfFirst { it.key == "c:$conv" }; val iSide = tree.indexOfFirst { it.key == "c:$sideId" }
            assertTrue("lateral bajo el origen ($iOrigin, $iSide)", iSide == iOrigin + 1 && (tree[iSide] as HomeTree.Conv).depth == 1)
            // Llevar la respuesta al hilo.
            a.openConversation(sideId)
            val ret = a.returnResult(sideId, "Respuesta: aprueba Beto ($tag)")
            assertEquals(conv, ret.parentId)
            val dt = until(8_000, "B ve el retorno en el hilo") { b.state.value.conversations[conv]!!.messages.any { it.body.contains("aprueba Beto ($tag)") } }
            log("lateral", "retorno al hilo visible para B en $dt ms")

            // §7 Responder en privado: directo con forwarded.messageId.
            a.openConversation(direct.id); b.loadBootstrap(); b.openConversation(direct.id)
            val privBody = "en privado $tag"
            a.send(direct.id, privBody, forwarded = ForwardedInfo("tiecoms", Names.person(a.state.value.data, bId)?.name, anchor.createdAt, conv, anchor.id))
            until(10_000, "B recibe la respuesta privada") { b.state.value.conversations[direct.id]?.messages?.any { it.body == privBody } == true }
            val pm = b.state.value.conversations[direct.id]!!.messages.first { it.body == privBody }
            assertEquals(anchor.id, pm.forwarded?.messageId); assertEquals(conv, pm.forwarded?.fromConversationId)
            // El servidor agrega el número del original (enlace ?m=) y el extracto; el cliente no los manda.
            assertEquals(anchor.seq, pm.forwarded?.messageSeq)
            assertTrue("extracto: ${pm.forwarded?.excerpt}", anchorBody.startsWith(pm.forwarded?.excerpt ?: "∅") && (pm.forwarded?.excerpt?.length ?: 0) in 1..200)
            log("respuesta privada", "B recibe en el directo con forwarded.messageId=${pm.forwarded?.messageId} messageSeq=${pm.forwarded?.messageSeq} excerpt=«${pm.forwarded?.excerpt}»")

            // §3 Comentarios de asuntos.
            val issue = a.createIssue(conv, "Presupuesto $tag", bId, null, anchor.id)
            until(8_000, "B conoce el asunto") { b.state.value.issues[issue.id] != null }
            val tc = System.currentTimeMillis()
            val after = a.commentIssue(issue.id, "¿Alguna novedad? $tag")
            assertEquals(1, after.commentCount)
            val live = until(8_000, "B recibe issue.updated con commentCount=1") { b.state.value.issues[issue.id]?.commentCount == 1 }
            log("asuntos", "POST comments → issue.updated al par en ${System.currentTimeMillis() - tc} ms (espera $live ms)")
            val detail = b.issueDetail(issue.id)
            assertTrue(detail.events.any { it.kind == "comment" && it.actorId == aId })
            log("asuntos", "comentario publicado; B ve ${detail.events.count { it.kind == "comment" }} comentario(s); commentCount=${after.commentCount}")

            // §6 Push: registrar y borrar el token de FCM de la sesión.
            a.registerPushToken("fcm-test-$tag", "es")
            a.unregisterPushToken()
            log("push", "PUT /push/token (fcm, es) y DELETE sin error; badge local A=${a.badge()} B=${b.badge()}")

            // §9 Crear espacio desde Inicio.
            val ws = a.createWorkspace("Espacio $tag", "Pruebas")
            assertTrue(a.state.value.data!!.workspaces.any { it.id == ws.id })
            log("espacios", "POST /workspaces → ${ws.id}")
        } finally {
            runCatching { a.logout() }; runCatching { b.logout() }
        }
    }
}
