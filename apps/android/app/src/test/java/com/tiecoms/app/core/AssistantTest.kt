package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
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
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** gg en Android (docs/ASISTENTE.md): historial por persona, «envíalos», voz y el contrato de /assistant. */
class AssistantTest {
    private fun turn(role: String, text: String, vararg actions: AssistantActionDTO) = AssistantTurn(role, text, actions.toList(), 1)

    // ---------- Historial ----------
    @Test fun `historial por usuario y el de otra cuenta se descarta al abrir`() {
        val st = MemoryStorage()
        Assistant.save(st, "u1", listOf(turn("user", "hola"), turn("assistant", "¿qué tal?")))
        assertEquals(2, Assistant.load(st, "u1").size)
        assertTrue(st.get("assistant:u1") != null)
        // Entra otra cuenta en el mismo dispositivo: no ve nada y lo de u1 se borra.
        assertTrue(Assistant.load(st, "u2").isEmpty())
        assertNull(st.get("assistant:u1"))
        Assistant.save(st, "u2", listOf(turn("user", "x")))
        assertEquals(listOf("x"), Assistant.load(st, "u2").map { it.content })
    }

    @Test fun `guarda solo los ultimos 40 turnos y se borra con clear`() {
        val st = MemoryStorage()
        Assistant.save(st, "u1", (1..55).map { turn("user", "t$it") })
        val back = Assistant.load(st, "u1")
        assertEquals(40, back.size); assertEquals("t16", back.first().content); assertEquals("t55", back.last().content)
        st.set(Assistant.SPEAK_KEY, "0")
        Assistant.clear(st)
        assertNull(st.get("assistant:u1"))
        assertEquals("la preferencia de voz alta es del dispositivo", "0", st.get(Assistant.SPEAK_KEY))
    }

    @Test fun `historial corrupto no rompe`() {
        val st = MemoryStorage(); st.set(Assistant.OWNER_KEY, "u1"); st.set("assistant:u1", "{no es json")
        assertTrue(Assistant.load(st, "u1").isEmpty())
    }

    @Test fun `al API van 20 turnos con el resumen de acciones y sin tokens`() {
        val a = AssistantActionDTO("a1", "send_message", "pending", "Laura", "Ya va", token = "SECRETO", undoToken = "OTRO")
        val turns = (1..25).map { turn("user", "q$it") } + turn("assistant", "Te dejé un borrador", a)
        val h = Assistant.history(turns)
        assertEquals(20, h.size)
        assertEquals("Te dejé un borrador\n[pending: send_message → Laura: Ya va]", h.last().content)
        assertFalse(h.any { it.content.contains("SECRETO") || it.content.contains("OTRO") })
        assertEquals(4000, Assistant.history(listOf(turn("user", "x".repeat(5000)))).single().content.length)
    }

    // ---------- «envíalos» ----------
    @Test fun `deteccion de enviarlos`() {
        listOf("envíalos", "Envíalos.", "envialos", "mándalos", "mandalos!", "dale", "sí, envía", "si envia", "Sí, envíalos", "send them", "send it", " envíala ")
            .forEach { assertTrue(it, Assistant.isSendAll(it)) }
        listOf("envíale a Laura que ya voy", "dale un reporte", "no los envíes", "", "responde mis pendientes", "mándale un saludo a Pedro")
            .forEach { assertFalse(it, Assistant.isSendAll(it)) }
    }

    @Test fun `pendientes y parche de una accion`() {
        val a = AssistantActionDTO("a1", "send_message", "pending", "Laura", "hola", token = "t1")
        val b = AssistantActionDTO("a2", "create_issue", "done", "Ops", "Revisar", undoToken = "u")
        val c = AssistantActionDTO("a3", "send_message", "pending", "Pedro", "ok", token = "t3")
        val ts = listOf(turn("assistant", "r", a, b), turn("assistant", "r2", c))
        assertEquals(listOf("a1", "a3"), Assistant.pending(ts).map { it.id })
        val p = Assistant.patch(ts, "a3") { copy(status = "done", token = null) }
        assertEquals(listOf("a1"), Assistant.pending(p).map { it.id })
        assertEquals(ts[0], p[0])
    }

    @Test fun `sugerencias de siguiente paso llegan y se guardan en el turno`() {
        val t = TcJson.decodeFromString(AssistantTurnDTO.serializer(), """{"reply":"ok","actions":[],"suggestions":["Envíalos","Márcalos como leídos"]}""")
        assertEquals(listOf("Envíalos", "Márcalos como leídos"), t.suggestions)
        assertTrue(TcJson.decodeFromString(AssistantTurnDTO.serializer(), """{"reply":"ok"}""").suggestions.isEmpty())
        val st = MemoryStorage()
        Assistant.save(st, "u1", listOf(AssistantTurn("assistant", "ok", suggestions = t.suggestions)))
        assertEquals(t.suggestions, Assistant.load(st, "u1").single().suggestions)
    }

    // ---------- Voz y enlaces ----------
    @Test fun `gg se lee yiyi`() {
        assertEquals("Soy yiyi, ¿en qué te ayudo?", Assistant.spoken("Soy gg, ¿en qué te ayudo?"))
        assertEquals("yiyi: listo. yiyi", Assistant.spoken("GG: listo. gg"))
        assertEquals("eggs y huggs", Assistant.spoken("eggs y huggs"))
    }

