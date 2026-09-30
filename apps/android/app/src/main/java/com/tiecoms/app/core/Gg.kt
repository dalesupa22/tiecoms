package com.tiecoms.app.core

import kotlinx.serialization.Serializable

/**
 * gg como chat y «Tú» (docs/GG-CHAT.md). gg es un participante bot único con id fijo; lo que deja listo va en un mensaje de
 * sistema {k:'gg.actions', forUserId, actions, suggestions} y solo forUserId lo confirma o lo descarta.
 */
object Gg {
    const val ID = "0a9a9a9a-0000-4000-8000-000000000066"
    const val NAME = "gg"

    fun id(data: BootstrapDTO?): String = data?.assistantId?.takeIf { it.isNotBlank() } ?: ID
    fun isGg(id: String?, data: BootstrapDTO? = null): Boolean = id != null && (id == ID || id == data?.assistantId)

    /** «Tú»: el directo de la persona consigo misma (un solo miembro, yo). */
    fun isSelfChat(c: ConversationDTO, data: BootstrapDTO?): Boolean {
        val me = data?.me?.id ?: return false
        return c.kind == "direct" && c.memberIds.isNotEmpty() && c.memberIds.all { it == me }
    }

    /** Degradado de @gg (web .mention.is-gg): #FF5A36 → #FFB23F → #FF4FA3 → #7B61FF → #2F8CFF. */
    val GRADIENT: List<Long> = listOf(0xFFFF5A36, 0xFFFFB23F, 0xFFFF4FA3, 0xFF7B61FF, 0xFF2F8CFF)
    private val HAND = Regex("(^|[^\\w@.])(@gg)(?!\\w)", RegexOption.IGNORE_CASE)

    /**
     * «@gg» escrito a mano como palabra (ggRanges de la web): no dentro de un correo («ana@gg.com») ni de «@ggg».
     * Devuelve (inicio, largo) de cada uno.
     */
    fun handRanges(text: String): List<Pair<Int, Int>> = HAND.findAll(text).map { m -> (m.range.first + m.groupValues[1].length) to 3 }.toList()

    /**
     * Menciones a gg que se pintan con el degradado: las estructuradas (userId de gg) y las escritas a mano que no caen
     * sobre otra mención.
     */
    fun ggMentions(text: String, mentions: List<MentionDTO>, data: BootstrapDTO? = null): List<MentionDTO> {
        val taken = mentions.filter { it.start >= 0 && it.start + it.length <= text.length }
        val hand = handRanges(text).filter { (s, l) -> taken.none { s < it.start + it.length && it.start < s + l } }
            .map { (s, l) -> MentionDTO(userId = ID, start = s, length = l) }
        return (taken.filter { isGg(it.userId, data) } + hand).sortedBy { it.start }
    }

    @Serializable
    data class ActionsBody(val k: String = "", val forUserId: String = "", val actions: List<AssistantActionDTO> = emptyList(), val suggestions: List<String> = emptyList())

    fun parseActions(m: MessageDTO): ActionsBody? = if (m.kind != "system") null else parseActions(m.body)
    fun parseActions(body: String): ActionsBody? {
        if (!body.startsWith("{\"k\":\"gg.actions\"")) return null
        return runCatching { TcJson.decodeFromString(ActionsBody.serializer(), body) }.getOrNull()?.takeIf { it.k == "gg.actions" }
    }
}
