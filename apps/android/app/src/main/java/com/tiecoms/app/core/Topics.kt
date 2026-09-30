package com.tiecoms.app.core

import kotlinx.serialization.Serializable

/**
 * Tema fijo de una conversación (docs/TEMAS.md): una banderita con color e ícono.
 * Los temas no son hilos ni tareas: son etiquetas que se ponen a los mensajes del mismo chat.
 * Decodificación tolerante: todo tiene valor por defecto y un color desconocido se pinta azul.
 */
@Serializable
data class TopicDTO(
    val id: String = "",
    val conversationId: String = "",
    val name: String = "",
    /** blue | green | orange | violet | magenta | aqua | red | yellow ([Topics.COLORS]). */
    val color: String = "blue",
    val icon: String = "#",
    val position: Int = 0,
    /** null = activo (está en la fila); con fecha = archivado (sus mensajes conservan la etiqueta en gris). */
    val archivedAt: String? = null,
    val createdBy: String = "",
    val createdAt: String = "",
) {
    val archived: Boolean get() = archivedAt != null
}

/** GET /conversations/:id/topics, PATCH /topics/:id y DELETE /topics/:id (este además con [cleared]). */
@Serializable
data class TopicsPage(val topics: List<TopicDTO> = emptyList(), val cleared: Int = 0)

/** POST /conversations/:id/topics: el tema creado y la lista completa. */
@Serializable
data class TopicCreated(val topic: TopicDTO = TopicDTO(), val topics: List<TopicDTO> = emptyList())

/** Reglas de los temas, sin interfaz (las mismas de la web: apps/web/src/screens/Topics.tsx). */
object Topics {
    /** Tope técnico del servidor; no hay límite práctico. Si se llega, el servidor responde 409 y se muestra su mensaje. */
    const val LIMIT = 50
    val COLORS = listOf("blue", "green", "orange", "violet", "magenta", "aqua", "red", "yellow")
    val ICONS = listOf("🌐", "🌱", "💰", "📣", "📈", "🤝", "🎯", "🧾", "⚙️", "📦", "🎓", "⚖️")

    fun active(list: List<TopicDTO>): List<TopicDTO> = list.filter { !it.archived }
    fun archived(list: List<TopicDTO>): List<TopicDTO> = list.filter { it.archived }

    /** 1.7.4: la fila en orden de llegada (position; estable si empatan). El orden lo cambia quien arrastra y es del chat. */
    fun ordered(list: List<TopicDTO>): List<TopicDTO> = active(list).sortedBy { it.position }

    /**
     * Soltar [from] sobre [target] (dropOn de la web): el orden nuevo de los ids activos, o null si no cambia nada.
     * Hacia adelante queda después del destino; hacia atrás, antes.
     */
    fun moveTo(ids: List<String>, from: String, target: String): List<String>? {
        val fi = ids.indexOf(from); val ti = ids.indexOf(target)
        if (fi < 0 || ti < 0 || fi == ti) return null
        val rest = ids.filter { it != from }.toMutableList()
        rest.add(rest.indexOf(target) + (if (fi < ti) 1 else 0), from)
        return rest.takeIf { it != ids }
    }

    /** Aplica el orden nuevo a la lista (actualización optimista, como reorderTopics de la web). */
    fun applyOrder(list: List<TopicDTO>, ids: List<String>): List<TopicDTO> {
        val pos = ids.withIndex().associate { it.value to it.index }
        return list.map { t -> pos[t.id]?.let { t.copy(position = it) } ?: t }.sortedBy { it.position }
    }

    /** Mensajes con tema por banderita (solo los cargados y no eliminados). */
    fun counts(messages: List<MessageDTO>): Map<String, Int> =
        messages.filter { it.topicId != null && it.deletedAt == null }.groupingBy { it.topicId!! }.eachCount()

    /** Filtro «Todo»: todos los mensajes, con y sin tema (el filtro null es «General»). */
    const val ALL = "__all"

    /**
     * Filtro válido: un tema activo de la lista, o [ALL] si hay temas activos; si no, null («General»).
     * Un tema archivado o quitado deja de filtrar; sin temas activos «General» y «Todo» son lo mismo.
     */
    fun validFilter(list: List<TopicDTO>, filter: String?): String? = when (filter) {
        null -> null
        ALL -> ALL.takeIf { list.any { !it.archived } }
        else -> filter.takeIf { f -> list.any { it.id == f && !it.archived } }
    }

    /**
     * Mensajes de un tema ([topicId]) y las tarjetas de sus tareas ([issueTopic] da el tema de la tarea de un aviso
     * `issue.created`). Con null no filtra.
     */
    fun filter(messages: List<MessageDTO>, topicId: String?, issueTopic: (String) -> String? = { null }): List<MessageDTO> =
        if (topicId == null) messages
        else messages.filter { it.topicId == topicId || (it.kind == "system" && cardIssueId(it)?.let(issueTopic) == topicId) }

    /** Ids de los temas activos (los archivados cuentan como «sin tema» en «General» y en los contadores). */
    fun activeIds(list: List<TopicDTO>): Set<String> = list.filter { !it.archived }.map { it.id }.toSet()

