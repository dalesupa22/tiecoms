import SwiftUI
import UIKit

/// Estado del visor/editor de firma. Las marcas viven en `SignBoard` (lógica pura); la vista UIKit las dibuja.
@MainActor
@Observable
final class SignSession {
    var board = SignBoard(pages: [])
    var selected: String? { didSet { if oldValue != selected { canvas?.syncMarks() } } }
    var signing: Bool
    var visiblePage = 1
    /// Imágenes de las firmas guardadas (por id).
    var images: [String: UIImage] = [:]
    @ObservationIgnored weak var canvas: SignCanvasView?
    /// Tocar una marca de texto ya elegida la edita.
    @ObservationIgnored var onEditText: ((String) -> Void)?

    init(signing: Bool) { self.signing = signing }

    var dirty: Bool { !board.marks.isEmpty }
    var selectedMark: SignMark? { board.mark(selected) }

    func mutate(_ f: (inout SignBoard) -> Void) {
        f(&board)
        if let s = selected, board.mark(s) == nil { selected = nil }
        canvas?.syncMarks()
    }

    /// Centro de lo que se ve de la página, en proporciones (entre 0,1 y 0,9).
    func viewCenter(_ page: Int) -> CGPoint { canvas?.viewCenter(page) ?? CGPoint(x: 0.5, y: 0.5) }

    func setImage(_ img: UIImage, for id: String) {
        images[id] = img
        canvas?.syncMarks()
    }
}

/// Envoltura SwiftUI del lienzo.
struct SignCanvas: UIViewRepresentable {
    let document: CGPDFDocument
    let session: SignSession

    func makeUIView(context: Context) -> SignCanvasView {
        let v = SignCanvasView(document: document, session: session)
        session.canvas = v
        return v
    }

    func updateUIView(_ v: SignCanvasView, context: Context) {
        _ = session.signing
        v.syncMarks()
    }
}

/// Scroll que no se desplaza ni hace zoom cuando el gesto empieza sobre una marca (esa la mueve o la agranda).
final class PdfScrollView: UIScrollView {
    var touchDown: CGPoint = .zero
    /// ¿Hay una marca editable en este punto (coordenadas del scroll)? Con `selectedOnly` solo la elegida.
    var markAt: ((CGPoint, Bool) -> Bool)?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if event?.type == .touches { touchDown = point }
        return super.hitTest(point, with: event)
    }

    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        if g === panGestureRecognizer, markAt?(touchDown, false) == true { return false }
        if g === pinchGestureRecognizer, markAt?(g.location(in: self), true) == true || markAt?(touchDown, true) == true { return false }
        return super.gestureRecognizerShouldBegin(g)
    }
}

