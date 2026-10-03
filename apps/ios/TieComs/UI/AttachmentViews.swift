import AVKit
import CryptoKit
import PhotosUI
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Descarga autenticada (Bearer) con caché en memoria y en disco (Caches/TieComsAttachments).
@MainActor
final class AttachmentCache {
    static let shared = AttachmentCache()
    private let memory: NSCache<NSString, NSData> = { let c = NSCache<NSString, NSData>(); c.totalCostLimit = 32 * 1024 * 1024; c.countLimit = 64; return c }()
    private var inflight: [String: Task<Data, Error>] = [:]
    private var waFiles: [String: Set<URL>] = [:]
    func purgeWhatsApp(where affected: (String) -> Bool) {
        for source in Array(waFiles.keys) where affected(source) {
            for file in waFiles.removeValue(forKey: source) ?? [] { try? FileManager.default.removeItem(at: file) }
        }
    }
    private let dir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("TieComsAttachments", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private func key(_ path: String, api: APIClient) -> String {
        let scope = api.baseURL.absoluteString + "|" + (api.accessToken ?? "anonymous") + "|" + path
        return SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func data(_ path: String, api: APIClient) async throws -> Data {
        let k = key(path, api: api)
        if WaPrivacy.requestSource(path) != nil {
            memory.removeObject(forKey: k as NSString)
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(k))
            return try await api.download(path) // Private WA media is revalidated, never read from disk/memory.
        }
        if let d = memory.object(forKey: k as NSString) { return d as Data }
        let file = dir.appendingPathComponent(k)
        if let d = try? Data(contentsOf: file) { memory.setObject(d as NSData, forKey: k as NSString, cost: d.count); return d }
        if let t = inflight[k] { return try await t.value }
        let t = Task { try await api.download(path) }
        inflight[k] = t
        defer { inflight[k] = nil }
        let d = try await t.value
        memory.setObject(d as NSData, forKey: k as NSString, cost: d.count)
        try? d.write(to: file, options: .atomic)
        return d
    }

    /// Archivo local con su nombre (Quick Look y video necesitan una URL de archivo).
    func fileURL(_ att: AttachmentDTO, api: APIClient) async throws -> URL {
        let source = WaPrivacy.requestSource(att.url)
        let token = try source.map { try api.waPrivacyCheck?($0) ?? 0 }
        let d = try await data(att.url, api: api)
        if let source, let token { guard try (api.waPrivacyCheck?(source) ?? 0) == token else { throw CancellationError() } }
        let folder = dir.appendingPathComponent(att.id, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = att.name.replacingOccurrences(of: "/", with: "-")
        let url = folder.appendingPathComponent(safe.isEmpty ? "archivo" : safe)
        if source != nil || !FileManager.default.fileExists(atPath: url.path) { try d.write(to: url, options: .atomic) }
        if let source { waFiles[source, default: []].insert(url) }
        return url
    }
}

/// Imagen de un adjunto (miniatura si existe).
struct AttachmentImage: View {
    @Environment(AppStore.self) private var store
    let att: AttachmentDTO
    var useThumb = true
    @State private var image: UIImage?
    @State private var failed = false
    @State private var animation: GifAnimation?

    var body: some View {
        ZStack {
            Rectangle().fill(Theme.bubbleOther)
            if let animation { AnimatedGifImage(animation: animation, fill: true) }
            else if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if failed {
                Image(systemName: "photo").foregroundStyle(Theme.textSecondary)
            } else {
                ProgressView()
            }
        }
        .clipped()
        .task(id: att.id) {
            image = nil; animation = nil; failed = false
            let path = (useThumb && !att.isGif ? att.thumbUrl : nil) ?? att.url
            if let d = try? await AttachmentCache.shared.data(path, api: store.api), let img = UIImage(data: d) {
                let decoded = att.isGif ? await Task.detached { GifAnimation.decode(d) }.value : nil
                guard !Task.isCancelled else { return }; image = decoded?.frames.first ?? img; animation = decoded
            } else { failed = true }
        }
    }
}

/// Adjuntos dentro de la burbuja: cuadrícula de fotos/videos (1–4 visibles + «+N») y chips de archivos.
struct AttachmentsBlock: View {
    @Environment(AppStore.self) private var store
    let attachments: [AttachmentDTO]
    var mine: Bool
    var messageId: String? = nil
    var conversationId: String? = nil
    @State private var viewer: ViewerStart?
    @State private var preview: URL?
    @State private var loadingFile: String?
    @State private var pdf: PdfOpen?
    @State private var textFile: AttachmentDTO?
    /// El archivo abierto en Quick Look (para su barra de acciones).
    @State private var previewAtt: AttachmentDTO?
    @Environment(\.askGgAboutMessage) private var askGgAboutMessage
    /// Tareas: el visor solo comparte (sin gg ni tarea nueva).
    var shareOnly = false

    /// PDF abierto en el visor (ver) o directo en modo firma.
    struct PdfOpen: Identifiable { let att: AttachmentDTO; let sign: Bool; var id: String { att.id + (sign ? "-s" : "") } }

    struct ViewerStart: Identifiable { let index: Int; var id: Int { index } }

    var body: some View {
        let media = attachments.filter(\.isMedia)
        let files = attachments.filter { !$0.isMedia && !$0.isVoice }
        VStack(alignment: .leading, spacing: 6) {
            ForEach(attachments.filter(\.isVoice)) { v in
                VoiceNoteView(att: v, mine: mine, conversationId: conversationId, messageId: messageId, authorIsMe: mine)
            }
            if !media.isEmpty { grid(media) }
            ForEach(attachments.filter { $0.provenance != nil }) { a in if let p = a.provenance { ProvenanceCredits(provenance: p, mine: mine) } }
            ForEach(files) { f in
                if f.isPdf { pdfChip(f) } else { fileChip(f) }
            }
        }
        .sheet(item: $textFile) { UTF8FileSheet(attachment: $0) }
        .fullScreenCover(item: $pdf) { p in PdfSignScreen(att: p.att, startSigning: p.sign, actions: viewerActions) }
        .fullScreenCover(item: $viewer) { v in MediaViewer(items: media, start: v.index, actions: viewerActions) }
        .sheet(item: Binding(get: { preview.map(URLBox.init) }, set: { preview = $0?.url })) { box in
            FileQuickLookScreen(url: box.url, att: previewAtt, actions: viewerActions)
        }
    }

    private var originMessage: MessageDTO? {
        guard let conversationId, let messageId else { return nil }
        return store.conversations[conversationId]?.messages.first { $0.id == messageId }
    }

    /// Cierra el visor abierto y, cuando ya se fue, hace la acción (una hoja no se puede abrir encima mientras se cierra).
    private func afterClosing(_ action: @escaping () -> Void) {
        viewer = nil; pdf = nil; preview = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: action)
    }

    /// Acciones del visor: solo con un chat donde se puede escribir (en el visor de una tarea, solo compartir).
    private var viewerActions: FileViewerActions? {
        if shareOnly { return FileViewerActions() }
        guard let conversationId, let c = store.meta(conversationId) else { return nil }
        return FileViewerActions(
            askGg: messageId.flatMap { id in askGgAboutMessage.map { ask in { afterClosing { ask(id) } } } },
            taskConversationId: c.canPost ? conversationId : nil,
            origin: originMessage)
    }

    @ViewBuilder private func grid(_ media: [AttachmentDTO]) -> some View {
        let shown = Array(media.prefix(4))
        let extra = media.count - shown.count
        let cols = shown.count == 1 ? 1 : 2
        let side: CGFloat = shown.count == 1 ? 230 : 112
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(side), spacing: 4), count: cols), spacing: 4) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { i, a in
                Button { viewer = ViewerStart(index: i) } label: {
                    ZStack {
                        AttachmentImage(att: a).frame(width: side, height: shown.count == 1 ? 230 * aspect(a) : side)
                        if a.isVideo && a.thumbUrl == nil { Color.black.opacity(0.35) }
                        if a.isVideo { Image(systemName: "play.circle.fill").font(.system(size: 34)).foregroundStyle(.white) }
                        if i == 3 && extra > 0 {
                            Color.black.opacity(0.5)
                            Text("+\(extra)").font(.title2.weight(.bold)).foregroundStyle(.white)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(a.isVideo ? L("att.video") : L("att.photo"))
                .accessibilityHint(L("att.openViewer"))
                .accessibilityIdentifier("att.media.\(a.id)")
                .contextMenu { if a.isImage { Button { Task { await ImageClipboard.copy(a, store: store) } } label: { Label(L("copy.image"), systemImage: "doc.on.doc") } } }
            }
        }
        // LazyVGrid ocupa todo el ancho disponible: se fija al de las fotos para que la burbuja se ciña.
        .frame(width: CGFloat(cols) * side + CGFloat(cols - 1) * 4)
    }

    private func aspect(_ a: AttachmentDTO) -> CGFloat {
        guard let w = a.width, let h = a.height, w > 0, h > 0 else { return 0.75 }
        return min(1.4, max(0.5, CGFloat(h) / CGFloat(w)))
    }

    /// PDF: tocarlo abre el visor; «✍️ Firmar» abre directo en modo firma. Si ya viene firmado, lo dice.
    private func pdfChip(_ f: AttachmentDTO) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            fileChip(f) { pdf = PdfOpen(att: f, sign: false) }
            HStack(spacing: 8) {
                Button { pdf = PdfOpen(att: f, sign: true) } label: {
                    Text("✍️ " + L("att.signBtn")).font(.footnote.weight(.semibold))
                        .padding(.horizontal, 14).frame(minHeight: 34)
                        .background(Capsule().fill(mine ? Color.white.opacity(0.22) : Theme.surface))
                        .foregroundStyle(mine ? Color.white : Theme.accentText)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .accessibilityIdentifier("att.sign.\(f.id)")
                if let s = f.signing {
                    Text(L("att.signedBy", ["name": s.signerName])).font(.caption.weight(.semibold))
                        .foregroundStyle(mine ? Color.white : SignColors.ok)
                        .lineLimit(1)
                        .accessibilityIdentifier("att.signed.\(f.id)")
                }
            }
        }
    }

    private func fileChip(_ f: AttachmentDTO, open: (() -> Void)? = nil) -> some View {
        Button {
            if let open { open(); return }
            if f.isUTF8Text { textFile = f; return }
            loadingFile = f.id
            Task {
                defer { loadingFile = nil }
                do { previewAtt = f; preview = try await AttachmentCache.shared.fileURL(f, api: store.api) } catch { store.show(L10n.errorText(error)) }
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: AttachmentRules.icon(f.contentType, f.name)).font(.title3)
                    .foregroundStyle(mine ? Color.white : Theme.accentText)
                VStack(alignment: .leading, spacing: 1) {
                    Text(f.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(AttachmentRules.sizeLabel(f.sizeBytes)).font(.caption2).opacity(0.8)
                }
                .foregroundStyle(mine ? Color.white : Theme.textPrimary)
                Spacer(minLength: 0)
                if loadingFile == f.id { ProgressView().tint(mine ? .white : nil) } else {
                    Image(systemName: "arrow.down.circle").foregroundStyle(mine ? Color.white.opacity(0.9) : Theme.textSecondary)
                }
            }
            .padding(10)
            .frame(maxWidth: 260)
            .background(RoundedRectangle(cornerRadius: 12).fill(mine ? Color.white.opacity(0.18) : Theme.surface))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(f.name), \(AttachmentRules.sizeLabel(f.sizeBytes))")
        .accessibilityHint(L("att.openFile"))
        .accessibilityIdentifier("att.file.\(f.id)")
    }
}

