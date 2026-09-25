import SwiftUI

/// Coreografía del splash "Un solo hilo" como funciones puras del tiempo (segundos).
/// Idéntica a la de Android (SPEC-v2 §4); la vista solo dibuja lo que esto devuelve.
enum SplashTimeline {
    struct Node { let x: Double; let y: Double; let initials: String; let color: UInt32; let org: String }

    /// Posiciones en fracciones de ancho/alto respecto al centro de la pantalla.
    static let nodes: [Node] = [
        Node(x: -0.30, y: -0.22, initials: "SR", color: 0x3B7BF6, org: "Acme"),
        Node(x: 0.28, y: -0.16, initials: "TB", color: 0x5B8DEF, org: "Acme"),
        Node(x: -0.26, y: 0.06, initials: "LP", color: 0x1A7F51, org: "Nova"),
        Node(x: 0.24, y: 0.12, initials: "KA", color: 0x3DAA7F, org: "Nova"),
        Node(x: 0.02, y: 0.28, initials: "MG", color: 0x8B5CF6, org: "Lexa"),
    ]

    static let soundAt = 0.30
    static let hapticAt = 1.02
    static let exitStart = 2.40
    static let total = 2.75
    /// Arranque en frío por un enlace: empieza en la fase 4 y dura ≤ 1,2 s.
    static let shortStart = 1.30
    static let shortDuration = 1.2
    static let maxWait = 6.0
    static let knot = (x: 0.49, y: 0.72)
    static let sparkCount = 10

    enum Phase: Int, Comparable {
        case people = 1, thread, tie, logo, slogan, exit, done
        static func < (a: Phase, b: Phase) -> Bool { a.rawValue < b.rawValue }
    }

    static func phase(_ t: Double) -> Phase {
        switch t {
        case ..<0.30: return .people
        case ..<1.00: return .thread
        case ..<1.30: return .tie
        case ..<1.85: return .logo
        case ..<exitStart: return .slogan
        case ..<total: return .exit
        default: return .done
        }
    }

