package com.tiecoms.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Qué anuncia el socket (Sync): solo lo nuevo en vivo de una conversación conocida produce Incoming;
 * lo silenciado produce Silenced (decisión «sin aviso» para el registro compartido con FCM); lo de antes
 * de reconectar (catch-up tras un despliegue) y la conversación desconocida no producen nada, y por eso
 * FCM debe poder mostrarlos en primer plano. Servidor Socket.IO sintético en proceso.
 */
class SocketNoticeSignalsTest {
    private val server = MockWebServer()
    private var client: TieComsClient? = null
    @Volatile private var ws: WebSocket? = null
    private val scope = CoroutineScope(Dispatchers.Default)

    @After fun close() { scope.cancel(); client?.close(); server.shutdown() }

    private fun start(): Pair<TieComsClient, CopyOnWriteArrayList<ClientSignal>> {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                if (path.startsWith("/api/socket.io")) return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        ws = webSocket
                        webSocket.send("""0{"sid":"e1","upgrades":[],"pingInterval":25000,"pingTimeout":20000}""")
                    }
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text.startsWith("40")) { webSocket.send("""40{"sid":"s1"}"""); webSocket.send("""42["ready",{}]""") }
                    }
                })
                val body = when (path) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA"},"people":[{"id":"peer","name":"Synthetic Peer"}],"conversations":[
                        {"id":"dm-open","kind":"direct","memberIds":["me","peer"],"lastMessageSeq":1,"lastReadSeq":1,"lastEventSeq":1},
                        {"id":"dm-muted","kind":"direct","memberIds":["me","peer"],"lastMessageSeq":1,"lastReadSeq":1,"lastEventSeq":1,"mutedUntil":"${Silence.FOREVER}"}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    else -> """{}"""
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        val c = TieComsClient(server.url("/").toString().trimEnd('/'), "Signals QA", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        client = c
        val signals = CopyOnWriteArrayList<ClientSignal>()
        scope.launch { c.signals.collect { signals += it } }
        runBlocking {
            c.login("qa@example.test", "synthetic")
            withTimeout(15_000) { c.state.first { it.connection == ConnectionStatus.ONLINE } }
        }
        return c to signals
    }

    private fun created(conv: String, id: String, seq: Long, createdAt: String) {
        ws!!.send("""42["conv.event",{"conversationId":"$conv","eventSeq":$seq,"type":"message.created","message":{"id":"$id","conversationId":"$conv","seq":$seq,"authorId":"peer","body":"Synthetic","createdAt":"$createdAt"}}]""")
    }

    private fun waitFor(what: String, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + 10_000
        while (!cond()) { check(System.currentTimeMillis() < until) { "Timeout: $what" }; Thread.sleep(20) }
    }

    @Test fun `el socket anuncia solo lo nuevo en vivo y registra lo silenciado`() {
        val (c, signals) = start()
        val live = "2099-01-01T00:00:00Z"
        // Anterior a la conexión en vivo (catch-up tras el despliegue): sin Incoming ni Silenced.
        created("dm-open", "m-old", 2, "2026-09-28T15:09:32Z")
        // Conversación desconocida (DM nuevo que aún no está en el snapshot): tampoco.
        created("dm-unknown", "m-unknown", 1, live)
        created("dm-muted", "m-muted", 2, live)
        created("dm-open", "m-live", 3, live)
        waitFor("Incoming en vivo") { signals.any { it is ClientSignal.Incoming && it.message.id == "m-live" } }
        waitFor("Silenced del chat silenciado") { signals.any { it is ClientSignal.Silenced && it.messageId == "m-muted" } }
        val ids = signals.mapNotNull { (it as? ClientSignal.Incoming)?.message?.id ?: (it as? ClientSignal.Silenced)?.messageId }
        assertEquals(listOf("m-muted", "m-live"), ids)
        assertTrue("El chat silenciado no produce Incoming", signals.none { it is ClientSignal.Incoming && it.message.id == "m-muted" })

        // Lo mismo que hace AppContainer: el FCM de m-old y m-unknown se muestra; m-muted y m-live no se repiten.
        val ledger = NoticeLedger()
        signals.forEach { s ->
            when (s) {
                is ClientSignal.Incoming -> Notices.forLive(ledger, s.message.id, openAndLoaded = false)
                is ClientSignal.Silenced -> Notices.silenced(ledger, s.messageId)
                else -> Unit
            }
        }
        val st = c.state.value
        fun fcm(conv: String, id: String) = Notices.forPush(ledger,
            PushMessage("message", "Peer", "", "Synthetic", 1, conv, "TC_MESSAGE", conv, id, "peer", "Peer", null, null, null),
            Notices.PushContext(foreground = true, live = st.connection == ConnectionStatus.ONLINE, dnd = c.dndActive(),
                convKnown = c.meta(conv) != null, convMutedUntil = null, openAndLoaded = false, nowMs = System.currentTimeMillis()))
        assertEquals(Notices.Outcome.SHOW, fcm("dm-open", "m-old"))
        assertEquals(Notices.Outcome.SHOW, fcm("dm-unknown", "m-unknown"))
        assertEquals(Notices.Outcome.DUPLICATE, fcm("dm-muted", "m-muted"))
        assertEquals(Notices.Outcome.DUPLICATE, fcm("dm-open", "m-live"))
    }
}
