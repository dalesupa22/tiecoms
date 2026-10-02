package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 2-oct-2026: pines de correo (PUT/GET /mail/pins, MailPinDTO, bootstrap.mailPins), los dos pines de WhatsApp,
 * responder desde chaggu y la pantalla WhatsApp compacta (orden, «Solo trabajo», contadores sin «0»).
 * Contrato: apps/api/src/modules/mail-pins.ts y whatsapp.ts (rama web-cuadricula-plegar).
 */
class PinsWhatsAppContractTest {
    private fun withServer(routes: Map<String, String>, bootstrap: String = """{"me":{"id":"me"},"conversations":[]}""",
                           block: suspend (TieComsClient, List<RecordedRequest>, List<String>) -> Unit) = runBlocking {
        val calls = CopyOnWriteArrayList<RecordedRequest>(); val bodies = CopyOnWriteArrayList<String>()
        val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when (path) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"fixture","user":{"id":"me"}}"""
                    "/api/v1/bootstrap" -> bootstrap
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    else -> routes["${r.method} $path"]?.also { calls += r; bodies += r.body.readUtf8() } ?: return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        } }
        server.start()
        val client = TieComsClient(server.url("/").toString().trimEnd('/'), "pins fixture", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        try { client.login("qa@example.test", "fixture"); block(client, calls, bodies) } finally { client.close(); server.shutdown() }
    }

    private val pinJson = """{"provider":"google","threadKey":"t1","messageId":"g1","subject":"Comité","from":{"name":"Jorge","email":"jorge@uni.co"},"date":"2026-10-02T10:00:00.000Z","mainPinnedAt":"2026-10-02T11:00:00.000Z","mailPinnedAt":null,"extra":1}"""

    @Test fun `MailPinDTO decodes and bootstrap mailPins absent means old server`() {
        val p = TcJson.decodeFromString(MailPinDTO.serializer(), pinJson)
        assertEquals("google:t1", p.key); assertEquals("Jorge", p.from?.name); assertNotNull(p.mainPinnedAt); assertNull(p.mailPinnedAt)
        assertEquals("g1", p.asItem().id); assertEquals("t1", p.asItem().threadId)
        assertNull(TcJson.decodeFromString(BootstrapDTO.serializer(), """{"me":{"id":"me"}}""").mailPins)
        assertEquals(1, TcJson.decodeFromString(BootstrapDTO.serializer(), """{"me":{"id":"me"},"mailPins":[$pinJson]}""").mailPins!!.size)
        val bare = TcJson.decodeFromString(MailPinDTO.serializer(), """{"provider":"microsoft","threadKey":"x","messageId":"x","subject":"","from":null,"date":null,"mainPinnedAt":null,"mailPinnedAt":"2026-10-02T11:00:00Z"}""")
        assertNull(bare.from); assertEquals(listOf(bare), MailPins.inMail(listOf(bare, p), "microsoft")); assertEquals(listOf(p), MailPins.main(listOf(bare, p)))
    }

    @Test fun `put body sends only the changed pin and thread key falls back to the message id`() {
        assertEquals("t9", MailPins.threadKey("t9", "m1")); assertEquals("m1", MailPins.threadKey(null, "m1")); assertEquals("m1", MailPins.threadKey(" ", "m1"))
        val b = MailPins.body("google", "t1", "g1", "Comité", MailAddressDTO("Jorge", "jorge@uni.co"), "2026-10-02T10:00:00Z", main = true, mail = null)
        assertEquals(setOf("provider", "threadKey", "messageId", "subject", "from", "date", "main"), b.keys)
        assertTrue(b["main"]!!.jsonPrimitive.boolean)
        assertEquals("jorge@uni.co", b["from"]!!.jsonObject["email"]!!.jsonPrimitive.content)
        val off = MailPins.body("microsoft", "x", "x", "", null, null, main = null, mail = false)
        assertEquals(JsonNull, off["from"]); assertEquals(JsonNull, off["date"]); assertFalse(off["mail"]!!.jsonPrimitive.boolean); assertFalse("main" in off)
    }

    @Test fun `setMailPin puts the body and keeps the server list in the bootstrap`() = withServer(mapOf(
        "PUT /api/v1/mail/pins" to """{"pins":[$pinJson]}""",
        "GET /api/v1/mail/pins" to """{"pins":[]}""",
    ), bootstrap = """{"me":{"id":"me"},"conversations":[],"mailPins":[]}""") { client, calls, bodies ->
        val pin = MailPinDTO(provider = "google", threadKey = "t1", messageId = "g1", subject = "Comité", from = MailAddressDTO("Jorge", "jorge@uni.co"), date = "2026-10-02T10:00:00Z")
        val l = client.setMailPin(pin, main = true)
        assertEquals("PUT", calls.single().method)
        val sent = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("t1", sent["threadKey"]!!.jsonPrimitive.content); assertEquals("g1", sent["messageId"]!!.jsonPrimitive.content)
        assertTrue(sent["main"]!!.jsonPrimitive.boolean); assertFalse("mail" in sent)
        assertEquals(1, l.size); assertEquals(l, client.state.value.data!!.mailPins)
        assertTrue(client.loadMailPins().isEmpty()); assertEquals(emptyList<MailPinDTO>(), client.state.value.data!!.mailPins)
    }

    @Test fun `setMailPin rolls back when the server fails`() = withServer(emptyMap(), bootstrap = """{"me":{"id":"me"},"conversations":[],"mailPins":[]}""") { client, _, _ ->
        val pin = MailPinDTO(provider = "google", threadKey = "t1", messageId = "g1")
        assertThrows(ApiException::class.java) { runBlocking { client.setMailPin(pin, mail = true) } }
        assertEquals(emptyList<MailPinDTO>(), client.state.value.data!!.mailPins)
    }

    @Test fun `optimistic pins keep the other flag and drop the row when none is left`() {
        val p = MailPinDTO(provider = "google", threadKey = "t1", messageId = "g1")
        val one = MailPins.optimistic(emptyList(), p, main = true, mail = null, nowIso = "N")
        assertEquals("N", one.single().mainPinnedAt); assertNull(one.single().mailPinnedAt)
        val two = MailPins.optimistic(one, p, main = null, mail = true, nowIso = "M")
        assertEquals("N", two.single().mainPinnedAt); assertEquals("M", two.single().mailPinnedAt)
        assertTrue(MailPins.optimistic(MailPins.optimistic(two, p, false, null, "x"), p, null, false, "x").isEmpty())
    }

    @Test fun `whatsapp pins, send and reply-from-chaggu bodies`() = withServer(mapOf(
        "PATCH /api/v1/whatsapp/chats/acc/1%40g.us" to """{"accountId":"acc","jid":"1@g.us","name":"Equipo","pinned":true,"inboxPlace":"groups","inboxPinnedAt":null}""",
        "POST /api/v1/whatsapp/chats/acc/1%40g.us/send" to """{"id":"o1","status":"queued"}""",
        "PATCH /api/v1/whatsapp/accounts/acc" to """{"id":"acc","label":"Personal","status":"connected","sendEnabled":true}""",
    )) { client, _, bodies ->
        val c = WaChatDTO(accountId = "acc", jid = "1@g.us", name = "Equipo")
        val up = client.waPatchChat(c, buildJsonObject { put("pinned", JsonPrimitive(true)) })
        assertTrue(up.pinned); assertEquals(setOf("pinned"), Json.parseToJsonElement(bodies[0]).jsonObject.keys)
        val r = client.waSend(c, "  hola  ")
        assertEquals("queued", r.status); assertEquals("hola", Json.parseToJsonElement(bodies[1]).jsonObject["text"]!!.jsonPrimitive.content)
        assertTrue(client.waSetSendEnabled("acc", true).sendEnabled)
        assertTrue(Json.parseToJsonElement(bodies[2]).jsonObject["sendEnabled"]!!.jsonPrimitive.boolean)
        assertFalse(TcJson.decodeFromString(WaAccountDTO.serializer(), """{"id":"x"}""").sendEnabled)
    }

    @Test fun `whatsapp screen order, summary, account dot and counters without zero while loading`() {
        val a = WaChatDTO(accountId = "1", jid = "a", lastMessageAt = "2026-10-02T10:00:00Z")
        val b = WaChatDTO(accountId = "1", jid = "b", lastMessageAt = "2026-10-01T10:00:00Z", pinned = true)
        val cc = WaChatDTO(accountId = "1", jid = "c", lastMessageAt = "2026-10-02T12:00:00Z")
        assertEquals(listOf("b", "c", "a"), WaView.sort(listOf(a, b, cc, a)).map { it.jid })
        val accs = listOf(WaAccountDTO(id = "1", status = "connected"), WaAccountDTO(id = "2", status = "qr"))
        val s = WaView.summary(accs); assertEquals(1, s.connected); assertEquals(2, s.total); assertTrue(s.waiting); assertFalse(s.allConnected)
        assertTrue(WaView.summary(accs.take(1)).allConnected)
        assertNull(WaView.accountColor(accs.take(1), "1")); assertNotEquals(WaView.accountColor(accs, "1"), WaView.accountColor(accs, "2"))
        val counts = mapOf("trabajo" to WaCount(3, 1), "familia" to WaCount(2, 0), "clientes" to WaCount(4, 0))
        assertNull(WaView.chipCount(counts, loaded = false, category = null)); assertNull(WaView.workCount(counts, loaded = false))
        assertEquals(9, WaView.chipCount(counts, true, null)); assertEquals(0, WaView.chipCount(counts, true, "amigos")); assertEquals(7, WaView.workCount(counts, true))
        // Ocultar: sale de la lista si no se ven los ocultos; fijar: sube.
        assertEquals(listOf("b", "c"), WaView.applyLocal(listOf(a, b, cc), a.copy(hidden = true), showHidden = false).map { it.jid })
        assertEquals(listOf("a", "b", "c"), WaView.applyLocal(listOf(a, b, cc), a.copy(pinned = true, lastMessageAt = "2026-10-03T00:00:00Z"), showHidden = false).map { it.jid })
    }

    @Test fun `work only keeps trabajo and clientes and the inbox keeps main-screen pins`() {
        val work = WaChatDTO(accountId = "1", jid = "w", category = "trabajo")
        val client = WaChatDTO(accountId = "1", jid = "k", category = "clientes")
        val fam = WaChatDTO(accountId = "1", jid = "f", category = "familia")
        val famPinned = WaChatDTO(accountId = "1", jid = "p", category = "amigos", inboxPinnedAt = "2026-10-02T00:00:00Z")
        val all = listOf(work, client, fam, famPinned)
        assertEquals(all, WaView.workFilter(all, false)); assertEquals(listOf("w", "k"), WaView.workFilter(all, true).map { it.jid })
        assertEquals(all, WaView.inboxFilter(all, false)); assertEquals(listOf("w", "k", "p"), WaView.inboxFilter(all, true).map { it.jid })
    }

    @Test fun `deep link to a whatsapp chat opens its messages`() {
        val l = DeepLinks.parse("chaggu://whatsapp/0a9a9a9a-0000-4000-8000-000000000066/573111%40s.whatsapp.net")
        assertEquals(DeepLink.Conversation("wa:0a9a9a9a-0000-4000-8000-000000000066:573111@s.whatsapp.net"), l)
        assertEquals(DeepLink.Screen(DeepLinks.SCREEN_WHATSAPP), DeepLinks.parse("chaggu://whatsapp"))
        assertEquals(DeepLink.Screen(DeepLinks.SCREEN_WHATSAPP), DeepLinks.parse("chaggu://whatsapp/0a9a9a9a-0000-4000-8000-000000000066/nada"))
    }
}
