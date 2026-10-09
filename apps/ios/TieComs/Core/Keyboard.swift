import SwiftUI
import UIKit

/// Cierre del teclado en toda la app (y en la extensión de compartir):
/// - tocar fuera de un campo de texto cierra el teclado (reconocedor en la ventana, no roba toques);
/// - los campos de formulario llevan un botón «Listo» en la barra del teclado;
/// - las listas lo cierran al deslizar (`.scrollDismissesKeyboard(.interactively)` en la raíz).
/// El compositor del chat se maneja aparte (su lista de mensajes lo cierra al tocar o deslizar),
/// así tocar «Enviar» o elegir una mención no cierra el teclado.
enum KeyboardPolicy {
    /// Identificador del compositor del chat (`ComposerTextView`).
    static let composerId = "composer.field"

    /// ¿Un toque en la ventana debe cerrar el teclado? (función pura)
    static func shouldDismissOnTap(editing: Bool, editorIsComposer: Bool, touchInTextInput: Bool) -> Bool {
        editing && !editorIsComposer && !touchInTextInput
    }

    /// ¿Este editor lleva el botón «Listo»? Buscadores (su tecla «Buscar» ya cierra) y el compositor no.
    static func wantsDoneBar(isSearchField: Bool, isComposer: Bool, isEditable: Bool) -> Bool {
        isEditable && !isSearchField && !isComposer
    }
}

/// Sigue qué campo está editándose y le pone la barra «Listo».
@MainActor
final class KeyboardTracker {
    static let shared = KeyboardTracker()
    private(set) weak var editor: UIView?
    private var installed = false

    func install() {
        guard !installed else { return }
        installed = true
        let nc = NotificationCenter.default
        for name in [UITextField.textDidBeginEditingNotification, UITextView.textDidBeginEditingNotification] {
            nc.addObserver(forName: name, object: nil, queue: .main) { n in
                let view = n.object as? UIView
                MainActor.assumeIsolated { KeyboardTracker.shared.began(view) }
            }
        }
        for name in [UITextField.textDidEndEditingNotification, UITextView.textDidEndEditingNotification] {
            nc.addObserver(forName: name, object: nil, queue: .main) { n in
                let view = n.object as? UIView
                MainActor.assumeIsolated { KeyboardTracker.shared.ended(view) }
            }
        }
    }

    var editorIsComposer: Bool { editor?.accessibilityIdentifier == KeyboardPolicy.composerId }

    private func began(_ view: UIView?) {
        editor = view
        if let f = view as? UITextField {
            guard KeyboardPolicy.wantsDoneBar(isSearchField: f is UISearchTextField, isComposer: false, isEditable: f.isEnabled),
                  Self.replaceable(f.inputAccessoryView) else { return }
            f.inputAccessoryView = Self.doneBar()
            f.reloadInputViews()
        } else if let t = view as? UITextView {
            guard KeyboardPolicy.wantsDoneBar(isSearchField: false, isComposer: t.accessibilityIdentifier == KeyboardPolicy.composerId, isEditable: t.isEditable),
                  Self.replaceable(t.inputAccessoryView) else { return }
            t.inputAccessoryView = Self.doneBar()
            t.reloadInputViews()
        }
    }

    private func ended(_ view: UIView?) {
        if editor === view { editor = nil }
    }

    /// Sin barra propia: nil, o el generador vacío (alto 0) que SwiftUI pone cuando no hay `.toolbar(.keyboard)`.
    private static func replaceable(_ acc: UIView?) -> Bool {
        guard let acc else { return true }
        return acc.frame.height == 0 && NSStringFromClass(type(of: acc)).contains("InputAccessoryGenerator")
    }

    private static func doneBar() -> UIView {
        let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        let done = UIBarButtonItem(title: L("common.done"), primaryAction: UIAction { _ in
            KeyboardTracker.shared.editor?.endEditing(true)
            KeyboardTracker.shared.editor?.resignFirstResponder()
        })
        done.style = .done
        done.accessibilityIdentifier = "keyboard.done"
        bar.items = [UIBarButtonItem(systemItem: .flexibleSpace), done]
        bar.sizeToFit()
        return bar
    }
}

/// Toque en cualquier parte de la ventana fuera de un campo de texto → cierra el teclado.
/// No cancela ni retrasa los toques: botones, menús y gestos siguen funcionando igual.
final class KeyboardDismissTap: UITapGestureRecognizer, UIGestureRecognizerDelegate {
    init() {
        super.init(target: nil, action: nil)
        addTarget(self, action: #selector(fire))
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
        name = "chaggu.keyboardDismiss"
    }

    @objc private func fire() {
        guard state == .ended else { return }
        MainActor.assumeIsolated { _ = KeyboardTracker.shared.editor?.resignFirstResponder() }
        view?.endEditing(true)
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        MainActor.assumeIsolated {
            let tracker = KeyboardTracker.shared
            var inInput = false
            var v: UIView? = touch.view
            while let cur = v { if cur is UITextField || cur is UITextView { inInput = true; break }; v = cur.superview }
            return KeyboardPolicy.shouldDismissOnTap(editing: tracker.editor != nil, editorIsComposer: tracker.editorIsComposer, touchInTextInput: inInput)
        }
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

/// Instala el reconocedor en la ventana que aloja la vista (sirve también en la extensión, sin UIApplication.shared).
private struct KeyboardDismissInstaller: UIViewRepresentable {
    final class Probe: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let w = window, !(w.gestureRecognizers ?? []).contains(where: { $0 is KeyboardDismissTap }) else { return }
            w.addGestureRecognizer(KeyboardDismissTap())
        }
    }
    func makeUIView(context: Context) -> Probe {
        MainActor.assumeIsolated { KeyboardTracker.shared.install() }
        let p = Probe(); p.isUserInteractionEnabled = false; p.isAccessibilityElement = false
        return p
    }
    func updateUIView(_ uiView: Probe, context: Context) {}
}

extension View {
    /// Raíz de la app o de la extensión: el teclado se cierra al deslizar listas, al tocar fuera y con «Listo».
    func keyboardDismissable() -> some View {
        self
            .scrollDismissesKeyboard(.interactively)
            .background(KeyboardDismissInstaller().frame(width: 0, height: 0).accessibilityHidden(true))
    }
}
