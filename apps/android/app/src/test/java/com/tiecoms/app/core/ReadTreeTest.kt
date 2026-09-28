package com.tiecoms.app.core

import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Pendientes del árbol y «Marcar como leído» (docs/TANDA-LECTURA-REUNIONES.md §1), con el caso real de Danny:
 * «Estudio Norte · General» leído (unread 0) y dos derivadas nunca abiertas con 5 y 6 sin leer.
 */
class ReadTreeTest {
    private val now = 1_790_000_000_000L
    private fun ws() = WorkspaceDTO(id = "w1", name = "Estudio Norte", owningOrgId = "o1", organizationIds = listOf("o1", "o2"))
    private fun conv(id: String, unread: Int, last: Long, read: Long = last - unread, parent: String? = null, kind: String? = null, mentions: Int = 0, muted: String? = null, ws: String? = "w1") =
        ConversationDTO(id = id, workspaceId = ws, kind = "group", name = id, lastMessageSeq = last, lastReadSeq = read, unread = unread, parentId = parent, deriveKind = kind,
            unreadMentions = mentions, mutedUntil = muted, lastMessageAt = "2026-09-28T10:00:00Z")

    private fun danny(): BootstrapDTO = BootstrapDTO(
        me = UserDTO(id = "u1", primaryOrgId = "o1"),
        organizations = listOf(OrganizationDTO(id = "o1", name = "Estudio Norte", myRole = "owner"), OrganizationDTO(id = "o2", name = "Cliente")),
        workspaces = listOf(ws()),
        conversations = listOf(
            conv("general", 0, 40),
            conv("diag", 5, 5, parent = "general", kind = "internal"),
            conv("decision", 6, 6, parent = "general", kind = "directive", mentions = 1),
            // Un sidechat que salió del grupo cuenta en DMs, no en el árbol.
            conv("side", 3, 3, parent = "general", kind = "side", ws = null),
            conv("otro", 0, 9),
        ),
    )

    @Test fun `caso de Danny - el grupo leido con 11 en sus derivadas cuenta como no leido`() {
        val d = danny()
        val g = d.conversations.first { it.id == "general" }
        val p = ReadTree.of(d, g, now)
        assertEquals(0, p.own); assertEquals(11, p.threads); assertEquals(11, p.total)
        assertEquals(1, p.mentions)
        assertEquals(listOf("diag", "decision"), p.pendingChildren.map { it.c.id })
        assertEquals(2, p.childrenWithPending)
        assertTrue("el menú ofrece Marcar como leído", p.markable)
        // Filtro y contador «No leídos»: el grupo cuenta (antes daba 0).
        assertEquals(1, GroupsTree.counts(d, emptyList(), now)[GroupsTree.Tab.UNREAD])
        assertTrue(GroupsTree.inTab(GroupsTree.Tab.UNREAD, g, emptyList(), now, ReadTree.all(d, now)))
        assertFalse("sin árbol, solo el propio", GroupsTree.inTab(GroupsTree.Tab.UNREAD, g, emptyList(), now))
        // Sección «Sin leer» de la vista Lista y chip «⑂ 11».
        val title: (ConversationDTO) -> String = { it.name ?: "" }
        val rows = GroupsTree.buildList(d, emptyList(), "", null, emptySet(), title, now)
        val first = rows.filterIsInstance<GroupsTree.Divider>().first()
        assertEquals(HomeTree.Block.UNREAD, first.block)
        val row = rows.filterIsInstance<GroupsTree.Group>().first()
        assertEquals("general", row.c.id); assertEquals(11, row.threadUnread)
        assertEquals(11, GroupsTree.threadUnread(d, now)["general"])
        // El filtro «No leídos» lo muestra; «otro» no.
        val unreadRows = GroupsTree.buildList(d, emptyList(), "", null, emptySet(), title, now, tab = GroupsTree.Tab.UNREAD).filterIsInstance<GroupsTree.Group>()
        assertEquals(listOf("general"), unreadRows.map { it.c.id })
        // Globo de Grupos: 11 (el sidechat va a DMs).
        assertEquals(11, GroupsTree.groupsUnread(d, now))
    }

    @Test fun `sin nada pendiente el menu ofrece marcar como no leido`() {
        val d = danny().let { b -> b.copy(conversations = b.conversations.map { if (it.parentId == "general" && it.deriveKind != "side") it.copy(unread = 0, lastReadSeq = it.lastMessageSeq, unreadMentions = 0) else it }) }
        val p = ReadTree.of(d, d.conversations.first { it.id == "general" }, now)
        assertEquals(0, p.total); assertFalse(p.markable); assertTrue(p.pendingChildren.isEmpty())
    }

    @Test fun `silenciada cuenta como leida pero se puede marcar`() {
        val muted = "2099-01-01T00:00:00Z"
        val d = danny().let { b -> b.copy(conversations = b.conversations.map { if (it.id == "diag") it.copy(mutedUntil = muted) else it }) }
        val p = ReadTree.of(d, d.conversations.first { it.id == "general" }, now)
        assertEquals(6, p.threads)
        assertEquals(listOf("diag", "decision"), p.pendingChildren.map { it.c.id }) // la silenciada también se limpia
    }

