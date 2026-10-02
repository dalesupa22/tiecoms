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
    data class MembersChanged(override val conversationId: String, override val eventSeq: Long, val memberIds: List<String>, val adminIds: List<String>? = null) : ConversationEvent
    data class IssueUpdated(override val conversationId: String, override val eventSeq: Long, val issue: IssueDTO) : ConversationEvent
    data class PinsChanged(override val conversationId: String, override val eventSeq: Long, val messageIds: List<String>) : ConversationEvent
    data class CalendarUpdated(override val conversationId: String, override val eventSeq: Long, val event: CalendarEventDTO) : ConversationEvent
    /** `topics.changed` (docs/TEMAS.md): trae la lista completa de temas (activos y archivados); reemplaza la local. */
    data class TopicsChanged(override val conversationId: String, override val eventSeq: Long, val topics: List<TopicDTO>) : ConversationEvent

    /** `call.updated` (docs/LLAMADAS.md): quién está en la llamada y si se transcribe; terminada = endedAt. */
    data class CallUpdated(override val conversationId: String, override val eventSeq: Long, val call: CallDTO) : ConversationEvent

    /** `mail.updated` (docs/CORREO.md): la tarjeta del correo, sin cuerpo; no borra un cuerpo ya cargado. */
    data class MailUpdated(override val conversationId: String, override val eventSeq: Long, val email: SharedMailDTO) : ConversationEvent

    /** `redacted` o cualquier tipo nuevo: solo avanza el cursor. */
    data class CursorOnly(override val conversationId: String, override val eventSeq: Long, val type: String) : ConversationEvent
}

