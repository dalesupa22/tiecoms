package com.tiecoms.app.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Recuperación del chat tras un 502 del proxy durante un despliegue (incidencia 28-sep-2026).
 * Servidor sintético en proceso: nada contra producción ni mensajes a personas reales.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatRecoveryTest {
    private val server = MockWebServer()
    private var client: TieComsClient? = null
    private val writes = java.util.concurrent.CopyOnWriteArrayList<String>()

    @After fun close() { client?.close(); server.shutdown() }

    private val nginx502 = MockResponse().setResponseCode(502).setHeader("content-type", "text/html")
        .setBody("<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>")

    private fun serve(messages: (Int) -> MockResponse): AtomicInteger {
        val gets = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                if (r.method != "GET") writes += "${r.method} $path"
                val body = when (path) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA"},"people":[{"id":"peer","name":"Synthetic Peer"}],"conversations":[{"id":"dm-qa","kind":"direct","memberIds":["me","peer"],"lastMessageSeq":2,"lastReadSeq":2}]}"""
                    "/api/v1/conversations/dm-qa/messages" -> return messages(gets.incrementAndGet())
                    "/api/v1/conversations/dm-qa/events" -> """{"events":[],"lastEventSeq":2}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    else -> """{}"""
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        return gets
    }

    private val page = MockResponse().setBody("""{"messages":[
        {"id":"m1","conversationId":"dm-qa","seq":1,"authorId":"peer","body":"Synthetic one","createdAt":"2026-09-28T15:09:00Z"},
        {"id":"m2","conversationId":"dm-qa","seq":2,"authorId":"peer","body":"Synthetic two","createdAt":"2026-09-28T15:09:30Z"}],
        "hasMore":false,"lastEventSeq":2}""")

    private fun newClient(): TieComsClient {
        val c = TieComsClient(server.url("/").toString().trimEnd('/'), "Recovery QA", MemoryStorage(), MemorySecretStore(),
            OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        client = c
        runBlocking { c.login("qa@example.test", "synthetic") }
        return c
    }

    @Test fun `502 del proxy se reintenta con espera y el chat carga`() {
        val gets = serve { n -> if (n <= 2) nginx502 else page }
        val c = newClient()
        val waits = mutableListOf<Long>()
        val kinds = mutableListOf<ChatRecovery.Kind>()
        val pendingBefore = c.state.value.pending
        runBlocking {
            ChatRecovery.withRetry(
                attempt = { c.openConversation("dm-qa") },
                onRetrying = { k, _ -> kinds += k },
                wait = { ms -> waits += ms },
            )
        }
        assertEquals(3, gets.get())
        assertEquals(listOf(1_000L, 2_000L), waits)
        assertEquals(listOf(ChatRecovery.Kind.UPDATING, ChatRecovery.Kind.UPDATING), kinds)
        val conv = c.state.value.conversations["dm-qa"]!!
        assertTrue(conv.loaded); assertFalse(conv.loading)
        assertEquals(listOf("m1", "m2"), conv.messages.map { it.id })
        // Nada se marcó leído ni se envió por el camino.
        assertEquals(2L, c.meta("dm-qa")!!.lastReadSeq)
        assertEquals(pendingBefore, c.state.value.pending)
        assertEquals("Solo lecturas (fuera del login): ni /read ni envíos", emptyList<String>(), writes.filter { !it.endsWith("/login") })
    }

    @Test fun `el 502 crudo no se muestra como texto y se agota en unos 30 s`() {
        val gets = serve { nginx502 }
        val c = newClient()
        val waits = mutableListOf<Long>()
        try {
            runBlocking { ChatRecovery.withRetry(attempt = { c.openConversation("dm-qa") }, wait = { waits += it }) }
            fail("Debe agotarse")
        } catch (e: ApiException) {
            assertEquals(502, e.status)
            assertTrue(ChatRecovery.transient(e))
        }
        assertEquals(ChatRecovery.BACKOFF_MS.toList(), waits)
        assertEquals(30_000L, waits.sum())
        assertEquals(6, gets.get())
        val conv = c.state.value.conversations["dm-qa"]!!
        assertFalse("Sigue sin cargar: no puede callar avisos", conv.loaded)
        assertFalse(conv.loading)
    }

    @Test fun `403 y 404 son permanentes y muestran su mensaje`() {
        val gets = serve { n ->
            if (n == 1) MockResponse().setResponseCode(403).setBody("""{"error":{"code":"forbidden","message":"No participas en esta conversación"}}""")
            else MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"No existe"}}""")
        }
        val c = newClient()
        for (status in listOf(403, 404)) {
            val waits = mutableListOf<Long>()
            try {
                runBlocking { ChatRecovery.withRetry(attempt = { c.openConversation("dm-qa") }, wait = { waits += it }) }
                fail("Debe fallar")
            } catch (e: ApiException) {
                assertEquals(status, e.status)
                assertEquals(ChatRecovery.Kind.PERMANENT, ChatRecovery.kind(e))
            }
            assertTrue("Sin reintentos para $status", waits.isEmpty())
        }
        assertEquals(2, gets.get())
    }

    @Test fun `clasificacion de errores`() {
        assertEquals(ChatRecovery.Kind.NETWORK, ChatRecovery.kind(NetworkException(java.io.IOException("reset"))))
        for (s in listOf(500, 502, 503, 504)) assertEquals(ChatRecovery.Kind.UPDATING, ChatRecovery.kind(ApiException(s, "http_$s", "HTTP $s")))
        for (s in listOf(401, 408, 429)) assertEquals(ChatRecovery.Kind.NETWORK, ChatRecovery.kind(ApiException(s, "x", "x")))
        for (s in listOf(400, 403, 404, 409, 413)) assertEquals(ChatRecovery.Kind.PERMANENT, ChatRecovery.kind(ApiException(s, "x", "x")))
        assertEquals(ChatRecovery.Kind.PERMANENT, ChatRecovery.kind(IllegalStateException()))
    }

    @Test fun `el socket en linea adelanta el reintento`() = runTest {
        val state = MutableStateFlow(ClientState(connection = ConnectionStatus.CONNECTING))
        val waited = async { ChatRecovery.waitOrOnline(8_000, state); currentTime }
        advanceTimeBy(1_500)
        state.value = state.value.copy(connection = ConnectionStatus.ONLINE)
        assertEquals("Reintenta al volver el socket, sin esperar los 8 s", 1_500L, waited.await())
        // Ya en línea: cuenta el tiempo completo (el 502 no depende del socket).
        val start = currentTime
        ChatRecovery.waitOrOnline(2_000, state)
        assertEquals(2_000L, currentTime - start)
    }

    @Test fun `cancelar durante la espera no vuelve a leer ni cambia pendientes`() {
        val gets = serve { nginx502 }
        val c = newClient()
        val pending = c.state.value.pending
        val enteredWait = CompletableDeferred<Unit>()
        runBlocking {
            val recovery = launch {
                ChatRecovery.withRetry(attempt = { c.openConversation("dm-qa") }, wait = {
                    enteredWait.complete(Unit)
                    awaitCancellation()
                })
            }
            enteredWait.await()
            recovery.cancelAndJoin()
        }
        assertEquals(1, gets.get())
        assertEquals(pending, c.state.value.pending)
        assertEquals(2L, c.meta("dm-qa")!!.lastReadSeq)
        assertFalse(c.state.value.conversations["dm-qa"]!!.loading)
        assertEquals(emptyList<String>(), writes.filter { !it.endsWith("/login") })
    }
}