    @Test fun `mencion antigua en un hilo sube el grupo y enciende la arroba`() {
        val d = BootstrapDTO(me = UserDTO(id = "u1", primaryOrgId = "o1"), organizations = listOf(OrganizationDTO(id = "o1", myRole = "owner")), workspaces = listOf(ws().copy(organizationIds = listOf("o1"))),
            conversations = listOf(conv("a", 0, 10), conv("b", 2, 30), conv("hilo", 0, 100, read = 99, parent = "a", kind = "same", mentions = 1)))
        val tree = ReadTree.all(d, now)
        assertEquals(1, tree["a"]!!.mentions); assertEquals(0, tree["a"]!!.total)
        // La mención en el hilo pone al grupo antes que uno con no leídos (orden único: mención > no leídos).
        assertEquals(listOf("a", "b"), HomeTree.order(d.conversations.filter { it.parentId == null }, now, tree).map { it.id })
        assertEquals(HomeTree.Block.UNREAD, HomeTree.blockOf(d.conversations.first { it.id == "a" }, now, tree))
        assertEquals(listOf("hilo"), ReadTree.of(d, d.conversations.first { it.id == "a" }, now).pendingChildren.map { it.c.id })
    }

    @Test fun `items de read-tree - el grupo y cada derivada pendiente hasta el seq conocido, sin sidechats`() {
        val d = danny()
        val items = ReadTree.items(d, d.conversations.first { it.id == "general" }, now)
        assertEquals(listOf(ReadTreeItem("general", 40), ReadTreeItem("diag", 5), ReadTreeItem("decision", 6)), items)
        // Sin pendientes, solo el grupo (el contrato exige al menos un item).
        val clean = d.copy(conversations = d.conversations.filter { it.parentId == null })
        assertEquals(listOf(ReadTreeItem("general", 40)), ReadTree.items(clean, clean.conversations.first { it.id == "general" }, now))
        // Paginación: el tope del contrato (200) nunca se pasa.
        val many = d.copy(conversations = listOf(conv("g", 1, 1)) + (1..400).map { conv("h$it", 1, 1, parent = "g", kind = "same") })
        assertEquals(ReadTree.MAX_ITEMS, ReadTree.items(many, many.conversations.first(), now).size)
    }

    @Test fun `aplicar un seq nunca retrocede y deja lo que llego despues`() {
        val c = conv("x", 5, 5)
        assertEquals(0, ReadTree.applyRead(c, 5).unread)
        // Llegó el 6 mientras se marcaba hasta el 5: queda 1 sin leer y la mención no se borra.
        val newer = c.copy(lastMessageSeq = 6, unread = 6, unreadMentions = 1)
        val r = ReadTree.applyRead(newer, 5)
        assertEquals(5, r.lastReadSeq); assertEquals(1, r.unread); assertEquals(1, r.unreadMentions)
        // Un cursor más adelante no retrocede.
        assertEquals(6, ReadTree.applyRead(c.copy(lastReadSeq = 6, lastMessageSeq = 6, unread = 0), 3).lastReadSeq)
        // Historial desde el ingreso: no se cuentan mensajes previos.
        assertEquals(0, ReadTree.applyRead(c.copy(historyFromSeq = 5), 2).unread)
    }

    // ---------- Cliente contra el contrato (POST /conversations/:id/read-tree) ----------
    private var server: MockWebServer? = null
    @After fun tearDown() { server?.shutdown() }

    private fun convJson(id: String, last: Long, read: Long, unread: Int, parent: String? = null, kind: String? = null, mentions: Int = 0) =
        """{"id":"$id","workspaceId":${if (kind == "side") "null" else "\"w1\""},"kind":"group","name":"$id","memberIds":["u1","u2"],"lastMessageSeq":$last,"lastReadSeq":$read,"unread":$unread,""" +
            """"unreadMentions":$mentions,"parentId":${parent?.let { "\"$it\"" } ?: "null"},"deriveKind":${kind?.let { "\"$it\"" } ?: "null"},"lastMessageAt":"2026-09-28T10:00:00Z"}"""

    private class Api(val requests: CopyOnWriteArrayList<Pair<RecordedRequest, String>>, var bootstrap: String, var readTree: () -> MockResponse)

    private fun client(api: Api): TieComsClient {
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                api.requests += request to body
                val path = request.path!!.substringBefore('?')
                return when {
                    path == "$AUTH_BASE_PATH/login" -> MockResponse().setBody("""{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}""")
                    path == "/api/v1/bootstrap" -> MockResponse().setBody(api.bootstrap)
                    path == "/api/v1/conversations/general/read-tree" -> api.readTree()
                    path == "/api/v1/reminders" -> MockResponse().setBody("""{"reminders":[]}""")
                    path == "/api/v1/blocks" -> MockResponse().setBody("""{"userIds":[]}""")
                    path == "/api/v1/scheduled" -> MockResponse().setBody("""{"scheduled":[]}""")
                    path == "/api/v1/issues" -> MockResponse().setBody("""{"issues":[]}""")
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
            }
        }
        s.start(); server = s
        val c = TieComsClient(s.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { c.login("ana@acme.co", "x") }
        return c
    }

