#if DEBUG
import SwiftUI
import UIKit
import ImageIO
import UniformTypeIdentifiers

/// Offline fixture surfaces use production components and never start a user session or send messages.
struct NightProofView: View {
    @Environment(AppStore.self) private var store
    @State private var reader = false
    @State private var page = "chat"
    @State private var draft = ""
    @State private var mentions: [Mention] = []
    @State private var cursor = 0
    @State private var focused = false
    @State private var selected: Set<String> = []
    @State private var calendar = false
    @State private var voice = true
    private static let original = (1...120).map { "Línea \($0): texto completo de prueba, 👩🏽‍💻 unicode y párrafos para lectura estable." }.joined(separator: "\n") + "\n```swift\nlet url = \"https://example.test/\(String(repeating: "ruta", count: 80))\"\nprint(url)\n```\nFIN DEL MENSAJE ORIGINAL — 120 LÍNEAS"
    private static let code = "**Negrita** y *legacy*.\n- Imagen\n- Voz\n1. Primera\n2. Segunda\n```swift\nlet saludo = \"Hola 👋\"\n// @gg https://example.test queda literal\nprint(saludo)\n```"
    private static let people = [PersonDTO(id: "qa-a", name: "QA Ana"), PersonDTO(id: "qa-b", name: "QA Bruno"), PersonDTO(id: "qa-c", name: "QA Carla"), PersonDTO(id: "qa-d", name: "QA Diego")]
    private static let gif: GifAnimation = {
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, 260, nil)!
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        for i in 0..<260 {
            let image = UIGraphicsImageRenderer(size: CGSize(width: 160, height: 100), format: format).image { ctx in
                (i % 2 == 0 ? UIColor.systemOrange : UIColor.systemBlue).setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 160, height: 100))
                ("GIF \(i + 1)" as NSString).draw(at: CGPoint(x: 30, y: 35), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 20), .foregroundColor: UIColor.white])
            }
            CGImageDestinationAddImage(destination, image.cgImage!, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.1]] as CFDictionary)
        }
        CGImageDestinationFinalize(destination)
        return GifAnimation.decode(data as Data)!
    }()
    var body: some View {
        if AppConfig.launchFlag("TCComposerProof") { ComposerConversationProof() } else { NavigationStack {
            VStack {
                Text("QA local · datos sintéticos · " + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") + "(" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?") + ")").font(.caption).foregroundStyle(.secondary)
                Picker("Prueba", selection: $page) { Text("Chat").tag("chat"); Text("Voz").tag("voice"); Text("Tareas").tag("issues"); Text("Agenda").tag("calendar") }.pickerStyle(.segmented)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if page == "chat" {
                            AnimatedGifImage(animation: Self.gif).frame(height: 110).accessibilityIdentifier("night.gif")
                            ProvenanceCredits(provenance: AttachmentProvenance(provider: "openverse", title: "GIF de fixture local", attribution: "QA local · CC0", sourceUrl: "https://example.test/gif", license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/"), mine: false)
                            CodeMessageBody(text: Self.code, mentions: [], mine: false) { _ in }
                            MessageBubble(text: Self.original, time: "21:00", mine: false, author: ("QA Ana", "QA"), status: nil, italic: false, linkify: true, messageId: "qa-long")
                        } else if page == "voice" {
                            if voice { LocalVoicePreview(data: wav(), durationMs: 1000, waveform: [0.2,0.6,0.4,0.8,0.3], onDiscard: { voice = false }, onSend: { store.show("QA: el envío no está conectado") }) }
                            Text("Vista previa local antes de enviar").font(.caption)
                        } else if page == "calendar" {
                            Text("QA local: formulario de calendario. No se consulta ni crea una reunión sin tocar sus botones.").font(.caption)
                            Button("Abrir calendario QA") { calendar = true }.accessibilityIdentifier("night.calendar")
                        } else {
                            AssigneeSelector(people: Self.people, selected: $selected, me: "qa-a")
                            Text("Responsables elegidos: \(selected.count)").accessibilityIdentifier("night.assigneeCount")
                            AvailabilityLabel(availability: AvailabilityDTO(mode: "busy", until: nil, silent: false, revision: 1))
                        }
                    }.padding(12)
                }
                ComposerTextView(text: $draft, mentions: $mentions, cursor: $cursor, focused: $focused, placeholder: "Borrador QA", accessibilityLabel: "Borrador QA")
                    .frame(maxHeight: 120).background(Theme.surface)
                Button("Salir del chat QA") { focused = false; UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil); page = "issues" }.accessibilityIdentifier("night.exit")
            }
            .navigationTitle("chaggu · prueba local")
            .sheet(isPresented: $reader) { LongTextSheet(text: Self.original, author: "QA local") }
            .sheet(isPresented: $calendar) { GgCalendarSheet(source: "c:qa-local", messageIds: [], suggestedTitle: "QA local · datos sintéticos") }
            .overlay(alignment: .top) { if let toast = store.toast { Text(toast).font(.caption).padding(8).background(Theme.surface) } }
        }
    }
    }
    private func wav() -> Data {
        // Generated silence fixture for preview, never microphone data.
        var data = Data()
        func append(_ s: String) { data.append(Data(s.utf8)) }
        func u32(_ n: UInt32) { var v = n.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        func u16(_ n: UInt16) { var v = n.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        append("RIFF"); u32(48036); append("WAVEfmt "); u32(16); u16(1); u16(1); u32(24000); u32(48000); u16(2); u16(16); append("data"); u32(48000); data.append(Data(repeating: 0, count: 48000)); return data
    }
}

/// Runs the real conversation/container against an in-process transport. No account or network is used.
private struct ComposerConversationProof: View {
    @State private var proofStore: AppStore
    @State private var metrics = ""
    @State private var keyboardFrame = CGRect.null
    @State private var shown = true
    private let timer = Timer.publish(every: 0.15, on: .main, in: .common).autoconnect()
    static let longDraft = (1...100).map { "Línea \($0): borrador QA 👋" }.joined(separator: "\n")
    init() {
        let base = URL(string: "https://composer-fixture.invalid")!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ComposerProofTransport.self]
        let store = AppStore(baseURL: base, secrets: MemorySecretStore(), outbox: OutboxStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("composer-proof-outbox")), feedback: nil, session: URLSession(configuration: config))
        let bootstrap = try! JSONDecoder().decode(BootstrapDTO.self, from: Data(#"{"me":{"id":"qa-composer","name":"QA local","kind":"human"},"people":[{"id":"qa-other","name":"QA Ana"}],"conversations":[{"id":"qa-composer-chat","kind":"direct","memberIds":["qa-composer","qa-other"],"canPost":true,"lastReadSeq":2,"lastSeq":2}]}"#.replacingOccurrences(of: "\"canPost\":true", with: AppConfig.launchFlag("TCProofReadOnly") ? "\"canPost\":false" : "\"canPost\":true").utf8))
        let messages = try! JSONDecoder().decode([MessageDTO].self, from: JSONSerialization.data(withJSONObject: ComposerProofTransport.history))
        store.ggSide.available = AppConfig.launchFlag("TCProofGg")
        store.seedForTesting(bootstrap, conversations: ["qa-composer-chat": ConversationState(messages: messages, lastEventSeq: 2, hasMore: false, loaded: true)])
        if !AppConfig.launchFlag("TCComposerResume"), let url = DraftStorage.url(server: base.absoluteString, account: "qa-composer", conversation: "qa-composer-chat") { try? FileManager.default.removeItem(at: url) }
        _proofStore = State(initialValue: store)
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Button("Copiar 100") { UIPasteboard.general.string = Self.longDraft }.accessibilityIdentifier("proof.copy100")
                    ForEach(["Inicio", "Medio", "Final"], id: \.self) { name in
                        Button(name) {
                            guard let editor = editor() else { return }
                            let length = editor.text.utf16.count
                            let loc = name == "Inicio" ? 0 : name == "Final" ? length : (editor.text as NSString).range(of: "Línea 50:").location
                            guard loc != NSNotFound else { return }
                            editor.selectedRange = NSRange(location: loc, length: 0)
                            editor.becomeFirstResponder()
                        }.accessibilityIdentifier("proof." + name)
                    }
                    Button(shown ? "Salir" : "Volver") { shown.toggle() }.accessibilityIdentifier("proof.route")
                }.font(.system(size: 12)).dynamicTypeSize(.medium).padding(4)
                Text(metrics).font(.system(size: 9, design: .monospaced)).lineLimit(1).minimumScaleFactor(0.5).accessibilityIdentifier("proof.metrics")
                if shown { ConversationView(conversationId: "qa-composer-chat") } else { Spacer() }
            }.environment(proofStore)
        }.onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            keyboardFrame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect ?? .null
        }.onReceive(timer) { _ in
            guard let editor = editor() else { return }
            let caret = editor.selectedTextRange.map { editor.caretRect(for: $0.end) } ?? .zero
            let visible = caret.height > 5 && caret.minY >= editor.bounds.minY - 2 && caret.maxY <= editor.bounds.maxY + 2
            let globalCaret = editor.convert(caret, to: editor.window)
            let keyboard = editor.window.map { $0.convert(keyboardFrame, from: $0.screen.coordinateSpace) } ?? .null
            let onscreen = !keyboard.isNull && globalCaret.minY >= 0 && globalCaret.maxY <= keyboard.minY + 2
            metrics = "len=\(editor.text.utf16.count) y=\(Int(editor.contentOffset.y)) h=\(Int(editor.bounds.height)) cy=\(Int(caret.maxY)) cs=\(Int(editor.contentSize.height)) caret=\(visible ? "yes" : "no") sel=\(editor.selectedRange.location) nsel=\(editor.selectedRange.length) onscreen=\(onscreen ? "yes" : "no")"
        }
    }
    private func editor() -> PastingTextView? {
        func search(_ view: UIView) -> PastingTextView? {
            if let v = view as? PastingTextView { return v }
            return view.subviews.compactMap(search).first
        }
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).compactMap(search).first
    }
}

