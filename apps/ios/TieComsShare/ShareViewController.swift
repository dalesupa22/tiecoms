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

    /// Las extensiones no pueden abrir URLs directamente: se busca en la cadena de respuesta la UIApplication y se le pide
    /// `open(_:options:completionHandler:)` por su selector (desde iOS 18 ya no existe `openURL:`; esto sigue en iOS 26).
    /// Si aun así no abre, lo pendiente queda en el App Group y chaggu lo retoma al abrirse (ShareHandoffStore).
    private func openContainingApp(_ url: URL) {
        var r: UIResponder? = self
        let modern = NSSelectorFromString("openURL:options:completionHandler:")
        let legacy = sel_registerName("openURL:")
        typealias Open = @convention(c) (AnyObject, Selector, NSURL, AnyObject?, AnyObject?) -> Void
        while let cur = r {
            // UIApplication recibe un diccionario de opciones; UIScene, un UISceneOpenExternalURLOptions (nil vale).
            // Pasarle un diccionario a la escena la hacía caer (doesNotRecognizeSelector).
            if cur is UIApplication || cur is UIScene, cur.responds(to: modern) {
                let f = unsafeBitCast(cur.method(for: modern), to: Open.self)
                f(cur, modern, url as NSURL, cur is UIApplication ? NSDictionary() : nil, nil)
                break
            }
            if cur.responds(to: legacy), !(cur is UIViewController) { _ = cur.perform(legacy, with: url); break }
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
    /// 1.7.15: primero la pantalla de acciones; «Enviar a un chat» abre el selector.
    var picking = false
    /// Acción en curso (gg, guardar, firmar) y su resultado.
    var working: ShareActionsRule.Action?
    var done: String?
    /// Para «Abre chaggu para continuar» si iOS no dejó abrir la app.
    var continueURL: URL?

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

    var actions: [ShareActionsRule.Action] { ShareActionsRule.available(attachments: attachments, hasText: !text.isEmpty) }
    var localFiles: [LocalAttachment] { attachments.compactMap(\.asAttachment) }

    /// Páginas del PDF (si lo es) para la vista previa.
    var pdfPages: Int? {
        guard attachments.count == 1, attachments[0].isPdf, let d = attachments[0].data, let provider = CGDataProvider(data: d as CFData),
              let doc = CGPDFDocument(provider) else { return nil }
        return doc.numberOfPages
    }

    private var api: APIClient? { apiURL.map { APIClient(baseURL: $0, secrets: KeychainSecretStore(apiURL: $0)) } }

    /// Sube los archivos a un chat y manda un mensaje con ellos. Devuelve el mensaje.
    private func post(to conversationId: String, body: String, api: APIClient) async throws -> MessageDTO {
        var ids: [String] = []
        for f in localFiles { ids.append(try await api.uploadAttachment(conversationId, f) { _ in }.id) }
        var payload: [String: Any] = ["clientMessageId": UUID().uuidString.lowercased(), "body": String(body.prefix(8000))]
        if !ids.isEmpty { payload["attachmentIds"] = ids }
        let r: SendResult = try await api.request("/conversations/\(conversationId)/messages", method: "POST", json: payload)
        return r.message
    }

    /// «Analizar con gg»: el archivo va al chat con gg (POST /assistant/chat lo crea si hace falta) con el pedido de análisis;
    /// luego se abre ese chat en la app.
    func analyzeWithGg() async {
        guard let api, working == nil else { return }
        working = .analyze; error = nil
        defer { working = nil }
        do {
            let chat: CreateChatResult = try await api.request("/assistant/chat", method: "POST", json: [:])
            let ask = [L(ShareActionsRule.analyzePrompt), comment.trimmingCharacters(in: .whitespacesAndNewlines)].filter { !$0.isEmpty }.joined(separator: "\n\n")
            _ = try await post(to: chat.id, body: ask, api: api)
            done = L("share.ggSent")
            let url = URL(string: "chaggu://c/\(chat.id)")!
            continueURL = url
            try? await Task.sleep(nanoseconds: 700_000_000)
            opener(url)
        } catch { self.error = L10n.errorText(error) }
    }

    /// «Guardar en mis archivos» (POST /drive/files sin espacio = Mis archivos).
    func saveToMyFiles() async {
        guard let api, working == nil else { return }
        working = .save; error = nil
        defer { working = nil }
        do {
            for f in localFiles {
                var q = URLComponents(); q.queryItems = [URLQueryItem(name: "name", value: String(f.name.prefix(400)))]
                let query = q.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B") ?? ""
                let _: DriveFileDTO = try await api.upload("/drive/files?\(query)", body: .init(data: f.data, contentType: "application/octet-stream",
                                                                                              headers: ["x-file-type": f.contentType]))
            }
            done = L("share.savedFiles")
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            context?.completeRequest(returningItems: nil)
        } catch { self.error = L10n.errorText(error) }
    }

    /// «Firmar»: el PDF va a «Tú» (POST /me/notes) y la app abre el firmador con él.
    func sign() async {
        guard let api, working == nil else { return }
        working = .sign; error = nil
        defer { working = nil }
        do {
            let notes: CreateChatResult = try await api.request("/me/notes", method: "POST", json: [:])
            let m = try await post(to: notes.id, body: comment.trimmingCharacters(in: .whitespacesAndNewlines), api: api)
            guard let att = m.attachments.first else { throw ApiRequestError(status: 500, code: "no_attachment", message: L("common.error")) }
            let id = try ShareHandoffStore.save(.sign, files: [], attachment: att, conversationId: notes.id)
            handOff(id)
        } catch { self.error = L10n.errorText(error) }
    }

    /// «Crear tarea»: la app abre la hoja de tarea nueva (con elegir grupo) con los archivos.
    func createTask() {
        do {
            let note = [comment.trimmingCharacters(in: .whitespacesAndNewlines), text].filter { !$0.isEmpty }.joined(separator: "\n")
            let id = try ShareHandoffStore.save(.task, files: localFiles, text: note.isEmpty ? nil : note)
            handOff(id)
        } catch { self.error = L10n.errorText(error) }
    }

    private func handOff(_ id: String) {
        let url = ShareHandoffStore.url(id)
        continueURL = url
        done = L("share.continueInApp")
        Task { try? await Task.sleep(nanoseconds: 800_000_000); opener(url) }
    }

    func cancel() { context?.cancelRequest(withError: NSError(domain: "com.chaggu.share", code: 0)) }
    func openApp() { opener(URL(string: "chaggu://")!) }
    func open(_ url: URL) { opener(url) }

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
    @FocusState private var searching: Bool

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
                } else if let done = model.done {
                    doneView(done)
                } else if model.picking {
                    picker
                } else {
                    actionsScreen
                }
            }
            .navigationTitle(model.picking ? L("share.pickTitle") : L("share.header"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if model.picking && !model.sending {
                        Button { model.picking = false; query = "" } label: { Label(L("common.back"), systemImage: "chevron.left") }
                            .accessibilityIdentifier("share.back")
                    } else {
                        Button(L("common.cancel")) { model.cancel() }.disabled(model.sending || model.working != nil)
                    }
                }
            }
        }
        .tint(accent)
    }

    // MARK: Paso 1 — acciones

    private var actionsScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                bigPreview
                ForEach(model.problems, id: \.self) { Text($0).font(.footnote).foregroundStyle(.red) }
                if let e = model.error { Text(e).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("share.error") }
                VStack(spacing: 10) {
                    ForEach(model.actions, id: \.self) { a in actionButton(a) }
                }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
    }

    /// Vista previa grande: la foto, o el ícono del archivo con nombre, tamaño y páginas (PDF); o el enlace/texto.
    private var bigPreview: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.loading { ProgressView().frame(maxWidth: .infinity, minHeight: 120) }
            if let first = model.attachments.first {
                if first.kind == .image, let d = first.data, let img = UIImage(data: d) {
                    Image(uiImage: img).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 260)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                HStack(spacing: 12) {
                    if first.kind != .image {
                        Image(systemName: first.kind == .video ? "film" : AttachmentRules.icon(first.contentType, first.name))
                            .font(.system(size: 30)).foregroundStyle(accent)
                            .frame(width: 56, height: 56).background(RoundedRectangle(cornerRadius: 12).fill(orange.opacity(0.14)))
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.attachments.count > 1 ? L("share.nFiles", ["n": model.attachments.count]) : first.name)
                            .font(.headline).lineLimit(2)
                        Text(previewDetail).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
            } else if !model.text.isEmpty {
                Text(String(model.text.prefix(400))).font(.body).lineLimit(6)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemGroupedBackground)))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("share.preview")
    }

    private var previewDetail: String {
        let size = AttachmentRules.sizeLabel(model.attachments.reduce(0) { $0 + $1.sizeBytes })
        if let pages = model.pdfPages { return "PDF · \(size) · " + (pages == 1 ? L("share.onePage") : L("share.nPages", ["n": pages])) }
        return size
    }

    private func actionButton(_ a: ShareActionsRule.Action) -> some View {
        let (icon, title, sub): (String, String, String?) = switch a {
        case .send: ("paperplane.fill", L("share.actSend"), L("share.actSendSub"))
        case .sign: ("signature", L("share.actSign"), L("share.actSignSub"))
        case .analyze: ("sparkles", L("share.actAnalyze"), L("share.actAnalyzeSub"))
        case .task: ("checklist", L("share.actTask"), L("share.actTaskSub"))
        case .save: ("folder", L("share.actSave"), L("share.actSaveSub"))
        }
        return Button {
            switch a {
            case .send: model.picking = true
            case .sign: Task { await model.sign() }
            case .analyze: Task { await model.analyzeWithGg() }
            case .task: model.createTask()
            case .save: Task { await model.saveToMyFiles() }
            }
        } label: {
            HStack(spacing: 14) {
                Group {
                    if model.working == a { ProgressView() } else { Image(systemName: icon).font(.system(size: 20, weight: .semibold)) }
                }
                .foregroundStyle(a == .send ? Color.white : accent)
                .frame(width: 44, height: 44)
                .background(Circle().fill(a == .send ? orange : orange.opacity(0.14)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                    if let sub { Text(sub).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading) }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color(.secondarySystemGroupedBackground)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.working != nil || model.loading || !model.problems.isEmpty)
        .accessibilityIdentifier("share.action.\(a.rawValue)")
    }

    private func doneView(_ text: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 52)).foregroundStyle(orange)
            Text(text).font(.headline).multilineTextAlignment(.center)
            if let url = model.continueURL {
                Text(L("share.continueHint")).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button(L("share.openApp")) { model.open(url) }.buttonStyle(.borderedProminent).tint(orange)
                    .accessibilityIdentifier("share.openApp")
            }
        }
        .padding(32)
        .accessibilityIdentifier("share.done")
    }

    // MARK: Paso 2 — elegir chats

    private var picker: some View {
        let lists = SharePicker.lists(model.targets, query: query, suggested: model.suggested)
        return VStack(spacing: 0) {
            // Buscador fijo arriba (no flota sobre la lista).
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(L("fwd.search"), text: $query).focused($searching).submitLabel(.search)
                    .accessibilityIdentifier("share.search")
                if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain) }
                smallPreview
            }
            .padding(.horizontal, 12).frame(minHeight: 40)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(.tertiarySystemFill)))
            .padding(.horizontal, 16).padding(.vertical, 8)
            List {
                if !lists.recents.isEmpty {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(alignment: .top, spacing: 14) { ForEach(lists.recents) { recent($0) } }
                                .padding(.horizontal, 16).padding(.vertical, 6)
                        }
                        .listRowInsets(EdgeInsets())
                        .accessibilityIdentifier("share.recents")
                    } header: { Text(L("share.recent")) }
                }
                if !lists.chats.isEmpty { Section(L("share.chats")) { ForEach(lists.chats) { row($0) } } }
                if !lists.groups.isEmpty { Section(L("share.groups")) { ForEach(lists.groups) { row($0) } } }
                if lists.chats.isEmpty && lists.groups.isEmpty { Text(L("share.noResults")).foregroundStyle(.secondary) }
            }
            .listStyle(.insetGrouped)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Color(.systemGroupedBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
    }

    /// Miniatura de lo que se comparte, al lado del buscador.
    @ViewBuilder private var smallPreview: some View {
        if let first = model.attachments.first {
            Group {
                if first.kind == .image, let d = first.data, let img = UIImage(data: d) { Image(uiImage: img).resizable().scaledToFill() }
                else { Image(systemName: AttachmentRules.icon(first.contentType, first.name)).foregroundStyle(accent) }
            }
            .frame(width: 30, height: 30).background(orange.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(alignment: .topTrailing) {
                if model.attachments.count > 1 {
                    Text("\(model.attachments.count)").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                        .padding(3).background(Circle().fill(orange)).offset(x: 5, y: -5)
                }
            }
            .accessibilityLabel(model.attachments.count > 1 ? L("share.nFiles", ["n": model.attachments.count]) : first.name)
        }
    }

    private func recent(_ t: ShareTargets.Target) -> some View {
        let on = model.selected.contains(t.id)
        return Button { model.toggle(t.id) } label: {
            VStack(spacing: 4) {
                ShareAvatar(target: t, base: model.apiURL, size: 54)
                    .overlay(alignment: .bottomTrailing) {
                        if on { Image(systemName: "checkmark.circle.fill").font(.system(size: 20)).foregroundStyle(.white, orange).background(Circle().fill(.white)) }
                    }
                Text(t.title).font(.caption2).lineLimit(1).foregroundStyle(.primary).frame(width: 64)
            }
        }
        .buttonStyle(.plain)
        .disabled(model.sending)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("share.recent.\(t.id)")
    }

    /// Enviar abajo, grande y a mano del pulgar (como Instagram): avatares elegidos, «Añadir un mensaje…» y Enviar.
    /// Con 2+ directos: «Enviar por separado» o «Enviar en un grupo».
    @ViewBuilder private var sendBar: some View {
        if !model.selected.isEmpty || model.sending {
            VStack(spacing: 8) {
                if !model.sending {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(model.selected, id: \.self) { id in
                                if let t = model.targets.first(where: { $0.id == id }) {
                                    Button { model.toggle(id) } label: {
                                        ShareAvatar(target: t, base: model.apiURL, size: 32)
                                            .overlay(alignment: .topTrailing) {
                                                Image(systemName: "xmark.circle.fill").font(.system(size: 13)).foregroundStyle(.white, .gray).offset(x: 3, y: -3)
                                            }
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(L("share.remove", ["name": t.title]))
                                }
                            }
                        }
                        .padding(.top, 3)
                    }
                    if let e = model.error { Text(e).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading) }
                    TextField(L("share.addMessage"), text: $model.comment, axis: .vertical).lineLimit(1...3)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Color(.tertiarySystemFill)))
                        .accessibilityIdentifier("share.comment")
                }
                if model.sending {
                    HStack(spacing: 8) { ProgressView(); Text(L("wa.sending")).font(.subheadline) }
                        .frame(maxWidth: .infinity, minHeight: 50)
                } else if model.groupPeers != nil {
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
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
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

    private func row(_ t: ShareTargets.Target) -> some View {
        let on = model.selected.contains(t.id)
        let sub = SharePicker.subtitle(t)
        return Button { model.toggle(t.id) } label: {
            HStack(spacing: 12) {
                ShareAvatar(target: t, base: model.apiURL, size: 38)
                VStack(alignment: .leading, spacing: 1) {
                    Text(t.title).foregroundStyle(.primary).lineLimit(1)
                    if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
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

/// Foto del chat: redonda en directos y en «Recientes»; cuadrada redondeada en grupos.
private struct ShareAvatar: View {
    let target: ShareTargets.Target
    let base: URL?
    var size: CGFloat = 34
    var body: some View {
        let round = target.kind == "direct" || target.kind == "multi"
        let radius = round ? size / 2 : size * 0.26
        ZStack {
            RoundedRectangle(cornerRadius: radius).fill(orange.opacity(0.14))
            Image(systemName: target.isSide ? "bubble.left.and.text.bubble.right" : target.kind == "direct" ? "person.fill" : target.kind == "multi" ? "person.2.fill" : target.kind == "internal" ? "lock.fill" : "number")
                .font(.system(size: size * 0.4)).foregroundStyle(accent)
            if let p = target.avatarPath, let base, let url = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + p) {
                AsyncImage(url: url) { img in img.resizable().scaledToFill() } placeholder: { Color.clear }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: radius))
        .accessibilityHidden(true)
    }
}
