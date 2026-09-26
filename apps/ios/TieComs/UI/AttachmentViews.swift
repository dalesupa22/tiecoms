import AVKit
import PhotosUI
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Descarga autenticada (Bearer) con caché en memoria y en disco (Caches/TieComsAttachments).
@MainActor
final class AttachmentCache {
    static let shared = AttachmentCache()
    private let memory = NSCache<NSString, NSData>()
    private var inflight: [String: Task<Data, Error>] = [:]
    private let dir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("TieComsAttachments", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private func key(_ path: String) -> String { path.replacingOccurrences(of: "/", with: "_") }

    func data(_ path: String, api: APIClient) async throws -> Data {
        let k = key(path)
        if let d = memory.object(forKey: k as NSString) { return d as Data }
        let file = dir.appendingPathComponent(k)
        if let d = try? Data(contentsOf: file) { memory.setObject(d as NSData, forKey: k as NSString); return d }
        if let t = inflight[k] { return try await t.value }
        let t = Task { try await api.download(path) }
        inflight[k] = t
        defer { inflight[k] = nil }
        let d = try await t.value
        memory.setObject(d as NSData, forKey: k as NSString)
        try? d.write(to: file, options: .atomic)
        return d
    }

    /// Archivo local con su nombre (Quick Look y video necesitan una URL de archivo).
    func fileURL(_ att: AttachmentDTO, api: APIClient) async throws -> URL {
        let d = try await data(att.url, api: api)
        let folder = dir.appendingPathComponent(att.id, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = att.name.replacingOccurrences(of: "/", with: "-")
        let url = folder.appendingPathComponent(safe.isEmpty ? "archivo" : safe)
        if !FileManager.default.fileExists(atPath: url.path) { try d.write(to: url, options: .atomic) }
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

    var body: some View {
        ZStack {
            Rectangle().fill(Theme.bubbleOther)
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if failed {
                Image(systemName: "photo").foregroundStyle(Theme.textSecondary)
            } else {
                ProgressView()
            }
        }
        .clipped()
        .task(id: att.id) {
            let path = (useThumb ? att.thumbUrl : nil) ?? att.url
            if let d = try? await AttachmentCache.shared.data(path, api: store.api), let img = UIImage(data: d) { image = img } else { failed = true }
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

    struct ViewerStart: Identifiable { let index: Int; var id: Int { index } }

    var body: some View {
        let media = attachments.filter(\.isMedia)
        let files = attachments.filter { !$0.isMedia && !$0.isVoice }
        VStack(alignment: .leading, spacing: 6) {
            ForEach(attachments.filter(\.isVoice)) { v in
                VoiceNoteView(att: v, mine: mine, conversationId: conversationId, messageId: messageId, authorIsMe: mine)
            }
            if !media.isEmpty { grid(media) }
            ForEach(files) { f in fileChip(f) }
        }
        .fullScreenCover(item: $viewer) { v in MediaViewer(items: media, start: v.index) }
        .sheet(item: Binding(get: { preview.map(URLBox.init) }, set: { preview = $0?.url })) { box in QuickLookView(url: box.url).ignoresSafeArea() }
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
            }
        }
        // LazyVGrid ocupa todo el ancho disponible: se fija al de las fotos para que la burbuja se ciña.
        .frame(width: CGFloat(cols) * side + CGFloat(cols - 1) * 4)
    }

    private func aspect(_ a: AttachmentDTO) -> CGFloat {
        guard let w = a.width, let h = a.height, w > 0, h > 0 else { return 0.75 }
        return min(1.4, max(0.5, CGFloat(h) / CGFloat(w)))
    }

    private func fileChip(_ f: AttachmentDTO) -> some View {
        Button {
            loadingFile = f.id
            Task {
                defer { loadingFile = nil }
                do { preview = try await AttachmentCache.shared.fileURL(f, api: store.api) } catch { store.show(L10n.errorText(error)) }
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
    @Environment(\.dismiss) private var dismiss
    let items: [AttachmentDTO]
    @State var start: Int

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
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() }.accessibilityIdentifier("viewer.close") }
                ToolbarItem(placement: .principal) {
                    Text(items.indices.contains(start) ? items[start].name : "").font(.subheadline).foregroundStyle(.white).lineLimit(1)
                }
            }
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

private struct ZoomablePhoto: View {
    @Environment(AppStore.self) private var store
    let att: AttachmentDTO
    @State private var image: UIImage?
    var body: some View {
        Group {
            if let image { ZoomableImage(image: image) } else { ProgressView().tint(.white) }
        }
        .accessibilityIdentifier("viewer.photo")
        .task(id: att.id) {
            if let d = try? await AttachmentCache.shared.data(att.url, api: store.api) { image = UIImage(data: d) }
        }
    }
}

/// UIScrollView para zoom nativo.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    func makeUIView(context: Context) -> UIScrollView {
        let s = UIScrollView()
        s.minimumZoomScale = 1
        s.maximumZoomScale = 5
        s.delegate = context.coordinator
        s.showsHorizontalScrollIndicator = false
        s.showsVerticalScrollIndicator = false
        let iv = UIImageView(image: image)
        iv.contentMode = .scaleAspectFit
        iv.frame = s.bounds
        iv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        iv.isAccessibilityElement = true
        iv.accessibilityTraits = .image
        s.addSubview(iv)
        context.coordinator.imageView = iv
        let dbl = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        dbl.numberOfTapsRequired = 2
        s.addGestureRecognizer(dbl)
        return s
    }
    func updateUIView(_ s: UIScrollView, context: Context) { context.coordinator.imageView?.image = image }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
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
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    /// El «＋» del compositor también crea un evento o un asunto del chat (nil = no se ofrece).
    var onEvent: (() -> Void)? = nil
    var onIssue: (() -> Void)? = nil
    var onError: (String) -> Void

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label(L("att.fromPhotos"), systemImage: "photo.on.rectangle") }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { showCamera = true } label: { Label(L("att.fromCamera"), systemImage: "camera") }
            }
            Button { showFiles = true } label: { Label(L("att.fromFiles"), systemImage: "folder") }
            if onEvent != nil || onIssue != nil { Divider() }
            if let onEvent { Button(action: onEvent) { Label(L("bar.newEvent"), systemImage: "calendar.badge.plus") }.accessibilityIdentifier("composer.plus.event") }
            if let onIssue { Button(action: onIssue) { Label(L("bar.newIssue"), systemImage: "diamond") }.accessibilityIdentifier("composer.plus.issue") }
        } label: {
            Image(systemName: "plus").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.accentText)
                .frame(width: 36, height: 40)
        }
        .accessibilityLabel(onEvent != nil || onIssue != nil ? L("bar.plus") : L("att.attach"))
        .accessibilityIdentifier("composer.attach")
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: AttachmentRules.maxPerMessage,
                      matching: .any(of: [.images, .videos]), photoLibrary: .shared())
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    let type = item.supportedContentTypes.first { $0.conforms(to: .movie) || $0.conforms(to: .image) } ?? .jpeg
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        let ext = type.preferredFilenameExtension ?? "jpg"
                        add(LocalAttachment(name: "\(type.conforms(to: .movie) ? "video" : "foto")-\(staged.count + 1).\(ext)",
                                            contentType: AttachmentRules.mimeType(for: type), data: data))
                    }
                }
                photos = []
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { img in
                showCamera = false
                if let img, let d = img.jpegData(compressionQuality: 0.85) {
                    add(LocalAttachment(name: "foto-\(staged.count + 1).jpg", contentType: "image/jpeg", data: d))
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                let ok = url.startAccessingSecurityScopedResource()
                defer { if ok { url.stopAccessingSecurityScopedResource() } }
                if let d = try? Data(contentsOf: url) {
                    add(LocalAttachment(name: url.lastPathComponent, contentType: AttachmentRules.mimeType(for: url), data: d))
                }
            }
        }
    }

    private func add(_ a: LocalAttachment) {
        guard staged.count < AttachmentRules.maxPerMessage else { onError(L("att.max", ["n": AttachmentRules.maxPerMessage])); return }
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
                                if a.isImage, let img = UIImage(data: a.data) {
                                    Image(uiImage: img).resizable().scaledToFill()
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
