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

    @Serializable
    data class ActionsBody(val k: String = "", val forUserId: String = "", val actions: List<AssistantActionDTO> = emptyList(), val suggestions: List<String> = emptyList())

    fun parseActions(m: MessageDTO): ActionsBody? = if (m.kind != "system") null else parseActions(m.body)
    fun parseActions(body: String): ActionsBody? {
        if (!body.startsWith("{\"k\":\"gg.actions\"")) return null
        return runCatching { TcJson.decodeFromString(ActionsBody.serializer(), body) }.getOrNull()?.takeIf { it.k == "gg.actions" }
    }
}
