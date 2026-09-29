package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real client preferences/session restoration plus two competing presentation callbacks; no device/network provider. */
class NoticeDeliveryRaceTest {
    private val server = MockWebServer()
    private var client: TieComsClient? = null
    private var user = "A"
    private var clock = Instant.parse("2026-09-29T04:00:00Z").toEpochMilli() // 23:00 Bogotá
    private var blocks = "[]"
    private val secrets = MemorySecretStore()
    private val storage = MemoryStorage()
    private var sessionEnded: () -> Unit = {}
    @After fun close() { client?.close(); server.shutdown() }

    private fun start(saved: Boolean = false): TieComsClient {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val body = when (r.requestUrl!!.encodedPath) {
                    "$AUTH_BASE_PATH/login", "$AUTH_BASE_PATH/refresh" -> """{"accessToken":"synthetic","refreshToken":"synthetic","sessionId":"session-$user","user":{"id":"$user"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"$user","sleep":{"on":true,"start":"22:00","end":"07:00","tz":"America/Bogota","tzAuto":false}},"conversations":[{"id":"group","kind":"group","memberIds":["$user","peer"],"lastMessageSeq":1,"lastReadSeq":1}]}"""
                    "/api/v1/conversations/group/messages" -> """{"messages":[{"id":"m","conversationId":"group","seq":1,"authorId":"peer","body":"Synthetic applied"}],"hasMore":false,"lastEventSeq":1}"""
                    "/api/v1/conversations/group/events" -> """{"events":[],"lastEventSeq":1}"""
                    "/api/v1/blocks" -> """{"userIds":$blocks}"""
                    "/api/v1/me/dnd" -> return MockResponse().setResponseCode(404).setBody("{}") // supported local-only compatibility
                    else -> "{}"
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        if (saved) secrets.set("synthetic")
        val c = TieComsClient(server.url("/").toString().trimEnd('/'), "QA", storage, secrets,
            OkHttpClient(), now = { clock }, onNoticeSessionEnded = { sessionEnded() })
        client = c
        if (!saved) runBlocking { c.login("qa@example.test", "synthetic") }
        return c
    }
    private fun push(id: String = "m", mention: Boolean = false) = PushMessage(
        if (mention) "mention" else "message", "Synthetic", "", "Synthetic", 1, "group", "TC_MESSAGE", "group", id, "peer", "Peer", null, null, null)
    private fun context(c: TieComsClient, id: String = "m") = c.noticeContext("group", id, "peer", true, "group")

    @Test fun `real sleep manual DND and blocking agree across transports`() {
        val c = start()
        for (at in listOf("2026-09-29T04:00:00Z", "2026-09-29T11:59:00Z")) {
            clock = Instant.parse(at).toEpochMilli()
            for (pushFirst in listOf(true, false)) {
                val ledger = NoticeLedger(); var posts = 0
                fun fcm() = Notices.forPush(ledger, push(mention = true), context(c), present = { posts++; true })
                fun socket() = Notices.forLive(ledger, "m", context(c), true, present = { posts++; true })
                assertEquals(Notices.Outcome.DND, if (pushFirst) fcm() else socket())
                assertEquals(Notices.Outcome.DUPLICATE, if (pushFirst) socket() else fcm())
                assertEquals(0, posts)
            }
        }
        clock = Instant.parse("2026-09-29T12:00:00Z").toEpochMilli()
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(NoticeLedger(), push(), context(c)))
        runBlocking { c.setDnd("2026-09-29T13:00:00Z") }
        assertEquals(Notices.Outcome.DND, Notices.forLive(NoticeLedger(), "m", context(c), true))
        runBlocking { c.setDnd(null); blocks = "[\"peer\"]"; c.loadBlocks() }
        for (p in listOf(push(), push(mention = true))) {
            assertEquals(Notices.Outcome.BLOCKED, Notices.forPush(NoticeLedger(), p, context(c)))
            assertEquals(Notices.Outcome.BLOCKED, Notices.forLive(NoticeLedger(), "m", context(c), p.type == "mention"))
        }
    }


