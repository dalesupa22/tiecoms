package com.tiecoms.app.core

/**
 * Admins de grupo al estilo WhatsApp (docs/ADMINS-INTEGRACIONES.md §1). Las reglas las aplica el API;
 * aquí solo se decide qué etiquetas y acciones mostrar para no ofrecer lo que el API rechazaría.
 */
object GroupAdmins {
    enum class Action { MAKE_ADMIN, REMOVE_ADMIN, REMOVE_FROM_GROUP, LEAVE_ADMIN }

    /** Tipos de conversación que tienen admins. */
    private val ADMIN_KINDS = setOf("group", "internal", "multi")

    fun supports(conv: ConversationDTO): Boolean = conv.kind in ADMIN_KINDS

    fun isBot(p: PersonDTO): Boolean = p.kind == "agent"

    fun isAdmin(conv: ConversationDTO, userId: String): Boolean = conv.adminIds?.contains(userId) == true

    /**
     * Acciones del menú contextual sobre [target], vistas por [meId].
     * - Servidor viejo (sin `adminIds`): solo «Quitar del grupo», que ya existía.
     * - Terceros y bots no se nombran admins; a quien creó el grupo no se le quita el admin ni se le saca.
     * - Sobre mí: «Dejar de ser admin» si soy admin y no creé el grupo (salir se hace desde otro lado).
     */
    fun actionsFor(conv: ConversationDTO, target: PersonDTO, meId: String): List<Action> {
        if (!supports(conv)) return emptyList()
        val known = conv.adminIds != null
        val creator = conv.createdBy != null && conv.createdBy == target.id
        if (target.id == meId) {
            return if (known && isAdmin(conv, meId) && !creator) listOf(Action.LEAVE_ADMIN) else emptyList()
        }
        if (!conv.canManage) return emptyList()
        val out = mutableListOf<Action>()
        val admin = isAdmin(conv, target.id)
        if (known && !admin && !target.guest && !isBot(target)) out += Action.MAKE_ADMIN
        if (known && admin && !creator) out += Action.REMOVE_ADMIN
        if (!creator && !isBot(target)) out += Action.REMOVE_FROM_GROUP
        return out
    }
}
