package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Regla del árbol de Grupos y de DMs (docs/GRUPOS.md), sin servidor. */
class GroupsTreeTest {
    private val mine = OrganizationDTO(id = "mine", name = "Ongoing", myRole = "owner")
    private val acme = OrganizationDTO(id = "acme", name = "Acme")
    private val beta = OrganizationDTO(id = "beta", name = "Beta")

    private fun ws(id: String, owner: String, orgs: List<String>, role: String = "member", home: Boolean = false, pending: String? = null) =
        WorkspaceDTO(id = id, name = id.uppercase(), owningOrgId = owner, organizationIds = orgs, myRole = role, isOrgHome = home, counterpartName = pending)

    private fun g(id: String, w: String?, at: String, kind: String = "group", unread: Int = 0, parent: String? = null, derive: String? = null, muted: String? = null) =
        ConversationDTO(id = id, workspaceId = w, kind = kind, name = id, lastMessageAt = at, unread = unread, parentId = parent, deriveKind = derive, mutedUntil = muted)

    private val data = BootstrapDTO(
        me = UserDTO(id = "u1", primaryOrgId = "mine"),
        organizations = listOf(mine, acme, beta),
        workspaces = listOf(
            ws("w-home", "mine", listOf("mine"), home = true),
            ws("w-old", "mine", listOf("mine")),
            ws("w-a1", "mine", listOf("mine", "acme")),
            ws("w-a2", "acme", listOf("acme", "mine")),
            ws("w-b", "beta", listOf("beta", "mine")),
            ws("w-p", "mine", listOf("mine"), pending = "Nestlé"),
            ws("w-g", "beta", listOf("beta"), role = "guest"),
        ),
        conversations = listOf(
            g("g-home", "w-home", "2026-09-25T10:00:00Z"),
            g("g-old", "w-old", "2026-09-24T10:00:00Z", kind = "internal"),
            g("g-a1", "w-a1", "2026-09-23T10:00:00Z", unread = 2),
            g("g-der", "w-a1", "2026-09-22T10:00:00Z", parent = "g-a1", derive = "same"),
            g("g-a2", "w-a2", "2026-09-21T10:00:00Z"),
            g("g-b", "w-b", "2026-09-20T10:00:00Z", unread = 5, muted = "2099-01-01T00:00:00Z"),
            g("g-p", "w-p", "2026-09-19T10:00:00Z"),
            g("g-g", "w-g", "2026-09-18T10:00:00Z"),
            // Sidechat (multi sin espacio) de g-a1, un directo y un chat grupal: van a DMs.
            g("s1", null, "2026-09-25T11:00:00Z", kind = "multi", unread = 1, parent = "g-a1", derive = "side"),
            g("d1", null, "2026-09-25T09:00:00Z", kind = "direct", unread = 3),
            g("m1", null, "2026-09-17T09:00:00Z", kind = "multi"),
        ),
    )

    private fun issue(id: String, conv: String, due: String? = null, status: String = "open", created: String = "2026-09-0${id.last()}T00:00:00Z") =
        IssueDTO(id = id, conversationId = conv, title = "Asunto $id", status = status, dueDate = due, createdAt = created)

    private val issues = listOf(
        issue("i1", "g-a1"), issue("i2", "g-a1"), issue("i3", "g-a1", due = "2026-09-01"), issue("i4", "g-a1"), issue("i5", "g-a1"),
        issue("i6", "g-a1", status = "done"), issue("i7", "g-home", status = "waiting"),
    )

    private fun build(q: String = "", ws: String? = null, collapsed: Set<String> = emptySet(), tab: GroupsTree.Tab = GroupsTree.Tab.ALL, list: List<IssueDTO> = issues, d: BootstrapDTO = data) =
        GroupsTree.build(d, list, q, ws, collapsed, { it.name ?: it.id }, nowMs = 0, tab = tab, today = "2026-09-26")
    private val open = setOf(GroupsTree.issuesKey("g-a1"), GroupsTree.issuesKey("g-home"))

