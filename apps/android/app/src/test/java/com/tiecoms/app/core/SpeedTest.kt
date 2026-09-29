package com.tiecoms.app.core

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** Velocidad (fase 2 de 1.7.0): copia local, pintar desde ella, revalidar, precargar y borrar al salir. */
class SpeedTest {
    private fun conv(id: String, at: String, unread: Int = 0, pinned: Boolean = false, muted: String? = null, seq: Long = 10) =
        ConversationDTO(id = id, kind = "direct", lastMessageAt = at, unread = unread, pinnedAt = if (pinned) "2026-09-01T00:00:00Z" else null,
            mutedUntil = muted, lastEventSeq = seq)
    private fun msgs(c: String, n: Int) = (1..n).map { MessageDTO(id = "$c-$it", conversationId = c, seq = it.toLong(), authorId = "u2", body = "m$it") }

    @Test fun `la copia guarda 30 conversaciones recientes con sus ultimos 50 mensajes`() {
        val convs = (1..40).map { conv("c$it", "2026-09-%02dT00:00:00Z".format(it % 28 + 1) + it) }
        val state = ClientState(status = SessionStatus.READY, data = BootstrapDTO(me = UserDTO(id = "u1", name = "Ana"), conversations = convs),
            conversations = convs.associate { it.id to ConversationState(messages = msgs(it.id, 70), lastEventSeq = 70, hasMore = false, loaded = true) },
            blockedUserIds = setOf("u9"))
        val snap = Speed.snapshot(state, 1000)!!
        assertEquals(30, snap.conversations.size)
        assertTrue(snap.conversations.all { it.messages.size == 50 && it.messages.first().seq == 21L && it.hasMore })
        // Las más recientes primero.
        val newest = convs.sortedByDescending { it.lastMessageAt }.take(30).map { it.id }.toSet()
        assertEquals(newest, snap.conversations.map { it.id }.toSet())
        val back = Speed.decode(Speed.encode(snap), "u1", 2000)!!
        assertEquals(listOf("u9"), back.blockedUserIds)
        val restored = Speed.restore(back)
        assertEquals(30, restored.size)
        assertTrue(restored.values.all { it.loaded && it.lastEventSeq == 70L && it.messages.size == 50 })
        // Otra persona, otra versión o muy vieja: no se pinta.
        assertNull(Speed.decode(Speed.encode(snap), "u2", 2000))
        assertNull(Speed.decode(Speed.encode(snap.copy(v = 0)), "u1", 2000))
        assertNull(Speed.decode(Speed.encode(snap), "u1", 1000 + Speed.MAX_AGE_MS + 1))
        assertNull(Speed.decode("{roto", "u1", 2000))
    }

    @Test fun `los mensajes de una sola vista se guardan sin contenido`() {
        val m = MessageDTO(id = "v", conversationId = "c1", seq = 1, authorId = "u2", body = "secreto", viewOnce = true,
            attachments = listOf(AttachmentDTO(id = "a", contentType = "image/png")))
        val state = ClientState(status = SessionStatus.READY, data = BootstrapDTO(me = UserDTO(id = "u1"), conversations = listOf(conv("c1", "x"))),
            conversations = mapOf("c1" to ConversationState(messages = listOf(m), loaded = true)))
        val saved = Speed.snapshot(state, 0)!!.conversations.single().messages.single()
        assertEquals("", saved.body); assertTrue(saved.attachments.isEmpty()); assertTrue(saved.viewOnce)
    }

    @Test fun `precarga no leidos y fijados, maximo 8, sin silenciados ni los que ya estan al dia`() {
        val convs = (1..12).map { conv("u$it", "2026-09-${10 + it}T00:00:00Z", unread = 2) } +
            conv("pin", "2026-09-01T00:00:00Z", pinned = true) +
            conv("muted", "2026-09-30T00:00:00Z", unread = 5, muted = "2099-01-01T00:00:00Z") +
            conv("read", "2026-09-30T00:00:00Z")
        val d = BootstrapDTO(me = UserDTO(id = "u1"), conversations = convs)
        val t = Speed.prefetchTargets(d, emptyMap(), System.currentTimeMillis())
        assertEquals(8, t.size)
        assertEquals("u12", t.first())
        assertFalse("muted" in t); assertFalse("read" in t)
        // Ya en memoria y al día: se salta; en memoria pero atrasada: se recupera.
        val local = mapOf("u12" to ConversationState(lastEventSeq = 10, loaded = true), "u11" to ConversationState(lastEventSeq = 3, loaded = true))
        val t2 = Speed.prefetchTargets(d, local, System.currentTimeMillis())
        assertFalse("u12" in t2); assertTrue("u11" in t2)
        // Pocas con no leídos: entra la fijada.
        assertTrue("pin" in Speed.prefetchTargets(d.copy(conversations = convs.drop(9)), emptyMap(), System.currentTimeMillis()))
    }

    @Test fun `vista previa de una sola vista en la lista (MessagePreviewDTO viewOnce)`() {
        val h = TcJson.decodeFromString(LastHumanPreviewDTO.serializer(), """{"messageId":"m","body":"","attachments":{"count":1,"images":1},"viewOnce":true}""")
        assertTrue(h.viewOnce)
        assertEquals("① Foto", ViewOnce.preview(h.attachments, "Foto", "Nota de voz", "Mensaje"))
        assertEquals("① Nota de voz", ViewOnce.preview(AttachmentSummaryDTO(count = 1, voices = 1), "Foto", "Nota de voz", "Mensaje"))
        assertEquals("① Mensaje", ViewOnce.preview(null, "Foto", "Nota de voz", "Mensaje"))
        assertFalse(TcJson.decodeFromString(LastHumanPreviewDTO.serializer(), """{"messageId":"m"}""").viewOnce)
    }

