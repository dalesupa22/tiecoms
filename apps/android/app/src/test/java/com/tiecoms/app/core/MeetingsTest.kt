package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

/** Reuniones con Meet, Teams o Zoom (docs/TANDA-LECTURA-REUNIONES.md §4). Todo contra un servidor simulado. */
class MeetingsTest {
    @Test fun `vuelta de conectar por el deep link`() {
        assertEquals(Meetings.Return.Connected("google"), Meetings.parseReturn("chaggu://meetings/connected?provider=google&connected=1"))
        val c = Meetings.parseReturn("chaggu://meetings/connected?provider=microsoft&error=cancelled") as Meetings.Return.Failed
        assertEquals("microsoft", c.provider); assertTrue(c.cancelled)
        val d = Meetings.parseReturn("chaggu://meetings/connected?provider=zoom&error=invalid_grant") as Meetings.Return.Failed
        assertFalse(d.cancelled); assertEquals("invalid_grant", d.error)
        // Proveedor desconocido: no se inventa uno.
        assertNull(Meetings.parseReturn("chaggu://meetings/connected?provider=evil&connected=1")!!.provider)
        assertNull(Meetings.parseReturn("chaggu://c/abc"))
        assertNull(Meetings.parseReturn("https://app.chaggu.com/meetings/connected?connected=1"))
        assertNull(Meetings.parseReturn("chaggu://meetings/otra"))
        // El router de enlaces no la trata como destino.
        assertNull(DeepLinks.parse("chaggu://meetings/connected?provider=google&connected=1"))
    }

    @Test fun `errores del contrato a motivos`() {
        assertEquals(Meetings.Problem.NotConnected, Meetings.problem(ApiException(409, "not_connected", "x")))
        assertEquals(Meetings.Problem.Reconnect, Meetings.problem(ApiException(409, "reconnect_required", "x")))
        assertEquals(Meetings.Problem.NoTeams, Meetings.problem(ApiException(409, "no_teams", "x")))
        assertEquals(Meetings.Problem.Unavailable("Falta ZOOM_CLIENT_ID"), Meetings.problem(ApiException(503, "provider_unavailable", "Falta ZOOM_CLIENT_ID")))
        assertEquals(Meetings.Problem.Provider("Google Meet: caído"), Meetings.problem(ApiException(502, "google_failed", "Google Meet: caído")))
        assertEquals(Meetings.Problem.Network, Meetings.problem(ApiException(502, "provider_unreachable", "no respondió")))
        assertEquals(Meetings.Problem.Network, Meetings.problem(NetworkException(java.io.IOException("reset"))))
        assertEquals(Meetings.Problem.InProgress, Meetings.problem(ApiException(409, "meeting_in_progress", "x")))
        assertTrue(Meetings.retryable(Meetings.Problem.Network)); assertFalse(Meetings.retryable(Meetings.Problem.NotConnected))
    }

    @Test fun `idempotencia - una llave por toque, la misma en el reintento, nunca dos a la vez`() {
        var n = 0
        val a = MeetingAttempt { "k${++n}" }
        val k1 = a.begin()
        assertEquals("k1", k1)
        assertNull("doble toque mientras crea: se ignora", a.begin())
        a.failed()
        assertEquals("reintento con la misma llave", "k1", a.begin())
        a.failed()
        assertEquals("k1", a.begin())
        a.succeeded()
        assertNull(a.pendingKey)
        assertEquals("otra reunión, otra llave", "k2", a.begin())
        a.reset()
        assertEquals("mientras crea, cambiar el formulario no suelta la llave", "k2", a.pendingKey)
        a.failed(); a.reset()
        assertEquals("tras un fallo, cambiar el formulario es otra reunión", "k3", a.begin())
        a.failed(keepKey = false)
        assertEquals("sin Teams o sin permiso: repetir la llave daría lo mismo, el siguiente es otro", "k4", a.begin())
        // Con UUID por defecto.
        val u = MeetingAttempt().begin()!!
        assertEquals(36, u.length)
    }

