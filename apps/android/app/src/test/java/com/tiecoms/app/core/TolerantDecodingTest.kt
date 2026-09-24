package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TolerantDecodingTest {
    @Test fun `bootstrap con campos nuevos, nulos y valores desconocidos`() {
        val json = """
        {"contract":"2027-01-01","serverTime":"2026-09-23T10:00:00.000Z","futureTopLevel":{"a":1},
         "me":{"id":"u1","name":"Ana","kind":"human","primaryOrgId":"o1","avatarUrl":"https://x"},
         "organizations":[{"id":"o1","name":"Acme","mark":"AC","colorBg":"#112233","colorFg":"#fff","myRole":"owner","plan":"pro"}],
         "workspaces":[{"id":"w1","name":"Obra","department":null,"glyph":null,"owningOrgId":"o1","organizationIds":["o1"],"memberIds":["u1"],"myRole":"lead","createdAt":"2026-01-01T00:00:00Z","color":"red"}],
         "conversations":[{"id":"c1","workspaceId":"w1","kind":"thread","level":null,"name":"General","internalOrgId":null,"memberIds":["u1","u2"],
            "lastMessageSeq":5,"lastEventSeq":9,"lastMessageAt":null,"lastMessagePreview":null,"lastReadSeq":2,"unread":3,"canPost":null,
            "canManage":true,"historyFromSeq":0,"parentId":"c0","parentMessageId":"m0","parentMessageSeq":3,"deriveKind":"internal","deriveReason":"x","returnedAt":null,"openIssues":2}],
         "people":[{"id":"u2","name":"Beto","kind":"agent","orgId":null,"title":null,"area":null,"guest":true,"guestUntil":"2026-12-31T00:00:00Z","badge":"x"}]}
        """.trimIndent()
        val b = TcJson.decodeFromString(BootstrapDTO.serializer(), json)
        assertEquals("Ana", b.me.name)
        assertEquals("thread", b.conversations[0].kind) // tipo nuevo: la interfaz lo trata como grupo
        assertTrue(b.conversations[0].canPost) // null → valor por defecto
        assertEquals(2, b.conversations[0].openIssues)
        assertTrue(b.people[0].guest)
        assertEquals("General", Names.conversationTitle(b.conversations[0], b, "Interno", "Conversación"))
    }

    @Test fun `campos ausentes toman defaults`() {
        val m = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m1","seq":3,"body":"hola","mergedFrom":"c9","reactions":[]}""")
        assertEquals("text", m.kind)
        assertNull(m.clientMessageId)
        assertEquals("c9", m.mergedFrom)
    }

    @Test fun `evento message created`() {
        val e = decodeConversationEvent(TcJson.parseToJsonElement(
            """{"type":"message.created","conversationId":"c1","eventSeq":4,"message":{"id":"m1","conversationId":"c1","seq":2,"authorId":"u","kind":"text","body":"x","createdAt":"2026-09-23T00:00:00Z","extra":1}}""",
        ))
        assertTrue(e is ConversationEvent.MessageCreated)
        assertEquals(4L, e!!.eventSeq)
    }

    @Test fun `tipos desconocidos, redacted e issue updated solo avanzan el cursor`() {
        for (type in listOf("redacted", "issue.updated", "reaction.added", "")) {
            val e = decodeConversationEvent(TcJson.parseToJsonElement("""{"type":"$type","conversationId":"c1","eventSeq":11,"issue":{"id":"i"}}"""))
            assertEquals(ConversationEvent.CursorOnly("c1", 11, type), e)
        }
    }

    @Test fun `mensaje ilegible no rompe la cadena de cursores`() {
        val e = decodeConversationEvent(TcJson.parseToJsonElement("""{"type":"message.created","conversationId":"c1","eventSeq":12,"message":"???"}"""))
        assertEquals(ConversationEvent.CursorOnly("c1", 12, "message.created"), e)
    }

    @Test fun `evento sin cursor se descarta`() {
        assertNull(decodeConversationEvent(TcJson.parseToJsonElement("""{"type":"message.created","conversationId":"c1"}""")))
        assertNull(decodeConversationEvent(TcJson.parseToJsonElement("[1,2]")))
    }

    @Test fun `pagina de eventos con tipos mezclados`() {
        val page = TcJson.decodeFromString(EventsPageRaw.serializer(), """
            {"events":[{"type":"members.changed","conversationId":"c","eventSeq":1,"memberIds":["a","b"]},
                       {"type":"nuevo.tipo","conversationId":"c","eventSeq":2},
                       {"type":"redacted","conversationId":"c","eventSeq":3}],
             "resetRequired":false,"lastEventSeq":3,"cursor":"z"}""")
        val events = page.events.mapNotNull { decodeConversationEvent(it) }
        assertEquals(listOf(1L, 2L, 3L), events.map { it.eventSeq })
        assertTrue(events[0] is ConversationEvent.MembersChanged)
        assertFalse(page.resetRequired)
    }

    @Test fun `eventos de cuenta`() {
        assertEquals(AccountEvent.ReadUpdated("c", 5), decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"read.updated","conversationId":"c","seq":5}""")))
        assertTrue(decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"scope.changed","reason":"member.added"}""")) is AccountEvent.ScopeChanged)
        assertTrue(decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"otro"}""")) is AccountEvent.Unknown)
    }

    @Test fun `errores del API`() {
        val e = HttpApi.parseError(HttpResult(403, """{"error":{"code":"forbidden","message":"No","details":null},"requestId":"r"}"""))
        assertEquals("forbidden", e.code)
        assertTrue(e.permanent)
        val e2 = HttpApi.parseError(HttpResult(502, "<html>bad gateway</html>"))
        assertEquals("http_502", e2.code)
        assertFalse(e2.permanent)
        assertFalse(HttpApi.parseError(HttpResult(429, "{}")).permanent)
        assertFalse(HttpApi.parseError(HttpResult(401, "{}")).permanent)
    }

    @Test fun `upsert ordena y no duplica`() {
        val a = MessageDTO(id = "a", seq = 1); val b = MessageDTO(id = "b", seq = 2); val c = MessageDTO(id = "c", seq = 3)
        assertEquals(listOf("a", "b", "c"), upsertMessage(listOf(a, c), b).map { it.id })
        assertEquals(2, upsertMessage(listOf(a, b), b.copy(body = "editado")).size)
    }
}
