package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
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
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList

/** SPEC-silencio en Android: opciones, reglas de aviso y «No molestar» contra el contrato (y un servidor viejo). */
class SilenceTest {
    private val bogota = ZoneId.of("America/Bogota")
    private val now = Instant.parse("2026-09-28T15:30:00Z").toEpochMilli() // 10:30 en Bogotá

    // ---------- Reglas puras ----------
    @Test fun `opciones de silencio de un chat`() {
        assertEquals("2026-09-28T16:30:00Z", Silence.muteUntil(Silence.MuteOption.HOUR_1, now))
        assertEquals("2026-09-28T23:30:00Z", Silence.muteUntil(Silence.MuteOption.HOURS_8, now))
        assertEquals("2026-10-05T15:30:00Z", Silence.muteUntil(Silence.MuteOption.WEEK, now))
        assertEquals("9999-12-31T00:00:00Z", Silence.muteUntil(Silence.MuteOption.FOREVER, now))
    }

    @Test fun `no molestar hasta mañana es a las 8 hora local`() {
        assertEquals("2026-09-29T13:00:00Z", Silence.dndUntil(Silence.DndOption.TOMORROW, now, bogota))
        // De noche (23:50 en Bogotá = 04:50Z del día siguiente) sigue siendo el día siguiente local.
        val late = Instant.parse("2026-09-29T04:50:00Z").toEpochMilli()
        assertEquals("2026-09-29T13:00:00Z", Silence.dndUntil(Silence.DndOption.TOMORROW, late, bogota))
        assertEquals("2026-09-28T16:30:00Z", Silence.dndUntil(Silence.DndOption.HOUR_1, now, bogota))
        assertEquals(Silence.FOREVER, Silence.dndUntil(Silence.DndOption.FOREVER, now, bogota))
    }

    @Test fun `estado del silencio`() {
        assertEquals(Silence.Status.Off, Silence.status(null, now))
        assertEquals(Silence.Status.Off, Silence.status("2026-09-28T15:00:00Z", now))
        assertEquals(Silence.Status.Off, Silence.status("no-es-fecha", now))
        assertEquals(Silence.Status.Until(Instant.parse("2026-09-28T23:00:00Z").toEpochMilli()), Silence.status("2026-09-28T23:00:00Z", now))
        assertEquals(Silence.Status.Forever, Silence.status(Silence.FOREVER, now))
        // Los silencios «siempre» viejos (2099) también cuentan como «hasta que lo reactive».
        assertEquals(Silence.Status.Forever, Silence.status("2099-12-31T00:00:00Z", now))
        assertTrue(Silence.status("2026-10-05T15:30:00Z", now) is Silence.Status.Until)
    }

    @Test fun `quien avisa - silencio, mencion y no molestar`() {
        val hour = Silence.muteUntil(Silence.MuteOption.HOUR_1, now)
        assertTrue(Silence.notifies(null, false, null, now))
        assertFalse("silenciado", Silence.notifies(hour, false, null, now))
        assertTrue("la mención suena aunque esté silenciado", Silence.notifies(hour, true, null, now))
        assertFalse("silencio «siempre»: tampoco la mención (igual que el servidor)", Silence.notifies(Silence.FOREVER, true, null, now))
        assertFalse("no molestar apaga todo", Silence.notifies(null, true, hour, now))
        assertTrue("no molestar vencido", Silence.notifies(null, false, "2026-09-28T15:00:00Z", now))
    }

    @Test fun `texto de la hora hoy y otro dia`() {
        val today = Silence.whenText(Instant.parse("2026-09-28T23:00:00Z").toEpochMilli(), now, bogota, Locale.forLanguageTag("es-CO"))
        assertTrue(today.sameDay); assertTrue(today.text, today.text.contains("6:00") || today.text.contains("18:00"))
        val other = Silence.whenText(Instant.parse("2026-10-05T15:30:00Z").toEpochMilli(), now, bogota, Locale.forLanguageTag("es-CO"))
        assertFalse(other.sameDay); assertTrue(other.text, other.text.contains("5"))
        assertEquals(null, Silence.msUntilChange(Silence.FOREVER, now))
        assertEquals(3_600_050L, Silence.msUntilChange("2026-09-28T16:30:00Z", now))
    }

