package com.tiecoms.app.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Varios mensajes de WhatsApp llevados juntos a chaggu (POST /whatsapp/share con messageIds): una sola tarjeta
 * con los mensajes en orden de envío (SharedMailDTO.wa.items). Lógica pura, sin UI.
 */
object WaBundle {
    /** Tope del API por envío (WA_SHARE_MAX_MESSAGES). */
    const val MAX_MESSAGES = 50
    /** Tope de chats destino por envío. */
    const val MAX_CHATS = 10
    /** Filas visibles en la tarjeta antes de «Ver los N». */
    const val SHOWN = 8

    /**
     * Los seleccionados en el orden del chat (la lista llega de más viejo a más nuevo), sin repetidos.
     * Los que ya no están en la lista quedan al final, en el orden en que se eligieron.
     */
    fun orderByChat(selected: Collection<String>, chat: List<WaMessageDTO>): List<String> {
        val want = LinkedHashSet(selected)
        val inChat = chat.asSequence().map { it.id }.filter { it in want }.distinct().toList()
        return inChat + want.filter { it !in inChat.toSet() }
    }

    /**
     * Cuerpo de POST /whatsapp/share. Con un solo mensaje va también `messageId` (lo entienden los servidores viejos);
     * con varios, solo `messageIds` (un servidor viejo responde 400 en vez de llevar solo el primero).
     */
    fun shareBody(accountId: String, jid: String, messageIds: List<String>, conversationIds: List<String>, comment: String?, clientMessageId: String? = null): JsonObject {
        val ids = messageIds.distinct()
        require(ids.isNotEmpty()) { "messageIds vacío" }
        return buildJsonObject {
            put("accountId", JsonPrimitive(accountId)); put("jid", JsonPrimitive(jid))
            if (ids.size == 1) put("messageId", JsonPrimitive(ids[0]))
            put("messageIds", JsonArray(ids.map { JsonPrimitive(it) }))
            put("conversationIds", JsonArray(conversationIds.map { JsonPrimitive(it) }))
            comment?.takeIf { it.isNotBlank() }?.let { put("comment", JsonPrimitive(it.trim())) }
            clientMessageId?.takeIf { it.isNotBlank() }?.let { put("clientMessageId", JsonPrimitive(it)) }
        }
    }

    /** Los mensajes de una tarjeta con varios (2 o más); null si es la tarjeta de un solo mensaje. */
    fun items(e: SharedMailDTO): List<WaSharedItemDTO>? = e.wa?.items?.takeIf { it.size >= 2 }

    /** El adjunto de un mensaje del paquete; null si no tiene o si ya se borró. */
    fun attachment(item: WaSharedItemDTO, e: SharedMailDTO): AttachmentDTO? =
        item.attachmentId?.let { id -> e.chagguAttachments.firstOrNull { it.id == id } }

    /** Adjuntos de la tarjeta que ningún mensaje del paquete referencia (se muestran aparte para no perderlos). */
    fun loose(e: SharedMailDTO, items: List<WaSharedItemDTO>): List<AttachmentDTO> {
        val used = items.mapNotNull { it.attachmentId }.toSet()
        return e.chagguAttachments.filter { it.id !in used }
    }

    /** Filas visibles: las primeras [SHOWN] o todas. */
    fun <T> visible(items: List<T>, expanded: Boolean): List<T> = if (expanded) items else items.take(SHOWN)

    /** Vista previa corta para la hoja de envío: «Autor: texto» de los primeros [lines] mensajes. */
    fun preview(messages: List<WaMessageDTO>, you: String, someone: String, lines: Int = 3, chars: Int = 80): String =
        messages.take(lines).joinToString("\n") { m ->
            val who = if (m.fromMe) you else m.author?.takeIf { it.isNotBlank() } ?: someone
            val text = m.body.replace(Regex("\\s+"), " ").trim().ifEmpty { m.media?.attachment?.name ?: "" }
            "$who: " + (if (text.length > chars) text.take(chars).trimEnd() + "…" else text)
        }
}