private final class ComposerProofTransport: URLProtocol, @unchecked Sendable {
    static let history: [[String: Any]] = (1...2).map { i in ["id": "qa-history-\(i)", "conversationId": "qa-composer-chat", "seq": i, "authorId": "qa-other", "kind": "text", "body": "HISTORIAL QA \(i) — permanece quieto al desplazar el borrador", "createdAt": "2026-10-02T10:00:00Z"] }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        var json: [String: Any] = [:]
        if path.hasSuffix("/messages"), request.httpMethod == "POST" {
            var data = request.httpBody ?? Data()
            if let stream = request.httpBodyStream { stream.open(); defer { stream.close() }; var bytes = [UInt8](repeating: 0, count: 4096); while stream.hasBytesAvailable { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(contentsOf: bytes.prefix(n)) } }
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            json = ["message": ["id": "qa-local-sent", "conversationId": "qa-composer-chat", "seq": 3, "authorId": "qa-composer", "kind": "text", "body": body["body"] ?? "", "clientMessageId": body["clientMessageId"] ?? "", "createdAt": "2026-10-02T10:01:00Z"]]
        } else if path.hasSuffix("/events") { json = ["events": [], "resetRequired": false, "lastEventSeq": 2] }
        else if path.hasSuffix("/messages") { json = ["messages": Self.history, "hasMore": false, "lastEventSeq": 2] }
        else if path.hasSuffix("/topics") { json = ["topics": []] }
        else if path.hasSuffix("/pins") { json = ["messageIds": []] }
        else if path.hasSuffix("/issues") { json = ["issues": []] }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: json))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif
