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

    /** Mensajes con tema por banderita (solo los cargados y no eliminados). */
    fun counts(messages: List<MessageDTO>): Map<String, Int> =
        messages.filter { it.topicId != null && it.deletedAt == null }.groupingBy { it.topicId!! }.eachCount()

    /** Filtro válido: solo un tema activo de la lista; archivado o quitado deja de filtrar. */
    fun validFilter(list: List<TopicDTO>, filter: String?): String? = filter?.takeIf { f -> list.any { it.id == f && !it.archived } }

    /**
     * Mensajes a mostrar con la banderita elegida (null = «Todo»): los de ese tema y las tarjetas de sus tareas
     * ([issueTopic] da el tema de la tarea de un aviso `issue.created`).
     */
    fun filter(messages: List<MessageDTO>, topicId: String?, issueTopic: (String) -> String? = { null }): List<MessageDTO> =
        if (topicId == null) messages
        else messages.filter { it.topicId == topicId || (it.kind == "system" && cardIssueId(it)?.let(issueTopic) == topicId) }

    /** Ids de los temas activos (los archivados cuentan como «sin tema» en «Todo» y en los contadores). */
    fun activeIds(list: List<TopicDTO>): Set<String> = list.filter { !it.archived }.map { it.id }.toSet()

    /**
     * «Todo» con temas activos (docs/TEMAS.md › «Todo», Conversation.tsx `hideTopicsInAll`): se ve lo sin tema, lo no leído
     * de cualquier tema (según lo leído al abrir, [readFrom]) y los mensajes a los que se saltó ([revealed]).
     * Lo ya leído con un tema activo queda solo en su banderita.
     */
    fun visibleInAll(m: MessageDTO, activeIds: Set<String>, readFrom: Long, revealed: Set<Long>): Boolean {
        val t = m.topicId ?: return true
        if (t !in activeIds) return true
        return m.seq > readFrom || m.seq in revealed
    }

    /**
     * Lo que se ve con la banderita [topicId] (null = «Todo»). Sin temas activos «Todo» muestra todo, como antes.
     * [issueTopic] da el tema de la tarea de un aviso `issue.created`.
     */
    fun view(messages: List<MessageDTO>, topics: List<TopicDTO>, topicId: String?, readFrom: Long, revealed: Set<Long>,
             issueTopic: (String) -> String? = { null }): List<MessageDTO> {
        if (topicId != null) return filter(messages, topicId, issueTopic)
        val active = activeIds(topics)
        if (active.isEmpty()) return messages
        return messages.filter { visibleInAll(it, active, readFrom, revealed) }
    }

    /** Lo que cuenta como «sin leer» en los números de las banderitas: texto de otra persona, no eliminado, después de [readSeq]. */
    private fun countsAsUnread(m: MessageDTO, readSeq: Long, me: String?): Boolean =
        m.seq > readSeq && m.deletedAt == null && m.kind == "text" && m.authorId != me

    /**
     * Sin leer por banderita, con lo leído en vivo ([readSeq] = max(lastReadSeq, historyFromSeq)). La clave "" es lo sin tema
     * (el número de «Todo»); un tema archivado o quitado cuenta como sin tema. Los propios y los de sistema no cuentan.
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
     * si están repartidos, hay no leídos sin tema o no hay ninguno, null (abre en «Todo»).
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
