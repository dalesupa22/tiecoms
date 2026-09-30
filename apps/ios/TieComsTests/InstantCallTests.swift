import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

private let callJSON = #"{"id":"callQ","conversationId":"cq","kind":"audio","startedBy":"a","startedAt":"2026-09-30T10:00:00.000Z","endedAt":null,"activeUserIds":["a"],"transcribing":false,"hasTranscript":false,"guests":[]}"#
private let instantJSON = #"{"call":\#(callJSON),"conversationId":"cq","link":{"url":"https://app.chaggu.com/llamada/tokRapido_123","token":"tokRapido_123"}}"#
private func joinJSON(_ call: String = callJSON) -> String { #"""
{"call":\#(call),
 "meeting":{"Meeting":{"MeetingId":"fake-callQ","ExternalMeetingId":"callQ","MediaRegion":"us-east-1",
   "MediaPlacement":{"AudioHostUrl":"fake.invalid:3478","SignalingUrl":"wss://fake.invalid/control","TurnControlUrl":"https://fake.invalid/turn"}}},
 "attendee":{"Attendee":{"AttendeeId":"att-a","ExternalUserId":"a#ios","JoinToken":"tok-a"}}}
"""# }

/// «Nueva llamada» con enlace para invitados (1.7.6): contrato de POST /calls/instant, texto a compartir y 404 de un servidor viejo.
@MainActor
final class InstantCallTests: XCTestCase {
    override func tearDown() { ControlledURLProtocol.handler = nil }

    // MARK: Decodificación

    func testDecodesInstantResponse() throws {
        let r = try dec(InstantCallDTO.self, instantJSON)
        XCTAssertEqual(r.call.id, "callQ")
        XCTAssertEqual(r.conversationId, "cq")
        XCTAssertEqual(r.link, InstantCallLinkDTO(url: "https://app.chaggu.com/llamada/tokRapido_123", token: "tokRapido_123"))
        XCTAssertTrue(r.call.isLive)
        XCTAssertEqual(DeepLink.parse(URL(string: r.link.url)!), .guestCall(r.link.token), "el enlace es el mismo /llamada/<token> que ya abre la app")

        // La llamada sin conversationId toma la de la respuesta; sin token también decodifica.
        let bare = try dec(InstantCallDTO.self, #"{"call":{"id":"x"},"conversationId":"c9","link":{"url":"https://app.chaggu.com/llamada/abc"}}"#)
        XCTAssertEqual(bare.call.conversationId, "c9"); XCTAssertEqual(bare.link.token, "")
        // Sin conversationId arriba usa el de la llamada.
        let noConv = try dec(InstantCallDTO.self, #"{"call":\#(callJSON),"link":{"url":"u","token":"t"}}"#)
        XCTAssertEqual(noConv.conversationId, "cq")
        // Sin enlace no hay llamada rápida.
        XCTAssertThrowsError(try dec(InstantCallDTO.self, #"{"call":\#(callJSON),"conversationId":"cq"}"#))
    }

    func testGuestsWithAndWithoutEmail() throws {
        let c = try dec(CallDTO.self, #"""
        {"id":"callQ","conversationId":"cq","activeUserIds":["a"],
         "guests":[{"id":"g1","name":"Laura Invitada","email":"laura@correo.test"},{"id":"g2","name":"Pedro"},
                   {"id":"g3","name":"Sin correo","email":null},{"id":"g4","name":"Vacío","email":"  "},{"id":"g5","name":"Raro","email":42},{"name":"sin id"}]}
        """#)
        XCTAssertEqual(c.guests.map(\.id), ["g1", "g2", "g3", "g4", "g5"], "el defectuoso se descarta, los demás quedan")
        XCTAssertEqual(c.guests[0], CallGuestDTO(id: "g1", name: "Laura Invitada", email: "laura@correo.test"))
        XCTAssertEqual(c.guests[1], CallGuestDTO(id: "g2", name: "Pedro"), "servidor sin email: nil")
        XCTAssertNil(c.guests[2].email); XCTAssertNil(c.guests[3].email, "solo espacios = sin correo"); XCTAssertNil(c.guests[4].email, "otro tipo = sin correo")
        XCTAssertEqual(CallRules.guestEmail(c, "guest:g1"), "laura@correo.test")
        XCTAssertNil(CallRules.guestEmail(c, "guest:g2"))
        XCTAssertNil(CallRules.guestEmail(c, "a"), "una persona de chaggu no muestra correo aquí")
        XCTAssertEqual(CallRules.guestName(c, "guest:g1"), "Laura Invitada")
        XCTAssertEqual(CallRules.people(c), ["a", "guest:g1", "guest:g2", "guest:g3", "guest:g4", "guest:g5"])
        // La vista del invitado (latido) también trae el correo.
        let st = try dec(GuestCallStateDTO.self, #"{"callId":"callQ","active":true,"guests":[{"id":"g1","name":"Laura","email":"l@x.test"},{"id":"g2","name":"P"}]}"#)
        XCTAssertEqual(st.guests.map(\.email), ["l@x.test", nil])
    }

    // MARK: Texto a compartir y título

    func testShareTextAndTitle() {
        let url = "https://app.chaggu.com/llamada/tokRapido_123"
        let text = InstantCallRules.shareText(url)
        XCTAssertTrue(text.contains(url))
        if L10n.lang == "es" {
            XCTAssertEqual(text, "Únete a mi llamada en chaggu: \(url). Solo necesitas tu nombre y correo.")
            XCTAssertEqual(InstantCallRules.autoTitle(myName: "Danny Suárez"), "Llamada de Danny")
            XCTAssertEqual(InstantCallRules.errorText(ApiRequestError(status: 404, code: "not_found", message: "Not found")),
                           "Actualiza pronto: tu servidor aún no tiene llamadas rápidas.")
        } else {
            XCTAssertEqual(text, "Join my call on chaggu: \(url). You only need your name and email.")
            XCTAssertEqual(InstantCallRules.autoTitle(myName: "Danny Suárez"), "Danny's call")
        }
        XCTAssertFalse(InstantCallRules.autoTitle(myName: nil).isEmpty)
        XCTAssertEqual(InstantCallRules.autoTitle(myName: "  "), InstantCallRules.autoTitle(myName: nil))
        XCTAssertEqual(InstantCallRules.title("  Obra Norte  ", myName: "Danny"), "Obra Norte")
        XCTAssertEqual(InstantCallRules.title("   ", myName: "Danny"), InstantCallRules.autoTitle(myName: "Danny"), "vacío → automático")
        XCTAssertEqual(InstantCallRules.title(String(repeating: "x", count: 200), myName: nil).count, InstantCallRules.titleMax)
        let body = InstantCallRules.body(title: "Obra", video: true)
        XCTAssertEqual(body["title"] as? String, "Obra"); XCTAssertEqual(body["video"] as? Bool, true)
        // Los textos existen en los dos idiomas (no se ve la clave).
        for k in ["calls.instant.new", "calls.instant.start", "calls.instant.shareTitle", "calls.instant.oldServer", "calls.instant.copy", "calls.instant.expires"] {
            XCTAssertNotEqual(L(k), k, k)
            XCTAssertNotEqual(L10n.englishBundle?.localizedString(forKey: k, value: k, table: nil), k, "en: \(k)")
        }
    }

    // MARK: 404 y errores

    func testOldServerErrorIsFriendly() {
        XCTAssertTrue(InstantCallRules.isOldServer(ApiRequestError(status: 404, code: "not_found", message: "")))
        XCTAssertFalse(InstantCallRules.isOldServer(ApiRequestError(status: 403, code: "calls_disabled", message: "")))
        XCTAssertFalse(InstantCallRules.isOldServer(ApiRequestError(status: 0, code: "network", message: "")))
        XCTAssertFalse(InstantCallRules.isOldServer(URLError(.badURL)))
        XCTAssertEqual(InstantCallRules.errorText(ApiRequestError(status: 404, code: "not_found", message: "x")), L("calls.instant.oldServer"))
        let net = ApiRequestError(status: 0, code: "network", message: "")
        XCTAssertEqual(InstantCallRules.errorText(net), L10n.errorText(net), "otros errores: el texto de siempre")
    }

    func testStartInstant404DoesNotEnterACall() async throws {
        let s = try ControlledURLProtocol.store()
        var paths: [String] = []
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            paths.append(req.request.url!.path)
            req.respond(404, #"{"error":{"code":"not_found","message":"Route POST:/api/v1/calls/instant not found"}}"#)
        } }
        do { _ = try await s.startInstantCallRequest(title: "Obra", video: false); XCTFail("debió fallar") }
        catch {
            XCTAssertTrue(InstantCallRules.isOldServer(error))
            XCTAssertEqual(InstantCallRules.errorText(error), L("calls.instant.oldServer"))
        }
        // (Otra prueba puede dejar un «leave» en vuelo: solo cuentan las rutas de esta.)
        XCTAssertEqual(paths.filter { !$0.hasSuffix("/leave") }, ["/api/v1/calls/instant"], "no intenta unirse")
        XCTAssertNil(s.callCenter.view)
        XCTAssertNil(s.callCenter.shareLink)
    }

    // MARK: Flujo completo con datos simulados

    func testStartInstantJoinsAndOffersLinkUntilTheCallEnds() async throws {
        let s = try ControlledURLProtocol.store()
        s.seedForTesting(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana Márquez"},"features":{"calls":true},"conversations":[]}"#))
        var paths: [String] = []
        var bodies: [String: [String: Any]] = [:]
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            let p = req.request.url!.path
            paths.append(p); bodies[p] = req.json
            switch p {
            case "/api/v1/calls/instant": req.respond(201, instantJSON)
            case "/api/v1/calls/callQ/join": req.respond(joinJSON())
            case "/api/v1/calls/callQ/leave": req.respond(#"{"call":\#(callJSON.replacingOccurrences(of: #""endedAt":null"#, with: #""endedAt":"2026-09-30T10:05:00Z""#))}"#)
            default: req.respond(#"{"ok":true}"#)
            }
        } }
        let title = InstantCallRules.title("", myName: s.me?.name)
        let r = try await s.startInstantCallRequest(title: title, video: false)
        XCTAssertEqual(bodies["/api/v1/calls/instant"]?["title"] as? String, title)
        XCTAssertEqual(bodies["/api/v1/calls/instant"]?["video"] as? Bool, false)
        XCTAssertEqual(s.liveCalls["cq"]?.id, "callQ", "la llamada queda en curso para la franja y «En curso ahora»")

        let center = s.callCenter
        try await center.enterInstant(r, video: false, title: title)
        XCTAssertEqual(paths, ["/api/v1/calls/instant", "/api/v1/calls/callQ/join"], "se entra con el flujo normal de unirse")
        XCTAssertTrue(center.media is NullCallMedia)
        XCTAssertTrue(center.expanded)
        XCTAssertEqual(center.currentShareLink, CallShareLink(callId: "callQ", url: "https://app.chaggu.com/llamada/tokRapido_123", token: "tokRapido_123", title: title))
        XCTAssertEqual(CallTitle.text(try XCTUnwrap(s.data), try XCTUnwrap(center.view).call, fallback: center.currentShareLink?.title), title,
                       "cabecera con el título mientras la conversación no llega")
        XCTAssertTrue(center.linkSheet, "la hoja «Comparte el enlace» sale sola")

        // Entra una invitada con correo (call.updated): aparece en la lista con nombre y correo.
        let withGuest = callJSON.replacingOccurrences(of: #""guests":[]"#, with: #""guests":[{"id":"g1","name":"Laura Invitada","email":"laura@correo.test"}]"#)
        s.socketEventForTesting("account.event", #"{"type":"call.updated","call":\#(withGuest)}"#)
        let v = try XCTUnwrap(center.view)
        let ctx = CallPeopleContext(d: s.data, me: "a", call: v.call)
        XCTAssertEqual(ctx.inside, ["a", "guest:g1"])
        XCTAssertEqual(ctx.fullName("guest:g1"), "Laura Invitada")
        XCTAssertEqual(CallRules.guestEmail(v.call, "guest:g1"), "laura@correo.test")
        XCTAssertTrue(ctx.isGuest("guest:g1"))
        XCTAssertNotNil(center.currentShareLink, "con gente dentro el enlace se sigue pudiendo compartir")

        // Colgar: el enlace muere con la llamada.
        await center.hangUp()
        XCTAssertNil(center.view)
        XCTAssertNil(center.shareLink); XCTAssertNil(center.currentShareLink)
        XCTAssertFalse(center.linkSheet)
    }

    func testCallEndedElsewhereClearsLinkAndOtherCallsHaveNone() async throws {
        let s = try ControlledURLProtocol.store()
        s.seedForTesting(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana"},"features":{"calls":true},"conversations":[{"id":"c1","kind":"direct","memberIds":["a","b"],"canPost":true}]}"#))
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            switch req.request.url!.path {
            case "/api/v1/calls/instant": req.respond(201, instantJSON)
            case "/api/v1/calls/callQ/join": req.respond(joinJSON())
            case "/api/v1/conversations/c1/call": req.respond(joinJSON(#"{"id":"call1","conversationId":"c1","activeUserIds":["a"]}"#))
            default: req.respond(#"{"ok":true}"#)
            }
        } }
        let center = s.callCenter
        try await center.enterInstant(try await s.startInstantCallRequest(title: "x", video: true), video: true)
        XCTAssertNotNil(center.currentShareLink)
        XCTAssertTrue(center.view?.camera == true, "Video: entra con cámara")
        // Terminó en otro lado: se cierra y el enlace desaparece.
        s.socketEventForTesting("account.event", #"{"type":"call.updated","call":\#(callJSON.replacingOccurrences(of: #""endedAt":null"#, with: #""endedAt":"2026-09-30T10:09:00Z""#))}"#)
        try await waitUntil(2, "cerrada") { center.view == nil }
        XCTAssertNil(center.shareLink)

        // Una llamada normal no tiene 🔗.
        try await center.start("c1", kind: "audio")
        XCTAssertNotNil(center.view)
        XCTAssertNil(center.currentShareLink)
        center.reset()
        XCTAssertNil(center.shareLink)
    }
}
