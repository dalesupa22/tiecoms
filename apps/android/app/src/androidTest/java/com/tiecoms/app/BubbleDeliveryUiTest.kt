package com.tiecoms.app

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ShortcutManager
import android.net.Uri
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.platform.TcMessagingService
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Real conversation UI and notification lifecycle against an opt-in local fixture. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 33)
class BubbleDeliveryUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val permission = GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val args = InstrumentationRegistry.getArguments()
    private val context get() = ins.targetContext
    private val manager get() = context.getSystemService(NotificationManager::class.java)
    private fun arg(key: String) = args.getString(key).orEmpty()

    private fun prepare(): String {
        assumeTrue("Local fixture is opt-in", arg("apiUrl").isNotBlank() && arg("conversationId").isNotBlank())
        assertTrue("Never run against production", arg("apiUrl").startsWith("http://10.0.2.2:"))
        ins.runOnMainSync { context.container.setDebugApiUrl(arg("apiUrl")) }
        runBlocking {
            val client = context.container.client.value
            withTimeout(20_000) { client.state.first { it.status != SessionStatus.LOADING } }
            if (client.state.value.status != SessionStatus.READY) client.login(arg("email"), arg("password"))
            withTimeout(20_000) { client.state.first { it.status == SessionStatus.READY } }
        }
        return arg("conversationId")
    }

    private fun post(id: String) {
        TcMessagingService.handle(context, mapOf(
            "type" to "message", "title" to "Chaggu · bubble verification",
            "subtitle" to "Synthetic local fixture", "body" to "The conversation remains open inside its bubble.",
            "conversationId" to id, "messageId" to UUID.randomUUID().toString(),
            "authorId" to "synthetic-review", "authorName" to "Synthetic review", "badge" to "1",
        ))
        compose.waitUntil(5_000) { manager.activeNotifications.any { it.id == id.hashCode() } }
    }

    @Test fun embeddedChatRetainsNotificationAndNormalChatClearsIt() {
        val id = prepare()
        post(id)
        val posted = manager.activeNotifications.single { it.id == id.hashCode() }.notification
        assertNotNull(posted.bubbleMetadata)
        assertEquals(id, posted.shortcutId)
        assertTrue(context.getSystemService(ShortcutManager::class.java).dynamicShortcuts.any { it.id == id && it.isDynamic })
        val uri = Uri.parse("chaggu://c/$id")
        val bubble = ActivityScenario.launch<BubbleActivity>(Intent(context, BubbleActivity::class.java).setData(uri))
        try {
            compose.waitUntilExactlyOneExists(hasTestTag("composer"), 15_000)
            // The old bug cancelled on ON_RESUME; allow that lifecycle and its binder work to settle.
            Thread.sleep(2_000)
            assertEquals(Lifecycle.State.RESUMED, bubble.state)
            assertTrue("Opening embedded content must preserve its backing notification",
                manager.activeNotifications.any { it.id == id.hashCode() })
        } finally { bubble.close() }
        assertTrue("Closing the embedded activity does not dismiss the conversation notification",
            manager.activeNotifications.any { it.id == id.hashCode() })

        val normal = ActivityScenario.launch<MainActivity>(Intent(Intent.ACTION_VIEW, uri, context, MainActivity::class.java))
        try {
            compose.waitUntilExactlyOneExists(hasTestTag("composer"), 15_000)
            compose.waitUntil(5_000) { manager.activeNotifications.none { it.id == id.hashCode() } }
        } finally { normal.close() }
    }

    /** Leaves one synthetic notification for a manual System UI bubble interaction; no FCM send. */
    @Test fun prepareBubbleForSystemUiInspection() {
        assumeTrue("Manual inspection is opt-in", arg("bubbleInspection") == "true")
        post(prepare())
    }
}
