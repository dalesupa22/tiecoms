package com.tiecoms.app.core

/**
 * Jerarquía de Inicio: Empresa → Espacio (tema) → Conversaciones (subtemas) → laterales, y luego «Chats».
 * Misma lógica que la barra lateral de la web (apps/web/src/screens/Shell.tsx: groupWorkspaces + counterpartOrg):
 * un espacio cuelga de la empresa contraparte (la primera del espacio que no es mía; si no hay, la dueña).
 */
object HomeTree {
    sealed interface Row { val key: String }
    data class Section(val kind: Kind, override val key: String = "s:" + kind.name) : Row
    data class Org(val org: OrganizationDTO?, val collapsed: Boolean, val unread: Int, override val key: String) : Row
    data class Ws(val ws: WorkspaceDTO, val collapsed: Boolean, val unread: Int, override val key: String = "w:" + ws.id) : Row
    /** depth: 0 = conversación de un espacio o chat; 1 = lateral bajo su origen. */
    data class Conv(val c: ConversationDTO, val depth: Int, val pinnedSection: Boolean = false, override val key: String) : Row
    data class Empty(val kind: Kind, override val key: String = "e:" + kind.name) : Row

    enum class Kind { PINNED, COMPANIES, CHATS, FILTER }

    /** Pestañas de Inicio (SPEC-v4 §C): Todo · No leídos · Asuntos · Chats · Laterales. */
    enum class Tab { ALL, UNREAD, ISSUES, CHATS, SIDES }

    fun inTab(tab: Tab, c: ConversationDTO, nowMs: Long): Boolean = when (tab) {
        Tab.ALL -> true
        Tab.UNREAD -> c.unread > 0 && !c.mutedAt(nowMs)
        Tab.ISSUES -> c.openIssues > 0
        Tab.CHATS -> c.isChat
        Tab.SIDES -> c.isSide
    }

    /** Contador de cada pestaña (Todo = todas las conversaciones). */
    fun counts(d: BootstrapDTO, nowMs: Long = System.currentTimeMillis()): Map<Tab, Int> =
        Tab.entries.associateWith { t -> d.conversations.count { inTab(t, it, nowMs) } }

    fun orgKey(org: OrganizationDTO?) = "org:" + (org?.id ?: "none")
    fun wsKey(ws: WorkspaceDTO) = "ws:" + ws.id

    /** Empresa contraparte de un espacio (counterpartOrg de la web). */
    fun counterpartOrg(d: BootstrapDTO, ws: WorkspaceDTO): OrganizationDTO? {
        val mine = d.organizations.filter { it.myRole != null }.map { it.id }.toSet()
        val other = ws.organizationIds.firstOrNull { it !in mine }
        return Names.org(d, other ?: ws.owningOrgId)
    }

    /** Espacios agrupados por empresa contraparte, en el orden de /bootstrap (groupWorkspaces de la web). */
    fun groupWorkspaces(d: BootstrapDTO): List<Pair<OrganizationDTO?, List<WorkspaceDTO>>> {
        val groups = LinkedHashMap<String, Pair<OrganizationDTO?, MutableList<WorkspaceDTO>>>()
        for (w in d.workspaces) {
            val org = counterpartOrg(d, w)
            groups.getOrPut(org?.id ?: "none") { org to mutableListOf() }.second.add(w)
        }
        return groups.values.map { it.first to it.second.toList() }
    }

    /** Actividad para ordenar (activityOf de la web): último mensaje de una persona si hay; si no, el último. */
    fun activity(c: ConversationDTO): String = c.lastHumanPreview?.createdAt ?: c.lastMessageAt ?: ""

    /** No leídos que cuentan (pendingOf): una silenciada con no leídos cuenta como leída. */
    fun pending(c: ConversationDTO, nowMs: Long): Int = if (c.unread > 0 && !c.mutedAt(nowMs)) c.unread else 0

    /**
     * compareConversations de la web (apps/web/src/screens/Shell.tsx): primero con no leídos, luego fijadas,
     * luego por actividad descendente; desempate por id para que el orden no salte.
     */
    fun comparator(nowMs: Long): Comparator<ConversationDTO> = Comparator { a, b ->
        // Una mención sin leer sube la conversación aunque esté silenciada (SPEC-v4 §H).
        val ua = if (pending(a, nowMs) > 0 || a.unreadMentions > 0) 1 else 0; val ub = if (pending(b, nowMs) > 0 || b.unreadMentions > 0) 1 else 0
        if (ua != ub) return@Comparator ub - ua
        val pa = if (a.pinnedAt != null) 1 else 0; val pb = if (b.pinnedAt != null) 1 else 0
        if (pa != pb) return@Comparator pb - pa
        activity(b).compareTo(activity(a)).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }

    fun order(list: List<ConversationDTO>, nowMs: Long): List<ConversationDTO> = list.sortedWith(comparator(nowMs))

    /** groupRank + compareRank de la web: con no leídos primero, luego más no leídos, luego actividad más reciente. */
    data class Rank(val unread: Int, val activity: String)
    fun rank(convs: List<ConversationDTO>, nowMs: Long) = Rank(convs.sumOf { pending(it, nowMs) + it.unreadMentions }, convs.maxOfOrNull { activity(it) } ?: "")
    fun compareRank(a: Rank, b: Rank): Int {
        if ((a.unread > 0) != (b.unread > 0)) return if (a.unread > 0) -1 else 1
        return (b.unread - a.unread).takeIf { it != 0 } ?: b.activity.compareTo(a.activity)
    }

