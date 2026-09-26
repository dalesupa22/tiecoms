import SwiftUI

/// Splash de Chaggu: la «ignición» del símbolo sobre tinta (#17161F).
/// Empieza idéntico a la Launch Screen del sistema (símbolo sin rayitas, 200 pt, centrado),
/// la burbuja mandarina hace un «pop», aparecen las rayitas y luego el eslogan.
/// Los tiempos son funciones puras (segundos) para poder probarlos.
enum SplashTimeline {
    /// Lado del símbolo en puntos (igual que `LaunchSymbol` en la Launch Screen).
    static let symbolSide = 200.0
    /// 0–0,25 s: quieto (capas 1 y 2, como la Launch Screen).
    static let holdEnd = 0.25
    /// «Pop» de la burbuja mandarina: 1 → 1,10 → 1, anclado en el centro de la propia burbuja
    /// (así no tapa la separación con la burbuja papel).
    static let popStart = 0.20
    static let popEnd = 0.55
    static let popPeak = 0.10
    /// Centro de la burbuja mandarina en coordenadas unitarias del lienzo.
    static let popAnchor = (x: 0.609, y: 0.340)
    /// Rayitas: opacidad 0→1 y escala 0,4→1 ancladas en su punto de origen.
    static let sparksStart = 0.35
    static let sparksEnd = 0.70
    /// Punto de origen de las rayitas en coordenadas unitarias del lienzo (esquina superior derecha).
    static let sparksAnchor = (x: 0.83, y: 0.17)
    /// Sonido `tc_splash` y háptico ligero: cuando aparecen las rayitas.
    static let soundAt = 0.35
    static let hapticAt = 0.35
    /// Eslogan: sube 8 pt y llega a opacidad 0,8.
    static let taglineStart = 0.55
    static let taglineEnd = 0.95
    static let taglineOpacity = 0.8
    static let taglineRise = 8.0
    /// Salida (fundido + leve escala), solo cuando la app está lista.
    static let exitStart = 1.30
    static let total = 1.60
    /// Arranque en frío por un enlace: versión corta.
    static let shortStart = 0.70
    static let maxWait = 6.0

    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
    static func progress(_ t: Double, _ a: Double, _ b: Double) -> Double { clamp((t - a) / (b - a)) }
    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
    static func easeInOut(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
    /// Ease out «back»: pasa un poco de 1 y regresa (sin rebote en los extremos: 0→0, 1→1).
    static func easeOutBack(_ x: Double) -> Double {
        let c1 = 1.70158, c3 = c1 + 1
        return 1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2)
    }

    /// Escala de la burbuja mandarina: 1 → 1,10 → 1.
    static func pop(_ t: Double) -> Double {
        let p = progress(t, popStart, popEnd)
        return 1 + popPeak * sin(.pi * easeOut(p))
    }

    /// Rayitas: opacidad y escala (0,4 → 1 con un leve «back»).
    static func sparks(_ t: Double) -> (opacity: Double, scale: Double) {
        let p = progress(t, sparksStart, sparksEnd)
        return (easeOut(p), 0.4 + 0.6 * easeOutBack(p))
    }

    /// Eslogan: opacidad (0 → 0,8) y desplazamiento vertical (8 → 0 pt).
    static func tagline(_ t: Double) -> (opacity: Double, offset: Double) {
        let p = easeOut(progress(t, taglineStart, taglineEnd))
        return (taglineOpacity * p, taglineRise * (1 - p))
    }

    static func exit(_ t: Double) -> (scale: Double, opacity: Double) {
        let p = easeInOut(progress(t, exitStart, total))
        return (1 + 0.04 * p, 1 - p)
    }

    /// Reloj del splash (función pura).
    /// - short: arranque en frío por un enlace → empieza en `shortStart`.
    /// - readyAt: segundo (del reloj real) en que la app quedó lista; nil = aún carga →
    ///   se queda en el último cuadro (inicio de la salida) hasta que esté lista (máx. 6 s).
    /// - skip: adelanto por un toque del usuario.
    static func clock(elapsed: Double, short: Bool, readyAt: Double?, skip: Double = 0) -> Double {
        let offset = short ? shortStart : 0
        let raw = offset + elapsed + skip
        let reachExit = exitStart - offset - skip
        let release = readyAt.map { max($0, reachExit) } ?? (elapsed >= maxWait ? max(maxWait, reachExit) : nil)
        guard raw > exitStart else { return raw }
        guard let release else { return exitStart }
        return exitStart + max(0, elapsed - release)
    }

    // MARK: Reduce Motion: sin escalas; solo fundido del eslogan (y rayitas) y salida.
    static let reducedTaglineStart = 0.15
    static let reducedTaglineEnd = 0.55
    static let reducedMinShown = 0.9
    static let reducedExit = 0.3

