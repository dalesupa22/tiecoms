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
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * Incidencia 28-sep-2026: el GET del DM devolvió 502 durante el reemplazo del API. El chat real (Compose + cliente
 * HTTP) reintenta con «chaggu se está actualizando, reintentando…», conserva el borrador y carga; un 403 muestra
 * su mensaje sin reintentar. Servidor sintético en proceso: sin cuentas ni mensajes de producción.
 */
@RunWith(AndroidJUnit4::class)
class ChatRecoveryUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private lateinit var client: TieComsClient
    private val writes = CopyOnWriteArrayList<String>()

    @After fun close() { if (::client.isInitialized) client.close(); server.shutdown() }

    private fun serve(messages: (Int) -> MockResponse): AtomicInteger {
        val gets = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                if (r.method != "GET") writes += "${r.method} $path"
                val body = when (path) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA"},"people":[{"id":"peer","name":"Synthetic Peer"}],"conversations":[{"id":"dm-qa","kind":"direct","memberIds":["me","peer"],"lastMessageSeq":2,"lastReadSeq":2,"canPost":true}]}"""
                    "/api/v1/conversations/dm-qa/messages" -> return messages(gets.incrementAndGet())
                    "/api/v1/conversations/dm-qa/events" -> """{"events":[],"lastEventSeq":2}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/issues" -> """{"issues":[]}"""
                    "/api/v1/calendar/events" -> """{"events":[]}"""
                    "/api/v1/conversations/dm-qa/pins" -> """{"messageIds":[]}"""
                    "/api/v1/reminders" -> """{"reminders":[]}"""
                    "/api/v1/scheduled" -> """{"scheduled":[]}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Recovery UI", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        runBlocking { client.login("qa@example.test", "synthetic") }
        compose.setContent {
            CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
                TieComsTheme { ConversationScreen("dm-qa", onBack = {}, onDetails = {}, onOpenConversation = { _, _ -> }, onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}) }
            }
        }
        return gets
    }

    private val page get() = MockResponse().setBody("""{"messages":[
        {"id":"m1","conversationId":"dm-qa","seq":1,"authorId":"peer","body":"Synthetic one","createdAt":"2026-09-28T15:09:00Z"},
        {"id":"m2","conversationId":"dm-qa","seq":2,"authorId":"peer","body":"Synthetic two after the release","createdAt":"2026-09-28T15:09:30Z"}],
        "hasMore":false,"lastEventSeq":2}""")

    private fun text(id: Int) = compose.activity.getString(id)

    private fun shot(name: String) {
        val ins = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        ins.uiAutomation.takeScreenshot()?.let { b ->
            java.io.File(ins.targetContext.getExternalFilesDir(null), "$name.png").outputStream().use { b.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test fun badGatewayRetriesWithClearTextKeepsDraftAndLoads() {
        val ok = java.util.concurrent.atomic.AtomicBoolean(false)
        val gets = serve { _ ->
            if (!ok.get()) MockResponse().setResponseCode(502).setHeader("content-type", "text/html").setBody("<html><title>502 Bad Gateway</title><body>nginx</body></html>")
            else page
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("chatRecovering").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(text(R.string.chat_updating_retrying)).assertIsDisplayed()
        compose.onNodeWithTag("chatRetryNow").assertIsDisplayed()
        assertTrue("Nunca el texto crudo del proxy", compose.onAllNodesWithText("Bad Gateway", substring = true, ignoreCase = true).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithText("HTTP 502", substring = true).fetchSemanticsNodes().isEmpty())
        // La persona escribe mientras el API vuelve.
        val draft = "Borrador sintético durante el despliegue"
        compose.onNodeWithTag("composer").performTextInput(draft)
        shot("chat-recovering-502")
        // Reintentos automáticos: al menos dos 502 antes de que el API vuelva.
        compose.waitUntil(10_000) { gets.get() >= 2 }
        ok.set(true)
        compose.waitUntil(20_000) { client.state.value.conversations["dm-qa"]?.loaded == true }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Synthetic two after the release").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer").assertTextContains(draft)
        assertTrue(compose.onAllNodesWithTag("chatRecovering").fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithTag("chatLoadError").fetchSemanticsNodes().isEmpty())
        shot("chat-recovered")
        // Sin envíos ni lecturas que no se vieron: solo el login escribe (lastReadSeq ya estaba en 2).
        assertEquals(listOf("POST $AUTH_BASE_PATH/login"), writes.toList())
    }

    @Test fun forbiddenShowsItsMessageWithoutRetrying() {
        val gets = serve { MockResponse().setResponseCode(403).setBody("""{"error":{"code":"forbidden","message":"Synthetic: you are not in this chat"}}""") }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("chatLoadError").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("chatRetry").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithTag("chatRecovering").fetchSemanticsNodes().isEmpty())
        Thread.sleep(2_500)
        assertEquals("Un 403 no se reintenta solo", 1, gets.get())
        val shown = compose.onAllNodesWithText("Synthetic: you are not in this chat").fetchSemanticsNodes().isNotEmpty() ||
            compose.onAllNodesWithText(text(R.string.err_forbidden)).fetchSemanticsNodes().isNotEmpty()
        assertTrue("Muestra el mensaje del error permanente", shown)
    }
}
