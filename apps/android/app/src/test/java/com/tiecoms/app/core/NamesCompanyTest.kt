package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Listas: arriba solo el nombre; debajo, la empresa (web 72b001d, quick-search companyOf). */
class NamesCompanyTest {
    private val orgs = listOf(OrganizationDTO(id = "ox", name = "Xertify"), OrganizationDTO(id = "on", name = "Estudio Norte"),
        OrganizationDTO(id = "ou", name = "Uniandes"), OrganizationDTO(id = "ob", name = "Banco"))
    private val people = listOf(PersonDTO(id = "me", name = "Danny", orgId = "ox"), PersonDTO(id = "a", name = "Ana", orgId = "on"),
        PersonDTO(id = "b", name = "Beto", orgId = "ox"), PersonDTO(id = "c", name = "Caro", orgId = "ou"), PersonDTO(id = "d", name = "Dora", orgId = "ob"))
    private val data = BootstrapDTO(me = UserDTO(id = "me", name = "Danny", primaryOrgId = "ox"), organizations = orgs, people = people)

    @Test fun multiChatCompaniesOthersFirst() {
        val c = ConversationDTO(id = "m1", kind = "multi", memberIds = listOf("me", "a", "b"))
        assertEquals("Estudio Norte · Xertify", Names.multiCompanies(c, data))
        assertEquals("Estudio Norte · Xertify", Names.rowCompany(c, data, "Interno", "Conversación"))
        val many = ConversationDTO(id = "m2", kind = "multi", memberIds = listOf("me", "a", "c", "d"))
        assertEquals("Estudio Norte · Uniandes +2", Names.multiCompanies(many, data))
        // Solo de mi empresa: la mía.
        assertEquals("Xertify", Names.multiCompanies(ConversationDTO(id = "m3", kind = "multi", memberIds = listOf("me", "b")), data))
    }

    @Test fun directAndSide() {
        assertEquals("Estudio Norte", Names.rowCompany(ConversationDTO(id = "d1", kind = "direct", memberIds = listOf("me", "a")), data, "Interno", "Conversación"))
        assertNull(Names.rowCompany(ConversationDTO(id = "s1", kind = "multi", memberIds = listOf("me", "a"), deriveKind = "side", parentId = "g1"), data, "Interno", "Conversación"))
    }
}
