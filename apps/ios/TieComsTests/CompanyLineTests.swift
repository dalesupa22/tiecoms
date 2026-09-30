import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// Empresa en gris bajo el nombre (1.7.1, web quick-search.ts companyOf): chats de varias personas y sidechats.
@MainActor
final class CompanyLineTests: XCTestCase {
    func testMultiChatCompaniesOthersFirstPlusN() throws {
        let d = try dec(BootstrapDTO.self, #"""
        {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","primaryOrgId":"x"},
         "organizations":[{"id":"x","name":"Xertify"},{"id":"u","name":"Uniandes"},{"id":"r","name":"Rosario"},{"id":"j","name":"Javeriana"}],
         "people":[{"id":"me","name":"Ana","orgId":"x"},{"id":"b","name":"Bruno","orgId":"u"},{"id":"c","name":"Carla","orgId":"u"},{"id":"e","name":"Eva","orgId":"r"},{"id":"g","name":"Gil","orgId":"j"}],
         "conversations":[
          {"id":"m2","kind":"multi","memberIds":["me","b","c"]},
          {"id":"m4","kind":"multi","memberIds":["me","b","e","g"]},
          {"id":"mine","kind":"multi","memberIds":["me"]},
          {"id":"side","kind":"multi","memberIds":["me","b"],"deriveKind":"side","parentId":"m2"}]}
        """#)
        let c = Dictionary(uniqueKeysWithValues: d.conversations.map { ($0.id, $0) })
        XCTAssertEqual(Naming.companyLine(d, c["m2"]!, title: "Comité"), "Uniandes · Xertify", "primero las de los demás, sin repetir")
        XCTAssertEqual(Naming.companyLine(d, c["m4"]!, title: "Comité"), "Uniandes · Rosario +2", "más de dos: «+N»")
        XCTAssertEqual(Naming.companyLine(d, c["mine"]!, title: "Notas"), "Xertify")
        XCTAssertNil(Naming.companyLine(d, c["side"]!, title: "Sidechat"), "los sidechats no llevan empresa")
    }
}