    @Test fun `regla exacta de secciones`() {
        assertEquals(GroupsTree.Placement(GroupsTree.Kind.ORG, "mine", null), GroupsTree.place(data, data.workspaces[0]))
        assertEquals(GroupsTree.Placement(GroupsTree.Kind.RELATIONS, "acme", null), GroupsTree.place(data, data.workspaces[2]))
        // La contraparte es la primera empresa que no es mía, aunque la dueña sea la otra.
        assertEquals(GroupsTree.Placement(GroupsTree.Kind.RELATIONS, "beta", null), GroupsTree.place(data, data.workspaces[4]))
        val pending = GroupsTree.place(data, data.workspaces[5])
        assertEquals(GroupsTree.Kind.RELATIONS, pending.kind); assertNull(pending.orgId); assertEquals("Nestlé", pending.pendingName)
        assertEquals(GroupsTree.Placement(GroupsTree.Kind.GUEST, "beta", null), GroupsTree.place(data, data.workspaces[6]))
    }

    @Test fun `arbol completo en orden, asuntos plegados por defecto`() {
        assertEquals(listOf(
            "s:ORG:mine", "c:g-home", "c:g-old",
            "s:RELATIONS",
            "o:RELATIONS:acme", "c:g-a1", "c:g-a2",
            "o:RELATIONS:beta", "c:g-b",
            "o:RELATIONS:pending:nestlé", "c:g-p",
            "s:GUEST", "o:GUEST:beta", "c:g-g",
        ), build().map { it.key })
        // Desplegados (clave iss:<id>): hasta 3 y «+N asuntos».
        assertEquals(listOf(
            "s:ORG:mine", "c:g-home", "i:i7", "c:g-old",
            "s:RELATIONS",
            "o:RELATIONS:acme", "c:g-a1", "i:i3", "i:i5", "i:i4", "mi:g-a1", "c:g-a2",
            "o:RELATIONS:beta", "c:g-b",
            "o:RELATIONS:pending:nestlé", "c:g-p",
            "s:GUEST", "o:GUEST:beta", "c:g-g",
        ), build(collapsed = open).map { it.key })
    }

    @Test fun `chip de asuntos con conteo local y vencidos`() {
        fun g(k: String, rows: List<GroupsTree.Row>) = rows.first { it.key == k } as GroupsTree.Group
        val rows = build()
        // i1…i5 activos (i6 está resuelto): 5 asuntos, 1 vencido (i3, 1-sep).
        assertEquals(5, g("c:g-a1", rows).issueCount); assertEquals(1, g("c:g-a1", rows).overdueCount)
        assertFalse(g("c:g-a1", rows).issuesExpanded)
        assertEquals(1, g("c:g-home", rows).issueCount) // waiting cuenta como activo
        assertEquals(0, g("c:g-old", rows).issueCount)
        assertTrue(g("c:g-a1", build(collapsed = open)).issuesExpanded)
        // Un grupo sin asuntos nunca queda «desplegado» aunque tenga la clave.
        assertFalse(g("c:g-old", build(collapsed = setOf(GroupsTree.issuesKey("g-old")))).issuesExpanded)
    }

    @Test fun `completar un asunto lo saca de la lista y baja el conteo al instante`() {
        // El servidor aún dice openIssues = 9 (atrasado): manda el conteo local.
        val d = data.copy(conversations = data.conversations.map { if (it.id == "g-a1") it.copy(openIssues = 9) else it })
        val done = issues.map { if (it.id == "i3") it.copy(status = "done") else if (it.id == "i5") it.copy(status = "cancelled") else it }
        val rows = build(collapsed = open, list = done, d = d)
        val g = rows.first { it.key == "c:g-a1" } as GroupsTree.Group
        assertEquals(3, g.issueCount); assertEquals(0, g.overdueCount)
        assertFalse(rows.any { it.key == "i:i3" || it.key == "i:i5" })
        assertEquals(listOf("i:i4", "i:i2", "i:i1"), rows.filter { it is GroupsTree.Issue && it.issue.conversationId == "g-a1" }.map { it.key })
        assertFalse(rows.any { it.key == "mi:g-a1" })
        // En curso sigue siendo activo.
        val moving = issues.map { if (it.id == "i1") it.copy(status = "in_progress") else it }
        assertEquals(5, (build(list = moving).first { it.key == "c:g-a1" } as GroupsTree.Group).issueCount)
        assertEquals(setOf("open", "in_progress", "waiting"), GroupsTree.ACTIVE_STATUSES)
    }

