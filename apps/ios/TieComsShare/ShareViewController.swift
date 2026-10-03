import Intents
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Extensión «Compartir en Chaggu»: fotos, videos, archivos, enlaces o texto desde cualquier app hacia
/// una o varias conversaciones (máx. 5). Usa la sesión de la app (Keychain del grupo group.com.chaggu.app)
/// y la lista de conversaciones que la app deja en el App Group. Si el usuario tocó una sugerencia de la fila
/// de arriba (INSendMessageIntent donado por la app), esa conversación llega preseleccionada.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext, opener: { [weak self] url in self?.openContainingApp(url) })
        let host = UIHostingController(rootView: ShareExtensionView(model: model).keyboardDismissable().appTextSize(TextSize.shared()))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.loadInput() }
    }

    /// Las extensiones no pueden abrir URLs directamente: se busca en la cadena de respuesta quien pueda (la app anfitriona).
    private func openContainingApp(_ url: URL) {
        var r: UIResponder? = self
        let sel = sel_registerName("openURL:")
        while let cur = r {
            if cur.responds(to: sel), !(cur is UIViewController) { _ = cur.perform(sel, with: url); break }
            r = cur.next
        }
        extensionContext?.completeRequest(returningItems: nil)
    }
}

@MainActor
@Observable
final class ShareModel {
    private let context: NSExtensionContext?
    private let opener: (URL) -> Void
    var items: [SharedItem] = []
    var loading = true
    var targets: [ShareTargets.Target] = []
    var apiURL: URL?
    var selected: [String] = []
    var suggested: String?
    var comment = ""
    var sending = false
    /// Progreso por archivo (clave: destino + archivo).
    var progress: [String: Double] = [:]
    var error: String?
    var sentCount = 0
    var sentToGroup = false

    init(context: NSExtensionContext?, opener: @escaping (URL) -> Void) {
        self.context = context
        self.opener = opener
        let saved = ShareTargets.load()
        targets = saved.targets
        apiURL = saved.apiURL
        if let intent = context?.intent as? INSendMessageIntent, let id = intent.conversationIdentifier, saved.targets.contains(where: { $0.id == id }) {
            suggested = id
            selected = [id]
        }
    }

    var hasSession: Bool { apiURL != nil && !targets.isEmpty && KeychainSecretStore(apiURL: apiURL).get() != nil }
    var text: String { ShareItems.text(of: items) }
    var attachments: [SharedItem] { items.filter(\.isAttachment) }
    var problems: [String] { ShareItems.problems(items) }
    var canSend: Bool { !selected.isEmpty && !sending && problems.isEmpty && (!attachments.isEmpty || !text.isEmpty || !comment.trimmingCharacters(in: .whitespaces).isEmpty) }

    /// Personas de los directos elegidos si se puede «Enviar en un grupo»; nil si hay grupos mezclados.
    var groupPeers: [String]? { ShareGroupRule.peers(selected: selected, in: targets) }

    func toggle(_ id: String) {
        if let i = selected.firstIndex(of: id) { selected.remove(at: i) }
        else if selected.count < AttachmentRules.maxShareTargets { selected.append(id) }
        else { error = L("share.max5") }
    }

