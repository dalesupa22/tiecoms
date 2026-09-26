import AVFoundation
import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// Archivo m4a AAC mono 24 kHz como el del grabador, con un tono de `seconds` segundos.
func makeTestNote(seconds: Double) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("prueba-voz-\(UUID().uuidString).m4a")
    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000]
    let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    let format = file.processingFormat
    let total = AVAudioFrameCount(seconds * format.sampleRate)
    var written: AVAudioFrameCount = 0
    while written < total {
        let n = min(24_000, total - written)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { break }
        buf.frameLength = n
        let p = buf.floatChannelData![0]
        for i in 0..<Int(n) { p[i] = 0.2 * sinf(Float(Int(written) + i) * 2 * .pi * 440 / Float(format.sampleRate)) }
        try file.write(from: buf)
        written += n
    }
    return url
}

/// Foto «de cámara» realista: 4032×3024 con ruido (no comprime como un color plano), orientación opcional.
func makeCameraLikeImage(orientation: UIImage.Orientation = .up) -> UIImage {
    let size = CGSize(width: 4032, height: 3024)
    let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = true
    let img = UIGraphicsImageRenderer(size: size, format: fmt).image { ctx in
        var g = SystemRandomNumberGenerator()
        for y in stride(from: 0, to: Int(size.height), by: 24) {
            for x in stride(from: 0, to: Int(size.width), by: 24) {
                UIColor(red: .random(in: 0...1, using: &g), green: .random(in: 0...1, using: &g), blue: .random(in: 0...1, using: &g), alpha: 1).setFill()
                ctx.fill(CGRect(x: x, y: y, width: 24, height: 24))
            }
        }
    }
    return UIImage(cgImage: img.cgImage!, scale: 1, orientation: orientation)
}

/// 1.6.2: notas de voz medidas en el archivo (no con el reloj del grabador) y títulos «Empresa - Grupo».
@MainActor
final class V8VoiceNotificationTests: XCTestCase {

    // MARK: Duración real y resultado

    func testOutcomeUsesRealAudioNotTheRecorderClock() {
        XCTAssertEqual(VoiceRules.outcome(fileDurationMs: 1_500, bytes: 4_000), .clip(durationMs: 1_500))
        XCTAssertEqual(VoiceRules.outcome(fileDurationMs: 499, bytes: 900), .tooShort, "solo lo que de verdad dura < 0,5 s")
        XCTAssertEqual(VoiceRules.outcome(fileDurationMs: 500, bytes: 900), .clip(durationMs: 500))
        XCTAssertEqual(VoiceRules.outcome(fileDurationMs: nil, bytes: 900), .unreadable, "archivo ilegible ≠ «demasiado corta»")
        XCTAssertEqual(VoiceRules.outcome(fileDurationMs: 3_000, bytes: 0), .unreadable)
        XCTAssertEqual(VoiceRules.outcome(fileDurationMs: VoiceRules.maxMs + 5_000, bytes: 9), .clip(durationMs: VoiceRules.maxMs))
        XCTAssertLessThan(VoiceRules.tapMs, 700, "un toque pasa a manos libres")
    }

    func testFileDurationForShortMediumAndLongNotes() throws {
        for seconds in [1.5, 45.0, 240.0] {
            let url = try makeTestNote(seconds: seconds)
            defer { try? FileManager.default.removeItem(at: url) }
            let ms = try XCTUnwrap(VoiceRules.fileDurationMs(url), "se lee la nota de \(seconds) s")
            XCTAssertEqual(Double(ms), seconds * 1000, accuracy: 120, "duración medida en el archivo")
            let bytes = (try Data(contentsOf: url)).count
            guard case .clip(let d) = VoiceRules.outcome(fileDurationMs: ms, bytes: bytes) else { return XCTFail("\(seconds) s debe enviarse") }
            XCTAssertEqual(Double(d), seconds * 1000, accuracy: 120)
            if seconds >= 240 {
                // Reproducción de una nota larga (el mismo AVAudioPlayer de VoicePlayer): carga, dura y se puede mover.
                let player = try AVAudioPlayer(data: Data(contentsOf: url), fileTypeHint: AVFileType.m4a.rawValue)
                XCTAssertEqual(player.duration, seconds, accuracy: 0.5)
                player.currentTime = player.duration * 0.75
                XCTAssertEqual(player.currentTime, seconds * 0.75, accuracy: 1)
                XCTAssertLessThan(bytes, AttachmentRules.maxBytes, "4 min caben de sobra en 25 MB")
            }
        }
        XCTAssertNil(VoiceRules.fileDurationMs(FileManager.default.temporaryDirectory.appendingPathComponent("no-existe.m4a")))
    }

