package com.tiecoms.app.core

/** Nombres visibles, iguales en web, iOS y Android. */
object Names {
    fun person(data: BootstrapDTO?, id: String): PersonDTO? = data?.people?.firstOrNull { it.id == id }
    fun org(data: BootstrapDTO?, id: String?): OrganizationDTO? = id?.let { oid -> data?.organizations?.firstOrNull { it.id == oid } }

    fun otherInDirect(c: ConversationDTO, data: BootstrapDTO?): PersonDTO? {
        val me = data?.me?.id
        return c.memberIds.firstOrNull { it != me }?.let { person(data, it) }
    }

    /** group → name; internal → name (con candado en la interfaz); direct → la otra persona. */
    fun conversationTitle(c: ConversationDTO, data: BootstrapDTO?, internalFallback: String, directFallback: String): String = when (c.kind) {
        "direct" -> otherInDirect(c, data)?.name ?: c.name ?: directFallback
        "internal" -> c.name?.takeIf { it.isNotBlank() } ?: internalFallback
        else -> c.name?.takeIf { it.isNotBlank() } ?: directFallback
    }

    /** Empresas de los participantes, en orden de aparición. */
    fun participantOrgs(c: ConversationDTO, data: BootstrapDTO?): List<OrganizationDTO> =
        c.memberIds.mapNotNull { person(data, it)?.orgId }.distinct().mapNotNull { org(data, it) }

    fun initials(name: String): String =
        name.split(' ', '-', '.').filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "?" }
}