    /// Opacidad del eslogan (0 → 0,8) con Reduce Motion, según el tiempo real.
    static func reducedTagline(_ elapsed: Double) -> Double {
        taglineOpacity * progress(elapsed, reducedTaglineStart, reducedTaglineEnd)
    }

    /// Opacidad de salida con Reduce Motion: se desvanece cuando la app está lista
    /// (nunca antes de `reducedMinShown`) o a los 6 s.
    static func reducedExitOpacity(elapsed: Double, readyAt: Double?) -> Double {
        let release = readyAt.map { max($0, reducedMinShown) } ?? (elapsed >= maxWait ? maxWait : nil)
        guard let release else { return 1 }
        return 1 - clamp((elapsed - release) / reducedExit)
    }
}

/// Splash de arranque en frío: ignición del símbolo de Chaggu y eslogan sobre tinta.
struct LaunchSplashView: View {
    /// true cuando ya hay algo que mostrar (sesión cargada o login).
    var ready: Bool
    /// Arranque en frío por un enlace.
    var short: Bool
    /// Recibe cuánto estuvo en pantalla (segundos).
    var onFinish: (Double) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var skip: Double = 0
    @State private var readyAt: Double?
    @State private var soundPlayed = false
    @State private var hapticDone = false
    @State private var finished = false
    /// Solo pruebas: congela el fotograma en este instante (argumento -TCSplashFreeze <s>).
    private let freeze: Double? = AppConfig.launchValue("TCSplashFreeze").flatMap(Double.init)

    private typealias T = SplashTimeline

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: finished)) { ctx in
            let elapsed = freeze ?? ctx.date.timeIntervalSince(start)
            let t = freeze ?? T.clock(elapsed: elapsed, short: short, readyAt: readyAt, skip: skip)
            let side = CGFloat(T.symbolSide)
            let reduced = reduceMotion && freeze == nil
            let pop = reduced ? 1 : T.pop(t)
            let sparks = reduced ? (opacity: T.reducedTagline(elapsed) / T.taglineOpacity, scale: 1.0) : T.sparks(t)
            let tag = reduced ? (opacity: T.reducedTagline(elapsed), offset: 0.0) : T.tagline(t)
            let exit = reduced ? (scale: 1.0, opacity: T.reducedExitOpacity(elapsed: elapsed, readyAt: readyAt)) : T.exit(t)
            ZStack {
                Theme.ink
                // Las tres capas comparten el mismo lienzo cuadrado: se apilan con el mismo frame.
                ZStack {
                    Image("SplashBubbleWhite").resizable()
                    Image("SplashBubbleOrange").resizable()
                        .scaleEffect(pop, anchor: UnitPoint(x: T.popAnchor.x, y: T.popAnchor.y))
                    Image("SplashSparks").resizable()
                        .scaleEffect(sparks.scale, anchor: UnitPoint(x: T.sparksAnchor.x, y: T.sparksAnchor.y))
                        .opacity(sparks.opacity)
                }
                .frame(width: side, height: side)
                // El eslogan va debajo sin mover el símbolo (sigue centrado como en la Launch Screen).
                .overlay(alignment: .top) {
                    Text(L("splash.tagline"))
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Color(hex: 0xF6F3EC))
                        .multilineTextAlignment(.center)
                        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                        .frame(width: 320)
                        .fixedSize(horizontal: false, vertical: true)
                        .opacity(tag.opacity)
                        .offset(y: side + 4 + tag.offset)
                }
            }
            .scaleEffect(exit.scale)
            .opacity(exit.opacity)
            .onChange(of: ctx.date) { _, _ in tick(t: t, elapsed: elapsed) }
        }
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture {
            let now = Date().timeIntervalSince(start)
            let t = T.clock(elapsed: now, short: short, readyAt: readyAt, skip: skip)
            if t < T.exitStart { skip += T.exitStart - t }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Chaggu. " + L("splash.tagline"))
        .accessibilityIdentifier("splash")
        .onAppear {
            start = Date()
            AppFeedback.shared.sounds.configure()
            Haptics.prepare()
        }
    }

    private func tick(t: Double, elapsed: Double) {
        guard freeze == nil, !finished else { return }
        if ready && readyAt == nil { readyAt = elapsed }
        // La ignición (sonido + háptico) solo en el arranque normal: la versión corta empieza después.
        if !reduceMotion, !short, !soundPlayed, t >= T.soundAt { soundPlayed = true; AppFeedback.shared.playSplash() }
        if !reduceMotion, !short, !hapticDone, t >= T.hapticAt { hapticDone = true; Haptics.tap() }
        let done = reduceMotion ? T.reducedExitOpacity(elapsed: elapsed, readyAt: readyAt) <= 0
                                : t >= T.total || elapsed > T.maxWait + 0.4
        if done { finished = true; onFinish(elapsed) }
    }
}
