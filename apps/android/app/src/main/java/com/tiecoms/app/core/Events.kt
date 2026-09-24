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
    data class IssueUpdated(override val conversationId: String, override val eventSeq: Long, val issue: IssueDTO) : ConversationEvent
    data class PinsChanged(override val conversationId: String, override val eventSeq: Long, val messageIds: List<String>) : ConversationEvent
    data class CalendarUpdated(override val conversationId: String, override val eventSeq: Long, val event: CalendarEventDTO) : ConversationEvent

    /** `redacted` o cualquier tipo nuevo: solo avanza el cursor. */
    data class CursorOnly(override val conversationId: String, override val eventSeq: Long, val type: String) : ConversationEvent
}

sealed interface AccountEvent {
    data class ScopeChanged(val reason: String) : AccountEvent
    data class ReadUpdated(val conversationId: String, val seq: Long) : AccountEvent
    data class ReminderDue(val reminder: ReminderDTO) : AccountEvent
    data class PrefsUpdated(val conversationId: String?, val workspaceId: String?) : AccountEvent
    data class WhatsAppUpdated(val accountId: String?) : AccountEvent
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
        "members.changed" -> ids(o, "memberIds")?.let { ConversationEvent.MembersChanged(conv, seq, it) }
        "pins.changed" -> ids(o, "messageIds")?.let { ConversationEvent.PinsChanged(conv, seq, it) }
        "issue.updated" -> obj(o, "issue", IssueDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { ConversationEvent.IssueUpdated(conv, seq, it) }
        "calendar.updated" -> obj(o, "event", CalendarEventDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { ConversationEvent.CalendarUpdated(conv, seq, it) }
        else -> null
    } ?: ConversationEvent.CursorOnly(conv, seq, type)
}

private fun ids(o: JsonObject, key: String): List<String>? =
    runCatching { o[key]!!.jsonArray.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } }.getOrNull()

private fun <T> obj(o: JsonObject, key: String, s: kotlinx.serialization.KSerializer<T>): T? =
    runCatching { TcJson.decodeFromJsonElement(s, o[key]!!) }.getOrNull()

fun decodeAccountEvent(el: JsonElement): AccountEvent {
    val o = el as? JsonObject ?: return AccountEvent.Unknown("")
    return when (val type = o.str("type") ?: "") {
        "scope.changed" -> AccountEvent.ScopeChanged(o.str("reason") ?: "")
        "read.updated" -> {
            val c = o.str("conversationId"); val s = o.long("seq")
            if (c != null && s != null) AccountEvent.ReadUpdated(c, s) else AccountEvent.Unknown(type)
        }
        "reminder.due" -> obj(o, "reminder", ReminderDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { AccountEvent.ReminderDue(it) } ?: AccountEvent.Unknown(type)
        "prefs.updated" -> AccountEvent.PrefsUpdated(o.str("conversationId"), o.str("workspaceId"))
        "whatsapp.updated" -> AccountEvent.WhatsAppUpdated(o.str("accountId"))
        else -> AccountEvent.Unknown(type)
    }
}