    @Test fun `applied visible message receives exactly one sound in either order`() {
        val c = start(); clock = Instant.parse("2026-09-29T15:00:00Z").toEpochMilli()
        runBlocking { c.openConversation("group") }
        val ctx = context(c)
        assertTrue(ctx.openAndLoaded)
        assertFalse(c.noticeContext("group", "absent", "peer", true, "group").openAndLoaded)
        for (pushFirst in listOf(true, false)) {
            val ledger = NoticeLedger(); var receives = 0; var posts = 0
            fun fcm() = Notices.forPush(ledger, push(), ctx,
                opened = { receives++ }, present = { posts++; true })
            fun socket() = Notices.forLive(ledger, "m", ctx, false,
                opened = { receives++ }, present = { posts++; true })
            assertEquals(Notices.Outcome.OPEN, if (pushFirst) fcm() else socket())
            assertEquals(Notices.Outcome.DUPLICATE, if (pushFirst) socket() else fcm())
            assertEquals(1, receives); assertEquals(0, posts)
        }
        for (pushFirst in listOf(true, false)) {
            val silentLedger = NoticeLedger(); var disabledSounds = 0
            val silent = ctx.copy(soundsEnabled = false)
            fun fcm() = Notices.forPush(silentLedger, push(), silent, opened = { disabledSounds++ })
            fun socket() = Notices.forLive(silentLedger, "m", silent, false, opened = { disabledSounds++ })
            if (pushFirst) { fcm(); socket() } else { socket(); fcm() }
            assertEquals("The dispatch honors the app sounds preference", 0, disabledSounds)
        }
        val ledger = NoticeLedger(); var receives = 0
        Notices.forPush(ledger, push(), ctx.copy(dnd = true), opened = { receives++ })
        Notices.forLive(ledger, "m", ctx, false, opened = { receives++ })
        assertEquals("A silenced first decision cannot produce a late receive sound", 0, receives)
    }

    @Test fun `failed publisher leaves fallback and competing transports publish once`() {
        val ledger = NoticeLedger(); val ctx = Notices.PushContext(false, false, false, false, null, false, clock)
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val posts = AtomicInteger()
        val pool = Executors.newFixedThreadPool(2)
        try {
            val first = pool.submit<Notices.Outcome> { Notices.forLive(ledger, "m", ctx, false, present = {
                entered.countDown(); check(release.await(2, TimeUnit.SECONDS)); false
            }) }
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            val fallback = pool.submit<Notices.Outcome> { Notices.forPush(ledger, push(), ctx, present = { posts.incrementAndGet(); true }) }
            release.countDown()
            assertEquals(Notices.Outcome.NOT_DELIVERED, first.get(3, TimeUnit.SECONDS))
            assertEquals(Notices.Outcome.SHOW, fallback.get(3, TimeUnit.SECONDS))
            assertEquals(Notices.Outcome.DUPLICATE, Notices.forLive(ledger, "m", ctx, false, present = { posts.incrementAndGet(); true }))
            assertEquals(1, posts.get())
        } finally { release.countDown(); pool.shutdownNow() }
    }

    @Test fun `queued session A cannot publish or repopulate session B ledger`() {
        val c = start(); clock = Instant.parse("2026-09-29T15:00:00Z").toEpochMilli()
        val ledger = NoticeLedger(); val a = c.noticeGeneration
        c.withNoticeSession(a) { Notices.silenced(ledger, "m", c to a) }
        runBlocking { c.logout(); user = "B"; c.login("b@example.test", "synthetic") }
        var posts = 0
        assertNull(c.withNoticeSession(a) { posts++; Notices.silenced(ledger, "other", c to a) })
        val b = c.noticeGeneration
        assertEquals(Notices.Outcome.SHOW, c.withNoticeSession(b) {
            Notices.forPush(ledger, push(), context(c), c to b, present = { posts++; true })
        })
        assertEquals(1, posts)
        assertNull(ledger.decision("other"))
        runBlocking { c.logout() }
        assertNull(c.withNoticeSession(c.noticeGeneration) { posts++ })
        assertEquals(1, posts)
    }

