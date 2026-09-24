package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** DTO y eventos de la v2 (asuntos, agenda, recordatorios, fijados, preferencias, WhatsApp) con campos extra. */
class V2DecodingTest {
    private fun ev(json: String) = decodeConversationEvent(TcJson.parseToJsonElement(json))
    private fun acc(json: String) = decodeAccountEvent(TcJson.parseToJsonElement(json))

    @Test fun `conversacion con preferencias, linaje y campos futuros`() {
        val c = TcJson.decodeFromString(ConversationDTO.serializer(), """
            {"id":"c1","kind":"group","memberIds":[],"pinnedAt":"2026-09-24T10:00:00Z","mutedUntil":"2099-12-31T00:00:00Z",
             "parentId":"p","parentMessageId":"m","parentMessageSeq":7,"deriveKind":"internal","deriveReason":"r","returnedAt":null,
             "openIssues":3,"agentPolicy":{"x":1},"color":"#fff"}""")
        assertEquals("2026-09-24T10:00:00Z", c.pinnedAt)
        assertTrue(c.mutedAt(System.currentTimeMillis()))
        assertEquals(7L, c.parentMessageSeq)
        assertFalse(c.copy(mutedUntil = "2000-01-01T00:00:00Z").mutedAt(System.currentTimeMillis()))
        assertFalse(c.copy(mutedUntil = "no-es-fecha").mutedAt(System.currentTimeMillis()))
    }

