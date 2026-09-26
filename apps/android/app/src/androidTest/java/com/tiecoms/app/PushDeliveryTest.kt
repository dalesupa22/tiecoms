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
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Runs without login, a backend or Firebase credentials. Calls the real FCM callback. */
@RunWith(AndroidJUnit4::class)
class PushDeliveryTest {
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        else GrantPermissionRule.grant()

    @Test fun callbackPostsGroupNotificationWithoutMainThreadOrAvatarNetwork() = verifyDelivery("message")

    @Test fun callbackPostsSidechatNotificationWithReplyAndDeepLink() = verifyDelivery("side")

    private fun verifyDelivery(type: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.waitForIdleSync()
        val container = context.container
        assertFalse("Test needs a background process without an activity", container.foreground)
        val manager = context.getSystemService(NotificationManager::class.java)
        val conversation = "push-test-${UUID.randomUUID()}"
        val service = TcMessagingService()
        ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
            .apply { isAccessible = true }.invoke(service, context)
        val message = RemoteMessage.Builder("synthetic-test").setData(mapOf(
            "type" to type, "title" to "Synthetic group", "subtitle" to "Synthetic participant",
            "body" to "Background delivery regression", "badge" to "3",
            "conversationId" to conversation, "messageId" to UUID.randomUUID().toString(),
            "authorId" to "synthetic-author", "authorName" to "Synthetic participant",
            "authorAvatarUrl" to "https://127.0.0.1:1/unavailable-avatar.png",
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
        } finally {
            releaseMain.countDown()
            manager.cancel(conversation.hashCode())
        }
    }
}
