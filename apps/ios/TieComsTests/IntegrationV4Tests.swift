import AVFoundation
import XCTest
import UIKit
@testable import TieComs

/// Integración SPEC-v4 contra el API de mobile-feedback (3043): subir una foto (con miniatura), enviarla a
/// dos conversaciones y comprobar que la otra persona la recibe con sus adjuntos; descarga autenticada.
/// Entorno: TEST_RUNNER_TC_FIXTURE4=<fx.json creado con API_URL=http://localhost:3043>.
@MainActor
final class IntegrationV4Tests: XCTestCase {
    typealias Fixture = IntegrationTests.Fixture

    private func fx() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE4"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE4") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"))
        return f
    }

    private func http(_ f: Fixture, _ method: String, _ path: String, token: String?, body: [String: Any]? = nil) async throws -> (Int, Any?) {
        var req = URLRequest(url: URL(string: "\(f.apiUrl)/api/v1\(path)")!)
        req.httpMethod = method
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "content-type") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, res) = try await URLSession(configuration: .ephemeral).data(for: req)   // sin la caché compartida
        return ((res as! HTTPURLResponse).statusCode, try? JSONSerialization.jsonObject(with: data))
    }

    func testPhotoToTwoConversationsIsReceivedWithAttachments() async throws {
        let f = try fx()
        let s = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await s.login(email: f.a.email, password: f.password)
        try await waitUntil(10, "socket") { s.connection == .online }
        // Segunda conversación: directo con B.
        let (_, bLogin) = try await http(f, "POST", "/auth/login", token: nil, body: ["email": f.b.email, "password": f.password,
                                                                                     "device": ["deviceId": UUID().uuidString, "name": "XCTest B v4", "platform": "agent"]])
        let tokenB = try XCTUnwrap((bLogin as? [String: Any])?["accessToken"] as? String)
        let (stD, dj) = try await http(f, "POST", "/directs", token: tokenB, body: ["userId": f.a.id])
        XCTAssertTrue((200..<300).contains(stD))
        let directId = try XCTUnwrap(((dj as? [String: Any])?["conversation"] as? [String: Any])?["id"] as? String ?? (dj as? [String: Any])?["id"] as? String)
        try await s.refreshAll()
        let targets = [f.conversationId, directId]
        for id in targets { try await s.openConversation(id) }

        let img = UIGraphicsImageRenderer(size: CGSize(width: 1600, height: 1000)).image { ctx in
            UIColor.systemIndigo.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 1600, height: 1000))
            UIColor.white.setFill(); ctx.fill(CGRect(x: 200, y: 200, width: 400, height: 300))
        }
        let file = LocalAttachment(name: "captura v4.jpg", contentType: "image/jpeg", data: img.jpegData(compressionQuality: 0.8)!)
        var sent: [String: String] = [:]
        for id in targets {
            let progress = ProgressBox()
            let a = try await s.api.uploadAttachment(id, file, progress: { v in Task { @MainActor in progress.values.append(v) } })
            XCTAssertEqual(a.name, "captura v4.jpg", "el nombre se envía URL-encoded y vuelve legible")
            XCTAssertEqual(a.contentType, "image/jpeg")
            XCTAssertEqual(a.sizeBytes, file.sizeBytes)
            XCTAssertEqual(a.url, "/api/v1/attachments/\(a.id)")
            XCTAssertNotNil(a.thumbUrl, "la miniatura la sube el cliente")
            let p = try XCTUnwrap(s.send(id, body: "", attachments: [a]), "con adjuntos el texto puede ir vacío")
            sent[id] = p.clientMessageId
            // Descarga autenticada de la original y de la miniatura; sin token, 401.
            let orig = try await s.api.download(a.url)
            XCTAssertEqual(orig.count, file.sizeBytes)
            let thumb = try await s.api.download(try XCTUnwrap(a.thumbUrl))
            let t = try XCTUnwrap(UIImage(data: thumb))
            XCTAssertEqual(max(t.size.width, t.size.height) * t.scale, 480)
            let (anon, _) = try await http(f, "GET", "/attachments/\(a.id)", token: nil)
            XCTAssertEqual(anon, 401)
        }
        for id in targets {
            try await waitUntil(15, "mensaje con foto en \(id)") {
                (s.conversations[id]?.messages ?? []).contains { $0.clientMessageId == sent[id] && $0.attachments.count == 1 }
            }
        }
        XCTAssertTrue(s.pending.isEmpty, "la cola quedó vacía")
        // B recibe cada mensaje con su adjunto (mismo contrato que web/Android).
        for id in targets {
            let (st, j) = try await http(f, "GET", "/conversations/\(id)/messages?limit=5", token: tokenB)
            XCTAssertEqual(st, 200)
            let list = ((j as? [String: Any])?["messages"] as? [[String: Any]]) ?? (j as? [[String: Any]]) ?? []
            let m = try XCTUnwrap(list.first { $0["clientMessageId"] as? String == sent[id] }, "B ve el mensaje en \(id)")
            let atts = try XCTUnwrap(m["attachments"] as? [[String: Any]])
            XCTAssertEqual(atts.count, 1)
            XCTAssertEqual(atts[0]["name"] as? String, "captura v4.jpg")
        }
        // Vista previa del Inicio: el objeto lastHumanPreview trae el conteo de fotos.
        try await s.refreshAll()
        let meta = try XCTUnwrap(s.meta(f.conversationId))
        XCTAssertEqual(meta.lastHumanPreview?.attachments?.images, 1)
        XCTAssertEqual(L10n.listPreview(meta), L("att.photo"))
        // Mayor a 25 MB: se rechaza antes de subir, con el mensaje claro.
        do {
            _ = try await s.api.uploadAttachment(f.conversationId, LocalAttachment(name: "grande.bin", contentType: "application/octet-stream",
                                                                                    data: Data(count: AttachmentRules.maxBytes + 1)), progress: { _ in })
            XCTFail("debía rechazarse")
        } catch let e as ApiRequestError { XCTAssertEqual(e.code, "too_large") }
    }
}

