import XCTest
@testable import TieComs

/// Búsqueda rápida (personas, grupos y chats), «Recientes» de Mensaje nuevo y destinos de «＋ Nuevo asunto».
final class QuickSearchTests: XCTestCase {
    private func boot() throws -> BootstrapDTO {
        try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"""
        {"contract":"2026-09-25","serverTime":"","me":{"id":"me","name":"Ana Ruiz","kind":"human","primaryOrgId":"oA"},
         "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"},{"id":"oB","name":"Ongoing"},{"id":"oC","name":"Acme"}],
         "workspaces":[
           {"id":"wHome","name":"Xertify","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me","col"],"myRole":"member","isOrgHome":true,"createdAt":"2026-09-01"},
           {"id":"wRel","name":"Mentorías","owningOrgId":"oB","organizationIds":["oB","oA"],"memberIds":["me","bob","mar"],"myRole":"member","createdAt":"2026-09-01"},
           {"id":"wGuest","name":"Programa","owningOrgId":"oC","organizationIds":["oC"],"memberIds":["me"],"myRole":"guest","createdAt":"2026-09-01"}],
         "conversations":[
           {"id":"g1","workspaceId":"wHome","kind":"group","name":"Pagos","memberIds":["me","col"],"lastMessageAt":"2026-09-25T10:00:00Z"},
           {"id":"r1","workspaceId":"wRel","kind":"group","name":"Mentoría 1","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T09:00:00Z"},
           {"id":"th","workspaceId":"wRel","kind":"group","name":"Hilo · Pagos","parentId":"r1","deriveKind":"same","memberIds":["me","bob"]},
           {"id":"x1","workspaceId":"wGuest","kind":"group","name":"Cohorte","memberIds":["me"]},
           {"id":"ro","workspaceId":"wHome","kind":"group","name":"Anuncios","memberIds":["me"],"canPost":false},
           {"id":"d1","kind":"direct","memberIds":["me","bob"],"lastMessageAt":"2026-09-20T11:00:00Z"},
           {"id":"d2","kind":"direct","memberIds":["me","col"],"lastMessageAt":"2026-09-26T11:00:00Z"},
           {"id":"m1","kind":"multi","name":"Café","memberIds":["me","bob","col"],"lastMessageAt":"2026-09-21T11:00:00Z"}],
         "people":[{"id":"me","name":"Ana Ruiz","kind":"human","orgId":"oA"},{"id":"col","name":"Carla Pérez","kind":"human","orgId":"oA","title":"Pagos"},
                   {"id":"bob","name":"Bob","kind":"human","orgId":"oB"},{"id":"mar","name":"Mariana","kind":"human","orgId":"oB"},
                   {"id":"ana2","name":"Ánalía","kind":"human","orgId":"oB"},{"id":"bot","name":"Asistente","kind":"agent","orgId":"oA"}]}
        """#.utf8))
    }

    func testPeopleIncludeThoseWithoutDirectAndSkipMeAndAgents() throws {
        let d = try boot()
        XCTAssertEqual(QuickSearch.people(d, query: "mariana").map(\.id), ["mar"], "sin directo también sale")
        XCTAssertTrue(QuickSearch.people(d, query: "ana").allSatisfy { $0.id != "me" }, "nunca yo")
        XCTAssertTrue(QuickSearch.people(d, query: "asist").isEmpty, "los agentes no son personas a las que escribir")
        XCTAssertTrue(QuickSearch.people(d, query: " ").isEmpty, "sin texto, nada")
    }

    func testPeopleMatchCompanyAndRoleAndOrderPrefixFirst() throws {
        let d = try boot()
        // «ana»: Ánalía empieza con lo escrito (sin tildes) y va antes que Mariana, que solo lo contiene.
        XCTAssertEqual(QuickSearch.people(d, query: "ana").map(\.id), ["ana2", "mar"])
        XCTAssertEqual(Set(QuickSearch.people(d, query: "ongoing").map(\.id)), ["bob", "mar", "ana2"], "por empresa")
        XCTAssertEqual(QuickSearch.people(d, query: "pagos").map(\.id), ["col"], "por cargo")
        XCTAssertEqual(QuickSearch.people(d, query: "ongoing", exclude: ["bob"]).count, 2)
    }

    func testGroupsByNameOrCompanyWithoutThreads() throws {
        let d = try boot()
        XCTAssertEqual(QuickSearch.groups(d, query: "pagos").map(\.id), ["g1"], "el hilo «Hilo · Pagos» no es un grupo")
        XCTAssertEqual(QuickSearch.groups(d, query: "ongoing").map(\.id), ["r1"], "por la empresa de la otra parte")
        XCTAssertTrue(QuickSearch.groups(d, query: "café").isEmpty, "los chats no son grupos")
        XCTAssertEqual(QuickSearch.run(d, query: "café").chats.map(\.id), ["m1"])
    }

    func testDirectAndRecentPeople() throws {
        let d = try boot()
        XCTAssertEqual(QuickSearch.direct(d, with: "bob")?.id, "d1")
        XCTAssertNil(QuickSearch.direct(d, with: "mar"))
        XCTAssertEqual(QuickSearch.recentPeopleIds(d), ["col", "bob"], "el directo más reciente primero")
    }

    func testIssueDestinationsSkipGuestReadOnlyAndThreads() throws {
        let d = try boot()
        let ids = NewIssueSheet.destinations(d).map(\.id)
        XCTAssertFalse(ids.contains("x1"), "un tercero no crea asuntos")
        XCTAssertFalse(ids.contains("ro"), "sin permiso de escribir")
        XCTAssertFalse(ids.contains("th"), "los hilos no")
        XCTAssertEqual(ids.first, "d2", "el de actividad más reciente primero (también directos)")
        XCTAssertEqual(NewIssueSheet.label(d, d.conversations.first { $0.id == "r1" }!), "Mentoría 1 · Ongoing")
    }
}
