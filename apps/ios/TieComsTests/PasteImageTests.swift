import XCTest
import UIKit
import UniformTypeIdentifiers
@testable import TieComs

/// 1.7.1: pegar imágenes del portapapeles en el compositor (menú «Pegar» o ⌘V). Cada prueba usa un portapapeles propio.
@MainActor
final class PasteImageTests: XCTestCase {
    private var pb: UIPasteboard!

    override func setUp() {
        pb = UIPasteboard(name: UIPasteboard.Name("tc-paste-\(UUID().uuidString)"), create: true)
    }
    override func tearDown() {
        if let pb { UIPasteboard.remove(withName: pb.name) }
    }

    private func image(_ w: CGFloat = 40, _ h: CGFloat = 30, color: UIColor = .systemTeal) -> UIImage {
        let f = UIGraphicsImageRendererFormat(); f.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: f).image { ctx in
            color.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        }
    }

    private func view(_ onPaste: (([LocalAttachment]) -> Void)?) -> PastingTextView {
        let v = PastingTextView()
        v.pasteboard = pb
        v.onPasteAttachments = onPaste
        return v
    }

    /// Espera a que llegue el callback (se prepara fuera del hilo principal).
    private func pasted(_ v: PastingTextView, timeout: TimeInterval = 5) -> [LocalAttachment]? {
        var got: [LocalAttachment]?
        let e = expectation(description: "pegado")
        let old = v.onPasteAttachments
        v.onPasteAttachments = { list in got = list; old?(list); e.fulfill() }
        v.paste(nil)
        wait(for: [e], timeout: timeout)
        return got
    }

    func testPngOnPasteboardBecomesOnePngAttachment() throws {
        let png = try XCTUnwrap(image().pngData())
        pb.setData(png, forPasteboardType: UTType.png.identifier)
        XCTAssertTrue(PasteImages.hasImages(pb))
        let raw = PasteImages.raw(pb)
        XCTAssertEqual(raw.count, 1)
        let list = PasteImages.prepare(raw)
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list.first?.name, "pegada-1.png")
        XCTAssertEqual(list.first?.contentType, "image/png")
        XCTAssertEqual(list.first?.data, png, "una imagen pequeña se adjunta tal cual")
    }

    func testJpegHeicAndGifKeepTheirType() throws {
        let img = image(60, 60)
        pb.items = [[UTType.jpeg.identifier: try XCTUnwrap(img.jpegData(compressionQuality: 0.8))]]
        XCTAssertEqual(PasteImages.prepare(PasteImages.raw(pb)).first?.contentType, "image/jpeg")
        // GIF: se respeta (animado) sin recomprimir.
        let gif = Data([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x2c,
                        0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b])
        pb.items = [[UTType.gif.identifier: gif]]
        let g = PasteImages.prepare(PasteImages.raw(pb))
        XCTAssertEqual(g.first?.contentType, "image/gif")
        XCTAssertEqual(g.first?.name, "pegada-1.gif")
    }

    func testBigImageIsReducedToJpeg() throws {
        // 4000×3000: pasa por ImagePrep (lado máximo y peso) como una foto de Fotos.
        let big = image(4000, 3000)
        pb.setData(try XCTUnwrap(big.pngData()), forPasteboardType: UTType.png.identifier)
        let a = try XCTUnwrap(PasteImages.prepare(PasteImages.raw(pb)).first)
        XCTAssertEqual(a.contentType, "image/jpeg")
        let out = try XCTUnwrap(UIImage(data: a.data))
        XCTAssertLessThanOrEqual(max(out.size.width, out.size.height), ImagePrep.maxSide + 1)
    }

    func testSeveralImagesAreCappedAtMaxPerMessage() throws {
        let png = try XCTUnwrap(image().pngData())
        pb.items = Array(repeating: [UTType.png.identifier: png], count: AttachmentRules.maxPerMessage + 3)
        XCTAssertEqual(PasteImages.raw(pb).count, AttachmentRules.maxPerMessage)
        XCTAssertEqual(PasteImages.prepare(PasteImages.raw(pb)).map(\.name).last, "pegada-\(AttachmentRules.maxPerMessage).png")
    }

    func testTextOnlyPastesTextAndNoAttachment() {
        pb.string = "hola desde el portapapeles"
        XCTAssertFalse(PasteImages.hasImages(pb), "solo texto: lo pega el sistema (no se llama al paste del sistema aquí: pediría permiso)")
        XCTAssertTrue(PasteImages.hasPlainText(pb))
        XCTAssertTrue(PasteImages.raw(pb).isEmpty)
    }

    func testPasteMenuOffersPasteWhenThereIsAnImage() throws {
        pb.setData(try XCTUnwrap(image().pngData()), forPasteboardType: UTType.png.identifier)
        let v = view { _ in }
        XCTAssertTrue(v.canPerformAction(#selector(UIResponder.paste(_:)), withSender: nil), "«Pegar» aparece con una imagen")
    }

    func testPastingAnImageAttachesItAndDoesNotInsertText() throws {
        pb.setData(try XCTUnwrap(image().pngData()), forPasteboardType: UTType.png.identifier)
        let v = view { _ in }
        let list = try XCTUnwrap(pasted(v))
        XCTAssertEqual(list.count, 1)
        XCTAssertTrue(list[0].isImage)
        XCTAssertEqual(v.text, "", "la imagen no se pega como texto")
    }

    func testImageLinkFromSafariIsNotPastedAsText() throws {
        pb.items = [[UTType.png.identifier: try XCTUnwrap(image().pngData()), UTType.utf8PlainText.identifier: "https://example.com/foto.png"]]
        XCTAssertTrue(PasteImages.hasImages(pb))
        XCTAssertFalse(PasteImages.hasPlainText(pb), "el enlace de la imagen no vale como texto")
        pb.items = [[UTType.png.identifier: try XCTUnwrap(image().pngData()), UTType.utf8PlainText.identifier: "mira esta foto"]]
        XCTAssertTrue(PasteImages.hasPlainText(pb), "un texto de verdad sí se pega además de la imagen")
    }
}
