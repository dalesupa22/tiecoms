package com.tiecoms.app.core

import java.text.Collator
import java.text.Normalizer
import java.util.Locale

/**
 * Búsqueda rápida de Grupos, DMs y «Mensaje nuevo» (docs/GRUPOS.md › Barra de arriba y búsqueda rápida; igual que iOS):
 * personas, grupos y chats a la vez, para escribirle a alguien o entrar a un grupo sin pasar por su empresa.
 * Una persona sin directo también sale: al tocarla se abre (POST /chats {userIds:[id]}, idempotente con una persona).
 */
object QuickSearch {
    data class Results(val people: List<PersonDTO> = emptyList(), val groups: List<ConversationDTO> = emptyList(), val chats: List<ConversationDTO> = emptyList()) {
        val isEmpty: Boolean get() = people.isEmpty() && groups.isEmpty() && chats.isEmpty()
    }

    /** Sin tildes ni mayúsculas («Ánalía» → «analia»). */
    fun fold(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)

    /** Palabras con las que también me encuentro a mí («Tú», notas para ti), como en la web, iOS, WhatsApp o Slack. */
    private val SELF_WORDS = listOf("tu", "yo", "notas", "conmigo", "you", "me", "notes", "self", "myself")

    /** Yo como persona (por si el directorio no me trae). */
    fun mePerson(d: BootstrapDTO): PersonDTO = Names.person(d, d.me.id)
        ?: PersonDTO(id = d.me.id, name = d.me.name, kind = "human", orgId = d.me.primaryOrgId, title = d.me.title, area = d.me.area, avatarUrl = d.me.avatarUrl)

    /** ¿Lo escrito (ya plegado) me nombra a mí? Mi nombre, cargo, área o empresa, o «tú», «yo», «notas»… */
    fun matchesMe(d: BootstrapDTO, q: String): Boolean {
        if (q.length >= 2 && SELF_WORDS.any { it.startsWith(q) }) return true
        val me = mePerson(d)
        return listOfNotNull(me.name, me.title, me.area, Names.org(d, me.orgId)?.name).any { fold(it).contains(q) }
    }

    /**
     * Personas (humanas, sin [exclude]) cuyo nombre, cargo, área o empresa coincide. Primero quien empieza con
     * lo escrito (Ana antes que Mariana), luego con quien ya tengo directo (el más reciente primero), luego por nombre.
     * Yo también salgo, de primero, si lo escrito me nombra (tocarme abre «Tú», notas para ti).
     */
    fun people(d: BootstrapDTO, query: String, exclude: Set<String> = emptySet()): List<PersonDTO> {
        val q = fold(query.trim())
        if (q.isEmpty()) return emptyList()
        val rank = recentPeopleIds(d).withIndex().associate { (i, id) -> id to i }
        val coll = Collator.getInstance(Locale.getDefault()).apply { strength = Collator.PRIMARY }
        val me = if (d.me.id.isNotEmpty() && d.me.id !in exclude && matchesMe(d, q)) listOf(mePerson(d)) else emptyList()
        return me + d.people
            .filter { it.kind == "human" && it.id != d.me.id && it.id !in exclude }
            .filter { p -> listOfNotNull(p.name, p.title, p.area, Names.org(d, p.orgId)?.name).any { fold(it).contains(q) } }
            .sortedWith { a, b ->
                val pa = fold(a.name).startsWith(q); val pb = fold(b.name).startsWith(q)
                if (pa != pb) return@sortedWith if (pa) -1 else 1
                val ra = rank[a.id] ?: Int.MAX_VALUE; val rb = rank[b.id] ?: Int.MAX_VALUE
                if (ra != rb) return@sortedWith ra.compareTo(rb)
                coll.compare(a.name, b.name)
            }
    }

