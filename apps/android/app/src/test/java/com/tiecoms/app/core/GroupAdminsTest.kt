package com.tiecoms.app.core

import com.tiecoms.app.core.GroupAdmins.Action.LEAVE_ADMIN
import com.tiecoms.app.core.GroupAdmins.Action.MAKE_ADMIN
import com.tiecoms.app.core.GroupAdmins.Action.REMOVE_ADMIN
import com.tiecoms.app.core.GroupAdmins.Action.REMOVE_FROM_GROUP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Admins de grupo al estilo WhatsApp (docs/ADMINS-INTEGRACIONES.md §1). */
class GroupAdminsTest {
    private val creator = PersonDTO(id = "c", name = "Creadora")
    private val admin = PersonDTO(id = "a", name = "Admin")
    private val member = PersonDTO(id = "m", name = "Miembro")
    private val guest = PersonDTO(id = "g", name = "Tercero", guest = true)
    private val bot = PersonDTO(id = "b", name = "Jira", kind = "agent")

    private fun group(me: String, canManage: Boolean, adminIds: List<String>? = listOf("c", "a"), createdBy: String? = "c", kind: String = "group") =
        ConversationDTO(id = "g1", kind = kind, memberIds = listOf("c", "a", "m", "g", "b", me).distinct(), canManage = canManage, adminIds = adminIds, createdBy = createdBy)

    // ---------- Decodificación tolerante ----------

    @Test fun `conversacion con adminIds y createdBy`() {
        val c = TcJson.decodeFromString(ConversationDTO.serializer(),
            """{"id":"c1","kind":"group","memberIds":["u1","u2"],"canManage":true,"adminIds":["u1"],"createdBy":"u1","futuro":1}""")
        assertEquals(listOf("u1"), c.adminIds)
        assertEquals("u1", c.createdBy)
        assertTrue(GroupAdmins.isAdmin(c, "u1"))
        assertFalse(GroupAdmins.isAdmin(c, "u2"))
    }

