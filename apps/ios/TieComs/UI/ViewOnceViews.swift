import AVFoundation
import SwiftUI
import UIKit

// Mensajes de una sola vista (docs/TANDA-1.7.md §7): texto, fotos y notas de voz. La burbuja va cerrada («① Foto»);
// el contenido solo sale una vez por persona con POST /messages/:id/open (URLs firmadas de 60 s, sin caché) y se ve
// en pantalla completa. Si la pantalla se está grabando o duplicando, el contenido se tapa; una captura se avisa.

enum ViewOnceRules {
    enum Kind { case text, photo, voice }
    static func kind(_ m: MessageDTO) -> Kind {
        if m.attachments.contains(where: \.isVoice) { return .voice }
        if m.attachments.contains(where: \.isImage) { return .photo }
        return .text
    }
    static func label(_ m: MessageDTO) -> String {
        switch kind(m) {
        case .text: return L("vo.message")
        case .photo: return L("vo.photo")
        case .voice: return L("vo.voice")
        }
    }
    /// Solo texto, fotos y notas de voz (archivos o videos: el servidor responde 400).
    static func allowed(_ staged: [LocalAttachment]) -> Bool { staged.allSatisfy { $0.contentType.hasPrefix("image/") } }
    /// En los eventos en vivo llega 'unopened' para todos: también cuenta si estoy en openedBy (contrato 1.7).
    static func opened(_ m: MessageDTO, me: String? = nil) -> Bool {
        m.viewOnceState == "opened" || (me.map { id in m.openedBy.contains { $0.userId == id } } ?? false)
    }
    /// Para el autor: «Visto por Ana y Bruno».
    static func seenBy(_ m: MessageDTO, name: (String) -> String?) -> String? {
        let names = m.openedBy.compactMap { name($0.userId)?.split(separator: " ").first.map(String.init) }
        return names.isEmpty ? nil : L("vo.seenBy", ["names": ListFormatter.localizedString(byJoining: names)])
    }
}

/// POST /messages/:id/open → { body, attachments } (una vez; 410 already_opened la segunda).
struct ViewOnceContent: Decodable, Sendable {
    var body: String
    var attachments: [AttachmentDTO]
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        body = c.v("body", "")
        attachments = c.lossyArray("attachments")
    }
}

extension AppStore {
    func openViewOnce(_ m: MessageDTO) async throws -> ViewOnceContent {
        let r: ViewOnceContent = try await api.request("/messages/\(m.id)/open", method: "POST", json: [:])
        markViewOnceOpened(m)
        return r
    }

    /// Ya abierto (aquí o en otro dispositivo): la burbuja queda «Abierto».
    func markViewOnceOpened(_ m: MessageDTO) {
        var x = m
        x.viewOnceState = "opened"
        upsertLocal(x)
    }

    /// Bytes de un adjunto de una sola vista: URL firmada (absoluta) o ruta del API. Sin caché.
    func viewOnceData(_ path: String) async throws -> Data {
        if path.hasPrefix("http://") || path.hasPrefix("https://"), let u = URL(string: path) {
            let (d, r) = try await URLSession.shared.data(from: u)
            guard (r as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else { throw ApiRequestError(status: 403, code: "forbidden", message: "") }
            return d
        }
        return try await api.download(path)
    }
}

/// Burbuja cerrada: «① Foto» / «① Mensaje» / «① Nota de voz»; «Abierto» después; el autor ve «una vista · Visto por …».
struct ViewOnceBubble: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    let mine: Bool
    var time: String
    @State private var viewing = false

    var body: some View {
        let opened = ViewOnceRules.opened(message, me: store.me?.id)
        let canOpen = !mine && !opened
        Button { if canOpen { viewing = true } } label: {
            HStack(spacing: 10) {
                Text("1").font(.caption.weight(.heavy))
                    .frame(width: 22, height: 22)
                    .overlay(Circle().stroke(lineWidth: 1.6))
                    .opacity(opened ? 0.5 : 1)
                VStack(alignment: .leading, spacing: 1) {
                    // El «①» ya va en el círculo.
                    Text(ViewOnceRules.label(message).replacingOccurrences(of: "① ", with: "")).font(.subheadline.weight(.semibold))
                    Text(sub(opened: opened)).font(.caption2).opacity(0.8)
                }
                Text(time).font(.caption2).opacity(0.7)
            }
            .foregroundStyle(mine ? Color.white : Theme.textPrimary)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 18).fill(mine ? Theme.bubbleMine : Theme.bubbleOther))
        }
        .buttonStyle(.plain)
        .allowsHitTesting(canOpen)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .accessibilityIdentifier("vo.bubble.\(message.id)")
        .fullScreenCover(isPresented: $viewing) { ViewOnceViewer(message: message) }
    }

    private func sub(opened: Bool) -> String {
        if mine {
            let seen = store.data.flatMap { d in ViewOnceRules.seenBy(message) { Naming.person(d, $0)?.name } }
            return [L("vo.oneView"), seen].compactMap { $0 }.joined(separator: " · ")
        }
        return opened ? L("vo.opened") : L("vo.tapToOpen")
    }
}

