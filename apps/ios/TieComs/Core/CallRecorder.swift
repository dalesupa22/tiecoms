import AVFoundation
import Foundation

// Transcripción con Groq Whisper (docs/LLAMADAS.md › «Transcripción con Groq Whisper»; web: call.ts startRecorder/uploadChunk).
// Mientras la transcripción está prendida y la llamada en vivo, cada dispositivo graba SU micrófono en pedazos de 12–20 s
// (corta en el primer silencio después de 12 s, a los 20 s como máximo) y manda solo los que tienen ≥ 0,8 s de voz
// y con el micrófono abierto, a POST /calls/:id/audio.

/// Reglas puras del corte (las usan el grabador y las pruebas).
enum ChunkRules {
    static let minMs = 12_000
    static let maxMs = 20_000
    static let minVoiceMs = 800
    /// RMS > 0,015 de la web ≈ −36,5 dBFS.
    static let voiceRMS: Float = 0.015
    static let silenceMs = 700
    static let tickMs = 100

    static func isVoice(rms: Float, muted: Bool) -> Bool { !muted && rms > voiceRMS }
    /// ¿Cortar ahora? (ms desde que empezó el pedazo, y desde la última voz).
    static func shouldCut(elapsed: Int, sinceVoice: Int) -> Bool { elapsed >= maxMs || (elapsed >= minMs && sinceVoice > silenceMs) }
    static func shouldSend(voicedMs: Int) -> Bool { voicedMs >= minVoiceMs }
    /// dBFS (averagePower de AVAudioRecorder) a RMS lineal.
    static func rms(fromDecibels db: Float) -> Float { powf(10, db / 20) }
    /// Id del pedazo (reintentar no duplica): 6–64 caracteres [A-Za-z0-9_-].
    static func segId() -> String { "ios" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(20).lowercased() }
}

/// Un pedazo listo para subir.
struct AudioChunk: Sendable {
    var data: Data
    var type: String
    var segId: String
    var offsetMs: Int
    var durationMs: Int
}

@MainActor
protocol CallChunkRecorder: AnyObject {
    func start()
    func stop()
}

/// AVAudioRecorder sobre la misma sesión de audio de la llamada (playAndRecord / voiceChat, con cancelación de eco),
/// AAC mono 16 kHz ≈ 24 kbps. El SDK de Chime tiene su propia unidad de voz; iOS deja grabar a la vez desde la app.
@MainActor
final class MicChunkRecorder: NSObject, CallChunkRecorder {
    private let callStartedAt: Date
    private let isMuted: () -> Bool
    private let upload: (AudioChunk) -> Void
    private var loop: Task<Void, Never>?

    init(callStartedAt: Date, isMuted: @escaping () -> Bool, upload: @escaping (AudioChunk) -> Void) {
        self.callStartedAt = callStartedAt; self.isMuted = isMuted; self.upload = upload
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { @MainActor [weak self] in await self?.run() }
    }

    func stop() { loop?.cancel(); loop = nil }

    private func run() async {
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
                                       AVEncoderBitRateKey: 24_000, AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue]
        while !Task.isCancelled {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("call-\(UUID().uuidString).m4a")
            guard let rec = try? AVAudioRecorder(url: url, settings: settings) else { return }
            rec.isMeteringEnabled = true
            let t0 = Date()
            guard rec.record() else { return }
            var voiced = 0, lastVoice = 0, elapsed = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(ChunkRules.tickMs) * 1_000_000)
                rec.updateMeters()
                elapsed = Int(Date().timeIntervalSince(t0) * 1000)
                if ChunkRules.isVoice(rms: ChunkRules.rms(fromDecibels: rec.averagePower(forChannel: 0)), muted: isMuted()) {
                    voiced += ChunkRules.tickMs; lastVoice = elapsed
                }
                if ChunkRules.shouldCut(elapsed: elapsed, sinceVoice: elapsed - lastVoice) { break }
            }
            rec.stop()
            defer { try? FileManager.default.removeItem(at: url) }
            if ChunkRules.shouldSend(voicedMs: voiced), let data = try? Data(contentsOf: url), !data.isEmpty {
                upload(AudioChunk(data: data, type: "audio/mp4", segId: ChunkRules.segId(),
                                  offsetMs: max(0, Int(t0.timeIntervalSince(callStartedAt) * 1000)), durationMs: elapsed))
            }
        }
    }
}

/// Pruebas con CALLS_STT_PROVIDER=fake: un pedazo «texto:…» (el proveedor falso devuelve ese texto) al prender.
@MainActor
final class FakeChunkRecorder: CallChunkRecorder {
    private let upload: (AudioChunk) -> Void
    private var task: Task<Void, Never>?
    init(upload: @escaping (AudioChunk) -> Void) { self.upload = upload }
    func start() {
        guard task == nil else { return }
        task = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            self?.upload(AudioChunk(data: Data("texto:\(L("call.fakeCaption"))".utf8), type: "audio/mp4", segId: ChunkRules.segId(), offsetMs: 1000, durationMs: 12_000))
        }
    }
    func stop() { task?.cancel(); task = nil }
}

extension AppStore {
    /// Sube un pedazo (octet-stream con x-file-type, x-seg-id, x-offset-ms, x-duration-ms). Un reintento en 5xx o sin red.
    func sendCallAudio(_ callId: String, _ chunk: AudioChunk) async {
        let body = APIClient.RawBody(data: chunk.data, contentType: "application/octet-stream",
                                     headers: ["x-file-type": chunk.type, "x-seg-id": chunk.segId,
                                               "x-offset-ms": String(chunk.offsetMs), "x-duration-ms": String(chunk.durationMs)])
        for attempt in 0..<2 {
            do { try await api.requestData("/calls/\(callId)/audio", method: "POST", body: body); return } catch {
                if let e = error as? ApiRequestError, !e.isNetwork, e.status < 500 { return }
                if attempt == 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            }
        }
    }

    /// Sumar personas a la llamada en curso (les suena aunque no estén en el chat).
    func inviteToCall(_ callId: String, userIds: [String]) async throws {
        let r: CallResult = try await api.request("/calls/\(callId)/invite", method: "POST", json: ["userIds": userIds])
        if let c = r.call { putCall(c) }
    }
}