    func loadInput() async {
        defer { loading = false }
        var out: [SharedItem] = []
        for item in (context?.inputItems as? [NSExtensionItem]) ?? [] {
            if let t = item.attributedContentText?.string, !t.isEmpty { out.append(SharedItem(kind: .text, text: t)) }
            for p in item.attachments ?? [] {
                guard let kind = ShareItems.kind(for: p.registeredTypeIdentifiers) else { continue }
                let type = ShareItems.loadType(for: kind, typeIdentifiers: p.registeredTypeIdentifiers)
                switch kind {
                case .url:
                    if let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                        if u.isFileURL, let d = try? Data(contentsOf: u) {
                            out.append(SharedItem(kind: .file, name: u.lastPathComponent, contentType: AttachmentRules.mimeType(for: u), data: d, url: u))
                        } else { out.append(SharedItem(kind: .url, url: u)) }
                    }
                case .text:
                    if let s = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String { out.append(SharedItem(kind: .text, text: s)) }
                case .image, .video, .file:
                    if let (data, name) = await Self.loadFile(p, type: type) {
                        let finalName = name ?? ShareItems.defaultName(kind: kind, type: type, index: out.count)
                        var mime = AttachmentRules.mimeType(for: type)
                        if let ext = UTType(filenameExtension: (finalName as NSString).pathExtension)?.preferredMIMEType { mime = ext }
                        out.append(SharedItem(kind: kind, name: finalName, contentType: mime, data: data))
                    }
                }
            }
        }
        items = out
    }

    /// Copia el archivo del proveedor (la URL temporal deja de existir al volver del cierre).
    private static func loadFile(_ p: NSItemProvider, type: UTType) async -> (Data, String?)? {
        await withCheckedContinuation { cont in
            _ = p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                if let url, let d = try? Data(contentsOf: url) { cont.resume(returning: (d, p.suggestedName.map { n in
                    (n as NSString).pathExtension.isEmpty ? "\(n).\(url.pathExtension)" : n } ?? url.lastPathComponent)) }
                else {
                    _ = p.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                        cont.resume(returning: data.map { ($0, p.suggestedName) })
                    }
                }
            }
        }
    }

    /// `asGroup`: crea (o retoma, si ya existe con las mismas personas) el chat grupal con las personas de los
    /// directos elegidos —el mismo POST /chats que «Mensaje nuevo» de la app— y envía ahí una sola vez.
    func send(asGroup: Bool = false) async {
        guard let apiURL, canSend else { return }
        sending = true
        error = nil
        let api = APIClient(baseURL: apiURL, secrets: KeychainSecretStore(apiURL: apiURL))
        let body = [comment.trimmingCharacters(in: .whitespacesAndNewlines), text].filter { !$0.isEmpty }.joined(separator: "\n\n")
        // Fotos de la galería no son reenvíos; un texto de WhatsApp/correo sí conserva su origen.
        let source = attachments.isEmpty && !text.isEmpty ? SharedText.detectSource(text) : nil
        do {
            var destinations = selected
            if asGroup, let peers = groupPeers {
                let chat: CreateChatResult = try await api.request("/chats", method: "POST", json: ["userIds": peers])
                destinations = [chat.id]
                sentToGroup = true
            }
            for target in destinations {
                var ids: [String] = []
                for item in attachments {
                    guard let file = item.asAttachment else { continue }
                    let key = "\(target)|\(item.id)"
                    progress[key] = 0
                    let a = try await api.uploadAttachment(target, file) { p in Task { @MainActor in self.progress[key] = p } }
                    ids.append(a.id)
                }
                var payload: [String: Any] = ["clientMessageId": UUID().uuidString.lowercased(), "body": String(body.prefix(8000))]
                if !ids.isEmpty { payload["attachmentIds"] = ids }
                if let source, source != .other { payload["forwarded"] = ForwardedInfo(source: source).json }
                try await api.requestData("/conversations/\(target)/messages", method: "POST", json: payload)
                sentCount += 1
            }
            try? await Task.sleep(nanoseconds: 900_000_000)
            context?.completeRequest(returningItems: nil)
        } catch {
            self.error = L10n.errorText(error)
        }
        sending = false
    }

    func cancel() { context?.cancelRequest(withError: NSError(domain: "com.chaggu.share", code: 0)) }
    func openApp() { opener(URL(string: "chaggu://")!) }

    /// Secciones como Inicio: sugerida, recientes y luego por «Empresa · Espacio»; chats al final.
    func sections(query: String) -> [(title: String, items: [ShareTargets.Target])] {
        ShareSections.build(targets, query: query, suggested: suggested)
    }
}

private let orange = Color(red: 0.91, green: 0.44, blue: 0.04)
private let accent = Color(red: 0.70, green: 0.33, blue: 0)

