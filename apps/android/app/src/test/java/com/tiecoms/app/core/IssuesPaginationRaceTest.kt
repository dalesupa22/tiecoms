package com.tiecoms.app.core

import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.CopyOnWriteArrayList

class IssuesPaginationRaceTest {
    @Test fun paginatedLoadPreservesSocketEditsAndRejectsHiddenOrSignedOutResults() = runBlocking {
        var entered = CountDownLatch(1)
        var release = CountDownLatch(1)
        val queries = CopyOnWriteArrayList<String>()
        val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when(path) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"fixture","user":{"id":"me"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"me"},"conversations":[{"id":"c","kind":"group","memberIds":["me"]}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/issues" -> {
                        queries += r.path!!
                        assertNotNull(r.getHeader("X-TieComs-Contract"))
                        if (r.requestUrl!!.queryParameter("offset") == "200") { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); """{"issues":[],"nextOffset":null}""" }
                        else """{"issues":[{"id":"i","conversationId":"c","title":"old","updatedAt":"2026-10-01"}],"nextOffset":200}"""
                    }
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        } }
        server.start()
        val c = TieComsClient(server.url("/").toString().trimEnd('/'), "Local pagination QA", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        fun socket(event: AccountEvent) { TieComsClient::class.java.getDeclaredMethod("onAccountEvent", AccountEvent::class.java).apply { isAccessible = true }.invoke(c, event) }
        try {
            c.login("qa@example.test", "fixture")
            val load = async(Dispatchers.Default) { c.loadIssues() }
            assertTrue(entered.await(10, TimeUnit.SECONDS))
            socket(AccountEvent.IssueUpdated(IssueDTO(id = "i", conversationId = "c", title = "socket new", updatedAt = "2026-10-05")))
            release.countDown(); load.await()
            assertEquals("socket new", c.state.value.issues["i"]!!.title)
            assertEquals(listOf("/api/v1/issues?limit=200&offset=0", "/api/v1/issues?limit=200&offset=200"), queries.toList())
            c.loadIssues(conversationId = "c")
            assertEquals("/api/v1/issues?conversationId=c", queries.last())
            socket(AccountEvent.IssueUpdated(IssueDTO(id = "restricted", conversationId = "unlisted", ownerId = "me", visibility = "private")))
            c.loadBootstrap()
            assertTrue("An assigned private task remains accessible without access to its chat", c.state.value.issues.containsKey("restricted"))
            entered = CountDownLatch(1); release = CountDownLatch(1)
            val revoked = async(Dispatchers.Default) { runCatching { c.loadIssues() }.exceptionOrNull() }
            assertTrue(entered.await(10, TimeUnit.SECONDS)); socket(AccountEvent.IssueHidden("i", "c")); release.countDown()
            assertTrue(revoked.await() is CancellationException)
            assertFalse(c.state.value.issues.containsKey("i"))
            entered = CountDownLatch(1); release = CountDownLatch(1)
            val oldSession = async(Dispatchers.Default) { runCatching { c.loadIssues() }.exceptionOrNull() }
            assertTrue(entered.await(10, TimeUnit.SECONDS)); c.logout(); release.countDown()
            assertTrue(oldSession.await() is CancellationException)
            assertTrue(c.state.value.issues.isEmpty())
        } finally { release.countDown(); c.close(); server.shutdown() }
    }
}
