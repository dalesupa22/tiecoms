import XCTest
@testable import TieComs

/// Orden de los temas (docs/TEMAS.md): por defecto el de llegada (position); arrastrar reordena para todo el chat
/// con PUT /conversations/:id/topics/order { ids } (dropOn y reorderTopics de la web).
@MainActor
final class TopicOrderTests: XCTestCase {
    private func t(_ id: String, _ name: String, pos: Int, archived: Bool = false) -> TopicDTO {
        var x = TopicDTO(id: id, conversationId: "c1", name: name)
        x.position = pos
        x.createdAt = "2026-09-0\(pos + 1)T00:00:00Z"
        if archived { x.archivedAt = "2026-09-20" }
        return x
    }

    func testDefaultIsArrivalOrderNotAlphabetical() {
        let list = [t("v", "Ventas", pos: 1), t("n", "2600", pos: 2), t("p", "Producto", pos: 0), t("a", "Archivo", pos: 3, archived: true)]
        XCTAssertEqual(TopicRules.active(list).map(\.name), ["Producto", "Ventas", "2600"], "orden de llegada, sin archivados")
    }

    func testReorderForwardAndBackward() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(TopicRules.reorder(ids, moving: "a", onto: "c"), ["b", "c", "a", "d"], "hacia adelante: queda después del destino")
        XCTAssertEqual(TopicRules.reorder(ids, moving: "d", onto: "b"), ["a", "d", "b", "c"], "hacia atrás: queda antes del destino")
        XCTAssertEqual(TopicRules.reorder(ids, moving: "a", onto: "d"), ["b", "c", "d", "a"], "al final")
        XCTAssertEqual(TopicRules.reorder(ids, moving: "c", onto: "a"), ["c", "a", "b", "d"], "al principio")
        XCTAssertNil(TopicRules.reorder(ids, moving: "b", onto: "b"), "sobre sí misma: nada")
        XCTAssertNil(TopicRules.reorder(ids, moving: "x", onto: "b"), "no está")
        XCTAssertEqual(TopicRules.step(ids, "b", by: -1), ["b", "a", "c", "d"])
        XCTAssertEqual(TopicRules.step(ids, "b", by: 1), ["a", "c", "b", "d"])
        XCTAssertNil(TopicRules.step(ids, "a", by: -1), "ya es la primera")
        XCTAssertNil(TopicRules.step(ids, "d", by: 1), "ya es la última")
        let list = [t("a", "A", pos: 0), t("b", "B", pos: 1), t("z", "Z", pos: 2, archived: true), t("c", "C", pos: 3)]
        XCTAssertEqual(TopicRules.applyOrder(list, ["c", "a", "b"]).filter { !$0.isArchived }.map(\.id), ["c", "a", "b"])
    }

    func testReorderContractOptimisticAndRollback() async throws {
        let s = try ControlledURLProtocol.store()
        s.topics["c1"] = [t("a", "A", pos: 0), t("b", "B", pos: 1), t("c", "C", pos: 2)]
        var method = "", path = "", body: [String: Any] = [:]
        var fail = false
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            method = req.request.httpMethod ?? ""; path = req.request.url!.path; body = req.json
            // Mientras responde, la fila ya se ve con el orden nuevo.
            XCTAssertEqual(TopicRules.active(s.topics["c1"] ?? []).map(\.id), ["c", "a", "b"], "optimista")
            if fail { req.respond(403, #"{"error":{"code":"forbidden","message":"No puedes escribir en este chat"}}"#); return }
            req.respond(#"{"topics":[{"id":"c","conversationId":"c1","name":"C","position":0},{"id":"a","conversationId":"c1","name":"A","position":1},{"id":"b","conversationId":"c1","name":"B","position":2}]}"#)
        } }
        try await s.reorderTopics("c1", ids: ["c", "a", "b"])
        XCTAssertEqual(method, "PUT"); XCTAssertEqual(path, "/api/v1/conversations/c1/topics/order")
        XCTAssertEqual(body["ids"] as? [String], ["c", "a", "b"])
        XCTAssertEqual(TopicRules.active(s.topics["c1"] ?? []).map(\.id), ["c", "a", "b"], "lo que responde el servidor")

        s.topics["c1"] = [t("a", "A", pos: 0), t("b", "B", pos: 1), t("c", "C", pos: 2)]
        fail = true
        do { try await s.reorderTopics("c1", ids: ["c", "a", "b"]); XCTFail("debió fallar") }
        catch let e as ApiRequestError { XCTAssertEqual(e.status, 403) }
        XCTAssertEqual(TopicRules.active(s.topics["c1"] ?? []).map(\.id), ["a", "b", "c"], "si falla vuelve el orden anterior")
    }
}
