package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** gg propone, la persona confirma (2-oct-2026): borradores de reunión/correo y envío con clave. Contrato: apps/api/src/modules/gg-actions.ts. */
class GgActionsContractTest {
    private fun withServer(routes: Map<String, String>, block: suspend (TieComsClient, List<RecordedRequest>, List<String>) -> Unit) = runBlocking {
        val calls = CopyOnWriteArrayList<RecordedRequest>(); val bodies = CopyOnWriteArrayList<String>()
        val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when (path) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"fixture","user":{"id":"me"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"me"},"conversations":[{"id":"c","kind":"group"}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    else -> routes[path]?.also { calls += r; bodies += r.body.readUtf8() } ?: return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        } }
        server.start()
        val client = TieComsClient(server.url("/").toString().trimEnd('/'), "gg actions fixture", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        try { client.login("qa@example.test", "fixture"); block(client, calls, bodies) } finally { client.close(); server.shutdown() }
    }

    @Test fun `meeting draft parses and sends source with picked messages`() = withServer(mapOf(
        "/api/v1/gg/meeting-draft" to """{"title":"Revisión contrato","durationMin":45,"attendeeEmails":["ana@cliente.co"],"invitees":[{"id":"u1","name":"Luis Pérez"}],"missingPeople":["Marta"],"links":["https://docs.example/x"],"description":"Revisar.\n\nEnlaces:\n- https://docs.example/x","extra":1}""",
    )) { client, calls, bodies ->
        val d = client.ggMeetingDraft("c:c", listOf("m1", "m2", "m1"), "  para el lunes ")
        assertEquals("Revisión contrato", d.title); assertEquals(45, d.durationMin)
        assertEquals(listOf("ana@cliente.co"), d.attendeeEmails); assertEquals(GgInviteeDTO("u1", "Luis Pérez"), d.invitees.single())
        assertEquals(listOf("Marta"), d.missingPeople); assertEquals(listOf("https://docs.example/x"), d.links); assertTrue(d.description.contains("Enlaces"))
        assertEquals("POST", calls.single().method)
        val sent = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("c:c", sent["source"]!!.jsonPrimitive.content)
        assertEquals(listOf("m1", "m2"), sent["messageIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("para el lunes", sent["instruction"]!!.jsonPrimitive.content)
        // Sin mensajes elegidos ni instrucción, solo la fuente.
        client.ggMeetingDraft("c:c", emptyList())
        assertEquals(setOf("source"), Json.parseToJsonElement(bodies.last()).jsonObject.keys)
    }

    @Test fun `meeting draft tolerates missing fields`() {
        val d = TcJson.decodeFromString(GgMeetingDraft.serializer(), """{"title":"Solo título"}""")
        assertEquals(30, d.durationMin); assertTrue(d.invitees.isEmpty() && d.attendeeEmails.isEmpty() && d.links.isEmpty())
        assertEquals(15, GgMail.duration(5)); assertEquals(240, GgMail.duration(600)); assertEquals(45, GgMail.duration(45))
    }

    @Test fun `mail draft parses ready and needs connect`() = withServer(mapOf(
        "/api/v1/gg/mail-draft" to """{"provider":"google","from":"yo@empresa.co","status":"ready","to":["ana@cliente.co"],"cc":[],"missingPeople":["Luis"],"subject":"Propuesta","body":"Hola Ana"}""",
    )) { client, _, bodies ->
        val d = client.ggMailDraft("c:c", listOf("m9"))
        assertTrue(d.ready); assertEquals("yo@empresa.co", d.from); assertEquals(listOf("ana@cliente.co"), d.to)
        assertEquals(listOf("Luis"), d.missingPeople); assertEquals("Propuesta", d.subject); assertEquals("Hola Ana", d.body)
        assertEquals(listOf("m9"), Json.parseToJsonElement(bodies.single()).jsonObject["messageIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        val off = TcJson.decodeFromString(GgMailDraft.serializer(), """{"provider":null,"from":null,"status":"needs_connect","to":[],"cc":[],"missingPeople":[],"subject":"x","body":"y"}""")
        assertFalse(off.ready); assertNull(off.from)
    }

    @Test fun `mail send posts exactly the reviewed fields and same key twice is the same body`() = withServer(mapOf(
        "/api/v1/gg/mail-send" to """{"ok":true,"already":false}""",
    )) { client, calls, bodies ->
        val key = GgMail.Key()
        val to = GgMail.parse("Ana@Cliente.co, ana@cliente.co; luis@socio.co"); val cc = GgMail.parse("jefe@empresa.co")
        val k1 = key.forContent(to, cc, " Propuesta ", "Hola\n")
        val r = client.ggMailSend("c:c", "google", k1, to, cc, " Propuesta ", "Hola\n")
        assertTrue(r.ok); assertFalse(r.already)
        val first = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals(setOf("source", "provider", "idempotencyKey", "to", "cc", "subject", "body"), first.keys)
        assertEquals("c:c", first["source"]!!.jsonPrimitive.content); assertEquals("google", first["provider"]!!.jsonPrimitive.content)
        assertEquals(k1, first["idempotencyKey"]!!.jsonPrimitive.content)
        assertEquals(listOf("ana@cliente.co", "luis@socio.co"), first["to"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("jefe@empresa.co"), first["cc"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("Propuesta", first["subject"]!!.jsonPrimitive.content); assertEquals("Hola", first["body"]!!.jsonPrimitive.content)
        // Un segundo toque sin cambios: misma clave y exactamente el mismo cuerpo (el servidor responde already).
        val k2 = key.forContent(to, cc, " Propuesta ", "Hola\n")
        assertEquals(k1, k2)
        client.ggMailSend("c:c", "google", k2, to, cc, " Propuesta ", "Hola\n")
        assertEquals(2, calls.size); assertEquals(bodies[0], bodies[1])
        // Si se edita algo, es otro correo: otra clave.
        val k3 = key.forContent(to, cc, "Propuesta v2", "Hola")
        assertNotEquals(k1, k3)
        assertEquals(k3, key.forContent(to, cc, "Propuesta v2", "Hola"))
        key.reset(); assertNotEquals(k3, key.forContent(to, cc, "Propuesta v2", "Hola"))
    }

    @Test fun `mail send surfaces connect required`() = runBlocking {
        val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse = when (r.requestUrl!!.encodedPath) {
                "$AUTH_BASE_PATH/login" -> MockResponse().setBody("""{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"fixture","user":{"id":"me"}}""")
                "/api/v1/bootstrap" -> MockResponse().setBody("""{"me":{"id":"me"},"conversations":[]}""")
                "/api/v1/blocks" -> MockResponse().setBody("""{"userIds":[]}""")
                "/api/v1/gg/mail-send" -> MockResponse().setResponseCode(409).setBody("""{"error":{"code":"mail_connect_required","message":"Conecta tu correo (Gmail u Outlook) para enviar desde chaggu"}}""")
                else -> MockResponse().setResponseCode(404).setBody("{}")
            }
        } }
        server.start()
        val client = TieComsClient(server.url("/").toString().trimEnd('/'), "gg actions fixture", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        try {
            client.login("qa@example.test", "fixture")
            val e = try { client.ggMailSend("c:c", "google", "k-12345678", listOf("a@b.co"), emptyList(), "s", "b"); null } catch (x: ApiException) { x }
            assertEquals(409, e!!.status); assertEquals("mail_connect_required", e.code)
        } finally { client.close(); server.shutdown() }
    }

    @Test fun `email rules`() {
        assertEquals(listOf("a@b.co", "c@d.co"), GgMail.parse(" A@B.co ;c@d.co\n a@b.co "))
        assertTrue(GgMail.valid("ana@cliente.co")); assertFalse(GgMail.valid("Luis")); assertFalse(GgMail.valid("a@b")); assertFalse(GgMail.valid("a b@c.co"))
        assertEquals(listOf("Luis"), GgMail.invalid(listOf("ana@cliente.co", "Luis")))
    }
}