    @Test fun `enlaces de video y proveedor por defecto`() {
        assertTrue(Meetings.isVideoLink("https://meet.google.com/abc-defg-hij"))
        assertTrue(Meetings.isVideoLink("https://teams.microsoft.com/l/meetup-join/x"))
        assertTrue(Meetings.isVideoLink("https://us02web.zoom.us/j/123"))
        assertTrue(Meetings.isVideoLink(" https://zoom.us/j/9 "))
        assertFalse(Meetings.isVideoLink("Sala 3"))
        assertFalse(Meetings.isVideoLink("https://evil.com/meet.google.com"))
        assertFalse(Meetings.isVideoLink(null))
        val list = listOf(MeetingConnectionDTO("google", "Google Meet", true, null, "none"), MeetingConnectionDTO("microsoft", "Microsoft Teams", true, null, "active", "a@b.co"),
            MeetingConnectionDTO("zoom", "Zoom", false, "Falta ZOOM_CLIENT_ID", "none"))
        assertEquals("microsoft", Meetings.defaultProvider(list, null))
        assertEquals("microsoft", Meetings.defaultProvider(list, "zoom"))
        assertNull(Meetings.defaultProvider(list.take(1), null))
        assertEquals("Teams", Meetings.appName("microsoft")); assertEquals("Meet", Meetings.appName("google")); assertEquals("Zoom", Meetings.appName("zoom"))
        val m = TcJson.decodeFromString(MeetingDTO.serializer(), """{"id":"m","provider":"google","status":"created","joinUrl":"http://x","messageId":null}""")
        assertNull("solo https cuenta como enlace", m.usableUrl); assertFalse(m.shared)
    }

    private var server: MockWebServer? = null
    @After fun tearDown() { server?.shutdown() }

