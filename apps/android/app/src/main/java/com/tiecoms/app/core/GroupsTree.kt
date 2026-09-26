package com.tiecoms.app.core

/**
 * Pestañas Grupos y DMs (docs/GRUPOS.md; misma regla en web e iOS).
 *
 * Grupos:
 *   Tu organización · X   una sección por empresa mía, con los grupos de todos sus espacios
 *   Relaciones            espacios compartidos, bajo la empresa contraparte (o su counterpartName, pendiente)
 *   Invitado en           espacios donde soy tercero (myRole guest), bajo la empresa anfitriona
 * Solo grupos y asuntos: ningún espacio se muestra como cabecera; los hilos (derivadas) viven en la barra del chat.
 * Bajo cada grupo, un chip «◆ N asuntos» (y «N vencidos») pliega sus asuntos activos, plegados por defecto
 * (26-sep-2026: con 7 grupos de 7 a 18 asuntos la lista era eterna). Desplegados: hasta 3 y «+N asuntos».
 * Buscar o el filtro Asuntos los muestran todos desplegados. Directos, chats y sidechats van a DMs.
 * El orden de siempre (compareConversations / sortHome de la web) se mantiene dentro de cada sección.
 */
object GroupsTree {
    enum class Kind { PINNED, ORG, RELATIONS, GUEST }

    /** Filtros de Grupos: los de Inicio sin Chats ni Laterales (esos viven en DMs). */
    enum class Tab { ALL, UNREAD, ISSUES }

    /** Asuntos visibles bajo cada grupo antes de la fila «+N asuntos». */
    const val MAX_ISSUES = 3

    sealed interface Row { val key: String }
    /** Cabecera de sección. En ORG lleva la empresa («Tu organización · X»). */
    data class Section(val kind: Kind, val org: OrganizationDTO?, val collapsed: Boolean, val unread: Int, override val key: String) : Row
    /** Empresa de una relación o anfitriona («Invitado en»). [pendingName]: relación cuya empresa aún no entra. */
    data class Company(val kind: Kind, val id: String, val org: OrganizationDTO?, val pendingName: String?, val workspaces: List<WorkspaceDTO>,
                       val collapsed: Boolean, val unread: Int, override val key: String) : Row
    /**
     * Grupo. [label]: «{espacio} · {grupo}» cuando dos grupos de la empresa se llaman igual; [threadUnread]: no leídos
     * de sus hilos (no se listan en el árbol, viven en la barra del chat).
     */
    data class Group(val c: ConversationDTO, val level: Int, val pinnedSection: Boolean = false, val label: String? = null, val threadUnread: Int = 0,
                     /** Asuntos activos (open, in_progress, waiting), contados aquí: el openIssues del servidor puede ir atrasado. */
                     val issueCount: Int = 0, val overdueCount: Int = 0,
                     /** Sus asuntos están desplegados (clave [issuesKey] en los ajustes, o buscando). */
                     val issuesExpanded: Boolean = false, override val key: String) : Row
    data class Issue(val issue: IssueDTO, val level: Int, override val key: String) : Row
    data class MoreIssues(val conversationId: String, val count: Int, val level: Int, override val key: String) : Row
    /** Sin nada que mostrar: [filtered] = por búsqueda o filtro (si no, es el estado vacío de Grupos). */
    data class Empty(val filtered: Boolean, override val key: String = "empty") : Row

    // ---------- Claves de plegado (se guardan en los ajustes) ----------
    fun sectionKey(kind: Kind, orgId: String? = null) = "gs:" + kind.name + (orgId?.let { ":$it" } ?: "")
    fun companyKey(kind: Kind, id: String) = "gc:" + kind.name + ":" + id
    /** Al revés que las demás: la clave presente significa asuntos DESPLEGADOS (plegados por defecto). */
    fun issuesKey(conversationId: String) = ISSUES_PREFIX + conversationId
    const val ISSUES_PREFIX = "iss:"

    // ---------- Regla del árbol ----------
    /** Dónde va un espacio: sección y empresa (id de la organización o, si está pendiente, el nombre escrito). */
    data class Placement(val kind: Kind, val orgId: String?, val pendingName: String?) {
        /** Clave de la empresa dentro de la sección (las pendientes con el mismo nombre se juntan). */
        val companyId: String get() = orgId ?: ("pending:" + (pendingName ?: "").trim().lowercase())
    }

