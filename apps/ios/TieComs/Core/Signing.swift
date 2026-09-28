import CoreGraphics
import Foundation
import UIKit

// MARK: - Firmar PDFs: contrato (packages/contracts: SignatureDTO, SignInfoDTO, AttachmentSigningDTO, SigningHistoryItemDTO)

/// Firma guardada: PNG transparente. `url` exige Bearer y solo la sirve a su dueño.
struct SignatureDTO: Codable, Equatable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable { case signature, initials }
    enum Source: String, Codable, Sendable { case drawn, typed, uploaded }
    var id: String
    var kind: Kind
    var source: Source
    var width: Int
    var height: Int
    var url: String
    var createdAt: String

    init(id: String, kind: Kind, source: Source = .drawn, width: Int, height: Int, url: String? = nil, createdAt: String = "") {
        self.id = id; self.kind = kind; self.source = source; self.width = width; self.height = height
        self.url = url ?? "/api/v1/me/signatures/\(id)/image"; self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        kind = Kind(rawValue: c.v("kind", "signature")) ?? .signature
        source = Source(rawValue: c.v("source", "drawn")) ?? .drawn
        width = max(1, c.int("width", 1))
        height = max(1, c.int("height", 1))
        url = c.v("url", "/api/v1/me/signatures/\(id)/image")
        createdAt = c.v("createdAt", "")
    }
}

struct SignatureList: Decodable {
    var signatures: [SignatureDTO]
    init(from decoder: Decoder) throws { signatures = (try container(decoder)).lossyArray("signatures") }
}

struct SignInfoDTO: Decodable, Equatable {
    var attachmentId: String
    var name: String
    var sizeBytes: Int
    var hasDigitalSignature: Bool
    var encrypted: Bool
    var signing: AttachmentSigningDTO?
    var history: [AttachmentSigningDTO]

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        attachmentId = c.v("attachmentId", "")
        name = c.v("name", "")
        sizeBytes = c.int("sizeBytes")
        hasDigitalSignature = c.v("hasDigitalSignature", false)
        encrypted = c.v("encrypted", false)
        signing = c.o("signing")
        history = c.lossyArray("history")
    }
}

struct SignPdfResult: Decodable {
    var message: MessageDTO?
    var attachment: AttachmentDTO?
    var signing: AttachmentSigningDTO?
    var duplicate: Bool
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        message = c.o("message"); attachment = c.o("attachment"); signing = c.o("signing")
        duplicate = c.v("duplicate", false)
    }
}

/// Una fila de «Documentos que firmé» (GET /me/signings).
struct SigningHistoryItemDTO: Decodable, Equatable, Identifiable {
    var signing: AttachmentSigningDTO
    var ref: String
    var documentName: String
    var conversationId: String
    var conversationName: String?
    var messageId: String?
    var sourceAttachmentId: String
    var resultAttachmentId: String
    var requestedById: String?
    var requestedByName: String?
    var marks: Int
    var signatureMarks: Int
    var pagesMarked: Int
    var pages: Int
    var stamp: Bool
    var certificate: Bool
    var attachment: AttachmentDTO?

    var id: String { signing.id }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        signing = try AttachmentSigningDTO(from: decoder)
        ref = c.v("ref", AttachmentSigningDTO.ref(signing.id))
        if ref.isEmpty { ref = AttachmentSigningDTO.ref(signing.id) }
        documentName = c.v("documentName", "")
        conversationId = c.v("conversationId", "")
        conversationName = c.o("conversationName")
        messageId = c.o("messageId")
        sourceAttachmentId = c.v("sourceAttachmentId", "")
        resultAttachmentId = c.v("resultAttachmentId", "")
        requestedById = c.o("requestedById")
        requestedByName = c.o("requestedByName")
        marks = c.int("marks")
        signatureMarks = c.int("signatureMarks")
        pagesMarked = c.int("pagesMarked")
        pages = c.int("pages")
        stamp = c.v("stamp", true)
        certificate = c.v("certificate", false)
        attachment = c.o("attachment")
    }
}

struct SigningHistoryPage: Decodable {
    var signings: [SigningHistoryItemDTO]
    var nextBefore: String?
    var total: Int
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        signings = c.lossyArray("signings")
        nextBefore = c.o("nextBefore")
        total = c.int("total", signings.count)
    }
}

