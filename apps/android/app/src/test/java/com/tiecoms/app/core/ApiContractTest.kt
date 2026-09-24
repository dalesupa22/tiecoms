package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Rutas y cuerpos del contrato para lo que no se puede ejercer en vivo contra 3041:
 * WhatsApp (no hay WhatsApp real en pruebas) y dominios (requieren DNS real).
 */
class ApiContractTest {
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient

    private val account = """{"id":"a1","label":"Personal","kind":"personal","status":"qr","qr":"data:image/png;base64,AAAA","pairingCode":null,"chats":0,"groups":0,"createdAt":"2026-09-24T10:00:00Z"}"""
    private val chat = """{"accountId":"a1","accountLabel":"Personal","accountKind":"personal","jid":"120363@g.us","name":"Obra 12","isGroup":true,"participants":8,"category":"trabajo","unread":3,"pinned":false,"hidden":false,"linkedConversationId":"c1"}"""

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                val path = request.path!!.substringBefore('?')
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana","primaryOrgId":"o1"},"organizations":[{"id":"o1","name":"Acme","myRole":"owner"}],"conversations":[{"id":"c1","kind":"group","memberIds":["u1"]}]}"""
                    path == "/api/v1/reminders" -> """{"reminders":[]}"""
                    path == "/api/v1/whatsapp/accounts" && request.method == "GET" -> """{"accounts":[$account],"max":5}"""
                    path == "/api/v1/whatsapp/accounts" -> account
                    path.endsWith("/relink") -> account.replace("\"qr\",", "\"pending\",")
                    path.startsWith("/api/v1/whatsapp/accounts/") && request.method == "DELETE" -> """{"ok":true}"""
                    path == "/api/v1/whatsapp/chats" -> """{"chats":[$chat],"categories":{"trabajo":{"total":1,"unread":3}}}"""
                    path.endsWith("/messages") && path.startsWith("/api/v1/whatsapp") -> """{"messages":[{"id":"w1","fromMe":false,"author":"Juan","kind":"text","body":"hola","sentAt":"2026-09-24T09:00:00Z"}]}"""
                    path.startsWith("/api/v1/whatsapp/chats/") -> chat.replace("\"c1\"", "null")
                    path == "/api/v1/whatsapp/organize" -> """{"reviewed":10,"changed":2}"""
                    path == "/api/v1/organizations/o1/domains" && request.method == "GET" -> """{"domains":[]}"""
                    path == "/api/v1/organizations/o1/domains" -> """{"domain":"acme.co","status":"pending","txtName":"_tiecoms.acme.co","txtValue":"tiecoms-verification=x"}"""
                    path.endsWith("/verify") -> """{"domain":"acme.co","status":"dns","txtName":"_tiecoms.acme.co","txtValue":"tiecoms-verification=x","verifiedAt":"2026-09-24T10:00:00Z"}"""
                    path == "/api/v1/account" -> """{"ok":true}"""
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

    private fun last(method: String, pathPrefix: String) = requests.last { it.first.method == method && it.first.path!!.startsWith(pathPrefix) }
    private fun json(s: String) = TcJson.parseToJsonElement(s).jsonObject

    @Test fun `whatsapp cuentas, chats, vinculo y organizador`() = runBlocking {
        val page = client.waAccounts()
        assertEquals(5, page.max); assertEquals("qr", page.accounts[0].status)
        client.waCreate("Personal", "personal", null)
        val create = json(last("POST", "/api/v1/whatsapp/accounts").second)
        assertEquals("personal", create["kind"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, create["pairPhone"])
        client.waRelink("a1", "+57 300 123 4567")
        assertEquals("+57 300 123 4567", json(last("POST", "/api/v1/whatsapp/accounts/a1/relink").second)["pairPhone"]!!.jsonPrimitive.content)
        val chats = client.waChats(null, "trabajo", true, false, "obra 12")
        assertEquals(8, chats.chats[0].participants)
        val q = last("GET", "/api/v1/whatsapp/chats").first.path!!
        assertTrue(q, q.contains("category=trabajo") && q.contains("groups=1") && q.contains("q=obra%2012"))
        val up = client.waPatchChat(chats.chats[0], JsonObject(mapOf("linkedConversationId" to JsonNull)))
        assertEquals(null, up.linkedConversationId)
        val patch = last("PATCH", "/api/v1/whatsapp/chats/")
        assertEquals("/api/v1/whatsapp/chats/a1/120363%40g.us", patch.first.path)
        assertEquals(JsonNull, json(patch.second)["linkedConversationId"])
        assertEquals("Juan", client.waMessages(chats.chats[0])[0].author)
        assertEquals(2, client.waOrganize().changed)
        client.waRemove("a1")
        assertEquals("DELETE", last("DELETE", "/api/v1/whatsapp/accounts/a1").first.method)
    }

    @Test fun `dominios de empresa y eliminar cuenta`() = runBlocking {
        assertEquals(0, client.listDomains("o1").size)
        val d = client.addDomain("o1", "acme.co")
        assertEquals("tiecoms-verification=x", d.txtValue)
        assertEquals("acme.co", json(last("POST", "/api/v1/organizations/o1/domains").second)["domain"]!!.jsonPrimitive.content)
        assertEquals("dns", client.verifyDomain("o1", "acme.co").status)
        assertEquals("/api/v1/organizations/o1/domains/acme.co/verify", last("POST", "/api/v1/organizations/o1/domains/acme.co").first.path)
        client.deleteAccount(" Ana@Acme.co ", "")
        val del = last("DELETE", "/api/v1/account")
        assertEquals("ana@acme.co", json(del.second)["confirmEmail"]!!.jsonPrimitive.content)
        assertTrue("sin contraseña no se envía el campo", json(del.second)["password"] == null)
        assertEquals(SessionStatus.ANONYMOUS, client.state.value.status)
    }

    @Test fun `preferencias con nulos explicitos`() = runBlocking {
        requests.clear()
        runCatching { client.setConversationPrefs("c1", mutedUntil = null) }
        val body = json(requests.last { it.first.path == "/api/v1/conversations/c1/prefs" }.second)
        assertEquals(JsonNull, body["mutedUntil"]); assertTrue(body["pinned"] == null)
        runCatching { client.setConversationPrefs("c1", pinned = true) }
        val b2 = json(requests.last { it.first.path == "/api/v1/conversations/c1/prefs" }.second)
        assertEquals(JsonPrimitive(true), b2["pinned"]); assertTrue("no toca el silencio", b2["mutedUntil"] == null)
    }
}