    fun myOrgIds(d: BootstrapDTO): Set<String> = d.organizations.filter { it.myRole != null }.map { it.id }.toSet()

    /**
     * La regla exacta de docs/GRUPOS.md:
     *  guest → «Invitado en» bajo la dueña; si no, contraparte = primera empresa del espacio que no es mía →
     *  «Relaciones»; si no hay y trae counterpartName → «Relaciones» pendiente; si no → «Tu organización · dueña».
     */
    fun place(d: BootstrapDTO, w: WorkspaceDTO, mine: Set<String> = myOrgIds(d)): Placement {
        if (w.myRole == "guest") return Placement(Kind.GUEST, w.owningOrgId, null)
        val other = w.organizationIds.firstOrNull { it !in mine }
        if (other != null) return Placement(Kind.RELATIONS, other, null)
        val pending = w.counterpartName?.trim()?.takeIf { it.isNotEmpty() }
        if (pending != null) return Placement(Kind.RELATIONS, null, pending)
        return Placement(Kind.ORG, w.owningOrgId, null)
    }

    /** Una relación (o empresa anfitriona) con sus espacios, en el orden de /bootstrap. */
    data class Relation(val kind: Kind, val id: String, val org: OrganizationDTO?, val pendingName: String?, val workspaces: List<WorkspaceDTO>) {
        val pending: Boolean get() = org == null && pendingName != null
    }

    /** Espacios agrupados por sección y empresa (sin ordenar por actividad). */
    fun relations(d: BootstrapDTO): List<Relation> {
        val mine = myOrgIds(d)
        val out = LinkedHashMap<String, Relation>()
        for (w in d.workspaces) {
            val p = place(d, w, mine)
            val k = p.kind.name + "|" + p.companyId
            val prev = out[k]
            out[k] = prev?.copy(workspaces = prev.workspaces + w) ?: Relation(p.kind, p.companyId, Names.org(d, p.orgId), p.pendingName, listOf(w))
        }
        return out.values.toList()
    }

    /** Relaciones con otra empresa donde puedo crear grupos (el selector «Empresa» de Nuevo grupo). */
    fun companyChoices(d: BootstrapDTO): List<Relation> = relations(d).filter { it.kind == Kind.RELATIONS }

    // ---------- Qué va en cada pestaña ----------
    /** Conversación de Grupos: tiene un espacio conocido y no es chat ni sidechat. */
    fun isGroup(d: BootstrapDTO, c: ConversationDTO): Boolean =
        c.workspaceId != null && !c.isChat && !c.isSide && d.workspaces.any { it.id == c.workspaceId }

    /**
     * DMs: directos y chats `multi`, incluidos los sidechats (y cualquier conversación sin espacio conocido).
     * Los hilos de un directo o chat grupal (derive same fuera de un espacio, 26-sep-2026) no: viven en la barra
     * de hilos de su chat, como los de los grupos; su no leído va como «💬 N» en el chat.
     */
    fun isDm(d: BootstrapDTO, c: ConversationDTO): Boolean = !isGroup(d, c) && !isChatThread(d, c)

    /** Hilo de un directo o chat grupal: tiene padre, no es sidechat y no es de un grupo. */
    fun isChatThread(d: BootstrapDTO, c: ConversationDTO): Boolean = c.parentId != null && !c.isSide && !isGroup(d, c)

    /** No leídos de los hilos (no sidechats) de cada conversación: el chip «💬 N». */
    fun threadUnread(d: BootstrapDTO, nowMs: Long = System.currentTimeMillis()): Map<String, Int> =
        d.conversations.filter { it.parentId != null && !it.isSide }.groupBy { it.parentId!! }.mapValues { (_, l) -> l.sumOf { HomeTree.pending(it, nowMs) } }

    /** Globo de Grupos y de DMs: no leídos que cuentan (sin silenciadas). */
    fun groupsUnread(d: BootstrapDTO, nowMs: Long = System.currentTimeMillis()): Int = d.conversations.filter { isGroup(d, it) }.sumOf { HomeTree.pending(it, nowMs) }
    fun dmsUnread(d: BootstrapDTO, nowMs: Long = System.currentTimeMillis()): Int = d.conversations.filter { isDm(d, it) || isChatThread(d, it) }.sumOf { HomeTree.pending(it, nowMs) }

