package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
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
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** 1.7.4: orden de la fila de temas: de llegada (position) y reordenar arrastrando (PUT /conversations/:id/topics/order). */
class TopicsOrderTest {
    private fun t(id: String, pos: Int, archived: Boolean = false) =
        TopicDTO(id = id, conversationId = "c1", name = id.uppercase(), position = pos, archivedAt = if (archived) "2026-09-30T00:00:00Z" else null)

    @Test fun `orden de llegada por position, estable y sin archivados`() {
        val l = listOf(t("c", 2), t("a", 0), t("x", 1, archived = true), t("b", 1), t("d", 1))
        assertEquals(listOf("a", "b", "d", "c"), Topics.ordered(l).map { it.id })
    }

    @Test fun `mover hacia adelante queda despues del destino`() {
        assertEquals(listOf("b", "c", "a", "d"), Topics.moveTo(listOf("a", "b", "c", "d"), "a", "c"))
        assertEquals(listOf("b", "c", "d", "a"), Topics.moveTo(listOf("a", "b", "c", "d"), "a", "d"))
        assertEquals(listOf("a", "c", "b", "d"), Topics.moveTo(listOf("a", "b", "c", "d"), "b", "c"))
    }

    @Test fun `mover hacia atras queda antes del destino`() {
        assertEquals(listOf("d", "a", "b", "c"), Topics.moveTo(listOf("a", "b", "c", "d"), "d", "a"))
        assertEquals(listOf("a", "c", "b", "d"), Topics.moveTo(listOf("a", "b", "c", "d"), "c", "b"))
    }

    @Test fun `soltar en el mismo sitio o con ids desconocidos no cambia nada`() {
        assertNull(Topics.moveTo(listOf("a", "b"), "a", "a"))
        assertNull(Topics.moveTo(listOf("a", "b"), "z", "a"))
        assertNull(Topics.moveTo(listOf("a", "b"), "a", "z"))
    }

    @Test fun `aplicar el orden nuevo (optimista)`() {
        val l = listOf(t("a", 0), t("b", 1), t("c", 2))
        val r = Topics.applyOrder(l, listOf("c", "a", "b"))
        assertEquals(listOf("c", "a", "b"), r.map { it.id }); assertEquals(listOf(0, 1, 2), r.map { it.position })
    }

    // ---------- Contrato ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient
    @Volatile private var fail403 = false

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                val body = when (request.path!!.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana","primaryOrgId":"o1"},"organizations":[{"id":"o1","name":"Acme","myRole":"owner"}],"conversations":[{"id":"c1","kind":"group","memberIds":["u1"]}]}"""
                    "/api/v1/reminders" -> """{"reminders":[]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/conversations/c1/topics/order" ->
                        if (fail403) return MockResponse().setResponseCode(403).setBody("""{"error":{"code":"forbidden","message":"No puedes escribir"}}""")
                        else """{"topics":[{"id":"c","conversationId":"c1","name":"C","position":0},{"id":"a","conversationId":"c1","name":"A","position":1},{"id":"b","conversationId":"c1","name":"B","position":2}]}"""
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

    private val list = listOf(t("a", 0), t("b", 1), t("c", 2))

    @Test fun `PUT con los ids y guarda lo que responde el servidor`() = runBlocking {
        val r = client.reorderTopics("c1", list, listOf("c", "a", "b"))
        assertEquals(listOf("c", "a", "b"), r.map { it.id })
        val req = requests.last { it.first.path == "/api/v1/conversations/c1/topics/order" }
        assertEquals("PUT", req.first.method)
        assertEquals(listOf("c", "a", "b"), TcJson.parseToJsonElement(req.second).jsonObject["ids"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("c", "a", "b"), client.state.value.topics["c1"]!!.map { it.id })
    }

    @Test fun `si el API falla vuelve al orden anterior`() = runBlocking {
        fail403 = true
        try { client.reorderTopics("c1", list, listOf("c", "a", "b")); fail() } catch (e: ApiException) { assertEquals(403, e.status) }
        assertEquals(listOf("a", "b", "c"), client.state.value.topics["c1"]!!.map { it.id })
    }
}