enum SignLimits {
    static let maxSaved = 12
    static let maxBytes = 512 * 1024
    static let maxPlacements = 300
}

extension APIClient {
    func listSignatures() async throws -> [SignatureDTO] {
        let r: SignatureList = try await request("/me/signatures")
        return r.signatures
    }

    /// PNG transparente ya recortado (≤ 512 KB).
    func createSignature(png: Data, kind: SignatureDTO.Kind, source: SignatureDTO.Source) async throws -> SignatureDTO {
        try await upload("/me/signatures", body: .init(data: png, contentType: "image/png",
                                                     headers: ["x-signature-kind": kind.rawValue, "x-signature-source": source.rawValue]))
    }

    func deleteSignature(_ id: String) async throws {
        try await requestData("/me/signatures/\(id)", method: "DELETE")
    }

    func signInfo(_ attachmentId: String) async throws -> SignInfoDTO {
        try await request("/attachments/\(attachmentId)/sign-info")
    }

    func signPdf(_ attachmentId: String, body: [String: Any]) async throws -> SignPdfResult {
        try await request("/attachments/\(attachmentId)/sign", method: "POST", json: body)
    }

    func listSignings(before: String? = nil, q: String? = nil, limit: Int = 30) async throws -> SigningHistoryPage {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { items.append(URLQueryItem(name: "before", value: before)) }
        if let q, !q.trimmingCharacters(in: .whitespaces).isEmpty { items.append(URLQueryItem(name: "q", value: q.trimmingCharacters(in: .whitespaces))) }
        var comps = URLComponents()
        comps.queryItems = items
        // URLComponents deja «+» sin codificar: el servidor lo leería como espacio.
        let query = (comps.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        return try await request("/me/signings?\(query)")
    }
}

// MARK: - Geometría (igual que apps/api/src/modules/signatures.ts)

enum SignGeometry {
    struct Box: Equatable { var x, y, width, height: Double }

    /// /Rotate normalizado a 0, 90, 180 o 270.
    static func normRotation(_ angle: Int) -> Int { ((Int((Double(angle) / 90).rounded()) * 90) % 360 + 360) % 360 }

    /// Tamaño de la página tal como se ve (con la rotación aplicada: a 90/270 se invierten ancho y alto).
    static func displaySize(_ box: Box, rotation: Int) -> CGSize {
        rotation % 180 == 0 ? CGSize(width: box.width, height: box.height) : CGSize(width: box.height, height: box.width)
    }

    /// Punto de la página vista (arriba a la izquierda, en puntos) → espacio del PDF (abajo a la izquierda, sin girar).
    static func displayToPdf(_ box: Box, rotation: Int, _ dx: Double, _ dy: Double) -> CGPoint {
        switch rotation {
        case 90: return CGPoint(x: box.x + dy, y: box.y + dx)
        case 180: return CGPoint(x: box.x + box.width - dx, y: box.y + dy)
        case 270: return CGPoint(x: box.x + box.width - dy, y: box.y + box.height - dx)
        default: return CGPoint(x: box.x + dx, y: box.y + box.height - dy)
        }
    }

    /// Transformación inversa (PDF → página vista, eje y hacia abajo) para dibujar con CoreGraphics en un contexto UIKit.
    /// Así lo que se ve coincide exactamente con donde el servidor estampa.
    static func pdfToDisplay(_ box: Box, rotation: Int) -> CGAffineTransform {
        switch rotation {
        case 90: return CGAffineTransform(a: 0, b: 1, c: 1, d: 0, tx: -box.y, ty: -box.x)
        case 180: return CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: box.x + box.width, ty: -box.y)
        case 270: return CGAffineTransform(a: 0, b: -1, c: -1, d: 0, tx: box.y + box.height, ty: box.x + box.width)
        default: return CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: -box.x, ty: box.y + box.height)
        }
    }

    /// Punto dentro de la vista de una página (en puntos de pantalla) → proporción 0–1 de la página vista.
    static func proportion(_ p: CGPoint, in pageFrame: CGRect) -> CGPoint {
        guard pageFrame.width > 0, pageFrame.height > 0 else { return .zero }
        return CGPoint(x: (p.x - pageFrame.minX) / pageFrame.width, y: (p.y - pageFrame.minY) / pageFrame.height)
    }

    static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }
}

