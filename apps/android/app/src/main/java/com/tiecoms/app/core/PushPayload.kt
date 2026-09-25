package com.tiecoms.app.core

/**
 * Mensaje de datos de FCM (SPEC-v3 §6): todos los valores llegan como texto. Tolerante: campos
 * desconocidos se ignoran; un `type` desconocido se descarta (null) para no mostrar basura.
 */
data class PushMessage(
    val type: String,
    val title: String,
    val subtitle: String,
    val body: String,
    val badge: Int,
    val threadId: String,
    val category: String,
    val conversationId: String,
    val messageId: String?,
    val authorId: String?,
    val authorName: String?,
    /** Ruta relativa /api/v1/avatars/… o null. */
    val authorAvatarUrl: String?,
    val reminderId: String?,
    val eventId: String?,
    /** Aviso de reunión «Empieza en 10 min» (null = convocatoria). */
    val minutes: Int? = null,
)

object PushPayload {
    val TYPES = setOf("message", "reminder", "event")

    fun parse(data: Map<String, String?>): PushMessage? {
        fun s(k: String) = data[k]?.trim()?.takeIf { it.isNotEmpty() }
        val type = s("type") ?: "message"
        if (type !in TYPES) return null
        val conv = s("conversationId") ?: return null
        return PushMessage(
            type = type,
            title = s("title") ?: s("authorName") ?: "TieComs",
            subtitle = s("subtitle") ?: "",
            body = s("body") ?: "",
            badge = s("badge")?.toIntOrNull()?.coerceAtLeast(0) ?: 0,
            threadId = s("threadId") ?: conv,
            category = s("category") ?: when (type) { "reminder" -> "TC_REMINDER"; "event" -> "TC_EVENT"; else -> "TC_MESSAGE" },
            conversationId = conv,
            messageId = s("messageId"),
            authorId = s("authorId"),
            authorName = s("authorName"),
            authorAvatarUrl = s("authorAvatarUrl"),
            reminderId = s("reminderId"),
            eventId = s("eventId"),
            minutes = s("minutes")?.toIntOrNull(),
        )
    }
}
