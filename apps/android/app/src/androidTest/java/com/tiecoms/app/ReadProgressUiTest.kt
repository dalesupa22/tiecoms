package com.tiecoms.app

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiecoms.app.core.*
import com.tiecoms.app.ui.ConversationScreen
import com.tiecoms.app.ui.LocalClient
import com.tiecoms.app.ui.LocalContainer
import com.tiecoms.app.ui.theme.TieComsTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/** Actual Compose chat + HTTP client, synthetic in-process server; no production accounts or messages. */
@RunWith(AndroidJUnit4::class)
class ReadProgressUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private lateinit var client: TieComsClient
    private val reads = CopyOnWriteArrayList<Long>()
    private val pages = CopyOnWriteArrayList<Long>()
    @Volatile private var failOlder = true

    @After fun close() { if (::client.isInitialized) client.close(); server.shutdown() }

    @Test fun failedUnreadPageRetainsCursorThenLoadsAllPagesAndJumpDoesNotMarkSkippedMessages() {
        val messages = (1L..300L).map { MessageDTO(id = "read-$it", conversationId = "read-qa", seq = it,
            authorId = "other", body = "Synthetic pending message $it", createdAt = "2026-09-28T10:00:00Z") }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA"},"people":[{"id":"other","name":"Synthetic Reader"}],"conversations":[{"id":"read-qa","kind":"group","name":"Read regression","memberIds":["me","other"],"lastMessageSeq":300,"lastReadSeq":0,"unread":300}]}"""
                    path == "/api/v1/conversations/read-qa/messages" -> {
                        val before = r.requestUrl!!.queryParameter("before")?.toLong() ?: 301L
                        pages += before
                        if (failOlder && before == 151L) return MockResponse().setResponseCode(503).setBody("{}")
                        val page = messages.filter { it.seq < before }.takeLast(50)
                        TcJson.encodeToString(MessagesPage.serializer(), MessagesPage(page, page.first().seq > 1, 0))
                    }
                    path == "/api/v1/conversations/read-qa/read" -> {
                        reads += TcJson.parseToJsonElement(r.body.readUtf8()).jsonObject["seq"]!!.jsonPrimitive.long
                        "{}"
                    }
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path == "/api/v1/reminders" -> """{"reminders":[]}"""
                    path == "/api/v1/scheduled" -> """{"scheduled":[]}"""
                    path == "/api/v1/issues" -> """{"issues":[]}"""
                    path == "/api/v1/calendar/events" -> """{"events":[]}"""
                    path == "/api/v1/conversations/read-qa/pins" -> """{"messageIds":[]}"""
                    path == "/api/v1/conversations/read-qa/events" -> """{"events":[],"lastEventSeq":0}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Local read UI", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        runBlocking { client.login("reader@example.test", "synthetic") }
        compose.setContent {
            CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
                TieComsTheme { ConversationScreen("read-qa", onBack = {}, onDetails = {}, onOpenConversation = { _, _ -> }, onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}) }
            }
        }
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("readRetry").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        assertTrue("No read until all pages needed for the unread frontier load", reads.isEmpty())
        assertEquals(0L, client.meta("read-qa")!!.lastReadSeq)
        failOlder = false
        compose.onNodeWithTag("readRetry").onChildren().filter(hasClickAction()).onFirst().performClick()
        compose.waitUntil(15_000) { client.state.value.conversations["read-qa"]?.messages?.size == 300 }
        compose.waitUntil(10_000) { reads.isNotEmpty() }
        compose.waitForIdle()
        compose.onNodeWithTag("msg-1").assertIsDisplayed()
        val ins = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        ins.uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(ins.targetContext.getExternalFilesDir(null), "reader-first-unread.png").outputStream().use {
                bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        assertTrue("Loaded beyond the former three-page limit", pages.distinct().size >= 6)
        assertTrue("Only the initial viewport prefix was acknowledged", reads.max() in 1L..30L)
        compose.onNodeWithTag("messages").performScrollToIndex(0)
        compose.waitForIdle()
        Thread.sleep(700)
        assertTrue("Jumping to newest must retain the unseen middle", reads.max() < 300L)
        assertTrue(client.meta("read-qa")!!.unread > 0)
    }
}