private struct URLBox: Identifiable { let url: URL; var id: String { url.absoluteString } }

/// Visor a pantalla completa: fotos con zoom (pellizco y doble toque) y videos con el reproductor nativo.
struct MediaViewer: View {
    @Environment(AppStore.self) private var store
    @State private var sharing: URL?
    @Environment(\.dismiss) private var dismiss
    let items: [AttachmentDTO]
    @State var start: Int
    var actions: FileViewerActions? = nil

    var body: some View {
        NavigationStack {
            TabView(selection: $start) {
                ForEach(Array(items.enumerated()), id: \.element.id) { i, a in
                    Group {
                        if a.isVideo { VideoPage(att: a) } else { ZoomablePhoto(att: a) }
                    }
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: items.count > 1 ? .automatic : .never))
            .background(Color.black.ignoresSafeArea())
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let actions, items.indices.contains(start) { FileViewerActionBar(att: items[start], actions: actions, dark: true) }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() }.accessibilityIdentifier("viewer.close") }
                ToolbarItem(placement: .primaryAction) {
                    if items.indices.contains(start) {
                        Menu {
                            if items[start].isImage { Button { Task { await ImageClipboard.copy(items[start], store: store) } } label: { Label(L("copy.image"), systemImage: "doc.on.doc") } }
                            Button { let selected = items[start]; Task { do { sharing = try await AttachmentCache.shared.fileURL(selected, api: store.api) } catch { store.show(L10n.errorText(error)) } } } label: { Label(L("copy.shareOriginal"), systemImage: "square.and.arrow.up") }
                        } label: { Image(systemName: "ellipsis.circle") }
                    }
                }
                ToolbarItem(placement: .principal) {
                    Text(items.indices.contains(start) ? items[start].name : "").font(.subheadline).foregroundStyle(.white).lineLimit(1)
                }
            }
            .sheet(item: Binding(get: { sharing.map(URLBox.init) }, set: { sharing = $0?.url })) { ActivityView(items: [$0.url]) }
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

