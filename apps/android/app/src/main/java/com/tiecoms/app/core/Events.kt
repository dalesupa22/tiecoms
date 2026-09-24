package com.tiecoms.app.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.longOrNull

/** Evento durable de una conversación, ordenado por eventSeq. */
sealed interface ConversationEvent {
    val conversationId: String
    val eventSeq: Long

    data class MessageCreated(override val conversationId: String, override val eventSeq: Long, val message: MessageDTO) : ConversationEvent
    data class MessageUpdated(override val conversationId: String, override val eventSeq: Long, val message: MessageDTO) : ConversationEvent
    data class MembersChanged(override val conversationId: String, override val eventSeq: Long, val memberIds: List<String>) : ConversationEvent

    /** `redacted`, `issue.updated` o cualquier tipo nuevo: solo avanza el cursor. */
    data class CursorOnly(override val conversationId: String, override val eventSeq: Long, val type: String) : ConversationEvent
}

sealed interface AccountEvent {
    data class ScopeChanged(val reason: String) : AccountEvent
    data class ReadUpdated(val conversationId: String, val seq: Long) : AccountEvent
    data class Unknown(val type: String) : AccountEvent
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.let { it.longOrNull ?: it.contentOrNull?.toDoubleOrNull()?.toLong() }

/**
 * Decodifica un evento de conversación de forma tolerante. Devuelve null solo si
 * no tiene conversationId/eventSeq (no se puede ubicar en el cursor). Un tipo
 * desconocido o un mensaje ilegible se convierte en [ConversationEvent.CursorOnly]
 * para que su eventSeq igualmente avance el cursor.
 */
fun decodeConversationEvent(el: JsonElement): ConversationEvent? {
    val o = el as? JsonObject ?: return null
    val conv = o.str("conversationId") ?: return null
    val seq = o.long("eventSeq") ?: return null
    val type = o.str("type") ?: ""
    fun message(): MessageDTO? = runCatching { TcJson.decodeFromJsonElement(MessageDTO.serializer(), o["message"]!!) }
        .getOrNull()?.takeIf { it.id.isNotEmpty() }
    return when (type) {
        "message.created" -> message()?.let { ConversationEvent.MessageCreated(conv, seq, it.copy(conversationId = it.conversationId.ifEmpty { conv })) }
        "message.updated" -> message()?.let { ConversationEvent.MessageUpdated(conv, seq, it.copy(conversationId = it.conversationId.ifEmpty { conv })) }
        "members.changed" -> runCatching { o["memberIds"]!!.jsonArray.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } }
            .getOrNull()?.let { ConversationEvent.MembersChanged(conv, seq, it) }
        else -> null
    } ?: ConversationEvent.CursorOnly(conv, seq, type)
}

fun decodeAccountEvent(el: JsonElement): AccountEvent {
    val o = el as? JsonObject ?: return AccountEvent.Unknown("")
    return when (val type = o.str("type") ?: "") {
        "scope.changed" -> AccountEvent.ScopeChanged(o.str("reason") ?: "")
        "read.updated" -> {
            val c = o.str("conversationId"); val s = o.long("seq")
            if (c != null && s != null) AccountEvent.ReadUpdated(c, s) else AccountEvent.Unknown(type)
        }
        else -> AccountEvent.Unknown(type)
    }
}
