import PDFKit
import UIKit
import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// Firmar PDFs: geometría (vista ↔ proporciones ↔ PDF, páginas giradas), tablero de marcas, imagen y contrato.
final class SignTests: XCTestCase {
    // MARK: Geometría

    func testDisplaySizeSwapsOnQuarterTurns() {
        let box = SignGeometry.Box(x: 0, y: 0, width: 612, height: 792)
        XCTAssertEqual(SignGeometry.displaySize(box, rotation: 0), CGSize(width: 612, height: 792))
        XCTAssertEqual(SignGeometry.displaySize(box, rotation: 90), CGSize(width: 792, height: 612))
        XCTAssertEqual(SignGeometry.displaySize(box, rotation: 180), CGSize(width: 612, height: 792))
        XCTAssertEqual(SignGeometry.displaySize(box, rotation: 270), CGSize(width: 792, height: 612))
        XCTAssertEqual(SignGeometry.normRotation(-90), 270)
        XCTAssertEqual(SignGeometry.normRotation(450), 90)
        XCTAssertEqual(SignGeometry.normRotation(360), 0)
    }

    /// Igual que el servidor: las esquinas de la página vista caen en las esquinas correctas del PDF.
    func testDisplayToPdfMatchesServer() {
        let box = SignGeometry.Box(x: 10, y: 20, width: 600, height: 800)
        // Sin girar: arriba a la izquierda de la vista = (x, y + H) del PDF.
        XCTAssertEqual(SignGeometry.displayToPdf(box, rotation: 0, 0, 0), CGPoint(x: 10, y: 820))
        // 90°: la vista mide 800 × 600; su esquina superior izquierda es la inferior izquierda del PDF.
        XCTAssertEqual(SignGeometry.displayToPdf(box, rotation: 90, 0, 0), CGPoint(x: 10, y: 20))
        XCTAssertEqual(SignGeometry.displayToPdf(box, rotation: 90, 800, 600), CGPoint(x: 610, y: 820))
        XCTAssertEqual(SignGeometry.displayToPdf(box, rotation: 180, 0, 0), CGPoint(x: 610, y: 20))
        XCTAssertEqual(SignGeometry.displayToPdf(box, rotation: 270, 0, 0), CGPoint(x: 610, y: 820))
    }

    /// La transformación con la que se dibuja la página es la inversa exacta de la del servidor.
    func testPdfToDisplayIsInverseOfServerMapping() {
        let box = SignGeometry.Box(x: 10, y: 20, width: 600, height: 800)
        for rot in [0, 90, 180, 270] {
            let t = SignGeometry.pdfToDisplay(box, rotation: rot)
            let size = SignGeometry.displaySize(box, rotation: rot)
            for (dx, dy) in [(0.0, 0.0), (size.width, 0), (0, size.height), (123.5, 45.25), (size.width, size.height)] {
                let pdf = SignGeometry.displayToPdf(box, rotation: rot, dx, dy)
                let back = pdf.applying(t)
                XCTAssertEqual(back.x, dx, accuracy: 1e-9, "rot \(rot)")
                XCTAssertEqual(back.y, dy, accuracy: 1e-9, "rot \(rot)")
            }
        }
    }

    func testViewPointToPageProportion() {
        // Página dibujada en (12, 500) con 351 × 454 pt de pantalla.
        let frame = CGRect(x: 12, y: 500, width: 351, height: 454)
        let p = SignGeometry.proportion(CGPoint(x: 12 + 351 * 0.25, y: 500 + 454 * 0.8), in: frame)
        XCTAssertEqual(p.x, 0.25, accuracy: 1e-9)
        XCTAssertEqual(p.y, 0.8, accuracy: 1e-9)
    }

