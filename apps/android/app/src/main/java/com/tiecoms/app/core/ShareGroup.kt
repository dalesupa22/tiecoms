package com.tiecoms.app.core

/**
 * 1.7.13, compartir desde otra app como Instagram: con 2+ destinos que son todos directos con personas, además de
 * «Enviar por separado» (un mensaje a cada uno) se ofrece «Enviar en un grupo»: POST /chats con esas personas (sin
 * nombre, así el servidor retoma el chat grupal que ya exista con exactamente esa gente) y se envía ahí una vez.
 */
object ShareGroup {
    /**
     * Personas para el chat grupal, o null si no aplica: menos de 2 destinos, alguno no es un directo (grupos,
     * chats grupales, «Tú», gg u otro agente) o no sé quién es la otra persona.
     */
    fun people(selected: List<String>, data: BootstrapDTO): List<String>? {
        if (selected.size < 2) return null
        val me = data.me.id
        val ids = selected.map { id ->
            val c = data.conversations.firstOrNull { it.id == id } ?: return null
            if (c.kind != "direct" || c.isSide) return null
            val other = c.memberIds.filter { it != me }.singleOrNull() ?: return null
            if (Gg.isGg(other, data)) return null
            val p = data.people.firstOrNull { it.id == other }
            if (p != null && p.kind != "human") return null
            other
        }.distinct()
        return ids.takeIf { it.size >= 2 }
    }
}

/**
 * 1.7.15: lista del selector de «Compartir en chaggu». Plana, por actividad (lo último arriba), sin encabezados por
 * empresa: el grupo lleva su empresa y espacio como subtítulo gris, sin repetir lo que ya dice el título.
 */
object ShareList {
    data class Row(val c: ConversationDTO, val title: String, val subtitle: String?)

    fun subtitle(c: ConversationDTO, data: BootstrapDTO, title: String): String? {
        val parts = when (c.kind) {
            "direct" -> listOfNotNull(Names.directCompany(c, data))
            "multi" -> listOf(Names.multiSubtitle(c, data))
            else -> data.workspaces.firstOrNull { it.id == c.workspaceId }?.let { ws -> listOfNotNull(HomeTree.counterpartOrg(data, ws)?.name, ws.name) } ?: emptyList()
        }
        val t = QuickSearch.fold(title)
        return parts.map { it.trim() }.filter { it.isNotEmpty() && QuickSearch.fold(it) != t }.distinctBy { QuickSearch.fold(it) }.joinToString(" · ").ifEmpty { null }
    }

    /** Destinos posibles (donde puedo escribir, sin hilos laterales), por actividad; con [query], los que coinciden. */
    fun rows(data: BootstrapDTO, query: String, title: (ConversationDTO) -> String): List<Row> {
        val q = QuickSearch.fold(query.trim())
        return data.conversations.filter { it.canPost && !it.isSide }
            .sortedByDescending { it.lastMessageAt ?: "" }
            .map { c -> val t = title(c); Row(c, t, subtitle(c, data, t)) }
            .filter { r -> q.isEmpty() || QuickSearch.fold(r.title).contains(q) || QuickSearch.fold(r.subtitle ?: "").contains(q) }
    }
}
