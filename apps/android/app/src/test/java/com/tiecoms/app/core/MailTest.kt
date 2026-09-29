package com.tiecoms.app.core

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Correo en el chat (docs/CORREO.md): DTO, reglas de la lista y los filtros, tarjeta, respuesta, tarea y conexión. */
class MailTest {
    // Una tarjeta como la devuelve GET /mail/shared?ids= (sin cuerpo), con un campo nuevo que la app no conoce.
    private val cardJson = """
        {"id":"e1","conversationId":"c1","sharedBy":"u1","provider":"google","accountEmail":"danny@x.co","direction":"in",
         "from":{"name":"Jorge Ramírez","email":"jorge@uniandes.edu.co"},"to":[{"name":"Danny","email":"danny@x.co"}],
         "cc":[{"name":"Óscar","email":"oscar@uniandes.edu.co"}],"subject":"RE: Fw: Comité del jueves","snippet":"Para el comité…","body":"","full":false,
         "trimmed":true,"sentAt":"2026-09-29T15:00:00.000Z","attachments":[{"id":"a1","name":"Requisitos.pdf","size":2048,"contentType":"application/pdf"}],
         "messageId":"m1","comment":"¿Cómo respondemos?","status":"pending","repliedAt":null,"repliedBy":null,"scheduledReply":null,"issueId":null,
         "commentCount":2,"lastComments":[{"id":"k1","emailId":"e1","authorId":"u2","body":"Yo lo reviso","createdAt":"2026-09-29T15:10:00.000Z"}],
         "createdAt":"2026-09-29T15:05:00.000Z","webLink":"https://mail.google.com/x","campoNuevo":42}
    """.trimIndent()
    private val card = TcJson.decodeFromString(SharedMailDTO.serializer(), cardJson)

    @Test fun decodesCardTolerantly() {
        assertEquals("e1", card.id); assertFalse(card.out); assertTrue(card.trimmed); assertFalse(card.full)
        assertEquals("jorge@uniandes.edu.co", card.from?.email); assertEquals(1, card.attachments.size); assertEquals(2048L, card.attachments[0].size)
        assertEquals(2, card.commentCount); assertEquals("Yo lo reviso", card.lastComments.single().body)
        // Campos que faltan caen al defecto.
        val min = TcJson.decodeFromString(SharedMailDTO.serializer(), """{"id":"e2","status":"scheduled","scheduledReply":{"id":"r1","sendAt":"2026-09-30T14:00:00Z"}}""")
        assertEquals("google", min.provider); assertEquals("in", min.direction); assertEquals("r1", min.scheduledReply?.id)
        val list = TcJson.decodeFromString(MailListDTO.serializer(), """{"items":[{"provider":"microsoft","id":"ms-g1","from":null,"to":[],"subject":"x","snippet":"","date":null,"unread":true,"hasAttachments":false,"box":"sent"}],"nextPage":"p2","accountEmail":"a@b.co"}""")
        assertEquals("p2", list.nextPage); assertEquals("sent", list.items[0].box); assertNull(list.items[0].from)
        val conns = TcJson.decodeFromString(MailConnectionsPage.serializer(), """{"connections":[{"provider":"google","label":"Gmail","available":true,"unavailableReason":null,"status":"active","accountEmail":"a@b.co"},{"provider":"microsoft","label":"Outlook","available":false,"unavailableReason":"Falta configurar","status":"none","accountEmail":null}]}""")
        assertEquals(listOf("active", "none"), conns.connections.map { it.status }); assertEquals("Falta configurar", conns.connections[1].unavailableReason)
    }

