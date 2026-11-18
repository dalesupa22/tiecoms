package com.tiecoms.app

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiecoms.app.core.*
import com.tiecoms.app.platform.Perf
import com.tiecoms.app.ui.ConversationScreen
import com.tiecoms.app.ui.LocalClient
import com.tiecoms.app.ui.LocalContainer
import com.tiecoms.app.ui.theme.TieComsTheme
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * CH035 (tanda 2): con un chat abierto, lo que pasa en OTRO chat (alguien escribe, llega un mensaje) no vuelve a
 * componer la pantalla ni sus burbujas. Lo que pasa en el chat abierto sí. Servidor sintético; nada de producción.
 */
@RunWith(AndroidJUnit4::class)
class RecomposicionUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private lateinit var client: TieComsClient

    @After fun close() { Perf.countCompositions = false; if (::client.isInitialized) client.close(); server.shutdown() }

    private fun open() {
        val messages = (1L..30L).map { s ->
            MessageDTO(id = "a-$s", conversationId = "abierto", seq = s, authorId = if (s % 3 == 0L) "me" else "other",
                body = "Mensaje $s", createdAt = "2026-09-28T10:%02d:00Z".format(s))
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA"},"people":[{"id":"me","name":"QA"},{"id":"other","name":"Ana Otra"},{"id":"third","name":"Luis Tercero"}],"conversations":[
                        {"id":"abierto","kind":"group","name":"Abierto","memberIds":["me","other","third"],"lastMessageSeq":30,"lastReadSeq":30,"canPost":true},
                        {"id":"ajeno","kind":"group","name":"Ajeno","memberIds":["me","other","third"],"lastMessageSeq":5,"lastReadSeq":5,"canPost":true}]}"""
                    path == "/api/v1/conversations/abierto/messages" -> TcJson.encodeToString(MessagesPage.serializer(), MessagesPage(messages, false, 0))
                    path.endsWith("/read") -> "{}"
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path == "/api/v1/reminders" -> """{"reminders":[]}"""
                    path == "/api/v1/scheduled" -> """{"scheduled":[]}"""
                    path == "/api/v1/issues" -> """{"issues":[]}"""
                    path == "/api/v1/calendar/events" -> """{"events":[]}"""
                    path.endsWith("/pins") -> """{"messageIds":[]}"""
                    path.endsWith("/topics") -> """{"topics":[]}"""
                    path.endsWith("/events") -> """{"events":[],"lastEventSeq":0}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Recomposición UI", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        runBlocking { client.login("recompose@example.test", "synthetic") }
        compose.setContent {
            CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
                TieComsTheme { ConversationScreen("abierto", onBack = {}, onDetails = {}, onOpenConversation = { _, _ -> }, onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}) }
            }
        }
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("msg-30").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        // Que terminen las cargas secundarias del arranque (asuntos, fijados, temas, eventos) antes de contar.
        Thread.sleep(1_500)
        compose.waitForIdle()
    }

    private fun typing(conv: String, user: String) = client.debugSocketEvent("typing", buildJsonObject { put("conversationId", conv); put("userId", user) })
    private fun message(conv: String, seq: Long, eventSeq: Long) = client.debugSocketEvent("conv.event", buildJsonObject {
        put("conversationId", conv); put("eventSeq", eventSeq); put("type", "message.created")
        put("message", buildJsonObject {
            put("id", "$conv-$seq"); put("conversationId", conv); put("seq", seq); put("authorId", "other")
            put("body", "Nuevo $seq"); put("kind", "text"); put("createdAt", "2026-09-28T11:%02d:00Z".format(seq))
        })
    })

    private fun settle(ms: Long) { Thread.sleep(ms); compose.waitForIdle() }

    /**
     * Cuenta las composiciones durante [block]. "own" = cambios del propio chat en ese rato que sí le tocan a la pantalla
     * (aquí, la franja de conexión: el socket no llega al servidor sintético y reintenta por su cuenta).
     */
    private fun measure(label: String, block: () -> Unit): Map<String, Int> {
        compose.waitForIdle()
        val own = java.util.concurrent.atomic.AtomicInteger()
        val watch = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launch {
            client.state.map { it.connection }.distinctUntilChanged().drop(1).collect { own.incrementAndGet() }
        }
        Perf.resetCompositions(); Perf.countCompositions = true
        block()
        compose.waitForIdle()
        Perf.countCompositions = false
        watch.cancel()
        val counts = Perf.compositionCounts() + ("own" to own.get())
        android.util.Log.i("TcRecompose", "$label $counts")
        return counts
    }

    @Test fun otherChatDoesNotRecomposeTheOpenOne() {
        open()
        // Reposo previo, tan largo como la medición: lo que quede por asentarse del arranque no se le cuenta al otro chat.
        settle(5_500)
        // Alguien escribe en el otro chat: 3 avisos y su vencimiento (4,1 s después de cada uno).
        val typing = measure("typing-ajeno") { repeat(3) { typing("ajeno", "other"); settle(300) }; settle(4_600) }
        // Llegan 3 mensajes al otro chat (cambian su fila en la lista y el orden).
        val incoming = measure("mensajes-ajeno") { for (s in 6L..8L) { message("ajeno", s, s); settle(300) } }
        assertTrue("typing en otro chat no recompone la pantalla: $typing", (typing["chat"] ?: 0) <= typing.getValue("own"))
        assertEquals("typing en otro chat no recompone burbujas: $typing", 0, typing["bubble"] ?: 0)
        assertTrue("mensajes en otro chat no recomponen la pantalla: $incoming", (incoming["chat"] ?: 0) <= incoming.getValue("own"))
        assertEquals("mensajes en otro chat no recomponen burbujas: $incoming", 0, incoming["bubble"] ?: 0)
    }

    @Test fun ownChatStillUpdates() {
        open()
        val own = measure("mensaje-propio-chat") { message("abierto", 31, (client.state.value.conversations["abierto"]?.lastEventSeq ?: 0) + 1); settle(800) }
        compose.onNodeWithTag("msg-31").assertExists()
        // El mensaje nuevo compone su burbuja; las que ya estaban a la vista no se vuelven a componer todas.
        val visible = compose.onAllNodes(hasTestTagStartingWith("msg-")).fetchSemanticsNodes().size
        assertTrue("llegó el mensaje: $own", (own["bubble"] ?: 0) >= 1)
        assertTrue("un mensaje nuevo no recompone todas las burbujas visibles ($visible): $own", (own["bubble"] ?: 0) <= 3)
        val typing = measure("typing-propio-chat") { typing("abierto", "third"); settle(600) }
        assertTrue("typing en este chat sí se muestra: $typing", (typing["chat"] ?: 0) >= 1)
        assertEquals("typing en este chat no recompone burbujas: $typing", 0, typing["bubble"] ?: 0)
    }

    private fun hasTestTagStartingWith(prefix: String) = SemanticsMatcher("tag empieza por $prefix") { n ->
        n.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.let { it.startsWith(prefix) && it.removePrefix(prefix).all(Char::isDigit) } == true
    }
}
