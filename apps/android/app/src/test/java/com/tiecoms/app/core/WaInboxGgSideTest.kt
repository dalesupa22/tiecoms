package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 1.7.7: WhatsApp en la bandeja y gg dentro del chat (docs/CONTRATO-GG-CHAT-WA-INBOX.md), sin servidor. */
class WaInboxGgSideTest {
    private val mine = OrganizationDTO(id = "mine", name = "Ongoing", myRole = "owner")
    private fun wa(jid: String, place: String?, group: Boolean = false, unread: Int = 0, pinned: String? = null, at: String = "2026-09-30T10:00:00Z", status: String? = null) =
        WaChatDTO(accountId = "acc1", accountLabel = "Personal", jid = jid, name = "WA $jid", isGroup = group, lastMessageAt = at, unread = unread,
            inboxPlace = place, inboxPinnedAt = pinned, accountStatus = status)

    private val data = BootstrapDTO(
        me = UserDTO(id = "u1", primaryOrgId = "mine"),
        organizations = listOf(mine),
        workspaces = listOf(WorkspaceDTO(id = "w", name = "W", owningOrgId = "mine", organizationIds = listOf("mine"), myRole = "member")),
        conversations = listOf(
            ConversationDTO(id = "g1", workspaceId = "w", kind = "group", name = "g1", lastMessageAt = "2026-09-29T10:00:00Z"),
            ConversationDTO(id = "g2", workspaceId = "w", kind = "group", name = "g2", lastMessageAt = "2026-09-28T10:00:00Z", pinnedAt = "2026-09-01T00:00:00Z"),
            ConversationDTO(id = "d1", kind = "direct", name = "d1", lastMessageAt = "2026-09-27T10:00:00Z"),
        ),
        waInbox = listOf(
            wa("grp@g.us", WaInbox.GROUPS, group = true, unread = 3),
            wa("pin@g.us", WaInbox.GROUPS, group = true, pinned = "2026-09-30T00:00:00Z", at = "2026-09-01T00:00:00Z"),
            wa("ana@s.whatsapp.net", WaInbox.DMS, at = "2026-09-30T12:00:00Z"),
        ),
    )
    private val title: (ConversationDTO) -> String = { it.name ?: "" }

    @Test fun `clave sintetica ida y vuelta`() {
        assertEquals("wa:acc1:123@s.whatsapp.net", WaInbox.key("acc1", "123@s.whatsapp.net"))
        assertEquals("acc1" to "1:2@lid", WaInbox.parse("wa:acc1:1:2@lid"))
        assertNull(WaInbox.parse("c:abc"))
        assertTrue(WaInbox.isWa("wa:a:b")); assertFalse(WaInbox.isWa("g1"))
    }

    @Test fun `grupos mezcla WhatsApp con el mismo orden y separadores`() {
        val rows = GroupsTree.buildList(data, emptyList(), "", null, emptySet(), title)
        val keys = rows.map { it.key }
        // Fijados: g2 y el WhatsApp fijado (pinnedAt = inboxPinnedAt); Sin leer: el WhatsApp con 3; Recientes: g1.
        assertEquals(listOf("b:PINNED", "c:g2", "c:wa:acc1:pin@g.us", "b:UNREAD", "c:wa:acc1:grp@g.us", "b:RECENT", "c:g1"), keys)
        // Los DMs de WhatsApp no salen en Grupos.
        assertTrue(keys.none { it.contains("ana@") })
    }

    @Test fun `filtro sin leer y tareas`() {
        val unread = GroupsTree.buildList(data, emptyList(), "", null, emptySet(), title, tab = GroupsTree.Tab.UNREAD).map { it.key }
        assertEquals(listOf("c:wa:acc1:grp@g.us"), unread)
        val counts = GroupsTree.counts(data, emptyList())
        assertEquals(4, counts[GroupsTree.Tab.ALL]); assertEquals(1, counts[GroupsTree.Tab.UNREAD]); assertEquals(0, counts[GroupsTree.Tab.ISSUES])
        val issues = GroupsTree.buildList(data, emptyList(), "", null, emptySet(), title, tab = GroupsTree.Tab.ISSUES).map { it.key }
        assertTrue(issues.none { it.contains("wa:") })
    }

    @Test fun `dms mezcla WhatsApp y busca por nombre`() {
        val list = GroupsTree.dms(data, "", title).map { it.id }
        assertEquals(listOf("wa:acc1:ana@s.whatsapp.net", "d1"), list)
        assertEquals(listOf("wa:acc1:ana@s.whatsapp.net"), GroupsTree.dms(data, "wa ana", title).map { it.id })
        assertTrue(GroupsTree.dms(data, "", title, unreadOnly = true).isEmpty())
    }

    @Test fun `el arbol pone el WhatsApp fijado en Fijados`() {
        val rows = GroupsTree.build(data, emptyList(), "", null, emptySet(), title).map { it.key }
        assertTrue(rows.indexOf("pc:wa:acc1:pin@g.us") in 1..3)
        assertTrue("wc:wa:acc1:grp@g.us" in rows)
    }

