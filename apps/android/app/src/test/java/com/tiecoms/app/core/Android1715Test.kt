package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 1.7.15: lista plana del selector de «Compartir en chaggu», sin encabezados por empresa repetidos. */
class Android1715Test {
    private val data = BootstrapDTO(
        me = UserDTO(id = "me"),
        organizations = listOf(OrganizationDTO(id = "x", name = "Xertify"), OrganizationDTO(id = "m", name = "La Mafia"), OrganizationDTO(id = "n", name = "Nestle")),
        workspaces = listOf(WorkspaceDTO(id = "w1", name = "La Mafia", owningOrgId = "m", organizationIds = listOf("m")), WorkspaceDTO(id = "w2", name = "Implementación", owningOrgId = "n", organizationIds = listOf("n"))),
        conversations = listOf(
            ConversationDTO(id = "g1", kind = "group", workspaceId = "w1", name = "La Mafia", lastMessageAt = "2026-10-03T10:00:00Z"),
            ConversationDTO(id = "g2", kind = "group", workspaceId = "w2", name = "General", lastMessageAt = "2026-10-03T12:00:00Z"),
            ConversationDTO(id = "ro", kind = "group", workspaceId = "w2", name = "Anuncios", canPost = false, lastMessageAt = "2026-10-03T13:00:00Z"),
            ConversationDTO(id = "side", kind = "group", workspaceId = "w2", name = "Lateral", deriveKind = "side", parentId = "g2", lastMessageAt = "2026-10-03T14:00:00Z"),
        ),
    )
    private fun title(c: ConversationDTO) = c.name ?: ""

    @Test fun `por actividad, sin los que no puedo escribir ni los laterales`() {
        assertEquals(listOf("g2", "g1"), ShareList.rows(data, "") { title(it) }.map { it.c.id })
    }

    @Test fun `el subtitulo no repite el titulo ni la empresa dos veces`() {
        val rows = ShareList.rows(data, "") { title(it) }.associateBy { it.c.id }
        assertNull(rows["g1"]!!.subtitle) // «La Mafia · La Mafia» ya no sale
        assertEquals("Nestle · Implementación", rows["g2"]!!.subtitle)
    }

    @Test fun `busca por nombre o por empresa, sin tildes`() {
        assertEquals(listOf("g2"), ShareList.rows(data, "nestle") { title(it) }.map { it.c.id })
        assertEquals(listOf("g2"), ShareList.rows(data, "implementacion") { title(it) }.map { it.c.id })
    }
}
