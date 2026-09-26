import AVFoundation
import Foundation
import Observation
import UIKit

/// Notas de voz (SPEC-v4 F): grabación AAC m4a mono 32 kbps 24 kHz, onda de hasta 64 valores y subida como adjunto.
enum VoiceRules {
    static let maxMs = 15 * 60 * 1000
    /// Audio real grabado (medido en el archivo, no con el reloj del grabador) por debajo del cual la nota se descarta.
    static let minMs = 500
    /// Soltar antes de esto (sin arrastrar) es un toque: la grabación sigue en manos libres, como en WhatsApp.
    static let tapMs = 400
    static let waveformBars = 64

    /// Resultado de terminar una grabación.
    enum Outcome: Equatable {
        case clip(durationMs: Int)
        /// El audio grabado de verdad no llega al mínimo.
        case tooShort
        /// El archivo no se pudo leer (grabador detenido por el sistema, disco, formato).
        case unreadable
    }

    /// Decide con la duración medida en el archivo (nil = no se pudo leer) y los bytes del archivo.
    static func outcome(fileDurationMs: Int?, bytes: Int) -> Outcome {
        guard let ms = fileDurationMs, bytes > 0 else { return .unreadable }
        guard ms >= minMs else { return .tooShort }
        return .clip(durationMs: min(ms, maxMs))
    }

    /// Duración real de un archivo de audio (AVAudioFile: frames / frecuencia). nil si no se puede leer.
    static func fileDurationMs(_ url: URL) -> Int? {
        guard let f = try? AVAudioFile(forReading: url), f.fileFormat.sampleRate > 0 else { return nil }
        return Int((Double(f.length) / f.fileFormat.sampleRate * 1000).rounded())
    }

    /// Texto de un error al subir la nota: 413 (límite del servidor) y red con su propio mensaje, nunca «demasiado corta».
    static func uploadErrorText(_ error: Error) -> String {
        if let e = error as? ApiRequestError {
            if e.status == 413 || e.code == "too_large" || e.code == "http_413" { return L("voice.uploadTooLarge") }
            if e.isNetwork { return L("voice.uploadNetwork") }
        }
        return L("voice.uploadFailed", ["reason": L10n.errorText(error)])
    }

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
    /// En pausa: llamada entrante, pantalla bloqueada o app en segundo plano (sin modo de audio en segundo plano).
    /// La grabación no se pierde: queda bloqueada para enviarla o continuarla.
    private(set) var paused = false
    /// Se puede continuar (no si el sistema detuvo el grabador: grabar de nuevo sobrescribiría el archivo).
    private(set) var canResume = false
    var onAutoStop: (() -> Void)?
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var url: URL?
    /// Reloj propio (solo para el contador): AVAudioRecorder.currentTime se queda en ~0 mientras el sistema
    /// activa la sesión o cambia la ruta a Bluetooth (AirPods, HFP).
    private var startedAt: Date?
    private var accumulatedMs = 0

    var isActive: Bool { state != .idle }

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// Configura y activa la sesión de audio al tocar el micrófono (antes de pedir permiso y de arrancar el contador),
    /// para que el primer segundo no se pierda mientras el sistema prepara la ruta.
    static func prewarm() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try? session.setActive(true)
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
        r.prepareToRecord()
        guard r.record(forDuration: TimeInterval(VoiceRules.maxMs) / 1000) else { throw ApiRequestError(status: 0, code: "mic", message: L("voice.micDenied")) }
        recorder = r; url = file; samples = []; elapsedMs = 0; accumulatedMs = 0; paused = false; startedAt = Date(); state = .recording
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: AVAudioSession.interruptionNotification, object: nil)
        // Sin UIBackgroundModes «audio» el sistema cortaría la grabación: al salir de la app se pausa y queda bloqueada.
        NotificationCenter.default.addObserver(self, selector: #selector(resigned), name: UIApplication.willResignActiveNotification, object: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private var wallMs: Int { accumulatedMs + (startedAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0) }

    private func tick() {
        guard let r = recorder, r.isRecording else { return }
        r.updateMeters()
        samples.append(VoiceRules.level(db: r.averagePower(forChannel: 0)))
        elapsedMs = max(Int(r.currentTime * 1000), wallMs)
    }

    func lock() { if state == .recording { state = .locked } }

    /// Pausa sin perder lo grabado (queda bloqueada: enviar, borrar o continuar).
    func pause() {
        guard state != .idle, !paused else { return }
        recorder?.pause()
        accumulatedMs = wallMs; startedAt = nil
        paused = true; canResume = true
        state = .locked
    }

    /// Continúa una grabación en pausa.
    func resume() {
        guard paused, canResume, let r = recorder else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        if r.record() { paused = false; startedAt = Date() }
    }

    /// Detiene y mide el audio real en el archivo. Se descarta solo si de verdad dura menos del mínimo.
    func finish() -> (data: Data, durationMs: Int, waveform: [Double])? {
        switch finishOutcome() {
        case .success(let clip): return clip
        case .failure: return nil
        }
    }

    enum FinishError: Error, Equatable { case tooShort, unreadable }

    func finishOutcome() -> Result<(data: Data, durationMs: Int, waveform: [Double]), FinishError> {
        let file = url
        let waveform = VoiceRules.downsample(samples)
        stop()
        guard let file else { return .failure(.unreadable) }
        defer { try? FileManager.default.removeItem(at: file) }
        let data = (try? Data(contentsOf: file)) ?? Data()
        switch VoiceRules.outcome(fileDurationMs: VoiceRules.fileDurationMs(file), bytes: data.count) {
        case .clip(let ms): return .success((data, ms, waveform))
        case .tooShort: return .failure(.tooShort)
        case .unreadable: return .failure(.unreadable)
        }
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
        NotificationCenter.default.removeObserver(self, name: UIApplication.willResignActiveNotification, object: nil)
        startedAt = nil; accumulatedMs = 0; paused = false; canResume = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        state = .idle
    }

    /// Una llamada entrante pausa la grabación; se bloquea para que la persona decida al volver.
    @objc nonisolated private func interrupted(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
        Task { @MainActor in self.pause() }
    }

    /// Pantalla bloqueada o app al fondo: pausa (el archivo queda válido) y bloqueada para enviar al volver.
    @objc nonisolated private func resigned(_ n: Notification) {
        Task { @MainActor in self.pause() }
    }

    /// Llegó al máximo de 15 min (o el sistema detuvo el grabador): lo grabado se conserva.
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            guard self.state != .idle, self.recorder === recorder else { return }
            if flag && self.wallMs >= VoiceRules.maxMs - 1500 { self.onAutoStop?() } else { self.accumulatedMs = self.wallMs; self.startedAt = nil; self.paused = true; self.canResume = false; self.state = .locked }
        }
    }
}

