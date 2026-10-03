import XCTest
@testable import TieComs

/// 1.7.15: extensión Compartir con pantalla de acciones, selector plano y traspaso a la app (App Group).
final class Share1715Tests: XCTestCase {
    private func t(_ id: String, _ title: String, kind: String, group: String? = nil, sub: String = "", at: String, side: Bool = false) -> ShareTargets.Target {
        ShareTargets.Target(id: id, title: title, subtitle: sub, group: group, kind: kind, lastMessageAt: at, isSide: side)
    }

    func testPickerListsFlatWithRecentsChatsAndGroups() {
        let list = [t("g1", "La Mafia", kind: "group", group: "La Mafia · La Mafia", at: "2026-10-01"),
                    t("d1", "Bruno", kind: "direct", sub: "Xertify", at: "2026-10-03"),
                    t("m1", "Ana, Bruno", kind: "multi", at: "2026-09-01"),
                    t("g2", "Ventas", kind: "group", group: "Xertify · Nestle", at: "2026-10-02"),
                    t("s1", "¿Precio?", kind: "group", at: "2026-08-01", side: true)]
        let l = SharePicker.lists(list, query: "", suggested: "m1", recentCount: 3)
        XCTAssertEqual(l.recents.map(\.id), ["m1", "d1", "g2"], "sugerida primero y luego por actividad")
        XCTAssertEqual(l.chats.map(\.id), ["d1", "m1"])
        XCTAssertEqual(l.groups.map(\.id), ["g2", "g1", "s1"])
        XCTAssertEqual(SharePicker.subtitle(list[0]), "", "sin «La Mafia · La Mafia» ni repetir el nombre")
        XCTAssertEqual(SharePicker.subtitle(list[3]), "Xertify · Nestle")
        let q = SharePicker.lists(list, query: "nestle", suggested: nil)
        XCTAssertTrue(q.recents.isEmpty, "al buscar no hay recientes")
        XCTAssertEqual(q.groups.map(\.id), ["g2"], "busca también en el subtítulo")
    }

    func testActionsDependOnWhatIsShared() {
        let pdf = SharedItem(kind: .file, name: "contrato.pdf", contentType: "application/pdf", data: Data([1]))
        let img = SharedItem(kind: .image, name: "a.jpg", contentType: "image/jpeg", data: Data([1]))
        XCTAssertEqual(ShareActionsRule.available(attachments: [pdf], hasText: false), [.send, .sign, .analyze, .task, .save])
        XCTAssertEqual(ShareActionsRule.available(attachments: [img], hasText: false), [.send, .analyze, .task, .save], "firmar solo PDF")
        XCTAssertEqual(ShareActionsRule.available(attachments: [pdf, img], hasText: false), [.send, .analyze, .task, .save], "firmar con un solo PDF")
        XCTAssertEqual(ShareActionsRule.available(attachments: [], hasText: true), [.send, .task])
        XCTAssertEqual(L(ShareActionsRule.analyzePrompt), "Analiza este archivo: resumen, puntos clave, fechas, montos y qué debo hacer")
    }

    func testHandoffSaveLoadPendingAndConsume() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: base) }
        let f = LocalAttachment(name: "Contrato Nestlé.pdf", contentType: "application/pdf", data: Data("pdf".utf8))
        let now = Date()
        let id = try ShareHandoffStore.save(.task, files: [f], text: "Revisar", base: base, now: now)
        let (h, files) = try XCTUnwrap(ShareHandoffStore.load(id, base: base))
        XCTAssertEqual(h.action, .task)
        XCTAssertEqual(h.text, "Revisar")
        XCTAssertEqual(files.map(\.name), ["Contrato Nestlé.pdf"])
        XCTAssertEqual(files.first?.data, Data("pdf".utf8))
        XCTAssertEqual(ShareHandoffStore.latestPending(base: base, now: now.addingTimeInterval(60)), id)
        XCTAssertNil(ShareHandoffStore.latestPending(base: base, now: now.addingTimeInterval(20 * 60)), "vencido a los 15 min (y se borra)")
        XCTAssertNil(ShareHandoffStore.load(id, base: base))
        let id2 = try ShareHandoffStore.save(.task, files: [], base: base)
        ShareHandoffStore.consume(id2, base: base)
        XCTAssertNil(ShareHandoffStore.load(id2, base: base))
        XCTAssertNil(ShareHandoffStore.load("../../etc", base: base), "ids raros no salen del directorio")
        XCTAssertEqual(ShareTaskRequest(id: "x", files: [f], text: nil).title, "Contrato Nestlé")
    }

    func testHandoffDeepLinkOnlyWithOwnScheme() {
        XCTAssertEqual(DeepLink.parse(URL(string: "chaggu://handoff/0f8a-12")!), .handoff("0f8a-12"))
        XCTAssertNil(DeepLink.parse(URL(string: "https://chaggu.com/handoff/0f8a")!), "no desde la web")
    }

    /// Bug «cracks»: una descarga trabada ya no deja la ruedita para siempre (tope de tiempo y reintento).
    func testDownloadTimeoutEndsAStuckLoad() async {
        let start = Date()
        do {
            _ = try await AttachmentCache.withTimeout(0.3) { try await Task.sleep(nanoseconds: 5_000_000_000); return Data() }
            XCTFail("debía agotar el tiempo")
        } catch let e as ApiRequestError {
            XCTAssertEqual(e.code, "timeout")
        } catch { XCTFail("\(error)") }
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
        let ok = try? await AttachmentCache.withTimeout(2) { Data([1, 2]) }
        XCTAssertEqual(ok, Data([1, 2]))
        XCTAssertLessThanOrEqual(AttachmentCache.timeout, AttachmentCache.staleAfter, "no se espera una descarga más vieja que el tope")
    }
}