    @Test fun `evento me dnd`() {
        val on = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"me.dnd","dndUntil":"2026-09-28T23:00:00Z"}"""))
        assertEquals(AccountEvent.DndUpdated("2026-09-28T23:00:00Z"), on)
        assertEquals(AccountEvent.DndUpdated(null), decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"me.dnd","dndUntil":null}""")))
        assertTrue(decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"me.dnd"}""")) is AccountEvent.Unknown)
    }

    // ---------- Cliente contra el contrato ----------
    private var server: MockWebServer? = null
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    @After fun tearDown() { server?.shutdown() }

    /** [dndRoute]: el servidor conoce PUT /me/dnd; si no, 404 como un servidor viejo. [bootDnd]: JSON de me.dndUntil o null = ausente. */
    private fun client(dndRoute: Boolean, bootDnd: String?, storage: KeyValueStorage = MemoryStorage()): TieComsClient {
        var serverDnd: String? = bootDnd?.takeIf { it != "null" }?.trim('"')
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                requests += request to body
                val path = request.path!!.substringBefore('?')
                return when {
                    path == "$AUTH_BASE_PATH/login" -> MockResponse().setBody("""{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}""")
                    path == "/api/v1/bootstrap" -> {
                        val dnd = if (bootDnd == null) "" else ""","dndUntil":${serverDnd?.let { "\"$it\"" } ?: "null"}"""
                        MockResponse().setBody("""{"me":{"id":"u1","name":"Ana"$dnd},"conversations":[{"id":"c1","kind":"group","memberIds":["u1"]}]}""")
                    }
                    path == "/api/v1/reminders" -> MockResponse().setBody("""{"reminders":[]}""")
                    path == "/api/v1/blocks" -> MockResponse().setBody("""{"userIds":[]}""")
                    path == "/api/v1/me/dnd" && dndRoute && request.method == "PUT" -> {
                        val until = TcJson.parseToJsonElement(body).jsonObject["until"]
                        serverDnd = (until as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { Instant.parse(it).isAfter(Instant.now()) }
                        MockResponse().setBody("""{"dndUntil":${serverDnd?.let { "\"$it\"" } ?: "null"}}""")
                    }
                    path == "/api/v1/me/dnd" -> MockResponse().setResponseCode(404).setBody("""{"message":"Route PUT:/api/v1/me/dnd not found","error":"Not Found","statusCode":404}""")
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
            }
        }
        s.start(); server = s
        val c = TieComsClient(s.url("/").toString().trimEnd('/'), "Pixel", storage, MemorySecretStore(), OkHttpClient())
        runBlocking { c.login("ana@acme.co", "x") }
        return c
    }

    @Test fun `no molestar contra el contrato - PUT, respuesta y bootstrap`() = runBlocking {
        val c = client(dndRoute = true, bootDnd = "null")
        try {
            assertNull(c.state.value.dndUntil); assertFalse(c.dndActive())
            val until = Instant.now().plusSeconds(3600).toString()
            assertTrue("quedó en el servidor", c.setDnd(until))
            val put = requests.last { it.first.path == "/api/v1/me/dnd" }
            assertEquals("PUT", put.first.method)
            assertEquals(JsonPrimitive(until), TcJson.parseToJsonElement(put.second).jsonObject["until"])
            assertEquals(until, c.state.value.dndUntil); assertTrue(c.dndActive()); assertFalse(c.state.value.dndLocalOnly)
            // El bootstrap manda (otra sesión lo apagó y aquí se recarga).
            c.loadBootstrap(); assertEquals(until, c.state.value.dndUntil)
            assertTrue(c.setDnd(null))
            assertEquals(JsonNull, TcJson.parseToJsonElement(requests.last { it.first.path == "/api/v1/me/dnd" }.second).jsonObject["until"])
            assertNull(c.state.value.dndUntil); assertFalse(c.dndActive())
            // «Hasta que lo reactive»
            c.setDnd(Silence.FOREVER); assertEquals(Silence.Status.Forever, Silence.status(c.state.value.dndUntil, System.currentTimeMillis()))
        } finally { c.close() }
    }

    @Test fun `servidor viejo - 404 lo deja solo en el dispositivo sin romperse`() = runBlocking {
        val storage = MemoryStorage()
        val c = client(dndRoute = false, bootDnd = null, storage = storage)
        try {
            val until = Instant.now().plusSeconds(3600).toString()
            assertFalse("solo en el dispositivo", c.setDnd(until))
            assertEquals(until, c.state.value.dndUntil); assertTrue(c.state.value.dndLocalOnly); assertTrue(c.dndActive())
            // El bootstrap sin el campo no lo borra.
            c.loadBootstrap()
            assertEquals(until, c.state.value.dndUntil); assertTrue(c.state.value.dndLocalOnly)
            assertEquals(until, storage.get("dnd:until"))
            assertFalse(c.setDnd(null)); assertFalse(c.dndActive())
        } finally { c.close() }
    }

    @Test fun `bootstrap con dndUntil vigente y cerrar sesion lo limpia`() = runBlocking {
        val storage = MemoryStorage()
        val until = Instant.now().plusSeconds(7200).toString()
        val c = client(dndRoute = true, bootDnd = "\"$until\"", storage = storage)
        try {
            assertEquals(until, c.state.value.dndUntil); assertTrue(c.dndActive())
            assertEquals("espejo para los push con la app cerrada", until, storage.get("dnd:until"))
            c.logout()
            assertNull(storage.get("dnd:until")); assertFalse(c.dndActive())
        } finally { c.close() }
    }
}