private struct ZoomablePhoto: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    let att: AttachmentDTO
    @State private var image: UIImage?
    @State private var animation: GifAnimation?
    @State private var manual = false
    @State private var failed = false
    var body: some View {
        Group {
            if let image {
                ZoomableImage(image: image, animation: animation, manualPlayback: manual)
                    .overlay(alignment: .bottomTrailing) {
                        if reducedMotion, animation != nil {
                            Button { manual.toggle() } label: { Image(systemName: manual ? "pause.circle.fill" : "play.circle.fill").font(.largeTitle).foregroundStyle(.white).padding() }
                                .accessibilityLabel(L(manual ? "gifs.pause" : "gifs.play"))
                        }
                    }
            } else if failed { Label(L("att.loadFailed"), systemImage: "exclamationmark.triangle").foregroundStyle(.white) }
            else { ProgressView().tint(.white) }
        }
        .accessibilityIdentifier("viewer.photo")
        .task(id: att.id) {
            let stamp = store.sessionStamp
            do {
                let d = try await AttachmentCache.shared.data(att.url, api: store.api)
                let decoded = att.isGif ? await Task.detached { GifAnimation.decode(d, maxSide: 1280) }.value : nil
                guard !Task.isCancelled, stamp == store.sessionStamp else { return }; image = decoded?.frames.first ?? UIImage(data: d); animation = decoded; failed = image == nil
            } catch { if !Task.isCancelled, stamp == store.sessionStamp { failed = true } }
        }
    }
}