    /// Solo con TEST_RUNNER_TC_REAL_MIC=1 y permiso: en un simulador sin entrada de audio `record()` tarda minutos en fallar.
    private func requireRealMic() throws {
        guard ProcessInfo.processInfo.environment["TC_REAL_MIC"] == "1" else { throw XCTSkip("Sin TC_REAL_MIC") }
        guard AVAudioApplication.shared.recordPermission == .granted else { throw XCTSkip("Sin permiso de micrófono") }
    }

    /// Grabación real con el micrófono del simulador (el del Mac): 2 s, pausa (como al bloquear la pantalla), 1 s más.
    /// Requiere `xcrun simctl privacy <sim> grant microphone com.chaggu.app`; sin permiso se omite.
    func testRealRecordingPauseResumeAndFinishMeasuresTheFile() async throws {
        try requireRealMic()
        let r = VoiceRecorder()
        do { try r.start() } catch { throw XCTSkip("Este simulador no puede grabar (sin entrada de audio del Mac)") }
        XCTAssertEqual(r.state, .recording)
        try await Task.sleep(nanoseconds: 2_000_000_000)
        r.pause()
        XCTAssertTrue(r.paused && r.canResume)
        XCTAssertEqual(r.state, .locked, "en pausa queda bloqueada para enviar o continuar")
        try await Task.sleep(nanoseconds: 1_000_000_000)   // la pausa no cuenta
        r.resume()
        XCTAssertFalse(r.paused)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        guard case .success(let clip) = r.finishOutcome() else { return XCTFail("la nota debe quedar") }
        XCTAssertEqual(Double(clip.durationMs), 3_000, accuracy: 450, "≈ 3 s de audio real, sin la pausa")
        XCTAssertGreaterThan(clip.data.count, 1_000)
        XCTAssertEqual(r.state, .idle)
    }

    /// Un toque corto (≈ 0,2 s) sin audio suficiente: «demasiado corta» solo si el archivo de verdad dura < 0,5 s.
    func testVeryShortRealRecordingIsTooShort() async throws {
        try requireRealMic()
        let r = VoiceRecorder()
        do { try r.start() } catch { throw XCTSkip("Este simulador no puede grabar (sin entrada de audio del Mac)") }
        try await Task.sleep(nanoseconds: 150_000_000)
        switch r.finishOutcome() {
        case .failure(let e): XCTAssertEqual(e, .tooShort)
        case .success(let c): XCTAssertGreaterThanOrEqual(c.durationMs, VoiceRules.minMs, "si pasó, es porque de verdad duró ≥ 0,5 s")
        }
    }

    func testFinishWithoutRecordingIsUnreadableNotTooShort() {
        let r = VoiceRecorder()
        guard case .failure(let e) = r.finishOutcome() else { return XCTFail("sin grabación no hay nota") }
        XCTAssertEqual(e, .unreadable)
        XCTAssertEqual(r.state, .idle)
        XCTAssertFalse(r.paused)
    }

