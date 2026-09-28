package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
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

/** Asuntos personales (docs/TANDA-LECTURA-REUNIONES.md §3): IssueDTO.conversationId puede ser null. */
class PersonalIssuesTest {
    private val personalJson = """{"id":"p1","workspaceId":null,"conversationId":null,"originMessageId":null,"originMessageSeq":null,"title":"Renovar el pasaporte",""" +
        """"status":"open","ownerId":"u1","requestedBy":null,"dueDate":"2026-10-02","createdBy":"u1","createdAt":"2026-09-28T10:00:00Z","updatedAt":"2026-09-28T10:00:00Z",""" +
        """"statusSince":"2026-09-28T10:00:00Z","closedAt":null,"commentCount":0,"parentIssueId":null,"visibility":"private","visibleOrgId":null,"viewerIds":["u1"]}"""

    @Test fun `decodifica conversationId null como personal`() {
        val i = TcJson.decodeFromString(IssueDTO.serializer(), personalJson)
        assertNull(i.conversationId); assertTrue(i.personal); assertTrue(i.restricted)
        // Uno de un chat sigue igual.
        val c = TcJson.decodeFromString(IssueDTO.serializer(), personalJson.replace("\"conversationId\":null", "\"conversationId\":\"c1\""))
        assertEquals("c1", c.conversationId); assertFalse(c.personal)
    }

    @Test fun `evento de cuenta issue personal`() {
        val e = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"issue.personal","issue":$personalJson}"""))
        assertTrue(e is AccountEvent.IssuePersonal)
        assertEquals("p1", (e as AccountEvent.IssuePersonal).issue.id)
        assertTrue(e.issue.personal)
        // Sin asunto válido no rompe nada.
        assertTrue(decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"issue.personal"}""")) is AccountEvent.Unknown)
    }

    @Test fun `por grupo, la seccion Personal va primero y sin tocar las demas`() {
        val p = TcJson.decodeFromString(IssueDTO.serializer(), personalJson)
        val a = p.copy(id = "a1", conversationId = "a"); val b1 = p.copy(id = "b1", conversationId = "b"); val b2 = p.copy(id = "b2", conversationId = "b")
        val s = IssueTasks.sections(listOf(a, b1, p, b2), byPerson = false, myId = "u1") { it }
        assertEquals(listOf(IssueTasks.PERSONAL, "b", "a"), s.map { it.first })
        assertEquals(listOf("p1"), s.first().second.map { it.id })
        // Por responsable el personal es mío, como cualquier otro.
        assertEquals(listOf("u1"), IssueTasks.sections(listOf(p), byPerson = true, myId = "u1") { it }.map { it.first })
        assertNull(IssueTasks.groupConversation(p, emptyMap()))
        // No cuenta bajo ningún grupo.
        assertTrue(GroupsTree.openIssues(listOf(p, a), "a").map { it.id } == listOf("a1"))
    }

    private var server: MockWebServer? = null
    @After fun tearDown() { server?.shutdown() }

    @Test fun `crear un asunto personal - POST issues con el contrato 2026-09-28`() = runBlocking {
        val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8(); requests += request to body
                return when (request.path!!.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> MockResponse().setBody("""{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}""")
                    "/api/v1/bootstrap" -> MockResponse().setBody("""{"me":{"id":"u1","name":"Ana"},"conversations":[{"id":"c1","kind":"group","memberIds":["u1"],"openIssues":0}]}""")
                    "/api/v1/blocks" -> MockResponse().setBody("""{"userIds":[]}""")
                    "/api/v1/reminders" -> MockResponse().setBody("""{"reminders":[]}""")
                    "/api/v1/scheduled" -> MockResponse().setBody("""{"scheduled":[]}""")
                    "/api/v1/issues" -> if (request.method == "POST") MockResponse().setBody(personalJson) else MockResponse().setBody("""{"issues":[$personalJson]}""")
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
            }
        }
        s.start(); server = s
        val c = TieComsClient(s.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        try {
            c.login("ana@acme.co", "x")
            val i = c.createPersonalIssue("Renovar el pasaporte", null)
            assertTrue(i.personal)
            val post = requests.first { it.first.path == "/api/v1/issues" && it.first.method == "POST" }
            assertEquals("2026-09-28", post.first.getHeader("x-tiecoms-contract"))
            val body = TcJson.parseToJsonElement(post.second).jsonObject
            assertEquals("Renovar el pasaporte", body["title"]!!.jsonPrimitive.content)
            assertEquals(JsonNull, body["dueDate"])
            assertFalse("no manda conversación ni responsable", body.containsKey("conversationId") || body.containsKey("ownerId"))
            assertEquals(i, c.state.value.issues["p1"])
            // No sube el contador de ninguna conversación.
            assertEquals(0, c.meta("c1")!!.openIssues)
            val listed = c.loadIssues()
            assertEquals(listOf("p1"), listed.map { it.id })
        } finally { c.close() }
    }
}
