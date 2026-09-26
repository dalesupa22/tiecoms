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
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Reacciones (docs/REACCIONES_ENLACES.md): normalizeEmoji portado, decodificación tolerante y PUT/DELETE optimistas.
 * También el cambio rápido de estado de un asunto (pulsación larga), que usa el mismo patrón optimista.
 */
class ReactionsTest {
    // ---------- normalizeEmoji (mismos casos que el contrato) ----------
    @Test fun `forma canonica de un emoji`() {
        assertEquals("❤️", Reactions.normalize("❤"))
        assertEquals("❤️", Reactions.normalize("❤️"))
        assertEquals("👍", Reactions.normalize("👍️"))
        assertEquals("👍", Reactions.normalize(" 👍 "))
        assertEquals("👍🏽", Reactions.normalize("👍🏽"))
        assertEquals("✅", Reactions.normalize("✅"))
        assertEquals("✔️", Reactions.normalize("✔"))
        assertEquals("☺️", Reactions.normalize("☺"))
        assertEquals("1️⃣", Reactions.normalize("1⃣"))
        assertEquals("1️⃣", Reactions.normalize("1️⃣"))
        assertEquals("🇨🇴", Reactions.normalize("🇨🇴"))
        assertEquals("🏳️‍🌈", Reactions.normalize("🏳‍🌈"))
        assertEquals("👩‍💻", Reactions.normalize("👩‍💻"))
        assertEquals("🏃‍♀️", Reactions.normalize("🏃‍♀"))
        assertEquals("👨‍👩‍👧‍👦", Reactions.normalize("👨‍👩‍👧‍👦"))
        assertEquals("🏴󠁧󠁢󠁥󠁮󠁧󠁿", Reactions.normalize("🏴󠁧󠁢󠁥󠁮󠁧󠁿"))
        Reactions.QUICK.forEach { assertEquals(it, Reactions.normalize(it)) }
        Reactions.PICKER.forEach { assertEquals("canónico: $it", it, Reactions.normalize(it)) }
    }

    @Test fun `no es exactamente un emoji`() {
        listOf("", "  ", "a", "ok", "👍👍", "👍 ❤️", "1", "#", "🇨", "x👍", "👍x", "‍", "👍‍").forEach {
            assertNull("«$it» no es un emoji", Reactions.normalize(it))
        }
        assertNull(Reactions.normalize("👍".repeat(20)))
    }

    @Test fun `solo emojis se ven grandes`() {
        assertTrue(Reactions.isJumbo("👍"))
        assertTrue(Reactions.isJumbo(" 😂😂 "))
        assertTrue(Reactions.isJumbo("🎉 🎉 🎉"))
        assertTrue(Reactions.isJumbo("👨‍👩‍👧‍👦"))
        assertFalse(Reactions.isJumbo("🎉🎉🎉🎉"))
        assertFalse(Reactions.isJumbo("gracias 👍"))
        assertFalse(Reactions.isJumbo("123"))
        assertFalse(Reactions.isJumbo(""))
    }

    @Test fun `poner y quitar mi reaccion en local`() {
        val list = listOf(ReactionDTO("👍", listOf("u2")), ReactionDTO("❤️", listOf("u1")), ReactionDTO("😂", emptyList(), listOf(ExternalReactor("Pedro", "whatsapp"))))
        val on = Reactions.toggle(list, "👍", "u1", true)
        assertEquals(listOf("u2", "u1"), on.first { it.emoji == "👍" }.userIds)
        val off = Reactions.toggle(list, "❤️", "u1", false)
        assertFalse(off.any { it.emoji == "❤️" }) // sin nadie, el chip desaparece
        assertTrue(off.any { it.emoji == "😂" }) // la externa se queda
        val added = Reactions.toggle(list, "🙏", "u1", true)
        assertEquals("🙏", added.last().emoji); assertEquals(listOf("u1"), added.last().userIds)
        assertEquals(1, list[2].count)
        val full = (1..20).map { ReactionDTO("e$it", listOf("u9")) }
        assertFalse(Reactions.canAdd(full, "🙏")); assertTrue(Reactions.canAdd(full, "e3"))
    }

    @Test fun `recordatorio de ojos en tres horas o manana a las nueve`() {
        val z = ZoneId.of("America/Bogota")
        assertEquals(ZonedDateTime.of(2026, 9, 26, 13, 0, 0, 0, z), Reactions.lookRemindAt(ZonedDateTime.of(2026, 9, 26, 10, 0, 0, 0, z)))
        assertEquals(ZonedDateTime.of(2026, 9, 27, 9, 0, 0, 0, z), Reactions.lookRemindAt(ZonedDateTime.of(2026, 9, 26, 16, 30, 0, 0, z)))
        assertEquals(ZonedDateTime.of(2026, 9, 27, 9, 0, 0, 0, z), Reactions.lookRemindAt(ZonedDateTime.of(2026, 9, 26, 22, 0, 0, 0, z)))
    }

