package com.tiecoms.app.core

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** Real client queue and session transitions. All requests stay on a synthetic local server. */
class OutboxSessionTest {
    private val server = MockWebServer()
    private var client: TieComsClient? = null
    private var user = "A"
    private val storage = MemoryStorage()
    private val secrets = MemorySecretStore()
    private val cache = MemorySnapshotCache()
    private var ended: () -> Unit = {}
    private val posts = CopyOnWriteArrayList<Pair<String?, String>>()

    private fun start(cold: Boolean = false): TieComsClient {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                if (request.method == "POST" && path == "/api/v1/conversations/group/messages") {
                    posts += request.getHeader("authorization") to request.body.readUtf8()
                    return MockResponse().setBody("""{"message":{"id":"sent","conversationId":"group","seq":1,"authorId":"$user","body":"sent"}}""")
                }
                val response = when (path) {
                    "$AUTH_BASE_PATH/login", "$AUTH_BASE_PATH/refresh" -> """{"accessToken":"synthetic-$user","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"synthetic","sessionId":"session-$user","user":{"id":"$user"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"$user"},"conversations":[{"id":"group","kind":"group","memberIds":["A","B"]}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    else -> "{}"
                }
                return MockResponse().setBody(response).apply { if (cold && path == "$AUTH_BASE_PATH/refresh") setHeadersDelay(300, TimeUnit.MILLISECONDS) }
            }
        }
        server.start()
        if (cold) {
            storage.set(LAST_USER_KEY, "A"); secrets.set("synthetic")
            cache.write("A", Speed.encode(SessionSnapshot(userId = "A", savedAt = System.currentTimeMillis(), data = BootstrapDTO(me = UserDTO(id = "A"), conversations = listOf(ConversationDTO(id = "group", memberIds = listOf("A", "B")))))))
        }
        val c = TieComsClient(server.url("/").toString().trimEnd('/'), "Outbox fixture", storage, secrets, OkHttpClient(), snapshots = cache, onNoticeSessionEnded = { ended() })
        client = c
        if (!cold) runBlocking { c.login("a@example.test", "synthetic") }
        return c
    }
    @After fun close() { ended = {}; client?.close(); server.shutdown() }

    @Test fun `cold cache send survives the first refresh generation change`() = runBlocking {
        val c = start(cold = true)
        val restoring = async { c.start() }
        withTimeout(5000) { while (!c.paintedFromCache) delay(5) }
        assertEquals("A", c.myId)
        val beforeNotice = c.noticeGeneration; val beforeRequest = c.sessionGeneration
        c.send("group", "cold draft")
        restoring.await()
        withTimeout(5000) { while (posts.isEmpty()) delay(5) }
        assertEquals(beforeNotice, c.noticeGeneration)
        assertTrue(c.sessionGeneration > beforeRequest)
        assertEquals("Bearer synthetic-A", posts.single().first)
        assertTrue(posts.single().second.contains("cold draft"))
    }

    @Test fun `queued old-author send is rejected when login switches accounts`() = runBlocking {
        val c = start()
        // This callback runs on the serialized client dispatcher before auth ownership changes.
        // Its queued send can only execute after applyAuth has invalidated A's notice generation.
        ended = { c.send("group", "queued by A") }
        user = "B"
        c.login("b@example.test", "synthetic")
        delay(200)
        assertEquals("B", c.myId)
        assertTrue(posts.isEmpty())
        assertTrue(c.state.value.pending.isEmpty())
        assertFalse(storage.get("u:B:outbox").orEmpty().contains("queued by A"))
    }

    @Test fun `queued old-author send cannot repopulate the outbox after logout`() = runBlocking {
        val c = start()
        ended = { c.send("group", "queued before logout") }
        c.logout()
        delay(200)
        assertEquals(SessionStatus.ANONYMOUS, c.state.value.status)
        assertTrue(c.state.value.pending.isEmpty())
        assertTrue(posts.isEmpty())
    }
}