/// UIScrollView para zoom nativo.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    var animation: GifAnimation? = nil
    var manualPlayback = false
    func makeUIView(context: Context) -> UIScrollView {
        let s = UIScrollView()
        s.minimumZoomScale = 1
        s.maximumZoomScale = 5
        s.delegate = context.coordinator
        s.showsHorizontalScrollIndicator = false
        s.showsVerticalScrollIndicator = false
        let iv = GifImageView(image: image)
        iv.allowReducedMotion = manualPlayback
        iv.configure(animation)
        iv.contentMode = .scaleAspectFit
        iv.frame = s.bounds
        iv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        iv.isAccessibilityElement = true
        iv.accessibilityTraits = .image
        s.addSubview(iv)
        context.coordinator.imageView = iv
        context.coordinator.configuredImage = image
        let dbl = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        dbl.numberOfTapsRequired = 2
        s.addGestureRecognizer(dbl)
        return s
    }
    func updateUIView(_ s: UIScrollView, context: Context) {
        let gif = context.coordinator.imageView as? GifImageView
        if context.coordinator.configuredImage !== image || gif?.animationID != animation?.identity || gif?.allowReducedMotion != manualPlayback {
            context.coordinator.configuredImage = image; context.coordinator.imageView?.image = image
            gif?.allowReducedMotion = manualPlayback; gif?.configure(animation)
        }
    }
    static func dismantleUIView(_ s: UIScrollView, coordinator: Coordinator) { (coordinator.imageView as? GifImageView)?.stop() }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        var configuredImage: UIImage?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let s = g.view as? UIScrollView else { return }
            s.setZoomScale(s.zoomScale > 1 ? 1 : 2.5, animated: true)
        }
    }
}