    private fun boot(vararg convs: String) =
        """{"me":{"id":"u1","name":"Ana","primaryOrgId":"o1"},"organizations":[{"id":"o1","name":"Estudio Norte","myRole":"owner"}],""" +
            """"workspaces":[{"id":"w1","name":"Estudio Norte","owningOrgId":"o1","organizationIds":["o1"],"myRole":"owner"}],"conversations":[${convs.joinToString(",")}]}"""

    @Test fun `marcar como leido - un mensaje nuevo mientras se marca sigue sin leer`() = runBlocking {
        val gate = CountDownLatch(1)
        val api = Api(CopyOnWriteArrayList(), boot(convJson("general", 40, 40, 0), convJson("diag", 5, 0, 5, "general", "internal"),
            convJson("decision", 6, 0, 6, "general", "directive", mentions = 1), convJson("side", 3, 0, 3, "general", "side")), {
            // El servidor tarda: mientras tanto llega un mensaje nuevo a «diag» (el 6).
            gate.await(5, TimeUnit.SECONDS)
            MockResponse().setBody("""{"marked":[{"conversationId":"general","lastReadSeq":40},{"conversationId":"diag","lastReadSeq":5},{"conversationId":"decision","lastReadSeq":6}]}""")
        })
        val c = client(api)
        try {
            val job = async { c.markTreeRead("general") }
            // Optimista: la fila deja de contar de una vez.
            kotlinx.coroutines.withTimeout(3_000) { while (c.meta("diag")?.unread != 0) kotlinx.coroutines.delay(10) }
            assertEquals(0, c.meta("decision")!!.unreadMentions)
            api.bootstrap = boot(convJson("general", 40, 40, 0), convJson("diag", 6, 0, 6, "general", "internal"),
                convJson("decision", 6, 0, 6, "general", "directive", mentions = 1), convJson("side", 3, 0, 3, "general", "side"))
            c.loadBootstrap() // el snapshot trae el 6 (y todavía no la lectura)
            gate.countDown()
            assertEquals(3, job.await())
            val sent = api.requests.first { it.first.path == "/api/v1/conversations/general/read-tree" }
            assertEquals("POST", sent.first.method)
            val items = TcJson.parseToJsonElement(sent.second).jsonObject["items"]!!.jsonArray.map { it.jsonObject["conversationId"]!!.jsonPrimitive.content to it.jsonObject["seq"]!!.jsonPrimitive.long }
            assertEquals(listOf("general" to 40L, "diag" to 5L, "decision" to 6L), items)
            assertEquals("el 6 de diag no se tragó", 1, c.meta("diag")!!.unread)
            assertEquals(0, c.meta("decision")!!.unread)
            assertEquals("el sidechat no se toca", 3, c.meta("side")!!.unread)
            assertEquals(1, ReadTree.of(c.state.value.data!!, c.meta("general")!!).total)
        } finally { c.close() }
    }

    @Test fun `marcar como leido - si el API falla vuelve como estaba`() = runBlocking {
        val api = Api(CopyOnWriteArrayList(), boot(convJson("general", 40, 38, 2), convJson("diag", 5, 0, 5, "general", "internal", mentions = 2)), {
            MockResponse().setResponseCode(503).setBody("""{"error":{"code":"unavailable","message":"caído"}}""")
        })
        val c = client(api)
        try {
            try { c.markTreeRead("general"); fail("debía fallar") } catch (_: Exception) {}
            assertEquals(2, c.meta("general")!!.unread); assertEquals(38, c.meta("general")!!.lastReadSeq)
            assertEquals(5, c.meta("diag")!!.unread); assertEquals(2, c.meta("diag")!!.unreadMentions)
        } finally { c.close() }
    }

    @Test fun `persistencia - tras reabrir, el snapshot del servidor manda`() = runBlocking {
        // Tras marcar, otro dispositivo (o reabrir la app) trae el estado del servidor: todo leído.
        val api = Api(CopyOnWriteArrayList(), boot(convJson("general", 40, 40, 0), convJson("diag", 5, 0, 5, "general", "internal")), {
            MockResponse().setBody("""{"marked":[{"conversationId":"general","lastReadSeq":40},{"conversationId":"diag","lastReadSeq":5}]}""")
        })
        val c = client(api)
        try {
            c.markTreeRead("general")
            api.bootstrap = boot(convJson("general", 40, 40, 0), convJson("diag", 5, 5, 0, "general", "internal"))
            c.loadBootstrap()
            assertFalse(ReadTree.of(c.state.value.data!!, c.meta("general")!!).markable)
        } finally { c.close() }
    }
}