    @Test fun `abrir segun el link`() {
        assertEquals(Assistant.Target.Conversation("c9"), Assistant.linkTarget("/c/c9"))
        assertEquals(Assistant.Target.Conversation("c9"), Assistant.linkTarget("/c/c9?m=3"))
        assertEquals(Assistant.Target.Screen("agenda"), Assistant.linkTarget("/agenda"))
        assertEquals(Assistant.Target.Screen("issues"), Assistant.linkTarget("/asuntos"))
        assertNull(Assistant.linkTarget(null)); assertNull(Assistant.linkTarget("/c/")); assertNull(Assistant.linkTarget("https://evil.example"))
    }

    @Test fun `decodificacion tolerante del turno`() {
        val t = TcJson.decodeFromString(AssistantTurnDTO.serializer(), """{"reply":"Listo","actions":[{"id":"1","kind":"mark_read","status":"done","target":"Ops","text":"3 chats","undoToken":"u","link":null,"extra":1},{"id":"2","kind":"futuro","status":"pending","target":"X","text":"y","detail":null}]}""")
        assertEquals("Listo", t.reply); assertEquals(2, t.actions.size)
        assertEquals("u", t.actions[0].undoToken); assertNull(t.actions[0].link)
        assertEquals("✦", Assistant.icon(t.actions[1].kind)); assertEquals("◉", Assistant.icon("mark_read"))
    }

    // ---------- Cliente contra el contrato ----------
    private var server: MockWebServer? = null
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    @After fun tearDown() { server?.shutdown() }

    private fun client(storage: KeyValueStorage): TieComsClient {
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                requests += request to body
                return when (request.path!!.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> MockResponse().setBody("""{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}""")
                    "$AUTH_BASE_PATH/logout" -> MockResponse().setBody("{}")
                    "/api/v1/bootstrap" -> MockResponse().setBody("""{"me":{"id":"u1","name":"Ana"},"conversations":[]}""")
                    "/api/v1/reminders" -> MockResponse().setBody("""{"reminders":[]}""")
                    "/api/v1/blocks" -> MockResponse().setBody("""{"userIds":[]}""")
                    "/api/v1/assistant/turn" -> MockResponse().setBody("""{"reply":"Te dejé 1 borrador","actions":[{"id":"a1","kind":"send_message","status":"pending","target":"Laura","text":"Ya va","token":"tok"}]}""")
                    "/api/v1/assistant/run" -> if (TcJson.parseToJsonElement(body).jsonObject["token"]?.jsonPrimitive?.content == "viejo")
                        MockResponse().setResponseCode(410).setBody("""{"error":{"code":"gone","message":"Venció"}}""")
                    else MockResponse().setBody("""{"id":"a1","kind":"send_message","status":"done","target":"Laura","text":"Ya va","undoToken":"und","link":"/c/c1"}""")
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
            }
        }
        s.start(); server = s
        val c = TieComsClient(s.url("/").toString().trimEnd('/'), "Pixel", storage, MemorySecretStore(), OkHttpClient())
        runBlocking { c.login("ana@acme.co", "x") }
        return c
    }

    @Test fun `turn y run con la sesion, y cerrar sesion borra el historial`() = runBlocking {
        val storage = MemoryStorage()
        val c = client(storage)
        try {
            val out = c.assistantTurn(listOf(AssistantMessage("user", "Responde mis pendientes")), "America/Bogota", "es")
            val turnReq = requests.last { it.first.path == "/api/v1/assistant/turn" }
            assertEquals("Bearer t", turnReq.first.getHeader("authorization"))
            val body = TcJson.parseToJsonElement(turnReq.second).jsonObject
            assertEquals("America/Bogota", body["timezone"]!!.jsonPrimitive.content); assertEquals("es", body["lang"]!!.jsonPrimitive.content)
            assertEquals("Responde mis pendientes", body["messages"]!!.jsonArray[0].jsonObject["content"]!!.jsonPrimitive.content)
            assertEquals("tok", out.actions.single().token)

            val done = c.assistantRun("tok", "Ya voy, 5 min")
            val runBody = TcJson.parseToJsonElement(requests.last { it.first.path == "/api/v1/assistant/run" }.second).jsonObject
            assertEquals(JsonPrimitive("tok"), runBody["token"]); assertEquals(JsonPrimitive("Ya voy, 5 min"), runBody["text"])
            assertEquals("done", done.status); assertEquals("und", done.undoToken); assertEquals("/c/c1", done.link)
            c.assistantRun("und")
            assertFalse("sin texto no se manda text", TcJson.parseToJsonElement(requests.last { it.first.path == "/api/v1/assistant/run" }.second).jsonObject.containsKey("text"))
            val e = runCatching { c.assistantRun("viejo") }.exceptionOrNull() as ApiException
            assertEquals(410, e.status)

            c.saveAssistantHistory(listOf(AssistantTurn("user", "hola")))
            assertEquals(1, c.assistantHistory().size)
            c.logout()
            assertNull(storage.get("assistant:u1"))
            assertTrue(c.assistantHistory().isEmpty())
        } finally { c.close() }
    }
}