    @Test fun `sin asuntos cargados el chip usa openIssues del servidor`() {
        val d = data.copy(conversations = data.conversations.map { if (it.id == "g-a2") it.copy(openIssues = 4) else it })
        val rows = build(list = emptyList(), d = d, collapsed = setOf(GroupsTree.issuesKey("g-a2")))
        assertEquals(4, (rows.first { it.key == "c:g-a2" } as GroupsTree.Group).issueCount)
        // Desplegado sin la lista: solo «+4 asuntos», que abre la lista del grupo.
        assertEquals(4, (rows.first { it.key == "mi:g-a2" } as GroupsTree.MoreIssues).count)
    }

    @Test fun `buscar y el filtro Asuntos despliegan, No leidos respeta el plegado`() {
        assertEquals(listOf("s:RELATIONS", "o:RELATIONS:acme", "c:g-a1", "i:i3", "i:i5", "i:i4", "mi:g-a1"), build(q = "g-a1").map { it.key })
        assertEquals(listOf("s:RELATIONS", "o:RELATIONS:acme", "c:g-a1"), build(tab = GroupsTree.Tab.UNREAD).map { it.key })
    }

    @Test fun `plegar todo, expandir todo y todos los asuntos`() {
        val sec = GroupsTree.sectionKey(GroupsTree.Kind.ORG, "mine")
        val folded = GroupsTree.foldAll(open, data)
        assertTrue(sec in folded); assertTrue(GroupsTree.companyKey(GroupsTree.Kind.RELATIONS, "acme") in folded)
        assertTrue(folded.none { it.startsWith(GroupsTree.ISSUES_PREFIX) })
        assertTrue(GroupsTree.allFolded(folded, data)); assertFalse(GroupsTree.allFolded(folded + GroupsTree.issuesKey("g-a1"), data))
        // Plegado todo: solo cabeceras y empresas.
        assertFalse(build(collapsed = folded).any { it is GroupsTree.Group || it is GroupsTree.Issue })
        val expanded = GroupsTree.expandAll(folded + GroupsTree.sectionKey(GroupsTree.Kind.GUEST), data, issues)
        assertEquals(setOf(GroupsTree.issuesKey("g-a1"), GroupsTree.issuesKey("g-home")), expanded)
        assertEquals(setOf(GroupsTree.issuesKey("g-a1"), GroupsTree.issuesKey("g-home")), GroupsTree.allIssueKeys(data, issues))
        val shown = GroupsTree.showAllIssues(setOf(sec), data, issues)
        assertEquals(setOf(sec) + GroupsTree.allIssueKeys(data, issues), shown)
        assertEquals(setOf(sec), GroupsTree.hideAllIssues(shown))
    }

    @Test fun `sin cabeceras de espacio, hilos fuera del arbol y pendiente marcada`() {
        val rows = build()
        // Ningún espacio como cabecera: los grupos de todos los espacios van directo bajo la empresa.
        assertFalse(rows.any { it.key.startsWith("w:") || it.key.startsWith("pw:") })
        assertEquals(0, (rows.first { it.key == "c:g-home" } as GroupsTree.Group).level)
        assertEquals(0, (rows.first { it.key == "c:g-old" } as GroupsTree.Group).level)
        assertEquals(1, (rows.first { it.key == "c:g-a2" } as GroupsTree.Group).level)
        assertEquals(1, (rows.first { it.key == "c:g-g" } as GroupsTree.Group).level)
        val p = rows.first { it.key == "o:RELATIONS:pending:nestlé" } as GroupsTree.Company
        assertNull(p.org); assertEquals("Nestlé", p.pendingName)
        // La derivada no se lista: vive en la barra del chat.
        assertFalse(rows.any { it.key == "c:g-der" })
        assertEquals(2, (build(collapsed = open).first { it.key == "mi:g-a1" } as GroupsTree.MoreIssues).count)
    }

    @Test fun `hilos con no leidos dan el chip en su grupo`() {
        val d = data.copy(conversations = data.conversations.map { if (it.id == "g-der") it.copy(unread = 4) else it })
        val row = GroupsTree.build(d, issues, "", null, emptySet(), { it.name ?: it.id }, nowMs = 0).first { it.key == "c:g-a1" } as GroupsTree.Group
        assertEquals(4, row.threadUnread)
        // Un sidechat no cuenta como hilo del árbol (va a DMs con su propio no leído).
        assertEquals(0, (build().first { it.key == "c:g-a1" } as GroupsTree.Group).threadUnread)
    }

