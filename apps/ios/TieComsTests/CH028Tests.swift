import CallKit
import XCTest
@testable import TieComs

/// CH028: buscarme a mí mismo («Tú», notas para ti, mismas reglas que apps/web/src/quick-search.ts), «Enviar mensaje»
/// desde la ficha de una persona y las reglas puras del puente con CallKit (Recientes de Teléfono).
@MainActor
final class CH028Tests: XCTestCase {
    private func boot(selfChat: Bool = true, meInPeople: Bool = true) throws -> BootstrapDTO {
        let selfRow = selfChat ? #"{"id":"tu","kind":"direct","memberIds":["me"],"lastMessageAt":"2026-10-01T10:00:00Z"},"# : ""
        let mePerson = meInPeople ? #"{"id":"me","name":"Danny Suárez","kind":"human","orgId":"oA","title":"Gerente"},"# : ""
        return try JSONDecoder().decode(BootstrapDTO.self, from: Data("""
        {"contract":"2026-09-25","serverTime":"","me":{"id":"me","name":"Danny Suárez","kind":"human","primaryOrgId":"oA","title":"Gerente"},
         "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"},{"id":"oB","name":"Ongoing"}],
         "workspaces":[],
         "conversations":[\(selfRow)
           {"id":"d1","kind":"direct","memberIds":["me","bob"],"lastMessageAt":"2026-09-20T11:00:00Z"},
           {"id":"d2","kind":"direct","memberIds":["me","yoli"],"lastMessageAt":"2026-09-26T11:00:00Z"},
           {"id":"m1","kind":"multi","name":"Café","memberIds":["me","bob","yoli"],"lastMessageAt":"2026-09-21T11:00:00Z"}],
         "people":[\(mePerson){"id":"bob","name":"Bob","kind":"human","orgId":"oB"},
                   {"id":"yoli","name":"Yolanda Mejía","kind":"human","orgId":"oA"},
                   {"id":"bot","name":"Asistente","kind":"agent","orgId":"oA"}]}
        """.utf8))
    }

    // MARK: Buscarme a mí mismo

    func testSelfWordsAndMyNameFindMe() throws {
        let d = try boot()
        for q in ["danny", "Dann", "suarez", "yo", "tú", "tu", "notas", "conmigo", "me", "self", "myself", "you", "notes", "NOT", "gerente", "xertify"] {
            XCTAssertTrue(QuickSearch.people(d, query: q).contains { $0.id == "me" }, "«\(q)» me encuentra")
        }
        // Mismo orden que la web: quien empieza con lo escrito y luego con quien hablo (Yolanda empieza con «yo»).
        XCTAssertEqual(QuickSearch.people(d, query: "notas").map(\.id), ["me"])
        XCTAssertEqual(QuickSearch.people(d, query: "danny").map(\.id), ["me"])
        XCTAssertEqual(QuickSearch.people(d, query: "yo").map(\.id), ["yoli", "me"])
        XCTAssertFalse(QuickSearch.people(d, query: "bob").contains { $0.id == "me" }, "lo que no me nombra no me trae")
        XCTAssertFalse(QuickSearch.people(d, query: "o").contains { $0.id == "me" }, "una sola letra no basta para las palabras («o» de «yo»)")
        XCTAssertFalse(QuickSearch.people(d, query: "danny", exclude: ["me"]).contains { $0.id == "me" }, "excluido, no sale")
        XCTAssertTrue(QuickSearch.people(d, query: "asist").isEmpty, "los agentes siguen fuera")
    }

    func testMeComesFromSnapshotWhenDirectoryLacksMe() throws {
        let d = try boot(meInPeople: false)
        let me = try XCTUnwrap(QuickSearch.people(d, query: "notas").first)
        XCTAssertEqual(me.id, "me")
        XCTAssertEqual(me.name, "Danny Suárez")
        XCTAssertEqual(me.orgId, "oA")
        XCTAssertEqual(me.title, "Gerente")
        XCTAssertEqual(QuickSearch.people(d, query: "gerente").map(\.id), ["me"], "por mi cargo también")
    }

    func testDirectWithMeIsOnlyTheSelfChat() throws {
        let d = try boot()
        XCTAssertEqual(QuickSearch.direct(d, with: "me")?.id, "tu", "conmigo mismo es «Tú», no cualquier directo")
        XCTAssertEqual(QuickSearch.direct(d, with: "bob")?.id, "d1")
        XCTAssertNil(QuickSearch.direct(try boot(selfChat: false), with: "me"), "sin «Tú» se crea con POST /me/notes")
    }

    func testDirectPeopleDoesNotHideMeUnlessSelfChatIsListed() throws {
        let d = try boot()
        let directs = d.conversations.filter { $0.id == "d1" || $0.id == "d2" }
        XCTAssertEqual(QuickSearch.directPeople(d, directs), ["bob", "yoli"], "estar en todos los directos no me esconde")
        XCTAssertEqual(QuickSearch.directPeople(d, d.conversations.filter { $0.id == "tu" }), ["me"])
    }