    // MARK: Curvas

    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
    static func progress(_ t: Double, _ a: Double, _ b: Double) -> Double { clamp((t - a) / (b - a)) }
    static func easeInOut(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
    static func easeIn(_ x: Double) -> Double { x * x * x }
    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
    /// Resorte subamortiguado normalizado: 0 → 1 con un pequeño rebote.
    static func spring(_ x: Double, damping: Double = 6, frequency: Double = 2.2) -> Double {
        guard x > 0 else { return 0 }
        guard x < 1 else { return 1 }
        return 1 - exp(-damping * x) * cos(2 * .pi * frequency * x)
    }

    // MARK: Fase 1 · Personas

    static func nodeScale(_ i: Int, _ t: Double) -> Double {
        let start = Double(i) * 0.07
        return spring(progress(t, start, start + 0.38))
    }

    // MARK: Fase 2 · El hilo

    static func rope(_ t: Double) -> Double { easeInOut(progress(t, 0.30, 1.00)) }

    /// Instante en que la punta de la cuerda alcanza el nodo i (i/4 del recorrido).
    static func reachTime(_ i: Int) -> Double {
        let target = Double(i) / Double(nodes.count - 1)
        var lo = 0.30, hi = 1.00
        for _ in 0..<30 { let mid = (lo + hi) / 2; if rope(mid) < target { lo = mid } else { hi = mid } }
        return hi
    }

    /// Anillo naranja del nodo: aparece al llegar la cuerda (escala 1,25 → 1), 0 = sin anillo.
    static func ring(_ i: Int, _ t: Double) -> (scale: Double, opacity: Double) {
        let r = reachTime(i)
        guard t >= r else { return (0, 0) }
        let p = easeOut(progress(t, r, r + 0.22))
        return (1.25 - 0.25 * p, 1)
    }

    // MARK: Fase 3 · Se amarra

    static func tie(_ t: Double) -> Double { easeIn(progress(t, 1.00, 1.35)) }
    static func tieRotation(_ t: Double) -> Double { 20 * tie(t) }
    static func nodeOpacity(_ t: Double) -> Double { 1 - tie(t) }

    // MARK: Fase 4 · Nace el logo

    static func pulse(_ t: Double) -> (radius: Double, opacity: Double) {
        let p = progress(t, 1.30, 1.75)
        guard p > 0, p < 1 else { return (0, 0) }
        return (easeOut(p), 0.38 * (1 - p) * (1 - p))
    }

    /// Chispa k: desplazamiento (en unidades del ancho del logo) y opacidad. Salen en abanico hacia arriba y caen.
    static func spark(_ k: Int, _ t: Double) -> (dx: Double, dy: Double, opacity: Double) {
        let p = progress(t, 1.32, 1.95)
        guard p > 0, p < 1 else { return (0, 0, 0) }
        let angle = (-160 + 140 * Double(k) / Double(sparkCount - 1)) * .pi / 180
        let speed = 0.16 + 0.05 * Double(k % 3)
        let dx = cos(angle) * speed * p
        let dy = sin(angle) * speed * p + 0.22 * p * p // gravedad
        return (dx, dy, 1 - p)
    }

    static func orangeLayer(_ t: Double) -> (scale: Double, opacity: Double) {
        let p = progress(t, 1.30, 1.80)
        return (0.8 + 0.2 * spring(p), clamp(p * 2.5))
    }

    /// Máscara de la tinta, de izquierda a derecha (0 → 1).
    static func inkReveal(_ t: Double) -> Double { easeInOut(progress(t, 1.40, 1.95)) }

    // MARK: Fase 5 · Eslogan

    static func tagline(_ t: Double) -> (opacity: Double, offset: Double) {
        let p = easeOut(progress(t, 1.85, 2.10))
        return (p, 8 * (1 - p))
    }

    static func lines(_ t: Double) -> (opacity: Double, offset: Double) {
        let p = easeOut(progress(t, 2.00, 2.40))
        return (p, 8 * (1 - p))
    }

    // MARK: Fase 6 · Salida

    static func exit(_ t: Double) -> (scale: Double, opacity: Double) {
        let p = easeInOut(progress(t, exitStart, total))
        return (1 + 0.06 * p, 1 - p)
    }

    /// Reloj de la coreografía (función pura).
    /// - short: arranque en frío por un enlace → empieza en la fase 4 y dura ≤ 1,2 s.
    /// - readyAt: segundo (del reloj real) en que la app quedó lista; nil = aún carga →
    ///   se detiene al inicio de la salida hasta que esté lista (máx. 6 s).
    /// - skip: adelanto por un toque del usuario.
    static func clock(elapsed: Double, short: Bool, readyAt: Double?, skip: Double = 0) -> Double {
        let speed = short ? (total - shortStart) / shortDuration : 1
        let raw = (short ? shortStart : 0) + elapsed * speed + skip
        // Momento (reloj real) en que la coreografía llega a la salida.
        let reachExit = (exitStart - (short ? shortStart : 0) - skip) / speed
        let release = readyAt.map { max($0, reachExit) } ?? (elapsed >= maxWait ? max(maxWait, reachExit) : nil)
        guard raw > exitStart else { return raw }
        guard let release else { return exitStart }
        return exitStart + max(0, elapsed - release) * speed
    }

    /// Reduce Motion: solo el logo con fundido de 0,4 s.
    static func reducedOpacity(_ elapsed: Double) -> Double { clamp(elapsed / 0.4) }
}

/// Splash animado dibujado con Canvas + TimelineView (60 fps, sin GIF ni video).
struct AnimatedSplashView: View {
    /// true cuando ya hay algo que mostrar (sesión cargada o login).
    var ready: Bool
    /// Arranque en frío por un enlace.
    var short: Bool
    /// Recibe cuánto estuvo en pantalla (segundos).
    var onFinish: (Double) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var start = Date()
    @State private var skip: Double = 0
    @State private var readyAt: Double?
    @State private var soundPlayed = false
    @State private var hapticDone = false
    @State private var finished = false
    /// Solo pruebas: congela el fotograma en este instante (argumento -TCSplashFreeze <s>).
    private let freeze: Double? = AppConfig.launchValue("TCSplashFreeze").flatMap(Double.init)