private struct VideoPage: View {
    @Environment(AppStore.self) private var store
    let att: AttachmentDTO
    @State private var player: AVPlayer?
    @State private var failed = false
    var body: some View {
        Group {
            if let player { VideoPlayer(player: player).onAppear { player.play() }.onDisappear { player.pause() } }
            else if failed { Image(systemName: "exclamationmark.triangle").foregroundStyle(.white) }
            else { ProgressView().tint(.white) }
        }
        .task(id: att.id) {
            // Descarga autenticada a un archivo local y reproduce desde ahí (AVPlayer no manda el Bearer).
            if let url = try? await AttachmentCache.shared.fileURL(att, api: store.api) { player = AVPlayer(url: url) } else { failed = true }
        }
    }
}

/// Quick Look para archivos.
struct QuickLookView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UINavigationController {
        let q = QLPreviewController()
        q.dataSource = context.coordinator
        return UINavigationController(rootViewController: q)
    }
    func updateUIViewController(_ vc: UINavigationController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

// MARK: - Compositor: elegir y previsualizar antes de enviar

/// Botón clip del compositor: Fotos (varias), Cámara o Archivos.
struct AttachButton: View {
    @Binding var staged: [LocalAttachment]
    var otherStagedCount = 0
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    /// El «＋» del compositor también crea un evento o un asunto del chat (nil = no se ofrece).
    var onEvent: (() -> Void)? = nil
    var onIssue: (() -> Void)? = nil
    /// «📹 Reunión ahora» y «📅 Agendar reunión con enlace» (Meet, Teams o Zoom), 1.6.6.
    var onMeeting: ((Bool) -> Void)? = nil
    /// «✉ Correo» y «Mensaje de WhatsApp» (docs/CORREO.md), solo con features.mail.
    var onMail: (() -> Void)? = nil
    var onWhatsApp: (() -> Void)? = nil
    var onGifs: (() -> Void)? = nil
    /// «✨ Ideas de respuesta de gg» (antes una ✨ suelta en la barra; 1.7.13).
    var onReplyIdeas: (() -> Void)? = nil
    var formatting: ComposerFormattingController? = nil
    /// Con texto («📎 Adjuntar» en tareas) en vez del «＋» del compositor.
    var title: String? = nil
    var onError: (String) -> Void

    var body: some View {
        Menu {
            if let onReplyIdeas {
                Button(action: onReplyIdeas) { Label(L("ggs.replyIdeas"), systemImage: "sparkles") }.accessibilityIdentifier("composer.ggReplies")
                Divider()
            }
            if let formatting { ComposerFormatMenu(controller: formatting); Divider() }
            Button { showPhotos = true } label: { Label(L("att.fromPhotos"), systemImage: "photo.on.rectangle") }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { showCamera = true } label: { Label(L("att.fromCamera"), systemImage: "camera") }
            }
            Button { showFiles = true } label: { Label(L("att.fromFiles"), systemImage: "folder") }
            if let onGifs { Button(action: onGifs) { Label(L("gifs.title"), systemImage: "face.smiling") }.accessibilityIdentifier("composer.plus.gifs") }
            if onEvent != nil || onIssue != nil { Divider() }
            if let onEvent { Button(action: onEvent) { Label(L("bar.newEvent"), systemImage: "calendar.badge.plus") }.accessibilityIdentifier("composer.plus.event") }
            if let onIssue { Button(action: onIssue) { Label(L("bar.newIssue"), systemImage: "diamond") }.accessibilityIdentifier("composer.plus.issue") }
            if let onMeeting {
                Divider()
                Button { onMeeting(true) } label: { Text(L("meet.now")) }.accessibilityIdentifier("composer.plus.meetNow")
                Button { onMeeting(false) } label: { Text(L("meet.schedule")) }.accessibilityIdentifier("composer.plus.meetSchedule")
            }
            if onMail != nil || onWhatsApp != nil { Divider() }
            if let onMail { Button(action: onMail) { Label(L("mail.fromChat"), systemImage: "envelope") }.accessibilityIdentifier("composer.plus.mail") }
            if let onWhatsApp { Button(action: onWhatsApp) { Label(L("wa.fromChat"), systemImage: "phone.bubble") }.accessibilityIdentifier("composer.plus.whatsapp") }
        } label: {
            if let title {
                Label(title, systemImage: "paperclip").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accentText)
                    .frame(minHeight: 44)
            } else {
                Image(systemName: "plus").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.accentText)
                    .frame(width: 36, height: 40)
            }
        }
        .accessibilityLabel(title ?? (onEvent != nil || onIssue != nil || onMeeting != nil ? L("bar.plus") : L("att.attach")))
        .accessibilityIdentifier(title != nil ? "taskFiles.attach" : "composer.attach")
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: max(1, AttachmentRules.maxPerMessage - staged.count - otherStagedCount),
                      matching: .any(of: [.images, .videos]), photoLibrary: .shared())
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    let type = item.supportedContentTypes.first { $0.conforms(to: .movie) || $0.conforms(to: .image) } ?? .jpeg
                    guard let data = try? await item.loadTransferable(type: Data.self) else {
                        // Foto en iCloud sin descargar, formato no soportado…: se avisa en vez de perderla en silencio.
                        onError(L("att.loadFailed")); continue
                    }
                    let ext = type.preferredFilenameExtension ?? "jpg"
                    let name = "\(type.conforms(to: .movie) ? "video" : "foto")-\(staged.count + 1).\(ext)"
                    if type.conforms(to: .image) {
                        guard let img = ImagePrep.prepare(data, name: name, contentType: AttachmentRules.mimeType(for: type)) else { onError(L("att.loadFailed")); continue }
                        add(img)
                    } else {
                        add(LocalAttachment(name: name, contentType: AttachmentRules.mimeType(for: type), data: data))
                    }
                }
                photos = []
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(front: false) { img in
                showCamera = false
                guard let img else { return }
                // Foto de la cámara: derecha, ≤ 2560 px y JPEG liviano (no los 5–12 MB del original).
                if let d = ImagePrep.jpeg(img) {
                    add(LocalAttachment(name: "foto-\(staged.count + 1).jpg", contentType: "image/jpeg", data: d))
                } else { onError(L("att.loadFailed")) }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                let ok = url.startAccessingSecurityScopedResource()
                defer { if ok { url.stopAccessingSecurityScopedResource() } }
                guard let d = try? Data(contentsOf: url) else { onError(L("att.loadFailed")); continue }
                let type = AttachmentRules.mimeType(for: url)
                // HEIC u otras fotos grandes desde Archivos: igual que desde Fotos.
                if type.hasPrefix("image/"), type != "image/svg+xml", let img = ImagePrep.prepare(d, name: url.lastPathComponent, contentType: type) { add(img) }
                else { add(LocalAttachment(name: url.lastPathComponent, contentType: type, data: d)) }
            }
        }
    }

    private func add(_ a: LocalAttachment) {
        guard staged.count + otherStagedCount < AttachmentRules.maxPerMessage else { onError(L("att.max", ["n": AttachmentRules.maxPerMessage])); return }
        if a.tooBig { onError(L("att.tooBig", ["name": a.name])); return }
        staged.append(a)
    }
}

