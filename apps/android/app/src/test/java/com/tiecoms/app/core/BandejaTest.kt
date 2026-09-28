package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 1.6.4: orden único, vista Lista de Grupos, asuntos contraíbles y primer no leído del chat. */
class BandejaTest {
    private val mine = OrganizationDTO(id = "mine", name = "Ongoing", myRole = "owner")
    private val acme = OrganizationDTO(id = "acme", name = "Acme")
    private val beta = OrganizationDTO(id = "beta", name = "Beta")

    private fun ws(id: String, owner: String, orgs: List<String>, role: String = "member", pending: String? = null) =
        WorkspaceDTO(id = id, name = id.uppercase(), owningOrgId = owner, organizationIds = orgs, myRole = role, counterpartName = pending)

    private fun g(id: String, w: String?, at: String, name: String = id, unread: Int = 0, parent: String? = null, muted: Boolean = false,
                  pinned: String? = null, mentions: Int = 0, kind: String = "group") =
        ConversationDTO(id = id, workspaceId = w, kind = kind, name = name, lastMessageAt = at, unread = unread, parentId = parent,
            deriveKind = parent?.let { "same" }, mutedUntil = if (muted) "2999-01-01T00:00:00Z" else null, pinnedAt = pinned, unreadMentions = mentions)

    private val data = BootstrapDTO(
        me = UserDTO(id = "u1", primaryOrgId = "mine"),
        organizations = listOf(mine, acme, beta),
        workspaces = listOf(
            ws("w-home", "mine", listOf("mine")),
            ws("w-a", "acme", listOf("acme", "mine")),
            ws("w-b", "beta", listOf("beta", "mine")),
            ws("w-p", "mine", listOf("mine"), pending = "Nestlé"),
            ws("w-g", "beta", listOf("beta"), role = "guest"),
        ),
        conversations = listOf(
            g("g-home", "w-home", "2026-09-25T10:00:00Z", name = "Pagos"),
            g("g-old", "w-home", "2026-09-24T10:00:00Z", name = "Ongoing Ventas"),       // ya empieza por la empresa
            g("g-a1", "w-a", "2026-09-23T10:00:00Z", name = "Mentorías", unread = 2),
            g("g-der", "w-a", "2026-09-26T10:00:00Z", parent = "g-a1", unread = 4),    // hilo: no se lista
            g("g-a2", "w-a", "2026-09-21T10:00:00Z", name = "Finanzas"),
            g("g-b", "w-b", "2026-09-20T10:00:00Z", name = "Soporte", unread = 5, muted = true),
            g("g-p", "w-p", "2026-09-19T10:00:00Z", name = "Piloto"),
            g("g-g", "w-g", "2026-09-18T10:00:00Z", name = "Invitados"),
            g("d1", null, "2026-09-25T09:00:00Z", kind = "direct", unread = 3),
        ),
    )

    private fun issue(id: String, conv: String, due: String? = null) =
        IssueDTO(id = id, conversationId = conv, title = "Asunto $id", status = "open", dueDate = due, createdAt = "2026-09-0${id.last()}T00:00:00Z")
    private val issues = listOf(issue("i1", "g-a1"), issue("i2", "g-a1", due = "2026-09-01"), issue("i3", "g-home"))

    private fun list(d: BootstrapDTO = data, q: String = "", collapsed: Set<String> = emptySet(), tab: GroupsTree.Tab = GroupsTree.Tab.ALL) =
        GroupsTree.buildList(d, issues, q, null, collapsed, { it.name ?: it.id }, nowMs = 0, tab = tab, today = "2026-09-26")