extension IntegrationV4Tests {
    /// m4a AAC de ~1,5 s (tono) generado en el simulador, como el de la grabadora.
    static func toneM4A(seconds: Double = 1.5) throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tono-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000]
        let fmt = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
        do {
            let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            let frames = AVAudioFrameCount(24_000 * seconds)
            let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames)!
            buf.frameLength = frames
            for i in 0..<Int(frames) { buf.floatChannelData![0][i] = Float(sin(Double(i) * 2 * .pi * 440 / 24_000) * 0.3) }
            try file.write(from: buf)
        }
        defer { try? FileManager.default.removeItem(at: url) }
        return try Data(contentsOf: url)
    }

    /// Nota de voz en un directo (x-voice-note); asunto y reunión en el directo (SPEC-v4 E y F).
    func testVoiceNoteAndChatIssuesAndEvents() async throws {
        let f = try fx()
        let s = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await s.login(email: f.a.email, password: f.password)
        try await waitUntil(10, "socket") { s.connection == .online }
        let (_, bLogin) = try await http(f, "POST", "/auth/login", token: nil, body: ["email": f.b.email, "password": f.password,
                                                                                     "device": ["deviceId": UUID().uuidString, "name": "XCTest B v4F", "platform": "agent"]])
        let tokenB = try XCTUnwrap((bLogin as? [String: Any])?["accessToken"] as? String)
        let (_, dj) = try await http(f, "POST", "/directs", token: tokenB, body: ["userId": f.a.id])
        let directId = try XCTUnwrap(((dj as? [String: Any])?["conversation"] as? [String: Any])?["id"] as? String ?? (dj as? [String: Any])?["id"] as? String)
        try await s.refreshAll()
        try await s.openConversation(directId)

        // F. Voz: sube, envía con body '' y la transcripción pasa de null a pending/disabled/done.
        let audio = try Self.toneM4A()
        let wave = VoiceRules.downsample((0..<150).map { Double($0 % 7) / 7 })
        let a = try await s.api.uploadVoiceNote(directId, data: audio, durationMs: 1500, waveform: wave)
        XCTAssertEqual(a.kind, "voice")
        XCTAssertEqual(a.durationMs, 1500)
        XCTAssertEqual(a.waveform?.count, 64)
        XCTAssertNil(a.transcript, "recién subida: sin transcripción")
        let p = try XCTUnwrap(s.send(directId, body: "", attachments: [a]))
        try await waitUntil(15, "nota de voz en el chat") {
            (s.conversations[directId]?.messages ?? []).contains { $0.clientMessageId == p.clientMessageId && $0.attachments.first?.isVoice == true }
        }
        let status = s.conversations[directId]?.messages.first { $0.clientMessageId == p.clientMessageId }?.attachments.first?.transcript?.status
        XCTAssertTrue([.pending, .disabled, .done].contains(status), "estado: \(String(describing: status))")
        // Si hay llave, message.updated trae el texto; si no, queda disabled.
        let deadline = Date().addingTimeInterval(25)
        var final = status
        while Date() < deadline, final == .pending {
            try await Task.sleep(nanoseconds: 500_000_000)
            final = s.conversations[directId]?.messages.first { $0.clientMessageId == p.clientMessageId }?.attachments.first?.transcript?.status
        }
        print("[voice] transcripción final: \(String(describing: final))")
        XCTAssertNotEqual(final, .pending, "message.updated actualiza la transcripción")
        let played = try await s.api.download(a.url)
        XCTAssertGreaterThan(played.count, 1000, "se reproduce con Bearer")
        XCTAssertNotNil(try? AVAudioPlayer(data: played, fileTypeHint: AVFileType.m4a.rawValue), "AAC m4a reproducible")
        try await s.refreshAll()
        XCTAssertEqual(s.meta(directId)?.lastHumanPreview?.attachments?.voices, 1)
        XCTAssertTrue(L10n.listPreview(try XCTUnwrap(s.meta(directId)))?.hasPrefix("🎤") == true)

        // E. Asunto y reunión en el directo (workspaceId null); aparecen en las listas.
        let issue = try await s.createIssue(conversationId: directId, title: "Enviar el contrato revisado", ownerId: f.b.id, dueDate: nil, originMessageId: nil)
        XCTAssertNil(issue.workspaceId)
        let all = try await s.loadIssues()
        XCTAssertTrue(all.contains { $0.id == issue.id }, "GET /issues incluye los de directos")
        XCTAssertTrue(IssueTree.group(s.data!, all).contains { $0.isChats })
        let start = Date().addingTimeInterval(3600)
        let ev = try await s.createEvent(conversationId: directId, ["title": "Revisión del contrato", "startsAt": ISODate.string(start),
                                                                    "endsAt": ISODate.string(start.addingTimeInterval(1800)), "timezone": "America/Bogota"])
        XCTAssertNil(ev.workspaceId)
        XCTAssertEqual(Set(ev.invitees.map(\.userId)), Set([f.a.id, f.b.id]), "sin inviteeIds se invita a todos")
        let evs = try await s.loadEvents(from: Date(), to: Date().addingTimeInterval(86400))
        XCTAssertTrue(evs.contains { $0.id == ev.id })
    }
}

@MainActor private final class ProgressBox { var values: [Double] = [] }
