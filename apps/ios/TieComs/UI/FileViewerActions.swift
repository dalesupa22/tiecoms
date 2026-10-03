import SwiftUI

/// Acciones del visor de un archivo (1.7.14): «✨ Preguntar a gg» (gg de ese chat citando el mensaje del archivo),
/// «Crear tarea» (en ese chat, con el nombre del archivo como título y el archivo ya adjunto) y «Compartir» (hoja del
/// sistema o reenviar el mensaje a otro chat de chaggu). nil = el visor no las muestra (p. ej. sin chat).
struct FileViewerActions {
    /// Cierra el visor y abre gg del chat citando el mensaje.
    var askGg: (() -> Void)?
    /// Chat donde crear la tarea (nil = sin «Crear tarea»).
    var taskConversationId: String?
    /// El mensaje que trae el archivo: origen de la tarea y lo que se reenvía.
    var origin: MessageDTO?
}

/// El chat pasa por el entorno cómo abrir gg citando un mensaje (los visores están dentro de AttachmentsBlock).
private struct AskGgAboutMessageKey: EnvironmentKey { static let defaultValue: ((String) -> Void)? = nil }
extension EnvironmentValues {
    var askGgAboutMessage: ((String) -> Void)? {
        get { self[AskGgAboutMessageKey.self] }
        set { self[AskGgAboutMessageKey.self] = newValue }
    }
}

/// Barra inferior del visor: gg, tarea y compartir. `dark` en el visor de fotos (fondo negro).
struct FileViewerActionBar: View {
    @Environment(AppStore.self) private var store
    let att: AttachmentDTO
    let actions: FileViewerActions
    var dark = false
    @State private var sharing: URL?
    @State private var loading = false
    /// La tarea y el reenvío se abren encima del visor (sin cerrarlo).
    @State private var creatingTask = false
    @State private var forwarding: MessageDTO?

    var body: some View {
        HStack(spacing: 0) {
            if let ask = actions.askGg, store.ggSide.available != false {
                item("sparkles", L("ggs.askPlain"), id: "viewer.askGg", action: ask)
            }
            if actions.taskConversationId != nil {
                item("checklist", L("viewer.createTask"), id: "viewer.createTask") { creatingTask = true }
            }
            Menu {
                Button { shareSystem() } label: { Label(L("viewer.shareSystem"), systemImage: "square.and.arrow.up") }
                    .accessibilityIdentifier("viewer.shareSystem")
                if let origin = actions.origin {
                    Button { forwarding = origin } label: { Label(L("viewer.forward"), systemImage: "arrowshape.turn.up.right") }
                        .accessibilityIdentifier("viewer.forward")
                }
            } label: {
                label(loading ? nil : "square.and.arrow.up", L("viewer.share"))
            }
            .accessibilityIdentifier("viewer.share")
        }
        .padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 4)
        .background(dark ? AnyShapeStyle(Color.black.opacity(0.85)) : AnyShapeStyle(.bar))
        .sheet(item: Binding(get: { sharing.map(ViewerURLBox.init) }, set: { sharing = $0?.url })) { ActivityView(items: [$0.url]) }
        .sheet(isPresented: $creatingTask) {
            NewIssueSheet(conversationId: actions.taskConversationId, origin: actions.origin,
                          prefill: GgPrefill(title: TaskAttachmentRules.title(fromFileName: att.name)), attachFrom: [att])
                .environment(store)
        }
        .sheet(item: $forwarding) { m in ForwardSheet(source: m).environment(store) }
    }

    private func item(_ icon: String, _ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { label(icon, title) }
            .buttonStyle(.plain)
            .accessibilityIdentifier(id)
    }

    private func label(_ icon: String?, _ title: String) -> some View {
        VStack(spacing: 3) {
            if let icon { Image(systemName: icon).font(.system(size: 19, weight: .semibold)) } else { ProgressView().frame(height: 22) }
            Text(title).font(.caption2.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
        }
        .foregroundStyle(dark ? Color.white : Theme.accentText)
        .frame(maxWidth: .infinity, minHeight: 48)
        .contentShape(Rectangle())
    }

    private func shareSystem() {
        loading = true
        Task {
            defer { loading = false }
            do { sharing = try await AttachmentCache.shared.fileURL(att, api: store.api) } catch { store.show(L10n.errorText(error)) }
        }
    }
}

struct ViewerURLBox: Identifiable { let url: URL; var id: String { url.absoluteString } }

/// Quick Look de un archivo con la barra de acciones debajo.
struct FileQuickLookScreen: View {
    let url: URL
    let att: AttachmentDTO?
    let actions: FileViewerActions?
    var body: some View {
        VStack(spacing: 0) {
            QuickLookView(url: url)
            if let att, let actions { FileViewerActionBar(att: att, actions: actions) }
        }
        .ignoresSafeArea(edges: .top)
    }
}
