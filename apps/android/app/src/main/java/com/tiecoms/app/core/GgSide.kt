package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/*
 * gg dentro del chat (docs/CONTRATO-GG-CHAT-WA-INBOX.md, parte B): una conversación PRIVADA de la persona con gg
 * sobre UN chat (fuente `c:<conversationId>` o `wa:<cuenta>:<jid>`). gg nunca ejecuta nada: devuelve borradores
 * y sugerencias que la persona confirma en los diálogos de siempre.
 */

@Serializable data class GgQuotedDTO(val id: String = "", val author: String = "", val text: String = "")
@Serializable data class GgActionDTO(val kind: String = "task", val title: String = "", val assigneeName: String? = null, val due: String? = null)
/** style: short | warm | action */
@Serializable data class GgDraft(val style: String = "short", val text: String = "", val action: GgActionDTO? = null)
/** kind: reply | task | reminder | message_person | summary */
@Serializable data class GgSuggestion(
    val id: String = "", val kind: String = "reply", val title: String = "", val detail: String? = null,
    val draft: String? = null, val params: JsonObject? = null, val forMessageIds: List<String> = emptyList(),
) {
    fun param(k: String): String? = (params?.get(k) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
}
@Serializable data class GgPendingItem(val text: String = "", val messageId: String? = null)
@Serializable data class GgExtraDTO(
    val followUps: List<String> = emptyList(), val drafts: List<GgDraft> = emptyList(),
    val suggestions: List<GgSuggestion> = emptyList(), val pending: List<GgPendingItem> = emptyList(),
)
@Serializable data class GgSideMessageDTO(
    val id: String = "", val role: String = "gg", val body: String = "",
    val quoted: List<GgQuotedDTO>? = null, val extra: GgExtraDTO? = null, val createdAt: String = "",
)
@Serializable data class GgSideThread(val session: Int = 1, val messages: List<GgSideMessageDTO> = emptyList(), val pending: Int = 0)
/** POST /gg/side responde además `question`: la pregunta guardada (reemplaza a la copia local). */
@Serializable data class GgSideOne(val message: GgSideMessageDTO = GgSideMessageDTO(), val question: GgSideMessageDTO? = null)
@Serializable data class GgPendingRefresh(val source: String = "", val pending: Int = 0, val recalculated: Boolean = false)
@Serializable data class GgDraftsPage(val drafts: List<GgDraft> = emptyList())
@Serializable data class GgSuggestionsPage(val suggestions: List<GgSuggestion> = emptyList())

object GgSide {
    fun conversation(id: String) = "c:$id"
    fun whatsapp(accountId: String, jid: String) = "wa:$accountId:$jid"
    fun isWhatsApp(source: String) = source.startsWith("wa:")

    /** Tonos de «Responder por mí»: Como yo · Más corto · Más formal · Otras. */
    val TONES = listOf("me", "shorter", "formal", "more")

    /** «Siguientes preguntas» del último mensaje de gg (2 a 4): son las que salen como chips. */
    fun followUps(messages: List<GgSideMessageDTO>): List<String> =
        messages.lastOrNull()?.takeIf { it.role == "gg" }?.extra?.followUps.orEmpty().filter { it.isNotBlank() }.distinct().take(4)

    /** Sugerencias de varios mensajes: sin repetir (mismo tipo y título) y en el orden en que llegan (ya ordenadas). */
    fun dedupe(list: List<GgSuggestion>): List<GgSuggestion> {
        val seen = HashSet<String>()
        return list.filter { s -> seen.add(s.kind + "|" + s.title.trim().lowercase()) }
    }

    /** El último mensaje visible es de otra persona: el móvil ofrece ✨ para las 3 burbujitas de respuesta. */
    fun lastIsFromOther(messages: List<MessageDTO>, me: String): Boolean =
        messages.lastOrNull { it.kind == "text" && it.deletedAt == null }?.let { it.authorId != me } == true

    /** Nombre de quien se parece más a [name] entre [people] (para prellenar el responsable de una tarea). */
    fun matchPerson(name: String?, people: List<PersonDTO>): PersonDTO? {
        val n = name?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        return people.firstOrNull { it.name.lowercase() == n }
            ?: people.firstOrNull { it.name.lowercase().startsWith(n) }
            ?: people.firstOrNull { p -> p.name.lowercase().split(' ').any { it == n } }
    }

    /** Fecha AAAA-MM-DD de la sugerencia, si la trae válida. */
    fun dueDate(raw: String?): String? = raw?.take(10)?.takeIf { runCatching { java.time.LocalDate.parse(it) }.isSuccess }
}