/// Páginas del PDF una debajo de otra a lo ancho y, encima, las marcas. Las marcas se arrastran con el dedo a
/// cualquier parte (también a otra página), se agrandan con el asa o con el pellizco y se quitan con la ×.
final class SignCanvasView: UIView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    let document: CGPDFDocument
    let session: SignSession
    let scroll = PdfScrollView()
    private let content = UIView()
    private var geoms: [PdfPageGeometry] = []
    private var pageViews: [UIImageView] = []
    /// Escala (px por punto de pantalla) con la que está dibujada cada página; 0 = sin dibujar.
    private var renderedScale: [CGFloat] = []
    private var rendering: Set<Int> = []
    private var pageFrames: [CGRect] = []
    private var markViews: [String: SignMarkView] = [:]
    private var laidOutWidth: CGFloat = 0
    private let renderQueue = DispatchQueue(label: "chaggu.pdf.render", qos: .userInitiated)
    static let margin: CGFloat = 12
    static let spacing: CGFloat = 12

    // Arrastre en curso.
    private struct Drag { var id: String; var offset: CGPoint; var finger: CGPoint }
    private var drag: Drag?
    private var autoScroll: CADisplayLink?
    private struct Resize { var id: String; var start: SignMark; var startFrame: CGRect }
    private var resizing: Resize?
    private var pinchStart: SignMark?

    init(document: CGPDFDocument, session: SignSession) {
        self.document = document
        self.session = session
        super.init(frame: .zero)
        backgroundColor = UIColor(Theme.bubbleOther)
        scroll.delegate = self
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 4
        scroll.delaysContentTouches = false
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .onDrag
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.markAt = { [weak self] p, selectedOnly in self?.editableMark(at: p, selectedOnly: selectedOnly) != nil }
        scroll.accessibilityIdentifier = "sign.stage"
        addSubview(scroll)
        scroll.addSubview(content)
        for i in 0..<document.numberOfPages {
            guard let page = document.page(at: i + 1) else { continue }
            geoms.append(PdfPageGeometry(page))
            let iv = UIImageView()
            iv.backgroundColor = .white
            iv.contentMode = .scaleToFill
            iv.layer.shadowColor = UIColor.black.cgColor
            iv.layer.shadowOpacity = 0.12
            iv.layer.shadowRadius = 3
            iv.layer.shadowOffset = CGSize(width: 0, height: 1)
            iv.isAccessibilityElement = true
            iv.accessibilityLabel = L("sign.pageOf", ["i": i + 1, "n": document.numberOfPages])
            iv.accessibilityIdentifier = "sign.page.\(i + 1)"
            content.addSubview(iv)
            pageViews.append(iv)
            renderedScale.append(0)
        }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapStage(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        scroll.addGestureRecognizer(tap)
    }

    required init?(coder: NSCoder) { fatalError() }

    // MARK: Distribución

    override func layoutSubviews() {
        super.layoutSubviews()
        scroll.frame = bounds
        guard bounds.width > 0, abs(bounds.width - laidOutWidth) > 0.5 else { updateVisible(); return }
        laidOutWidth = bounds.width
        let zoom = scroll.zoomScale
        if zoom != 1 { scroll.setZoomScale(1, animated: false) }
        // Páginas a lo ancho (máx. 900 pt en iPad), centradas.
        let pageW = min(900, bounds.width - Self.margin * 2)
        let left = (bounds.width - pageW) / 2
        var y = Self.margin
        pageFrames = geoms.map { g in
            let h = pageW * g.size.height / max(1, g.size.width)
            defer { y += h + Self.spacing }
            return CGRect(x: left, y: y, width: pageW, height: h)
        }
        content.frame = CGRect(x: 0, y: 0, width: bounds.width, height: y - Self.spacing + Self.margin + 80)
        scroll.contentSize = content.frame.size
        for (i, f) in pageFrames.enumerated() {
            pageViews[i].frame = f
            pageViews[i].layer.shadowPath = UIBezierPath(rect: pageViews[i].bounds).cgPath
            renderedScale[i] = min(renderedScale[i], 0.01) // se redibuja al nuevo ancho
        }
        syncMarks()
        updateVisible()
    }

    func pageFrame(_ page: Int) -> CGRect? { pageFrames.indices.contains(page - 1) ? pageFrames[page - 1] : nil }

    /// Rectángulo visible en coordenadas del contenido (sin zoom).
    private var visibleContentRect: CGRect { scroll.convert(scroll.bounds, to: content) }

    func viewCenter(_ page: Int) -> CGPoint {
        guard let f = pageFrame(page) else { return CGPoint(x: 0.5, y: 0.5) }
        let v = visibleContentRect
        let p = SignGeometry.proportion(CGPoint(x: v.midX, y: v.midY), in: f)
        return CGPoint(x: SignGeometry.clamp(p.x, 0.1, 0.9), y: SignGeometry.clamp(p.y, 0.1, 0.9))
    }

    /// Página bajo un punto del contenido (la más cercana en vertical si cae entre dos).
    private func page(atContentY y: CGFloat) -> Int {
        var best = 1, dist = CGFloat.infinity
        for (i, f) in pageFrames.enumerated() {
            let d = y < f.minY ? f.minY - y : (y > f.maxY ? y - f.maxY : 0)
            if d < dist { dist = d; best = i + 1 }
        }
        return best
    }

    // MARK: Dibujo perezoso de páginas

    func scrollViewDidScroll(_ scrollView: UIScrollView) { updateVisible() }
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { content }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { counterScaleHandles() }
    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) { updateVisible() }

    private func updateVisible() {
        guard !pageFrames.isEmpty else { return }
        let v = visibleContentRect
        let mid = v.midY
        let current = page(atContentY: mid)
        if session.visiblePage != current, drag == nil { session.visiblePage = current }
        let near = v.insetBy(dx: 0, dy: -max(600, v.height))
        let far = v.insetBy(dx: 0, dy: -max(2400, v.height * 4))
        let screen = window?.screen.scale ?? 3
        for (i, f) in pageFrames.enumerated() {
            if f.intersects(near) {
                // Nitidez según pantalla y zoom, sin pasar de ~12 Mpx por página.
                var s = (f.width / max(1, geoms[i].size.width)) * screen * min(3, scroll.zoomScale)
                let px = geoms[i].size.width * geoms[i].size.height * s * s
                if px > 12_000_000 { s *= sqrt(12_000_000 / px) }
                if renderedScale[i] < s * 0.9 { render(i, scale: s) }
            } else if !f.intersects(far), renderedScale[i] > 0 {
                pageViews[i].image = nil
                renderedScale[i] = 0
            }
        }
    }

    private func render(_ i: Int, scale: CGFloat) {
        guard !rendering.contains(i) else { return }
        rendering.insert(i)
        let doc = document
        renderQueue.async { [weak self] in
            let img = doc.page(at: i + 1).map { PdfPageGeometry.render($0, scale: scale) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.rendering.remove(i)
                if let img { self.pageViews[i].image = img; self.renderedScale[i] = scale }
                self.updateVisible()
            }
        }
    }

    // MARK: Marcas

    /// Deja las vistas de las marcas iguales al tablero.
    func syncMarks() {
        let editable = session.signing
        let marks = session.board.marks
        let ids = Set(marks.map(\.id))
        for (id, v) in markViews where !ids.contains(id) { v.removeFromSuperview(); markViews[id] = nil }
        for m in marks {
            guard let f = pageFrame(m.page) else { continue }
            let v = markViews[m.id] ?? {
                let nv = SignMarkView(canvas: self, id: m.id)
                content.addSubview(nv)
                markViews[m.id] = nv
                return nv
            }()
            let frame = CGRect(x: f.minX + m.x * f.width, y: f.minY + m.y * f.height, width: m.w * f.width, height: m.h * f.height)
            v.configure(m, frame: frame, image: m.signatureId.flatMap { session.images[$0] },
                        selected: m.id == session.selected, editable: editable, zoom: scroll.zoomScale)
        }
        if let s = session.selected, let v = markViews[s] { content.bringSubviewToFront(v) }
    }

    private func counterScaleHandles() { for v in markViews.values { v.setZoom(scroll.zoomScale) } }

    /// Marca editable bajo un punto del scroll (con margen para que las pequeñas se puedan tomar con el dedo).
    func editableMark(at p: CGPoint, selectedOnly: Bool) -> SignMarkView? {
        guard session.signing else { return nil }
        let c = scroll.convert(p, to: content)
        if let s = session.selected, let v = markViews[s], v.hitArea.contains(c) { return v }
        if selectedOnly { return nil }
        return markViews.values.first { $0.hitArea.contains(c) }
    }

    /// El toque de la hoja (soltar la selección) no compite con el de las marcas.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var v = touch.view
        while let x = v, x !== scroll { if x is SignMarkView { return false }; v = x.superview }
        return true
    }

    @objc private func tapStage(_ g: UITapGestureRecognizer) {
        guard session.signing, editableMark(at: g.location(in: scroll), selectedOnly: false) == nil else { return }
        session.selected = nil
    }

    // Tocar una marca: la elige; si ya estaba elegida y es texto, se edita.
    func tapped(_ id: String) {
        guard session.signing else { return }
        if session.selected == id, let m = session.board.mark(id), m.kind.isText { session.onEditText?(id); return }
        session.selected = id
        UISelectionFeedbackGenerator().selectionChanged()
    }

    func removeMark(_ id: String) {
        session.mutate { $0.remove(id) }
        session.selected = nil
    }

    // Mover con el dedo, también a otra página.
    func pan(_ g: UIPanGestureRecognizer, id: String) {
        guard session.signing, let m = session.board.mark(id), let f = pageFrame(m.page) else { return }
        switch g.state {
        case .began:
            session.selected = id
            let finger = g.location(in: content)
            let origin = CGPoint(x: f.minX + m.x * f.width, y: f.minY + m.y * f.height)
            drag = Drag(id: id, offset: CGPoint(x: finger.x - origin.x, y: finger.y - origin.y), finger: g.location(in: self))
            markViews[id]?.setLifted(true)
            startAutoScroll()
        case .changed:
            drag?.finger = g.location(in: self)
            applyDrag()
        default:
            applyDrag()
            drag = nil
            stopAutoScroll()
            markViews[id]?.setLifted(false)
            if let m = session.board.mark(id) { session.visiblePage = m.page }
        }
    }

    private func applyDrag() {
        guard let d = drag, let m = session.board.mark(d.id) else { return }
        let p = convert(d.finger, to: content)
        let target = page(atContentY: p.y)
        guard let tf = pageFrame(target) else { return }
        let x = (p.x - d.offset.x - tf.minX) / tf.width, y = (p.y - d.offset.y - tf.minY) / tf.height
        let before = m.page
        session.mutate { b in
            if target == m.page { b.move(d.id, x: x, y: y) } else { b.moveToPage(d.id, page: target, x: x, y: y) }
        }
        if target != before { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    }

    private func startAutoScroll() {
        stopAutoScroll()
        let link = CADisplayLink(target: self, selector: #selector(autoScrollTick))
        link.add(to: .main, forMode: .common)
        autoScroll = link
    }

    private func stopAutoScroll() { autoScroll?.invalidate(); autoScroll = nil }

    /// Cerca del borde de arriba o de abajo, la hoja se desplaza sola para llevar la marca más lejos.
    @objc private func autoScrollTick() {
        guard let d = drag else { return }
        let edge: CGFloat = 64
        let y = d.finger.y
        var dy: CGFloat = 0
        if y > bounds.height - edge { dy = (y - (bounds.height - edge)) / edge * 16 }
        else if y < edge { dy = -(edge - y) / edge * 16 }
        guard dy != 0 else { return }
        let maxY = max(0, scroll.contentSize.height - scroll.bounds.height)
        let ny = SignGeometry.clamp(scroll.contentOffset.y + dy, 0, maxY)
        guard ny != scroll.contentOffset.y else { return }
        scroll.contentOffset.y = ny
        applyDrag()
    }

    // Asa de la esquina: agranda o achica conservando la proporción.
    func resize(_ g: UIPanGestureRecognizer, id: String) {
        guard session.signing, let m = session.board.mark(id), let f = pageFrame(m.page) else { return }
        switch g.state {
        case .began:
            session.selected = id
            resizing = Resize(id: id, start: m, startFrame: CGRect(x: 0, y: 0, width: m.w * f.width, height: m.h * f.height))
        case .changed, .ended:
            guard let r = resizing else { return }
            let t = g.translation(in: content)
            let ratio = r.startFrame.height / max(1, r.startFrame.width)
            // Lo que más se movió manda (hacia la derecha o hacia abajo).
            let dw = abs(t.x) >= abs(t.y / max(ratio, 0.01)) ? t.x : t.y / max(ratio, 0.01)
            let wPt = max(18, r.startFrame.width + dw)
            session.mutate { $0.resize(id, width: wPt / f.width) }
            if g.state == .ended { resizing = nil }
        default: resizing = nil
        }
    }

    // Pellizco sobre la marca elegida.
    func pinch(_ g: UIPinchGestureRecognizer, id: String) {
        guard session.signing, let m = session.board.mark(id) else { return }
        switch g.state {
        case .began: pinchStart = m; session.selected = id
        case .changed, .ended:
            if let s = pinchStart { session.mutate { $0.scale(id, from: s, by: Double(g.scale)) } }
            if g.state == .ended { pinchStart = nil }
        default: pinchStart = nil
        }
    }
}

/// Vista de una marca: imagen o texto, borde al elegirla, × arriba a la izquierda y asa redonda abajo a la derecha.
final class SignMarkView: UIView, UIGestureRecognizerDelegate {
    private weak var canvas: SignCanvasView?
    let id: String
    private let imageView = UIImageView()
    private let label = UILabel()
    private let border = CAShapeLayer()
    private let removeButton = UIButton(type: .custom)
    private let handle = UIView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var selected = false
    private var editable = false
    private var kind: SignMarkKind = .signature
    /// Zona tocable mínima (44 pt).
    static let touch: CGFloat = 44
    private static let knob: CGFloat = 26

    init(canvas: SignCanvasView, id: String) {
        self.canvas = canvas
        self.id = id
        super.init(frame: .zero)
        clipsToBounds = false
        imageView.contentMode = .scaleToFill
        addSubview(imageView)
        label.textColor = UIColor(red: 0.06, green: 0.07, blue: 0.12, alpha: 1)
        label.adjustsFontSizeToFitWidth = false
        label.lineBreakMode = .byClipping
        addSubview(label)
        addSubview(spinner)
        border.fillColor = UIColor.clear.cgColor
        border.strokeColor = UIColor(Theme.primaryFill).cgColor
        border.lineWidth = 1.5
        border.lineDashPattern = [5, 3]
        layer.addSublayer(border)

        removeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .bold)), for: .normal)
        removeButton.tintColor = .white
        removeButton.backgroundColor = UIColor(Theme.primaryFill)
        removeButton.layer.cornerRadius = Self.knob / 2
        removeButton.layer.borderColor = UIColor.white.cgColor
        removeButton.layer.borderWidth = 2
        removeButton.accessibilityLabel = L("sign.remove")
        removeButton.accessibilityIdentifier = "sign.mark.remove"
        removeButton.addAction(UIAction { [weak self] _ in guard let self else { return }; self.canvas?.removeMark(self.id) }, for: .touchUpInside)
        addSubview(removeButton)

        handle.backgroundColor = .white
        handle.layer.cornerRadius = Self.knob / 2
        handle.layer.borderColor = UIColor(Theme.primaryFill).cgColor
        handle.layer.borderWidth = 3
        handle.layer.shadowColor = UIColor.black.cgColor
        handle.layer.shadowOpacity = 0.25
        handle.layer.shadowRadius = 2
        handle.layer.shadowOffset = CGSize(width: 0, height: 1)
        handle.isAccessibilityElement = false
        handle.accessibilityIdentifier = "sign.mark.handle"
        addSubview(handle)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
        pan.maximumNumberOfTouches = 1
        pan.delegate = self
        addGestureRecognizer(pan)
        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap))
        addGestureRecognizer(tap)
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
        pinch.delegate = self
        addGestureRecognizer(pinch)
        let resize = UIPanGestureRecognizer(target: self, action: #selector(onResize(_:)))
        resize.maximumNumberOfTouches = 1
        handle.addGestureRecognizer(resize)

        isAccessibilityElement = true
        accessibilityIdentifier = "sign.mark"
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ m: SignMark, frame f: CGRect, image: UIImage?, selected: Bool, editable: Bool, zoom: CGFloat) {
        kind = m.kind
        self.selected = selected
        self.editable = editable
        if !frame.equalTo(f) { frame = f }
        imageView.frame = bounds
        imageView.isHidden = !m.kind.isImage
        if m.kind.isImage { imageView.image = image }
        if m.kind.isImage, image == nil { spinner.center = CGPoint(x: bounds.midX, y: bounds.midY); spinner.startAnimating() } else { spinner.stopAnimating() }
        label.isHidden = !m.kind.isText
        if m.kind.isText, let text = m.text, let page = canvas?.pageFrame(m.page), let pts = canvas?.session.board.size(m.page) {
            // Mismo tamaño de letra que estampa el servidor, pasado a puntos de pantalla.
            let k = page.width / max(1, pts.width)
            let size = SignText.fontSize(text, w: Double(f.width / k), h: Double(f.height / k)) * Double(k)
            label.font = UIFont(name: SignText.font, size: CGFloat(size))
            label.text = text
            label.frame = bounds
        }
        border.isHidden = !(selected && editable)
        border.path = UIBezierPath(roundedRect: bounds.insetBy(dx: -2, dy: -2), cornerRadius: 3).cgPath
        removeButton.isHidden = !(selected && editable)
        handle.isHidden = !(selected && editable)
        setZoom(zoom)
        accessibilityLabel = m.kind.isText ? (m.text ?? "") : L(m.kind == .initials ? "sign.initials" : "sign.signature")
        accessibilityTraits = selected ? [.button, .selected] : .button
    }

    func setZoom(_ zoom: CGFloat) {
        let k = 1 / max(zoom, 0.01)
        removeButton.bounds = CGRect(x: 0, y: 0, width: Self.knob, height: Self.knob)
        handle.bounds = removeButton.bounds
        removeButton.transform = CGAffineTransform(scaleX: k, y: k)
        handle.transform = removeButton.transform
        removeButton.center = CGPoint(x: -2, y: -2)
        handle.center = CGPoint(x: bounds.maxX + 2, y: bounds.maxY + 2)
    }

    func setLifted(_ on: Bool) {
        UIView.animate(withDuration: 0.12) {
            self.layer.shadowColor = UIColor.black.cgColor
            self.layer.shadowOpacity = on ? 0.25 : 0
            self.layer.shadowRadius = on ? 6 : 0
            self.layer.shadowOffset = CGSize(width: 0, height: on ? 3 : 0)
            self.alpha = on ? 0.92 : 1
        }
    }

    /// Zona tocable en coordenadas del contenido: al menos 44 × 44 pt alrededor de la marca.
    var hitArea: CGRect {
        let zoom = max(0.01, (canvas?.scroll.zoomScale ?? 1))
        let minSide = Self.touch / zoom
        let dx = max(0, (minSide - frame.width) / 2), dy = max(0, (minSide - frame.height) / 2)
        var r = frame.insetBy(dx: -dx, dy: -dy)
        if selected && editable { r = r.insetBy(dx: -Self.touch / 2 / zoom, dy: -Self.touch / 2 / zoom) }
        return r
    }

    private func expanded(_ v: UIView) -> CGRect {
        let zoom = max(0.01, (canvas?.scroll.zoomScale ?? 1))
        let s = Self.touch / zoom
        return CGRect(x: v.center.x - s / 2, y: v.center.y - s / 2, width: s, height: s)
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard editable else { return false }
        if selected, expanded(removeButton).contains(point) || expanded(handle).contains(point) { return true }
        let area = hitArea.offsetBy(dx: -frame.minX, dy: -frame.minY)
        return area.contains(point)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard editable, !isHidden, self.point(inside: point, with: event) else { return nil }
        if selected {
            if expanded(removeButton).contains(point) { return removeButton }
            if expanded(handle).contains(point) { return handle }
        }
        return self
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) { canvas?.pan(g, id: id) }
    @objc private func onTap() { canvas?.tapped(id) }
    @objc private func onPinch(_ g: UIPinchGestureRecognizer) { canvas?.pinch(g, id: id) }
    @objc private func onResize(_ g: UIPanGestureRecognizer) { canvas?.resize(g, id: id) }

    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        if g is UIPinchGestureRecognizer { return selected && editable }
        return editable
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // Pellizco y arrastre de la misma marca a la vez (con dos dedos se mueve y se agranda).
        g.view === other.view
    }

    override func accessibilityActivate() -> Bool { canvas?.tapped(id); return true }
}
