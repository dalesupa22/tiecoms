import SwiftUI
import UIKit

/// Per-frame playback preserves GIF delays, pauses off-screen and respects Reduce Motion.
final class GifImageView: UIImageView {
    var allowReducedMotion = false
    private var animation: GifAnimation?
    var animationID: UUID? { animation?.identity }
    private var link: CADisplayLink?
    private var index = 0
    private var last: TimeInterval = 0
    private var elapsed: TimeInterval = 0
    private var observers: [NSObjectProtocol] = []
    override init(frame: CGRect) { super.init(frame: frame); observePlayback() }
    override init(image: UIImage?) { super.init(image: image); observePlayback() }
    required init?(coder: NSCoder) { super.init(coder: coder); observePlayback() }
    private func observePlayback() {
        for name in [UIAccessibility.reduceMotionStatusDidChangeNotification, UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.stop()
                if UIApplication.shared.applicationState == .active { self?.start() }
            })
        }
    }
    func configure(_ value: GifAnimation?) {
        stop(); animation = value; index = 0; elapsed = 0
        if let first = value?.frames.first { image = first }
        start()
    }
    override func didMoveToWindow() { super.didMoveToWindow(); window == nil ? stop() : start() }
    private func start() {
        guard window != nil, UIApplication.shared.applicationState == .active, link == nil, let animation, animation.frames.count > 1, (!UIAccessibility.isReduceMotionEnabled || allowReducedMotion) else { return }
        last = 0
        let l = CADisplayLink(target: self, selector: #selector(tick(_:))); l.add(to: .main, forMode: .common); link = l
    }
    func stop() { link?.invalidate(); link = nil; last = 0 }
    @objc private func tick(_ sender: CADisplayLink) {
        guard let animation, !animation.frames.isEmpty else { stop(); return }
        if (UIAccessibility.isReduceMotionEnabled && !allowReducedMotion) || UIApplication.shared.applicationState != .active { last = 0; return }
        guard last != 0 else { last = sender.timestamp; return }
        elapsed += min(0.25, sender.timestamp - last); last = sender.timestamp
        while elapsed >= animation.delays[index] {
            elapsed -= animation.delays[index]; index = (index + 1) % animation.frames.count
        }
        image = animation.frames[index]
    }
    deinit { link?.invalidate(); observers.forEach(NotificationCenter.default.removeObserver) }
}
private struct AnimatedGifRenderer: UIViewRepresentable {
    var manualPlayback = false
    let animation: GifAnimation
    var fill = false
    func makeUIView(context: Context) -> GifImageView {
        let v = GifImageView(frame: .zero); v.clipsToBounds = true; v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal); v.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        v.contentMode = fill ? .scaleAspectFill : .scaleAspectFit; v.allowReducedMotion = manualPlayback; v.configure(animation); return v
    }
    func updateUIView(_ v: GifImageView, context: Context) {
        v.contentMode = fill ? .scaleAspectFill : .scaleAspectFit
        if v.animationID != animation.identity || v.allowReducedMotion != manualPlayback { v.allowReducedMotion = manualPlayback; v.configure(animation) }
    }
    static func dismantleUIView(_ v: GifImageView, coordinator: ()) { v.stop() }
}

struct AnimatedGifImage: View {
    let animation: GifAnimation
    var fill = false
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @State private var manual = false
    var body: some View {
        AnimatedGifRenderer(manualPlayback: manual, animation: animation, fill: fill)
            .overlay(alignment: .bottomTrailing) {
                if reducedMotion {
                    Button { manual.toggle() } label: { Image(systemName: manual ? "pause.circle.fill" : "play.circle.fill").font(.title).foregroundStyle(.white).padding(6).background(.black.opacity(0.4), in: Circle()) }
                        .accessibilityLabel(L(manual ? "gifs.pause" : "gifs.play"))
                }
            }
    }
}
struct LocalAttachmentImage: View {
    let file: LocalAttachment
    @State private var animation: GifAnimation?
    var body: some View {
        Group {
            if let animation { AnimatedGifImage(animation: animation, fill: true) }
            else if let image = UIImage(data: file.data) { Image(uiImage: image).resizable().scaledToFill() }
            else { Image(systemName: "photo") }
        }.task(id: file.id) {
            if file.contentType.split(separator: ";").first?.lowercased() == "image/gif" {
                let value = await Task.detached { GifAnimation.decode(file.data, maxSide: 160, maxPixels: 300_000) }.value
                if !Task.isCancelled { animation = value }
            }
        }
    }
}

