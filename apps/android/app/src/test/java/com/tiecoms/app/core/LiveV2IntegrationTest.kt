package com.tiecoms.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.util.Collections
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Integración v2 contra el API de PRUEBAS (http://localhost:3041, base tiecoms_mobile) con dos clientes
 * reales en vivo: A (la app) y B (el par). Se omite sin fixture:
 *   TIECOMS_FIXTURE=/ruta/fx.json [TIECOMS_DELETE_API=http://localhost:3042] ./gradlew :app:testDebugUnitTest --tests '*LiveV2*'
 */
class LiveV2IntegrationTest {
    private val fxPath = System.getenv("TIECOMS_FIXTURE").orEmpty()
    private fun log(step: String, detail: String) = println("[v2] $step: $detail")
    private val ok = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()

    private suspend fun until(ms: Long, what: String, cond: () -> Boolean): Long {
        val t0 = System.currentTimeMillis()
        try { withTimeout(ms) { while (!cond()) delay(20) } } catch (e: Exception) { throw AssertionError("No ocurrió en $ms ms: $what") }
        return System.currentTimeMillis() - t0
    }

    @Test
    fun paridadV2EnVivo() = runBlocking {
        assumeTrue("Sin TIECOMS_FIXTURE: se omite", fxPath.isNotBlank() && File(fxPath).exists())
        val fx = TcJson.parseToJsonElement(File(fxPath).readText()).jsonObject
        val api = fx["apiUrl"]!!.jsonPrimitive.content
        assertFalse("Nunca contra producción", api.contains("app.tiecoms.com"))
        val password = fx["password"]!!.jsonPrimitive.content
        val convId = fx["conversationId"]!!.jsonPrimitive.content
        val a = TieComsClient(api, "JVM A", MemoryStorage(), MemorySecretStore(), ok)
        val b = TieComsClient(api, "JVM B (par)", MemoryStorage(), MemorySecretStore(), ok)
        val sigA = Collections.synchronizedList(mutableListOf<ClientSignal>())
        val sigB = Collections.synchronizedList(mutableListOf<ClientSignal>())
        val bg = CoroutineScope(Dispatchers.Default)
        bg.launch { a.signals.collect { sigA += it } }
        bg.launch { b.signals.collect { sigB += it } }
        try {
            a.login((fx["a"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            b.login((fx["b"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            until(10_000, "sockets en vivo") { a.state.value.connection == ConnectionStatus.ONLINE && b.state.value.connection == ConnectionStatus.ONLINE }
            a.openConversation(convId); b.openConversation(convId)
            val me = a.myId!!

            // 1. Editar, fijar y borrar en vivo (el par ve el cambio y A recibe pins.changed del par).
            val body = "v2 ${UUID.randomUUID().toString().take(6)}"
            a.send(convId, body)
            until(10_000, "B recibe el mensaje") { b.state.value.conversations[convId]!!.messages.any { it.body == body } }
            val m = a.state.value.conversations[convId]!!.messages.first { it.body == body }
            var t0 = System.currentTimeMillis()
            a.editMessage(m.id, "$body (editado)")
            var dt = until(5_000, "B recibe message.updated") { b.state.value.conversations[convId]!!.messages.any { it.id == m.id && it.body.endsWith("(editado)") && it.editedAt != null } }
            log("editar", "PATCH + message.updated al par en ${System.currentTimeMillis() - t0} ms (espera $dt ms)")
            t0 = System.currentTimeMillis()
            b.setMessagePinned(m, true)
            dt = until(5_000, "A recibe pins.changed del par") { a.state.value.pins[convId]?.contains(m.id) == true }
            log("fijar", "B fija → A recibe pins.changed en ${System.currentTimeMillis() - t0} ms")
            assertEquals(listOf(m.id), a.loadPins(convId).map { it.id })
            a.setMessagePinned(m, false)
            until(5_000, "B ve desfijado") { b.state.value.pins[convId]?.contains(m.id) == false }
            t0 = System.currentTimeMillis()
            a.deleteMessage(m.id)
            until(5_000, "B ve el borrado") { b.state.value.conversations[convId]!!.messages.any { it.id == m.id && it.deletedAt != null && it.body.isEmpty() } }
            log("borrar", "DELETE + message.updated al par en ${System.currentTimeMillis() - t0} ms")

            // Mensaje con respuesta citada y marcar no leído desde un mensaje.
            a.send(convId, "cita", replyTo = null)
            val base = "base ${UUID.randomUUID().toString().take(4)}"
            a.send(convId, base)
            until(5_000, "mensaje base") { a.state.value.conversations[convId]!!.messages.any { it.body == base } }
            val baseMsg = a.state.value.conversations[convId]!!.messages.first { it.body == base }
            b.send(convId, "respuesta", replyTo = baseMsg.id)
            until(5_000, "A recibe la respuesta citada") { a.state.value.conversations[convId]!!.messages.any { it.body == "respuesta" && it.replyTo == baseMsg.id } }
            b.markUnread(convId, baseMsg.seq)
            assertTrue(b.meta(convId)!!.unread >= 1)
            log("responder / no leído", "replyTo=${baseMsg.id.take(8)} · B no leídos=${b.meta(convId)!!.unread}")

            // 2. Asunto: crear → cambiar estado (el par lo ve en vivo, contador openIssues).
            t0 = System.currentTimeMillis()
            val issue = a.createIssue(convId, "Revisar $body", me, null, baseMsg.id)
            until(5_000, "B recibe issue.updated") { b.state.value.issues[issue.id] != null }
            a.updateIssue(issue.id, buildJsonObject { put("status", JsonPrimitive("in_progress")) })
            until(5_000, "B ve el nuevo estado") { b.state.value.issues[issue.id]?.status == "in_progress" }
            b.commentIssue(issue.id, "voy")
            val detail = a.issueDetail(issue.id)
            assertTrue(detail.events.any { it.kind == "comment" } && detail.events.any { it.kind == "status" })
            assertEquals(1, b.meta(convId)!!.openIssues)
            log("asunto", "crear→en curso→comentario en ${System.currentTimeMillis() - t0} ms; historial ${detail.events.map { it.kind }}")

            // 3. Reunión: crear → RSVP (B invitado recibe aviso en vivo; A ve la respuesta).
            val bId = (fx["b"] as JsonObject)["id"]!!.jsonPrimitive.content
            val starts = Instant.now().plusSeconds(86_400).let { Instant.ofEpochSecond(it.epochSecond / 60 * 60) }
            t0 = System.currentTimeMillis()
            val ev = a.createEvent(convId, buildJsonObject {
                put("title", JsonPrimitive("Comité $body")); put("startsAt", JsonPrimitive(starts.toString())); put("endsAt", JsonPrimitive(starts.plusSeconds(3600).toString()))
                put("timezone", JsonPrimitive("America/Bogota")); put("inviteeIds", JsonArray(listOf(JsonPrimitive(me), JsonPrimitive(bId))))
            })
            until(5_000, "B recibe calendar.updated") { b.state.value.events[ev.id] != null }
            until(5_000, "B recibe aviso de reunión nueva") { sigB.any { it is ClientSignal.CalendarChanged && it.event.id == ev.id && it.kind == "created" } }
            b.rsvp(ev.id, "yes")
            until(5_000, "A ve el RSVP de B") { a.state.value.events[ev.id]?.invitees?.any { it.userId == bId && it.rsvp == "yes" } == true }
            val listed = a.loadEvents(starts.minusSeconds(60), starts.plusSeconds(7200), convId)
            assertTrue(listed.any { it.id == ev.id })
            log("reunión", "crear→aviso a B→RSVP sí en ${System.currentTimeMillis() - t0} ms")

            // 4. Derivar → devolver (el resultado llega al origen como mensaje con mergedFrom).
            t0 = System.currentTimeMillis()
            val child = a.derive(convId, baseMsg.id, "same", "Derivada · $body", "probar")
            assertEquals(convId, a.meta(child)!!.parentId)
            a.send(child, "conclusión de la derivada")
            until(5_000, "mensaje en la derivada") { a.state.value.conversations[child]?.messages?.any { it.body.startsWith("conclusión") } == true || a.meta(child)!!.lastMessageSeq > 1 }
            val ret = a.returnResult(child, "Resultado: todo listo")
            assertEquals(convId, ret.parentId)
            until(8_000, "B recibe el resultado en el origen") { b.state.value.conversations[convId]!!.messages.any { it.mergedFrom == child } }
            assertNotNull(a.meta(child)!!.returnedAt)
            log("derivar→devolver", "hija ${child.take(8)} · mergedFrom en el origen en ${System.currentTimeMillis() - t0} ms")

            // 5. Silenciar → no suena (sin Incoming); reactivar → vuelve a sonar.
            b.setConversationPrefs(convId, mutedUntil = Instant.now().plusSeconds(3600).toString())
            until(5_000, "prefs aplicadas") { b.meta(convId)!!.mutedAt(System.currentTimeMillis()) }
            val quiet = "silencio ${UUID.randomUUID().toString().take(4)}"
            a.send(convId, quiet)
            until(5_000, "B recibe el mensaje silenciado") { b.state.value.conversations[convId]!!.messages.any { it.body == quiet } }
            delay(300)
            assertFalse("Silenciada: sin sonido ni notificación", sigB.any { it is ClientSignal.Incoming && it.message.body == quiet })
            b.setConversationPrefs(convId, mutedUntil = null)
            val loud = "sonido ${UUID.randomUUID().toString().take(4)}"
            a.send(convId, loud)
            until(5_000, "Incoming al reactivar") { sigB.any { it is ClientSignal.Incoming && it.message.body == loud } }
            b.setConversationPrefs(convId, pinned = true)
            until(5_000, "fijada arriba (pinnedAt)") { b.meta(convId)!!.pinnedAt != null }
            b.loadBootstrap()
            assertNotNull("El servidor conserva la fijación", b.meta(convId)!!.pinnedAt)
            log("silenciar", "silenciada: 0 avisos · reactivada: aviso recibido · fijada arriba=${b.meta(convId)!!.pinnedAt != null}")

            // 6. Compartir hacia TieComs: mensaje con forwarded (origen detectado).
            val shared = "Texto compartido desde otra app ${UUID.randomUUID().toString().take(4)}"
            a.send(convId, shared, null, ForwardedInfo(source = "whatsapp", author = "Juan"))
            until(5_000, "B recibe el compartido con origen") { b.state.value.conversations[convId]!!.messages.any { it.body == shared && it.forwarded?.source == "whatsapp" && it.forwarded.author == "Juan" } }
            val fwd = "reenvío ${UUID.randomUUID().toString().take(4)}"
            a.send(child, fwd, null, ForwardedInfo("tiecoms", "Ana", Instant.now().toString(), convId))
            until(5_000, "reenvío entre conversaciones") { a.state.value.pending.none { it.body == fwd } }
            log("compartir / reenviar", "forwarded whatsapp·Juan y tiecoms·fromConversationId OK")

            // 7. Recordatorio que vence en 1 min → reminder.due por el socket.
            t0 = System.currentTimeMillis()
            val rem = a.createReminder(convId, baseMsg.id, "llamar", Instant.now().plusSeconds(60))
            val waited = until(110_000, "reminder.due por socket") { sigA.any { it is ClientSignal.ReminderDue && it.reminder.id == rem.id } }
            log("recordatorio", "vence en 60 s → reminder.due a los ${(System.currentTimeMillis() - t0) / 1000.0} s (espera $waited ms)")
            a.snoozeReminder(rem.id, Instant.now().plusSeconds(3600))
            a.completeReminder(rem.id)
            assertTrue(a.loadReminders().none { it.id == rem.id })

            // 8. SSO contra 3041: /start responde de forma controlada (sin credenciales reales en pruebas).
            val ch = Pkce.challenge(Pkce.newVerifier())
            val noRedirect = ok.newBuilder().followRedirects(false).build()
            for (p in SsoProvider.entries) {
                val url = Sso.startUrl(api, p, "dev-jvm-test", ch)
                noRedirect.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    val loc = r.header("location")
                    val bodyText = r.body?.string()?.take(160)
                    log("sso /start ${p.path}", "HTTP ${r.code}${loc?.let { " → ${it.take(80)}" } ?: ""}${if (loc == null) " · $bodyText" else ""}")
                    assertTrue("Respuesta controlada (redirect o error JSON)", r.code in 300..399 || (r.code in 400..599 && bodyText?.contains("\"error\"") == true))
                }
            }
        } finally {
            bg.cancel()
            a.close(); b.close()
        }
    }

    /** Eliminar la cuenta (DELETE /api/v1/account) contra 3042 con una cuenta creada ahí. */
    @Test
    fun eliminarCuentaContra3042() = runBlocking {
        val api = System.getenv("TIECOMS_DELETE_API").orEmpty()
        assumeTrue("Sin TIECOMS_DELETE_API: se omite", api.isNotBlank())
        assertFalse(api.contains("app.tiecoms.com"))
        val tag = UUID.randomUUID().toString().take(6)
        val email = "borrar.$tag@qa.tiecoms.test"
        val password = "Clave-${UUID.randomUUID()}"
        val c = TieComsClient(api, "JVM borrar", MemoryStorage(), MemorySecretStore(), ok)
        try {
            c.signup("Persona Borrable $tag", email, password, "QA Borrado $tag", null, null)
            assertEquals(SessionStatus.READY, c.state.value.status)
            try { c.deleteAccount("otro.$tag@qa.tiecoms.test", password); throw AssertionError("debió fallar") } catch (e: ApiException) { assertEquals(400, e.status) }
            try { c.deleteAccount(email, "incorrecta-123"); throw AssertionError("debió fallar") } catch (e: ApiException) { assertEquals(403, e.status) }
            try { c.deleteAccount(email, null); throw AssertionError("debió fallar") } catch (e: ApiException) { assertEquals("sin contraseña en cuenta con contraseña → 403", 403, e.status) }
            val t0 = System.currentTimeMillis()
            c.deleteAccount(email.uppercase(), password)
            log("eliminar cuenta", "400 correo distinto · 403 contraseña mala · 403 sin contraseña · 200 en ${System.currentTimeMillis() - t0} ms")
            assertEquals(SessionStatus.ANONYMOUS, c.state.value.status)
            try { c.login(email, password); throw AssertionError("no debería poder entrar") } catch (e: ApiException) { assertEquals(401, e.status) }
        } finally { c.close() }
    }
}