extension APIClient {
    /// Nota de voz: adjunto con x-voice-note, x-duration-ms, x-waveform y Accept-Language (idioma de la transcripción).
    func uploadVoiceNote(_ conversationId: String, data: Data, durationMs: Int, waveform: [Double],
                         aiConsent: Bool = false,
                         progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> AttachmentDTO {
        guard data.count <= AttachmentRules.maxBytes else { throw ApiRequestError(status: 413, code: "too_large", message: L("voice.tooLong")) }
        let stamp = ISO8601DateFormatter().string(from: Date()).prefix(19).replacingOccurrences(of: ":", with: "-")
        var headers = ["x-file-name": "nota-de-voz-\(stamp).m4a", "x-file-type": "audio/mp4", "x-voice-note": "1",
                       "x-duration-ms": String(durationMs), "x-waveform": VoiceRules.waveformHeader(waveform),
                       "accept-language": L10n.lang]
        // Consent belongs to this recording; silence/default never authorizes third-party AI.
        if aiConsent { headers["x-ai-consent"] = "1" }
        return try await uploadWithProgress("/conversations/\(conversationId)/attachments", data: data, contentType: "application/octet-stream",
                                            headers: headers,
                                            progress: progress)
    }

    /// Reintento de la transcripción (503 transcription_disabled si no hay llave).
    func retryTranscription(_ attachmentId: String, aiConsent: Bool = false) async throws {
        guard aiConsent else { throw ApiRequestError(status: 403, code: "ai_consent_required", message: L("err.ai_consent_required")) }
        try await requestData("/attachments/\(attachmentId)/transcribe", method: "POST", json: ["aiConsent": true])
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
    private var api: APIClient?
    /// Reproducción continua: la nota que sigue a esta (en el mensaje siguiente), si la hay.
    var nextProvider: ((String) -> AttachmentDTO?)?
    /// Notas ya escuchadas (para el punto «Sin escuchar»).
    private(set) var heard: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "tc.voice.heard") ?? [])

    func toggle(_ att: AttachmentDTO, api: APIClient) async {
        if currentId == att.id, let p = player {
            if p.isPlaying { p.pause(); playing = false } else { p.play(); playing = true }
            return
        }
        stop()
        currentId = att.id
        self.api = api
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
        Task { @MainActor in
            let finished = self.currentId
            let api = self.api
            self.stop()
            // Notas seguidas: al terminar una, suena la siguiente.
            if flag, let finished, let api, let next = self.nextProvider?(finished) { await self.toggle(next, api: api) }
        }
    }

    /// La nota siguiente en una lista ordenada de mensajes: otra nota del mismo mensaje o del mensaje inmediatamente siguiente.
    nonisolated static func next(after id: String, in messages: [MessageDTO]) -> AttachmentDTO? {
        let humans = messages.filter { !$0.isSystem && $0.deletedAt == nil }
        guard let i = humans.firstIndex(where: { $0.attachments.contains { $0.id == id } }) else { return nil }
        let voices = humans[i].attachments.filter(\.isVoice)
        if let j = voices.firstIndex(where: { $0.id == id }), j + 1 < voices.count { return voices[j + 1] }
        guard i + 1 < humans.count else { return nil }
        return humans[i + 1].attachments.first(where: \.isVoice)
    }
}
