import SwiftUI

/// Splash de Chaggu: el logo sobre tinta (#17161F) con un fundido corto y el eslogan.
/// Estático y simple; los tiempos son funciones puras (segundos) para poder probarlos.
enum SplashTimeline {
    /// Entrada del logo (fundido + leve escala).
    static let logoIn = 0.35
    /// Entrada del eslogan.
    static let taglineStart = 0.20
    static let taglineEnd = 0.60
    static let soundAt = 0.10
    static let hapticAt = 0.35
    static let exitStart = 1.10
    static let total = 1.40
    /// Arranque en frío por un enlace: se salta la entrada (dura ≤ 1,1 s).
    static let shortStart = 0.35
    static let maxWait = 6.0

    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
    static func progress(_ t: Double, _ a: Double, _ b: Double) -> Double { clamp((t - a) / (b - a)) }
    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
    static func easeInOut(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }

    static func logo(_ t: Double) -> (scale: Double, opacity: Double) {
        let p = easeOut(progress(t, 0, logoIn))
        return (0.92 + 0.08 * p, p)
    }

    static func tagline(_ t: Double) -> (opacity: Double, offset: Double) {
        let p = easeOut(progress(t, taglineStart, taglineEnd))
        return (p, 8 * (1 - p))
    }

    static func exit(_ t: Double) -> (scale: Double, opacity: Double) {
        let p = easeInOut(progress(t, exitStart, total))
        return (1 + 0.04 * p, 1 - p)
    }

    /// Reloj del splash (función pura).
    /// - short: arranque en frío por un enlace → empieza con el logo ya visible.
    /// - readyAt: segundo (del reloj real) en que la app quedó lista; nil = aún carga →
    ///   se detiene al inicio de la salida hasta que esté lista (máx. 6 s).
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

    /// Reduce Motion: solo el logo con fundido de 0,4 s.
    static func reducedOpacity(_ elapsed: Double) -> Double { clamp(elapsed / 0.4) }
}

/// Splash de arranque en frío (sin GIF ni video): logo de Chaggu y eslogan sobre tinta.
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

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: finished)) { ctx in
            let elapsed = ctx.date.timeIntervalSince(start)
            let t = freeze ?? SplashTimeline.clock(elapsed: elapsed, short: short, readyAt: readyAt, skip: skip)
            let logo = SplashTimeline.logo(t)
            let tag = SplashTimeline.tagline(t)
            let exit = SplashTimeline.exit(t)
            GeometryReader { geo in
                ZStack {
                    Theme.ink
                    VStack(spacing: 0) {
                        Image("Logo").resizable().scaledToFit()
                            .frame(width: min(geo.size.width * 0.7, 380))
                            .scaleEffect(reduceMotion ? 1 : logo.scale)
                            .opacity(reduceMotion ? SplashTimeline.reducedOpacity(elapsed) : logo.opacity)
                        VStack(spacing: 6) {
                            Text(L("splash.tagline")).font(.system(size: 15)).foregroundStyle(Color(hex: 0xA8A29A))
                            VStack(spacing: 2) {
                                Text(L("splash.line1")).font(.system(size: 22, weight: .semibold)).foregroundStyle(Color(hex: 0xF6F3EC))
                                Text(L("splash.line2")).font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.orange)
                            }
                            .padding(.top, 10)
                            if !ready && t >= SplashTimeline.exitStart { WaitingDot().padding(.top, 14) }
                        }
                        .opacity(reduceMotion ? 1 : tag.opacity).offset(y: reduceMotion ? 0 : tag.offset)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.top, 20)
                        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                    }
                }
                .scaleEffect(reduceMotion ? 1 : exit.scale)
                .opacity(reduceMotion ? (ready && elapsed > 0.8 ? max(0, 1 - (elapsed - 0.8) / 0.3) : 1) : exit.opacity)
            }
            .onChange(of: ctx.date) { _, _ in tick(t: t, elapsed: elapsed) }
        }
        // El splash siempre va sobre tinta: se usan las variantes oscuras de los recursos.
        .environment(\.colorScheme, .dark)
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture {
            let now = Date().timeIntervalSince(start)
            let t = SplashTimeline.clock(elapsed: now, short: short, readyAt: readyAt, skip: skip)
            if t < SplashTimeline.exitStart { skip += SplashTimeline.exitStart - t }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Chaggu. " + L("splash.line1") + " " + L("splash.line2"))
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
        if !reduceMotion, !short, !soundPlayed, t >= SplashTimeline.soundAt { soundPlayed = true; AppFeedback.shared.playSplash() }
        if !reduceMotion, !hapticDone, t >= SplashTimeline.hapticAt { hapticDone = true; Haptics.tap() }
        let done = reduceMotion ? (ready && elapsed > 1.1) || elapsed > SplashTimeline.maxWait
                                : t >= SplashTimeline.total || elapsed > SplashTimeline.maxWait + 0.4
        if done { finished = true; onFinish(elapsed) }
    }
}

/// Punto mandarina que late mientras la app termina de cargar.
private struct WaitingDot: View {
    @State private var on = false
    var body: some View {
        Circle().fill(Theme.orange).frame(width: 10, height: 10)
            .scaleEffect(on ? 1.35 : 0.8).opacity(on ? 1 : 0.5)
            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
    }
}
