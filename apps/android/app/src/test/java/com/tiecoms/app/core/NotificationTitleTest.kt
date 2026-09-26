package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** Títulos de notificación «Empresa - Grupo» con la regla de empresa del árbol de Grupos. */
class NotificationTitleTest {
    private val mine = OrganizationDTO(id = "mine", name = "Xertify", myRole = "owner")
    private val acme = OrganizationDTO(id = "acme", name = "Uniandes")
    private val host = OrganizationDTO(id = "host", name = "Nestlé")
    private val d = BootstrapDTO(
        me = UserDTO(id = "u1", primaryOrgId = "mine"),
        organizations = listOf(mine, acme, host),
        people = listOf(PersonDTO(id = "u2", name = "Laura Gómez", orgId = "acme")),
        workspaces = listOf(
            WorkspaceDTO(id = "w-home", name = "Xertify", owningOrgId = "mine", organizationIds = listOf("mine"), myRole = "owner", isOrgHome = true),
            WorkspaceDTO(id = "w-rel", name = "Proyecto", owningOrgId = "mine", organizationIds = listOf("mine", "acme"), myRole = "admin"),
            WorkspaceDTO(id = "w-pend", name = "Piloto", owningOrgId = "mine", organizationIds = listOf("mine"), myRole = "owner", counterpartName = "Bimbo"),
            WorkspaceDTO(id = "w-guest", name = "Obra", owningOrgId = "host", organizationIds = listOf("host", "acme"), myRole = "guest"),
        ),
    )
    private fun t(c: ConversationDTO) = Names.notificationTitle(c, d, "Interno", "Conversación")

    @Test fun `grupos con su empresa`() {
        assertEquals("Xertify - General", t(ConversationDTO(id = "a", workspaceId = "w-home", kind = "group", name = "General")))
        assertEquals("Uniandes - Pagos", t(ConversationDTO(id = "b", workspaceId = "w-rel", kind = "group", name = "Pagos")))
        assertEquals("Bimbo - Piloto", t(ConversationDTO(id = "c", workspaceId = "w-pend", kind = "group", name = "Piloto")))
        // Tercero: la anfitriona, aunque haya otra empresa en el espacio.
        assertEquals("Nestlé - Obra 12", t(ConversationDTO(id = "e", workspaceId = "w-guest", kind = "group", name = "Obra 12")))
        assertEquals("Xertify - Interno", t(ConversationDTO(id = "f", workspaceId = "w-home", kind = "internal")))
    }

    @Test fun `directos, chats y espacios desconocidos sin empresa`() {
        assertEquals("Laura Gómez", t(ConversationDTO(id = "d", kind = "direct", memberIds = listOf("u1", "u2"))))
        assertEquals("Obra", t(ConversationDTO(id = "m", kind = "multi", name = "Obra")))
        assertEquals("Suelto", t(ConversationDTO(id = "x", workspaceId = "w-otro", kind = "group", name = "Suelto")))
        assertEquals("Suelto", Names.notificationTitle(ConversationDTO(id = "x", workspaceId = "w-home", kind = "group", name = "Suelto"), null, "", ""))
    }

    @Test fun `reuniones con su grupo y sin inventar grupo en chats`() {
        fun p(c: ConversationDTO?) = Names.meetingPlace(c, d, "Interno", "Conversación")
        assertEquals("Uniandes - Pagos", p(ConversationDTO(id = "b", workspaceId = "w-rel", kind = "group", name = "Pagos")))
        assertEquals("Xertify - General", p(ConversationDTO(id = "a", workspaceId = "w-home", kind = "group", name = "General")))
        assertEquals(null, p(ConversationDTO(id = "d", kind = "direct", memberIds = listOf("u1", "u2"))))
        assertEquals(null, p(ConversationDTO(id = "m", kind = "multi", name = "Obra")))
        assertEquals(null, p(null))
    }
}