    @Test fun liveUpdateNeverDropsALoadedBody() {
        val full = card.copy(body = "Buenos días, Danny…", full = true, scheduledReply = ScheduledReplyDTO("r1", "2026-09-30T14:00:00Z"))
        // mail.updated llega sin cuerpo, sin respuesta programada ni enlace.
        val live = card.copy(commentCount = 3, status = "scheduled", webLink = null, scheduledReply = null)
        val merged = Mail.fromLive(full, live)
        assertEquals("Buenos días, Danny…", merged.body); assertTrue(merged.full); assertEquals(3, merged.commentCount)
        assertEquals("r1", merged.scheduledReply?.id) // sigue programada: se conserva la que ya conocía
        assertEquals("https://mail.google.com/x", merged.webLink)
        // Ya no está programada: la respuesta programada se va.
        assertNull(Mail.fromLive(full, live.copy(status = "replied")).scheduledReply)
        // Un lote (tarjeta sin cuerpo) tampoco borra el cuerpo; un cuerpo nuevo sí lo reemplaza.
        assertEquals("Buenos días, Danny…", Mail.merge(full, card).body)
        assertEquals("otro", Mail.merge(full, card.copy(body = "otro", full = true)).body)
        // El evento se decodifica como MailUpdated.
        val ev = decodeConversationEvent(TcJson.parseToJsonElement("""{"type":"mail.updated","conversationId":"c1","eventSeq":9,"email":$cardJson}"""))
        assertTrue(ev is ConversationEvent.MailUpdated); assertEquals("e1", (ev as ConversationEvent.MailUpdated).email.id)
    }

    @Test fun categoriesAndSearchRules() {
        assertEquals(listOf("primary", "updates", "promotions", "social", "forums", "any"), Mail.categories("google"))
        assertEquals(listOf("focused", "other", "any"), Mail.categories("microsoft"))
        val f = Mail.Filters()
        // Por defecto: Principal (Gmail) o Prioritarios (Outlook).
        assertEquals("primary", Mail.category(f, null, "google")); assertEquals("focused", Mail.category(f, null, "microsoft"))
        // Al buscar sin haber elegido pestaña: todas (any). Si eligió una, esa.
        assertEquals("any", Mail.category(f.copy(q = "pago"), null, "google"))
        assertEquals("any", Mail.category(f.copy(from = "jorge"), null, "google"))
        assertEquals("updates", Mail.category(f.copy(q = "pago"), "updates", "google"))
        // Fuera de Recibidos no hay pestaña.
        assertNull(Mail.category(f.copy(box = "sent"), "updates", "google"))
        assertFalse(f.filtered); assertTrue(f.copy(unread = true).filtered); assertTrue(f.copy(after = "2026-01-01").filtered)
    }

    @Test fun listQueryOnlySendsWhatHasValue() {
        val f = Mail.Filters(q = "precios comité", from = "jorge@uniandes.edu.co", attachments = true, after = "2026-09-22")
        val q = Mail.listQuery("google", f, "any", page = "tok/1", fresh = true)
        assertEquals("/mail/messages?provider=google&box=inbox&category=any&q=precios+comit%C3%A9&from=jorge%40uniandes.edu.co&after=2026-09-22&attachments=1&page=tok%2F1&fresh=1", q)
        assertEquals("/mail/messages?provider=microsoft&box=sent", Mail.listQuery("microsoft", Mail.Filters(box = "sent"), null))
    }

    @Test fun dateFilters() {
        val today = LocalDate.of(2026, 9, 29)
        assertEquals("2026-09-29" to "", Mail.dateRange("today", today))
        assertEquals("2026-09-22" to "", Mail.dateRange("7", today))
        assertEquals("2026-08-30" to "", Mail.dateRange("30", today))
        assertEquals("2026-01-01" to "", Mail.dateRange("year", today))
        assertEquals("" to "2025-09-29", Mail.dateRange("older", today))
        val f = Mail.withRange(Mail.Filters(), "7", today)
        assertEquals("7", f.range); assertEquals("2026-09-22", f.after)
        // «Cualquier fecha» los borra.
        val any = Mail.withRange(f, "", today)
        assertEquals("", any.after); assertEquals("", any.before); assertNull(any.range)
    }

