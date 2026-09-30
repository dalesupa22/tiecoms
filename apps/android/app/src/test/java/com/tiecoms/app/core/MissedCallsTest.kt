package com.tiecoms.app.core

import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Llamadas perdidas (migración 042): `missedCalls` del bootstrap, `calls.missed`, POST /calls/seen y «Perdida» en el historial. */
class MissedCallsTest {
    private fun acc(json: String) = decodeAccountEvent(TcJson.parseToJsonElement(json))

    @Test fun `decodifica missedCalls del bootstrap y el historial`() {
        val b = TcJson.decodeFromString(BootstrapDTO.serializer(), """{"me":{"id":"u1"},"missedCalls":3}""")
        assertEquals(3, b.missedCalls)
        // Servidor anterior: sin el campo = 0.
        assertEquals(0, TcJson.decodeFromString(BootstrapDTO.serializer(), """{"me":{"id":"u1"}}""").missedCalls)
        val page = TcJson.decodeFromString(CallHistoryPage.serializer(),
            """{"calls":[{"call":{"id":"k1","conversationId":"c1","endedAt":"2026-09-30T00:00:00Z"},"participantIds":["u2"],"missed":true},
                        {"call":{"id":"k2","conversationId":"c1","endedAt":"2026-09-30T00:00:00Z"},"participantIds":["u1"]}]}""")
        assertTrue(Calls.isMissedByMe(page.calls[0]))
        assertFalse(Calls.isMissedByMe(page.calls[1]))
        assertTrue(Calls.isMissed(page.calls[1])) // «Sin respuesta» sigue para las que no son mías
    }

    @Test fun `decodifica calls missed con y sin callId`() {
        assertEquals(AccountEvent.CallsMissed("k1", 2), acc("""{"type":"calls.missed","callId":"k1","missedCalls":2}"""))
        // Abrí Llamadas en otro dispositivo: callId null y 0.
        assertEquals(AccountEvent.CallsMissed(null, 0), acc("""{"type":"calls.missed","callId":null,"missedCalls":0}"""))
        assertEquals(AccountEvent.CallsMissed(null, 1), acc("""{"type":"calls.missed","missedCalls":1}"""))
        assertTrue(acc("""{"type":"calls.missed","callId":"k1"}""") is AccountEvent.Unknown)
    }

    @Test fun `el numero se reemplaza, no se suma`() {
        val d = BootstrapDTO(missedCalls = 2)
        assertEquals(5, Calls.withMissed(d, 5).missedCalls)
        assertEquals(1, Calls.withMissed(Calls.withMissed(d, 3), 1).missedCalls)
        assertEquals(0, Calls.withMissed(d, 0).missedCalls)
        assertEquals(0, Calls.withMissed(d, -4).missedCalls)
        assertSame("sin cambio no hay copia", d, Calls.withMissed(d, 2))
    }

    @Test fun `el push de llamada perdida trae callMissed`() {
        val p = PushPayload.parse(mapOf("type" to "message", "conversationId" to "c1", "callMissed" to "k1", "body" to "📞 Llamada perdida"))!!
        assertEquals("k1", p.callMissed)
        assertNull(PushPayload.parse(mapOf("type" to "message", "conversationId" to "c1"))!!.callMissed)
    }

    // ---------- API ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient
    @Volatile private var seenStatus = 200

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                val body = when (request.path!!.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana"},"conversations":[],"features":{"calls":true},"missedCalls":2}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/calls/seen" -> if (seenStatus == 200) """{"missedCalls":0}"""
                        else return MockResponse().setResponseCode(seenStatus).setBody("""{"error":{"code":"boom","message":"no"}}""")
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

    @Test fun `abrir Llamadas llama a calls seen y pone 0`() = runBlocking {
        if (client.state.value.data?.missedCalls != 2) client.loadBootstrap()
        assertEquals(2, client.state.value.data!!.missedCalls)
        client.markCallsSeen()
        assertEquals(0, client.state.value.data!!.missedCalls)
        val seen = requests.last { it.first.path == "/api/v1/calls/seen" }
        assertEquals("POST", seen.first.method)
        assertEquals("{}", seen.second)
    }

    @Test fun `un error de calls seen se ignora y el numero queda en 0`() = runBlocking {
        if (client.state.value.data?.missedCalls != 2) client.loadBootstrap()
        seenStatus = 500
        client.markCallsSeen() // no lanza
        assertEquals(0, client.state.value.data!!.missedCalls)
        assertTrue(requests.any { it.first.path == "/api/v1/calls/seen" })
    }

    @Test fun `cancelar a quien llamo no corta el POST`() = runBlocking {
        if (client.state.value.data?.missedCalls != 2) client.loadBootstrap()
        // Como la pestaña: poner 0 cambia la clave del LaunchedEffect y lo cancela en seguida.
        val job = launch(kotlinx.coroutines.Dispatchers.IO) { client.markCallsSeen() }
        while (client.state.value.data!!.missedCalls != 0) kotlinx.coroutines.delay(1)
        job.cancel(); job.join()
        assertTrue("el POST llegó al servidor", requests.any { it.first.path == "/api/v1/calls/seen" })
    }
}
