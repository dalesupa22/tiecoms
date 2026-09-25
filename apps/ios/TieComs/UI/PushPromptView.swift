import SwiftUI

/// Pantalla previa al permiso del sistema: explica para qué son las notificaciones.
struct PushPromptView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "bell.badge.fill").font(.system(size: 56)).foregroundStyle(Theme.orange).accessibilityHidden(true)
            Text(L("push.promptTitle")).font(.title2.weight(.bold)).multilineTextAlignment(.center)
            VStack(alignment: .leading, spacing: 12) {
                Label(L("push.promptMessages"), systemImage: "bubble.left.and.bubble.right")
                Label(L("push.promptReminders"), systemImage: "alarm")
                Label(L("push.promptControl"), systemImage: "bell.slash")
            }
            .font(.body)
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, 8)
            Spacer()
            Button {
                Prefs.pushPrompted = true
                Task { await AppFeedback.shared.requestAuthorizationIfNeeded(); dismiss() }
            } label: { Text(L("push.promptAllow")) }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("push.allow")
            Button(L("push.promptLater")) { Prefs.pushPrompted = true; dismiss() }
                .frame(minHeight: 44)
                .accessibilityIdentifier("push.later")
        }
        .padding(24)
        .background(Theme.background.ignoresSafeArea())
        .presentationDetents([.large])
        .interactiveDismissDisabled()
    }
}
