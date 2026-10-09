import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }
private func sys(_ body: String) -> MessageDTO {
    MessageDTO(id: "s\(abs(body.hashValue))", conversationId: "c1", seq: 1, authorId: "a", clientMessageId: nil, kind: "system", body: body, createdAt: "")
}

/// Correo y WhatsApp en el chat (docs/CORREO.md): parseo de avisos, DTO, filtros y reglas de la respuesta.
@MainActor
final class MailTests: XCTestCase {
    // MARK: Avisos del chat: nunca JSON crudo

    func testSystemTextsNeverRawJson() {
        let saved = L10n.choice; defer { L10n.choice = saved }
        L10n.choice = .es
        XCTAssertEqual(L10n.systemText(#"{"k":"mail.shared","emailId":"e1","provider":"google","subject":"Comité de compras","from":"Jorge Pérez","comment":"¿Cómo respondemos?"}"#),
                       "✉ Compartió el correo «Comité de compras»")
        XCTAssertEqual(L10n.systemText(#"{"k":"mail.comments","emailId":"e1","title":"Comité","count":2,"lastById":"b","lastByName":"Bruno","lastExcerpt":"Yo lo miro"}"#),
                       "💬 Bruno comentó el correo «Comité»: Yo lo miro")
        XCTAssertEqual(L10n.systemText(#"{"k":"mail.replied","emailId":"e1","subject":"Comité","byName":"Ana Gómez"}"#), "✉ Ana Gómez respondió el correo «Comité»")
        XCTAssertEqual(L10n.systemText(#"{"k":"mail.reply_failed","emailId":"e1","subject":"Comité","error":"Sin permiso"}"#), "⚠ No salió la respuesta a «Comité»: Sin permiso")
        XCTAssertEqual(L10n.systemText(#"{"k":"wa.shared","accountId":"a","jid":"x@g.us","waMessageId":"w1","accountKind":"business","chatName":"Obra","isGroup":true,"author":"Luis","fromMe":false,"text":"Llegó el cemento","sentAt":null}"#),
                       "Compartió un mensaje de WhatsApp")
        // Tipos futuros: un texto neutro, nunca las llaves.
        XCTAssertEqual(L10n.systemText(#"{"k":"mail.forwarded","emailId":"e1"}"#), "Correo")
        XCTAssertEqual(L10n.systemText(#"{"k":"wa.reacted","x":1}"#), "Mensaje de WhatsApp")
        let future = L10n.systemText(#"{"k":"otra.cosa.nueva","a":"b"}"#)
        XCTAssertFalse(future.hasPrefix("{"), future)
        // Vista previa cortada a 140 caracteres (JSON incompleto).
        let cut = String(#"{"k":"mail.shared","emailId":"e1","provider":"google","subject":"Comité de compras de la sede norte con adjuntos","from":"Jorge Pérez Martínez de la Cruz"#.prefix(140))
        XCTAssertFalse(L10n.systemText(cut).hasPrefix("{"))
        L10n.choice = .en
        XCTAssertEqual(L10n.systemText(#"{"k":"mail.shared","emailId":"e1","subject":"Committee"}"#), "✉ Shared the email “Committee”")
        XCTAssertEqual(L10n.systemText(#"{"k":"wa.shared","text":"hi"}"#), "Shared a WhatsApp message")
    }

    func testChatKindParse() {
        XCTAssertEqual(MailChatKind.parse(sys(#"{"k":"mail.shared","emailId":"e1","comment":"Miren"}"#).systemPayload), .shared(emailId: "e1", comment: "Miren", forwardedFrom: nil))
        XCTAssertEqual(MailChatKind.parse(sys(#"{"k":"mail.shared","emailId":"e1"}"#).systemPayload), .shared(emailId: "e1", comment: nil, forwardedFrom: nil))
        guard case .comments(let id, let info, let prov)? = MailChatKind.parse(sys(#"{"k":"mail.comments","emailId":"e2","title":"T","count":3,"lastById":"b","lastByName":"Bruno Díaz","lastExcerpt":"ok","provider":"whatsapp"}"#).systemPayload) else { return XCTFail() }
        XCTAssertEqual(id, "e2"); XCTAssertEqual(info.count, 3); XCTAssertEqual(info.lastByName, "Bruno Díaz"); XCTAssertEqual(info.lastExcerpt, "ok")
        XCTAssertEqual(info.title, "T"); XCTAssertEqual(prov, "whatsapp", "el aviso trae el proveedor para el icono")
        XCTAssertEqual(MailChatKind.parse(sys(#"{"k":"mail.replied","emailId":"e3"}"#).systemPayload), .replied(emailId: "e3"))
        XCTAssertEqual(MailChatKind.parse(sys(#"{"k":"mail.reply_failed","emailId":"e3","error":"x"}"#).systemPayload), .replyFailed(emailId: "e3"))
        guard case .waShared(let w)? = MailChatKind.parse(sys(#"{"k":"wa.shared","accountId":"a1","jid":"j","waMessageId":"w","accountKind":"business","chatName":"Obra","isGroup":true,"author":"Luis","fromMe":false,"text":"Llegó","sentAt":"2026-09-29T10:00:00Z","comment":"Ojo"}"#).systemPayload) else { return XCTFail() }
        XCTAssertEqual(w.chatName, "Obra"); XCTAssertTrue(w.isGroup); XCTAssertEqual(w.accountKind, "business"); XCTAssertEqual(w.comment, "Ojo"); XCTAssertEqual(w.text, "Llegó")
        XCTAssertNil(w.emailId, "los viejos no traen registro propio")
        guard case .waShared(let w2)? = MailChatKind.parse(sys(#"{"k":"wa.shared","emailId":"e9","text":"Hola"}"#).systemPayload) else { return XCTFail() }
        XCTAssertEqual(w2.emailId, "e9", "desde la 040: tarjeta con hilo y tarea")
        // Sin id o de otro tipo: no es tarjeta de correo.
        XCTAssertNil(MailChatKind.parse(sys(#"{"k":"mail.shared"}"#).systemPayload))
        XCTAssertNil(MailChatKind.parse(sys(#"{"k":"issue.created","issueId":"i"}"#).systemPayload))
        XCTAssertNil(ChatCards.kind(sys(#"{"k":"mail.comments","emailId":"e2","count":1}"#)), "no se confunde con las tarjetas de tareas/eventos")
    }

    // MARK: DTO

    func testSharedMailDecodeAndMerge() throws {
        let json = #"""
        {"id":"e1","conversationId":"c1","sharedBy":"u1","provider":"microsoft","accountEmail":"yo@x.co","direction":"out",
         "from":{"name":"Yo","email":"yo@x.co"},"to":[{"name":null,"email":"jorge@cliente.com"}],"cc":[{"name":"Ana","email":"ana@x.co"}],
         "subject":"RE: Pedido","snippet":"Hola","body":"","full":false,"trimmed":true,"sentAt":"2026-09-28T15:00:00Z",
         "attachments":[{"id":"a1","name":"orden.pdf","size":20480,"contentType":"application/pdf"}],"messageId":"m1","comment":null,
         "status":"scheduled","repliedAt":null,"repliedBy":null,"scheduledReply":{"id":"r1","sendAt":"2026-09-30T14:00:00Z"},
         "issueId":null,"commentCount":2,"lastComments":[{"id":"k1","emailId":"e1","authorId":"u2","body":"Dale","createdAt":"2026-09-28T16:00:00Z"}],
         "createdAt":"2026-09-28T15:05:00Z","webLink":"https://outlook.office.com/x","campoNuevo":42}
        """#
        let e = try dec(SharedMailDTO.self, json)
        XCTAssertEqual(e.provider, .microsoft); XCTAssertTrue(e.isOut); XCTAssertEqual(e.other?.email, "jorge@cliente.com")
        XCTAssertEqual(e.attachments.first?.size, 20480); XCTAssertEqual(e.scheduledReply?.id, "r1"); XCTAssertTrue(e.trimmed)
        XCTAssertEqual(e.lastComments.first?.body, "Dale"); XCTAssertEqual(e.commentCount, 2)
        // Tolerante: faltan casi todos los campos.
        let thin = try dec(SharedMailDTO.self, #"{"id":"e2","provider":"yahoo"}"#)
        XCTAssertEqual(thin.provider, .google); XCTAssertEqual(thin.status, "pending"); XCTAssertTrue(thin.to.isEmpty)

        // mail.updated llega SIN cuerpo y sin lo que solo ve su dueño: no borra nada de eso.
        var full = e; full.body = "Texto completo"; full.full = true
        var live = e; live.body = ""; live.full = false; live.scheduledReply = nil; live.webLink = nil; live.commentCount = 3
        let merged = SharedMailDTO.merge(live, into: full, live: true)
        XCTAssertEqual(merged.body, "Texto completo"); XCTAssertTrue(merged.full); XCTAssertEqual(merged.commentCount, 3)
        XCTAssertEqual(merged.scheduledReply?.id, "r1"); XCTAssertEqual(merged.webLink, "https://outlook.office.com/x")
        // Si ya no está programado, lo programado se va.
        var done = live; done.status = "replied"
        XCTAssertNil(SharedMailDTO.merge(done, into: full, live: true).scheduledReply)
        // Una tarjeta pedida por mí (no en vivo) sí trae su scheduledReply real.
        var mine = live; mine.scheduledReply = nil
        XCTAssertNil(SharedMailDTO.merge(mine, into: full).scheduledReply)
    }

    func testWhatsAppSharedAndShareResult() throws {
        let e = try dec(SharedMailDTO.self, #"{"id":"w1","conversationId":"c1","sharedBy":"u1","provider":"whatsapp","direction":"in","from":{"name":"Luis","email":""},"subject":"Obra","snippet":"Llegó el cemento","attachments":[],"wa":{"chatName":"Obra","isGroup":true,"accountKind":"business","accountId":"a1","jid":"x@g.us"}}"#)
        XCTAssertEqual(e.provider, .whatsapp); XCTAssertTrue(e.provider.isWhatsApp); XCTAssertEqual(e.provider.label, "WhatsApp")
        XCTAssertEqual(e.wa?.chatName, "Obra"); XCTAssertTrue(e.wa?.isGroup == true); XCTAssertEqual(e.wa?.jid, "x@g.us"); XCTAssertEqual(e.from?.name, "Luis")
        // Varios chats: {emails:[…]}; servidores anteriores: un SharedMailDTO; WhatsApp viejo: {message} sin tarjetas.
        XCTAssertEqual(MailShareResult.decode(Data(#"{"emails":[{"id":"a"},{"id":"b"}]}"#.utf8)).map(\.id), ["a", "b"])
        XCTAssertEqual(MailShareResult.decode(Data(#"{"id":"a","conversationId":"c1"}"#.utf8)).map(\.id), ["a"])
        XCTAssertTrue(MailShareResult.decode(Data(#"{"message":{"id":"m"}}"#.utf8)).isEmpty)
    }

    func testCardQuoteNeverJson() {
        let saved = L10n.choice; defer { L10n.choice = saved }
        L10n.choice = .es
        let mail = #"{"k":"mail.shared","emailId":"e1","provider":"google","subject":"Comité del jueves","from":"Jorge Ramírez","comment":"Miren"}"#
        XCTAssertEqual(MailText.cardQuote(kind: "system", body: mail), "✉ Comité del jueves · Jorge Ramírez")
        XCTAssertEqual(MailText.cardQuote(kind: "system", body: #"{"k":"mail.shared","emailId":"e1","subject":""}"#), "✉ (sin asunto)")
        XCTAssertEqual(MailText.cardQuote(kind: "system", body: #"{"k":"wa.shared","chatName":"Obra","text":"Llegó el cemento"}"#), "WhatsApp · Obra: Llegó el cemento")
        // Cortado a 140 caracteres (vista previa): igual sale sin JSON.
        let cut = String(#"{"k":"mail.shared","emailId":"e1","provider":"google","subject":"Solicitud de presentación para el comité del jueves","from":"Jorge Ramírez Martínez de la Universidad de los Andes"}"#.prefix(140))
        XCTAssertLessThan(cut.count, 170)
        XCTAssertEqual(MailText.cardQuote(kind: "system", body: cut), "✉ Solicitud de presentación para el comité del jueves")
        XCTAssertNil(MailText.cardQuote(kind: "text", body: mail), "un mensaje de texto no es tarjeta")
        // Cualquier otra cita de un aviso de sistema: su texto, nunca el JSON.
        XCTAssertEqual(MailText.quoteText(kind: "system", body: #"{"k":"mail.replied","emailId":"e1","subject":"Comité","byName":"Ana"}"#), "✉ Ana respondió el correo «Comité»")
        XCTAssertEqual(MailText.quoteText(kind: "text", body: "hola"), "hola")
        // Reenviado: forwardedFrom en mail.shared y wa.shared.
        XCTAssertEqual(MailChatKind.parse(sys(#"{"k":"mail.shared","emailId":"e2","forwardedFrom":"c9"}"#).systemPayload), .shared(emailId: "e2", comment: nil, forwardedFrom: "c9"))
        guard case .waShared(let w)? = MailChatKind.parse(sys(#"{"k":"wa.shared","emailId":"e3","text":"x","forwardedFrom":"c9"}"#).systemPayload) else { return XCTFail() }
        XCTAssertEqual(w.forwardedFrom, "c9")
    }

    func testLiveEventDecodes() throws {
        let ev = try dec(ConversationEvent.self, #"{"type":"mail.updated","conversationId":"c1","eventSeq":9,"email":{"id":"e1","conversationId":"c1","sharedBy":"u1","provider":"google","subject":"Hola","body":""}}"#)
        guard case .mailUpdated(let c, let s, let m) = ev else { return XCTFail("\(ev)") }
        XCTAssertEqual(c, "c1"); XCTAssertEqual(s, 9); XCTAssertEqual(m.subject, "Hola")
        XCTAssertEqual(ev.eventSeq, 9)
        let b = try dec(BootstrapDTO.self, #"{"contract":"x","serverTime":"","me":{"id":"u1"},"features":{"calls":true,"mail":true}}"#)
        XCTAssertTrue(b.mailEnabled)
        let old = try dec(BootstrapDTO.self, #"{"contract":"x","serverTime":"","me":{"id":"u1"},"features":{"calls":true}}"#)
        XCTAssertFalse(old.mailEnabled)
    }

    func testListDTOs() throws {
        let l = try dec(MailListDTO.self, #"{"items":[{"provider":"google","id":"g1","threadId":"t","from":{"name":"Jorge","email":"j@c.com"},"to":[],"subject":"Comité","snippet":"Adjunto…","date":"2026-09-29T10:00:00Z","unread":true,"hasAttachments":true,"box":"inbox"},{"broken":1}],"nextPage":"abc+/=","accountEmail":"yo@x.co"}"#)
        XCTAssertEqual(l.items.count, 1); XCTAssertEqual(l.nextPage, "abc+/="); XCTAssertTrue(l.items[0].unread)
        let m = try dec(MailMessageDTO.self, #"{"provider":"google","id":"g1","subject":"S","box":"sent","to":[{"email":"a@b.co"}],"cc":[{"email":"c@b.co"}],"body":"Hola","attachments":[{"id":"x","name":"a.pdf","size":10,"contentType":"application/pdf"}]}"#)
        XCTAssertTrue(m.item.isSent); XCTAssertEqual(m.item.other?.email, "a@b.co"); XCTAssertEqual(m.cc.count, 1); XCTAssertEqual(m.attachments.count, 1)
        let c = try dec(MailConnectionDTO.self, #"{"provider":"microsoft","label":"Outlook","available":false,"unavailableReason":"Falta configurar","status":"none","accountEmail":null}"#)
        XCTAssertFalse(c.available); XCTAssertFalse(c.isActive)
    }

    // MARK: Filtros

    func testFiltersQuery() {
        var f = MailFilters()
        XCTAssertEqual(f.effectiveCategory(.google), "primary", "por defecto Principal")
        XCTAssertEqual(f.effectiveCategory(.microsoft), "focused", "por defecto Prioritarios")
        f.q = "comité"
        XCTAssertEqual(f.effectiveCategory(.google), "any", "al buscar sin elegir pestaña: todas")
        f.category = "promotions"
        XCTAssertEqual(f.effectiveCategory(.google), "promotions", "salvo que se haya elegido una")
        f.box = "sent"
        XCTAssertNil(f.effectiveCategory(.google), "solo Recibidos tiene pestañas")
        XCTAssertFalse(f.path(.google).contains("category="))

        var g = MailFilters()
        g.from = "jorge@cliente.com"; g.attachments = true; g.unread = true; g.label = "Clientes"
        let path = g.path(.google, page: "tok+en/1", fresh: true)
        XCTAssertTrue(path.hasPrefix("/mail/messages?provider=google&box=inbox&category=any"), path)
        XCTAssertTrue(path.contains("from=jorge@cliente.com")); XCTAssertTrue(path.contains("attachments=1")); XCTAssertTrue(path.contains("unread=1"))
        XCTAssertTrue(path.contains("label=Clientes")); XCTAssertTrue(path.contains("fresh=1"))
        XCTAssertTrue(path.contains("page=tok%2Ben/1"), "el + del token de página no se vuelve espacio")
        XCTAssertFalse(path.contains("q="), "lo vacío no viaja")
        XCTAssertTrue(g.filtered)
        g.clear(); XCTAssertFalse(g.filtered); XCTAssertEqual(g.box, "inbox")
    }

    func testDateRanges() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/Bogota")!
        let now = ISODate.parse("2026-09-29T15:00:00Z")!
        var f = MailFilters()
        f.setRange(.today, now: now, calendar: cal); XCTAssertEqual(f.after, "2026-09-29"); XCTAssertEqual(f.before, "")
        f.setRange(.week, now: now, calendar: cal); XCTAssertEqual(f.after, "2026-09-22")
        f.setRange(.month, now: now, calendar: cal); XCTAssertEqual(f.after, "2026-08-30")
        f.setRange(.year, now: now, calendar: cal); XCTAssertEqual(f.after, "2026-01-01")
        f.setRange(.older, now: now, calendar: cal); XCTAssertEqual(f.after, ""); XCTAssertEqual(f.before, "2025-09-29")
        XCTAssertTrue(f.filtered)
        f.setRange(nil, now: now, calendar: cal); XCTAssertEqual(f.after, ""); XCTAssertEqual(f.before, ""); XCTAssertNil(f.range)
    }

    // MARK: Responder, tarea y programar

    func testReplyRules() {
        let e = SharedMailDTO(id: "e1", conversationId: "c1", sharedBy: "u1", accountEmail: "yo@x.co", direction: "in",
                              from: .init(name: "Jorge Pérez", email: "jorge@cliente.com"),
                              to: [.init(name: "Yo", email: "YO@x.co"), .init(name: "Ana", email: "ana@x.co")],
                              cc: [.init(name: nil, email: "ana@x.co"), .init(name: nil, email: "jorge@cliente.com"), .init(name: nil, email: "luis@x.co")],
                              subject: "RE: Fwd: Comité de compras")
        XCTAssertEqual(MailText.replyTo(e).map(\.email), ["jorge@cliente.com"])
        XCTAssertEqual(MailText.defaultCc(e), ["ana@x.co", "luis@x.co"], "todos menos yo y el destinatario, sin repetir")
        XCTAssertEqual(MailText.taskTitle(e, prefix: "Responder a"), "Responder a Jorge: Comité de compras")
        var out = e; out.direction = "out"; out.subject = "RV: Cotización"
        XCTAssertEqual(MailText.replyTo(out).map(\.email), ["YO@x.co", "ana@x.co"])
        XCTAssertEqual(MailText.taskTitle(out, prefix: "Responder a"), "RV: Cotización")
        XCTAssertEqual(MailText.stripPrefixes("fw: RE:  aw: Hola"), "Hola")
        XCTAssertEqual(MailText.parseCc("a@b.co, c@d.co;e@f.co  "), ["a@b.co", "c@d.co", "e@f.co"])
        XCTAssertTrue(MailText.validEmail("a@b.co")); XCTAssertFalse(MailText.validEmail("a@b")); XCTAssertFalse(MailText.validEmail("sin arroba"))
        XCTAssertEqual(MailText.size(20480), "20 KB"); XCTAssertEqual(MailText.size(1_572_864), "1.5 MB")
    }

    func testQuickScheduleTimes() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/Bogota")!
        let wed = ISODate.parse("2026-09-30T15:00:00Z")! // miércoles 10:00 en Bogotá
        XCTAssertEqual(MailText.quickDate(.in1h, now: wed, calendar: cal).timeIntervalSince(wed), 3600)
        XCTAssertEqual(MailText.quickDate(.in3h, now: wed, calendar: cal).timeIntervalSince(wed), 3 * 3600)
        XCTAssertEqual(ISODate.string(MailText.quickDate(.tomorrow9, now: wed, calendar: cal)).prefix(16), "2026-10-01T14:00")
        XCTAssertEqual(ISODate.string(MailText.quickDate(.monday9, now: wed, calendar: cal)).prefix(16), "2026-10-05T14:00")
        let mon = ISODate.parse("2026-10-05T15:00:00Z")!
        XCTAssertEqual(ISODate.string(MailText.quickDate(.monday9, now: mon, calendar: cal)).prefix(16), "2026-10-12T14:00", "un lunes: el lunes siguiente, como la web")
    }

    func testConnectCallback() {
        let r = String(repeating: "a", count: 43)
        XCTAssertEqual(MailCallback.parse(URL(string: "chaggu://mail/connected?mail=1&provider=google&receipt=\(r)")!), .receipt(.google, r))
        XCTAssertEqual(MailCallback.parse(URL(string: "chaggu://mail/connected?mail=1&provider=microsoft&error=cancelled")!), .failed(.microsoft, code: "cancelled"))
        XCTAssertEqual(MailCallback.parse(URL(string: "chaggu://mail/connected?mail=1&provider=google&receipt=corto")!), .failed(.google, code: "invalid_callback"))
        XCTAssertEqual(MailCallback.parse(URL(string: "chaggu://mail/connected?provider=google&provider=microsoft&receipt=\(r)")!), .failed(nil, code: "invalid_callback"))
        XCTAssertNil(MailCallback.parse(URL(string: "chaggu://meetings/connected?receipt=\(r)")!))
        XCTAssertTrue(MailCallback.isMail(URL(string: "tiecoms://mail/connected")!))
    }
}
