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
        NavigationStack {
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
    private func wav() -> Data {
        // Generated silence fixture for preview, never microphone data.
        var data = Data()
        func append(_ s: String) { data.append(Data(s.utf8)) }
        func u32(_ n: UInt32) { var v = n.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        func u16(_ n: UInt16) { var v = n.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        append("RIFF"); u32(48036); append("WAVEfmt "); u32(16); u16(1); u16(1); u32(24000); u32(48000); u16(2); u16(16); append("data"); u32(48000); data.append(Data(repeating: 0, count: 48000)); return data
    }
}
#endif
