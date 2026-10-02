package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class NightApiContractTest {
    @Test fun `hub counts fetch limit one cache sixty seconds and validate before outbox`() = runBlocking {
        val calls = CopyOnWriteArrayList<RecordedRequest>()
        var clock = System.currentTimeMillis()
        val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                calls += request
                val body = when(request.requestUrl!!.encodedPath) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"fixture","sessionId":"fixture","user":{"id":"me"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"me"},"conversations":[{"id":"c","kind":"direct"}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/whatsapp/chats" -> """{"chats":[],"categories":{"work":{"unread":7},"personal":{"unread":2}}}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        } }
        server.start()
        val client = TieComsClient(server.url("/").toString().trimEnd('/'), "Nocturna local fixture", MemoryStorage(), MemorySecretStore(), OkHttpClient(), now = { clock })
        try {
            client.login("qa@example.test", "fixture")
            repeat(12) { assertEquals(9, client.waUnreadCount()) }
            assertEquals(1, calls.count { it.requestUrl!!.encodedPath == "/api/v1/whatsapp/chats" })
            assertEquals("1", calls.last { it.requestUrl!!.encodedPath == "/api/v1/whatsapp/chats" }.requestUrl!!.queryParameter("limit"))
            clock += 60_001
            assertEquals(9, client.waUnreadCount())
            assertEquals(2, calls.count { it.requestUrl!!.encodedPath == "/api/v1/whatsapp/chats" })
            assertThrows(IllegalArgumentException::class.java) { client.send("c", "x".repeat(8001)) }
            assertTrue(client.state.value.pending.isEmpty())
        } finally { client.close(); server.shutdown() }
    }
    @Test fun `new media statuses provenance read revision remain optional for installed clients`() {
        val old = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","body":"legacy"}""")
        assertNull(old.displayBody)
        val updated = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","body":"full credit","displayBody":"caption","attachments":[{"id":"a","contentType":"IMAGE/GIF ; charset=binary","provenance":{"version":1,"provider":"openverse","title":"Original","attribution":"full credit"}}]}""")
        assertEquals("caption", updated.displayBody); assertTrue(updated.attachments.single().isGif)
        val mail = TcJson.decodeFromString(SharedMailDTO.serializer(), """{"provider":"whatsapp","mediaStatus":"ready","chagguAttachments":[{"id":"destination-copy","kind":"voice","contentType":"audio/mp4"}]}""")
        assertTrue(mail.chagguAttachments.single().isVoice)
        val event = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"read.updated","conversationId":"c","seq":4,"readRevision":9}""").let { it as kotlinx.serialization.json.JsonObject })
        assertEquals(9L, (event as AccountEvent.ReadUpdated).readRevision)
    }
    @Test fun `around identity paginates every gap before joining distant windows`() = runBlocking {
        val pages = CopyOnWriteArrayList<Long>()
        val original = (1L..1000L).map { MessageDTO(id = "m$it", conversationId = "c", seq = it, authorId = "other", body = "QA $it") }
        val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when(path) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"fixture","user":{"id":"me"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"me"},"conversations":[{"id":"c","kind":"direct","lastMessageSeq":1000,"lastReadSeq":0}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/conversations/c/messages" -> {
                        val before = r.requestUrl!!.queryParameter("before")?.toLong() ?: 1001L
                        pages += before
                        val page = original.filter { it.seq < before }.takeLast(50)
                        TcJson.encodeToString(MessagesPage.serializer(), MessagesPage(page, page.first().seq > 1, 0))
                    }
                    "/api/v1/conversations/c/messages/around" -> TcJson.encodeToString(MessagesPage.serializer(), MessagesPage(original.filter { it.seq in 75L..125L }, true, 0))
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        } }
        server.start()
        val client = TieComsClient(server.url("/").toString().trimEnd('/'), "Gap fixture", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        try {
            client.login("qa@example.test", "fixture")
            assertEquals(100L, client.ensureMessageId("c", "m100"))
            val loaded = client.state.value.conversations["c"]!!.messages
            assertEquals(50L, loaded.first().seq - 1)
            assertTrue(loaded.zipWithNext().all { (a,b) -> b.seq == a.seq + 1 })
            assertTrue(pages.contains(951L) && pages.contains(151L))
            assertEquals(0L, ReadProgress().observe(0,0,loaded,setOf(100,1000),"me", emptySet()))
        } finally { client.close(); server.shutdown() }
    }
    @Test fun `calendar request has explicit attendees original timezone and never shares implicitly`() = runBlocking {
        val confirmations = CopyOnWriteArrayList<String>()
        val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val body = when(r.requestUrl!!.encodedPath) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"fixture","user":{"id":"me"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"me"},"conversations":[{"id":"c","kind":"direct"}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/gg/calendar/confirm" -> { confirmations += r.body.readUtf8(); """{"id":"meeting","title":"QA confirmed"}""" }
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        } }
        server.start()
        val client = TieComsClient(server.url("/").toString().trimEnd('/'), "Calendar fixture", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        try {
            client.login("qa@example.test", "fixture")
            val result = client.ggCalendarConfirm("c:c", listOf("m1"), "google", "explicit-fixture-id", "QA confirmed", GgCalendarSlot("2099-01-01T10:00:00Z","2099-01-01T10:30:00Z"), "America/Bogota", "Original description", listOf("qa@example.test"), listOf("p1","p2","p3"))
            assertEquals("meeting", result.id)
            val body = confirmations.single()
            assertTrue(body.contains("\"shareToChat\":false")); assertTrue(body.contains("America/Bogota"))
            assertTrue(body.contains("explicit-fixture-id") && body.contains("Original description") && body.contains("qa@example.test"))
            assertTrue(body.contains("p1") && body.contains("p2") && body.contains("p3"))
        } finally { client.close(); server.shutdown() }
    }

}