/// Página de un PDF lista para ver: tamaño tal como se ve y dibujo coherente con el servidor.
struct PdfPageGeometry: Equatable {
    var box: SignGeometry.Box
    var rotation: Int
    var size: CGSize { SignGeometry.displaySize(box, rotation: rotation) }

    init(box: SignGeometry.Box, rotation: Int) { self.box = box; self.rotation = SignGeometry.normRotation(rotation) }

    init(_ page: CGPDFPage) {
        let r = page.getBoxRect(.cropBox)
        self.init(box: .init(x: r.minX, y: r.minY, width: r.width, height: r.height), rotation: Int(page.rotationAngle))
    }

    /// Imagen de la página a `scale` píxeles por punto, fondo blanco.
    static func render(_ page: CGPDFPage, scale: CGFloat) -> UIImage {
        let g = PdfPageGeometry(page)
        let size = CGSize(width: max(1, (g.size.width * scale).rounded(.down)), height: max(1, (g.size.height * scale).rounded(.down)))
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1; fmt.opaque = true
        return UIGraphicsImageRenderer(size: size, format: fmt).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let cg = ctx.cgContext
            cg.interpolationQuality = .high
            cg.scaleBy(x: size.width / g.size.width, y: size.height / g.size.height)
            cg.concatenate(SignGeometry.pdfToDisplay(g.box, rotation: g.rotation))
            cg.clip(to: CGRect(x: g.box.x, y: g.box.y, width: g.box.width, height: g.box.height))
            cg.drawPDFPage(page)
        }
    }
}

// MARK: - Marcas sobre el documento

enum SignMarkKind: String, Equatable, Sendable { case signature, initials, date, text
    var isImage: Bool { self == .signature || self == .initials }
    var isText: Bool { !isImage }
}

/// Una marca en proporciones (0–1) de la página tal como se ve, origen arriba a la izquierda. `page` empieza en 1.
struct SignMark: Identifiable, Equatable, Sendable {
    var id: String = UUID().uuidString
    var kind: SignMarkKind
    var page: Int
    var x: Double
    var y: Double
    var w: Double
    var h: Double
    var signatureId: String? = nil
    var text: String? = nil
    /// Copias de «En todas»: se mueven y se agrandan juntas.
    var group: String? = nil
}

/// Tablero de marcas: lógica pura (se prueba sin pantalla). Tamaños de las páginas en puntos, tal como se ven.
struct SignBoard: Equatable {
    var pages: [CGSize]
    var marks: [SignMark] = []

    private static let clamp = SignGeometry.clamp

    func size(_ page: Int) -> CGSize? { pages.indices.contains(page - 1) ? pages[page - 1] : nil }
    func mark(_ id: String?) -> SignMark? { id.flatMap { id in marks.first { $0.id == id } } }
    var signatureCount: Int { marks.filter { $0.kind.isImage }.count }
    var pagesUsed: Int { Set(marks.map(\.page)).count }

    /// Tamaño por defecto (proporciones) de una firma: ancho 170 pt (6 cm) o 60 pt las iniciales; alto según la imagen.
    static func defaultSize(kind: SignatureDTO.Kind, imageW: Int, imageH: Int, page: CGSize) -> (w: Double, h: Double) {
        let initials = kind == .initials
        var wPt: Double = initials ? 60 : 170
        var hPt = wPt * Double(imageH) / Double(max(1, imageW))
        let maxH: Double = initials ? 50 : 70
        if hPt > maxH { hPt = maxH; wPt = hPt * Double(imageW) / Double(max(1, imageH)) }
        return (min(0.9, wPt / page.width), min(0.9, hPt / page.height))
    }

    /// Nueva firma centrada en (cx, cy) de la página. Devuelve su id.
    @discardableResult
    mutating func addSignature(_ s: SignatureDTO, page: Int, center: CGPoint) -> String? {
        guard let size = size(page) else { return nil }
        let (w, h) = SignBoard.defaultSize(kind: s.kind, imageW: s.width, imageH: s.height, page: size)
        let m = SignMark(kind: s.kind == .initials ? .initials : .signature, page: page,
                         x: SignBoard.clamp(center.x - w / 2, 0, 1 - w), y: SignBoard.clamp(center.y - h / 2, 0, 1 - h),
                         w: w, h: h, signatureId: s.id)
        marks.append(m)
        return m.id
    }