    private var background: Color { scheme == .dark ? Color(hex: 0x161413) : Color(hex: 0xFDFAF7) }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: finished)) { ctx in
            let elapsed = ctx.date.timeIntervalSince(start)
            let t = freeze ?? currentTime(elapsed)
            GeometryReader { geo in
                ZStack {
                    background
                    if reduceMotion {
                        reduced(geo.size, elapsed: elapsed)
                    } else {
                        Canvas { g, size in draw(&g, size: size, t: t) }
                        slogan(geo.size, t: t)
                    }
                }
                .scaleEffect(reduceMotion ? 1 : SplashTimeline.exit(t).scale)
                .opacity(reduceMotion ? (ready && elapsed > 0.8 ? max(0, 1 - (elapsed - 0.8) / 0.3) : 1) : SplashTimeline.exit(t).opacity)
            }
            .onChange(of: ctx.date) { _, _ in tick(t: t, elapsed: elapsed) }
        }
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture {
            let now = Date().timeIntervalSince(start)
            let t = SplashTimeline.clock(elapsed: now, short: short, readyAt: readyAt, skip: skip)
            if t < SplashTimeline.exitStart { skip += SplashTimeline.exitStart - t }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("TieComs. " + L("splash.line1") + " " + L("splash.line2"))
        .accessibilityIdentifier("splash")
        .onAppear {
            start = Date()
            AppFeedback.shared.sounds.configure()
            Haptics.prepare()
        }
    }

    private func currentTime(_ elapsed: Double) -> Double {
        SplashTimeline.clock(elapsed: elapsed, short: short, readyAt: readyAt, skip: skip)
    }

    private func tick(t: Double, elapsed: Double) {
        guard freeze == nil, !finished else { return }
        if ready && readyAt == nil { readyAt = elapsed }
        if !reduceMotion, !short, !soundPlayed, t >= SplashTimeline.soundAt { soundPlayed = true; AppFeedback.shared.playSplash() }
        if !reduceMotion, !hapticDone, t >= SplashTimeline.hapticAt { hapticDone = true; Haptics.tap() }
        let done = reduceMotion ? (ready && elapsed > 1.1) || elapsed > SplashTimeline.maxWait
                                : t >= SplashTimeline.total || elapsed > SplashTimeline.maxWait + 0.4
        if done { finished = true; onFinish(elapsed) }
    }

    // MARK: Dibujo

    private func logoRect(_ size: CGSize) -> CGRect {
        let w = min(size.width * 0.78, 420)
        let h = w * 484 / 2380
        // El nudo del logo queda en el centro de la pantalla (ahí se amarra la cuerda).
        let origin = CGPoint(x: size.width / 2 - SplashTimeline.knot.x * w, y: size.height / 2 - SplashTimeline.knot.y * h)
        return CGRect(origin: origin, size: CGSize(width: w, height: h))
    }

    private func nodePoint(_ n: SplashTimeline.Node, _ size: CGSize, tie: Double, rot: Double) -> CGPoint {
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        var dx = n.x * size.width * (1 - tie), dy = n.y * size.height * (1 - tie)
        let a = rot * .pi / 180
        (dx, dy) = (dx * cos(a) - dy * sin(a), dx * sin(a) + dy * cos(a))
        return CGPoint(x: c.x + dx, y: c.y + dy)
    }

    /// Catmull-Rom → Bézier cúbicas por los puntos.
    private func ropePath(_ pts: [CGPoint]) -> Path {
        var p = Path()
        guard pts.count > 1 else { return p }
        p.move(to: pts[0])
        for i in 0..<(pts.count - 1) {
            let p0 = pts[max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[min(i + 2, pts.count - 1)]
            let c1 = CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6)
            let c2 = CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6)
            p.addCurve(to: p2, control1: c1, control2: c2)
        }
        return p
    }

    private func draw(_ g: inout GraphicsContext, size: CGSize, t: Double) {
        let tie = SplashTimeline.tie(t)
        let rot = SplashTimeline.tieRotation(t)
        let pts = SplashTimeline.nodes.map { nodePoint($0, size, tie: tie, rot: rot) }
        let nodeAlpha = SplashTimeline.nodeOpacity(t)

        // Cuerda
        let rope = SplashTimeline.rope(t)
        if rope > 0 && nodeAlpha > 0.01 {
            let path = ropePath(pts).trimmedPath(from: 0, to: rope)
            var rg = g
            rg.opacity = nodeAlpha
            rg.stroke(path, with: .color(Color(hex: 0xC95A00)), style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
            rg.stroke(path, with: .color(Theme.orange), style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
        }

        // Personas
        if nodeAlpha > 0.01 {
            for (i, n) in SplashTimeline.nodes.enumerated() {
                let s = SplashTimeline.nodeScale(i, t) * (1 - 0.5 * tie)
                guard s > 0.01 else { continue }
                var ng = g
                ng.opacity = nodeAlpha
                let r = 22 * s
                let pt = pts[i]
                let ring = SplashTimeline.ring(i, t)
                if ring.opacity > 0 {
                    let rr = (r + 5) * ring.scale
                    ng.stroke(Path(ellipseIn: CGRect(x: pt.x - rr, y: pt.y - rr, width: 2 * rr, height: 2 * rr)), with: .color(Theme.orange), lineWidth: 3)
                }
                var sg = ng
                sg.addFilter(.shadow(color: .black.opacity(0.18), radius: 6, x: 0, y: 3))
                sg.fill(Path(ellipseIn: CGRect(x: pt.x - r, y: pt.y - r, width: 2 * r, height: 2 * r)), with: .color(Color(hex: n.color)))
                ng.draw(Text(n.initials).font(.system(size: 15 * s, weight: .bold)).foregroundColor(.white), at: pt)
                if s > 0.6 {
                    ng.draw(Text(n.org).font(.system(size: 11)).foregroundColor(Color(hex: 0x8A837A)), at: CGPoint(x: pt.x, y: pt.y + r + 11))
                }
            }
        }

        // Logo
        let rect = logoRect(size)
        let knot = CGPoint(x: rect.minX + SplashTimeline.knot.x * rect.width, y: rect.minY + SplashTimeline.knot.y * rect.height)
        let pulse = SplashTimeline.pulse(t)
        if pulse.opacity > 0 {
            let r = 12 + pulse.radius * rect.width * 0.26
            g.fill(Path(ellipseIn: CGRect(x: knot.x - r, y: knot.y - r, width: 2 * r, height: 2 * r)), with: .color(Theme.orange.opacity(pulse.opacity)))
        }
        for k in 0..<SplashTimeline.sparkCount {
            let s = SplashTimeline.spark(k, t)
            guard s.opacity > 0 else { continue }
            let p = CGPoint(x: knot.x + s.dx * rect.width, y: knot.y + s.dy * rect.width)
            let r = 3.0
            g.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)), with: .color(Theme.orangeLight.opacity(s.opacity)))
        }
        let ink = SplashTimeline.inkReveal(t)
        if ink > 0 {
            var ig = g
            ig.clip(to: Path(CGRect(x: rect.minX - 4, y: rect.minY - 20, width: (rect.width + 8) * ink, height: rect.height + 40)))
            ig.draw(Image("WordmarkInk"), in: rect)
        }
        let orange = SplashTimeline.orangeLayer(t)
        if orange.opacity > 0 {
            var og = g
            og.opacity = orange.opacity
            og.translateBy(x: knot.x, y: knot.y)
            og.scaleBy(x: orange.scale, y: orange.scale)
            og.translateBy(x: -knot.x, y: -knot.y)
            og.draw(Image("WordmarkOrange"), in: rect)
        }
    }

    @ViewBuilder
    private func slogan(_ size: CGSize, t: Double) -> some View {
        let rect = logoRect(size)
        let a = SplashTimeline.tagline(t), b = SplashTimeline.lines(t)
        VStack(spacing: 6) {
            Text(L("splash.tagline"))
                .font(.system(size: 15))
                .foregroundStyle(Color(hex: 0x8A837A))
                .opacity(a.opacity).offset(y: a.offset)
            VStack(spacing: 2) {
                Text(L("splash.line1")).font(.system(size: 22, weight: .semibold)).foregroundStyle(scheme == .dark ? Theme.cream : Theme.ink)
                Text(L("splash.line2")).font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.orange)
            }
            .padding(.top, 14)
            .opacity(b.opacity).offset(y: b.offset)
            if !ready && t >= SplashTimeline.exitStart {
                WaitingDot().padding(.top, 14)
            }
        }
        .multilineTextAlignment(.center)
        .frame(width: size.width - 32)
        .position(x: size.width / 2, y: rect.maxY + 70)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }

    private func reduced(_ size: CGSize, elapsed: Double) -> some View {
        let rect = logoRect(size)
        return Image("Wordmark").resizable().scaledToFit()
            .frame(width: rect.width)
            .position(x: rect.midX, y: rect.midY)
            .opacity(SplashTimeline.reducedOpacity(elapsed))
    }
}

/// Punto naranja que late mientras la app termina de cargar.
private struct WaitingDot: View {
    @State private var on = false
    var body: some View {
        Circle().fill(Theme.orange).frame(width: 10, height: 10)
            .scaleEffect(on ? 1.35 : 0.8).opacity(on ? 1 : 0.5)
            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
    }
}
