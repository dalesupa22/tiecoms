import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.6 · Asuntos personales: `IssueDTO.conversationId` puede llegar null (contrato 2026-09-28).
@MainActor
final class PersonalIssueTests: XCTestCase {
    private func issue(_ id: String, conv: String?, parent: String? = nil, owner: String = "me") throws -> IssueDTO {
        let c = conv.map { "\"\($0)\"" } ?? "null"
        let p = parent.map { "\"\($0)\"" } ?? "null"
        return try dec(IssueDTO.self, #"{"id":"\#(id)","workspaceId":null,"conversationId":\#(c),"parentIssueId":\#(p),"title":"T \#(id)","status":"open","ownerId":"\#(owner)","createdBy":"me","visibility":"\#(conv == nil ? "private" : "all")","viewerIds":["me"]}"#)
    }

    func testContractAndNullConversationDecode() throws {
        XCTAssertEqual(Contract.version, "2026-09-28", "GET /issues solo manda personales con contrato ≥ 2026-09-28")
        let p = try issue("p", conv: nil)
        XCTAssertNil(p.conversationId)
        XCTAssertTrue(p.isPersonal)
        XCTAssertFalse(try issue("s", conv: "c1").isPersonal)
        let empty = try dec(IssueDTO.self, #"{"id":"e","conversationId":"","title":"x"}"#)
        XCTAssertNil(empty.conversationId, "vacío = sin conversación")
    }

    func testPersonalAccountEvent() throws {
        let e = try dec(AccountEvent.self, #"{"type":"issue.personal","issue":{"id":"p1","conversationId":null,"title":"Mío","status":"open","createdBy":"me","visibility":"private"}}"#)
        guard case .issuePersonal(let i) = e else { return XCTFail("\(e)") }
        XCTAssertEqual(i.id, "p1"); XCTAssertTrue(i.isPersonal)
        let s = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        let d = try dec(BootstrapDTO.self, #"{"me":{"id":"me","name":"A","kind":"human"},"organizations":[],"workspaces":[],"people":[],"conversations":[{"id":"c1","kind":"group","openIssues":1}]}"#)
        s.seedForTesting(d)
        s.socketEventForTesting("account.event", #"{"type":"issue.personal","issue":{"id":"p1","conversationId":null,"title":"Mío","status":"open","ownerId":"me","createdBy":"me","visibility":"private"}}"#)
        XCTAssertEqual(s.issues["p1"]?.title, "Mío", "llega a mi cuenta y entra en la lista")
        XCTAssertEqual(s.meta("c1")?.openIssues, 1, "no cuenta en los chips de ninguna conversación")
        XCTAssertEqual(s.myOpenIssues, 1, "sí cuenta en «Míos»")
    }

    func testByGroupPutsPersonalSectionFirstAndNothingElseBreaks() throws {
        let p = try issue("p", conv: nil), a = try issue("a", conv: "c1"), b = try issue("b", conv: "c1")
        let all = Dictionary(uniqueKeysWithValues: [p, a, b].map { ($0.id, $0) })
        let s = IssueTree.sections([a, b, p], by: .group, me: "me", groupKey: { IssueTasks.groupConversation($0, all) }) { $0 }
        XCTAssertEqual(s.map(\.id), [IssueTasks.personalKey, "c1"], "«Personal · solo tú» primero aunque tenga menos")
        XCTAssertEqual(HomeView.openByConversation(all).keys.sorted(), ["c1"], "no va bajo ningún grupo")
        XCTAssertTrue(ChatAgendaItem.build(conversationId: "c1", events: [], issues: [p], reminders: []).isEmpty)
        XCTAssertEqual(IssueTasks.listed(in: "c1", all).map(\.id).sorted(), ["a", "b"])
        XCTAssertTrue(IssueTree.group(try dec(BootstrapDTO.self, #"{"me":{"id":"me","name":"A","kind":"human"},"organizations":[],"workspaces":[],"people":[],"conversations":[]}"#), [p]).isEmpty)
    }
}