    @Test fun `servidor viejo sin adminIds ni createdBy`() {
        val c = TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c1","kind":"group","memberIds":["u1"],"canManage":true}""")
        assertNull(c.adminIds)
        assertNull(c.createdBy)
        assertFalse(GroupAdmins.isAdmin(c, "u1"))
        // Nulos explícitos también se toleran.
        val n = TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c1","adminIds":null,"createdBy":null}""")
        assertNull(n.adminIds)
    }

    @Test fun `members changed con y sin adminIds`() {
        val with = decodeConversationEvent(TcJson.parseToJsonElement(
            """{"type":"members.changed","conversationId":"c","eventSeq":7,"memberIds":["a","b"],"adminIds":["a"]}"""))
        assertEquals(ConversationEvent.MembersChanged("c", 7, listOf("a", "b"), listOf("a")), with)
        val without = decodeConversationEvent(TcJson.parseToJsonElement(
            """{"type":"members.changed","conversationId":"c","eventSeq":8,"memberIds":["a"]}"""))
        assertEquals(ConversationEvent.MembersChanged("c", 8, listOf("a"), null), without)
        // adminIds ilegible: el evento sigue valiendo con memberIds.
        val bad = decodeConversationEvent(TcJson.parseToJsonElement(
            """{"type":"members.changed","conversationId":"c","eventSeq":9,"memberIds":["a"],"adminIds":"x"}"""))
        assertEquals(ConversationEvent.MembersChanged("c", 9, listOf("a"), null), bad)
    }

    @Test fun `respuesta del PUT admin`() {
        assertEquals(listOf("a", "m"), TcJson.decodeFromString(AdminIdsResult.serializer(), """{"adminIds":["a","m"],"x":1}""").adminIds)
        assertEquals(emptyList<String>(), TcJson.decodeFromString(AdminIdsResult.serializer(), "{}").adminIds)
    }

    // ---------- Etiquetas ----------

    @Test fun `bot es la persona con kind agent`() {
        assertTrue(GroupAdmins.isBot(bot))
        assertFalse(GroupAdmins.isBot(member))
        assertFalse(GroupAdmins.isBot(guest))
    }

    // ---------- Acciones por participante ----------

    @Test fun `admin ve nombrar, quitar admin y sacar segun reglas`() {
        val g = group(me = "a", canManage = true)
        assertEquals(listOf(MAKE_ADMIN, REMOVE_FROM_GROUP), GroupAdmins.actionsFor(g, member, "a"))
        // Terceros: no se nombran admins, pero sí se sacan.
        assertEquals(listOf(REMOVE_FROM_GROUP), GroupAdmins.actionsFor(g, guest, "a"))
        // Bots: ni admin ni sacar (se revoca la integración).
        assertEquals(emptyList<GroupAdmins.Action>(), GroupAdmins.actionsFor(g, bot, "a"))
        // A quien creó el grupo no se le quita el admin ni se le saca.
        assertEquals(emptyList<GroupAdmins.Action>(), GroupAdmins.actionsFor(g, creator, "a"))
    }

    @Test fun `creadora quita admin y saca a otro admin`() {
        val g = group(me = "c", canManage = true)
        assertEquals(listOf(REMOVE_ADMIN, REMOVE_FROM_GROUP), GroupAdmins.actionsFor(g, admin, "c"))
    }

    @Test fun `sobre mi`() {
        // Admin que no creó el grupo: «Dejar de ser admin».
        assertEquals(listOf(LEAVE_ADMIN), GroupAdmins.actionsFor(group(me = "a", canManage = true), admin, "a"))
        // Quien creó el grupo no deja de ser admin.
        assertEquals(emptyList<GroupAdmins.Action>(), GroupAdmins.actionsFor(group(me = "c", canManage = true), creator, "c"))
        // Administro el espacio pero no estoy en adminIds: nada sobre mí.
        assertEquals(emptyList<GroupAdmins.Action>(), GroupAdmins.actionsFor(group(me = "m", canManage = true), member, "m"))
    }

    @Test fun `sin canManage no hay acciones sobre otros`() {
        val g = group(me = "m", canManage = false)
        listOf(creator, admin, guest, bot).forEach { assertEquals(emptyList<GroupAdmins.Action>(), GroupAdmins.actionsFor(g, it, "m")) }
    }

    @Test fun `lead del espacio fuera de adminIds administra igual`() {
        val g = group(me = "lead", canManage = true)
        assertEquals(listOf(MAKE_ADMIN, REMOVE_FROM_GROUP), GroupAdmins.actionsFor(g, member, "lead"))
        assertEquals(listOf(REMOVE_ADMIN, REMOVE_FROM_GROUP), GroupAdmins.actionsFor(g, admin, "lead"))
    }

    @Test fun `servidor viejo solo ofrece sacar`() {
        val g = group(me = "a", canManage = true, adminIds = null, createdBy = null)
        assertEquals(listOf(REMOVE_FROM_GROUP), GroupAdmins.actionsFor(g, member, "a"))
        assertEquals(emptyList<GroupAdmins.Action>(), GroupAdmins.actionsFor(g, admin, "a"))
    }

    @Test fun `directos no tienen admins y chats grupales si`() {
        assertEquals(emptyList<GroupAdmins.Action>(), GroupAdmins.actionsFor(group(me = "a", canManage = true, kind = "direct"), member, "a"))
        assertEquals(listOf(MAKE_ADMIN, REMOVE_FROM_GROUP), GroupAdmins.actionsFor(group(me = "a", canManage = true, kind = "multi"), member, "a"))
        assertEquals(listOf(MAKE_ADMIN, REMOVE_FROM_GROUP), GroupAdmins.actionsFor(group(me = "a", canManage = true, kind = "internal"), member, "a"))
    }

    // ---------- Textos ----------

    @Test fun `textos es y en de mensajes de sistema y acciones`() {
        fun strings(dir: String): Map<String, String> = Regex("<string name=\"([^\"]+)\">(.*?)</string>")
            .findAll(File("src/main/res/$dir/strings_admins.xml").readText()).associate { it.groupValues[1] to it.groupValues[2] }
        val es = strings("values-es"); val en = strings("values")
        assertEquals(es.keys, en.keys)
        assertEquals("%1\$s ahora es admin del grupo.", es["sys_admin_added"])
        assertEquals("%1\$s is now a group admin.", en["sys_admin_added"])
        assertEquals("%1\$s ya no es admin del grupo.", es["sys_admin_removed"])
        assertEquals("%1\$s is no longer a group admin.", en["sys_admin_removed"])
        assertEquals("Se conectó la integración «%1\$s».", es["sys_integration_added"])
        assertEquals("The “%1\$s” integration was connected.", en["sys_integration_added"])
        assertEquals("Se desconectó la integración «%1\$s».", es["sys_integration_removed"])
        assertEquals("The “%1\$s” integration was disconnected.", en["sys_integration_removed"])
        assertEquals("Nombrar admin", es["admin_make"]); assertEquals("Quitar como admin", es["admin_remove"])
        assertEquals("Quitar del grupo", es["admin_kick"]); assertEquals("Dejar de ser admin", es["admin_leave"])
        assertEquals("¿Nombrar a %1\$s admin del grupo? Podrá sumar y sacar personas y nombrar otros admins.", es["admin_make_confirm"])
        assertEquals("¿Quitarle el admin a %1\$s?", es["admin_remove_confirm"])
        // systemText reconoce las cuatro claves.
        val common = File("src/main/java/com/tiecoms/app/ui/Common.kt").readText()
        listOf("admin.added", "admin.removed", "integration.added", "integration.removed").forEach { assertTrue(it, common.contains("\"$it\" ->")) }
    }
}