struct ShareExtensionView: View {
    @Bindable var model: ShareModel
    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                if !model.hasSession {
                    VStack(spacing: 16) {
                        Image(systemName: "person.crop.circle.badge.exclamationmark").font(.system(size: 48)).foregroundStyle(orange)
                        Text(L("share.signIn")).font(.headline).multilineTextAlignment(.center)
                        Button(L("share.openApp")) { model.openApp() }.buttonStyle(.borderedProminent).tint(orange)
                            .accessibilityIdentifier("share.openApp")
                    }
                    .padding(32)
                } else if model.sentCount > 0 && !model.sending {
                    ContentUnavailableView(model.sentToGroup ? L("share.sentGroup") : model.sentCount == 1 ? L("share.sentOne") : L("share.sentMany", ["n": model.sentCount]), systemImage: "checkmark.circle.fill")
                } else {
                    content
                }
            }
            .navigationTitle(L("share.header"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { model.cancel() }.disabled(model.sending) }
            }
        }
        .tint(accent)
    }

    /// Enviar abajo, grande y a mano del pulgar (como Instagram), sobre el teclado y la zona segura. Con 2+ directos:
    /// «Enviar por separado» (un mensaje a cada uno) o «Enviar en un grupo» (un chat con todos, un solo mensaje).
    @ViewBuilder private var sendBar: some View {
        if !model.selected.isEmpty || model.sending {
            VStack(spacing: 8) {
                if model.sending {
                    HStack(spacing: 8) { ProgressView(); Text(L("wa.sending")).font(.subheadline) }
                        .frame(maxWidth: .infinity, minHeight: 50)
                } else if model.groupPeers != nil {
                    // Como Instagram: «por separado» es lo de siempre (principal); el grupo, la segunda opción.
                    sendButton(L("share.sendSeparately", ["n": model.selected.count]), icon: "paperplane.fill", prominent: true, id: "share.send") {
                        Task { await model.send() }
                    }
                    sendButton(L("share.sendGroup"), icon: "person.3.fill", prominent: false, id: "share.sendGroup") {
                        Task { await model.send(asGroup: true) }
                    }
                } else {
                    sendButton(model.selected.count > 1 ? L("share.sendTo", ["n": model.selected.count]) : L("share.send"),
                               icon: "paperplane.fill", prominent: true, id: "share.send") { Task { await model.send() } }
                }
            }
            .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        }
    }

    private func sendButton(_ title: String, icon: String, prominent: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).font(.body.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, minHeight: prominent ? 50 : 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(prominent ? Color.white : accent)
        .background(RoundedRectangle(cornerRadius: 14).fill(prominent ? orange : orange.opacity(0.14)))
        .opacity(model.canSend ? 1 : 0.45)
        .disabled(!model.canSend)
        .accessibilityIdentifier(id)
    }

    private var content: some View {
        List {
            Section {
                if model.loading { ProgressView() }
                if !model.attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) { ForEach(model.attachments.prefix(10)) { thumb($0) } }
                    }
                    .accessibilityIdentifier("share.preview")
                }
                if !model.text.isEmpty { Text(String(model.text.prefix(300))).font(.subheadline).italic().lineLimit(4) }
                ForEach(model.problems, id: \.self) { Text($0).font(.footnote).foregroundStyle(.red) }
                TextField(L("share.addMessage"), text: $model.comment, axis: .vertical).lineLimit(1...4).accessibilityIdentifier("share.comment")
            }
            if let e = model.error { Section { Text(e).foregroundStyle(.red).font(.footnote) } }
            if !model.selected.isEmpty {
                Section { Text(L("shareX.selected", ["n": model.selected.count, "max": AttachmentRules.maxShareTargets])).font(.footnote).foregroundStyle(.secondary) }
            }
            ForEach(model.sections(query: query), id: \.title) { sec in
                Section(sec.title) {
                    ForEach(sec.items) { t in row(t) }
                }
            }
        }
        .searchable(text: $query, prompt: L("fwd.search"))
        .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
    }

    private func thumb(_ i: SharedItem) -> some View {
        let done = model.selected.map { model.progress["\($0)|\(i.id)"] ?? 0 }
        let p = done.isEmpty ? nil : (model.sending || done.contains(where: { $0 > 0 }) ? done.reduce(0, +) / Double(done.count) : nil)
        return ZStack(alignment: .bottom) {
            Group {
                if i.kind == .image, let d = i.data, let img = UIImage(data: d) { Image(uiImage: img).resizable().scaledToFill() }
                else {
                    VStack(spacing: 4) {
                        Image(systemName: i.kind == .video ? "film" : AttachmentRules.icon(i.contentType, i.name)).font(.title2)
                        Text(i.name).font(.caption2).lineLimit(1)
                    }
                    .padding(6)
                }
            }
            .frame(width: 76, height: 76)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            if let p { ProgressView(value: p).progressViewStyle(.linear).tint(orange).padding(4) }
        }
        .accessibilityLabel("\(i.name), \(AttachmentRules.sizeLabel(i.sizeBytes))")
    }

    private func row(_ t: ShareTargets.Target) -> some View {
        let on = model.selected.contains(t.id)
        return Button { model.toggle(t.id) } label: {
            HStack(spacing: 10) {
                ShareAvatar(target: t, base: model.apiURL)
                VStack(alignment: .leading, spacing: 1) {
                    Text(t.title).foregroundStyle(.primary).lineLimit(1)
                    Text(t.isSide ? L("side.kind") : t.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundStyle(on ? orange : .secondary).font(.title3)
            }
        }
        .disabled(model.sending)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("share.target.\(t.id)")
    }
}

private struct ShareAvatar: View {
    let target: ShareTargets.Target
    let base: URL?
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: target.kind == "direct" ? 17 : 9).fill(orange.opacity(0.14))
            Image(systemName: target.isSide ? "bubble.left.and.text.bubble.right" : target.kind == "direct" ? "person.fill" : target.kind == "multi" ? "person.2.fill" : target.kind == "internal" ? "lock.fill" : "number")
                .foregroundStyle(accent)
            if let p = target.avatarPath, let base, let url = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + p) {
                AsyncImage(url: url) { img in img.resizable().scaledToFill() } placeholder: { Color.clear }
            }
        }
        .frame(width: 34, height: 34)
        .clipShape(RoundedRectangle(cornerRadius: target.kind == "direct" ? 17 : 9))
        .accessibilityHidden(true)
    }
}