    @Test fun statusAndReplyButton() {
        assertEquals(Mail.Status.PENDING, Mail.status(card, "u1"))
        assertTrue(Mail.canReply(card, "u1")); assertFalse(Mail.canReply(card, "u2")) // solo quien lo trajo
        assertFalse(Mail.canReply(card.copy(status = "scheduled"), "u1")); assertEquals(Mail.Status.SCHEDULED, Mail.status(card.copy(status = "scheduled"), "u2"))
        assertEquals(Mail.Status.REPLIED_BY_ME, Mail.status(card.copy(status = "replied", repliedBy = "u1"), "u1"))
        assertEquals(Mail.Status.REPLIED, Mail.status(card.copy(status = "replied", repliedBy = "u1"), "u2"))
        val out = card.copy(direction = "out")
        assertEquals(Mail.Status.SENT_BY_ME, Mail.status(out, "u1")); assertEquals(Mail.Status.SENT, Mail.status(out, "u2"))
        assertEquals("Danny", Mail.who(Mail.other(out))); assertEquals("Jorge Ramírez", Mail.who(Mail.other(card)))
        assertEquals("2 KB", Mail.kb(2048)); assertEquals("1.5 MB", Mail.kb(1_572_864)); assertEquals("PDF", Mail.ext("Requisitos.pdf"))
    }

    @Test fun replyRecipientsAndCc() {
        // Al remitente; CC por defecto: todos menos yo y el destinatario.
        assertEquals(listOf("jorge@uniandes.edu.co"), Mail.replyTo(card).map { it.email })
        assertEquals(listOf("oscar@uniandes.edu.co"), Mail.defaultCc(card))
        // Un correo que mandé yo: a los mismos destinatarios.
        val out = card.copy(direction = "out", from = MailAddressDTO("Danny", "danny@x.co"), to = listOf(MailAddressDTO(null, "ana@u.co")), cc = listOf(MailAddressDTO(null, "danny@x.co")))
        assertEquals(listOf("ana@u.co"), Mail.replyTo(out).map { it.email }); assertEquals(emptyList<String>(), Mail.defaultCc(out))
        assertEquals(listOf("a@b.co", "c@d.co"), Mail.parseCc(" a@b.co, c@d.co;  "))
        assertFalse(Mail.badCc(listOf("a@b.co"))); assertTrue(Mail.badCc(listOf("a@b"))); assertTrue(Mail.badCc(listOf("no es correo")))
    }

    @Test fun taskTitleStripsReplyPrefixes() {
        assertEquals("Comité del jueves", Mail.cleanSubject("RE: Fw: Comité del jueves"))
        assertEquals("Pedido", Mail.cleanSubject("rv:RE : FWD: Pedido"))
        assertEquals("Responder a Jorge: Comité del jueves", Mail.taskTitle(card, "Responder a"))
        assertEquals("RE: Fw: Comité del jueves", Mail.taskTitle(card.copy(direction = "out"), "Responder a"))
        assertEquals(200, Mail.taskTitle(card.copy(subject = "x".repeat(400)), "Responder a").length)
    }

    @Test fun connectReturnDeepLink() {
        val ok = Mail.parseReturn("chaggu://mail/connected?mail=1&provider=google&receipt=" + "A".repeat(43))
        assertTrue(ok is Meetings.Return.Pending); assertEquals("google", ok!!.provider)
        val cancelled = Mail.parseReturn("chaggu://mail/connected?mail=1&provider=microsoft&error=cancelled") as Meetings.Return.Failed
        assertTrue(cancelled.cancelled); assertEquals("microsoft", cancelled.provider)
        assertNull(Mail.parseReturn("chaggu://meetings/connected?provider=google&receipt=x"))
        assertNull(Mail.parseReturn("https://www.chaggu.com/correo?mail=1"))
        // Proveedor desconocido o recibo raro: falla, no conecta nada.
        assertTrue(Mail.parseReturn("chaggu://mail/connected?provider=zoom&receipt=" + "A".repeat(43)) is Meetings.Return.Failed)
        assertTrue(Mail.parseReturn("chaggu://mail/connected?provider=google&receipt=a%20b") is Meetings.Return.Failed)
    }