    // ---------- Cliente contra un servidor de mentira ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<String>()
    @Volatile private var refreshDelayMs = 0L
    @Volatile private var title = "Primero"
    private val storage = MemoryStorage()
    private val secrets = MemorySecretStore()
    private val cache = MemorySnapshotCache()

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                requests += "${request.method} $path"
                val auth = """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                val body = when (path.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> auth
                    "$AUTH_BASE_PATH/refresh" -> return MockResponse().setBody(auth).setBodyDelay(refreshDelayMs, TimeUnit.MILLISECONDS)
                    "$AUTH_BASE_PATH/logout" -> "{}"
                    "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana"},"conversations":[
                        {"id":"c1","kind":"group","name":"$title","memberIds":["u1","u2"],"canPost":true,"lastMessageSeq":2,"lastEventSeq":2,"lastMessageAt":"2026-09-29T10:00:00Z"},
                        {"id":"c2","kind":"direct","memberIds":["u1","u2"],"canPost":true,"lastMessageSeq":1,"lastEventSeq":1,"unread":1,"lastMessageAt":"2026-09-29T09:00:00Z"}]}"""
                    "/api/v1/blocks" -> """{"userIds":["u7"]}"""
                    "/api/v1/conversations/c1/messages" -> """{"messages":[{"id":"m1","conversationId":"c1","seq":1,"authorId":"u2","body":"hola"},{"id":"m2","conversationId":"c1","seq":2,"authorId":"u1","body":"qué tal"}],"hasMore":false,"lastEventSeq":2}"""
                    "/api/v1/conversations/c2/messages" -> """{"messages":[{"id":"n1","conversationId":"c2","seq":1,"authorId":"u2","body":"¿vienes?"}],"hasMore":false,"lastEventSeq":1}"""
                    "/api/v1/conversations/c1/events", "/api/v1/conversations/c2/events" -> """{"events":[],"resetRequired":false}"""
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
    }
    @After fun tearDown() { server.shutdown() }

    private fun newClient() = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", storage, secrets, OkHttpClient(), snapshots = cache)

    private suspend fun waitFor(ms: Long = 5000, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + ms
        while (!cond()) { check(System.currentTimeMillis() < until) { "tiempo agotado" }; delay(20) }
    }

    @Test fun `pinta desde la copia antes del servidor, revalida, precarga y la borra al salir`() = runBlocking {
        // Primera sesión: entra, abre c1, la copia se escribe sola tras la ráfaga.
        val first = newClient()
        first.login("ana@acme.co", "x"); first.firstFrameDrawn(); first.openConversation("c1")
        waitFor { cache.map["u1"]?.contains("qué tal") == true }
        assertEquals("u1", storage.get(LAST_USER_KEY))
        first.close()

        // Arranque en frío con el servidor lento: la lista y el chat salen de la copia al instante.
        title = "Renombrado"; refreshDelayMs = 1500; requests.clear()
        val second = newClient()
        val started = async { second.start() }
        waitFor(1000) { second.state.value.status == SessionStatus.READY }
        assertTrue(second.paintedFromCache)
        assertEquals("Primero", second.state.value.data!!.conversations.first { it.id == "c1" }.name)
        assertEquals(listOf("m1", "m2"), second.state.value.conversations["c1"]!!.messages.map { it.id })
        assertEquals(setOf("u7"), second.state.value.blockedUserIds)
        assertFalse(requests.any { it.contains("/bootstrap") })

        // Revalidación: el bootstrap fresco reemplaza la copia; c2 (no leído) se precarga tras el primer fotograma.
        started.await()
        assertEquals("Renombrado", second.state.value.data!!.conversations.first { it.id == "c1" }.name)
        second.firstFrameDrawn()
        waitFor { second.state.value.conversations["c2"]?.loaded == true }
        assertEquals("¿vienes?", second.state.value.conversations["c2"]!!.messages.single().body)
        // Abrir c1 no espera la red: ya está en memoria (solo recupera eventos detrás).
        second.openConversation("c1")
        assertFalse(requests.any { it.startsWith("GET /api/v1/conversations/c1/messages") })

        // Cerrar sesión borra la copia y el último usuario.
        second.logout()
        assertNull(cache.map["u1"]); assertNull(storage.get(LAST_USER_KEY))
        second.close()
    }

    @Test fun `salir o escribir mientras la copia se revalida no se pierde`() = runBlocking {
        val first = newClient()
        first.login("ana@acme.co", "x"); first.firstFrameDrawn(); first.openConversation("c1")
        waitFor { cache.map["u1"]?.contains("qué tal") == true }
        first.close()
        refreshDelayMs = 800
        val second = newClient()
        val started = async { second.start() }
        waitFor(1000) { second.state.value.status == SessionStatus.READY }
        assertTrue(second.paintedFromCache)
        // Salir en el primer segundo (el refresh frío todavía no vuelve): la sesión se cierra y no revive.
        second.logout()
        // El arranque en curso se corta («Session changed»): es lo esperado.
        runCatching { started.await() }
        delay(300)
        assertEquals(SessionStatus.ANONYMOUS, second.state.value.status)
        assertNull(cache.map["u1"])
        second.close()
    }

    @Test fun `sin copia arranca como siempre y los bloqueos van en paralelo con el bootstrap`() = runBlocking {
        val c = newClient()
        c.login("ana@acme.co", "x")
        assertEquals(SessionStatus.READY, c.state.value.status)
        assertFalse(c.paintedFromCache)
        assertEquals(setOf("u7"), c.state.value.blockedUserIds)
        assertNotNull(c.state.value.data)
        c.close()
    }
}