struct CatalogImage: View {
    @Environment(AppStore.self) private var store
    let item: GifMediaItem
    @State private var image: UIImage?
    @State private var animation: GifAnimation?
    @State private var failed = false
    var body: some View {
        ZStack {
            Theme.background
            if let animation { AnimatedGifImage(animation: animation) }
            else if let image { Image(uiImage: image).resizable().scaledToFit() }
            else if failed { Image(systemName: "photo").foregroundStyle(Theme.textSecondary) }
            else { ProgressView() }
        }
        .task(id: item.previewUrl) {
            image = nil; animation = nil; failed = false
            do {
                let data = try await store.api.gifMediaData(item.previewUrl)
                let decoded = await Task.detached { GifAnimation.decode(data, maxSide: 320, maxPixels: 300_000) }.value
                guard !Task.isCancelled else { return }
                animation = decoded; image = decoded?.frames.first ?? UIImage(data: data); failed = image == nil
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
}

struct StagedGifs: View {
    @Binding var items: [GifMediaItem]
    var body: some View {
        if !items.isEmpty {
            ScrollView(.horizontal) {
                HStack {
                    ForEach(items) { item in
                        CatalogImage(item: item).frame(width: 86, height: 76).clipShape(RoundedRectangle(cornerRadius: 9))
                            .overlay(alignment: .topTrailing) {
                                Button { items.removeAll { $0.id == item.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.7)) }
                                    .accessibilityLabel(L("gifs.remove")).accessibilityIdentifier("gifs.remove.\(item.id)")
                            }
                    }
                }.padding(.horizontal, 12)
            }.accessibilityIdentifier("gifs.staged")
        }
    }
}

/// Choosing stages an attachment. The conversation's ordinary Send button performs the upload/send.
struct GifMemePicker: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let onGif: (GifMediaItem) -> Void
    let onMeme: (LocalAttachment) -> Void
    @State private var tab = 0
    @State private var query = ""
    @State private var items: [GifMediaItem] = []
    @State private var next: String?
    @State private var poweredBy: GifCatalog.PoweredBy?
    @State private var loading = false
    @State private var error: String?
    @State private var template: GifMediaItem?
    private var requestKey: String { "\(tab):\(query)" }
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Picker(L("gifs.title"), selection: $tab) { Text("GIFs").tag(0); Text(L("gifs.memes")).tag(1) }.pickerStyle(.segmented).padding(.horizontal)
                if tab == 0 { TextField(L("gifs.search"), text: $query).textFieldStyle(.roundedBorder).padding(.horizontal).accessibilityIdentifier("gifs.search") }
                if let error {
                    Text(error).foregroundStyle(Theme.textSecondary).padding()
                    Button(L("common.retry")) { Task { await load() } }
                }
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 145))], spacing: 12) {
                        ForEach(items) { item in
                            Button {
                                if tab == 0 { onGif(item); dismiss() } else { template = item }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    CatalogImage(item: item).frame(height: 128).clipShape(RoundedRectangle(cornerRadius: 10))
                                    Text(item.title).font(.caption).foregroundStyle(Theme.textPrimary).lineLimit(2)
                                }
                            }.buttonStyle(.plain).accessibilityIdentifier("gifs.item.\(item.id)")
                        }
                    }.padding(.horizontal)
                    if !loading && items.isEmpty && error == nil { Text(L("gifs.empty")).foregroundStyle(Theme.textSecondary).padding() }
                    if let next, !loading { Button(L("gifs.more")) { Task { await load(cursor: next) } }.padding() }
                    if loading { ProgressView().padding() }
                }
                if let poweredBy, let url = URL(string: poweredBy.url), url.scheme == "https" {
                    Link(poweredBy.label, destination: url).font(.caption).padding(.bottom, 8)
                }
            }
            .navigationTitle(L("gifs.title")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
            .task(id: requestKey) {
                if tab == 0 && !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)); guard !Task.isCancelled else { return } }
                await load()
            }
            .sheet(item: $template) { item in
                MemeEditor(item: item) { attachment in onMeme(attachment); dismiss() }
            }
        }
    }
    private func load(cursor: String? = nil) async {
        let key = requestKey
        loading = true; error = nil
        if cursor == nil { items = []; next = nil; poweredBy = nil }
        defer { if key == requestKey { loading = false } }
        do {
            let catalog = try await (tab == 0 ? store.api.gifCatalog(query: query, cursor: cursor) : store.api.memeTemplates())
            guard !Task.isCancelled, key == requestKey else { return }
            var seen = Set(items.map(\.id))
            items += catalog.items.filter { seen.insert($0.id).inserted }
            next = catalog.next; poweredBy = catalog.poweredBy
        } catch { if !Task.isCancelled, key == requestKey { self.error = L10n.errorText(error) } }
    }
}

struct MemeEditor: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: GifMediaItem
    let onChoose: (LocalAttachment) -> Void
    @State private var image: UIImage?
    @State private var top = ""
    @State private var bottom = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if let image, let rendered = MemeRenderer.image(template: image, top: top, bottom: bottom) {
                        Image(uiImage: rendered).resizable().scaledToFit().frame(maxHeight: 350).accessibilityIdentifier("meme.preview")
                    } else if let error { Text(error).foregroundStyle(Theme.textSecondary) } else { ProgressView().padding() }
                    TextField(L("gifs.top"), text: $top, axis: .vertical).textFieldStyle(.roundedBorder).accessibilityIdentifier("meme.top")
                    TextField(L("gifs.bottom"), text: $bottom, axis: .vertical).textFieldStyle(.roundedBorder).accessibilityIdentifier("meme.bottom")
                    Text(L("gifs.localText")).font(.caption).foregroundStyle(Theme.textSecondary)
                    if let note = item.attribution { Text(note).font(.caption).foregroundStyle(Theme.textSecondary) }
                    if let source = item.sourceUrl, let url = URL(string: source), url.scheme == "https" { Link(L("gifs.source"), destination: url).font(.caption) }
                    Button(L("gifs.add")) {
                        guard let image, let att = MemeRenderer.attachment(template: image, top: top, bottom: bottom, item: item) else { return }
                        onChoose(att); dismiss()
                    }.buttonStyle(.borderedProminent).disabled(image == nil).accessibilityIdentifier("meme.add")
                }.padding()
            }
            .navigationTitle(item.title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
            .onChange(of: top) { _, value in if value.count > MemeRenderer.maxCaptionLength { top = String(value.prefix(MemeRenderer.maxCaptionLength)) } }
            .onChange(of: bottom) { _, value in if value.count > MemeRenderer.maxCaptionLength { bottom = String(value.prefix(MemeRenderer.maxCaptionLength)) } }
            .task {
                do { let data = try await store.api.gifMediaData(item.url); guard !Task.isCancelled else { return }; image = UIImage(data: data); if image == nil { error = L("att.loadFailed") } }
                catch { self.error = L10n.errorText(error) }
            }
        }
    }
}
