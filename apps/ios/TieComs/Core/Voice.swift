import AVFoundation
import Foundation
import Observation

/// Notas de voz (SPEC-v4 F): grabación AAC m4a mono 32 kbps 24 kHz, onda de hasta 64 valores y subida como adjunto.
enum VoiceRules {
    static let maxMs = 15 * 60 * 1000
    static let minMs = 700
    static let waveformBars = 64

    /// Reduce las muestras de nivel (0…1) a `bars` valores (máximo por tramo), como pide `x-waveform`.
    static func downsample(_ samples: [Double], bars: Int = waveformBars) -> [Double] {
        guard !samples.isEmpty else { return [] }
        guard samples.count > bars else { return samples.map { min(1, max(0, $0)) } }
        let step = Double(samples.count) / Double(bars)
        return (0..<bars).map { i in
            let a = Int(Double(i) * step), b = max(a + 1, Int(Double(i + 1) * step))
            return min(1, max(0, samples[a..<min(b, samples.count)].max() ?? 0))
        }
    }

    /// dB de AVAudioRecorder (−160…0) a 0…1 con una curva que hace visible la voz normal.
    static func level(db: Float) -> Double {
        let minDb: Float = -50
        guard db > minDb else { return 0.02 }
        return Double(pow((db - minDb) / -minDb, 1.6))
    }

    static func waveformHeader(_ w: [Double]) -> String { w.map { String(format: "%.2f", $0) }.joined(separator: ",") }
}

@MainActor @Observable
final class VoiceRecorder: NSObject, AVAudioRecorderDelegate {
    enum State: Equatable { case idle, recording, locked }
    private(set) var state: State = .idle
    private(set) var elapsedMs = 0
    private(set) var samples: [Double] = []
    var onAutoStop: (() -> Void)?
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var url: URL?

    var isActive: Bool { state != .idle }

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("voz-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000, AVNumberOfChannelsKey: 1,
                                       AVEncoderBitRateKey: 32_000, AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue]
        let r = try AVAudioRecorder(url: file, settings: settings)
        r.delegate = self
        r.isMeteringEnabled = true
        guard r.record(forDuration: TimeInterval(VoiceRules.maxMs) / 1000) else { throw ApiRequestError(status: 0, code: "mic", message: L("voice.micDenied")) }
        recorder = r; url = file; samples = []; elapsedMs = 0; state = .recording
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: AVAudioSession.interruptionNotification, object: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        guard let r = recorder, r.isRecording else { return }
        r.updateMeters()
        samples.append(VoiceRules.level(db: r.averagePower(forChannel: 0)))
        elapsedMs = Int(r.currentTime * 1000)
    }

    func lock() { if state == .recording { state = .locked } }

    /// Detiene y devuelve el archivo; nil si es demasiado corto o se canceló.
    func finish() -> (data: Data, durationMs: Int, waveform: [Double])? {
        let ms = Int((recorder?.currentTime ?? 0) * 1000)
        let file = url
        stop()
        guard let file, let data = try? Data(contentsOf: file) else { return nil }
        try? FileManager.default.removeItem(at: file)
        let duration = max(ms, elapsedMs)
        guard duration >= VoiceRules.minMs else { return nil }
        return (data, min(duration, VoiceRules.maxMs), VoiceRules.downsample(samples))
    }

    func cancel() {
        let file = url
        stop()
        if let file { try? FileManager.default.removeItem(at: file) }
    }

    private func stop() {
        timer?.invalidate(); timer = nil
        recorder?.stop(); recorder = nil
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        state = .idle
    }

    /// Una llamada entrante pausa la grabación; se bloquea para que la persona decida al volver.
    @objc nonisolated private func interrupted(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
        Task { @MainActor in self.recorder?.pause(); self.state = .locked }
    }

    /// Llegó al máximo de 15 min.
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in if self.state != .idle { self.onAutoStop?() } }
    }
}

extension APIClient {
    /// Nota de voz: adjunto con x-voice-note, x-duration-ms, x-waveform y Accept-Language (idioma de la transcripción).
    func uploadVoiceNote(_ conversationId: String, data: Data, durationMs: Int, waveform: [Double],
                         progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> AttachmentDTO {
        guard data.count <= AttachmentRules.maxBytes else { throw ApiRequestError(status: 413, code: "too_large", message: L("voice.tooLong")) }
        let stamp = ISO8601DateFormatter().string(from: Date()).prefix(19).replacingOccurrences(of: ":", with: "-")
        return try await uploadWithProgress("/conversations/\(conversationId)/attachments", data: data, contentType: "application/octet-stream",
                                            headers: ["x-file-name": "nota-de-voz-\(stamp).m4a", "x-file-type": "audio/mp4", "x-voice-note": "1",
                                                      "x-duration-ms": String(durationMs), "x-waveform": VoiceRules.waveformHeader(waveform),
                                                      "accept-language": L10n.lang],
                                            progress: progress)
    }

    /// Reintento de la transcripción (503 transcription_disabled si no hay llave).
    func retryTranscription(_ attachmentId: String) async throws {
        try await requestData("/attachments/\(attachmentId)/transcribe", method: "POST", json: [:])
    }
}

/// Reproductor único de notas de voz (una a la vez), con velocidad 1× / 1.5× / 2×.
@MainActor @Observable
final class VoicePlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = VoicePlayer()
    private(set) var currentId: String?
    private(set) var playing = false
    private(set) var progress: Double = 0
    var rate: Float = 1 { didSet { player?.rate = rate } }
    private var player: AVAudioPlayer?
    private var timer: Timer?
    /// Notas ya escuchadas (para el punto «Sin escuchar»).
    private(set) var heard: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "tc.voice.heard") ?? [])

    func toggle(_ att: AttachmentDTO, api: APIClient) async {
        if currentId == att.id, let p = player {
            if p.isPlaying { p.pause(); playing = false } else { p.play(); playing = true }
            return
        }
        stop()
        currentId = att.id
        do {
            let data = try await AttachmentCache.shared.data(att.url, api: api)
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            let p = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.m4a.rawValue)
            p.enableRate = true
            p.rate = rate
            p.delegate = self
            guard currentId == att.id else { return }
            player = p
            p.play()
            playing = true
            markHeard(att.id)
            timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let p = self.player, p.duration > 0 else { return }
                    self.progress = p.currentTime / p.duration
                }
            }
        } catch {
            currentId = nil
        }
    }

    func seek(_ att: AttachmentDTO, to fraction: Double) {
        guard currentId == att.id, let p = player else { return }
        p.currentTime = p.duration * min(1, max(0, fraction))
        progress = fraction
    }

    func cycleRate() { rate = rate == 1 ? 1.5 : rate == 1.5 ? 2 : 1 }

    func stop() {
        timer?.invalidate(); timer = nil
        player?.stop(); player = nil
        playing = false; progress = 0; currentId = nil
    }

    func markHeard(_ id: String) {
        guard heard.insert(id).inserted else { return }
        UserDefaults.standard.set(Array(heard.suffix(2000)), forKey: "tc.voice.heard")
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.stop() }
    }
}