    @Test fun `cold refresh retains a legitimate FCM decision and logout invalidates its owner`() {
        val c = start(saved = true); val before = c.noticeGeneration; val ledger = NoticeLedger()
        val cold = Notices.PushContext(false, false, false, false, null, false, clock)
        assertEquals(Notices.Outcome.SHOW, c.withNoticeSession(before) { Notices.forPush(ledger, push(), cold, c to before) })
        runBlocking { c.start() }
        assertEquals(before, c.noticeGeneration)
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forLive(ledger, "m", cold, false, c to c.noticeGeneration))
        runBlocking { c.logout() }
        assertNull(c.withNoticeSession(before) { error("Old session must not run") })
    }

    @Test fun `cancelled notification stays deduplicated until the session resets`() {
        val ledger = NoticeLedger(); val ctx = Notices.PushContext(false, false, false, false, null, false, clock)
        var visible = false
        Notices.forPush(ledger, push(), ctx, present = { visible = true; true })
        ledger.cancel { visible = false }
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forLive(ledger, "m", ctx, false, present = { visible = true; true }))
        assertFalse(visible)
        ledger.clear()
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push(), ctx))
    }

    @Test fun `reminder then message retains both notifications for the same account`() {
        for (legacy in listOf(false, true)) {
            val ledger = NoticeLedger(); val owner = Any(); var clears = 0
            if (legacy) ledger.claim("soon:event", NoticeLedger.Decision.SHOWN)
            else ledger.deliver(owner, "soon:event", { Notices.Outcome.SHOW }, ownerChanged = { clears++ }) { true }
            assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push(),
                Notices.PushContext(false, false, false, false, null, false, clock), owner,
                ownerChanged = { clears++ }))
            assertEquals(0, clears)
            assertEquals(NoticeLedger.Decision.SHOWN, ledger.decision("soon:event"))
            ledger.deliver(Any(), "other", { Notices.Outcome.SHOW }, ownerChanged = { clears++ }) { true }
            assertEquals("A real account transition still clears old notifications", 1, clears)
            assertNull(ledger.decision("soon:event"))
        }
    }

    @Test fun `delayed logout clears A after login B but does not clear B notification`() {
        val c = start(); clock = Instant.parse("2026-09-29T15:00:00Z").toEpochMilli()
        val signalScope = CoroutineScope(Dispatchers.Unconfined)
        var signedOut: ClientSignal.SignedOut? = null
        signalScope.launch { c.signals.collect { if (it is ClientSignal.SignedOut) signedOut = it } }
        try {
            for (bFirst in listOf(false, true)) {
                val ledger = NoticeLedger(); val a = c.noticeGeneration; var shown: String? = null
                Notices.forPush(ledger, push(), context(c), c to a, present = { shown = "A"; true })
                runBlocking { c.logout(); user = if (user == "A") "B" else "A"; c.login("b@example.test", "synthetic") }
                assertEquals(a, signedOut!!.generation)
                val b = c.noticeGeneration
                fun showB() = Notices.forPush(ledger, push(), context(c), c to b,
                    ownerChanged = { shown = null }, present = { shown = "B"; true })
                if (bFirst) showB()
                val cleared = ledger.clearOwned(c to signedOut!!.generation) { shown = null }
                assertEquals(!bFirst, cleared)
                if (bFirst) assertEquals("B", shown) else { assertNull(shown); showB() }
                assertEquals("B", shown)
                assertEquals(NoticeLedger.Decision.SHOWN, ledger.decision("m"))
            }
        } finally { signalScope.cancel() }
    }

    @Test fun `cold OS notification with no ledger owner is cleared synchronously before another login`() {
        var shown: String? = "A from previous process"
        var clears = 0
        sessionEnded = { shown = null; clears++ }
        val c = start(saved = true)
        runBlocking { c.start() }
        assertEquals("First cold refresh keeps legitimate previous notifications", "A from previous process", shown)
        assertEquals(0, clears)
        runBlocking { c.logout() }
        assertNull("Cleanup does not depend on a populated ledger or a main-thread signal collector", shown)
        runBlocking { user = "B"; c.login("b@example.test", "synthetic") }
        shown = "B"
        assertEquals("B", shown)
        val beforeClose = clears
        c.close()
        assertNull(shown)
        assertEquals(beforeClose + 1, clears)
    }
}