    // ---------- A. Orden único ----------
    @Test fun `orden unico - fijadas, mencion, no leidos, actividad`() {
        val l = listOf(
            g("a", null, "2026-09-25T10:00:00Z"),
            g("b", null, "2026-09-20T10:00:00Z", unread = 2),
            g("c", null, "2026-09-10T10:00:00Z", pinned = "2026-09-01T00:00:00Z"),
            g("d", null, "2026-09-01T10:00:00Z", unread = 1, muted = true, mentions = 1),    // mención silenciada: sube igual
            g("e", null, "2026-09-02T10:00:00Z", unread = 1, pinned = "2026-09-05T00:00:00Z"),
            g("f", null, "2026-09-26T10:00:00Z", unread = 9, muted = true),                 // silenciada = leída
            g("h", null, "2026-09-09T10:00:00Z", pinned = "2026-09-03T00:00:00Z", mentions = 1, unread = 1),
        )
        // Fijadas: h (mención) → e (no leído) → c; luego d (mención), b (no leído) y el resto por actividad.
        assertEquals(listOf("h", "e", "c", "d", "b", "f", "a"), HomeTree.order(l, 0).map { it.id })
        assertEquals(HomeTree.order(l, 0), HomeTree.order(l.reversed(), 0))
        assertEquals(HomeTree.Block.PINNED, HomeTree.blockOf(l[2], 0))
        assertEquals(HomeTree.Block.UNREAD, HomeTree.blockOf(l[3], 0))
        assertEquals(HomeTree.Block.RECENT, HomeTree.blockOf(l[5], 0))
    }

    @Test fun `arbol - fijados arriba dentro de cada empresa`() {
        val d = data.copy(conversations = data.conversations.map { if (it.id == "g-a2") it.copy(pinnedAt = "2026-09-01T00:00:00Z") else it })
        val keys = GroupsTree.build(d, issues, "", null, emptySet(), { it.name ?: it.id }, nowMs = 0).map { it.key }
        assertEquals(listOf("s:PINNED", "pc:g-a2"), keys.take(2))
        // Dentro de Acme, Finanzas (fijada) antes que Mentorías (no leídos).
        assertTrue(keys.indexOf("c:g-a2") < keys.indexOf("c:g-a1"))
    }

    // ---------- B. Vista Lista ----------
    @Test fun `etiqueta Empresa - Grupo sin repetir la empresa`() {
        assertEquals("Acme · Mentorías", GroupsTree.listLabel("Acme", "Mentorías"))
        assertEquals("Ongoing Ventas", GroupsTree.listLabel("Ongoing", "Ongoing Ventas"))
        assertEquals("Piloto", GroupsTree.listLabel(null, "Piloto"))
        val labels = list().filterIsInstance<GroupsTree.Group>().associate { it.c.id to it.label }
        assertEquals("Ongoing · Pagos", labels["g-home"])         // Tu organización → mi empresa dueña
        assertEquals("Ongoing Ventas", labels["g-old"])
        assertEquals("Acme · Mentorías", labels["g-a1"])          // Relaciones → la contraparte
        assertEquals("Beta · Soporte", labels["g-b"])
        assertEquals("Nestlé · Piloto", labels["g-p"])            // relación pendiente → counterpartName
        assertEquals("Beta · Invitados", labels["g-g"])           // Invitado en → la anfitriona
    }

    @Test fun `lista plana con separadores Fijados, Sin leer y Recientes`() {
        assertEquals(listOf("b:UNREAD", "c:g-a1", "b:RECENT", "c:g-home", "c:g-old", "c:g-a2", "c:g-b", "c:g-p", "c:g-g"), list().map { it.key })
        val pinned = data.copy(conversations = data.conversations.map { if (it.id == "g-p" || it.id == "g-old") it.copy(pinnedAt = "2026-09-01T00:00:00Z") else it })
        assertEquals(listOf("b:PINNED", "c:g-old", "c:g-p", "b:UNREAD", "c:g-a1", "b:RECENT", "c:g-home", "c:g-a2", "c:g-b", "c:g-g"), list(pinned).map { it.key })
        // Sin no leídos: el bloque vacío no sale.
        val read = data.copy(conversations = data.conversations.map { it.copy(unread = 0) })
        assertFalse(list(read).any { it.key == "b:UNREAD" })
        // Buscar: por empresa o grupo, sin separadores.
        assertEquals(listOf("c:g-a1", "c:g-a2"), list(q = "acme").filterIsInstance<GroupsTree.Group>().map { it.key })
        assertEquals(listOf<GroupsTree.Row>(GroupsTree.Empty(filtered = true)), list(q = "nada"))
    }