    /** DMs en el orden de Inicio (compareConversations), con búsqueda por título, vista previa o personas. */
    fun dms(d: BootstrapDTO, query: String, title: (ConversationDTO) -> String, nowMs: Long = System.currentTimeMillis(), unreadOnly: Boolean = false): List<ConversationDTO> {
        val q = query.trim().lowercase()
        return HomeTree.order(d.conversations.filter { isDm(d, it) }
            .filter { !unreadOnly || HomeTree.pending(it, nowMs) > 0 || it.unreadMentions > 0 }
            .filter { c -> q.isEmpty() || matchesText(d, c, q, title) }, nowMs)
    }

    /** Origen visible de un sidechat («desde #Grupo»); null si no lo puedo ver. */
    fun sideOrigin(d: BootstrapDTO, c: ConversationDTO): ConversationDTO? =
        if (c.isSide) d.conversations.firstOrNull { it.id == c.parentId } else null

    /** Estados activos: los únicos que se listan y cuentan bajo los grupos (ni done ni cancelled). */
    val ACTIVE_STATUSES = setOf("open", "in_progress", "waiting")
    fun isActive(i: IssueDTO) = i.status in ACTIVE_STATUSES

    /** Asuntos activos de un grupo: primero los que tienen fecha (la más cercana), luego los más nuevos. */
    fun openIssues(issues: Collection<IssueDTO>, conversationId: String): List<IssueDTO> =
        issues.filter { it.conversationId == conversationId && isActive(it) }
            .sortedWith(compareBy<IssueDTO> { it.dueDate == null }.thenBy { it.dueDate ?: "" }.thenByDescending { it.createdAt }.thenBy { it.id })

    private fun matchesText(d: BootstrapDTO, c: ConversationDTO, q: String, title: (ConversationDTO) -> String): Boolean {
        if (title(c).lowercase().contains(q)) return true
        if (c.lastMessagePreview?.lowercase()?.contains(q) == true) return true
        return c.memberIds.any { id -> Names.person(d, id)?.name?.lowercase()?.contains(q) == true }
    }

    fun inTab(tab: Tab, c: ConversationDTO, issues: Collection<IssueDTO>, nowMs: Long): Boolean = when (tab) {
        Tab.ALL -> true
        Tab.UNREAD -> HomeTree.pending(c, nowMs) > 0 || c.unreadMentions > 0
        Tab.ISSUES -> if (issues.isEmpty()) c.openIssues > 0 else issues.any { it.conversationId == c.id && isActive(it) }
    }

    /** Contador de cada filtro (Todo = todos los grupos). */
    fun counts(d: BootstrapDTO, issues: Collection<IssueDTO>, nowMs: Long = System.currentTimeMillis()): Map<Tab, Int> {
        val groups = d.conversations.filter { isGroup(d, it) }
        return Tab.entries.associateWith { t -> groups.count { inTab(t, it, issues, nowMs) } }
    }

