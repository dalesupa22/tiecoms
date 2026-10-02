package com.tiecoms.app.core

import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ReadRevisionRaceTest {
    @Test fun `read unread tree acknowledgements never overwrite a newer socket revision`() = runBlocking {
        var entered = CountDownLatch(1)
        var release = CountDownLatch(1)
        var holdBootstrap = false
        var response = """{"lastReadSeq":10,"readRevision":2}"""
        val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when(path) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"fixture","user":{"id":"me"}}"""
                    "/api/v1/bootstrap" -> {
                        if (holdBootstrap) { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
                        """{"me":{"id":"me"},"conversations":[{"id":"c","kind":"group","memberIds":["me"],"lastMessageSeq":10,"lastReadSeq":0,"readRevision":1,"unread":10}]}"""
                    }
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/conversations/c/read", "/api/v1/conversations/c/unread", "/api/v1/conversations/c/read-tree" -> {
                        entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); response
                    }
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        } }
        server.start()
        val c = TieComsClient(server.url("/").toString().trimEnd('/'), "Read QA", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        fun socket(seq: Long, rev: Long) {
            TieComsClient::class.java.getDeclaredMethod("onAccountEvent", AccountEvent::class.java).apply { isAccessible = true }
                .invoke(c, AccountEvent.ReadUpdated("c", seq, rev))
        }
        try {
            c.login("qa@example.test", "fixture")
            val oldRead = async(Dispatchers.Default) { c.markRead("c", 10) }
            assertTrue(entered.await(10, TimeUnit.SECONDS)); socket(2, 3); release.countDown(); oldRead.await()
            assertEquals(2L, c.meta("c")!!.lastReadSeq); assertEquals(3L, c.meta("c")!!.readRevision)
            entered = CountDownLatch(1); release = CountDownLatch(1); response = """{"lastReadSeq":2,"readRevision":4}"""
            val oldUnread = async(Dispatchers.Default) { c.markUnread("c", 3) }
            assertTrue(entered.await(10, TimeUnit.SECONDS)); socket(8, 5); release.countDown(); oldUnread.await()
            assertEquals(8L, c.meta("c")!!.lastReadSeq); assertEquals(5L, c.meta("c")!!.readRevision)
            entered = CountDownLatch(1); release = CountDownLatch(1); response = """{"marked":[{"conversationId":"c","lastReadSeq":10,"readRevision":6}]}"""
            val oldTree = async(Dispatchers.Default) { c.markTreeRead("c") }
            assertTrue(entered.await(10, TimeUnit.SECONDS)); socket(1, 7); release.countDown(); oldTree.await()
            assertEquals(1L, c.meta("c")!!.lastReadSeq); assertEquals(9, c.meta("c")!!.unread)
            entered = CountDownLatch(1); release = CountDownLatch(0); response = """{"lastReadSeq":9,"readRevision":8}"""
            c.markRead("c", 10)
            assertEquals(9L, c.meta("c")!!.lastReadSeq); assertEquals(8L, c.meta("c")!!.readRevision)
            response = "{}"; c.markRead("c", 10)
            assertEquals(9L, c.meta("c")!!.lastReadSeq)
            entered = CountDownLatch(1); release = CountDownLatch(1); holdBootstrap = true
            val oldSnapshot = async(Dispatchers.Default) { c.loadBootstrap() }
            assertTrue(entered.await(10, TimeUnit.SECONDS)); socket(3, 9); release.countDown(); oldSnapshot.await()
            assertEquals(3L, c.meta("c")!!.lastReadSeq); assertEquals(9L, c.meta("c")!!.readRevision)
            assertEquals(7, c.meta("c")!!.unread)
        } finally { release.countDown(); c.close(); server.shutdown() }
    }

    @Test fun `cursor revisions allow deliberate decrease but legacy events remain monotonic`() {
        val c = ConversationDTO(lastMessageSeq = 10, lastReadSeq = 8, unread = 2, readRevision = 20)
        assertEquals(c, ReadTree.applyCursor(c, 10, 19))
        assertEquals(c, ReadTree.applyCursor(c, 10, 20))
        assertEquals(c, ReadTree.applyCursor(c, 10, null))
        val unread = ReadTree.applyCursor(c, 2, 21)
        assertEquals(2L, unread.lastReadSeq); assertEquals(8, unread.unread); assertEquals(21L, unread.readRevision)
        val legacy = c.copy(readRevision = null)
        assertEquals(8L, ReadTree.applyCursor(legacy, 2, null).lastReadSeq)
        assertEquals(2L, ReadTree.applyCursor(legacy, 2, null, legacyDecrease = true).lastReadSeq)
        assertEquals(21L, TcJson.decodeFromString(ReadResult.serializer(), """{"lastReadSeq":2,"readRevision":21}""").readRevision)
        assertEquals(21L, TcJson.decodeFromString(ReadTreeResult.serializer(), """{"marked":[{"conversationId":"c","lastReadSeq":2,"readRevision":21}]}""").marked.single().readRevision)
    }
}