/// Visor a pantalla completa: pide el contenido una sola vez, lo muestra y al cerrar queda «Abierto».
struct ViewOnceViewer: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let message: MessageDTO
    @State private var content: ViewOnceContent?
    @State private var image: UIImage?
    @State private var error: String?
    @State private var captured = UIScreen.main.isCaptured
    @State private var player: AVAudioPlayer?
    @State private var playing = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if captured {
                // Grabación o duplicación de pantalla: el contenido se tapa.
                Label(L("vo.captureHidden"), systemImage: "eye.slash").foregroundStyle(.white).padding()
                    .accessibilityIdentifier("vo.hidden")
            } else if let error {
                Text(error).foregroundStyle(.white).multilineTextAlignment(.center).padding()
            } else if let content {
                VStack(spacing: 16) {
                    if let image { Image(uiImage: image).resizable().scaledToFit() }
                    if content.attachments.contains(where: \.isVoice) {
                        Button { toggleVoice() } label: {
                            Image(systemName: playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 72)).foregroundStyle(.white)
                        }
                        .accessibilityIdentifier("vo.play")
                    }
                    if !content.body.isEmpty {
                        ScrollView {
                            Text(content.body).font(.title2.weight(.medium)).foregroundStyle(.white).multilineTextAlignment(.center)
                                .padding(24).frame(maxWidth: .infinity).accessibilityIdentifier("vo.text")
                        }
                        .scrollBounceBehavior(.basedOnSize)
                        .frame(maxHeight: 420)
                    }
                }
                .padding(.top, 70).padding(.bottom, 30)
            } else {
                ProgressView().tint(.white)
            }
        }
        .overlay(alignment: .topTrailing) {
            Button { player?.stop(); dismiss() } label: {
                Image(systemName: "xmark").font(.headline).foregroundStyle(.white).frame(width: 44, height: 44)
                    .background(Circle().fill(.white.opacity(0.15)))
            }
            .padding()
            .accessibilityLabel(L("common.close"))
            .accessibilityIdentifier("vo.close")
        }
        .overlay(alignment: .top) {
            Text(ViewOnceRules.label(message)).font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.8)).padding(.top, 18)
        }
        .task { await load() }
        .onReceive(NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)) { _ in captured = UIScreen.main.isCaptured }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in store.show(L("vo.screenshot")) }
        .onDisappear { player?.stop() }
    }

    private func load() async {
        guard content == nil else { return }
        do {
            let c = try await store.openViewOnce(message)
            content = c
            if let img = c.attachments.first(where: \.isImage) {
                if let d = try? await store.viewOnceData(img.url) { image = UIImage(data: d) }
            }
        } catch let e as ApiRequestError where e.status == 410 {
            store.markViewOnceOpened(message)
            error = L("vo.alreadyOpened")
        } catch { self.error = L10n.errorText(error) }
    }

    private func toggleVoice() {
        if let player { if player.isPlaying { player.pause(); playing = false } else { player.play(); playing = true }; return }
        guard let v = content?.attachments.first(where: \.isVoice) else { return }
        Task {
            guard let d = try? await store.viewOnceData(v.url), let p = try? AVAudioPlayer(data: d) else { store.show(L("common.error")); return }
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            player = p; p.play(); playing = true
        }
    }
}

/// ① del compositor: prende o apaga «una vista» para el próximo mensaje.
struct ViewOnceToggle: View {
    @Binding var on: Bool
    var body: some View {
        Button { on.toggle(); Haptics.tap() } label: {
            Text("1").font(.system(size: 13, weight: .heavy))
                .foregroundStyle(on ? Theme.onPrimary : Theme.textSecondary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(on ? Theme.primaryFill : .clear))
                .overlay(Circle().stroke(on ? Theme.primaryFill : Theme.textSecondary, lineWidth: 1.6))
                .frame(width: 36, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("vo.toggle"))
        .accessibilityValue(on ? L("vo.on") : L("vo.off"))
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("composer.viewOnce")
    }
}
