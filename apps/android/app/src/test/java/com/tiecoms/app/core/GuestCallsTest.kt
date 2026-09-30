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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** 1.7.4: invitados por enlace y pantallas compartidas (docs/LLAMADAS.md): decodificación, reglas y API público sin sesión. */
class GuestCallsTest {
    private val stateJson = """{"callId":"k1","kind":"video","active":true,"transcribing":false,"activeUserIds":["u1","u2"],
        "guests":[{"id":"g1","name":"Laura Pérez"}],"names":{"u1":"Ana Gómez","u2":"Beto","guest:g1":"Laura Pérez"},"futuro":true}"""
    private val meeting = """{"Meeting":{"MeetingId":"m-1","ExternalMeetingId":"k1","MediaRegion":"us-east-1","MediaPlacement":{"AudioHostUrl":"a:3478",
        "AudioFallbackUrl":"wss://fb","SignalingUrl":"wss://sig","TurnControlUrl":"https://turn"}}}"""
    private val attendee = """{"Attendee":{"AttendeeId":"att-g","ExternalUserId":"guest:g1","JoinToken":"jt"}}"""

    // ---------- Decodificación ----------
    @Test fun `GuestCallState completo y con faltantes`() {
        val g = TcJson.decodeFromString(GuestCallStateDTO.serializer(), stateJson)
        assertEquals("k1", g.callId); assertTrue(g.active); assertEquals(listOf("u1", "u2"), g.activeUserIds)
        assertEquals(listOf(CallGuestDTO("g1", "Laura Pérez")), g.guests); assertEquals("Laura Pérez", g.names["guest:g1"])
        val bare = TcJson.decodeFromString(GuestCallStateDTO.serializer(), """{"callId":"k2","guests":null,"names":null}""")
        assertFalse(bare.active); assertEquals("audio", bare.kind); assertTrue(bare.guests.isEmpty()); assertTrue(bare.names.isEmpty())
    }