    /// Caja de un texto de 18 pt de alto (la letra del servidor ocupa 0,78 del alto).
    static func textSize(_ text: String, page: CGSize, width1: (String) -> Double) -> (w: Double, h: Double) {
        let hPt = 18.0, wPt = max(30, width1(text) * hPt * 0.78 * 1.06)
        return (min(0.95, wPt / page.width), min(0.5, hPt / page.height))
    }

    @discardableResult
    mutating func addText(_ kind: SignMarkKind, _ text: String, page: Int, center: CGPoint, width1: (String) -> Double) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let size = size(page), !t.isEmpty else { return nil }
        let (w, h) = SignBoard.textSize(t, page: size, width1: width1)
        let m = SignMark(kind: kind, page: page, x: SignBoard.clamp(center.x - w / 2, 0, 1 - w), y: SignBoard.clamp(center.y - h / 2, 0, 1 - h),
                         w: w, h: h, text: t)
        marks.append(m)
        return m.id
    }

    /// Cambia el texto conservando el alto que tenía la marca.
    mutating func replaceText(_ id: String, _ text: String, width1: (String) -> Double) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let i = marks.firstIndex(where: { $0.id == id }), let size = size(marks[i].page), !t.isEmpty else { return }
        let (w, h) = SignBoard.textSize(t, page: size, width1: width1)
        marks[i].text = t
        marks[i].w = min(1 - marks[i].x, w * (marks[i].h / h))
    }

    /// Mover dentro de la misma página (la esquina superior izquierda a x, y). Las copias del grupo se mueven igual.
    mutating func move(_ id: String, x: Double, y: Double) {
        guard let base = mark(id) else { return }
        let dx = x - base.x, dy = y - base.y
        for i in marks.indices where marks[i].id == id || (base.group != nil && marks[i].group == base.group) {
            marks[i].x = SignBoard.clamp(marks[i].x + dx, 0, 1 - marks[i].w)
            marks[i].y = SignBoard.clamp(marks[i].y + dy, 0, 1 - marks[i].h)
        }
    }

    /// Llevar una marca a otra página conservando su tamaño en puntos; sale de su grupo.
    mutating func moveToPage(_ id: String, page: Int, x: Double, y: Double) {
        guard let i = marks.firstIndex(where: { $0.id == id }), let from = size(marks[i].page), let to = size(page) else { return }
        if page == marks[i].page { move(id, x: x, y: y); return }
        var m = marks[i]
        m.w = min(0.95, m.w * from.width / to.width)
        m.h = min(0.95, m.h * from.height / to.height)
        m.page = page
        m.group = nil
        m.x = SignBoard.clamp(x, 0, 1 - m.w)
        m.y = SignBoard.clamp(y, 0, 1 - m.h)
        marks[i] = m
    }

    /// Cambiar el tamaño conservando la proporción (en puntos) y la esquina superior izquierda; todo el grupo igual.
    mutating func resize(_ id: String, width w: Double) {
        guard let base = mark(id), base.w > 0 else { return }
        let ratio = base.h / base.w
        let minW = max(0.004, 0.004 / max(ratio, 1e-6))
        var nw = max(minW, w)
        nw = min(nw, 1 - base.x, (1 - base.y) / max(ratio, 1e-6))
        let nh = nw * ratio
        for i in marks.indices where marks[i].id == id || (base.group != nil && marks[i].group == base.group) {
            marks[i].w = min(nw, 1); marks[i].h = min(nh, 1)
            marks[i].x = SignBoard.clamp(marks[i].x, 0, 1 - marks[i].w)
            marks[i].y = SignBoard.clamp(marks[i].y, 0, 1 - marks[i].h)
        }
    }

    /// Cambiar el tamaño alrededor del centro (pellizco).
    mutating func scale(_ id: String, from start: SignMark, by k: Double) {
        guard mark(id) != nil else { return }
        let ratio = start.h / max(start.w, 1e-6)
        let maxW = min(1, 1 / max(ratio, 1e-6))
        let nw = SignBoard.clamp(start.w * k, max(0.004, 0.004 / max(ratio, 1e-6)), maxW)
        let nh = nw * ratio
        let cx = start.x + start.w / 2, cy = start.y + start.h / 2
        let group = start.group
        for i in marks.indices where marks[i].id == id || (group != nil && marks[i].group == group) {
            marks[i].w = nw; marks[i].h = nh
            if marks[i].id == id {
                marks[i].x = SignBoard.clamp(cx - nw / 2, 0, 1 - nw); marks[i].y = SignBoard.clamp(cy - nh / 2, 0, 1 - nh)
            } else {
                marks[i].x = SignBoard.clamp(marks[i].x, 0, 1 - nw); marks[i].y = SignBoard.clamp(marks[i].y, 0, 1 - nh)
            }
        }
    }

    /// «En todas»: copia la marca a todas las páginas en la misma posición relativa. Devuelve cuántas copias hizo.
    @discardableResult
    mutating func toAllPages(_ id: String) -> Int {
        guard let i = marks.firstIndex(where: { $0.id == id }), let from = size(marks[i].page) else { return 0 }
        let group = marks[i].group ?? UUID().uuidString
        marks[i].group = group
        let base = marks[i]
        var copies: [SignMark] = []
        for p in 1...max(1, pages.count) where p != base.page && !marks.contains(where: { $0.group == group && $0.page == p }) {
            guard let to = size(p) else { continue }
            let w = min(0.95, base.w * from.width / to.width), h = min(0.95, base.h * from.height / to.height)
            var c = base
            c.id = UUID().uuidString; c.page = p; c.w = w; c.h = h
            c.x = SignBoard.clamp(base.x, 0, 1 - w); c.y = SignBoard.clamp(base.y, 0, 1 - h)
            copies.append(c)
        }
        marks.append(contentsOf: copies)
        return copies.count
    }

    /// «Duplicar»: otra marca igual un poco más abajo en la misma página (pólizas con varias firmas). Si no cabe
    /// abajo, va arriba. La copia no pertenece al grupo.
    @discardableResult
    mutating func duplicate(_ id: String) -> String? {
        guard let base = mark(id) else { return nil }
        var c = base
        c.id = UUID().uuidString
        c.group = nil
        let gap = base.h * 0.4 + 0.01
        if base.y + base.h * 2 + gap <= 1 { c.y = base.y + base.h + gap }
        else if base.y - base.h - gap >= 0 { c.y = base.y - base.h - gap }
        else { c.y = SignBoard.clamp(base.y + 0.03, 0, 1 - base.h); c.x = SignBoard.clamp(base.x + 0.03, 0, 1 - base.w) }
        marks.append(c)
        return c.id
    }

    mutating func remove(_ id: String) { marks.removeAll { $0.id == id } }

    /// Cuerpo `placements` de POST /attachments/:id/sign.
    func placements() -> [[String: Any]] {
        marks.map { m in
            let x = SignBoard.clamp(m.x, 0, 1), y = SignBoard.clamp(m.y, 0, 1)
            var o: [String: Any] = ["page": m.page, "x": x, "y": y,
                                    "w": SignBoard.clamp(m.w, 0.004, 1 - x), "h": SignBoard.clamp(m.h, 0.004, 1 - y)]
            if let s = m.signatureId { o["type"] = "signature"; o["signatureId"] = s } else { o["type"] = "text"; o["text"] = m.text ?? "" }
            return o
        }
    }
}

// MARK: - Texto (Helvetica, como el servidor)

enum SignText {
    static let font = "Helvetica"
    /// Ancho del texto a 1 pt en Helvetica.
    static func width1(_ text: String) -> Double {
        let f = UIFont(name: font, size: 100) ?? .systemFont(ofSize: 100)
        return Double((text as NSString).size(withAttributes: [.font: f]).width) / 100
    }
    /// Tamaño de letra que usa el servidor para una caja de w × h puntos.
    static func fontSize(_ text: String, w: Double, h: Double) -> Double { max(4, min(h * 0.78, w / max(1e-6, width1(text)))) }

    /// Fecha de hoy: dd/MM/yyyy (es) o MM/dd/yyyy (en).
    static func today(_ d: Date = Date(), lang: String = L10n.lang) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = lang == "en" ? "MM/dd/yyyy" : "dd/MM/yyyy"
        return f.string(from: d)
    }
}