    fun build(
        d: BootstrapDTO, issues: Collection<IssueDTO>, query: String, wsFilter: String?, collapsed: Set<String>,
        title: (ConversationDTO) -> String, nowMs: Long = System.currentTimeMillis(), tab: Tab = Tab.ALL,
        /** Hoy (AAAA-MM-DD) para contar los vencidos. */
        today: String = java.time.LocalDate.now().toString(),
    ): List<Row> {
        val q = query.trim().lowercase()
        val searching = q.isNotEmpty() || tab != Tab.ALL
        // Buscar y el filtro Asuntos muestran los asuntos desplegados; si no, cada grupo recuerda el suyo.
        val showAllIssues = q.isNotEmpty() || tab == Tab.ISSUES
        // Sin asuntos cargados todavía, el chip usa el openIssues del servidor.
        val issuesLoaded = issues.isNotEmpty()
        fun matches(c: ConversationDTO) = (q.isEmpty() || matchesText(d, c, q, title)) && inTab(tab, c, issues, nowMs)
        val groupsByWs = d.conversations.filter { isGroup(d, it) }.groupBy { it.workspaceId!! }
        fun convsOf(w: WorkspaceDTO) = groupsByWs[w.id].orEmpty()
        fun unread(list: List<ConversationDTO>) = list.sumOf { HomeTree.pending(it, nowMs) }
        // Los hilos (derivadas) no se listan: viven en la barra de su chat; su no leído va como «💬 N» en el grupo.
        val threadUnread = threadUnread(d, nowMs)
        fun listed(w: WorkspaceDTO) = convsOf(w).filter { it.parentId == null }
        val rows = mutableListOf<Row>()

        /**
         * Solo grupos y asuntos (26-sep-2026): los grupos de todos los espacios de la empresa, sin cabecera de espacio.
         * Si dos se llaman igual, «{espacio} · {grupo}» (nunca en el espacio casa).
         */
        fun addGroups(spaces: List<WorkspaceDTO>, level: Int) {
            val byWs = spaces.associateBy { it.id }
            val all = spaces.flatMap { listed(it) }
            val dup = all.groupingBy { title(it).trim().lowercase() }.eachCount().filterValues { it > 1 }.keys
            HomeTree.order(all.filter { matches(it) }, nowMs).forEach { c ->
                val ws = byWs[c.workspaceId]
                val label = if (ws != null && !ws.isOrgHome && title(c).trim().lowercase() in dup) ws.name + " · " + title(c) else null
                val open = openIssues(issues, c.id)
                val count = if (open.isNotEmpty() || issuesLoaded) open.size else c.openIssues
                val expanded = count > 0 && (showAllIssues || issuesKey(c.id) in collapsed)
                rows += Group(c, level, label = label, threadUnread = threadUnread[c.id] ?: 0,
                    issueCount = count, overdueCount = open.count { it.dueDate != null && it.dueDate < today }, issuesExpanded = expanded, key = "c:" + c.id)
                if (!expanded) return@forEach
                open.take(MAX_ISSUES).forEach { rows += Issue(it, level + 1, key = "i:" + it.id) }
                if (count > MAX_ISSUES) rows += MoreIssues(c.id, count - minOf(open.size, MAX_ISSUES), level + 1, key = "mi:" + c.id)
            }
        }
        fun hasVisible(r: Relation) = r.workspaces.any { w -> listed(w).any { matches(it) } }
        fun hasGroups(r: Relation) = r.workspaces.any { listed(it).isNotEmpty() }

        // 📌 Fijados (grupos), como Inicio.
        if (wsFilter == null && !searching) {
            val pinned = d.conversations.filter { it.pinnedAt != null && isGroup(d, it) && it.parentId == null }.sortedBy { it.pinnedAt }
            if (pinned.isNotEmpty()) {
                rows += Section(Kind.PINNED, null, false, 0, key = "s:PINNED")
                pinned.forEach { rows += Group(it, 0, pinnedSection = true, threadUnread = threadUnread[it.id] ?: 0, key = "pc:" + it.id) }
            }
        }

        // Un espacio sin grupos no aparece; una relación pendiente sin grupos sí.
        val all = relations(d).map { r -> r.copy(workspaces = r.workspaces.filter { wsFilter == null || it.id == wsFilter }) }
            .filter { it.workspaces.isNotEmpty() && (hasGroups(it) || it.pending) }
        val primary = d.me.primaryOrgId
        val orgOrder = d.organizations.filter { it.myRole != null }.map { it.id }.sortedBy { if (it == primary) 0 else 1 }
        fun convs(r: Relation) = r.workspaces.flatMap { convsOf(it) }

        // Tu organización · X (una por cada empresa mía, la principal primero).
        val orgSections = all.filter { it.kind == Kind.ORG }.sortedBy { r -> orgOrder.indexOf(r.id).let { if (it < 0) Int.MAX_VALUE else it } }
        for (r in orgSections) {
            if (searching && !hasVisible(r)) continue
            val k = sectionKey(Kind.ORG, r.id)
            val folded = !searching && k in collapsed
            rows += Section(Kind.ORG, r.org, folded, unread(convs(r)), key = "s:ORG:" + r.id)
            if (!folded) addGroups(r.workspaces, 0)
        }

        // Relaciones e Invitado en: empresas por no leído agregado y actividad.
        for (kind in listOf(Kind.RELATIONS, Kind.GUEST)) {
            val list = all.filter { it.kind == kind }.filter { r -> !searching || hasVisible(r) }
                .sortedWith { a, b -> HomeTree.compareRank(HomeTree.rank(convs(a), nowMs), HomeTree.rank(convs(b), nowMs)).takeIf { it != 0 } ?: a.id.compareTo(b.id) }
            if (list.isEmpty()) continue
            val sk = sectionKey(kind)
            val sFolded = !searching && sk in collapsed
            rows += Section(kind, null, sFolded, unread(list.flatMap { convs(it) }), key = "s:" + kind.name)
            if (sFolded) continue
            for (r in list) {
                val ck = companyKey(kind, r.id)
                val folded = !searching && ck in collapsed
                rows += Company(kind, r.id, r.org, r.pendingName, r.workspaces, folded, unread(convs(r)), key = "o:" + kind.name + ":" + r.id)
                if (!folded) addGroups(r.workspaces, 1)
            }
        }

        if (rows.none { it is Group || it is Section && it.kind != Kind.PINNED }) return listOf(Empty(filtered = searching || wsFilter != null))
        if (searching && rows.none { it is Group }) return listOf(Empty(filtered = true))
        return rows
    }

