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

    enum class Kind { PINNED, COMPANIES, CHATS }

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

    fun build(
        d: BootstrapDTO, query: String, wsFilter: String?, collapsed: Set<String>,
        title: (ConversationDTO) -> String, nowMs: Long = System.currentTimeMillis(),
    ): List<Row> {
        val q = query.trim().lowercase()
        val searching = q.isNotEmpty()
        fun matches(c: ConversationDTO): Boolean {
            if (!searching) return true
            if (title(c).lowercase().contains(q)) return true
            if (c.lastMessagePreview?.lowercase()?.contains(q) == true) return true
            return c.memberIds.any { id -> Names.person(d, id)?.name?.lowercase()?.contains(q) == true }
        }
        val ids = d.conversations.map { it.id }.toSet()
        // Laterales cuyo origen veo: cuelgan de él; si no lo veo, van a «Chats».
        val sidesByParent = d.conversations.filter { it.isSide && it.parentId in ids }.groupBy { it.parentId!! }
        val hangingSides = sidesByParent.values.flatten().map { it.id }.toSet()
        fun unread(list: List<ConversationDTO>) = list.sumOf { c -> if (c.mutedAt(nowMs)) 0 else c.unread }

        val rows = mutableListOf<Row>()
        fun addConv(c: ConversationDTO, depth: Int) {
            rows += Conv(c, depth, key = "c:" + c.id)
            sidesByParent[c.id].orEmpty().filter { matches(it) || matches(c) }.forEach { s -> rows += Conv(s, depth + 1, key = "c:" + s.id) }
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
        val groups = groupWorkspaces(d).map { (org, list) -> org to list.filter { wsFilter == null || it.id == wsFilter } }.filter { it.second.isNotEmpty() }
        var anyCompany = false
        for ((org, list) in groups) {
            val perWs = list.map { w -> w to d.conversations.filter { it.workspaceId == w.id && it.id !in hangingSides } }
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
        if (!anyCompany) rows += Empty(Kind.COMPANIES)

        if (wsFilter == null) {
            rows += Section(Kind.CHATS)
            val chats = d.conversations.filter { (it.isChat || (it.workspaceId == null && !it.isChat)) && it.id !in hangingSides }
                .filter { c -> matches(c) || sidesByParent[c.id].orEmpty().any { matches(it) } }
                .sortedByDescending { it.lastMessageAt ?: "" }
            if (chats.isEmpty()) rows += Empty(Kind.CHATS) else chats.forEach { addConv(it, 0) }
        }
        return rows
    }
}
