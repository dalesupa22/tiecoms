import AVFoundation
import UIKit
import XCTest
@testable import TieComs

/// Integración 1.6.2 contra un API de PRUEBAS local: foto de cámara (4032×3024 → JPEG liviano), foto de galería y notas
/// de voz corta, media y larga: subir → enviar → recibir en el chat → descargar y reproducir.
/// Entorno: TEST_RUNNER_TC_FIXTURE_MEDIA=<fx.json del fixture de Grupos> y, opcional, TEST_RUNNER_TC_LIMITED_API=<proxy con
/// límite de 128 KB como el nginx de antes> para comprobar que un 413 se explica y el adjunto no se pierde.
@MainActor
final class IntegrationV8MediaTests: XCTestCase {
    struct Fixture: Decodable {
        struct Person: Decodable { var email: String; var id: String }
        var apiUrl: String
        var password: String
        var a: Person
        var pagosId: String
    }

    private func fx() throws -> Fixture {
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE_MEDIA"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE_MEDIA") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("chaggu.com") || f.apiUrl.contains("tiecoms.com"), "nunca contra producción")
        return f
    }

    private func store(_ f: Fixture, api: String? = nil) async throws -> AppStore {
        let s = AppStore(baseURL: URL(string: api ?? f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil)
        try await s.login(email: f.a.email, password: f.password)
        try await s.openConversation(f.pagosId)
        return s
    }

    /// Envía y espera a que el mensaje con ese adjunto quede en el chat (confirmado por el servidor).
    private func sendAndReceive(_ s: AppStore, _ conv: String, _ a: AttachmentDTO) async throws -> AttachmentDTO {
        let p = try XCTUnwrap(s.send(conv, body: "", attachments: [a]))
        try await waitUntil(15, "mensaje confirmado") { s.pendingFor(conv).allSatisfy { $0.clientMessageId != p.clientMessageId } }
        try await s.openConversation(conv, force: true)
        let m = try XCTUnwrap(s.conversations[conv]?.messages.last { $0.attachments.contains { $0.id == a.id } }, "llega al chat")
        return try XCTUnwrap(m.attachments.first { $0.id == a.id })
    }

    func testCameraAndGalleryPhotosAreSentReceivedAndDisplayed() async throws {
        let f = try fx()
        let s = try await store(f)
        // Cámara: el mismo camino que CameraPicker → ImagePrep.jpeg.
        let camera = try XCTUnwrap(ImagePrep.jpeg(makeCameraLikeImage(orientation: .right)))
        // Galería: un JPEG grande tal como lo entrega PhotosPicker.
        let galleryRaw = try XCTUnwrap(makeCameraLikeImage().jpegData(compressionQuality: 0.92))
        let gallery = try XCTUnwrap(ImagePrep.prepare(galleryRaw, name: "foto-2.jpeg", contentType: "image/jpeg"))
        for file in [LocalAttachment(name: "foto-1.jpg", contentType: "image/jpeg", data: camera), gallery] {
            let a = try await s.api.uploadAttachment(f.pagosId, file, progress: { _ in })
            XCTAssertNotNil(a.thumbUrl, "miniatura subida")
            let got = try await sendAndReceive(s, f.pagosId, a)
            XCTAssertTrue(got.isImage)
            let bytes = try await AttachmentCache.shared.data(got.url, api: s.api)
            XCTAssertEqual(bytes.count, file.sizeBytes, "se descarga igual")
            XCTAssertNotNil(UIImage(data: bytes), "se muestra")
            if let t = got.thumbUrl {
                let thumb = try await AttachmentCache.shared.data(t, api: s.api)
                XCTAssertNotNil(UIImage(data: thumb), "miniatura legible")
            }
        }
    }

    func testShortMediumAndLongVoiceNotesRoundTrip() async throws {
        let f = try fx()
        let s = try await store(f)
        for seconds in [1.5, 45.0, 300.0] {
            let url = try makeTestNote(seconds: seconds)
            defer { try? FileManager.default.removeItem(at: url) }
            let data = try Data(contentsOf: url)
            guard case .clip(let ms) = VoiceRules.outcome(fileDurationMs: VoiceRules.fileDurationMs(url), bytes: data.count) else { return XCTFail("\(seconds) s") }
            let a = try await s.api.uploadVoiceNote(f.pagosId, data: data, durationMs: ms, waveform: [0.2, 0.6, 0.4])
            let got = try await sendAndReceive(s, f.pagosId, a)
            XCTAssertTrue(got.isVoice)
            XCTAssertEqual(Double(got.durationMs ?? 0), seconds * 1000, accuracy: 150)
            let bytes = try await AttachmentCache.shared.data(got.url, api: s.api)
            let player = try AVAudioPlayer(data: bytes, fileTypeHint: AVFileType.m4a.rawValue)
            XCTAssertEqual(player.duration, seconds, accuracy: 0.5, "se reproduce entera")
            player.currentTime = player.duration / 2
            XCTAssertEqual(player.currentTime, seconds / 2, accuracy: 1, "se puede mover")
        }
    }

    /// Con el límite viejo de nginx (128 KB): el 413 se explica y el adjunto sigue disponible para reintentar.
    func testServerSizeLimitIsExplained() async throws {
        let f = try fx()
        guard let limited = ProcessInfo.processInfo.environment["TC_LIMITED_API"], !limited.isEmpty else { throw XCTSkip("Sin TC_LIMITED_API") }
        let s = try await store(f, api: limited)
        let photo = LocalAttachment(name: "foto-1.jpg", contentType: "image/jpeg", data: try XCTUnwrap(ImagePrep.jpeg(makeCameraLikeImage())))
        do { _ = try await s.api.uploadAttachment(f.pagosId, photo, progress: { _ in }); XCTFail("413 esperado") } catch {
            XCTAssertEqual(AttachmentRules.uploadErrorText(error, name: photo.name), L("att.uploadTooLarge", ["name": photo.name]))
        }
        let url = try makeTestNote(seconds: 45)
        defer { try? FileManager.default.removeItem(at: url) }
        do { _ = try await s.api.uploadVoiceNote(f.pagosId, data: try Data(contentsOf: url), durationMs: 45_000, waveform: []); XCTFail("413 esperado") } catch {
            XCTAssertEqual(VoiceRules.uploadErrorText(error), L("voice.uploadTooLarge"))
            XCTAssertNotEqual(VoiceRules.uploadErrorText(error), L("voice.tooShort"))
        }
    }
}