    /** Todas las claves plegables del árbol («Plegar todo»): empresas mías y empresas de Relaciones e Invitado en. */
    fun allFoldKeys(d: BootstrapDTO): Set<String> =
        relations(d).flatMap { r ->
            val base = if (r.kind == Kind.ORG) listOf(sectionKey(Kind.ORG, r.id)) else listOf(companyKey(r.kind, r.id))
            base
        }.toSet()

    /** Claves «asuntos desplegados» de todos los grupos con asuntos activos («Mostrar todos los asuntos»). */
    fun allIssueKeys(d: BootstrapDTO, issues: Collection<IssueDTO>): Set<String> =
        d.conversations.filter { isGroup(d, it) && it.parentId == null }
            .filter { c -> if (issues.isEmpty()) c.openIssues > 0 else issues.any { it.conversationId == c.id && isActive(it) } }
            .map { issuesKey(it.id) }.toSet()

    // ---------- Acciones de los menús (Plegar todo, Expandir todo, asuntos) ----------
    /** «Plegar todo»: pliega empresas y secciones y también los asuntos de cada grupo. */
    fun foldAll(collapsed: Set<String>, d: BootstrapDTO): Set<String> = (collapsed + allFoldKeys(d)).filterNot { it.startsWith(ISSUES_PREFIX) }.toSet()
    /** «Expandir todo»: despliega empresas, secciones y los asuntos de todos los grupos. */
    fun expandAll(collapsed: Set<String>, d: BootstrapDTO, issues: Collection<IssueDTO>): Set<String> =
        collapsed.filterNot { it.startsWith("gs:") || it.startsWith("gc:") }.toSet() + allIssueKeys(d, issues)
    fun showAllIssues(collapsed: Set<String>, d: BootstrapDTO, issues: Collection<IssueDTO>): Set<String> = collapsed + allIssueKeys(d, issues)
    fun hideAllIssues(collapsed: Set<String>): Set<String> = collapsed.filterNot { it.startsWith(ISSUES_PREFIX) }.toSet()
    /** ¿Está todo plegado? (para decidir si el menú ofrece «Expandir todo»). */
    fun allFolded(collapsed: Set<String>, d: BootstrapDTO): Boolean = allFoldKeys(d).let { it.isNotEmpty() && collapsed.containsAll(it) } && collapsed.none { it.startsWith(ISSUES_PREFIX) }
}

/** Código de invitación que escribe la persona (K7QM-4XPA): acepta minúsculas, espacios y sin guion. */
object InviteCodes {
    private const val ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

    /** «k7qm 4xpa» → «K7QM-4XPA»; null si no son 8 caracteres válidos. */
    fun normalize(raw: String): String? {
        val s = raw.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }
        if (s.length != 8 || s.any { it !in ALPHABET }) return null
        return s.take(4) + "-" + s.drop(4)
    }
}
