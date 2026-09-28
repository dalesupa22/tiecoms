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