    @Test fun `CallDTO trae los invitados (y un servidor viejo no)`() {
        val c = TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k1","conversationId":"c1","activeUserIds":["u1"],"guests":[{"id":"g1","name":"Laura"},{"id":"g2"}]}""")
        assertEquals(listOf(CallGuestDTO("g1", "Laura"), CallGuestDTO("g2", "")), c.guests)
        assertEquals(listOf("u1", "guest:g1", "guest:g2"), GuestCalls.people(c))
        val old = TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k1","activeUserIds":["u1","u2"]}""")
        assertNull(old.guests); assertEquals(listOf("u1", "u2"), GuestCalls.people(old))
    }

    @Test fun `vista previa y respuesta de entrar`() {
        val p = TcJson.decodeFromString(GuestCallPreviewDTO.serializer(), """{"title":null,"hostName":"Ana","orgName":"Xertify","kind":"video","active":true}""")
        assertNull(p.title); assertEquals("Ana", p.hostName); assertEquals("Xertify", p.orgName); assertTrue(p.active)
        val j = TcJson.decodeFromString(GuestJoinDTO.serializer(), """{"guestId":"g1","secret":"s3cr3t","call":$stateJson,"meeting":$meeting,"attendee":$attendee}""")
        assertEquals("g1", j.guestId); assertEquals("s3cr3t", j.secret)
        val info = ChimeJoin.parse(j.meeting, j.attendee)!!
        assertEquals("guest:g1", info.externalUserId); assertEquals("guest:g1", Calls171.personOf(info.externalUserId))
    }

    // ---------- Reglas ----------
    @Test fun `el estado del invitado con la forma de CallDTO`() {
        val g = TcJson.decodeFromString(GuestCallStateDTO.serializer(), stateJson)
        val c = GuestCalls.toCall(g, nowIso = "2026-09-30T10:00:00Z")
        assertEquals("k1", c.id); assertEquals("", c.conversationId); assertTrue(c.isVideo); assertFalse(c.ended)
        assertEquals("2026-09-30T10:00:00Z", c.startedAt); assertEquals(g.guests, c.guests)
        // El reloj no se reinicia con cada latido; si terminó, queda como terminada.
        val next = GuestCalls.toCall(g.copy(active = false), prev = c, nowIso = "2026-09-30T10:05:00Z")
        assertEquals("2026-09-30T10:00:00Z", next.startedAt); assertTrue(next.ended)
    }

    @Test fun `nombres de invitados e ids`() {
        val c = GuestCalls.toCall(TcJson.decodeFromString(GuestCallStateDTO.serializer(), stateJson))
        assertEquals("guest:g1", GuestCalls.externalId("g1"))
        assertTrue(GuestCalls.isGuest("guest:g1")); assertFalse(GuestCalls.isGuest("u1")); assertFalse(GuestCalls.isGuest(null))
        assertEquals("Laura Pérez", GuestCalls.guestName(c, "guest:g1"))
        assertNull(GuestCalls.guestName(c, "u1"))
        // Un invitado que no está en guests: su nombre de names, o vacío.
        assertEquals("", GuestCalls.guestName(c, "guest:zz"))
        assertEquals("Ana", GuestCalls.guestName(c.copy(guests = null, names = mapOf("guest:g9" to "Ana")), "guest:g9"))
    }

    @Test fun `nombre para entrar`() {
        assertEquals("Laura Pérez", GuestCalls.cleanName("  Laura   Pérez "))
        assertNull(GuestCalls.cleanName("   ")); assertNull(GuestCalls.cleanName(null))
        assertEquals(60, GuestCalls.cleanName("x".repeat(80))!!.length)
    }

    @Test fun `errores del enlace y del latido`() {
        assertEquals(GuestCalls.Problem.INVALID, GuestCalls.problemOf(ApiException(404, "not_found", "no")))
        assertEquals(GuestCalls.Problem.INVALID, GuestCalls.problemOf(ApiException(410, "link_revoked", "")))
        assertEquals(GuestCalls.Problem.ENDED, GuestCalls.problemOf(ApiException(409, "call_ended", "")))
        assertEquals(GuestCalls.Problem.NOT_LIVE, GuestCalls.problemOf(ApiException(409, "call_not_live", "")))
        assertEquals(GuestCalls.Problem.FULL, GuestCalls.problemOf(ApiException(409, "call_full", "")))
        assertEquals(GuestCalls.Problem.OTHER, GuestCalls.problemOf(NetworkException(java.io.IOException("x"))))
        assertTrue(GuestCalls.heartbeatEnds(ApiException(409, "not_in_call", "")))
        assertTrue(GuestCalls.heartbeatEnds(ApiException(404, "not_found", "")))
        assertFalse(GuestCalls.heartbeatEnds(ApiException(500, "internal", "")))
        assertFalse(GuestCalls.heartbeatEnds(NetworkException(java.io.IOException("x"))))
    }

    @Test fun `pantallas compartidas`() {
        assertTrue(GuestCalls.isContentAttendee("att-1#content")); assertFalse(GuestCalls.isContentAttendee("att-1")); assertFalse(GuestCalls.isContentAttendee(null))
        assertTrue(GuestCalls.isMyContent("att-1#content", "att-1")); assertFalse(GuestCalls.isMyContent("att-2#content", "att-1"))
        assertFalse(GuestCalls.isMyContent("att-1#content", null))
        // La persona de una pantalla: la parte antes del primer # (con dispositivo o sin él).
        assertEquals("u1", Calls171.personOf("u1#ab12cd34#content")); assertEquals("guest:g1", Calls171.personOf("guest:g1#content"))
    }

    // ---------- API público (sin sesión) ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                val path = request.path!!.substringBefore('?')
                return when (path) {
                    "/api/v1/call-links/tok1" -> MockResponse().setBody("""{"title":"Obra 12","hostName":"Ana","orgName":"Xertify","kind":"audio","active":true}""")
                    "/api/v1/call-links/tok1/join" -> MockResponse().setBody("""{"guestId":"g1","secret":"s1","call":$stateJson,"meeting":$meeting,"attendee":$attendee}""")
                    "/api/v1/call-links/full/join" -> MockResponse().setResponseCode(409).setBody("""{"error":{"code":"call_full","message":"llena"}}""")
                    "/api/v1/call-guests/g1/heartbeat" -> MockResponse().setBody(stateJson)
                    "/api/v1/call-guests/gone/heartbeat" -> MockResponse().setResponseCode(409).setBody("""{"error":{"code":"not_in_call","message":"no"}}""")
                    "/api/v1/call-guests/g1/leave" -> MockResponse().setBody("""{"ok":true}""")
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
    }

    @After fun tearDown() { client.close(); server.shutdown() }

    private fun last(path: String) = requests.last { it.first.path!!.startsWith(path) }

    @Test fun `vista previa, entrar, latir y salir sin sesion`() = runBlocking {
        val p = client.guestCallPreview("tok1")
        assertEquals("Obra 12", p.title); assertTrue(p.active)
        val get = last("/api/v1/call-links/tok1").first
        assertEquals("GET", get.method); assertEquals("android", get.getHeader("x-tiecoms-client")); assertNull(get.getHeader("authorization"))

        val j = client.guestCallJoin("tok1", "Laura Pérez")
        assertEquals("g1", j.guestId); assertNotNull(ChimeJoin.parse(j.meeting, j.attendee))
        val join = last("/api/v1/call-links/tok1/join")
        assertEquals("POST", join.first.method); assertEquals("Laura Pérez", TcJson.parseToJsonElement(join.second).jsonObject["name"]!!.jsonPrimitive.content)

        val st = client.guestCallHeartbeat("g1", "s1")
        assertEquals(listOf(CallGuestDTO("g1", "Laura Pérez")), st.guests)
        assertEquals("s1", TcJson.parseToJsonElement(last("/api/v1/call-guests/g1/heartbeat").second).jsonObject["secret"]!!.jsonPrimitive.content)

        client.guestCallLeave("g1", "s1")
        val leave = last("/api/v1/call-guests/g1/leave")
        assertEquals("POST", leave.first.method); assertEquals("s1", TcJson.parseToJsonElement(leave.second).jsonObject["secret"]!!.jsonPrimitive.content)
        assertNull(leave.first.getHeader("authorization"))
    }

    @Test fun `errores del API publico`() = runBlocking {
        try { client.guestCallPreview("tokenInvalidoDePrueba123"); fail() } catch (e: ApiException) { assertEquals(GuestCalls.Problem.INVALID, GuestCalls.problemOf(e)) }
        try { client.guestCallJoin("full", "Ana"); fail() } catch (e: ApiException) { assertEquals(GuestCalls.Problem.FULL, GuestCalls.problemOf(e)) }
        try { client.guestCallHeartbeat("gone", "s"); fail() } catch (e: ApiException) { assertTrue(GuestCalls.heartbeatEnds(e)) }
    }
}
