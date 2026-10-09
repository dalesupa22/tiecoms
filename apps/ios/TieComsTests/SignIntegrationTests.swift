import UIKit
import XCTest
@testable import TieComs

/// Firmar PDFs de punta a punta contra un API de PRUEBAS local (rama firmar-pdf): crear una firma escrita, ponerla en
/// la página girada 90° (arrastrada desde la 1), firmar, comprobar que el adjunto firmado vuelve con `signing`, que la
/// tinta quedó donde se puso y que aparece en «Documentos que firmé».
/// Entorno: TEST_RUNNER_TC_FIXTURE_SIGN=<json {apiUrl, email, password, conversationId}> (chat con un PDF de 3 páginas).
@MainActor
final class SignIntegrationTests: XCTestCase {
    struct Fixture: Decodable { var apiUrl: String; var email: String; var password: String; var conversationId: String }

    private func fx() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_SIGN"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_SIGN") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("chaggu.com") || f.apiUrl.contains("tiecoms.com"), "nunca contra producción")
        return f
    }

    func testSignRotatedPageEndToEnd() async throws {
        let f = try fx()
        let s = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await s.login(email: f.email, password: f.password)
        try await s.openConversation(f.conversationId)
        let msgs = try XCTUnwrap(s.conversations[f.conversationId]?.messages)
        let original = try XCTUnwrap(msgs.flatMap(\.attachments).first { $0.isPdf && $0.signing == nil && $0.name.hasPrefix("Contrato") }, "PDF sin firmar en el chat")

        // PDF y geometría: 3 páginas, la 3 girada (se ve apaisada).
        let data = try await AttachmentCache.shared.data(original.url, api: s.api)
        let doc = try XCTUnwrap(CGPDFDocument(CGDataProvider(data: data as CFData)!))
        XCTAssertGreaterThanOrEqual(doc.numberOfPages, 3)
        let pages = (1...doc.numberOfPages).map { PdfPageGeometry(doc.page(at: $0)!) }
        XCTAssertEqual(pages[2].rotation % 180, 90, "la página 3 está girada")
        XCTAssertGreaterThan(pages[2].size.width, pages[2].size.height)

        let info = try await s.api.signInfo(original.id)
        XCTAssertFalse(info.encrypted)

        // Firma escrita en cursiva, recortada y transparente.
        let cg = try XCTUnwrap(SignImage.typed("Danny Prueba", script: .vibes, ink: .blue))
        let png = try XCTUnwrap(SignImage.trimmedPNG(cg))
        let sig = try await s.api.createSignature(png: png.png, kind: .signature, source: .typed)
        addTeardownBlock { @MainActor in try? await s.api.deleteSignature(sig.id) }
        XCTAssertEqual(sig.width, png.width)
        let listed = try await s.api.listSignatures()
        XCTAssertTrue(listed.contains { $0.id == sig.id })
        let image = try await AttachmentCache.shared.data(sig.url, api: s.api)
        XCTAssertNotNil(UIImage(data: image), "la imagen guardada se descarga con Bearer")

        // Marcas: firma puesta en la página 1 y arrastrada a la 3; fecha en la 1.
        var board = SignBoard(pages: pages.map(\.size))
        let id = try XCTUnwrap(board.addSignature(sig, page: 1, center: CGPoint(x: 0.5, y: 0.5)))
        board.moveToPage(id, page: 3, x: 0.6, y: 0.2)
        board.addText(.date, SignText.today(), page: 1, center: CGPoint(x: 0.2, y: 0.9), width1: SignText.width1)
        let placed = try XCTUnwrap(board.mark(id))
        XCTAssertEqual(placed.page, 3)

        let cmid = UUID().uuidString.lowercased()
        let body: [String: Any] = ["clientMessageId": cmid, "body": "", "placements": board.placements(), "stamp": true, "certificate": false,
                                   "acceptBreakingSignatures": info.hasDigitalSignature, "timeZone": "America/Bogota"]
        let r = try await s.api.signPdf(original.id, body: body)
        XCTAssertFalse(r.duplicate)
        let signedAtt = try XCTUnwrap(r.attachment)
        XCTAssertNotNil(signedAtt.signing, "el adjunto firmado vuelve con signing")
        XCTAssertEqual(r.message?.conversationId, f.conversationId)
        // Reintento con el mismo clientMessageId: no firma dos veces.
        let again = try await s.api.signPdf(original.id, body: body)
        XCTAssertTrue(again.duplicate)
        XCTAssertEqual(again.attachment?.id, signedAtt.id)

        // La tinta quedó donde se ve la marca en la página girada.
        let signedData = try await AttachmentCache.shared.data(signedAtt.url, api: s.api)
        let signedDoc = try XCTUnwrap(CGPDFDocument(CGDataProvider(data: signedData as CFData)!))
        XCTAssertEqual(signedDoc.numberOfPages, doc.numberOfPages)
        let p3 = try XCTUnwrap(signedDoc.page(at: 3))
        let img = try XCTUnwrap(PdfPageGeometry.render(p3, scale: 1).cgImage)
        let before = try XCTUnwrap(PdfPageGeometry.render(doc.page(at: 3)!, scale: 1).cgImage)
        let inside = CGRect(x: placed.x * Double(img.width), y: placed.y * Double(img.height), width: placed.w * Double(img.width), height: placed.h * Double(img.height))
        let changedInside = changedPixels(before, img, in: inside)
        let outside = CGRect(x: 0, y: Double(img.height) * 0.6, width: Double(img.width) * 0.3, height: Double(img.height) * 0.3)
        XCTAssertGreaterThan(changedInside, 30, "la firma aparece dentro de su caja")
        XCTAssertEqual(changedPixels(before, img, in: outside), 0, "nada cambia lejos de la marca")

        // En el chat llega el firmado y en el historial queda la constancia.
        let signedInfo = try await s.api.signInfo(signedAtt.id)
        XCTAssertNotNil(signedInfo.signing)
        let hist = try await s.api.listSignings(q: AttachmentSigningDTO.ref(signedAtt.signing!.id))
        let row = try XCTUnwrap(hist.signings.first { $0.resultAttachmentId == signedAtt.id }, "aparece en Documentos que firmé")
        XCTAssertEqual(row.signatureMarks, 1)
        XCTAssertEqual(row.pagesMarked, 2)
        XCTAssertEqual(row.pages, doc.numberOfPages)
        XCTAssertEqual(row.conversationId, f.conversationId)
        let first = try await s.api.listSignings(limit: 1)
        XCTAssertEqual(first.signings.count, 1)
        if first.total > 1 {
            let next = try await s.api.listSignings(before: try XCTUnwrap(first.nextBefore), limit: 1)
            XCTAssertNotEqual(next.signings.first?.id, first.signings.first?.id, "paginación con nextBefore")
        }
    }

    private func changedPixels(_ a: CGImage, _ b: CGImage, in r: CGRect) -> Int {
        guard let x = SignImage.bitmap(a), let y = SignImage.bitmap(b), x.width == y.width, x.height == y.height else { return -1 }
        var n = 0
        let rr = r.integral.intersection(CGRect(x: 0, y: 0, width: x.width, height: x.height))
        guard !rr.isNull else { return 0 }
        for py in Int(rr.minY)..<Int(rr.maxY) {
            for px in Int(rr.minX)..<Int(rr.maxX) {
                let i = (py * x.width + px) * 4
                let d = abs(Int(x.data[i]) - Int(y.data[i])) + abs(Int(x.data[i + 1]) - Int(y.data[i + 1])) + abs(Int(x.data[i + 2]) - Int(y.data[i + 2]))
                if d > 60 { n += 1 }
            }
        }
        return n
    }
}