    /**
     * «General» (docs/TEMAS.md, pedido de Danny del 29-sep-2026; web: Conversation.tsx generalOnly): solo lo que no tiene
     * un tema activo, ni las tarjetas de tareas de un tema. Los mensajes de temas archivados o quitados cuentan como sin tema.
     * Un mensaje al que se saltó ([revealed]) queda a la vista.
     */
    fun inGeneral(m: MessageDTO, activeIds: Set<String>, revealed: Set<Long>, issueTopic: (String) -> String? = { null }): Boolean {
        if (m.seq in revealed) return true
        if (m.topicId != null && m.topicId in activeIds) return false
        if (m.kind == "system" && cardIssueId(m)?.let(issueTopic)?.let { it in activeIds } == true) return false
        return true
    }

    /**
     * Tres vistas: [filter] null = «General» (así abre el chat), [ALL] = «Todo» (todo, cada uno con su etiqueta) o el id de un
     * tema (solo lo suyo). Sin temas activos «General» muestra todo, como antes.
     */
    fun view(messages: List<MessageDTO>, topics: List<TopicDTO>, filter: String?, revealed: Set<Long> = emptySet(),
             issueTopic: (String) -> String? = { null }): List<MessageDTO> {
        val f = validFilter(topics, filter)
        if (f == ALL) return messages
        if (f != null) return filter(messages, f, issueTopic)
        val active = activeIds(topics)
        if (active.isEmpty()) return messages
        return messages.filter { inGeneral(it, active, revealed, issueTopic) }
    }

    /** El tema de lo que se escribe: el de la banderita elegida; en «General» y en «Todo», ninguno. */
    fun composeTopic(topics: List<TopicDTO>, filter: String?): String? = validFilter(topics, filter)?.takeIf { it != ALL }

    /**
     * Saltar a un mensaje (búsqueda, mención, enlace o notificación): el filtro pasa a su tema, o a «General» si no tiene
     * (o su tema ya no está activo). En «Todo» no cambia.
     */
    fun jumpFilter(topics: List<TopicDTO>, current: String?, target: MessageDTO?): String? {
        val cur = validFilter(topics, current)
        if (cur == ALL || target == null) return cur
        return target.topicId?.takeIf { it in activeIds(topics) }
    }

    /** Lo que cuenta como «sin leer» en los números de las banderitas: texto de otra persona, no eliminado, después de [readSeq]. */
    private fun countsAsUnread(m: MessageDTO, readSeq: Long, me: String?): Boolean =
        m.seq > readSeq && m.deletedAt == null && m.kind == "text" && m.authorId != me

    /**
     * Sin leer por banderita, con lo leído en vivo ([readSeq] = max(lastReadSeq, historyFromSeq)). La clave "" es lo sin tema
     * (el número de «General»); un tema archivado o quitado cuenta como sin tema. Los propios y los de sistema no cuentan.
     */
    fun unread(messages: List<MessageDTO>, activeIds: Set<String>, readSeq: Long, me: String?): Map<String, Int> {
        val n = HashMap<String, Int>()
        for (m in messages) {
            if (!countsAsUnread(m, readSeq, me)) continue
            val k = m.topicId?.takeIf { it in activeIds } ?: ""
            n[k] = (n[k] ?: 0) + 1
        }
        return n
    }

    /**
     * Al abrir un chat con no leídos: si todos están en un solo tema activo, el id de ese tema (el chat abre filtrado ahí);
     * si están repartidos, hay no leídos sin tema o no hay ninguno, null (abre en «General»).
     */
    fun autoTopic(messages: List<MessageDTO>, activeIds: Set<String>, readFrom: Long, me: String?): String? {
        val keys = messages.filter { countsAsUnread(it, readFrom, me) }.map { it.topicId?.takeIf { t -> t in activeIds } ?: "" }.toSet()
        return keys.singleOrNull()?.takeIf { it.isNotEmpty() }
    }

    /** El primer no leído del tema elegido al abrir: ahí va la línea «N mensajes nuevos». */
    fun firstUnreadIn(messages: List<MessageDTO>, topicId: String, readFrom: Long, me: String?): Long? =
        messages.firstOrNull { it.topicId == topicId && countsAsUnread(it, readFrom, me) }?.seq

    /**
     * Aviso de sistema que se pinta como tarjeta de tarea: `issue.created` con issueId y sin parentIssueId
     * (las tareas derivadas siguen como línea). Devuelve el id de la tarea o null.
     */
    fun cardIssueId(m: MessageDTO): String? {
        if (m.kind != "system" || !m.body.startsWith("{")) return null
        val o = runCatching { TcJson.parseToJsonElement(m.body) as? kotlinx.serialization.json.JsonObject }.getOrNull() ?: return null
        fun str(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        if (str("k") != "issue.created" || str("parentIssueId") != null) return null
        return str("issueId")
    }

    /** Color sugerido para un tema nuevo: el primero que nadie usa, o el primero. */
    fun nextColor(list: List<TopicDTO>): String = COLORS.firstOrNull { c -> list.none { it.color == c } } ?: COLORS.first()
    fun nextIcon(list: List<TopicDTO>): String = ICONS.firstOrNull { i -> list.none { it.icon == i } } ?: ICONS.first()

    /** Si alguien distinto del autor le puso el tema, a quién nombrar («tema puesto por X»); null si fue el autor. */
    fun setBy(m: MessageDTO): String? = m.topicBy?.takeIf { it.isNotEmpty() && it != m.authorId }

    /** Pone o quita el tema en la copia local de los mensajes (al quitar un tema, sus mensajes quedan sin tema). */
    fun clear(messages: List<MessageDTO>, topicId: String): List<MessageDTO> =
        messages.map { if (it.topicId == topicId) it.copy(topicId = null, topicBy = null) else it }
}