    @Test fun `aplicar cambios y evento`() {
        val list = data.waInbox
        val out = WaInbox.apply(list, wa("ana@s.whatsapp.net", null))
        assertEquals(2, out.size)
        val added = WaInbox.apply(list, wa("new@s.whatsapp.net", WaInbox.DMS))
        assertEquals(4, added.size)
        val moved = WaInbox.apply(list, wa("grp@g.us", WaInbox.DMS, group = true))
        assertEquals(WaInbox.DMS, moved.first { it.jid == "grp@g.us" }.inboxPlace)
        assertEquals(3, moved.size)
    }

    @Test fun `optimista fijar sin mover aplica la sugerida`() {
        val c = wa("x@g.us", null, group = true)
        val p = WaInbox.optimistic(c, null, placeSet = false, pinned = true, nowIso = "2026-10-01T00:00:00Z")
        assertEquals(WaInbox.GROUPS, p.inboxPlace); assertEquals("2026-10-01T00:00:00Z", p.inboxPinnedAt)
        val auto = WaInbox.optimistic(wa("y@s.whatsapp.net", null), "auto", placeSet = true, pinned = null, nowIso = "")
        assertEquals(WaInbox.DMS, auto.inboxPlace)
        val out = WaInbox.optimistic(p, null, placeSet = true, pinned = null, nowIso = "")
        assertNull(out.inboxPlace); assertNull(out.inboxPinnedAt)
        // El API anterior a la 081 responde sin los campos: no se guardó.
        assertTrue(WaInbox.serverIgnored(p, c))
        assertFalse(WaInbox.serverIgnored(p, p))
    }

    @Test fun `cuenta desconectada se atenua`() {
        assertTrue(WaInbox.disconnected(wa("a", WaInbox.DMS, status = "logged_out")))
        assertFalse(WaInbox.disconnected(wa("a", WaInbox.DMS, status = "connected")))
        assertFalse(WaInbox.disconnected(wa("a", WaInbox.DMS, status = null)))
    }

    @Test fun `bootstrap viejo sin waInbox y evento wa inbox`() {
        val d = TcJson.decodeFromString(BootstrapDTO.serializer(), """{"me":{"id":"u1"},"conversations":[]}""")
        assertTrue(d.waInbox.isEmpty())
        val e = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"wa.inbox","chat":{"accountId":"a","jid":"j","name":"N","inboxPlace":"dms","unread":2}}"""))
        assertTrue(e is AccountEvent.WaInboxUpdated)
        assertEquals("dms", (e as AccountEvent.WaInboxUpdated).chat?.inboxPlace)
        val empty = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"wa.inbox"}"""))
        assertNull((empty as AccountEvent.WaInboxUpdated).chat)
    }

    @Test fun `gg side decodifica el contrato y ordena`() {
        val t = TcJson.decodeFromString(GgSideThread.serializer(), """{"session":2,"pending":3,"messages":[
            {"id":"m1","role":"gg","body":"Hola","extra":{"followUps":["a","b","a"],"pending":[{"text":"Te piden el informe","messageId":"x"}]},"createdAt":"2026-10-01T00:00:00Z"},
            {"id":"m2","role":"user","body":"¿y?","quoted":[{"id":"x","author":"Ana","text":"el informe"}],"createdAt":"2026-10-01T00:01:00Z"},
            {"id":"m3","role":"gg","body":"","extra":{"drafts":[{"style":"short","text":"Va"},{"style":"action","text":"Lo hago","action":{"kind":"task","title":"Informe","assigneeName":"Ana","due":"2026-10-03"}}],"followUps":["c","d"]},"createdAt":"2026-10-01T00:02:00Z"}]}""")
        assertEquals(2, t.session); assertEquals(3, t.pending)
        assertEquals(listOf("c", "d"), GgSide.followUps(t.messages))
        assertEquals(listOf("a", "b"), GgSide.followUps(t.messages.take(1)))
        assertEquals("task", t.messages[2].extra!!.drafts[1].action!!.kind)
        val s = listOf(GgSuggestion(id = "1", kind = "task", title = "Informe"), GgSuggestion(id = "2", kind = "task", title = " informe "), GgSuggestion(id = "3", kind = "reply", title = "Informe"))
        assertEquals(listOf("1", "3"), GgSide.dedupe(s).map { it.id })
        assertEquals("c:abc", GgSide.conversation("abc")); assertEquals("wa:a:j", GgSide.whatsapp("a", "j"))
        assertEquals("2026-10-03", GgSide.dueDate("2026-10-03T00:00:00Z")); assertNull(GgSide.dueDate("mañana"))
        val people = listOf(PersonDTO(id = "p1", name = "Ana María Ruiz"), PersonDTO(id = "p2", name = "Beto"))
        assertEquals("p1", GgSide.matchPerson("ana", people)?.id)
        assertEquals("p2", GgSide.matchPerson("Beto", people)?.id)
        assertNull(GgSide.matchPerson(null, people))
    }

    @Test fun `ultimo mensaje de otra persona`() {
        val a = MessageDTO(id = "1", authorId = "u2", kind = "text", body = "hola")
        val b = MessageDTO(id = "2", authorId = "u1", kind = "text", body = "dime")
        assertTrue(GgSide.lastIsFromOther(listOf(b, a), "u1"))
        assertFalse(GgSide.lastIsFromOther(listOf(a, b), "u1"))
        assertFalse(GgSide.lastIsFromOther(emptyList(), "u1"))
    }
}