    func testUploadErrorsHaveTheirOwnMessage() {
        let tooShort = L("voice.tooShort")
        let nginx413 = ApiRequestError(status: 413, code: "http_413", message: "request entity too large")
        XCTAssertEqual(VoiceRules.uploadErrorText(nginx413), L("voice.uploadTooLarge"))
        XCTAssertEqual(VoiceRules.uploadErrorText(ApiRequestError(status: 0, code: "network", message: "")), L("voice.uploadNetwork"))
        let e500 = ApiRequestError(status: 500, code: "internal", message: "falló")
        XCTAssertEqual(VoiceRules.uploadErrorText(e500), L("voice.uploadFailed", ["reason": L10n.errorText(e500)]))
        for e in [nginx413, ApiRequestError(status: 500, code: "x", message: "")] { XCTAssertNotEqual(VoiceRules.uploadErrorText(e), tooShort) }
    }

    // MARK: Fotos (cámara y galería)

    func testCameraPhotoIsUprightResizedAndLight() throws {
        // La cámara entrega la foto «acostada» con orientación EXIF .right (retrato).
        let raw = makeCameraLikeImage(orientation: .right)
        XCTAssertGreaterThan(try XCTUnwrap(raw.jpegData(compressionQuality: 0.85)).count, 1_000_000, "el original pesa más de 1 MB")
        let d = try XCTUnwrap(ImagePrep.jpeg(raw))
        XCTAssertLessThanOrEqual(d.count, ImagePrep.targetBytes)
        let out = try XCTUnwrap(UIImage(data: d))
        XCTAssertEqual(out.imageOrientation, .up, "orientación aplicada a los píxeles")
        XCTAssertEqual(out.size.height, 2560, "retrato: el lado mayor queda en 2560")
        XCTAssertLessThan(out.size.width, out.size.height)
        let thumb = try XCTUnwrap(Thumbnails.jpeg(for: LocalAttachment(name: "foto-1.jpg", contentType: "image/jpeg", data: d)))
        XCTAssertLessThanOrEqual(thumb.count, 512 * 1024, "miniatura ≤ 512 KB")
    }

