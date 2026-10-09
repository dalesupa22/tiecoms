import AVFoundation
import Foundation
import Observation
import Speech

/// Voz de entrada de gg: Speech (SFSpeechRecognizer, es-CO / en-US) con resultados parciales.
@MainActor
@Observable
final class AssistantListener {
    private(set) var listening = false
    /// Texto parcial mientras escucha.
    private(set) var interim = ""
    /// Se llama al terminar con lo que se dijo (puede ser vacío).
    @ObservationIgnored var onFinish: ((String) -> Void)?

    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var heard = ""
    @ObservationIgnored private var finished = false
    @ObservationIgnored private var stopTimeout: Task<Void, Never>?
    /// Se soltó la burbuja antes de que el permiso respondiera: al empezar, se detiene de una vez.
    @ObservationIgnored private var stopRequested = false

    static var available: Bool {
        SFSpeechRecognizer(locale: Locale(identifier: L10n.lang == "en" ? "en-US" : "es-CO"))?.isAvailable ?? false
    }

    func start() {
        guard !listening else { return }
        stopRequested = false
        listening = true
        interim = ""
        heard = ""
        finished = false
        Task {
            let speech = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
                SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
            }
            let mic = await AVAudioApplication.requestRecordPermission()
            guard speech == .authorized, mic, listening else { finish(); return }
            do { try begin() } catch { finish(); return }
            if stopRequested { stop() }
        }
    }

    private func begin() throws {
        let r = SFSpeechRecognizer(locale: Locale(identifier: L10n.lang == "en" ? "en-US" : "es-CO"))
        guard let r, r.isAvailable else { throw ApiRequestError(status: 0, code: "speech", message: "") }
        recognizer = r
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        request = req
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw ApiRequestError(status: 0, code: "speech", message: "") }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
        engine.prepare()
        try engine.start()
        task = r.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            Task { @MainActor in
                guard let self else { return }
                if let text { self.heard = text; self.interim = text }
                if isFinal || error != nil { self.finish() }
            }
        }
    }

    /// «Listo» o soltar la burbuja: deja de escuchar y envía lo dicho.
    func stop() {
        guard listening else { return }
        guard request != nil else { stopRequested = true; return }
        if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        request?.endAudio()
        // Si el reconocedor no entrega el resultado final pronto, se usa lo último que se oyó.
        stopTimeout?.cancel()
        stopTimeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            self?.finish()
        }
    }

    /// Cierra sin enviar (se cerró el panel).
    func cancel() {
        onFinish = nil
        finish()
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        stopTimeout?.cancel(); stopTimeout = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        task?.cancel(); task = nil
        request = nil
        recognizer = nil
        listening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        let said = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        interim = ""
        onFinish?(said)
    }
}

/// Voz de salida de gg (AVSpeechSynthesizer). «gg» se lee «yiyi».
@MainActor
final class AssistantSpeaker {
    static let shared = AssistantSpeaker()
    private let synth = AVSpeechSynthesizer()

    func speak(_ text: String) {
        let t = Assistant.speakable(text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: t)
        let lang = L10n.lang == "en" ? "en-US" : "es-CO"
        u.voice = AVSpeechSynthesisVoice(language: lang)
            ?? AVSpeechSynthesisVoice.speechVoices().first { $0.language.hasPrefix(L10n.lang) }
        synth.speak(u)
    }

    func stop() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    }
}