    fun build(
        d: BootstrapDTO, query: String, wsFilter: String?, collapsed: Set<String>,
        title: (ConversationDTO) -> String, nowMs: Long = System.currentTimeMillis(), tab: Tab = Tab.ALL,
    ): List<Row> {
        val q = query.trim().lowercase()
        val textSearch = q.isNotEmpty()
        // Buscar o filtrar por pestaña oculta los grupos vacíos y abre todo (un grupo contraído no esconde lo que se busca).
        val searching = textSearch || tab != Tab.ALL
        fun textMatches(c: ConversationDTO): Boolean {
            if (!textSearch) return true
            if (title(c).lowercase().contains(q)) return true
            if (c.lastMessagePreview?.lowercase()?.contains(q) == true) return true
            return c.memberIds.any { id -> Names.person(d, id)?.name?.lowercase()?.contains(q) == true }
        }
        fun matches(c: ConversationDTO) = textMatches(c) && inTab(tab, c, nowMs)
        val ids = d.conversations.map { it.id }.toSet()
        // Laterales cuyo origen veo: cuelgan de él; si no lo veo, van a «Chats».
        val sidesByParent = d.conversations.filter { it.isSide && it.parentId in ids }.groupBy { it.parentId!! }
        val hangingSides = sidesByParent.values.flatten().map { it.id }.toSet()
        fun unread(list: List<ConversationDTO>) = list.sumOf { c -> if (c.mutedAt(nowMs)) 0 else c.unread }

        val rows = mutableListOf<Row>()
        fun addConv(c: ConversationDTO, depth: Int) {
            rows += Conv(c, depth, key = "c:" + c.id)
            sidesByParent[c.id].orEmpty().filter { matches(it) || (tab == Tab.ALL && matches(c)) }.forEach { s -> rows += Conv(s, depth + 1, key = "c:" + s.id) }
        }

        // 📌 Fijados (espacios y conversaciones), como la web.
        if (wsFilter == null && !searching) {
            val pinned = d.conversations.filter { it.pinnedAt != null }.sortedBy { it.pinnedAt }
            val pinnedWs = d.workspaces.filter { it.pinnedAt != null }
            if (pinned.isNotEmpty() || pinnedWs.isNotEmpty()) {
                rows += Section(Kind.PINNED)
                pinnedWs.forEach { rows += Ws(it, collapsed = true, unread = 0, key = "pw:" + it.id) }
                pinned.forEach { rows += Conv(it, 0, pinnedSection = true, key = "pc:" + it.id) }
            }
        }

        rows += Section(Kind.COMPANIES)
        fun convsOf(w: WorkspaceDTO) = d.conversations.filter { it.workspaceId == w.id }
        // sortHome de la web: espacios y empresas por no leído agregado y luego por actividad; desempate por id.
        val groups = groupWorkspaces(d).map { (org, list) -> org to list.filter { wsFilter == null || it.id == wsFilter }
                .sortedWith { a, b -> compareRank(rank(convsOf(a), nowMs), rank(convsOf(b), nowMs)).takeIf { it != 0 } ?: a.id.compareTo(b.id) } }
            .filter { it.second.isNotEmpty() }
            .sortedWith { a, b ->
                compareRank(rank(a.second.flatMap { convsOf(it) }, nowMs), rank(b.second.flatMap { convsOf(it) }, nowMs)).takeIf { it != 0 }
                    ?: (a.first?.id ?: "").compareTo(b.first?.id ?: "")
            }
        var anyCompany = false
        for ((org, list) in groups) {
            val perWs = list.map { w -> w to order(d.conversations.filter { it.workspaceId == w.id && it.id !in hangingSides }, nowMs) }
            val visible = perWs.map { (w, convs) -> w to convs.filter { c -> matches(c) || sidesByParent[c.id].orEmpty().any { matches(it) } } }
                .filter { !searching || it.second.isNotEmpty() }
            if (visible.isEmpty()) continue
            anyCompany = true
            val oKey = orgKey(org)
            val orgCollapsed = !searching && oKey in collapsed
            val orgConvs = perWs.flatMap { (_, cs) -> cs + cs.flatMap { sidesByParent[it.id].orEmpty() } }
            rows += Org(org, orgCollapsed, unread(orgConvs), key = "o:" + (org?.id ?: "none"))
            if (orgCollapsed) continue
            for ((w, convs) in visible) {
                val wKey = wsKey(w)
                val wsCollapsed = !searching && wKey in collapsed
                rows += Ws(w, wsCollapsed, unread(convs + convs.flatMap { sidesByParent[it.id].orEmpty() }))
                if (!wsCollapsed) convs.forEach { addConv(it, 0) }
            }
        }
        if (!anyCompany && tab == Tab.ALL) rows += Empty(Kind.COMPANIES)
        if (!anyCompany && tab != Tab.ALL) rows.removeAt(rows.lastIndex) // sin «Empresas y espacios» vacío en un filtro

        if (wsFilter == null) {
            val chats = d.conversations.filter { (it.isChat || it.workspaceId == null) && it.id !in hangingSides }
                .filter { c -> matches(c) || sidesByParent[c.id].orEmpty().any { matches(it) } }
                .let { order(it, nowMs) }
            if (tab == Tab.ALL || chats.isNotEmpty()) {
                rows += Section(Kind.CHATS)
                if (chats.isEmpty()) rows += Empty(Kind.CHATS) else chats.forEach { addConv(it, 0) }
            }
        }
        if (tab != Tab.ALL && rows.none { it is Conv }) return listOf(Empty(Kind.FILTER))
        return rows
    }
}