    func testGalleryHeicAndLargeJpegBecomeJpegSmallOnesStay() throws {
        let big = makeCameraLikeImage()
        let jpg = try XCTUnwrap(big.jpegData(compressionQuality: 0.9))
        let prepared = try XCTUnwrap(ImagePrep.prepare(jpg, name: "foto-1.jpeg", contentType: "image/jpeg"))
        XCTAssertEqual(prepared.contentType, "image/jpeg")
        XCTAssertLessThanOrEqual(prepared.sizeBytes, ImagePrep.targetBytes)
        XCTAssertEqual(prepared.name, "foto-1.jpg")
        // HEIC de la galería (si el simulador lo codifica): pasa a JPEG para web y Android.
        let heic = NSMutableData()
        if let dest = CGImageDestinationCreateWithData(heic, UTType.heic.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, big.cgImage!, nil)
            if CGImageDestinationFinalize(dest) {
                let h = try XCTUnwrap(ImagePrep.prepare(heic as Data, name: "IMG_0001.heic", contentType: "image/heic"))
                XCTAssertEqual(h.contentType, "image/jpeg")
                XCTAssertEqual(h.name, "IMG_0001.jpg")
                XCTAssertNotNil(UIImage(data: h.data))
            }
        }
        // Captura pequeña en PNG: tal cual.
        let small = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 200)).pngData { ctx in UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 300, height: 200)) }
        XCTAssertEqual(ImagePrep.prepare(small, name: "c.png", contentType: "image/png")?.data, small)
        XCTAssertNil(ImagePrep.prepare(Data("no es imagen".utf8), name: "x.jpg", contentType: "image/jpeg"), "ilegible → aviso, no se pierde en silencio")
    }

    func testAttachmentUploadErrorsExplainWhy() {
        let e413 = ApiRequestError(status: 413, code: "http_413", message: "request entity too large")
        XCTAssertEqual(AttachmentRules.uploadErrorText(e413, name: "foto-1.jpg"), L("att.uploadTooLarge", ["name": "foto-1.jpg"]))
        XCTAssertEqual(AttachmentRules.uploadErrorText(ApiRequestError(status: 0, code: "network", message: ""), name: "a"), L("att.uploadNetwork", ["name": "a"]))
    }

    // MARK: «Empresa - Grupo»

    private func boot() throws -> BootstrapDTO {
        try dec(BootstrapDTO.self, #"""
        {"contract":"2026-09-26","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"oA"},
         "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"},{"id":"oB","name":"Ongoing"},{"id":"oC","name":"Acelera"}],
         "workspaces":[
           {"id":"wHome","name":"Xertify","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"member","isOrgHome":true,"createdAt":""},
           {"id":"wRel","name":"Mentorías","owningOrgId":"oA","organizationIds":["oA","oB"],"memberIds":["me"],"myRole":"member","createdAt":""},
           {"id":"wPend","name":"Nestlé","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","counterpartName":"Nestlé","createdAt":""},
           {"id":"wGuest","name":"Programa","owningOrgId":"oC","organizationIds":["oC","oB"],"memberIds":["me"],"myRole":"guest","createdAt":""}],
         "conversations":[
           {"id":"g1","workspaceId":"wHome","kind":"group","name":"General","memberIds":["me"]},
           {"id":"g2","workspaceId":"wRel","kind":"group","name":"General","memberIds":["me"]},
           {"id":"g3","workspaceId":"wPend","kind":"group","name":"Pagos","memberIds":["me"]},
           {"id":"g4","workspaceId":"wGuest","kind":"group","name":"Cohorte","memberIds":["me"]},
           {"id":"d1","kind":"direct","memberIds":["me","bob"]},
           {"id":"m1","kind":"multi","name":"Café","memberIds":["me","bob","col"]}],
         "people":[{"id":"me","name":"Ana","kind":"human","orgId":"oA"},{"id":"bob","name":"Bob","kind":"human","orgId":"oB"},{"id":"col","name":"Col","kind":"human","orgId":"oA"}]}
        """#)
    }

    func testGroupNotificationTitleIsCompanyDashGroup() throws {
        let d = try boot()
        let t = { (id: String) in Naming.notificationTitle(d, d.conversations.first { $0.id == id }!) }
        XCTAssertEqual(t("g1"), "Xertify - General", "espacio de mi empresa")
        XCTAssertEqual(t("g2"), "Ongoing - General", "relación: la otra empresa")
        XCTAssertEqual(t("g3"), "Nestlé - Pagos", "relación pendiente: counterpartName")
        XCTAssertEqual(t("g4"), "Acelera - Cohorte", "tercero: la anfitriona, aunque haya otra empresa")
        XCTAssertEqual(t("d1"), Naming.title(d, d.conversations.first { $0.id == "d1" }!), "directo: sin empresa")
        XCTAssertEqual(t("m1"), "Café", "chat grupal: sin empresa")
    }

    func testDonationUsesCompanyDashGroup() throws {
        let d = try boot()
        XCTAssertEqual(Donations.intent(d, d.conversations[1], image: nil).speakableGroupName?.spokenPhrase, "Ongoing - General")
        XCTAssertEqual(Donations.intent(d, d.conversations[5], image: nil).speakableGroupName?.spokenPhrase, "Café")
    }

    func testLocalBannerForGroupMessageUsesCompanyDashGroup() throws {
        let spy = FeedbackSpyTitles()
        let s = AppStore(baseURL: URL(string: "http://127.0.0.1:9")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: spy)
        s.seedForTesting(try boot(), conversations: [:])
        s.openConversationId = nil
        let json = #"{"type":"message.created","conversationId":"g2","eventSeq":1,"message":{"id":"x1","conversationId":"g2","seq":1,"authorId":"bob","kind":"text","body":"hola","createdAt":"2026-09-26T10:00:00.000Z"}}"#
        s.onConversationEvent(try dec(ConversationEvent.self, json), live: true)
        XCTAssertEqual(spy.titles.first, "Ongoing - General")
    }
}

@MainActor
final class FeedbackSpyTitles: FeedbackSink {
    var titles: [String] = []
    func playSend() {}
    func playReceive() {}
    func notifyIncoming(conversationId: String, title: String, author: String, body: String) { titles.append(title) }
}
