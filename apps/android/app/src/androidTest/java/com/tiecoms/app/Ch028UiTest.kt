package com.tiecoms.app

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.core.*
import com.tiecoms.app.ui.*
import com.tiecoms.app.ui.theme.TieComsTheme
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * CH028: en un grupo, tocar a quien escribió abre su tarjeta y «Enviar mensaje» abre el directo; los participantes
 * se ven arriba en Detalles; tocarme a mí abre «Tú» (POST /me/notes). Servidor sintético dentro del emulador.
 */
@RunWith(AndroidJUnit4::class)
class Ch028UiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private lateinit var client: TieComsClient
    private val posts = CopyOnWriteArrayList<String>()
    @After fun close() { if (::client.isInitialized) client.close(); server.shutdown() }

    private fun start() {
        val messages = listOf(
            MessageDTO(id = "m1", conversationId = "g", seq = 1, authorId = "ana", body = "Hola equipo", createdAt = "2026-11-02T10:00:00Z"),
            MessageDTO(id = "m2", conversationId = "g", seq = 2, authorId = "bob", body = "¿Cómo vamos?", createdAt = "2026-11-02T10:01:00Z"),
            MessageDTO(id = "m3", conversationId = "g", seq = 3, authorId = "me", body = "Bien", createdAt = "2026-11-02T10:02:00Z"),
        )
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"me","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"Danny QA"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"Danny QA"},"people":[{"id":"me","name":"Danny QA"},{"id":"ana","name":"Ana Ruiz"},{"id":"bob","name":"Bob Pérez"}],"conversations":[{"id":"g","kind":"group","name":"Equipo","memberIds":["me","ana","bob"],"lastMessageSeq":3,"lastReadSeq":3,"unread":0,"canPost":true}]}"""
                    path == "/api/v1/conversations/g/messages" -> TcJson.encodeToString(MessagesPage.serializer(), MessagesPage(messages, false, 0))
                    path == "/api/v1/chats" -> { posts += "chats " + r.body.readUtf8(); """{"id":"dm-ana","kind":"direct"}""" }
                    path == "/api/v1/me/notes" -> { posts += "notes"; """{"id":"self"}""" }
                    path == "/api/v1/conversations/g/read" -> "{}"
                    path == "/api/v1/conversations/g/pins" -> """{"messageIds":[]}"""
                    path == "/api/v1/conversations/g/topics" -> """{"topics":[]}"""
                    path == "/api/v1/conversations/g/events" -> """{"events":[],"lastEventSeq":0}"""
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path == "/api/v1/reminders" -> """{"reminders":[]}"""
                    path == "/api/v1/scheduled" -> """{"scheduled":[]}"""
                    path == "/api/v1/issues" -> """{"issues":[]}"""
                    path == "/api/v1/calendar/events" -> """{"events":[]}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "CH028 UI", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        runBlocking { client.login("qa@example.test", "synthetic") }
    }

    private fun shot(name: String) {
        compose.waitForIdle(); Thread.sleep(500)
        val ins = InstrumentationRegistry.getInstrumentation()
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "ch028-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun tocarAlAutorEnUnGrupoAbreSuDirecto() {
        start()
        var opened: String? = null
        compose.setContent {
            CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
                TieComsTheme { ConversationScreen("g", onBack = {}, onDetails = {}, onOpenConversation = { c, _ -> opened = c }, onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}) }
            }
        }
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("msg-3").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("avatar-1", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("personDirect").assertIsDisplayed()
        shot("tarjeta")
        compose.onNodeWithTag("personDirect").performClick()
        compose.waitUntil(10_000) { opened != null }
        assertEquals("dm-ana", opened)
        assertEquals(listOf("chats {\"userIds\":[\"ana\"]}"), posts.toList())
        // También tocando el nombre.
        compose.onNodeWithTag("author-2", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("personCard").assertExists()
        compose.onNodeWithTag("personDirect").assertIsDisplayed()
    }

    @Test fun participantesArribaEnDetallesYTocarmeAbreTu() {
        start()
        compose.setContent {
            CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
                TieComsTheme { DetailsScreen("g", onBack = {}, onOpenIssue = {}, onOpenEvent = {}, onOpenConversation = {}) }
            }
        }
        compose.waitForIdle()
        // Sin desplazar: los participantes están a la vista.
        compose.onNodeWithTag("person-ana").assertIsDisplayed()
        compose.onNodeWithTag("person-bob").assertIsDisplayed()
        shot("detalles")
        val data = client.state.value.data!!
        assertEquals("self", runBlocking { openDirect(client, data, "me") })
        assertTrue(posts.contains("notes"))
        assertTrue("nunca POST /chats conmigo solo", posts.none { it.startsWith("chats") })
    }
}
