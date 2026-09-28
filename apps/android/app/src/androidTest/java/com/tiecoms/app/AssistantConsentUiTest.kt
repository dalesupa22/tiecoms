package com.tiecoms.app

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiecoms.app.core.*
import com.tiecoms.app.ui.AssistantModel
import com.tiecoms.app.ui.AssistantPanel
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** Real dialog and HTTP client; local fake responses only, no account or AI provider. */
@RunWith(AndroidJUnit4::class)
class AssistantConsentUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<String>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @Volatile private var delayNextTurn = false
    private lateinit var client: TieComsClient
    private lateinit var model: AssistantModel

    @Before fun setup() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                var delay = false
                val body = when (request.path?.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"local-test","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local-test","sessionId":"local-test","user":{"id":"demo","name":"Ana"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"demo","name":"Ana"},"conversations":[]}"""
                    "/api/v1/reminders" -> """{"reminders":[]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/assistant/turn" -> {
                        delay = delayNextTurn; delayNextTurn = false
                        requests += request.body.readUtf8()
                        """{"reply":"Draft ready","actions":[{"id":"demo-action","kind":"send_message","status":"pending","target":"Demo","text":"Local draft","token":"local-only"}]}"""
                    }
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body).apply { if (delay) setBodyDelay(500, TimeUnit.MILLISECONDS) }
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Consent test", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { client.login("demo@example.test", "local-only") }
        client.setAssistantSpeak(false)
        compose.runOnUiThread { model = AssistantModel(client, compose.activity, scope) }
        compose.setContent { MaterialTheme { AssistantPanel(model, "Ana", {}) } }
        compose.runOnIdle { model.openPanel(false) }
    }

    @After fun teardown() {
        if (::model.isInitialized) compose.runOnUiThread { model.dispose() }
        scope.cancel()
        if (::client.isInitialized) client.close()
        server.shutdown()
    }

    private fun waitForCalls(count: Int) = compose.waitUntil(10_000) { requests.size == count && !model.busy }

    @Test fun cancelPreservesDictationAndCloseRequiresNewConsent() {
        compose.runOnIdle { model.ask("Keep this spoken draft", voice = true) }
        compose.onNodeWithTag("ggConsentDialog").assertExists()
        val ins = InstrumentationRegistry.getInstrumentation()
        ins.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(ins.targetContext.getExternalFilesDir(null), "gg-consent-1.6.5.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        compose.onNodeWithTag("ggConsentCancel").performClick()
        compose.runOnIdle {
            assertEquals("Keep this spoken draft", model.text)
            assertTrue(model.turns.isEmpty())
            assertTrue(requests.isEmpty())
            model.ask(model.text)
        }
        compose.onNodeWithTag("ggConsentAllow").performClick()
        waitForCalls(1)
        val body = TcJson.parseToJsonElement(requests.single()).jsonObject
        assertEquals(JsonPrimitive(true), body["aiConsent"])
        assertEquals("Keep this spoken draft", body["messages"]!!.jsonArray.last().jsonObject["content"]!!.jsonPrimitive.content)
        compose.runOnIdle { model.ask("Second request") }
        waitForCalls(2)
        compose.onNodeWithTag("ggConsentDialog").assertDoesNotExist()
        compose.runOnIdle { model.close(); model.openPanel(false); model.ask("New session draft") }
        compose.onNodeWithTag("ggConsentDialog").assertExists()
        compose.onNodeWithTag("ggConsentCancel").performClick()
        compose.runOnIdle { assertEquals("New session draft", model.text); assertEquals(2, requests.size) }
    }

    @Test fun cancelledRewriteKeepsActionAndDisposalResetsPermission() {
        compose.runOnIdle { model.ask("Write a draft") }
        compose.onNodeWithTag("ggConsentAllow").performClick()
        waitForCalls(1)
        compose.runOnIdle {
            // MainNav disposes this model at logout; permission must not survive its disposal.
            model.dispose(); model.openPanel(false)
            model.redo(model.pendingAll.single())
        }
        compose.onNodeWithTag("ggConsentDialog").assertExists()
        compose.onNodeWithTag("ggConsentCancel").performClick()
        compose.runOnIdle {
            assertEquals("pending", model.pendingAll.single().status)
            assertEquals(1, requests.size)
            assertTrue(model.text.isNotBlank())
        }
    }
    @Test fun cancelSuggestionPreservesExistingDraftAndAllowSendsSelectedRequest() {
        compose.runOnIdle { model.text = "My existing draft"; model.ask("Selected suggestion") }
        compose.onNodeWithTag("ggConsentCancel").performClick()
        compose.runOnIdle {
            assertEquals("My existing draft", model.text)
            assertTrue(requests.isEmpty())
            model.ask("Selected suggestion")
        }
        compose.onNodeWithTag("ggConsentAllow").performClick()
        waitForCalls(1)
        val body = TcJson.parseToJsonElement(requests.single()).jsonObject
        assertEquals("Selected suggestion", body["messages"]!!.jsonArray.last().jsonObject["content"]!!.jsonPrimitive.content)
    }

    @Test fun closingDiscardsLateReplyAndRequiresConsentAgain() {
        delayNextTurn = true
        compose.runOnIdle { model.ask("Request before closing") }
        compose.onNodeWithTag("ggConsentAllow").performClick()
        compose.waitUntil(5_000) { requests.size == 1 }
        compose.runOnIdle { model.close(); model.openPanel(false); model.ask("A new draft") }
        compose.onNodeWithTag("ggConsentDialog").assertExists()
        // Let the already-authorized HTTP reply arrive after the panel's session ended.
        Thread.sleep(700)
        compose.runOnIdle {
            assertTrue(model.turns.none { it.role == "assistant" })
            assertNull(model.error)
            assertFalse(model.busy)
            assertEquals("A new draft", model.text)
            assertEquals(1, requests.size)
        }
    }

}
