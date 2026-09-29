import SwiftUI

/// Franja fija «✨ Actualización disponible · chaggu X» con «Actualizar». No se cierra: se va sola al instalar la
/// versión nueva. Va encima del contenido en la misma columna (lo empuja; no tapa el chat ni la cabecera).
struct UpdateBanner: View {
    let info: AppVersionInfo
    var onUpdate: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text("✨ \(L("update.available")) · chaggu \(info.latestVersion)")
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1).minimumScaleFactor(0.8)
                if let notes = info.notes {
                    Text(notes).font(.caption2).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Button(L("update.action"), action: onUpdate)
                .font(.footnote.weight(.bold))
                .foregroundStyle(Theme.onPrimary)
                .padding(.horizontal, 14).frame(minHeight: 32)
                .background(Capsule().fill(Theme.primaryFill))
                .buttonStyle(.plain)
                .accessibilityIdentifier("update.button")
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
        .frame(maxWidth: .infinity)
        // El color sube bajo la barra de estado; el texto respeta el área segura.
        .background(Theme.orange.opacity(0.14).background(Theme.surface).ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.orange.opacity(0.35)).frame(height: 0.5) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("update.banner")
    }
}

/// Build por debajo de minBuild: pantalla completa que bloquea hasta actualizar.
struct UpdateBlockedView: View {
    let info: AppVersionInfo
    var onUpdate: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "arrow.down.app.fill").font(.system(size: 56)).foregroundStyle(Theme.orange).accessibilityHidden(true)
            Text(L("update.blocked")).font(.title3.weight(.semibold)).multilineTextAlignment(.center).foregroundStyle(Theme.textPrimary)
            if let notes = info.notes { Text(notes).font(.footnote).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center) }
            Spacer()
            Button(L("update.action"), action: onUpdate).buttonStyle(PrimaryButtonStyle()).accessibilityIdentifier("update.button")
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .accessibilityIdentifier("update.blocked")
    }
}