    @Test fun scheduleTimesAndLimits() {
        val zone = ZoneId.of("America/Bogota")
        val now = Instant.parse("2026-09-29T20:00:00Z") // martes 3:00 p. m. en Bogotá
        val t = Mail.scheduleTimes(now, zone).toMap()
        assertEquals(listOf("1h", "3h", "tomorrow", "monday"), Mail.scheduleTimes(now, zone).map { it.first })
        assertEquals(now.plusSeconds(3600), t["1h"]); assertEquals(Instant.parse("2026-09-30T14:00:00Z"), t["tomorrow"])
        assertEquals(Instant.parse("2026-10-05T14:00:00Z"), t["monday"])
        assertTrue(Mail.validSendAt(now.plusSeconds(60), now)); assertFalse(Mail.validSendAt(now.minusSeconds(3600), now))
        assertFalse(Mail.validSendAt(now.plusSeconds(91L * 86_400), now))
    }

    @Test fun chatFilesForTheReply() {
        val msgs = (1..15).map { i -> MessageDTO(id = "m$i", seq = i.toLong(), authorId = "u$i", attachments = listOf(AttachmentDTO(id = "f$i", name = "f$i.pdf"))) } +
            MessageDTO(id = "v", seq = 16, attachments = listOf(AttachmentDTO(id = "voice", kind = "voice"))) +
            MessageDTO(id = "d", seq = 17, deletedAt = "x", attachments = listOf(AttachmentDTO(id = "gone")))
        val files = Mail.chatFiles(msgs)
        assertEquals(12, files.size); assertEquals("f15", files.first().first.id); assertEquals("u15", files.first().second)
        assertTrue(files.none { it.first.id == "voice" || it.first.id == "gone" })
    }

    @Test fun whatsappSharedAsMailRecord() {
        val wa = TcJson.decodeFromString(SharedMailDTO.serializer(), """{"id":"w1","provider":"whatsapp","direction":"in","from":{"name":"Luis","email":""},"subject":"Pedidos",
            "snippet":"Llegó el pedido","attachments":[],"status":"pending","wa":{"chatName":"Pedidos","isGroup":true,"accountKind":"business","accountId":"a1","jid":"57@g.us"},"sharedBy":"u1"}""")
        assertTrue(wa.isWhatsApp); assertEquals("Pedidos", wa.wa?.chatName); assertTrue(wa.wa!!.isGroup)
        assertFalse("WhatsApp no se responde desde chaggu", Mail.canReply(wa, "u1"))
        assertEquals("Luis", Mail.full(wa.from!!)); assertEquals("WhatsApp", Mail.label("whatsapp"))
        val b = MailSystem.parse(MessageDTO(kind = "system", body = """{"k":"wa.shared","emailId":"w1","accountId":"a1","jid":"57@g.us","text":"hola"}"""))!!
        assertEquals("w1", b.emailId)
    }

    @Test fun pickUpToTenChats() {
        var p = emptyList<String>()
        (1..12).forEach { p = Mail.toggleChat(p, "c$it") }
        assertEquals(10, p.size); assertEquals(listOf("c2", "c3"), Mail.toggleChat(listOf("c1", "c2", "c3"), "c1").take(2))
    }

    @Test fun waSharedIsParsedFromPartialPreviewToo() {
        val o = JsonObject(mapOf("k" to kotlinx.serialization.json.JsonPrimitive("mail.replied"), "emailId" to kotlinx.serialization.json.JsonPrimitive("e1"),
            "subject" to kotlinx.serialization.json.JsonPrimitive("Comité"), "byName" to kotlinx.serialization.json.JsonPrimitive("Danny")))
        assertEquals("Danny", MailSystem.parse(o)?.byName)
    }
}
