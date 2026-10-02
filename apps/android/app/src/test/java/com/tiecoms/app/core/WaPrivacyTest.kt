package com.tiecoms.app.core

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onEach
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class WaPrivacyTest {
    private val chat = WaChatDTO(accountId = "fixture-a", jid = "123:7@lid", name = "Synthetic private", inboxPlace = "dms")
    private val other = chat.copy(accountId = "fixture-b", jid = "other@s.whatsapp.net")

    @Test fun `epochs reject stale data after reset and unlock without hiding other sources`() {
        val key = WaInbox.key(chat)
        var p = WaPrivacy()
        val before = p.token(key)
        p = p.revoke(chat.accountId, listOf(chat.jid), false)
        assertFalse(p.allows(key)); assertTrue(p.allows(WaInbox.key(other))); assertTrue(p.allows("c:synthetic"))
        p = p.accept(listOf(chat))
        assertTrue(p.allows(key)); assertNotEquals(before, p.token(key))
        p = p.revoke(chat.accountId, emptyList(), true).accept(listOf(chat))
        assertFalse(p.allows(key))
        p = p.ready(chat.accountId).accept(listOf(chat))
        assertTrue(p.allows(key)); assertTrue(p.allows(WaInbox.key(other)))
    }

    @Test fun `events and encoded native media and gg source resolve exact account jid`() {
        val event = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"wa.privacy","accountId":"fixture-a","jids":["123:7@lid"],"reset":true}""")) as AccountEvent.WaPrivacy
        assertEquals(chat.accountId, event.accountId); assertEquals(listOf(chat.jid), event.jids); assertTrue(event.reset)
        assertEquals(WaInbox.key(chat), WaPrivacy.source("/api/v1/whatsapp/media/fixture-a/123%3A7%40lid/m1"))
        assertEquals(WaInbox.key(chat), WaPrivacy.source("/gg/side?source=wa%3Afixture-a%3A123%3A7%40lid"))
        assertEquals(WaInbox.key(chat), WaPrivacy.source("/whatsapp/share", """{"accountId":"fixture-a","jid":"123:7@lid"}"""))
        assertNull(WaPrivacy.source("/conversations/keep/messages"))
    }

    @Test fun `snapshots never restore WA before online validation and retain Chaggu history`() {
        val data = BootstrapDTO(me = UserDTO(id = "fixture-user"), waInbox = listOf(chat), conversations = listOf(ConversationDTO(id = "keep")))
        val old = SessionSnapshot(Speed.VERSION, data.me.id, 1000, data, emptyList(), emptyList())
        val restored = Speed.decode(Speed.encode(old), data.me.id, 1001)!!
        assertTrue(restored.data.waInbox.isEmpty()); assertEquals("keep", restored.data.conversations.single().id)
        assertTrue(Speed.snapshot(ClientState(data = data), 1001)!!.data.waInbox.isEmpty())
    }

    private suspend fun fixture(now: () -> Long = System::currentTimeMillis, test: suspend (TieComsClient, MockWebServer, (Dispatcher) -> Unit) -> Unit) {
        val server = MockWebServer()
        var override: Dispatcher? = null
        val chats = TcJson.encodeToString(WaChatsPage.serializer(), WaChatsPage(chats = listOf(chat, other)))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                if (r.requestUrl!!.encodedPath.startsWith("/api/v1/whatsapp/")) return override?.dispatch(r) ?: MockResponse().setBody(chats)
                if (override != null && (r.requestUrl!!.encodedPath == "$AUTH_BASE_PATH/refresh" || r.requestUrl!!.encodedPath == "/api/v1/bootstrap" || r.requestUrl!!.encodedPath.startsWith("/api/v1/gg/"))) return override!!.dispatch(r)
                val body = when (r.requestUrl!!.encodedPath) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"fixture","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"fixture","refreshToken":"fixture-refresh","user":{"id":"fixture-user"}}"""
                    "/api/v1/bootstrap" -> TcJson.encodeToString(BootstrapDTO.serializer(), BootstrapDTO(me = UserDTO(id = "fixture-user"), waInbox = listOf(chat, other), conversations = listOf(ConversationDTO(id = "keep"))))
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        val client = TieComsClient(server.url("/").toString().trimEnd('/'), "Privacy fixture", MemoryStorage(), MemorySecretStore(), OkHttpClient(), now = now)
        try { client.login("fixture@example.test", "fixture"); test(client, server) { override = it } }
        finally { client.close(); server.shutdown() }
    }

    @Test fun `held list cannot restore revoked inbox but fresh authorized list can unlock`() = runBlocking {
        fixture { client, _, override ->
            val started = CountDownLatch(1); val release = CountDownLatch(1)
            override(object : Dispatcher() { override fun dispatch(r: RecordedRequest): MockResponse {
                started.countDown(); check(release.await(5, TimeUnit.SECONDS))
                return MockResponse().setBody(TcJson.encodeToString(WaChatsPage.serializer(), WaChatsPage(chats = listOf(chat, other))))
            } })
            val pending = async(Dispatchers.IO) { runCatching { client.waChats(null, null, null, false, null) } }
            try {
                assertTrue(started.await(5, TimeUnit.SECONDS)); client.revokeWaPrivacy(chat.accountId, listOf(chat.jid)); release.countDown()
                assertTrue(pending.await().isFailure)
                assertEquals(listOf(other), client.state.value.data!!.waInbox)
                assertEquals("keep", client.state.value.data!!.conversations.single().id)
                assertEquals(2, client.waChats(null, null, null, false, null).chats.size)
                assertTrue(client.state.value.waPrivacy.allows(WaInbox.key(chat)))
            } finally { release.countDown() }
        }
    }

    @Test fun `denied messages purge account source files and repeated calls fail closed`() = runBlocking {
        fixture { client, _, override ->
            var calls = 0
            override(object : Dispatcher() { override fun dispatch(r: RecordedRequest): MockResponse { calls++; return MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found"}}""") } })
            val file = java.io.File.createTempFile("wa-privacy-", ".tmp").apply { writeText("synthetic") }
            client.trackWaFile(WaInbox.key(chat), file)
            assertTrue(runCatching { client.waMessages(chat) }.isFailure)
            assertFalse(file.exists()); assertFalse(client.state.value.waPrivacy.allows(WaInbox.key(chat)))
            assertTrue(runCatching { client.waMessages(chat) }.isFailure); assertEquals(1, calls)
            assertEquals(listOf(other), client.state.value.data!!.waInbox)
        }
    }

    @Test fun `held optimistic mutation cannot roll revoked row back on failure`() = runBlocking {
        fixture { client, _, override ->
            val started = CountDownLatch(1); val release = CountDownLatch(1)
            override(object : Dispatcher() { override fun dispatch(r: RecordedRequest): MockResponse {
                started.countDown(); check(release.await(5, TimeUnit.SECONDS)); return MockResponse().setResponseCode(500).setBody("{}")
            } })
            val pending = async(Dispatchers.IO) { runCatching { client.waSetInbox(chat, pinned = true) } }
            try {
                assertTrue(started.await(5, TimeUnit.SECONDS)); client.revokeWaPrivacy(chat.accountId, reset = true); release.countDown()
                assertTrue(pending.await().isFailure); assertEquals(listOf(other), client.state.value.data!!.waInbox)
            } finally { release.countDown() }
        }
    }
    @Test fun `held bootstrap and gg response cannot restore content revoked during request`() = runBlocking {
        for (bootstrap in listOf(true, false)) fixture { client, _, override ->
            val started = CountDownLatch(1); val release = CountDownLatch(1)
            override(object : Dispatcher() { override fun dispatch(r: RecordedRequest): MockResponse {
                started.countDown(); check(release.await(5, TimeUnit.SECONDS))
                return MockResponse().setBody(if (bootstrap)
                    TcJson.encodeToString(BootstrapDTO.serializer(), BootstrapDTO(me = UserDTO(id = "fixture-user"), waInbox = listOf(chat, other), conversations = listOf(ConversationDTO(id = "keep"))))
                    else """{"session":1,"messages":[{"id":"secret","body":"synthetic"}]}""")
            } })
            val pending = async(Dispatchers.IO) { runCatching { if (bootstrap) client.loadBootstrap() else client.ggSide(WaInbox.key(chat)) } }
            try {
                assertTrue(started.await(5, TimeUnit.SECONDS)); client.revokeWaPrivacy(chat.accountId, listOf(chat.jid)); release.countDown()
                val result = pending.await()
                if (bootstrap) assertTrue(result.isSuccess) else assertTrue(result.isFailure)
                assertEquals(listOf(other), client.state.value.data!!.waInbox)
            } finally { release.countDown() }
        }
    }

    @Test fun `ready account refreshes a list that completed before account validation`() = runBlocking {
        fixture { client, _, override ->
            client.revokeWaPrivacy(chat.accountId, reset = true)
            val revision = client.state.value.waRevision
            override(object : Dispatcher() { override fun dispatch(r: RecordedRequest) = MockResponse().setBody("""{"accounts":[{"id":"fixture-a","privacyReady":true}]}""") })
            client.waAccounts()
            assertTrue(client.state.value.waPrivacy.allows(WaInbox.key(chat)))
            assertTrue(client.state.value.waRevision > revision)
        }
    }

    @Test fun `mixed account readiness applies atomically in either order and purges reset files`() = runBlocking {
        for (reverse in listOf(false, true)) fixture { client, _, override ->
            client.revokeWaPrivacy(other.accountId, reset = true)
            val file = java.io.File.createTempFile("wa-mixed-", ".tmp").apply { writeText("synthetic") }
            client.trackWaFile(WaInbox.key(chat), file)
            val entries = listOf("""{"id":"fixture-a","privacyReady":false}""", """{"id":"fixture-b","privacyReady":true}""")
            override(object : Dispatcher() { override fun dispatch(r: RecordedRequest) = MockResponse().setBody("""{"accounts":[${(if (reverse) entries.reversed() else entries).joinToString(",")}]}""") })
            client.waAccounts()
            assertFalse(client.state.value.waPrivacy.allows(WaInbox.key(chat)))
            assertTrue(client.state.value.waPrivacy.allows(WaInbox.key(other)))
            assertFalse(file.exists())
            assertTrue(client.state.value.data!!.waInbox.isEmpty())
            assertEquals("keep", client.state.value.data!!.conversations.single().id)
        }
    }

    @Test fun `held refresh never dispatches private request after lock or reset even if unlocked`() = runBlocking {
        for (retry in listOf(false, true)) for (reset in listOf(false, true)) for (unlock in listOf(false, true)) for (media in listOf(false, true)) {
            val clock = java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis())
            fixture(now = clock::get) { client, _, override ->
                val started = CountDownLatch(1); val release = CountDownLatch(1)
                val privateCalls = java.util.concurrent.atomic.AtomicInteger()
                val file = java.io.File.createTempFile("wa-refresh-", ".tmp")
                override(object : Dispatcher() { override fun dispatch(r: RecordedRequest): MockResponse {
                    val path = r.requestUrl!!.encodedPath
                    if (path == "$AUTH_BASE_PATH/refresh") {
                        started.countDown(); check(release.await(5, TimeUnit.SECONDS))
                        return MockResponse().setBody("""{"accessToken":"fixture-new","accessExpiresAt":"2199-01-01T00:00:00Z","refreshToken":"fixture-refresh","sessionId":"fixture","user":{"id":"fixture-user"}}""")
                    }
                    if (path.endsWith("/accounts")) return MockResponse().setBody("""{"accounts":[{"id":"fixture-a","privacyReady":true}]}""")
                    if (path.endsWith("/chats")) return MockResponse().setBody(TcJson.encodeToString(WaChatsPage.serializer(), WaChatsPage(chats = listOf(chat))))
                    val calls = privateCalls.incrementAndGet()
                    return MockResponse().setResponseCode(if (retry && calls == 1) 401 else 200).setBody("{}")
                } })
                if (!retry) clock.set(java.time.Instant.parse("2100-01-01T00:00:00Z").toEpochMilli())
                val pending = async(Dispatchers.IO) { runCatching {
                    if (media) client.downloadAttachment("/whatsapp/media/fixture-a/123%3A7%40lid/m1", file) else client.waMessages(chat)
                } }
                try {
                    assertTrue(started.await(5, TimeUnit.SECONDS))
                    client.revokeWaPrivacy(chat.accountId, if (reset) emptyList() else listOf(chat.jid), reset)
                    if (unlock) {
                        clock.set(System.currentTimeMillis())
                        client.waAccounts(); client.waChats(chat.accountId, null, null, false, null)
                        assertTrue(client.state.value.waPrivacy.allows(WaInbox.key(chat)))
                    }
                    release.countDown()
                    assertTrue(pending.await().isFailure)
                    assertEquals("retry=$retry reset=$reset unlock=$unlock media=$media", if (retry) 1 else 0, privateCalls.get())
                    if (media) assertFalse(file.exists())
                } finally { release.countDown(); file.delete() }
            }
        }
    }

    @Test fun `signout purges all tracked WA sources and emits cleanup before resetting state`() = runBlocking {
        fixture { client, _, _ ->
            val file = java.io.File.createTempFile("wa-logout-", ".tmp").apply { writeText("synthetic") }
            val unlisted = java.io.File.createTempFile("wa-unlisted-", ".tmp").apply { writeText("synthetic") }
            val canonical = java.io.File.createTempFile("canonical-", ".tmp").apply { writeText("keep") }
            client.trackWaFile(WaInbox.key(chat), file)
            client.trackWaFile("wa:unlisted:synthetic@lid", unlisted)
            val events = mutableListOf<ClientSignal>()
            val cleanup = async(start = CoroutineStart.UNDISPATCHED) { client.signals.onEach { events += it }.first { it is ClientSignal.SignedOut } }
            try {
                client.logout(); withTimeout(2000) { cleanup.await() }
                assertFalse(file.exists()); assertFalse(unlisted.exists()); assertTrue(canonical.exists())
                assertEquals(SessionStatus.ANONYMOUS, client.state.value.status)
                assertTrue(events.filterIsInstance<ClientSignal.WaPrivacyChanged>().any { it.accountId == chat.accountId && it.reset })
                assertTrue(events.filterIsInstance<ClientSignal.WaPrivacyChanged>().any { it.accountId == "unlisted" && it.reset })
                assertTrue(events.last() is ClientSignal.SignedOut)
            } finally { cleanup.cancel(); file.delete(); unlisted.delete(); canonical.delete() }
        }
    }

}
