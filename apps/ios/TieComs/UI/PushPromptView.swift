import SwiftUI

/// Pantalla previa al permiso del sistema: explica para qué son las notificaciones.
struct PushPromptView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "bell.badge.fill").font(.system(size: 56)).foregroundStyle(Theme.orange).accessibilityHidden(true)
            Text(L("push.primerTitle")).font(.title2.weight(.bold)).multilineTextAlignment(.center)
            Text(L("push.primerBody")).font(.body).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
                .padding(.horizontal, 8)
            Spacer()
            Button {
                Prefs.pushPrompted = true
                Task { await AppFeedback.shared.requestAuthorizationIfNeeded(); dismiss() }
            } label: { Text(L("push.enable")) }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("push.allow")
            Button(L("push.later")) { Prefs.pushPrompted = true; dismiss() }
                .frame(minHeight: 44)
                .accessibilityIdentifier("push.later")
        }
        .padding(24)
        .background(Theme.background.ignoresSafeArea())
        .presentationDetents([.large])
        .interactiveDismissDisabled()
    }
}
