package com.tiecoms.app

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.google.firebase.messaging.RemoteMessage
import com.tiecoms.app.platform.Notifier
import com.tiecoms.app.platform.TcMessagingService
import com.tiecoms.app.core.AUTH_BASE_PATH
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.ConnectionStatus
import kotlinx.coroutines.runBlocking
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Synthetic local session; no real backend, Firebase delivery or user messages. Calls the real FCM callback. */
@RunWith(AndroidJUnit4::class)
class PushDeliveryTest {
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        else GrantPermissionRule.grant()
    private val server = MockWebServer()
    private val avatarRequests = AtomicInteger()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var fixtureUser = "push-qa-a"

    @Before fun syntheticSession() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl!!.encodedPath == "$AUTH_BASE_PATH/login") {
                    fixtureUser = if (request.body.readUtf8().contains("b@example.test")) "push-qa-b" else "push-qa-a"
                }
                if (request.requestUrl!!.encodedPath.startsWith("/api/socket.io")) return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        socket = webSocket
                        webSocket.send("""0{"sid":"notice-qa","upgrades":[],"pingInterval":25000,"pingTimeout":20000}""")
                    }
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text.startsWith("40")) { webSocket.send("""40{"sid":"notice-qa"}"""); webSocket.send("""42["ready",{}]""") }
                    }
                })
                val body = when (request.requestUrl!!.encodedPath) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"synthetic","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"synthetic","sessionId":"$fixtureUser","user":{"id":"$fixtureUser"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"$fixtureUser","name":"Synthetic QA","dndUntil":null,"sleep":{"on":false,"start":"22:00","end":"07:00","tz":"America/Bogota","tzAuto":false}},"people":[{"id":"peer","name":"Synthetic peer","avatarUrl":"${server.url("/avatar.png")}"}],"conversations":[{"id":"notice-race","kind":"group","name":"Synthetic QA group","memberIds":["$fixtureUser","peer"],"lastMessageSeq":1,"lastReadSeq":1,"lastEventSeq":1}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/avatar.png" -> { avatarRequests.incrementAndGet(); return MockResponse().setResponseCode(503).setHeadersDelay(5, TimeUnit.SECONDS) }
                    else -> "{}"
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val container = instrumentation.targetContext.container
        val url = server.url("/").toString()
        instrumentation.runOnMainSync { container.setDebugApiUrl(url) }
        val deadline = SystemClock.elapsedRealtime() + 5_000
        while (container.client.value.state.value.status != SessionStatus.ANONYMOUS && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
        assertEquals(SessionStatus.ANONYMOUS, container.client.value.state.value.status)
        runBlocking { container.client.value.login("qa@example.test", "synthetic") }
        assertEquals(SessionStatus.READY, container.client.value.state.value.status)
        waitUntil("Synthetic socket online") { container.client.value.state.value.connection == ConnectionStatus.ONLINE }
        container.notifier.cancelAll()
        instrumentation.waitForIdleSync()
    }

    @After fun cleanSyntheticSession() {
        val container = InstrumentationRegistry.getInstrumentation().targetContext.container
        runBlocking { container.client.value.logout() }
        container.notifier.cancelAll()
        // Keep the debug endpoint local after the test; do not start a production session.
        container.client.value.close()
        server.shutdown()
    }

    @Test fun callbackPostsGroupNotificationWithoutMainThreadOrAvatarNetwork() = verifyDelivery("message")

    @Test fun callbackPostsSidechatNotificationWithReplyAndDeepLink() = verifyDelivery("side")

    @Test fun logoutClearsNotificationWithoutLedgerOwnerBeforeBAndLateSignalKeepsB() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val container = context.container
        val manager = context.getSystemService(NotificationManager::class.java)
        val conversation = "legacy-notice-qa"
        container.notifier.showMessage(conversation, "Synthetic old notice", "Synthetic previous process", true)
        container.notifier.ledger.clear() // Same state as OS notifications retained across a process restart.
        waitUntil("Previous OS notification exists") { manager.activeNotifications.any { it.id == conversation.hashCode() } }
        val blocked = CountDownLatch(1); val releaseMain = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post { blocked.countDown(); releaseMain.await(8, TimeUnit.SECONDS) }
        assertTrue(blocked.await(2, TimeUnit.SECONDS))
        try {
            runBlocking { container.client.value.logout() }
            waitUntil("Logout clears ownerless OS notification without waiting for main") { manager.activeNotifications.none { it.id == conversation.hashCode() } }
            runBlocking { container.client.value.login("b@example.test", "synthetic") }
            assertEquals("push-qa-b", container.client.value.myId)
            service(context).onMessageReceived(RemoteMessage.Builder("synthetic-test").setData(mapOf(
                "type" to "message", "title" to "Synthetic B", "body" to "New session notice",
                "conversationId" to conversation, "messageId" to "new-session-message", "authorId" to "peer", "authorName" to "Synthetic peer",
            )).build())
            waitUntil("New session notification exists") { manager.activeNotifications.any { it.id == conversation.hashCode() } }
        } finally { releaseMain.countDown() }
        instrumentation.waitForIdleSync()
        assertNotNull("Queued SignedOut from A cannot remove the new session's notice", manager.activeNotifications.firstOrNull { it.id == conversation.hashCode() })
        container.notifier.cancel(conversation)
    }

    @Test fun socketAndFcmInEitherOrderProduceOneNotificationAndOneLine() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val container = context.container
        assertFalse(container.foreground)
        val manager = context.getSystemService(NotificationManager::class.java)
        val service = service(context)
        for ((index, pushFirst) in listOf(true, false).withIndex()) {
            val seq = index + 2
            val id = "synthetic-$seq"
            val message = RemoteMessage.Builder("synthetic-test").setData(mapOf(
                "type" to "message", "title" to "Synthetic QA group", "body" to "Synthetic $seq", "badge" to "1",
                "conversationId" to "notice-race", "messageId" to id, "authorId" to "peer", "authorName" to "Synthetic peer",
                "authorAvatarUrl" to server.url("/avatar.png").toString(),
            )).build()
            fun local() { socket!!.send("""42["conv.event",{"conversationId":"notice-race","eventSeq":$seq,"type":"message.created","message":{"id":"$id","conversationId":"notice-race","seq":$seq,"authorId":"peer","body":"Synthetic $seq","createdAt":"2099-01-01T00:00:00Z"}}]""") }
            if (pushFirst) { service.onMessageReceived(message); local() }
            else {
                local()
                waitUntil("Socket notification") { manager.activeNotifications.any { it.id == "notice-race".hashCode() } }
                service.onMessageReceived(message)
            }
            waitUntil("Socket message applied to metadata") { container.client.value.meta("notice-race")?.lastMessageSeq == seq.toLong() }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            val shown = manager.activeNotifications.filter { it.id == "notice-race".hashCode() }
            assertEquals("Exactly one system notification in order pushFirst=$pushFirst", 1, shown.size)
            val lines = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(shown.single().notification)!!.messages
            assertEquals("The second transport must not append another line", 1, lines.size)
            assertEquals("Synthetic $seq", lines.single().text.toString())
            assertEquals("Neither transport needs avatar I/O", 0, avatarRequests.get())
            capture("notice-order-$pushFirst")
            container.notifier.cancel("notice-race")
            waitUntil("System confirms cancelled race notification") { manager.activeNotifications.none { it.id == "notice-race".hashCode() } }
        }
    }

    private fun waitUntil(label: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 5_000
        while (!condition() && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
        assertTrue(label, condition())
    }

    private fun service(context: Context) = TcMessagingService().also {
        ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
            .apply { isAccessible = true }.invoke(it, context)
    }

    private fun capture(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.executeShellCommand("cmd statusbar expand-notifications").close()
        try {
            Thread.sleep(350)
            // Gradle uninstalls the test application; shell-owned evidence must survive that cleanup.
            val shot = instrumentation.uiAutomation.executeShellCommand("screencap -p /sdcard/Download/$name.png")
            android.os.ParcelFileDescriptor.AutoCloseInputStream(shot).use { it.readBytes() }
        } finally { instrumentation.uiAutomation.executeShellCommand("cmd statusbar collapse").close() }
    }

    private fun verifyDelivery(type: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.waitForIdleSync()
        val container = context.container
        assertFalse("Test needs a background process without an activity", container.foreground)
        val manager = context.getSystemService(NotificationManager::class.java)
        val conversation = "push-test-${UUID.randomUUID()}"
        val service = service(context)
        val message = RemoteMessage.Builder("synthetic-test").setData(mapOf(
            "type" to type, "title" to "Synthetic group", "subtitle" to "Synthetic participant",
            "body" to "Background delivery regression", "badge" to "3",
            "conversationId" to conversation, "messageId" to UUID.randomUUID().toString(),
            "authorId" to "synthetic-author", "authorName" to "Synthetic participant",
            "authorAvatarUrl" to server.url("/avatar.png").toString(),
            "sideOfConversationId" to "synthetic-origin",
        )).build()

        // The callback runs on FCM's worker thread. Simulate a main thread that cannot
        // drain a detached coroutine, so only work completed by the callback can notify.
        val blocked = CountDownLatch(1)
        val releaseMain = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            blocked.countDown()
            releaseMain.await(8, TimeUnit.SECONDS)
        }
        assertTrue(blocked.await(2, TimeUnit.SECONDS))
        try {
            val started = SystemClock.elapsedRealtime()
            service.onMessageReceived(message)
            assertTrue("Callback must not wait for avatar I/O", SystemClock.elapsedRealtime() - started < 1_000)
            // NotificationManager's binder operation can complete asynchronously in system_server.
            val deadline = SystemClock.elapsedRealtime() + 1_000
            var shown = manager.activeNotifications.firstOrNull { it.id == conversation.hashCode() }
            while (shown == null && SystemClock.elapsedRealtime() < deadline) {
                Thread.sleep(20)
                shown = manager.activeNotifications.firstOrNull { it.id == conversation.hashCode() }
            }
            assertNotNull("Notification must exist while the main thread remains blocked", shown)
            val notification = shown!!.notification
            val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification)
            assertNotNull(style)
            assertTrue(style!!.isGroupConversation)
            assertEquals("Background delivery regression", style.messages.last().text.toString())
            assertEquals(conversation, notification.shortcutId)
            assertEquals(Notifier.CHANNEL_ID, notification.channelId)
            assertEquals(3, notification.number)
            assertNotNull("Tap retains its deep link", notification.contentIntent)
            assertEquals(2, notification.actions.size)
            assertEquals(Notifier.KEY_REPLY, notification.actions[0].remoteInputs.single().resultKey)
            service.onMessageReceived(message)
            assertEquals("Duplicate delivery must not append the message", 1,
                NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(
                    manager.activeNotifications.first { it.id == conversation.hashCode() }.notification
                )!!.messages.size)
            assertEquals("Publication uses a cached avatar or fallback without fetching", 0, avatarRequests.get())
            container.notifier.cancel(conversation)
            waitUntil("System confirms cancellation") { manager.activeNotifications.none { it.id == conversation.hashCode() } }
            service.onMessageReceived(message)
            assertNull("A cancelled chat must not be revived by the other transport", manager.activeNotifications.firstOrNull { it.id == conversation.hashCode() })
        } finally {
            releaseMain.countDown()
            manager.cancel(conversation.hashCode())
        }
        runBlocking { container.client.value.logout() }
        val loggedOut = RemoteMessage.Builder("synthetic-test").setData(message.data + ("messageId" to UUID.randomUUID().toString())).build()
        service.onMessageReceived(loggedOut)
        assertNull("Signed-out callback cannot publish another account's notification", manager.activeNotifications.firstOrNull { it.id == conversation.hashCode() })
    }
}
