package com.tiecoms.app

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.geometry.Offset
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

/**
 * 1.7.1: chat con un mensaje más alto que la pantalla (≈5 000 caracteres, 120 líneas) en medio de otros 39.
 * El desplazamiento vertical que empieza sobre la burbuja larga no se lo come el deslizar-para-responder,
 * no se pierde ningún mensaje, «Ver más» expande el texto y deslizar a la derecha abre la cita (no un sidechat).
 * Servidor sintético dentro del emulador; nada de producción.
 */
@RunWith(AndroidJUnit4::class)
class LongChatUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private lateinit var client: TieComsClient

    @After fun close() { if (::client.isInitialized) client.close(); server.shutdown() }

    private val longBody = (1..120).joinToString("\n") { "Línea $it del mensaje muy largo: " + "texto de relleno ".repeat(2) }

    private fun open() {
        val messages = (1L..40L).map { s ->
            MessageDTO(id = "long-$s", conversationId = "long-qa", seq = s, authorId = if (s % 3 == 0L) "me" else "other",
                body = if (s == 20L) longBody else "Mensaje corto $s", createdAt = "2026-09-28T10:%02d:00Z".format(s))
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA"},"people":[{"id":"me","name":"QA"},{"id":"other","name":"Ana Larga"}],"conversations":[{"id":"long-qa","kind":"group","name":"Largo","memberIds":["me","other"],"lastMessageSeq":40,"lastReadSeq":40,"unread":0,"canPost":true}]}"""
                    path == "/api/v1/conversations/long-qa/messages" -> {
                        val before = r.requestUrl!!.queryParameter("before")?.toLong() ?: 41L
                        val page = messages.filter { it.seq < before }.takeLast(50)
                        TcJson.encodeToString(MessagesPage.serializer(), MessagesPage(page, false, 0))
                    }
                    path == "/api/v1/conversations/long-qa/read" -> "{}"
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path == "/api/v1/reminders" -> """{"reminders":[]}"""
                    path == "/api/v1/scheduled" -> """{"scheduled":[]}"""
                    path == "/api/v1/issues" -> """{"issues":[]}"""
                    path == "/api/v1/calendar/events" -> """{"events":[]}"""
                    path == "/api/v1/conversations/long-qa/pins" -> """{"messageIds":[]}"""
                    path == "/api/v1/conversations/long-qa/topics" -> """{"topics":[]}"""
                    path == "/api/v1/conversations/long-qa/events" -> """{"events":[],"lastEventSeq":0}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Long chat UI", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        runBlocking { client.login("long@example.test", "synthetic") }
        compose.setContent {
            CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
                TieComsTheme { ConversationScreen("long-qa", onBack = {}, onDetails = {}, onOpenConversation = { _, _ -> }, onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}) }
            }
        }
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("msg-40").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
    }

    /** Posición sin recortar (boundsInRoot se recorta a la lista). */
    private fun top(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().positionInRoot.y
    private fun fullBounds(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().let { androidx.compose.ui.geometry.Rect(it.positionInRoot, androidx.compose.ui.geometry.Size(it.size.width.toFloat(), it.size.height.toFloat())) }
    private fun exists(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun shown(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().any { n ->
        val list = compose.onNodeWithTag("messages").fetchSemanticsNode().boundsInRoot
        n.boundsInRoot.bottom > list.top && n.boundsInRoot.top < list.bottom
    }

    /** Arrastre vertical (con un poco de deriva horizontal, como un dedo real) desde el centro de la lista. */
    private fun drag(dy: Float, dx: Float = 24f) {
        compose.onNodeWithTag("messages").performTouchInput {
            val start = center
            down(start)
            val steps = 12
            for (i in 1..steps) moveTo(start + Offset(dx * i / steps, dy * i / steps), delayMillis = 16)
            up()
        }
        compose.waitForIdle()
    }

    @Test fun verticalScrollOverLongBubbleReachesEveryMessage() {
        open()
        // «Ver más»: plegado a 30 líneas; al tocarlo queda entero (más alto que la pantalla).
        compose.onNodeWithTag("messages").performScrollToKey("m:long-20")
        compose.waitForIdle()
        val collapsedH = fullBounds("msg-20").height
        compose.onNodeWithTag("expand-20").performClick()
        compose.waitForIdle()
        val expandedH = fullBounds("msg-20").height
        assertTrue("Ver más agranda la burbuja ($collapsedH → $expandedH)", expandedH > collapsedH * 2)
        assertTrue("La burbuja expandida es más alta que la lista", expandedH > compose.onNodeWithTag("messages").fetchSemanticsNode().size.height)
        compose.onNodeWithTag("messages").performScrollToIndex(0)
        compose.waitForIdle()
        // Hacia arriba (lo viejo) hasta el primer mensaje, pasando con el dedo por encima de la burbuja larga.
        var overLong = 0
        var reachedFirst = false
        for (i in 0 until 80) {
            val list = compose.onNodeWithTag("messages").fetchSemanticsNode().boundsInRoot
            if (exists("msg-20") && fullBounds("msg-20").contains(list.center)) {
                overLong++
                val before = top("msg-20")
                drag(dy = list.height * 0.35f)
                if (exists("msg-20")) {
                    val after = top("msg-20")
                    assertTrue("El arrastre sobre la burbuja larga debe desplazar la lista ($before → $after)", after > before + 20f)
                }
                continue
            }
            if (shown("msg-1")) { reachedFirst = true; break }
            drag(dy = list.height * 0.35f)
        }
        assertTrue("Llegó al primer mensaje", reachedFirst)
        assertTrue("El dedo pasó varias veces por encima de la burbuja larga ($overLong)", overLong >= 2)
        // Nada quedó sin ver: se recorre de vuelta hasta el final y cada seq aparece.
        val seen = mutableSetOf<Long>()
        for (i in 0 until 80) {
            (1L..40L).filter { shown("msg-$it") }.forEach { seen += it }
            if (40L in seen) break
            drag(dy = -compose.onNodeWithTag("messages").fetchSemanticsNode().boundsInRoot.height * 0.35f)
        }
        assertEquals("Todos los mensajes se ven al recorrer el chat", (1L..40L).toSet(), seen)
        val ins = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        ins.uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(ins.targetContext.getExternalFilesDir(null), "long-chat.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test fun swipeRightQuotesReplyInsteadOfSidechat() {
        open()
        compose.onNodeWithTag("msg-38").performTouchInput {
            val start = Offset(width * 0.2f, height / 2f)
            down(start)
            for (i in 1..10) moveTo(start + Offset(viewConfiguration.touchSlop + 22f * i, 2f * i), delayMillis = 16)
            up()
        }
        compose.waitForIdle()
        compose.onNodeWithTag("replyBar").assertIsDisplayed()
        compose.onNodeWithTag("replyBar").assert(hasAnyDescendant(hasText("Mensaje corto 38", substring = true)))
        assertFalse("Deslizar ya no abre el sidechat", exists("sideStartSheet"))
        // Un deslizamiento corto (bajo el umbral) no hace nada.
        compose.onNodeWithTag("replyBar").onChildren().filter(hasClickAction()).onFirst().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("msg-37").performTouchInput {
            val start = Offset(width * 0.2f, height / 2f)
            down(start); moveTo(start + Offset(viewConfiguration.touchSlop + 30f, 0f), delayMillis = 32); up()
        }
        compose.waitForIdle()
        assertFalse("Bajo el umbral no se responde", exists("replyBar"))
    }
}
