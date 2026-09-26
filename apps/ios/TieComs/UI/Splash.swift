import SwiftUI

/// Splash de Chaggu sobre tinta (#17161F): «los puntitos escriben y la marca se enciende».
/// Empieza idéntico a la Launch Screen del sistema (`LaunchSymbol` = símbolo sin rayitas, 200 pt, centrado).
/// Las burbujas van sin huecos (capas 1b/2b) y los 6 puntos se dibujan encima como círculos de tinta:
/// primero titilan los 3 de la burbuja papel (como «escribiendo»), luego los de la mandarina y
/// luego aparecen las rayitas ¡pum! con un golpecito de la burbuja mandarina.
/// Los tiempos son funciones puras (segundos) para poder probarlos.
enum SplashTimeline {
    /// Lado del símbolo en puntos (igual que `LaunchSymbol` en la Launch Screen).
    static let symbolSide = 200.0

    // MARK: Puntitos (coordenadas unitarias del lienzo; chaggu-marca/definitivo/capas-splash/puntitos.txt)
    enum Bubble: CaseIterable { case white, orange }
    static let dotRadius = 0.02949
    static let dotY = 0.33974
    static let whiteDotsX = [0.14744, 0.22436, 0.30128]
    static let orangeDotsX = [0.53205, 0.60897, 0.68590]
    static func dotsX(_ b: Bubble) -> [Double] { b == .white ? whiteDotsX : orangeDotsX }

    /// 0–0,15 s: quieto, puntos llenos.
    static let holdEnd = 0.15
    /// Inicio de los pulsos de cada burbuja.
    static let whiteStart = 0.15
    static let orangeStart = 0.85
    /// Desfase entre puntos, entre olas, número de olas y duración de cada pulso.
    static let dotStagger = 0.13
    static let waveGap = 0.40
    static let waves = 2
    static let pulseDuration = 0.30
    /// En la mitad del pulso: opacidad del punto 0,25 (se aclara hacia la burbuja) y sube 0,35 radios.
    static let pulseMinOpacity = 0.25
    static let pulseRise = 0.35

    /// Instantes en que empieza cada pulso del punto `index` de la burbuja.
    static func pulseStarts(_ b: Bubble, index: Int) -> [Double] {
        let base = (b == .white ? whiteStart : orangeStart) + dotStagger * Double(index)
        return (0..<waves).map { base + waveGap * Double($0) }
    }

    /// Forma del pulso: 0 → 1 (mitad) → 0, con ease in-out en cada tramo.
    static func bump(_ p: Double) -> Double {
        guard p > 0, p < 1 else { return 0 }
        return p < 0.5 ? easeInOut(p * 2) : easeInOut(2 - p * 2)
    }

    /// Punto `index` de la burbuja: opacidad del círculo de tinta y cuánto sube (en radios).
    static func dot(_ t: Double, _ b: Bubble, index: Int, reduced: Bool = false) -> (opacity: Double, rise: Double) {
        let k = pulseStarts(b, index: index).map { bump((t - $0) / pulseDuration) }.max() ?? 0
        return (1 - (1 - pulseMinOpacity) * k, reduced ? 0 : pulseRise * k)
    }

    // MARK: ¡Pum!
    static let pumStart = 1.65
    static let pumEnd = 1.85
    /// Las rayitas aparecen del todo en los primeros 0,08 s.
    static let sparksFade = 0.08
    /// Punto de origen de las rayitas (esquina superior derecha del lienzo).
    static let sparksAnchor = (x: 0.83, y: 0.17)
    /// Centro de la burbuja mandarina: ancla del golpecito.
    static let orangeAnchor = (x: 0.609, y: 0.340)
    static let tapPeak = 0.04
    /// Sonido `tc_splash` y háptico ligero: en el ¡pum!
    static let soundAt = 1.65
    static let hapticAt = 1.65

    /// Rayitas: opacidad 0→1 en 0,08 s y escala 0,3 → 1,15 → 1,0. Reduce Motion: fundido de 0,2 s, sin escala.
    static func sparks(_ t: Double, reduced: Bool = false) -> (opacity: Double, scale: Double) {
        if reduced { return (easeInOut(progress(t, pumStart, pumEnd)), 1) }
        let u = progress(t, pumStart, pumEnd)
        let scale = u < 0.6 ? 0.3 + 0.85 * easeOut(u / 0.6) : 1.15 - 0.15 * easeInOut((u - 0.6) / 0.4)
        return (progress(t, pumStart, pumStart + sparksFade), scale)
    }

