import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.6 · Reuniones con Meet / Teams / Zoom: idempotencia del diálogo, estados de los chips, errores y vuelta de la conexión.
final class MeetingTests: XCTestCase {
    func testIdempotencyKeyPerTapReusedOnRetryAndBlockedWhileCreating() {
        var n = 0
        let gen = { () -> String in n += 1; return "key-\(n)" }
        var i = MeetingIdempotency()
        XCTAssertEqual(i.begin(newKey: gen), "key-1")
        XCTAssertNil(i.begin(newKey: gen), "doble toque mientras crea: no hay segunda petición")
        i.failed()
        XCTAssertEqual(i.begin(newKey: gen), "key-1", "el reintento usa la misma llave")
        i.failed()
        XCTAssertEqual(i.begin(newKey: gen), "key-1")
        i.succeeded()
        XCTAssertFalse(i.inFlight)
        XCTAssertEqual(i.begin(newKey: gen), "key-2", "otra reunión, otra llave")
        XCTAssertEqual(n, 2)
    }

    func testChipStates() throws {
        let list = try dec(MeetingConnectionsList.self, #"""
        {"connections":[
          {"provider":"google","label":"Google Meet","available":true,"unavailableReason":null,"status":"active","accountEmail":"danny@example.com"},
          {"provider":"microsoft","label":"Microsoft Teams","available":true,"unavailableReason":null,"status":"reconnect","accountEmail":"d@x.com"},
          {"provider":"zoom","label":"Zoom","available":false,"unavailableReason":"Zoom aún no tiene una app OAuth","status":"none","accountEmail":null},
          {"provider":"webex","label":"Webex","available":true,"status":"none"}]}
        """#)
        XCTAssertEqual(list.connections.map(\.provider), [.google, .microsoft, .zoom], "un proveedor desconocido se ignora")
        XCTAssertEqual(list.connections[0].chipState, .connected("danny@example.com"))
        XCTAssertTrue(list.connections[0].canCreate)
        XCTAssertEqual(list.connections[1].chipState, .reconnect)
        XCTAssertFalse(list.connections[1].canCreate)
        XCTAssertEqual(list.connections[2].chipState, .unavailable("Zoom aún no tiene una app OAuth"))
        XCTAssertEqual(MeetingConnectionDTO(provider: .zoom).chipState, .connect)
    }

    func testErrorsMapToExplanations() {
        XCTAssertEqual(MeetingError(ApiRequestError(status: 409, code: "not_connected", message: "x")), .notConnected)
        XCTAssertEqual(MeetingError(ApiRequestError(status: 409, code: "reconnect_required", message: "x")), .reconnectRequired)
        XCTAssertEqual(MeetingError(ApiRequestError(status: 409, code: "no_teams", message: "x")), .noTeams)
        XCTAssertEqual(MeetingError(ApiRequestError(status: 503, code: "provider_unavailable", message: "Falta ZOOM_CLIENT_ID")), .unavailable("Falta ZOOM_CLIENT_ID"))
        XCTAssertEqual(MeetingError(ApiRequestError(status: 502, code: "google_failed", message: "Google Meet: cuota")), .provider("Google Meet: cuota"))
        XCTAssertEqual(MeetingError(ApiRequestError.network(URLError(.notConnectedToInternet))), .network)
        XCTAssertTrue(MeetingError.notConnected.needsConnect)
        XCTAssertFalse(MeetingError.noTeams.needsConnect)
        XCTAssertTrue(MeetingError.unavailable("Falta X").text(.zoom).contains("Falta X"), "se muestra el motivo")
    }

    func testOnlyConfirmedHttpsLinksCount() throws {
        let ok = try dec(MeetingDTO.self, #"{"id":"m","provider":"google","status":"created","title":"R","joinUrl":"https://meet.google.com/abc-defg-hij","messageId":"x"}"#)
        XCTAssertEqual(ok.confirmedURL?.host, "meet.google.com")
        XCTAssertTrue(ok.shared)
        XCTAssertNil(try dec(MeetingDTO.self, #"{"id":"m","provider":"zoom","status":"creating","joinUrl":"https://zoom.us/j/1"}"#).confirmedURL, "sin confirmación no hay enlace")
        XCTAssertNil(try dec(MeetingDTO.self, #"{"id":"m","provider":"zoom","status":"created","joinUrl":"javascript:alert(1)"}"#).confirmedURL)
        XCTAssertNil(try dec(MeetingDTO.self, #"{"id":"m","provider":"zoom","status":"created","joinUrl":null}"#).confirmedURL)
        XCTAssertEqual(MeetingProvider.microsoft.appName, "Teams")
    }

    func testConnectCallbackParsing() {
        XCTAssertEqual(MeetingCallback.parse(URL(string: "chaggu://meetings/connected?provider=google&connected=1")!), .connected(.google))
        XCTAssertEqual(MeetingCallback.parse(URL(string: "chaggu://meetings/connected?provider=microsoft&error=cancelled")!), .failed(.microsoft, code: "cancelled"))
        XCTAssertEqual(MeetingCallback.parse(URL(string: "chaggu://meetings/connected?provider=zoom&error=denied")!), .failed(.zoom, code: "denied"))
        XCTAssertNil(MeetingCallback.parse(URL(string: "chaggu://auth/callback?code=1")!))
        XCTAssertNil(MeetingCallback.parse(URL(string: "https://evil.example/meetings/connected?connected=1")!))
        XCTAssertTrue(MeetingCallback.isMeetings(URL(string: "chaggu://meetings/connected")!))
        XCTAssertNil(DeepLink.parse(URL(string: "chaggu://meetings/connected?provider=google&connected=1")!), "no es navegación")
    }

    func testNextSlotRoundsToHalfHour() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/Bogota")!
        let d = cal.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 10, minute: 12, second: 40))!
        XCTAssertEqual(cal.dateComponents([.hour, .minute, .second], from: MeetingSheet.nextSlot(d, calendar: cal)), DateComponents(hour: 10, minute: 30, second: 0))
        let e = cal.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 23, minute: 45))!
        XCTAssertEqual(cal.dateComponents([.day, .hour, .minute], from: MeetingSheet.nextSlot(e, calendar: cal)), DateComponents(day: 29, hour: 0, minute: 0))
    }
}
