import AuthenticationServices
import SwiftUI

/// The official native control remains visible while the server prepares its one-use challenge.
struct AppleSignInButton: UIViewRepresentable {
    @Environment(\.colorScheme) private var colorScheme
    var signingUp = false
    var continuing = false
    var enabled: Bool
    var identifier: String
    var action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(action: action, enabled: enabled) }
    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let type: ASAuthorizationAppleIDButton.ButtonType = continuing ? .continue : signingUp ? .signUp : .signIn
        let button = ASAuthorizationAppleIDButton(type: type, style: colorScheme == .dark ? .white : .black)
        button.cornerRadius = 14
        button.addTarget(context.coordinator, action: #selector(Coordinator.tap), for: .touchUpInside)
        button.accessibilityIdentifier = identifier
        return button
    }
    func updateUIView(_ button: ASAuthorizationAppleIDButton, context: Context) {
        context.coordinator.action = action
        context.coordinator.enabled = enabled
        button.isEnabled = enabled
        button.isUserInteractionEnabled = enabled
        button.accessibilityTraits = enabled ? [.button] : [.button, .notEnabled]
        button.alpha = enabled ? 1 : 0.5
    }
    final class Coordinator: NSObject {
        var action: () -> Void
        var enabled: Bool
        init(action: @escaping () -> Void, enabled: Bool) { self.action = action; self.enabled = enabled }
        @objc func tap() { guard enabled else { return }; action() }
    }
}

struct AppleAccountLinkSection: View {
    @Environment(AppStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @State private var error: String?
    @State private var completed = false

    var body: some View {
        Section {
            Text(L("auth.appleLinkHint")).font(.footnote).foregroundStyle(Theme.textSecondary)
            AppleSignInButton(continuing: true, enabled: !store.appleSignInBusy, identifier: "settings.apple.link") {
                error = nil
                completed = false
                Task {
                    do {
                        completed = try await store.loginWithApple(linking: true)
                    } catch { self.error = appleErrorText(error) }
                }
            }
            .disabled(store.appleSignInBusy)
            .id(colorScheme)
            .frame(height: 50)
            if store.appleSignInBusy { ProgressView(L("common.wait")) }
            if completed { Label(L("auth.appleLinked"), systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
        } header: { Text(L("auth.appleLinkTitle")) }
    }
}

func appleErrorText(_ error: Error) -> String {
    error is AppleSignInError ? L("err.apple_signin_failed") : L10n.errorText(error)
}