    /// Un PDF de 200 × 100 con un cuadro negro, girado 90°: al dibujarlo, el cuadro aparece donde el servidor
    /// estamparía una marca con esas proporciones.
    func testRenderedRotatedPageMatchesProportions() throws {
        let pdfData = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 100)).pdfData { ctx in
            ctx.beginPage()
            UIColor.black.setFill()
            // UIKit: arriba a la izquierda. En el PDF queda en x 20…40, y 70…90 (centro 30, 80).
            UIRectFill(CGRect(x: 20, y: 10, width: 20, height: 20))
        }
        let pdf = try XCTUnwrap(PDFDocument(data: pdfData))
        pdf.page(at: 0)?.rotation = 90
        let rotated = try XCTUnwrap(pdf.dataRepresentation())
        let doc = try XCTUnwrap(CGPDFDocument(CGDataProvider(data: rotated as CFData)!))
        let page = try XCTUnwrap(doc.page(at: 1))
        let g = PdfPageGeometry(page)
        XCTAssertEqual(g.rotation, 90)
        XCTAssertEqual(g.size, CGSize(width: 100, height: 200))

        let img = try XCTUnwrap(PdfPageGeometry.render(page, scale: 2).cgImage)
        XCTAssertEqual(img.width, 200)
        XCTAssertEqual(img.height, 400)
        let bmp = try XCTUnwrap(SignImage.bitmap(img))
        func luma(_ px: CGPoint) -> Int {
            let i = (Int(px.y) * bmp.width + Int(px.x)) * 4
            return (Int(bmp.data[i]) + Int(bmp.data[i + 1]) + Int(bmp.data[i + 2])) / 3
        }
        // Centro del cuadro en la vista, según la fórmula del servidor invertida: (80, 30) de 100 × 200.
        let center = CGPoint(x: 30, y: 80).applying(SignGeometry.pdfToDisplay(g.box, rotation: 90))
        XCTAssertEqual(center.x, 80, accuracy: 1e-9)
        XCTAssertEqual(center.y, 30, accuracy: 1e-9)
        let prop = CGPoint(x: center.x / g.size.width, y: center.y / g.size.height)
        XCTAssertLessThan(luma(CGPoint(x: prop.x * 200, y: prop.y * 400)), 40, "el cuadro debe verse donde se estampa")
        XCTAssertGreaterThan(luma(CGPoint(x: 30 * 2, y: 80 * 2)), 220, "sin girar estaría aquí: debe estar en blanco")
        // Y de vuelta: una marca en esas proporciones cae sobre el cuadro en el PDF.
        let back = SignGeometry.displayToPdf(g.box, rotation: 90, prop.x * g.size.width, prop.y * g.size.height)
        XCTAssertEqual(back.x, 30, accuracy: 1e-6)
        XCTAssertEqual(back.y, 80, accuracy: 1e-6)
    }

    // MARK: Tablero de marcas

    private let letter = CGSize(width: 612, height: 792)
    private let landscape = CGSize(width: 792, height: 612)
    private func sig(_ kind: SignatureDTO.Kind = .signature, _ w: Int = 1000, _ h: Int = 400) -> SignatureDTO {
        SignatureDTO(id: UUID().uuidString, kind: kind, width: w, height: h)
    }

    func testDefaultSizes() {
        let (w, h) = SignBoard.defaultSize(kind: .signature, imageW: 1000, imageH: 400, page: letter)
        XCTAssertEqual(w * 612, 170, accuracy: 1e-6)
        XCTAssertEqual(h * 792, 68, accuracy: 1e-6)
        // Muy alta: el alto se limita a 70 pt y el ancho baja en proporción.
        let (w2, h2) = SignBoard.defaultSize(kind: .signature, imageW: 400, imageH: 400, page: letter)
        XCTAssertEqual(h2 * 792, 70, accuracy: 1e-6)
        XCTAssertEqual(w2 * 612, 70, accuracy: 1e-6)
        let (w3, h3) = SignBoard.defaultSize(kind: .initials, imageW: 600, imageH: 600, page: letter)
        XCTAssertEqual(w3 * 612, 50, accuracy: 1e-6)
        XCTAssertEqual(h3 * 792, 50, accuracy: 1e-6)
    }

    func testAddSignatureCentersAndClamps() throws {
        var b = SignBoard(pages: [letter])
        let id = try XCTUnwrap(b.addSignature(sig(), page: 1, center: CGPoint(x: 0.5, y: 0.5)))
        let m = try XCTUnwrap(b.mark(id))
        XCTAssertEqual(m.x + m.w / 2, 0.5, accuracy: 1e-9)
        XCTAssertEqual(m.y + m.h / 2, 0.5, accuracy: 1e-9)
        let id2 = try XCTUnwrap(b.addSignature(sig(), page: 1, center: CGPoint(x: 0.98, y: 0.99)))
        let m2 = try XCTUnwrap(b.mark(id2))
        XCTAssertLessThanOrEqual(m2.x + m2.w, 1 + 1e-12)
        XCTAssertLessThanOrEqual(m2.y + m2.h, 1 + 1e-12)
        XCTAssertNil(b.addSignature(sig(), page: 3, center: .zero))
        XCTAssertEqual(b.signatureCount, 2)
    }

    func testMoveClampsInsidePage() throws {
        var b = SignBoard(pages: [letter])
        let id = try XCTUnwrap(b.addSignature(sig(), page: 1, center: CGPoint(x: 0.5, y: 0.5)))
        b.move(id, x: 1.4, y: -0.3)
        let m = try XCTUnwrap(b.mark(id))
        XCTAssertEqual(m.x, 1 - m.w, accuracy: 1e-12)
        XCTAssertEqual(m.y, 0)
    }

    /// Soltar en otra página (aquí girada, apaisada) conserva el tamaño en puntos y saca la marca del grupo.
    func testMoveToOtherPageKeepsSizeInPoints() throws {
        var b = SignBoard(pages: [letter, letter, landscape])
        let id = try XCTUnwrap(b.addSignature(sig(), page: 1, center: CGPoint(x: 0.5, y: 0.5)))
        b.toAllPages(id)
        let before = try XCTUnwrap(b.mark(id))
        b.moveToPage(id, page: 3, x: 0.2, y: 0.7)
        let m = try XCTUnwrap(b.mark(id))
        XCTAssertEqual(m.page, 3)
        XCTAssertNil(m.group)
        XCTAssertEqual(m.w * 792, before.w * 612, accuracy: 1e-6)
        XCTAssertEqual(m.h * 612, before.h * 792, accuracy: 1e-6)
        XCTAssertEqual(m.x, 0.2, accuracy: 1e-12)
        XCTAssertEqual(m.y, 0.7, accuracy: 1e-12)
        // Las demás copias siguen juntas y no se mueven con ella.
        XCTAssertEqual(b.marks.filter { $0.group == before.group }.count, 2)
    }

    func testAllPagesGroupMovesAndResizesTogether() throws {
        var b = SignBoard(pages: [letter, letter, letter])
        let id = try XCTUnwrap(b.addSignature(sig(.initials, 300, 200), page: 2, center: CGPoint(x: 0.8, y: 0.9)))
        XCTAssertEqual(b.toAllPages(id), 2)
        XCTAssertEqual(b.toAllPages(id), 0, "no se duplica en páginas que ya tienen su copia")
        XCTAssertEqual(Set(b.marks.map(\.page)), [1, 2, 3])
        b.move(id, x: 0.1, y: 0.1)
        for m in b.marks { XCTAssertEqual(m.x, 0.1, accuracy: 1e-12); XCTAssertEqual(m.y, 0.1, accuracy: 1e-12) }
        let ratio = b.marks[0].h / b.marks[0].w
        b.resize(id, width: 0.2)
        for m in b.marks { XCTAssertEqual(m.w, 0.2, accuracy: 1e-12); XCTAssertEqual(m.h / m.w, ratio, accuracy: 1e-9) }
    }

    func testResizeKeepsRatioAndStaysInPage() throws {
        var b = SignBoard(pages: [letter])
        let id = try XCTUnwrap(b.addSignature(sig(), page: 1, center: CGPoint(x: 0.7, y: 0.7)))
        let ratio = try XCTUnwrap(b.mark(id)).h / b.mark(id)!.w
        b.resize(id, width: 5)
        let m = try XCTUnwrap(b.mark(id))
        XCTAssertEqual(m.h / m.w, ratio, accuracy: 1e-9)
        XCTAssertLessThanOrEqual(m.x + m.w, 1 + 1e-9)
        XCTAssertLessThanOrEqual(m.y + m.h, 1 + 1e-9)
        b.resize(id, width: 0)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(b.mark(id)).h, 0.004 - 1e-12)
        // Pellizco: alrededor del centro.
        let start = try XCTUnwrap(b.mark(id))
        b.resize(id, width: 0.2)
        let s2 = try XCTUnwrap(b.mark(id))
        b.scale(id, from: s2, by: 1.5)
        let p = try XCTUnwrap(b.mark(id))
        XCTAssertEqual(p.w, s2.w * 1.5, accuracy: 1e-9)
        XCTAssertEqual(p.x + p.w / 2, s2.x + s2.w / 2, accuracy: 1e-9)
        _ = start
    }

    func testDuplicateGoesBelowOnSamePage() throws {
        var b = SignBoard(pages: [letter, letter])
        let id = try XCTUnwrap(b.addSignature(sig(), page: 2, center: CGPoint(x: 0.5, y: 0.3)))
        b.toAllPages(id)
        let base = try XCTUnwrap(b.mark(id))
        let dupId = b.duplicate(id)
        let dup = try XCTUnwrap(b.mark(dupId))
        XCTAssertEqual(dup.page, 2)
        XCTAssertNil(dup.group)
        XCTAssertGreaterThan(dup.y, base.y + base.h)
        XCTAssertEqual(dup.w, base.w)
        XCTAssertEqual(dup.signatureId, base.signatureId)
        // Al pie de la página: va arriba.
        b.move(id, x: base.x, y: 1)
        let low = try XCTUnwrap(b.mark(id))
        let upId = b.duplicate(id)
        let up = try XCTUnwrap(b.mark(upId))
        XCTAssertLessThan(up.y + up.h, low.y)
        XCTAssertEqual(b.signatureCount, 4)
    }

    func testTextMarksAndPlacements() throws {
        var b = SignBoard(pages: [letter])
        let id = try XCTUnwrap(b.addText(.date, "27/09/2026", page: 1, center: CGPoint(x: 0.3, y: 0.3), width1: SignText.width1))
        let m = try XCTUnwrap(b.mark(id))
        XCTAssertEqual(m.h * 792, 18, accuracy: 1e-6)
        XCTAssertNil(b.addText(.text, "   ", page: 1, center: .zero, width1: SignText.width1))
        b.replaceText(id, "Gerente general de la compañía", width1: SignText.width1)
        XCTAssertGreaterThan(try XCTUnwrap(b.mark(id)).w, m.w)
        _ = b.addSignature(SignatureDTO(id: "5b8c1c1e-1111-4222-8333-944455556666", kind: .signature, width: 800, height: 300), page: 1, center: CGPoint(x: 0.99, y: 0.99))
        let pl = b.placements()
        XCTAssertEqual(pl.count, 2)
        XCTAssertEqual(pl[0]["type"] as? String, "text")
        XCTAssertEqual(pl[0]["text"] as? String, "Gerente general de la compañía")
        XCTAssertEqual(pl[1]["type"] as? String, "signature")
        XCTAssertEqual(pl[1]["signatureId"] as? String, "5b8c1c1e-1111-4222-8333-944455556666")
        for p in pl {
            let x = p["x"] as! Double, y = p["y"] as! Double, w = p["w"] as! Double, h = p["h"] as! Double
            XCTAssertLessThanOrEqual(x + w, 1.000001); XCTAssertLessThanOrEqual(y + h, 1.000001)
            XCTAssertGreaterThanOrEqual(w, 0.004); XCTAssertGreaterThanOrEqual(h, 0.004)
            XCTAssertEqual(p["page"] as? Int, 1)
        }
        XCTAssertTrue(JSONSerialization.isValidJSONObject(["placements": pl]))
    }

    func testTextFontSizeLikeServer() {
        // Caja de 18 pt de alto y muy ancha: manda el alto (0,78).
        XCTAssertEqual(SignText.fontSize("Hola", w: 500, h: 18), 18 * 0.78, accuracy: 1e-9)
        // Caja angosta: manda el ancho.
        let s = SignText.fontSize("Un texto bastante largo", w: 100, h: 18)
        XCTAssertLessThan(s, 18 * 0.78)
        XCTAssertEqual(s * SignText.width1("Un texto bastante largo"), 100, accuracy: 0.01)
    }

    func testTodayFormat() {
        var c = DateComponents(); c.year = 2026; c.month = 9; c.day = 7
        let d = Calendar.current.date(from: c)!
        XCTAssertEqual(SignText.today(d, lang: "es"), "07/09/2026")
        XCTAssertEqual(SignText.today(d, lang: "en"), "09/07/2026")
    }

    func testInitials() {
        XCTAssertEqual(SignInitials.of("danny  alberto suárez gómez"), "DAS")
        XCTAssertEqual(SignInitials.of(""), "")
    }

    // MARK: Imagen

    private func twoTone(dark: UInt8, light: UInt8, w: Int = 20, h: Int = 10, darkRect: SignImage.Rect) -> SignImage.Bitmap {
        var d = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h { for x in 0..<w {
            let i = (y * w + x) * 4
            let isDark = x >= darkRect.x && x < darkRect.x + darkRect.w && y >= darkRect.y && y < darkRect.y + darkRect.h
            let v = isDark ? dark : light
            d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255
        } }
        return SignImage.Bitmap(width: w, height: h, data: d)
    }

    func testOtsuSplitsInkFromPaper() {
        let b = twoTone(dark: 30, light: 220, darkRect: .init(x: 5, y: 2, w: 6, h: 4))
        let t = SignImage.otsuThreshold(b)
        // Punto medio entre las dos medias de clase.
        XCTAssertEqual(t, 125)
        let out = SignImage.inkify(b, threshold: t, color: SignImage.Ink.blue.rgb)
        XCTAssertEqual(SignImage.inkBounds(out), .init(x: 5, y: 2, w: 6, h: 4))
        let ink = (2 * 20 + 5) * 4, paper = 0
        XCTAssertEqual(Array(out.data[ink..<ink + 4]), [23, 42, 138, 255])
        XCTAssertEqual(out.data[paper + 3], 0, "el papel queda transparente")
        // Conservar el color original.
        let orig = SignImage.inkify(b, threshold: t, color: nil)
        XCTAssertEqual(Array(orig.data[ink..<ink + 3]), [30, 30, 30])
    }

    func testInkifySoftEdges() {
        let b = twoTone(dark: 110, light: 250, darkRect: .init(x: 0, y: 0, w: 1, h: 1))
        let out = SignImage.inkify(b, threshold: 120, color: SignImage.Ink.black.rgb)
        // 10 por debajo del umbral con suavizado de 30: alfa ≈ 1/3.
        XCTAssertEqual(Int(out.data[3]), 85)
    }

    func testInkBoundsEmpty() {
        let b = SignImage.Bitmap(width: 4, height: 4, data: [UInt8](repeating: 0, count: 64))
        XCTAssertNil(SignImage.inkBounds(b))
    }

    func testTrimmedPngCropsToStrokeWithTransparentBackground() throws {
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = false
        let img = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 800), format: fmt).image { _ in
            SignImage.Ink.blue.color.setFill()
            UIRectFill(CGRect(x: 300, y: 200, width: 1600, height: 300))
        }
        let r = try XCTUnwrap(SignImage.trimmedPNG(try XCTUnwrap(img.cgImage)))
        // Recorte 1616 × 316 (margen 8) reducido a ≤ 1200 × 600.
        XCTAssertLessThanOrEqual(r.width, 1200)
        XCTAssertLessThanOrEqual(r.height, 600)
        XCTAssertEqual(Double(r.width) / Double(r.height), 1616.0 / 316.0, accuracy: 0.05)
        XCTAssertLessThanOrEqual(r.png.count, SignLimits.maxBytes)
        XCTAssertEqual(Array(r.png.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
        let bmp = try XCTUnwrap(SignImage.bitmap(try XCTUnwrap(UIImage(data: r.png)?.cgImage)))
        XCTAssertEqual(bmp.data[3], 0, "esquina transparente (margen)")
        let mid = (bmp.height / 2 * bmp.width + bmp.width / 2) * 4
        XCTAssertEqual(bmp.data[mid + 3], 255)
        // Nada dibujado: no hay firma.
        let blank = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 50), format: fmt).image { _ in }
        XCTAssertNil(SignImage.trimmedPNG(try XCTUnwrap(blank.cgImage)))
    }

    func testPhotoRemovesBackground() throws {
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = true
        let photo = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 200), format: fmt).image { ctx in
            UIColor(white: 0.92, alpha: 1).setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 200))
            UIColor(white: 0.1, alpha: 1).setFill(); ctx.fill(CGRect(x: 100, y: 80, width: 200, height: 30))
        }
        let r = try XCTUnwrap(SignImage.photo(photo, ink: .blue, threshold: nil))
        XCTAssertGreaterThan(r.auto, 40)
        XCTAssertLessThan(r.auto, 220)
        let png = try XCTUnwrap(SignImage.trimmedPNG(r.image))
        XCTAssertEqual(Double(png.width) / Double(png.height), 216.0 / 46.0, accuracy: 0.1)
    }

    func testScriptFontsAreBundled() throws {
        for s in SignImage.Script.allCases {
            XCTAssertTrue(s.available, "\(s.rawValue) debe estar registrada (UIAppFonts)")
            XCTAssertEqual(s.font(size: 40).familyName, s.rawValue)
            XCTAssertNotNil(SignImage.typed("Ana Ruiz", script: s, ink: .blue))
        }
        let cg = try XCTUnwrap(SignImage.typed("Ana Ruiz", script: .dancing, ink: .black))
        XCTAssertNotNil(SignImage.trimmedPNG(cg))
    }

    // MARK: Contrato

    func testDecodesSigningFieldsTolerantly() throws {
        let a = try dec(AttachmentDTO.self, #"{"id":"a1","name":"Contrato.pdf","contentType":"application/pdf","sizeBytes":10,"url":"/api/v1/attachments/a1","signing":{"id":"3f9a21c0-aaaa-bbbb-cccc-000000000000","signerId":"u","signerName":"Danny","signedAt":"2026-09-27T15:00:00.000Z","originalSha256":"ab","signedSha256":"cd"}}"#)
        XCTAssertTrue(a.isPdf)
        XCTAssertEqual(a.signing?.signerName, "Danny")
        let old = try dec(AttachmentDTO.self, #"{"id":"a2","name":"x.pdf","contentType":"application/pdf","sizeBytes":1,"url":"/u","signing":"raro"}"#)
        XCTAssertNil(old.signing)
        XCTAssertEqual(AttachmentSigningDTO.ref("3f9a21c0-aaaa-bbbb-cccc-000000000000"), "3F9A21C0")

        let info = try dec(SignInfoDTO.self, #"{"attachmentId":"a1","name":"C.pdf","sizeBytes":5,"hasDigitalSignature":true,"encrypted":false,"signing":null,"history":[{"id":"h","signerName":"A"},{"bad":1}]}"#)
        XCTAssertTrue(info.hasDigitalSignature)
        XCTAssertEqual(info.history.count, 1)

        let list = try dec(SignatureList.self, #"{"signatures":[{"id":"s1","kind":"initials","source":"typed","width":300,"height":200,"url":"/api/v1/me/signatures/s1/image","createdAt":""},{"id":"s2","kind":"nuevo"}]}"#)
        XCTAssertEqual(list.signatures.map(\.kind), [.initials, .signature])

        let page = try dec(SigningHistoryPage.self, #"{"signings":[{"id":"3f9a21c0-aaaa-bbbb-cccc-000000000000","signerId":"u","signerName":"Danny","signedAt":"2026-09-27T15:00:00.000Z","originalSha256":"ab","signedSha256":"cd","ref":"3F9A21C0","documentName":"Póliza.pdf","conversationId":"c","conversationName":"General","messageId":"m","sourceAttachmentId":"s","resultAttachmentId":"r","requestedById":"p","requestedByName":"Adriana","marks":4,"signatureMarks":3,"pagesMarked":2,"pages":3,"stamp":true,"certificate":false,"attachment":null}],"nextBefore":"2026-09-27T15:00:00.000Z","total":7}"#)
        XCTAssertEqual(page.total, 7)
        let it = try XCTUnwrap(page.signings.first)
        XCTAssertEqual(it.ref, "3F9A21C0")
        XCTAssertEqual(it.signing.signerName, "Danny")
        XCTAssertNil(it.attachment)
        XCTAssertEqual(SignedText.requestLine(it), L("signed.requestedBy", ["name": "Adriana"]) + " · General")
        // Sin ref (servidor anterior): se calcula.
        let noRef = try dec(SigningHistoryItemDTO.self, #"{"id":"abcdef12-0000-0000-0000-000000000000","signerName":"x"}"#)
        XCTAssertEqual(noRef.ref, "ABCDEF12")
    }

    func testStringsExist() {
        for k in ["sign.duplicate", "sign.summary", "signed.title", "att.signBtn", "sign.legal", "signed.marks"] {
            XCTAssertNotEqual(L(k), k, k)
        }
    }
}