    /// Golpecito de la burbuja mandarina: 1 → 1,04 → 1 durante el ¡pum!
    static func orangeTap(_ t: Double, reduced: Bool = false) -> Double {
        reduced ? 1 : 1 + tapPeak * sin(.pi * progress(t, pumStart, pumEnd))
    }

    // MARK: Eslogan y salida
    static let taglineStart = 1.80
    static let taglineEnd = 2.15
    static let taglineOpacity = 0.8
    static let taglineRise = 8.0
    static let exitStart = 2.35
    static let total = 2.65
    /// Arranque en frío por un enlace: versión corta.
    static let shortStart = 1.55
    static let maxWait = 6.0

    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
    static func progress(_ t: Double, _ a: Double, _ b: Double) -> Double { clamp((t - a) / (b - a)) }
    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
    static func easeInOut(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }

    /// Eslogan: opacidad (0 → 0,8) y desplazamiento vertical (8 → 0 pt; 0 con Reduce Motion).
    static func tagline(_ t: Double, reduced: Bool = false) -> (opacity: Double, offset: Double) {
        let p = easeOut(progress(t, taglineStart, taglineEnd))
        return (taglineOpacity * p, reduced ? 0 : taglineRise * (1 - p))
    }

    /// Salida: fundido + leve escala (sin escala con Reduce Motion).
    static func exit(_ t: Double, reduced: Bool = false) -> (scale: Double, opacity: Double) {
        let p = easeInOut(progress(t, exitStart, total))
        return (reduced ? 1 : 1 + 0.04 * p, 1 - p)
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
            let reduced = reduceMotion
            let tap = T.orangeTap(t, reduced: reduced)
            let sparks = T.sparks(t, reduced: reduced)
            let tag = T.tagline(t, reduced: reduced)
            let exit = T.exit(t, reduced: reduced)
            ZStack {
                Theme.ink
                // Todas las capas comparten el mismo lienzo cuadrado: se apilan con el mismo frame.
                ZStack {
                    ZStack {
                        Image("SplashBubbleWhite").resizable()
                        dots(.white, t: t, side: side, reduced: reduced)
                    }
                    ZStack {
                        Image("SplashBubbleOrange").resizable()
                        dots(.orange, t: t, side: side, reduced: reduced)
                    }
                    .scaleEffect(tap, anchor: UnitPoint(x: T.orangeAnchor.x, y: T.orangeAnchor.y))
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

    /// Los 3 puntos de una burbuja: círculos de tinta (se ven como los huecos del símbolo del sistema).
    private func dots(_ b: SplashTimeline.Bubble, t: Double, side: CGFloat, reduced: Bool) -> some View {
        let r = CGFloat(T.dotRadius) * side
        return ZStack(alignment: .topLeading) {
            ForEach(Array(T.dotsX(b).enumerated()), id: \.offset) { i, x in
                let d = T.dot(t, b, index: i, reduced: reduced)
                Circle().fill(Theme.ink)
                    .frame(width: r * 2, height: r * 2)
                    .opacity(d.opacity)
                    .position(x: CGFloat(x) * side, y: CGFloat(T.dotY) * side - CGFloat(d.rise) * r)
            }
        }
        .frame(width: side, height: side)
    }

    private func tick(t: Double, elapsed: Double) {
        guard freeze == nil, !finished else { return }
        if ready && readyAt == nil { readyAt = elapsed }
        // ¡Pum! (sonido + háptico). La versión corta (enlace) empieza en 1,55 s, antes del ¡pum!, así que también suena.
        if !reduceMotion, !soundPlayed, t >= T.soundAt { soundPlayed = true; AppFeedback.shared.playSplash() }
        if !reduceMotion, !hapticDone, t >= T.hapticAt { hapticDone = true; Haptics.tap() }
        let done = t >= T.total || elapsed > T.maxWait + 0.4
        if done { finished = true; onFinish(elapsed) }
    }
}
