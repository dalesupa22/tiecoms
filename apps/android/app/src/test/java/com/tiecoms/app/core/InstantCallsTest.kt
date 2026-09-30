package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** 1.7.6: «Nueva llamada» rápida con enlace para invitados (POST /calls/instant). */
class InstantCallsTest {
    private val body = """{"call":{"id":"k9","conversationId":"c9","kind":"audio","startedBy":"u1","startedAt":"2026-09-30T10:00:00Z",
        "activeUserIds":["u1"],"guests":[{"id":"g1","name":"Laura","email":"laura@acme.co"},{"id":"g2","name":"Beto"}],"title":"Llamada de Ana"},
        "conversationId":"c9","link":{"url":"https://app.chaggu.com/llamada/tok9","token":"tok9"},"futuro":1}"""

    // ---------- Decodificación del contrato ----------
    @Test fun `respuesta de calls instant con y sin email en los invitados`() {
        val r = TcJson.decodeFromString(InstantCallDTO.serializer(), body)
        assertEquals("c9", r.conversationId); assertEquals("k9", r.call.id); assertEquals("tok9", r.link.token)
        assertEquals("https://app.chaggu.com/llamada/tok9", InstantCalls.linkUrl(r))
        assertEquals(CallGuestDTO("g1", "Laura", "laura@acme.co"), r.call.guests!![0])
        assertNull(r.call.guests!![1].email)
        assertEquals("laura@acme.co", GuestCalls.guestEmail(r.call, "guest:g1"))
        assertNull(GuestCalls.guestEmail(r.call, "guest:g2")); assertNull(GuestCalls.guestEmail(r.call, "u1"))
        // Servidor 1.7.4: invitados sin email; email null o vacío también se toleran.
        val old = TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k1","guests":[{"id":"g1","name":"Laura"},{"id":"g2","name":"B","email":null},{"id":"g3","email":"  "}]}""")
        assertEquals(listOf(null, null, "  "), old.guests!!.map { it.email })
        assertNull(GuestCalls.guestEmail(old, "guest:g1")); assertNull(GuestCalls.guestEmail(old, "guest:g3"))
        assertEquals("Laura", GuestCalls.guestName(old, "guest:g1"))
    }

    @Test fun `respuesta incompleta se arma con lo que haya`() {
        val r = TcJson.decodeFromString(InstantCallDTO.serializer(), """{"call":{"id":"k1","conversationId":"c1"},"link":{"token":"a b"}}""")
        assertEquals("c1", InstantCalls.conversationOf(r))
        assertEquals("https://app.chaggu.com/llamada/a+b", InstantCalls.linkUrl(r))
        val http = TcJson.decodeFromString(InstantCallDTO.serializer(), """{"conversationId":"c2","link":{"url":"http://x/llamada/t","token":"t"}}""")
        assertEquals("https://app.chaggu.com/llamada/t", InstantCalls.linkUrl(http))
        assertNull(InstantCalls.linkUrl(TcJson.decodeFromString(InstantCallDTO.serializer(), "{}")))
    }

    @Test fun `titulo y correo del invitado`() {
        assertNull(InstantCalls.cleanTitle("   ")); assertNull(InstantCalls.cleanTitle(null))
        assertEquals("Obra 12 con Acme", InstantCalls.cleanTitle("  Obra  12   con Acme "))
        assertEquals(InstantCalls.TITLE_MAX, InstantCalls.cleanTitle("x".repeat(300))!!.length)
        assertEquals("laura@acme.co", GuestCalls.cleanEmail("  Laura@Acme.CO "))
        assertNull(GuestCalls.cleanEmail("laura")); assertNull(GuestCalls.cleanEmail("laura@acme")); assertNull(GuestCalls.cleanEmail("la ura@acme.co")); assertNull(GuestCalls.cleanEmail(null))
    }

    // ---------- Texto para compartir (el de strings.xml, es y en) ----------
    private fun template(dir: String): String {
        val f = listOf("src/main/res/$dir/strings_instant.xml", "app/src/main/res/$dir/strings_instant.xml").map(::File).first { it.exists() }
        val m = Regex("""<string name="call_instant_share_text">(.*?)</string>""").find(f.readText())!!
        return m.groupValues[1]
    }

    @Test fun `texto sugerido para compartir`() {
        val url = "https://app.chaggu.com/llamada/tok9"
        assertEquals("Únete a mi llamada en chaggu: $url. Solo necesitas tu nombre y correo", InstantCalls.shareText(template("values-es"), url))
        assertEquals("Join my call on chaggu: $url. You only need your name and email", InstantCalls.shareText(template("values"), url))
        assertEquals("A $url", InstantCalls.shareText(" A %1\$s ", url))
    }

    // ---------- API ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient
    @Volatile private var instantCode = 201

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                return when (request.path!!.substringBefore('?')) {
                    "/api/v1/calls/instant" ->
                        if (instantCode == 201) MockResponse().setResponseCode(201).setBody(body)
                        else MockResponse().setResponseCode(instantCode).setBody("""{"error":{"code":"not_found","message":"Not found"}}""")
                    "/api/v1/call-links/tok9/join" -> MockResponse().setResponseCode(409).setBody("""{"error":{"code":"call_not_live","message":"no"}}""")
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
    }

    @After fun tearDown() { client.close(); server.shutdown() }

    @Test fun `POST calls instant manda titulo y video y guarda la llamada`() = runBlocking {
        val r = client.startInstantCall("  Obra 12 ", video = true)
        assertEquals("c9", r.conversationId)
        val (req, sent) = requests.last { it.first.path!!.startsWith("/api/v1/calls/instant") }
        assertEquals("POST", req.method)
        val j = TcJson.parseToJsonElement(sent).jsonObject
        assertEquals("Obra 12", j["title"]!!.jsonPrimitive.content); assertEquals(true, j["video"]!!.jsonPrimitive.booleanOrNull)
        assertEquals("k9", client.state.value.calls["c9"]?.id)

        client.startInstantCall("   ", video = false)
        val j2 = TcJson.parseToJsonElement(requests.last().second).jsonObject
        assertFalse(j2.containsKey("title")); assertEquals(false, j2["video"]!!.jsonPrimitive.booleanOrNull)
    }

    @Test fun `404 es servidor sin llamadas rapidas`() = runBlocking {
        instantCode = 404
        try { client.startInstantCall(null, false); fail() } catch (e: ApiException) {
            assertEquals(404, e.status); assertTrue(InstantCalls.unsupported(e))
        }
        assertTrue(client.state.value.calls.isEmpty())
        // Otros errores no son «actualiza pronto».
        assertFalse(InstantCalls.unsupported(ApiException(403, "forbidden", "")))
        assertFalse(InstantCalls.unsupported(ApiException(500, "internal", "")))
        assertFalse(InstantCalls.unsupported(NetworkException(java.io.IOException("x"))))
    }

    @Test fun `el invitado entra con nombre y correo`() = runBlocking {
        try { client.guestCallJoin("tok9", "Laura", "laura@acme.co"); fail() } catch (_: ApiException) { }
        val j = TcJson.parseToJsonElement(requests.last().second).jsonObject
        assertEquals("Laura", j["name"]!!.jsonPrimitive.content); assertEquals("laura@acme.co", j["email"]!!.jsonPrimitive.content)
        try { client.guestCallJoin("tok9", "Laura"); fail() } catch (_: ApiException) { }
        assertFalse(TcJson.parseToJsonElement(requests.last().second).jsonObject.containsKey("email"))
    }
}