    // ---------- Decodificación tolerante ----------
    @Test fun `reacciones y reactionActions opcionales`() {
        val old = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","body":"x"}""")
        assertTrue(old.reactions.isEmpty())
        val nul = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","reactions":null}""")
        assertTrue(nul.reactions.isEmpty())
        val m = TcJson.decodeFromString(MessageDTO.serializer(),
            """{"id":"m","reactions":[{"emoji":"👍","userIds":["u1","u2"]},{"emoji":"😂","userIds":[],"external":[{"name":"Pedro","source":"whatsapp"}],"future":1}]}""")
        assertEquals(2, m.reactions[0].count); assertEquals("Pedro", m.reactions[1].external[0].name); assertEquals(1, m.reactions[1].count)
        assertTrue(TcJson.decodeFromString(OrganizationDTO.serializer(), """{"id":"o"}""").reactionActions)
        assertTrue(TcJson.decodeFromString(OrganizationDTO.serializer(), """{"id":"o","reactionActions":null}""").reactionActions)
        assertFalse(TcJson.decodeFromString(OrganizationDTO.serializer(), """{"id":"o","reactionActions":false}""").reactionActions)
        val r = TcJson.decodeFromString(ReactResult.serializer(), """{"message":{"id":"m"},"closedReminderIds":["r1"],"openIssueId":"i1"}""")
        assertEquals(listOf("r1"), r.closedReminderIds); assertEquals("i1", r.openIssueId); assertNull(r.reminder)
    }

    @Test fun `evento reminders changed y push de reaccion`() {
        assertEquals(AccountEvent.RemindersChanged, decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"reminders.changed"}""")))
        val p = PushPayload.parse(mapOf("type" to "reaction", "conversationId" to "c1", "messageId" to "m-9", "title" to "Laura reaccionó 👍", "body" to "«hola»"))!!
        assertEquals("reaction", p.type); assertEquals("TC_MESSAGE", p.category); assertEquals("m-9", p.messageId)
        val link = DeepLinks.parse("chaggu://c/c1?mid=m-9") as DeepLink.Conversation
        assertEquals("c1", link.id); assertEquals("m-9", link.messageId); assertNull(link.seq)
    }

    // ---------- API ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient
    /** Respuesta del próximo PUT/DELETE de reacción: código y cuerpo. */
    @Volatile private var reactReply: Pair<Int, String>? = null
    @Volatile private var issueReply: Pair<Int, String>? = null

    private val msg = """{"id":"m1","conversationId":"c1","seq":1,"authorId":"u2","body":"hola","createdAt":"2026-09-26T10:00:00Z","reactions":[{"emoji":"👍","userIds":["u2"]}]}"""

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val text = request.body.readUtf8()
                requests += request to text
                val path = request.path!!.substringBefore('?')
                if (path.startsWith("/api/v1/messages/m1/reactions/")) {
                    reactReply?.let { (code, body) -> return MockResponse().setResponseCode(code).setBody(body) }
                }
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana","primaryOrgId":"o1"},"organizations":[{"id":"o1","name":"Acme","myRole":"owner"}],
                        "people":[{"id":"u1","name":"Ana","orgId":"o1"},{"id":"u2","name":"Beto","orgId":"o1"}],
                        "conversations":[{"id":"c1","kind":"group","memberIds":["u1","u2"],"canPost":true,"lastMessageSeq":1,"lastReadSeq":1,"openIssues":2}]}"""
                    path == "/api/v1/reminders" -> """{"reminders":[{"id":"r-old","conversationId":"c1","messageId":"m1","remindAt":"2026-09-26T12:00:00Z"}]}"""
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path == "/api/v1/conversations/c1/messages" -> """{"messages":[$msg],"hasMore":false,"lastEventSeq":1}"""
                    path.startsWith("/api/v1/conversations/c1/events") -> """{"events":[],"resetRequired":false}"""
                    path == "/api/v1/issues" -> """{"issues":[{"id":"i1","conversationId":"c1","title":"Contrato","status":"open"},{"id":"i2","conversationId":"c1","title":"Pago","status":"waiting"}]}"""
                    path == "/api/v1/issues/i1" && request.method == "PATCH" -> {
                        issueReply?.let { (code, body) -> return MockResponse().setResponseCode(code).setBody(body) }
                        """{"id":"i1","conversationId":"c1","title":"Contrato","status":${TcJson.parseToJsonElement(text).jsonObject["status"]}}"""
                    }
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { client.login("ana@acme.co", "x"); client.loadReminders(); client.openConversation("c1") }
    }

    @After fun tearDown() { client.close(); server.shutdown() }

    private fun current() = client.state.value.conversations["c1"]!!.messages.first { it.id == "m1" }

    @Test fun `PUT con emoji codificado, cuerpo vacio y respuesta aplicada`() = runBlocking {
        reactReply = 200 to """{"message":{"id":"m1","conversationId":"c1","seq":1,"authorId":"u2","body":"hola","reactions":[{"emoji":"👍","userIds":["u2","u1"]},{"emoji":"❤️","userIds":["u3"]}]}}"""
        client.react(current(), "👍", on = true)
        val put = requests.last { it.first.method == "PUT" }
        assertEquals("/api/v1/messages/m1/reactions/%F0%9F%91%8D", put.first.path)
        assertEquals("{}", put.second)
        assertEquals(listOf("👍", "❤️"), current().reactions.map { it.emoji })
        // Sin «editado» ni no leídos: una reacción no es un mensaje.
        assertNull(current().editedAt)
        assertEquals(0, client.meta("c1")!!.unread)
    }

    @Test fun `DELETE, ojos con recordatorio y check que cierra`() = runBlocking {
        reactReply = 200 to """{"message":{"id":"m1","conversationId":"c1","seq":1,"authorId":"u2","body":"hola","reactions":[{"emoji":"👀","userIds":["u1"]}]},
            "reminder":{"id":"r-new","conversationId":"c1","messageId":"m1","remindAt":"2026-09-26T15:00:00Z"}}"""
        client.react(current(), "👀", on = true, remindAt = java.time.Instant.parse("2026-09-26T15:00:00Z"))
        val put = requests.last { it.first.method == "PUT" }
        assertEquals("2026-09-26T15:00:00Z", TcJson.parseToJsonElement(put.second).jsonObject["remindAt"]!!.jsonPrimitive.content)
        assertEquals(setOf("r-old", "r-new"), client.state.value.reminders.map { it.id }.toSet())
        reactReply = 200 to """{"message":{"id":"m1","conversationId":"c1","seq":1,"authorId":"u2","body":"hola","reactions":[]},"closedReminderIds":["r-new","r-old"]}"""
        client.react(current(), "❤", on = false)
        val del = requests.last { it.first.method == "DELETE" }
        assertEquals("/api/v1/messages/m1/reactions/%E2%9D%A4%EF%B8%8F", del.first.path) // normalizado: ❤ → ❤️
        assertEquals("", del.second)
        assertTrue(client.state.value.reminders.isEmpty())
        assertTrue(current().reactions.isEmpty())
    }

    @Test fun `409 y errores vuelven la reaccion como estaba`() = runBlocking {
        reactReply = 409 to """{"error":{"code":"too_many_reactions","message":"max"}}"""
        val before = current().reactions
        val e = runCatching { client.react(current(), "🙏", on = true) }.exceptionOrNull()
        assertEquals(409, (e as ApiException).status)
        assertEquals(before, current().reactions)
        assertTrue(runCatching { client.react(current(), "hola", on = true) }.isFailure)
        assertFalse("un texto no se manda", requests.any { it.first.path!!.contains("hola") })
    }

    @Test fun `optimista antes de que responda el servidor`() = runBlocking {
        reactReply = 500 to """{"error":{"code":"internal","message":"x"}}"""
        var inFlight: List<String>? = null
        server.dispatcher.let { d ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    // Mientras el PUT viaja, el chip ya muestra mi reacción.
                    if (request.method == "PUT") inFlight = client.state.value.conversations["c1"]!!.messages.first { it.id == "m1" }.reactions.first { it.emoji == "👍" }.userIds
                    return d.dispatch(request)
                }
            }
        }
        assertTrue(runCatching { client.react(current(), "👍", on = true) }.isFailure)
        assertEquals(listOf("u2", "u1"), inFlight)
        assertEquals(listOf("u2"), current().reactions.first { it.emoji == "👍" }.userIds)
    }

    @Test fun `completar un asunto baja el conteo al instante y vuelve si falla`() = runBlocking {
        client.loadOpenIssues()
        assertEquals(2, client.meta("c1")!!.openIssues)
        var inFlight: Pair<String, Int>? = null
        server.dispatcher.let { d ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.method == "PATCH") inFlight = client.state.value.issues["i1"]!!.status to client.meta("c1")!!.openIssues
                    return d.dispatch(request)
                }
            }
        }
        client.setIssueStatus("i1", "done")
        assertEquals("done" to 1, inFlight) // optimista: antes de que responda el API
        val patch = requests.last { it.first.method == "PATCH" }
        assertEquals("/api/v1/issues/i1", patch.first.path); assertEquals("""{"status":"done"}""", patch.second)
        assertEquals("done", client.state.value.issues["i1"]!!.status); assertEquals(1, client.meta("c1")!!.openIssues)
        // Deshacer / error: vuelve como estaba.
        client.setIssueStatus("i1", "open")
        issueReply = 403 to """{"error":{"code":"forbidden","message":"no"}}"""
        assertTrue(runCatching { client.setIssueStatus("i1", "done") }.isFailure)
        assertEquals("open", client.state.value.issues["i1"]!!.status); assertEquals(2, client.meta("c1")!!.openIssues)
    }
}
