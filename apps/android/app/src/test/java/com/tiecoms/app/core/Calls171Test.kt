package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
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
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Llamadas 1.7.1 (contratos d4c56b5): varios dispositivos, contestar en otro, franja, en curso, altavoz e invitados. */
class Calls171Test {
    private fun call(id: String = "k1", conv: String = "c1", devices: List<CallDeviceDTO>? = null, active: List<String> = listOf("u1", "u2"), ended: String? = null) =
        CallDTO(id = id, conversationId = conv, activeUserIds = active, myDevices = devices, endedAt = ended)

    @Test fun `la persona sale de externalUserId sin el dispositivo`() {
        assertEquals("u1", Calls171.personOf("u1#ab12cd34"))
        assertEquals("u1", Calls171.personOf("u1"))
        assertNull(Calls171.personOf("")); assertNull(Calls171.personOf(null))
        assertEquals("abcdef12", Calls171.keyOf("abcdef12-3456-7890"))
        // Los subtítulos también usan la persona.
        val caps = Calls.mergeCaption(emptyList(), TranscriptPiece("r", false, "hola", "a", "u2#x1y2z3w4", "es", 0, 1))
        assertEquals("u2", caps.single().userId)
    }

    @Test fun `DTOs y eventos nuevos`() {
        val c = TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k","conversationId":"c","myDevices":[{"deviceKey":"ab12cd34","platform":"ios","label":"iPhone"}]}""")
        assertEquals("iPhone", c.myDevices!!.single().label)
        assertNull(TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k"}""").myDevices)
        val b = TcJson.decodeFromString(BootstrapDTO.serializer(), """{"me":{"id":"u1"},"myActiveCall":{"id":"k","conversationId":"c"}}""")
        assertEquals("k", b.myActiveCall!!.id)
        val a = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"call.answered","callId":"k","conversationId":"c","deviceKey":"ab12cd34","platform":"ios","label":"iPhone"}"""))
        assertEquals(AccountEvent.CallElsewhere(CallElsewhere("k", true, "ab12cd34", "ios", "iPhone")), a)
        val d = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"call.declined","callId":"k","conversationId":"c"}"""))
        assertEquals(AccountEvent.CallElsewhere(CallElsewhere("k", false)), d)
        assertEquals("2026-09-29.1", CONTRACT_VERSION)
    }

    @Test fun `el call updated de la conversacion no borra mis dispositivos`() {
        val mine = listOf(CallDeviceDTO("ab12cd34", "ios", "iPhone"))
        var m = Calls.put(emptyMap(), call(devices = mine))
        m = Calls.put(m, call(devices = null, active = listOf("u1", "u2", "u3")))
        assertEquals(mine, m["c1"]!!.myDevices)
        assertEquals(3, m["c1"]!!.activeUserIds.size)
        m = Calls.put(m, call(devices = emptyList()))
        assertEquals(emptyList<CallDeviceDTO>(), m["c1"]!!.myDevices)
    }

    @Test fun `franja en llamada en otro dispositivo`() {
        val me = setOf("zz99yy88")
        val iphone = CallDeviceDTO("ab12cd34", "ios", "")
        val calls = mapOf<String, CallDTO?>("c1" to call(devices = listOf(iphone)))
        assertEquals("k1", Calls171.elsewhere(null, calls, null, me)?.id)
        // Ya estoy aquí (o solo este dispositivo está dentro): nada.
        assertNull(Calls171.elsewhere(null, calls, "k1", me))
        assertNull(Calls171.elsewhere(null, mapOf("c1" to call(devices = listOf(CallDeviceDTO("zz99yy88")))), null, me))
        // Del bootstrap, salvo que el socket ya la dio por terminada.
        assertEquals("k2", Calls171.elsewhere(call("k2", "c2", listOf(iphone)), emptyMap(), null, me)?.id)
        assertNull(Calls171.elsewhere(call("k2", "c2", listOf(iphone)), mapOf("c2" to null), null, me))
        assertEquals("iPhone", Calls171.deviceName(iphone, "iPhone", "Android", "navegador", "computador", "otro"))
        assertEquals("Mi Mac", Calls171.deviceName(CallDeviceDTO("x", "desktop", "Mi Mac"), "iPhone", "Android", "navegador", "computador", "otro"))
    }

    @Test fun `llamadas en curso`() {
        val el = TcJson.parseToJsonElement("""{"calls":[{"call":{"id":"k1","conversationId":"c1","activeUserIds":["u2"]},"title":"Ventas"},
            {"call":{"id":"k2","conversationId":"c2","endedAt":"2026-09-29T10:00:00Z"},"title":null},{"id":"k3","conversationId":"c3"}]}""")
        val list = Calls171.decodeActive(el)
        assertEquals(listOf("k1", "k3"), list.map { it.id })
        assertEquals("Ventas", list.first().title)
    }

    @Test fun `salida de audio`() {
        val R = Calls171.Route.entries
        assertEquals(Calls171.Route.EARPIECE, Calls171.defaultRoute(listOf(Calls171.Route.EARPIECE, Calls171.Route.SPEAKER), video = false))
        assertEquals(Calls171.Route.SPEAKER, Calls171.defaultRoute(listOf(Calls171.Route.EARPIECE, Calls171.Route.SPEAKER), video = true))
        assertEquals(Calls171.Route.BLUETOOTH, Calls171.defaultRoute(R, video = true))
        assertEquals(Calls171.Route.WIRED, Calls171.defaultRoute(listOf(Calls171.Route.EARPIECE, Calls171.Route.SPEAKER, Calls171.Route.WIRED), video = false))
        assertFalse(Calls171.needsPicker(listOf(Calls171.Route.EARPIECE, Calls171.Route.SPEAKER)))
        assertTrue(Calls171.needsPicker(listOf(Calls171.Route.SPEAKER, Calls171.Route.BLUETOOTH)))
        assertEquals(Calls171.Route.SPEAKER, Calls171.toggle(Calls171.Route.EARPIECE, R))
        assertEquals(Calls171.Route.EARPIECE, Calls171.toggle(Calls171.Route.SPEAKER, R))
        assertEquals(R, Calls171.choices(R.reversed()))
    }

    @Test fun `invitados llamando y no contesto`() {
        val c = CallDTO(id = "k", activeUserIds = listOf("u1"), invitedUserIds = listOf("u5", "u6"))
        val t = Calls171Invites.track(emptyMap(), c, 1000)
        assertEquals(mapOf("u5" to 1000L, "u6" to 1000L), t)
        // Entró u5: sale; u6 conserva su hora.
        val t2 = Calls171Invites.track(t, c.copy(activeUserIds = listOf("u1", "u5")), 5000)
        assertEquals(mapOf("u6" to 1000L), t2)
        // Con CallDTO.invited (servidor 1.7.1) manda el servidor: su hora y si ya entró.
        val at = java.time.Instant.parse("2026-09-29T15:00:00Z").toEpochMilli()
        val srv = c.copy(invited = listOf(CallInviteDTO("u5", "2026-09-29T15:00:00Z", joined = false), CallInviteDTO("u6", "2026-09-29T15:00:00Z", joined = true)))
        assertEquals(mapOf("u5" to at), Calls171Invites.track(emptyMap(), srv, at + 10_000))
        assertEquals(Calls171Invites.State.NO_ANSWER, Calls171Invites.state(at, at + 46_000))
        assertEquals(Calls171Invites.State.CALLING, Calls171Invites.state(1000, 1000 + 44_000))
        assertEquals(Calls171Invites.State.NO_ANSWER, Calls171Invites.state(1000, 1000 + 45_000))
    }

    // ---------- API ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                val body = when (request.path!!.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana"},"conversations":[],"myActiveCall":{"id":"k1","conversationId":"c1","activeUserIds":["u1"],"myDevices":[{"deviceKey":"ab12cd34","platform":"ios","label":"iPhone"}]}}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/calls/active" -> """{"calls":[{"call":{"id":"k1","conversationId":"c1","activeUserIds":["u1"]},"title":"Ventas"}]}"""
                    "/api/v1/calls/k1/decline" -> """{}"""
                    "/api/v1/calls/k1/leave", "/api/v1/calls/k1/join" -> """{"call":{"id":"k1","conversationId":"c1","activeUserIds":["u1"]}}"""
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { client.login("ana@acme.co", "x") }
    }
    @After fun tearDown() { client.close(); server.shutdown() }

    @Test fun `rechazar, pasar aqui, en curso y la clave del dispositivo`() = runBlocking {
        // El bootstrap trae la llamada en la que estoy en el iPhone: sale en el estado con myDevices.
        assertEquals("iPhone", client.state.value.calls["c1"]!!.myDevices!!.single().label)
        assertEquals("k1", Calls171.elsewhere(client.state.value.data!!.myActiveCall, client.state.value.calls, null, client.myDeviceKeys())?.id)
        client.declineCall("k1")
        assertTrue(requests.any { it.first.method == "POST" && it.first.path == "/api/v1/calls/k1/decline" })
        client.leaveCallDevice("k1", "ab12cd34")
        val leave = requests.last { it.first.path == "/api/v1/calls/k1/leave" }.second
        assertEquals("ab12cd34", TcJson.parseToJsonElement(leave).jsonObject["deviceKey"]!!.jsonPrimitive.content)
        runCatching { client.joinCall("k1") }
        val join = requests.last { it.first.path == "/api/v1/calls/k1/join" }.second
        val key = TcJson.parseToJsonElement(join).jsonObject["deviceKey"]!!.jsonPrimitive.content
        assertEquals(client.myDeviceKey(), key)
        assertEquals(8, key.length)
        assertTrue(key.matches(Regex("^[A-Za-z0-9_-]{1,16}$")))
        assertEquals("Ventas", client.activeCalls().single().title)
    }
}