sealed interface AccountEvent {
    data class ScopeChanged(val reason: String) : AccountEvent
    data class ReadUpdated(val conversationId: String, val seq: Long, val readRevision: Long? = null) : AccountEvent
    data class ReminderDue(val reminder: ReminderDTO) : AccountEvent
    /** Aviso de reunión (SPEC-v4 §E): empieza en [minutes] minutos (10). */
    data class EventSoon(val event: CalendarEventDTO, val minutes: Int) : AccountEvent
    data class PrefsUpdated(val conversationId: String?, val workspaceId: String?) : AccountEvent
    data class WaPrivacy(val accountId: String, val jids: List<String> = emptyList(), val reset: Boolean = false) : AccountEvent
    data class WhatsAppUpdated(val accountId: String?) : AccountEvent
    /** `wa.inbox` (contrato 1-oct-2026): un chat de WhatsApp de mi bandeja cambió o recibió un mensaje. null = recargar. */
    data class WaInboxUpdated(val chat: WaChatDTO?) : AccountEvent
    /** Cambió un árbol de archivos (workspaceId null = «Mis archivos»). */
    data class DriveUpdated(val workspaceId: String?) : AccountEvent
    /** Mis recordatorios cambiaron en otro dispositivo (👀 / ✅): volver a pedir GET /reminders. */
    data object RemindersChanged : AccountEvent
    /** «No molestar» cambió en otra sesión (`me.dnd`); null = apagado. */
    data class AvailabilityUpdated(val userId: String, val availability: AvailabilityDTO) : AccountEvent
    data class DndUpdated(val dndUntil: String?) : AccountEvent
    /** Un programado mío cambió en cualquier dispositivo (`scheduled.updated`). */
    data class ScheduledUpdated(val scheduled: ScheduledMessageDTO) : AccountEvent
    /** Mi modo sueño cambió (`me.sleep`). */
    data class SleepUpdated(val sleep: SleepDTO) : AccountEvent
    /** Un asunto restringido que puedo ver cambió: llega por la cuenta, sin eventSeq (docs/TAREAS.md). */
    data class IssueUpdated(val issue: IssueDTO) : AccountEvent
    /** Mi asunto personal cambió (`issue.personal`, solo a mi cuenta; no tiene conversación). */
    data class IssuePersonal(val issue: IssueDTO) : AccountEvent
    /** Perdí acceso a un asunto: sacarlo de la lista. */
    data class IssueHidden(val issueId: String, val conversationId: String) : AccountEvent
    /** `call.updated {call}` por la cuenta: me agregaron a una llamada de un chat en el que no estoy. */
    data class CallUpdated(val call: CallDTO) : AccountEvent
    /** `call.processing` / `call.transcript`: un pedazo de audio en Groq y luego sus frases. */
    data class CallCaption(val event: CallCaptionEvent) : AccountEvent
    /** `call.ringing`: me están llamando (el servidor no lo manda a quien tiene No molestar). */
    data class CallRinging(val call: CallDTO, val conversationTitle: String?, val callerName: String) : AccountEvent
    /** 1.7.1: `call.answered` / `call.declined` en otro de mis dispositivos: aquí deja de sonar. */
    data class CallElsewhere(val info: com.tiecoms.app.core.CallElsewhere) : AccountEvent
    /**
     * `calls.missed`: cuántas perdidas tengo sin ver. Llega al colgar una que me perdí ([callId]) o con 0 cuando
     * abrí Llamadas en otro dispositivo ([callId] null). Reemplaza el número, no lo suma.
     */
    data class CallsMissed(val callId: String?, val missedCalls: Int) : AccountEvent
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
        "members.changed" -> ids(o, "memberIds")?.let { ConversationEvent.MembersChanged(conv, seq, it, ids(o, "adminIds")) }
        "pins.changed" -> ids(o, "messageIds")?.let { ConversationEvent.PinsChanged(conv, seq, it) }
        "issue.updated" -> obj(o, "issue", IssueDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { ConversationEvent.IssueUpdated(conv, seq, it) }
        "calendar.updated" -> obj(o, "event", CalendarEventDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { ConversationEvent.CalendarUpdated(conv, seq, it) }
        "topics.changed" -> obj(o, "topics", kotlinx.serialization.builtins.ListSerializer(TopicDTO.serializer()))
            ?.filter { it.id.isNotEmpty() }?.map { it.copy(conversationId = it.conversationId.ifEmpty { conv }) }?.let { ConversationEvent.TopicsChanged(conv, seq, it) }
        "mail.updated" -> obj(o, "email", SharedMailDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { ConversationEvent.MailUpdated(conv, seq, it) }
        "call.updated" -> Calls.decode(o["call"])?.let { ConversationEvent.CallUpdated(conv, seq, it.copy(conversationId = it.conversationId.ifEmpty { conv })) }
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
            if (c != null && s != null) AccountEvent.ReadUpdated(c, s, o.long("readRevision")) else AccountEvent.Unknown(type)
        }
        "reminder.due" -> obj(o, "reminder", ReminderDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { AccountEvent.ReminderDue(it) } ?: AccountEvent.Unknown(type)
        "event.soon" -> obj(o, "event", CalendarEventDTO.serializer())?.takeIf { it.id.isNotEmpty() }
            ?.let { AccountEvent.EventSoon(it, (o.long("minutes") ?: 10L).toInt()) } ?: AccountEvent.Unknown(type)
        "prefs.updated" -> AccountEvent.PrefsUpdated(o.str("conversationId"), o.str("workspaceId"))
        "wa.privacy" -> AccountEvent.WaPrivacy(o.str("accountId") ?: "", (o["jids"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull } ?: emptyList(), o["reset"]?.toString() == "true")
        "whatsapp.updated" -> AccountEvent.WhatsAppUpdated(o.str("accountId"))
        "wa.inbox" -> AccountEvent.WaInboxUpdated(obj(o, "chat", WaChatDTO.serializer())?.takeIf { it.accountId.isNotEmpty() && it.jid.isNotEmpty() })
        "drive.updated" -> AccountEvent.DriveUpdated(o.str("workspaceId"))
        "reminders.changed" -> AccountEvent.RemindersChanged
        "scheduled.updated" -> obj(o, "scheduled", ScheduledMessageDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { AccountEvent.ScheduledUpdated(it) } ?: AccountEvent.Unknown(type)
        "issue.updated" -> obj(o, "issue", IssueDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { AccountEvent.IssueUpdated(it) } ?: AccountEvent.Unknown(type)
        "issue.personal" -> obj(o, "issue", IssueDTO.serializer())?.takeIf { it.id.isNotEmpty() }?.let { AccountEvent.IssuePersonal(it.copy(conversationId = null)) } ?: AccountEvent.Unknown(type)
        "issue.hidden" -> o.str("issueId")?.let { AccountEvent.IssueHidden(it, o.str("conversationId") ?: "") } ?: AccountEvent.Unknown(type)
        "me.sleep" -> obj(o, "sleep", SleepDTO.serializer())?.let { AccountEvent.SleepUpdated(it) } ?: AccountEvent.Unknown(type)
        "call.updated" -> Calls.decode(o["call"])?.takeIf { it.conversationId.isNotEmpty() }?.let { AccountEvent.CallUpdated(it) } ?: AccountEvent.Unknown(type)
        "call.processing", "call.transcript" -> {
            val callId = o.str("callId"); val segId = o.str("segId")
            if (callId == null || segId == null) AccountEvent.Unknown(type)
            else AccountEvent.CallCaption(CallCaptionEvent(callId, o.str("userId") ?: "", segId, type == "call.processing",
                obj(o, "segments", kotlinx.serialization.builtins.ListSerializer(CallTranscriptSegmentDTO.serializer())) ?: emptyList(),
                (o["failed"] as? JsonPrimitive)?.contentOrNull == "true"))
        }
        "call.ringing" -> Calls.decode(o["call"])?.takeIf { it.conversationId.isNotEmpty() }
            ?.let { AccountEvent.CallRinging(it, o.str("conversationTitle"), o.str("callerName") ?: "") } ?: AccountEvent.Unknown(type)
        "call.answered", "call.declined" -> o.str("callId")?.let {
            AccountEvent.CallElsewhere(CallElsewhere(it, type == "call.answered", o.str("deviceKey"), o.str("platform"), o.str("label")))
        } ?: AccountEvent.Unknown(type)
        "calls.missed" -> o.long("missedCalls")?.let { AccountEvent.CallsMissed(o.str("callId"), it.toInt()) } ?: AccountEvent.Unknown(type)
        "person.availability" -> o.str("userId")?.let { id -> runCatching { TcJson.decodeFromJsonElement(AvailabilityDTO.serializer(), o["availability"] ?: return@let null) }.getOrNull()?.let { AccountEvent.AvailabilityUpdated(id, it) } } ?: AccountEvent.Unknown(type)
        "me.dnd" -> if (o.containsKey("dndUntil")) AccountEvent.DndUpdated(o.str("dndUntil")) else AccountEvent.Unknown(type)
        else -> AccountEvent.Unknown(type)
    }
}