    @Test fun `mismo nombre en la misma empresa lleva el espacio, nunca en el espacio casa`() {
        val d = data.copy(conversations = data.conversations.map {
            when (it.id) { "g-a2", "g-a1", "g-home", "g-old" -> it.copy(name = "General"); else -> it }
        })
        val rows = GroupsTree.build(d, issues, "", null, emptySet(), { it.name ?: it.id }, nowMs = 0)
        fun label(k: String) = (rows.first { it.key == k } as GroupsTree.Group).label
        assertEquals("W-A1 · General", label("c:g-a1")); assertEquals("W-A2 · General", label("c:g-a2"))
        assertNull(label("c:g-home")); assertEquals("W-OLD · General", label("c:g-old"))
        assertNull(label("c:g-b"))
    }

    @Test fun `espacio sin grupos no aparece, relacion pendiente sin grupos si`() {
        val d = data.copy(
            workspaces = data.workspaces + ws("w-empty", "mine", listOf("mine", "zeta")) + ws("w-p2", "mine", listOf("mine"), pending = "Bimbo"),
            organizations = data.organizations + OrganizationDTO(id = "zeta", name = "Zeta"),
        )
        val keys = GroupsTree.build(d, issues, "", null, emptySet(), { it.name ?: it.id }, nowMs = 0).map { it.key }
        assertFalse("o:RELATIONS:zeta" in keys)
        assertTrue("o:RELATIONS:pending:bimbo" in keys)
    }

    @Test fun `sidechats, directos y chats van a DMs`() {
        val keys = build().map { it.key }
        assertFalse("c:s1" in keys); assertFalse("c:d1" in keys); assertFalse("c:m1" in keys)
        val dms = GroupsTree.dms(data, "", { it.name ?: it.id }, nowMs = 0)
        assertEquals(listOf("s1", "d1", "m1"), dms.map { it.id })
        assertEquals("g-a1", GroupsTree.sideOrigin(data, dms[0])?.id)
        assertNull(GroupsTree.sideOrigin(data, dms[1]))
        // Globos: Grupos solo cuenta grupos no silenciados (g-a1); DMs, s1 + d1.
        assertEquals(2, GroupsTree.groupsUnread(data, 0))
        assertEquals(4, GroupsTree.dmsUnread(data, 0))
    }

    @Test fun `hilos de un directo o chat grupal no van a DMs`() {
        // derive same fuera de un espacio: chat multi con parentId, deriveKind same.
        val t = g("t1", null, "2026-09-26T09:00:00Z", kind = "multi", unread = 2, parent = "d1", derive = "same")
        val d = data.copy(conversations = data.conversations + t)
        assertTrue(GroupsTree.isChatThread(d, t)); assertFalse(GroupsTree.isDm(d, t))
        assertEquals(listOf("s1", "d1", "m1"), GroupsTree.dms(d, "", { it.name ?: it.id }, nowMs = 0).map { it.id })
        // Su no leído va al chip «💬 N» de su chat y sigue sumando en el globo de DMs.
        assertEquals(2, GroupsTree.threadUnread(d, 0)["d1"])
        assertEquals(6, GroupsTree.dmsUnread(d, 0))
        // El sidechat sí sigue en DMs.
        assertTrue(GroupsTree.isDm(d, d.conversations.first { it.id == "s1" }))
    }

