import UIKit

/// Hoja de tarea nueva pedida desde la extensión Compartir: archivos y texto ya puestos; se elige el grupo.
struct ShareTaskRequest: Identifiable, Equatable {
    let id: String
    var files: [LocalAttachment]
    var text: String?
    /// Título sugerido: el nombre del primer archivo (sin extensión) o la primera línea del texto.
    var title: String {
        if let f = files.first { return TaskAttachmentRules.title(fromFileName: f.name) }
        let line = (text ?? "").split(separator: "\n").first.map(String.init) ?? ""
        return String(line.prefix(200))
    }
}

@MainActor
extension AppStore {
    /// Lo que dejó la extensión (chaggu://handoff/<id> o, si iOS no abrió la app, al volver al frente).
    func runShareHandoff(_ id: String) {
        guard status == .ready else { rememberAfterLogin(.handoff(id)); return }
        guard let (h, files) = ShareHandoffStore.load(id) else { return }
        ShareHandoffStore.consume(id)
        // Lo que esté abierto encima (un visor, una hoja) taparía la hoja nueva: se cierra primero.
        Self.dismissPresented { [self] in
            switch h.action {
            case .task:
                shareTask = ShareTaskRequest(id: id, files: files, text: h.text)
            case .sign:
                guard let att = h.attachment else { return }
                if let c = h.conversationId { navigate(to: .conversation(c)) }
                shareSign = att
            }
        }
    }

    private static func dismissPresented(then: @escaping () -> Void) {
        let root = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
        guard let presented = root?.presentedViewController else { then(); return }
        presented.dismiss(animated: true) { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: then) }
    }

    /// Al volver al frente: retoma un pedido de la extensión que no alcanzó a abrir la app (menos de 15 min).
    func resumePendingShareHandoff() {
        guard status == .ready, shareTask == nil, shareSign == nil, let id = ShareHandoffStore.latestPending() else { return }
        runShareHandoff(id)
    }
}