    @Test fun `crear, reintentar con la misma llave, conectar y desconectar contra el contrato`() = runBlocking {
        val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
        var creates = 0
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8(); requests += request to body
                val path = request.path!!.substringBefore('?')
                return when {
                    path == "$AUTH_BASE_PATH/login" -> MockResponse().setBody("""{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}""")
                    path == "/api/v1/bootstrap" -> MockResponse().setBody("""{"me":{"id":"u1","name":"Ana"},"conversations":[{"id":"c1","kind":"group","name":"General","memberIds":["u1"]}]}""")
                    path == "/api/v1/blocks" -> MockResponse().setBody("""{"userIds":[]}""")
                    path == "/api/v1/reminders" -> MockResponse().setBody("""{"reminders":[]}""")
                    path == "/api/v1/scheduled" -> MockResponse().setBody("""{"scheduled":[]}""")
                    path == "/api/v1/issues" -> MockResponse().setBody("""{"issues":[]}""")
                    path == "/api/v1/meetings/connections" -> MockResponse().setBody("""{"connections":[{"provider":"google","label":"Google Meet","available":true,"unavailableReason":null,"status":"active","accountEmail":"mock.google@example.com"},""" +
                        """{"provider":"zoom","label":"Zoom","available":false,"unavailableReason":"Falta ZOOM_CLIENT_ID","status":"none","accountEmail":null}]}""")
                    path == "/api/v1/meetings/connect/google" -> MockResponse().setBody("""{"url":"https://accounts.google.com/o/oauth2/v2/auth?state=mtg_x"}""")
                    path == "/api/v1/meetings/connect/zoom" -> MockResponse().setResponseCode(503).setBody("""{"error":{"code":"provider_unavailable","message":"Falta ZOOM_CLIENT_ID"}}""")
                    path == "/api/v1/meetings/connections/google" -> MockResponse().setBody("""{"ok":true}""")
                    path == "/api/v1/meetings" -> {
                        creates++
                        // El primer intento se corta después de que el servidor la creó (se perdió la respuesta).
                        if (creates == 1) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        else MockResponse().setBody("""{"id":"m1","provider":"google","status":"created","title":"Reunión · General","startsAt":"2026-09-28T15:00:00.000Z","endsAt":"2026-09-28T15:30:00.000Z",""" +
                            """"timezone":"America/Bogota","joinUrl":"https://meet.google.com/mock-abcd-efgh","conversationId":"c1","calendarEventId":"e1","messageId":"msg1","error":null}""")
                    }
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
            }
        }
        s.start(); server = s
        val c = TieComsClient(s.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        try {
            c.login("ana@acme.co", "x")
            val conns = c.loadMeetingConnections()
            assertEquals(listOf("google", "zoom"), conns.map { it.provider })
            assertTrue(conns[0].connected); assertFalse(conns[1].available)
            assertEquals(conns, c.state.value.meetingConnections)

            val attempt = MeetingAttempt()
            val key = attempt.begin()!!
            try { c.createMeeting("google", "c1", key, "Reunión · General", null, 30, "America/Bogota"); fail("la red se cortó") }
            catch (e: Exception) { assertTrue(Meetings.retryable(Meetings.problem(e))); attempt.failed() }
            val again = attempt.begin()!!
            assertEquals(key, again)
            val m = c.createMeeting("google", "c1", again, "Reunión · General", null, 30, "America/Bogota")
            assertEquals("https://meet.google.com/mock-abcd-efgh", m.usableUrl); assertTrue(m.shared)
            val posts = requests.filter { it.first.path == "/api/v1/meetings" }.map { TcJson.parseToJsonElement(it.second).jsonObject }
            assertEquals(2, posts.size)
            assertEquals("las dos con la misma llave", posts[0]["idempotencyKey"], posts[1]["idempotencyKey"])
            val b = posts[1]
            assertEquals("google", b["provider"]!!.jsonPrimitive.content); assertEquals("c1", b["conversationId"]!!.jsonPrimitive.content)
            assertEquals(JsonNull, b["startsAt"]); assertEquals(30, b["durationMin"]!!.jsonPrimitive.int)
            assertEquals("America/Bogota", b["timezone"]!!.jsonPrimitive.content); assertEquals(true, b["share"]!!.jsonPrimitive.content.toBoolean())
            // Agendada: startsAt ISO.
            val at = Instant.parse("2026-10-01T15:00:00Z")
            c.createMeeting("google", "c1", MeetingAttempt().begin()!!, "Revisión", at, 45, "America/Bogota")
            assertEquals("2026-10-01T15:00:00Z", TcJson.parseToJsonElement(requests.last { it.first.path == "/api/v1/meetings" }.second).jsonObject["startsAt"]!!.jsonPrimitive.content)

            // Conectar: la app pide la URL para Custom Tabs con el esquema chaggu.
            assertTrue(c.startMeetingConnect("google").startsWith("https://accounts.google.com/"))
            val connect = TcJson.parseToJsonElement(requests.last { it.first.path == "/api/v1/meetings/connect/google" }.second).jsonObject
            assertEquals("android", connect["platform"]!!.jsonPrimitive.content); assertEquals("chaggu", connect["redirectScheme"]!!.jsonPrimitive.content)
            // No disponible: el motivo del servidor, sin URL.
            try { c.startMeetingConnect("zoom"); fail() } catch (e: ApiException) { assertEquals(Meetings.Problem.Unavailable("Falta ZOOM_CLIENT_ID"), Meetings.problem(e)) }
            // Desconectar.
            c.disconnectMeeting("google")
            assertEquals("DELETE", requests.last { it.first.path == "/api/v1/meetings/connections/google" }.first.method)
            val g = c.state.value.meetingConnections!!.first { it.provider == "google" }
            assertEquals("none", g.status); assertNull(g.accountEmail)
            assertNotNull(c.state.value.meetingConnections)
        } finally { c.close() }
    }
}