    @Test fun `plegar, buscar y filtrar`() {
        val folded = build(collapsed = setOf(GroupsTree.companyKey(GroupsTree.Kind.RELATIONS, "acme"))).map { it.key }
        assertTrue("o:RELATIONS:acme" in folded); assertFalse("c:g-a1" in folded)
        val acme = build(collapsed = setOf(GroupsTree.companyKey(GroupsTree.Kind.RELATIONS, "acme"))).first { it.key == "o:RELATIONS:acme" } as GroupsTree.Company
        assertTrue(acme.collapsed); assertEquals(2, acme.unread)
        val sec = build(collapsed = setOf(GroupsTree.sectionKey(GroupsTree.Kind.RELATIONS))).map { it.key }
        assertTrue("s:RELATIONS" in sec); assertFalse("o:RELATIONS:acme" in sec); assertTrue("s:GUEST" in sec)
        // Buscar abre todo y oculta lo vacío.
        assertEquals(listOf("s:RELATIONS", "o:RELATIONS:beta", "c:g-b"),
            build(q = "g-b", collapsed = setOf(GroupsTree.sectionKey(GroupsTree.Kind.RELATIONS))).map { it.key })
        assertEquals(listOf("s:RELATIONS", "o:RELATIONS:acme", "c:g-a1", "i:i3", "i:i5", "i:i4", "mi:g-a1"),
            build(tab = GroupsTree.Tab.UNREAD, collapsed = open).map { it.key })
        assertEquals(listOf("s:ORG:mine", "c:g-home", "i:i7", "s:RELATIONS", "o:RELATIONS:acme", "c:g-a1", "i:i3", "i:i5", "i:i4", "mi:g-a1"),
            build(tab = GroupsTree.Tab.ISSUES).map { it.key })
        assertEquals(listOf("s:RELATIONS", "o:RELATIONS:pending:nestlé", "c:g-p"), build(ws = "w-p").map { it.key })
        assertEquals(listOf<GroupsTree.Row>(GroupsTree.Empty(filtered = true)), build(q = "nada"))
    }

    @Test fun `fijados arriba y estado vacio`() {
        val pinned = data.copy(conversations = data.conversations.map { if (it.id == "g-p") it.copy(pinnedAt = "2026-09-01T00:00:00Z") else it })
        val keys = GroupsTree.build(pinned, issues, "", null, emptySet(), { it.id }, nowMs = 0).map { it.key }
        assertEquals(listOf("s:PINNED", "pc:g-p", "s:ORG:mine"), keys.take(3))
        val empty = BootstrapDTO(me = UserDTO(id = "u1"), organizations = listOf(mine), conversations = listOf(g("d1", null, "x", kind = "direct")))
        assertEquals(listOf<GroupsTree.Row>(GroupsTree.Empty(filtered = false)), GroupsTree.build(empty, emptyList(), "", null, emptySet(), { it.id }, nowMs = 0))
    }

    @Test fun `empresas para Nuevo grupo`() {
        val choices = GroupsTree.companyChoices(data)
        assertEquals(listOf("acme", "beta", "pending:nestlé"), choices.map { it.id })
        assertEquals(listOf("w-a1", "w-a2"), choices[0].workspaces.map { it.id })
        assertTrue(choices[2].pending)
    }

    @Test fun `codigo de invitacion`() {
        assertEquals("K7QM-4XPA", InviteCodes.normalize("k7qm 4xpa"))
        assertEquals("K7QM-4XPA", InviteCodes.normalize("K7QM4XPA"))
        assertEquals("K7QM-4XPA", InviteCodes.normalize(" k7qm-4xpa "))
        assertNull(InviteCodes.normalize("K7QM-4XP"))
        assertNull(InviteCodes.normalize("K7QM-4XP0")) // 0 no está en el alfabeto
    }

    @Test fun `campos nuevos tolerantes`() {
        val old = TcJson.decodeFromString(WorkspaceDTO.serializer(), """{"id":"w","name":"W","owningOrgId":"o"}""")
        assertFalse(old.isOrgHome); assertNull(old.counterpartName)
        val nw = TcJson.decodeFromString(WorkspaceDTO.serializer(), """{"id":"w","isOrgHome":true,"counterpartName":null}""")
        assertTrue(nw.isOrgHome)
        val p = TcJson.decodeFromString(InvitationPreviewDTO.serializer(), """{"workspaceName":"X","valid":true,"groupNames":["Pagos"],"multiUse":true,"orgHome":null}""")
        assertEquals(listOf("Pagos"), p.groupNames); assertTrue(p.multiUse); assertFalse(p.orgHome)
        val r = TcJson.decodeFromString(CreateGroupResultDTO.serializer(), """{"workspaceId":"w","conversationId":"c","invited":1,"inviteUrl":"https://x/invite/t","inviteCode":"K7QM-4XPA"}""")
        assertEquals("K7QM-4XPA", r.inviteCode)
        val o = TcJson.decodeFromString(OversightDTO.serializer(), """{"orgId":"o","groups":[{"conversationId":"c","name":null,"kind":"internal","iAmMember":false,"futuro":1}]}""")
        assertFalse(o.groups[0].iAmMember); assertEquals("internal", o.groups[0].kind)
    }
}