    func testChatSearchFindsTuWithMyNameAndSelfWords() throws {
        let d = try boot()
        XCTAssertEqual(Naming.dms(d, query: "danny").map(\.id), ["tu"], "mi nombre solo encuentra «Tú» (estoy en todos)")
        XCTAssertEqual(Naming.dms(d, query: "notas").map(\.id), ["tu"])
        XCTAssertTrue(Naming.dms(d, query: "yo").contains { $0.id == "tu" })
        XCTAssertTrue(Naming.dms(d, query: "yo").contains { $0.id == "d2" }, "Yolanda también")
        XCTAssertEqual(Set(Naming.dms(d, query: "bob").map(\.id)), ["d1", "m1"])
        // En la búsqueda rápida, «Tú» ya está entre los chats: yo no salgo otra vez en Personas.
        let r = QuickSearch.run(d, query: "danny")
        XCTAssertEqual(r.chats.map(\.id), ["tu"])
        let people = QuickSearch.people(d, query: "danny", exclude: QuickSearch.directPeople(d, r.chats))
        XCTAssertTrue(people.isEmpty)
    }

    func testNewMessageListsMeFirstInMyTeam() throws {
        let d = try boot()
        let all = Naming.peopleByOrg(d, query: "", includeMe: true)
        XCTAssertEqual(all.first?.isMine, true)
        XCTAssertEqual(all.first?.people.map(\.id), ["me", "yoli"], "yo primero en mi equipo")
        XCTAssertEqual(Naming.peopleByOrg(d, query: "notas", includeMe: true).flatMap(\.people).map(\.id), ["me"])
        XCTAssertEqual(Naming.peopleByOrg(d, query: "danny", includeMe: true).flatMap(\.people).map(\.id), ["me"])
        XCTAssertFalse(Naming.peopleByOrg(d, query: "", includeMe: false).flatMap(\.people).contains { $0.id == "me" },
                       "agregar personas a un grupo sigue sin mí")
        XCTAssertFalse(Naming.peopleByOrg(d, query: "bob", includeMe: true).flatMap(\.people).contains { $0.id == "me" })
    }

    func testComposeWithMeOpensTuOrIgnoresMe() {
        XCTAssertEqual(ComposeRules.action(["me"], me: "me"), .openDirect("me"), "solo yo: «Tú»")
        XCTAssertEqual(ComposeRules.action(["me", "bob"], me: "me"), .openDirect("bob"), "conmigo y otra persona: su directo")
        XCTAssertEqual(ComposeRules.action(["bob", "me", "yoli"], me: "me"), .createChat(["bob", "yoli"]), "no me suma (ya estoy)")
        XCTAssertEqual(ComposeRules.action([], me: "me"), ComposeRules.Action.none)
        XCTAssertEqual(ComposeRules.action(["bob", "yoli"]), .createChat(["bob", "yoli"]), "sin `me`, como antes")
    }

    // MARK: Ficha de una persona en un grupo

    func testSendMessageOnlyForOtherHumansNotBlocked() throws {
        let d = try boot()
        let bob = try XCTUnwrap(Naming.person(d, "bob")), me = try XCTUnwrap(Naming.person(d, "me")), bot = try XCTUnwrap(Naming.person(d, "bot"))
        XCTAssertTrue(PersonCardSheet.canMessage(bob, me: "me", blocked: []))
        XCTAssertFalse(PersonCardSheet.canMessage(bob, me: "me", blocked: ["bob"]), "bloqueada")
        XCTAssertFalse(PersonCardSheet.canMessage(me, me: "me", blocked: []), "yo")
        XCTAssertFalse(PersonCardSheet.canMessage(bot, me: "me", blocked: []), "agente")
        XCTAssertFalse(PersonCardSheet.canMessage(PersonDTO(id: GG.id, name: "gg", kind: "agent"), me: "me", blocked: []), "gg")
    }

    // MARK: CallKit

    func testCallKitOffInChinaAndInUnitTests() {
        XCTAssertFalse(CallKitRules.enabled(region: "CN", unitTests: false), "App Store: sin CallKit en China")
        XCTAssertFalse(CallKitRules.enabled(region: "cn", unitTests: false))
        XCTAssertTrue(CallKitRules.enabled(region: "CO", unitTests: false))
        XCTAssertTrue(CallKitRules.enabled(region: nil, unitTests: false))
        XCTAssertFalse(CallKitRules.enabled(region: "CO", unitTests: true), "las pruebas no tocan el sistema")
        XCTAssertFalse(CallKitRules.enabled(), "en esta corrida (pruebas) está apagado")
    }

    func testCallKitNamesAndReasons() {
        XCTAssertEqual(CallKitRules.handleName("  Bob  "), "Bob")
        XCTAssertEqual(CallKitRules.handleName(""), "chaggu")
        XCTAssertEqual(CallKitRules.handleName(nil), "chaggu")
        XCTAssertEqual(CallKitRules.handleName(String(repeating: "x", count: 200)).count, 80)
        XCTAssertEqual(CallKitRules.endedReason(.failed), .failed)
        XCTAssertEqual(CallKitRules.endedReason(.remote), .remoteEnded)
        XCTAssertNotNil(UIImage(named: "CallKitIcon"), "icono monocromo del proveedor")
        XCTAssertNotNil(Bundle.main.url(forResource: "callkit_silence", withExtension: "wav"), "timbre silencioso en el paquete")
    }

    /// Sin puente (China, pruebas) la llamada funciona como antes: sin UUID de CallKit y colgar no falla.
    func testCallCenterWithoutBridgeKeepsWorking() async throws {
        let center = CallCenter()
        XCTAssertNil(center.systemCalls)
        XCTAssertNil(center.systemCallId)
        center.systemEnded(UUID())
        center.systemMuted(UUID(), true)
        center.systemDidReset()
        await center.hangUp()
        XCTAssertFalse(center.inCall)
    }
}
