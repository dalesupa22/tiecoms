package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Búsqueda rápida (personas, grupos y chats), «Recientes» de Mensaje nuevo y destinos de «＋ Nuevo asunto» (igual que iOS QuickSearchTests). */
class QuickSearchTest {
    private fun ws(id: String, name: String, owner: String, orgs: List<String>, members: List<String>, role: String = "member", home: Boolean = false) =
        WorkspaceDTO(id = id, name = name, owningOrgId = owner, organizationIds = orgs, memberIds = members, myRole = role, isOrgHome = home, createdAt = "2026-09-01")

    private fun c(id: String, w: String?, kind: String, name: String?, members: List<String>, at: String? = null, parent: String? = null, derive: String? = null, canPost: Boolean = true) =
        ConversationDTO(id = id, workspaceId = w, kind = kind, name = name, memberIds = members, lastMessageAt = at, parentId = parent, deriveKind = derive, canPost = canPost)

    private val d = BootstrapDTO(
        me = UserDTO(id = "me", name = "Ana Ruiz", primaryOrgId = "oA"),
        organizations = listOf(OrganizationDTO(id = "oA", name = "Xertify", myRole = "owner"), OrganizationDTO(id = "oB", name = "Ongoing"), OrganizationDTO(id = "oC", name = "Acme")),
        workspaces = listOf(
            ws("wHome", "Xertify", "oA", listOf("oA"), listOf("me", "col"), home = true),
            ws("wRel", "Mentorías", "oB", listOf("oB", "oA"), listOf("me", "bob", "mar")),
            ws("wGuest", "Programa", "oC", listOf("oC"), listOf("me"), role = "guest"),
        ),
        conversations = listOf(
            c("g1", "wHome", "group", "Pagos", listOf("me", "col"), "2026-09-25T10:00:00Z"),
            c("r1", "wRel", "group", "Mentoría 1", listOf("me", "bob"), "2026-09-25T09:00:00Z"),
            c("th", "wRel", "group", "Hilo · Pagos", listOf("me", "bob"), parent = "r1", derive = "same"),
            c("x1", "wGuest", "group", "Cohorte", listOf("me")),
            c("ro", "wHome", "group", "Anuncios", listOf("me"), canPost = false),
            c("d1", null, "direct", null, listOf("me", "bob"), "2026-09-20T11:00:00Z"),
            c("d2", null, "direct", null, listOf("me", "col"), "2026-09-26T11:00:00Z"),
            c("m1", null, "multi", "Café", listOf("me", "bob", "col"), "2026-09-21T11:00:00Z"),
        ),
        people = listOf(
            PersonDTO(id = "me", name = "Ana Ruiz", orgId = "oA"), PersonDTO(id = "col", name = "Carla Pérez", orgId = "oA", title = "Pagos"),
            PersonDTO(id = "bob", name = "Bob", orgId = "oB"), PersonDTO(id = "mar", name = "Mariana", orgId = "oB"),
            PersonDTO(id = "ana2", name = "Ánalía", orgId = "oB"), PersonDTO(id = "bot", name = "Asistente", kind = "agent", orgId = "oA"),
        ),
    )
    private val title: (ConversationDTO) -> String = { Names.conversationTitle(it, d, "Interno", "Conversación") }

    @Test fun `personas sin directo tambien salen, nunca yo ni agentes`() {
        assertEquals("sin directo también sale", listOf("mar"), QuickSearch.people(d, "mariana").map { it.id })
        assertTrue("nunca yo", QuickSearch.people(d, "ana").none { it.id == "me" })
        assertTrue("los agentes no son personas a las que escribir", QuickSearch.people(d, "asist").isEmpty())
        assertTrue("sin texto, nada", QuickSearch.people(d, " ").isEmpty())
    }

    @Test fun `personas por empresa y cargo, primero quien empieza con lo escrito`() {
        // «ana»: Ánalía empieza con lo escrito (sin tildes) y va antes que Mariana, que solo lo contiene.
        assertEquals(listOf("ana2", "mar"), QuickSearch.people(d, "ana").map { it.id })
        assertEquals("por empresa", setOf("bob", "mar", "ana2"), QuickSearch.people(d, "ongoing").map { it.id }.toSet())
        assertEquals("por cargo", listOf("col"), QuickSearch.people(d, "pagos").map { it.id })
        assertEquals(2, QuickSearch.people(d, "ongoing", exclude = setOf("bob")).size)
        // Mismo prefijo: primero con quien tengo directo (Bob), luego por nombre.
        assertEquals(listOf("bob", "ana2", "mar"), QuickSearch.people(d, "ongoing").map { it.id })
    }

    @Test fun `grupos por nombre o empresa, sin hilos`() {
        assertEquals("el hilo «Hilo · Pagos» no es un grupo", listOf("g1"), QuickSearch.groups(d, "pagos", title).map { it.id })
        assertEquals("por la empresa de la otra parte", listOf("r1"), QuickSearch.groups(d, "ongoing", title).map { it.id })
        assertEquals("por el espacio (sin tildes)", listOf("r1"), QuickSearch.groups(d, "mentorias", title).map { it.id })
        assertTrue("los chats no son grupos", QuickSearch.groups(d, "café", title).isEmpty())
        assertEquals(listOf("m1"), QuickSearch.run(d, "café", title).chats.map { it.id })
        assertTrue(QuickSearch.run(d, "zzz", title).isEmpty)
    }

    @Test fun `directo existente y personas recientes`() {
        assertEquals("d1", QuickSearch.direct(d, "bob")?.id)
        assertNull(QuickSearch.direct(d, "mar"))
        assertEquals("el directo más reciente primero", listOf("col", "bob"), QuickSearch.recentPeopleIds(d))
        assertEquals(setOf("me", "bob", "col"), QuickSearch.directPeople(d.conversations.filter { it.id == "d1" || it.id == "d2" || it.id == "m1" }))
    }

    @Test fun `destinos de nuevo asunto sin terceros, solo lectura ni hilos`() {
        val ids = QuickSearch.issueDestinations(d, nowMs = 0).map { it.id }
        assertFalse("un tercero no crea asuntos", "x1" in ids)
        assertFalse("sin permiso de escribir", "ro" in ids)
        assertFalse("los hilos no", "th" in ids)
        assertEquals("el de actividad más reciente primero (también directos)", "d2", ids.first())
        assertEquals("Mentoría 1 · Ongoing", QuickSearch.issueLabel(d, d.conversations.first { it.id == "r1" }, title))
        assertEquals("Café", QuickSearch.issueLabel(d, d.conversations.first { it.id == "m1" }, title))
        assertEquals("Pagos · Xertify", QuickSearch.issueLabel(d, d.conversations.first { it.id == "g1" }, title))
        // Relación pendiente (la otra empresa aún no entra): su nombre escrito, no la mía.
        val pending = d.copy(workspaces = d.workspaces + WorkspaceDTO(id = "wP", name = "Proveedores", owningOrgId = "oA", organizationIds = listOf("oA"), counterpartName = "Nestlé"),
            conversations = d.conversations + ConversationDTO(id = "p1", workspaceId = "wP", kind = "group", name = "Compras"))
        assertEquals("Compras · Nestlé", QuickSearch.issueLabel(pending, pending.conversations.first { it.id == "p1" }, title))
    }
}
