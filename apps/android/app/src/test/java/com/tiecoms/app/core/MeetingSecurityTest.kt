package com.tiecoms.app.core

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MeetingSecurityTest {
    private class Fixture(val meetingStore: SecretStore = MemorySecretStore()) : AutoCloseable {
        val server = MockWebServer()
        val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
        var custom: ((RecordedRequest, String) -> MockResponse?)? = null
        private val authNumber = AtomicInteger()
        val client: TieComsClient
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(r: RecordedRequest): MockResponse {
                    val body = r.body.readUtf8(); requests += r to body
                    custom?.invoke(r, body)?.let { return it }
                    val path = r.path!!.substringBefore('?')
                    val user = if (r.getHeader("authorization") == "Bearer b") "b" else "a"
                    val json = when {
                        path == "$AUTH_BASE_PATH/login" -> {
                            val u = if (body.contains("b@test")) "b" else "a"
                            """{"accessToken":"$u","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r$u","sessionId":"s$u-${authNumber.incrementAndGet()}","user":{"id":"$u","name":"QA"}}"""
                        }
                        path == "$AUTH_BASE_PATH/logout" -> "{}"
                        path == "/api/v1/bootstrap" -> """{"me":{"id":"$user","name":"QA"},"conversations":[{"id":"c","kind":"group","memberIds":["$user"],"lastMessageSeq":10,"lastReadSeq":0,"unread":10}]}"""
                        path == "/api/v1/blocks" -> """{"userIds":[]}"""
                        path == "/api/v1/reminders" -> """{"reminders":[]}"""
                        path == "/api/v1/scheduled" -> """{"scheduled":[]}"""
                        path == "/api/v1/issues" -> """{"issues":[]}"""
                        path == "/api/v1/meetings/connections" -> """{"connections":[]}"""
                        path.startsWith("/api/v1/meetings/connect/") -> if (path.endsWith("/confirm")) """{"ok":true,"provider":"google"}""" else """{"url":"https://accounts.google.com/mock"}"""
                        else -> "{}"
                    }
                    return MockResponse().setBody(json)
                }
            }
            server.start()
            client = TieComsClient(server.url("/").toString().trimEnd('/'), "QA", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build(), meetingStore = meetingStore)
        }
        override fun close() { client.close(); server.shutdown() }
    }

    @Test fun `OAuth proof is random S256 one use and cleared on cancel or account switch`() = runBlocking {
        Fixture().use { f ->
            val c = f.client; c.login("a@test", "test")
            c.startMeetingConnect("google")
            val body = TcJson.parseToJsonElement(f.requests.last { it.first.path == "/api/v1/meetings/connect/google" }.second).jsonObject
            val challenge = body["proofChallenge"]!!.jsonPrimitive.content
            assertTrue(challenge.matches(Regex("[A-Za-z0-9_-]{43}")))
            assertEquals("android", body["platform"]!!.jsonPrimitive.content)
            assertEquals("chaggu", body["redirectScheme"]!!.jsonPrimitive.content)
            c.confirmMeetingConnect("google", "a".repeat(43))
            val confirmed = TcJson.parseToJsonElement(f.requests.last { it.first.path == "/api/v1/meetings/connect/confirm" }.second).jsonObject
            val verifier = confirmed["proofVerifier"]!!.jsonPrimitive.content
            assertEquals(43, verifier.length); assertEquals(challenge, Pkce.challenge(verifier))
            assertEquals("a".repeat(43), confirmed["receipt"]!!.jsonPrimitive.content)
            suspend fun invalid() {
                try { c.confirmMeetingConnect("google", "b".repeat(43)); fail("must reject locally") }
                catch (e: ApiException) { assertEquals("meeting_confirmation_invalid", e.code) }
            }
            invalid() // replay: proof already consumed
            c.startMeetingConnect("google"); c.cancelMeetingConnect(); invalid()
            c.startMeetingConnect("google"); c.logout(); c.login("b@test", "test"); invalid()
            assertEquals(1, f.requests.count { it.first.path == "/api/v1/meetings/connect/confirm" })
        }
    }

    @Test fun `late private subject and meeting connections never enter the next session`() = runBlocking {
        Fixture().use { f ->
            val c = f.client; c.login("a@test", "test")
            val entered = CountDownLatch(3); val release = CountDownLatch(1)
            f.custom = { r, _ ->
                if ((r.path == "/api/v1/issues" || r.path == "/api/v1/meetings/connections") && r.getHeader("authorization") == "Bearer a") {
                    entered.countDown(); check(release.await(10, TimeUnit.SECONDS))
                    MockResponse().setBody(when {
                        r.path == "/api/v1/meetings/connections" -> """{"connections":[{"provider":"google","accountEmail":"private@a.test"}]}"""
                        r.method == "POST" -> """{"id":"private","conversationId":null,"title":"Private A"}"""
                        else -> """{"issues":[{"id":"private","conversationId":null,"title":"Private A"}]}"""
                    })
                } else null
            }
            val jobs = listOf(async(Dispatchers.Default) { runCatching { c.loadIssues() } },
                async(Dispatchers.Default) { runCatching { c.createPersonalIssue("Private A", null) } },
                async(Dispatchers.Default) { runCatching { c.loadMeetingConnections() } })
            try {
                assertTrue(entered.await(10, TimeUnit.SECONDS))
                c.logout(); c.login("b@test", "test"); release.countDown()
                jobs.forEach { assertTrue(it.await().exceptionOrNull() is CancellationException) }
                assertEquals("b", c.myId); assertTrue(c.state.value.issues.isEmpty()); assertNull(c.state.value.meetingConnections)
            } finally { release.countDown() }
        }
    }

    @Test fun `late 401 does not refresh or sign out the replacement session`() = runBlocking {
        Fixture().use { f ->
            val c = f.client; c.login("a@test", "test")
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.custom = { r, _ -> if (r.path == "/api/v1/meetings/connections" && r.getHeader("authorization") == "Bearer a") {
                entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); MockResponse().setResponseCode(401).setBody("""{"error":{"code":"unauthorized"}}""")
            } else null }
            val old = async(Dispatchers.Default) { runCatching { c.loadMeetingConnections() } }
            try {
                assertTrue(entered.await(10, TimeUnit.SECONDS)); c.logout(); c.login("b@test", "test"); release.countDown()
                assertTrue(old.await().exceptionOrNull() is CancellationException)
                assertEquals(SessionStatus.READY, c.state.value.status); assertEquals("b", c.myId)
                assertEquals(0, f.requests.count { it.first.path == "$AUTH_BASE_PATH/refresh" })
            } finally { release.countDown() }
        }
    }

    @Test fun `uncertain meeting keeps original payload and key across dismissal or form changes`() {
        val a = MeetingAttempt { "one" }; val payload = MeetingRequest("zoom", "c", "Original", null, 30, "UTC")
        assertEquals("one", a.begin(payload))
        a.failed(problem = Meetings.Problem.Uncertain("m1"), id = "m1"); a.reset()
        assertTrue(a.locked); assertEquals("m1", a.meetingId); assertEquals(payload, a.payload)
        try { a.begin(payload.copy(title = "Changed")); fail() } catch (_: IllegalArgumentException) {}
        assertEquals("one", a.begin(payload)); a.failed(problem = Meetings.Problem.Pending("m1"))
        assertEquals("m1", a.meetingId)
        assertNull(MeetingDTO(status = "creating", joinUrl = "https://meet.google.com/x").usableUrl)
        assertEquals(Meetings.Problem.IdempotencyMismatch, Meetings.problem(ApiException(409, "idempotency_mismatch", "")))
        listOf("no_teams", "no_meet", "not_connected", "reconnect_required", "meeting_in_progress", "meeting_pending", "meeting_uncertain").forEach {
            assertTrue(Meetings.mustKeepAttempt(ApiException(409, it, "", buildJsonObject { put("meetingId", "m1") })))
        }
        assertTrue(Meetings.mustKeepAttempt(ApiException(500, "internal", "")))
        assertFalse(Meetings.mustKeepAttempt(ApiException(503, "provider_unavailable", "")))
    }

    @Test fun `failed read acknowledgement leaves unread cursor and retry only marks visible prefix`() = runBlocking {
        Fixture().use { f ->
            val c = f.client; c.login("a@test", "test")
            var failRead = true
            f.custom = { r, _ -> if (r.path == "/api/v1/conversations/c/read" && failRead) MockResponse().setResponseCode(503).setBody("{}") else null }
            try { c.markRead("c", 4); fail() } catch (_: ApiException) {}
            try { c.markConversationRead("c"); fail() } catch (_: ApiException) {}
            assertEquals(0L, c.meta("c")!!.lastReadSeq); assertEquals(10, c.meta("c")!!.unread)
            failRead = false; c.markRead("c", 4)
            assertEquals(4L, c.meta("c")!!.lastReadSeq); assertEquals(6, c.meta("c")!!.unread)
            val posts = f.requests.filter { it.first.path == "/api/v1/conversations/c/read" }
            assertEquals(listOf(4L, 10L, 4L), posts.map { TcJson.parseToJsonElement(it.second).jsonObject["seq"]!!.jsonPrimitive.long })
        }
    }

    @Test fun `unresolved meeting survives process recreation only for its owner without OAuth proof`() = runBlocking {
        val store = MemorySecretStore()
        val payload = MeetingRequest("zoom", "c", "Same meeting", null, 30, "UTC")
        var key = ""
        Fixture(store).use { f ->
            f.client.login("a@test", "test")
            f.client.startMeetingConnect("google")
            key = f.client.meetingAttempt("c").begin(payload)!!
            // Persistence already exists while the HTTP request is in flight.
            assertTrue(store.get()!!.contains(key)); assertFalse(store.get()!!.contains("proof"))
        }
        Fixture(store).use { f ->
            f.client.login("a@test", "test")
            val restored = f.client.meetingAttempt("c")
            assertTrue(restored.locked); assertFalse(restored.creating)
            assertEquals(key, restored.pendingKey); assertEquals(payload, restored.payload)
            try { f.client.confirmMeetingConnect("google", "a".repeat(43)); fail() } catch (_: ApiException) {}
            restored.failed(problem = Meetings.Problem.Uncertain("m1"), id = "m1")
        }
        Fixture(store).use { f ->
            f.client.login("a@test", "test")
            assertEquals("m1", f.client.meetingAttempt("c").meetingId)
            assertEquals(key, f.client.meetingAttempt("c").begin(payload))
            f.client.logout()
            assertNull(store.get())
        }
        Fixture(store).use { f ->
            f.client.login("a@test", "test"); f.client.meetingAttempt("c").begin(payload)
        }
        Fixture(store).use { f ->
            f.client.login("b@test", "test")
            assertNull(f.client.meetingAttempt("c").pendingKey); assertNull(store.get())
        }
    }

    @Test fun `sending my own message preserves an older unread gap`() = runBlocking {
        Fixture().use { f ->
            val c = f.client; c.login("a@test", "test")
            f.custom = { r, body -> if (r.path == "/api/v1/conversations/c/messages" && r.method == "POST") {
                val id = TcJson.parseToJsonElement(body).jsonObject["clientMessageId"]!!.jsonPrimitive.content
                MockResponse().setBody("""{"message":{"id":"mine","conversationId":"c","authorId":"a","seq":11,"body":"My reply","clientMessageId":"$id"}}""")
            } else null }
            c.send("c", "My reply")
            withTimeout(5000) { while (c.meta("c")!!.lastMessageSeq < 11) delay(20) }
            assertEquals(0L, c.meta("c")!!.lastReadSeq)
            assertEquals(11, c.meta("c")!!.unread)
        }
    }

    @Test fun `unreadable saved meeting prevents a new provider operation`() = runBlocking {
        val store = MemorySecretStore().also { it.set("damaged-operation") }
        Fixture(store).use { f ->
            f.client.login("a@test", "test")
            try { f.client.meetingAttempt("c").begin(MeetingRequest("zoom", "c", "Must not send", null, 30, "UTC")); fail() }
            catch (_: IllegalStateException) {}
            assertEquals("damaged-operation", store.get())
            assertTrue(f.requests.none { it.first.path == "/api/v1/meetings" })
            f.client.logout(); assertNull(store.get())
        }
    }

    @Test fun `own message cannot acknowledge a missing intermediate sequence`() = runBlocking {
        Fixture().use { f ->
            val c = f.client; c.login("a@test", "test"); c.markRead("c", 10)
            f.custom = { r, body -> if (r.path == "/api/v1/conversations/c/messages" && r.method == "POST") {
                val id = TcJson.parseToJsonElement(body).jsonObject["clientMessageId"]!!.jsonPrimitive.content
                MockResponse().setBody("""{"message":{"id":"mine","conversationId":"c","authorId":"a","seq":12,"body":"My reply","clientMessageId":"$id"}}""")
            } else null }
            c.send("c", "My reply")
            withTimeout(5000) { while (c.meta("c")!!.lastMessageSeq < 12) delay(20) }
            assertEquals(10L, c.meta("c")!!.lastReadSeq); assertEquals(2, c.meta("c")!!.unread)
        }
    }

    @Test fun `pending reserved meeting recovers through the exact original POST after status lookup`() = runBlocking {
        Fixture().use { f ->
            val c = f.client; c.login("a@test", "test")
            var confirmed = false
            f.custom = { r, _ -> when (r.path) {
                "/api/v1/meetings/m1" -> MockResponse().setBody(if (confirmed) """{"id":"m1","status":"created","joinUrl":"https://meet.google.com/qa"}""" else """{"id":"m1","status":"creating"}""")
                "/api/v1/meetings" -> { confirmed = true; MockResponse().setBody("""{"id":"m1","status":"created","joinUrl":"https://meet.google.com/qa"}""") }
                else -> null
            } }
            val payload = MeetingRequest("google", "c", "Frozen title", "2026-09-28T09:00:00Z", 30, "UTC")
            assertNotNull(c.resolveMeetingAttempt(payload, "same-key", "m1").usableUrl)
            val sent = TcJson.parseToJsonElement(f.requests.single { it.first.path == "/api/v1/meetings" }.second).jsonObject
            assertEquals("same-key", sent["idempotencyKey"]!!.jsonPrimitive.content)
            assertEquals("Frozen title", sent["title"]!!.jsonPrimitive.content)
            assertEquals(payload.startsAt, sent["startsAt"]!!.jsonPrimitive.content)
            assertNotNull(c.resolveMeetingAttempt(payload, "same-key", "m1").usableUrl)
            assertEquals(1, f.requests.count { it.first.path == "/api/v1/meetings" })
        }
    }
}