    // ---------- C. Asuntos contraíbles ----------
    @Test fun `asuntos contraidos por defecto y el chip los alterna`() {
        val g = list().first { it.key == "c:g-a1" } as GroupsTree.Group
        assertFalse(g.issuesExpanded); assertEquals(2, g.issueCount); assertEquals(1, g.overdueCount)
        assertEquals(GroupsTree.issuesKey("g-a1"), g.foldKey)
        assertEquals(listOf("c:g-a1", "i:i2", "i:i1"), list(collapsed = setOf(g.foldKey)).map { it.key }.drop(1).take(3))
    }

    @Test fun `buscando o en Asuntos el chip tambien contrae`() {
        val g = list(q = "Mentor").first { it.key == "c:g-a1" } as GroupsTree.Group
        assertTrue(g.issuesExpanded)
        assertEquals(GroupsTree.issuesHiddenKey("g-a1"), g.foldKey)
        assertEquals(listOf("c:g-a1"), list(q = "Mentor", collapsed = setOf(g.foldKey)).map { it.key })
        val tree = GroupsTree.build(data, issues, "", null, setOf(GroupsTree.issuesHiddenKey("g-a1")), { it.name ?: it.id }, nowMs = 0, tab = GroupsTree.Tab.ISSUES, today = "2026-09-26")
        assertFalse(tree.any { it.key == "i:i1" }); assertTrue(tree.any { it.key == "i:i3" })
        // «Contraer todos los asuntos» también en ese modo; «Mostrar todos» los vuelve a abrir.
        val hidden = GroupsTree.hideAllIssues(emptySet(), data)
        assertFalse(list(q = "g", collapsed = hidden).any { it is GroupsTree.Issue })
        assertTrue(GroupsTree.showAllIssues(hidden, data, issues).none { it.startsWith(GroupsTree.HIDDEN_PREFIX) })
    }

    // ---------- D. Primer no leído ----------
    private fun m(seq: Long, author: String = "otro", mentions: List<String> = emptyList()) =
        MessageDTO(id = "m$seq", seq = seq, authorId = author, mentions = mentions.map { MentionDTO(it, 0, 3) })

    @Test fun `primer no leido despues de lastReadSeq`() {
        val msgs = (1L..20L).map { m(it, author = if (it == 12L) "u1" else "otro") }
        assertEquals(11L, ChatNav.firstUnreadSeq(msgs, lastReadSeq = 10, unread = 9, me = "u1"))
        // Mi propio mensaje no cuenta como no leído.
        assertEquals(13L, ChatNav.firstUnreadSeq(msgs, lastReadSeq = 11, unread = 8, me = "u1"))
        assertNull(ChatNav.firstUnreadSeq(msgs, lastReadSeq = 10, unread = 0, me = "u1"))
        // Un conteo menor no autoriza saltar el inicio cuando el cursor es cero.
        assertEquals(1L, ChatNav.firstUnreadSeq(msgs, lastReadSeq = 0, unread = 4, me = "u1"))
    }

    @Test fun `si el primer no leido no esta cargado hay que traer mas antiguos`() {
        val page = (51L..100L).map { m(it) }
        assertTrue(ChatNav.needsOlder(page, lastReadSeq = 20, unread = 80, me = "u1", hasMore = true))
        assertNull(ChatNav.firstUnreadSeq(page, lastReadSeq = 20, unread = 80, me = "u1", hasMore = true))
        assertFalse(ChatNav.needsOlder(page, lastReadSeq = 60, unread = 40, me = "u1", hasMore = true))
        // Una página terminal tampoco autoriza saltar el hueco; historyFrom se aplica aparte.
        assertNull(ChatNav.firstUnreadSeq(page, lastReadSeq = 20, unread = 80, me = "u1", hasMore = false))
    }

    @Test fun `menciones a mi sin leer para el boton arroba`() {
        val msgs = listOf(m(1, mentions = listOf("u1")), m(5, mentions = listOf("u2")), m(6, mentions = listOf("u1")), m(7, mentions = listOf("all")), m(8, author = "u1", mentions = listOf("u1")))
        assertEquals(listOf(6L, 7L), ChatNav.unreadMentionSeqs(msgs, afterSeq = 4, me = "u1"))
    }
}