    /** Grupos (con espacio, sin hilos ni sidechats) por nombre, espacio o empresa de la otra parte; en el orden de Inicio. */
    fun groups(d: BootstrapDTO, query: String, title: (ConversationDTO) -> String, nowMs: Long = System.currentTimeMillis()): List<ConversationDTO> {
        val q = fold(query.trim())
        if (q.isEmpty()) return emptyList()
        return HomeTree.order(d.conversations.filter { GroupsTree.isGroup(d, it) && it.parentId == null }.filter { c ->
            val hay = mutableListOf(title(c))
            d.workspaces.firstOrNull { it.id == c.workspaceId }?.let { ws ->
                hay += ws.name
                ws.counterpartName?.let { hay += it }
                HomeTree.counterpartOrg(d, ws)?.let { hay += it.name }
            }
            hay.any { fold(it).contains(q) }
        }, nowMs)
    }

    /** Chats (directos y grupales) como en la lista de DMs. */
    fun chats(d: BootstrapDTO, query: String, title: (ConversationDTO) -> String, nowMs: Long = System.currentTimeMillis()): List<ConversationDTO> =
        if (query.isBlank()) emptyList() else GroupsTree.dms(d, query, title, nowMs)

    fun run(d: BootstrapDTO, query: String, title: (ConversationDTO) -> String, nowMs: Long = System.currentTimeMillis()): Results =
        Results(people(d, query), groups(d, query, title, nowMs), chats(d, query, title, nowMs))

    /** Personas cuyo directo ya está en [convs] (no se repiten en «Personas»). Yo solo si «Tú» está entre ellos. */
    fun directPeople(d: BootstrapDTO, convs: List<ConversationDTO>): Set<String> = convs.filter { it.kind == "direct" }
        .flatMap { c -> if (Gg.isSelfChat(c, d)) listOf(d.me.id) else c.memberIds.filter { it != d.me.id } }.toSet()

    /** El directo que ya tengo con esa persona (si existe); conmigo mismo es «Tú» (todos sus miembros soy yo). */
    fun direct(d: BootstrapDTO, personId: String): ConversationDTO? =
        d.conversations.firstOrNull { it.kind == "direct" && !GroupsTree.isChatThread(d, it) &&
            if (personId == d.me.id) Gg.isSelfChat(it, d) else personId in it.memberIds }

    /** Personas de mis directos, de la conversación más reciente a la más vieja (fila «Recientes»). */
    fun recentPeopleIds(d: BootstrapDTO): List<String> =
        d.conversations.filter { it.kind == "direct" && !GroupsTree.isChatThread(d, it) }
            .sortedByDescending { HomeTree.activity(it) }
            .mapNotNull { c -> c.memberIds.firstOrNull { it != d.me.id } }
            .filter { id -> Names.person(d, id)?.kind == "human" }
            .distinct()

    /** Hilo con los del chat (derivada que no es sidechat): no es destino de un asunto nuevo. */
    private fun isThread(c: ConversationDTO) = c.parentId != null && !c.isSide

    /** Dónde puedo crear un asunto desde «＋ Crear»: grupos y chats donde escribo y no soy tercero, el más reciente primero. */
    fun issueDestinations(d: BootstrapDTO, nowMs: Long = System.currentTimeMillis()): List<ConversationDTO> =
        HomeTree.order(d.conversations.filter { c ->
            c.canPost && !isThread(c) && d.workspaces.firstOrNull { it.id == c.workspaceId }?.myRole != "guest"
        }, nowMs)

    /**
     * «Grupo · Empresa de la otra parte» (o el nombre del chat) para el selector «Grupo o chat». La empresa es la del
     * árbol de Grupos (GroupsTree.place): una relación pendiente lleva el nombre escrito («Nestlé»), no la mía.
     */
    fun issueLabel(d: BootstrapDTO, c: ConversationDTO, title: (ConversationDTO) -> String): String {
        val ws = d.workspaces.firstOrNull { it.id == c.workspaceId } ?: return title(c)
        val p = GroupsTree.place(d, ws)
        val company = p.pendingName ?: Names.org(d, p.orgId)?.name ?: ws.name
        return "${title(c)} · $company"
    }
}