/// Vista previa de lo elegido antes de enviar (con quitar y progreso de subida).
struct StagedAttachments: View {
    @Binding var staged: [LocalAttachment]
    var progress: [UUID: Double]
    var body: some View {
        if !staged.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(staged) { a in
                        ZStack(alignment: .topTrailing) {
                            Group {
                                if a.isImage {
                                    LocalAttachmentImage(file: a)
                                } else {
                                    VStack(spacing: 4) {
                                        Image(systemName: a.isVideo ? "film" : AttachmentRules.icon(a.contentType, a.name)).font(.title2)
                                        Text(a.name).font(.caption2).lineLimit(1)
                                        Text(AttachmentRules.sizeLabel(a.sizeBytes)).font(.caption2).foregroundStyle(Theme.textSecondary)
                                    }
                                    .padding(6)
                                }
                            }
                            .frame(width: 72, height: 72)
                            .background(Theme.bubbleOther)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(alignment: .bottom) {
                                if let p = progress[a.id] {
                                    ProgressView(value: p).progressViewStyle(.linear).tint(Theme.orange).padding(4)
                                }
                            }
                            if progress[a.id] == nil {
                                Button { staged.removeAll { $0.id == a.id } } label: {
                                    Image(systemName: "xmark.circle.fill").font(.title3).foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .offset(x: 6, y: -6)
                                .accessibilityLabel(L("att.remove", ["name": a.name]))
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("staged.\(a.name)")
                    }
                }
                .padding(.horizontal, 12).padding(.top, 8)
            }
        }
    }
}