    @Test fun `mensaje reenviado y organizacion verificada`() {
        val m = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","seq":1,"body":"x","forwarded":{"source":"whatsapp","author":"Juan","sentAt":"24/9/26 10:12","nuevo":true}}""")
        assertEquals("whatsapp", m.forwarded!!.source)
        assertEquals("Juan", m.forwarded.author)
        val o = TcJson.decodeFromString(OrganizationDTO.serializer(), """{"id":"o","name":"Acme","verification":"dns","verifiedDomain":"acme.co","plan":"x"}""")
        assertEquals("dns", o.verification)
    }

    @Test fun `asunto, reunion, recordatorio, dominio y whatsapp`() {
        val i = TcJson.decodeFromString(IssueDTO.serializer(), """{"id":"i","conversationId":"c","title":"T","status":"waiting","waitingOnOrgId":"o","statusSince":"2026-09-20T00:00:00Z","priority":"high"}""")
        assertEquals("waiting", i.status); assertFalse(i.closed)
        assertTrue(i.copy(status = "cancelled").closed)
        val e = TcJson.decodeFromString(CalendarEventDTO.serializer(), """{"id":"e","conversationId":"c","title":"Reunión","startsAt":"2026-09-30T15:00:00.000Z","endsAt":"2026-09-30T16:00:00.000Z","timezone":"America/Bogota","organizerId":"u","invitees":[{"userId":"u","rsvp":"yes","extra":1}],"cancelledAt":null,"videoUrl":"x"}""")
        assertEquals("yes", e.invitees[0].rsvp)
        val r = TcJson.decodeFromString(ReminderDTO.serializer(), """{"id":"r","conversationId":"c","messageSeq":4,"remindAt":"2026-09-24T12:00:00Z","firedAt":null,"repeat":"never"}""")
        assertEquals(4L, r.messageSeq)
        val d = TcJson.decodeFromString(DomainsPage.serializer(), """{"domains":[{"domain":"acme.co","status":"pending","txtName":"_tiecoms.acme.co","txtValue":"tiecoms-verification=abc","verifiedAt":null,"lastCheckedAt":null}]}""")
        assertEquals("tiecoms-verification=abc", d.domains[0].txtValue)
        val wa = TcJson.decodeFromString(WaChatsPage.serializer(), """{"chats":[{"accountId":"a","jid":"1@g.us","name":"Obra","isGroup":true,"participants":12,"category":"trabajo","unread":2,"linkedConversationId":null}],"categories":{"trabajo":{"total":1,"unread":2},"nueva":{"total":0}}}""")
        assertEquals(12, wa.chats[0].participants)
        assertEquals(2, wa.categories["trabajo"]!!.unread)
        val acc = TcJson.decodeFromString(WaAccountsPage.serializer(), """{"accounts":[{"id":"a","label":"Personal","kind":"personal","status":"qr","qr":"data:image/png;base64,AAA","pairingCode":null,"chats":0,"groups":0,"battery":90}],"max":5}""")
        assertEquals("qr", acc.accounts[0].status)
    }

    @Test fun `eventos nuevos de conversacion ya no son solo cursor`() {
        val pins = ev("""{"type":"pins.changed","conversationId":"c","eventSeq":5,"messageIds":["m1","m2"]}""")
        assertEquals(ConversationEvent.PinsChanged("c", 5, listOf("m1", "m2")), pins)
        val issue = ev("""{"type":"issue.updated","conversationId":"c","eventSeq":6,"issue":{"id":"i","conversationId":"c","title":"T","status":"done","x":1}}""")
        assertTrue(issue is ConversationEvent.IssueUpdated && issue.issue.closed)
        val cal = ev("""{"type":"calendar.updated","conversationId":"c","eventSeq":7,"event":{"id":"e","conversationId":"c","title":"R","startsAt":"2026-09-30T15:00:00Z","endsAt":"2026-09-30T16:00:00Z","invitees":[]}}""")
        assertTrue(cal is ConversationEvent.CalendarUpdated)
        // Cuerpo ilegible: igual avanza el cursor.
        assertEquals(ConversationEvent.CursorOnly("c", 8, "calendar.updated"), ev("""{"type":"calendar.updated","conversationId":"c","eventSeq":8,"event":"??"}"""))
        assertEquals(ConversationEvent.CursorOnly("c", 9, "reaction.added"), ev("""{"type":"reaction.added","conversationId":"c","eventSeq":9}"""))
    }

    @Test fun `eventos nuevos de cuenta`() {
        val r = acc("""{"type":"reminder.due","reminder":{"id":"r","conversationId":"c","remindAt":"2026-09-24T12:00:00Z","note":"llamar"}}""")
        assertTrue(r is AccountEvent.ReminderDue && r.reminder.note == "llamar")
        assertEquals(AccountEvent.PrefsUpdated("c", null), acc("""{"type":"prefs.updated","conversationId":"c"}"""))
        assertEquals(AccountEvent.PrefsUpdated(null, "w"), acc("""{"type":"prefs.updated","workspaceId":"w"}"""))
        assertEquals(AccountEvent.WhatsAppUpdated("a"), acc("""{"type":"whatsapp.updated","accountId":"a"}"""))
        assertTrue(acc("""{"type":"reminder.due"}""") is AccountEvent.Unknown)
    }

    @Test fun `detalle de asunto con historial`() {
        val d = TcJson.decodeFromString(IssueDetail.serializer(), """{"issue":{"id":"i","title":"T"},"events":[{"id":1,"issueId":"i","actorId":"u","kind":"status","payload":{"from":"open","to":"in_progress"},"createdAt":"2026-09-24T10:00:00Z"},{"id":2,"kind":"comment","payload":{"body":"ok"}}]}""")
        assertEquals(2, d.events.size)
        assertEquals("comment", d.events[1].kind)
    }

    @Test fun `enlaces nuevos`() {
        assertEquals(DeepLink.Screen(DeepLinks.SCREEN_ISSUES), DeepLinks.parse("https://app.tiecoms.com/asuntos"))
        assertEquals(DeepLink.Screen(DeepLinks.SCREEN_AGENDA), DeepLinks.parse("tiecoms://agenda"))
        assertEquals(DeepLink.Screen(DeepLinks.SCREEN_TRAZO), DeepLinks.parse("https://tiecoms.com/trazo"))
        assertEquals(DeepLink.Screen(DeepLinks.SCREEN_WHATSAPP), DeepLinks.parse("https://www.tiecoms.com/whatsapp"))
        assertEquals(DeepLink.Conversation("c1", 12), DeepLinks.parse("https://app.tiecoms.com/c/c1?m=12"))
        assertEquals(DeepLink.Conversation("c1", null), DeepLinks.parse("tiecoms://c/c1?m=x"))
        assertEquals(DeepLink.Share("hola\nmundo"), DeepLinks.parse("https://app.tiecoms.com/share?title=hola&text=mundo"))
        assertEquals("whatsapp", DeepLinks.sourceForPackage("com.whatsapp.w4b"))
        assertEquals("email", DeepLinks.sourceForPackage("com.google.android.gm"))
        assertEquals("other", DeepLinks.sourceForPackage(null))
    }

    @Test fun `traer desde whatsapp y correo`() {
        val lines = Bring.parseWhatsApp("[24/9/26, 10:12] Juan: hola\nsigue\n24/9/26 10:13 - Ana: <Multimedia omitido>\n[24/9/26, 10:14] Ana: listo")
        assertEquals(2, lines.size)
        assertEquals("hola\nsigue", lines[0].body)
        assertEquals("Ana", lines[1].author)
        assertEquals("24/9/26 10:12", lines[0].sentAt)
        val mail = Bring.parseEmail("De: Pedro <p@x.co>\nAsunto: Cotización\n\nHola")
        assertEquals("Pedro <p@x.co>", mail.from); assertEquals("Cotización", mail.subject)
        assertNull(Bring.parseEmail("sin cabeceras").from)
    }

    @Test fun `sso con empresa o invitacion`() {
        val u = Sso.startUrl("https://app.tiecoms.com", SsoProvider.GOOGLE, "d", "c", orgName = "Acme SAS")
        assertTrue(u.endsWith("&org_name=Acme%20SAS"))
        assertTrue(Sso.startUrl("https://app.tiecoms.com", SsoProvider.GOOGLE, "d", "c", orgInviteToken = "tok").contains("&org=tok"))
        assertTrue((Sso.parseCallback("tiecoms://auth/callback?error=sso_cancelled") as SsoCallback.Error).cancelled)
    }
}
