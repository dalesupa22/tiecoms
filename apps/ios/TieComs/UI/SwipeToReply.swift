import SwiftUI
import UIKit

/// Deslizar un mensaje a la derecha = responder con cita (1.7.1, como WhatsApp). Reglas puras (probadas en unitarias).
enum SwipeReplyRule {
    /// Pasado este desplazamiento (pt) se suelta y responde; al cruzarlo, háptico ligero.
    static let threshold: CGFloat = 60
    /// Tope visual de la burbuja.
    static let maxOffset: CGFloat = 96

    /// Solo empieza con movimiento claramente horizontal y hacia la derecha: así el scroll vertical nunca se pierde,
    /// aunque el dedo empiece sobre una burbuja más alta que la pantalla.
    static func shouldBegin(vx: CGFloat, vy: CGFloat) -> Bool { vx > 0 && abs(vx) > abs(vy) * 2 }

    /// La burbuja sigue al dedo hasta el umbral y luego con resistencia (30 %), sin pasar del tope.
    static func offset(_ dx: CGFloat) -> CGFloat {
        guard dx > 0 else { return 0 }
        if dx <= threshold { return dx }
        return min(maxOffset, threshold + (dx - threshold) * 0.3)
    }

    static func fires(_ dx: CGFloat) -> Bool { dx >= threshold }
}

/// Burbuja deslizable: sigue al dedo, muestra la flecha de responder y responde al soltar pasado el umbral.
/// El desplazamiento vive en esta vista (no en el chat): arrastrar no vuelve a dibujar toda la lista.
struct SwipeToReply: ViewModifier {
    var enabled: Bool
    var onReply: () -> Void
    @State private var dx: CGFloat = 0
    @State private var armed = false

    func body(content: Content) -> some View {
        if enabled {
            content
                .offset(x: SwipeReplyRule.offset(dx))
                .overlay(alignment: .leading) {
                    if dx > 6 {
                        Image(systemName: "arrowshape.turn.up.left.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.accentText)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Theme.surface).shadow(color: .black.opacity(0.12), radius: 3, y: 1))
                            .scaleEffect(armed ? 1.1 : 0.55 + 0.45 * min(1, dx / SwipeReplyRule.threshold))
                            .opacity(Double(min(1, dx / SwipeReplyRule.threshold)))
                            .offset(x: -2)
                            .accessibilityHidden(true)
                    }
                }
                .modifier(SwipeGesture(onChange: change, onEnd: end))
                .accessibilityAction(named: Text(L("menu.reply"))) { onReply() }
        } else {
            content
        }
    }

    private func change(_ x: CGFloat) {
        dx = max(0, x)
        let now = SwipeReplyRule.fires(dx)
        if now != armed {
            armed = now
            if now { Haptics.tap() }
        }
    }

    private func end(_ x: CGFloat) {
        let fire = SwipeReplyRule.fires(max(0, x))
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { dx = 0 }
        armed = false
        if fire { onReply() }
    }
}

/// iOS 18+: reconocedor de UIKit que solo empieza si el movimiento es horizontal (el scroll vertical lo espera y
/// sigue siendo del chat). En iOS 18 un `DragGesture` de SwiftUI sobre el contenido de un ScrollView se queda con los
/// toques que empiezan sobre él. iOS 17: el DragGesture simultáneo, que ahí no bloquea el scroll.
private struct SwipeGesture: ViewModifier {
    var onChange: (CGFloat) -> Void
    var onEnd: (CGFloat) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.gesture(HorizontalPan(onChange: onChange, onEnd: onEnd))
        } else {
            content.simultaneousGesture(DragGesture(minimumDistance: 24)
                .onChanged { v in if abs(v.translation.width) > abs(v.translation.height) * 2 { onChange(v.translation.width) } }
                .onEnded { v in onEnd(abs(v.translation.width) > abs(v.translation.height) * 2 ? v.translation.width : 0) })
        }
    }
}

@available(iOS 18.0, *)
private struct HorizontalPan: UIGestureRecognizerRepresentable {
    var onChange: (CGFloat) -> Void
    var onEnd: (CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let g = UIPanGestureRecognizer()
        g.maximumNumberOfTouches = 1
        g.delegate = context.coordinator
        return g
    }

    func handleUIGestureRecognizerAction(_ g: UIPanGestureRecognizer, context: Context) {
        let x = g.translation(in: g.view).x
        switch g.state {
        case .began, .changed: onChange(x)
        case .ended: onEnd(x)
        case .cancelled, .failed: onEnd(0)
        default: break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let p = g as? UIPanGestureRecognizer else { return false }
            let v = p.velocity(in: p.view)
            return SwipeReplyRule.shouldBegin(vx: v.x, vy: v.y)
        }
        /// Con el scroll: nunca a la vez. Si el movimiento es vertical este no empieza y el scroll sigue normal.
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { false }
        /// El pan del scroll espera a que este falle (falla enseguida si el movimiento es vertical).
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other.view is UIScrollView && other is UIPanGestureRecognizer && !(other.view is UITextView)
        }
    }
}
