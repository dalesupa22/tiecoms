import AVFoundation
import CallKit
import Foundation
import UIKit

// Llamadas de chaggu en «Recientes» de la app Teléfono (CallKit), como WhatsApp.
//
// Qué hace (CH028, sin PushKit):
// - Llamo yo (o entro a una llamada en curso): CXStartCallAction → «saliente»; reportOutgoingCall(startedConnectingAt/connectedAt).
// - Contesto una entrante (aviso en la app o acción «Contestar» del push): reportNewIncomingCall + CXAnswerCallAction
//   → «entrante». El timbre sigue siendo el de la app: el de CallKit es silencio (callkit_silence.wav).
// - Colgar desde la interfaz del sistema (CXEndCallAction) cuelga la llamada de chaggu; el mute del sistema
//   (CXSetMutedCallAction) silencia el micrófono de Chime y el de la app se refleja en el sistema.
// - Audio: con CallKit el sistema activa la AVAudioSession. La categoría (playAndRecord / voiceChat o videoChat) se pone al
//   ejecutar la acción y Chime arranca con callKitEnabled = true cuando llega provider(_:didActivate:). Si CallKit falla o
//   no activa el audio a tiempo, la llamada sigue como antes de CH028 (la app activa la sesión y Chime con callKitEnabled = false).
// - Desactivado en China (regla de App Store) y en pruebas unitarias: todo queda como antes.
// - Sin PushKit: con la app cerrada no aparece la pantalla nativa de llamada entrante (el push de siempre sigue sonando);
//   las perdidas/rechazadas no van a Recientes (registrarlas exigiría hacer sonar la interfaz del sistema).

/// Reglas puras (las usan el puente y las pruebas).
enum CallKitRules {
    /// Espera máxima a que CallKit active el audio antes de seguir como sin CallKit.
    static let audioActivationTimeout: TimeInterval = 4
    /// Timbre de CallKit: silencio (la app ya hace sonar su propio tono, ver RingTone).
    static let silentRingtone = "callkit_silence.wav"

    /// App Store: CallKit no se puede usar en China continental. Tampoco en pruebas unitarias.
    static func enabled(region: String? = Locale.current.region?.identifier, unitTests: Bool = AppConfig.isRunningUnitTests) -> Bool {
        !unitTests && region?.uppercased() != "CN"
    }

    /// Nombre que ve el sistema (Recientes, pantalla de bloqueo): el del chat o la persona; nunca vacío.
    static func handleName(_ title: String?) -> String {
        let t = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "chaggu" : String(t.prefix(80))
    }

    /// Por qué terminó una llamada que el sistema conoce (cuando no colgué yo).
    static func endedReason(_ cause: CallCenter.SystemEndCause) -> CXCallEndedReason {
        switch cause {
        case .failed: return .failed
        case .local, .remote: return .remoteEnded
        }
    }
}

/// Puente con CallKit: un solo proveedor para la app, una llamada a la vez (maximumCallGroups 1).
@MainActor
final class CallKitBridge: NSObject {
    private let provider: CXProvider
    private let controller = CXCallController()
    weak var center: CallCenter?

    /// Audio activado por el sistema para la llamada actual y quién espera ese momento.
    private var audioActive = false
    private var audioWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
    /// Llamada a la que pertenece la espera (la categoría se pone para esta).
    private var pendingVideo = false

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true
        config.ringtoneSound = CallKitRules.silentRingtone
        if let icon = UIImage(named: "CallKitIcon")?.pngData() { config.iconTemplateImageData = icon }
        provider = CXProvider(configuration: config)
        super.init()
        // Cola nil = principal: los métodos del delegado llegan en el hilo principal.
        provider.setDelegate(self, queue: nil)
    }

    // MARK: Empezar

    /// Registra la llamada en el sistema. `outgoing`: la empecé yo (o entré a una en curso); si no, contesté una entrante.
    /// Devuelve el UUID de CallKit, o nil si el sistema no la aceptó (la llamada sigue sin CallKit).
    func begin(outgoing: Bool, name: String, video: Bool) async -> UUID? {
        let uuid = UUID()
        audioActive = false
        pendingVideo = video
        let handle = CXHandle(type: .generic, value: CallKitRules.handleName(name))
        let update = CXCallUpdate()
        update.remoteHandle = handle
        update.localizedCallerName = CallKitRules.handleName(name)
        update.hasVideo = video
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        if outgoing {
            let action = CXStartCallAction(call: uuid, handle: handle)
            action.isVideo = video
            action.contactIdentifier = nil
            do { try await controller.request(CXTransaction(action: action)) } catch {
                NSLog("[Chaggu] CallKit: no se pudo registrar la llamada saliente: \(error.localizedDescription)")
                return nil
            }
            provider.reportCall(with: uuid, updated: update)
            return uuid
        }
        do { try await provider.reportNewIncomingCall(with: uuid, update: update) } catch {
            NSLog("[Chaggu] CallKit: no se pudo registrar la llamada entrante: \(error.localizedDescription)")
            return nil
        }
        do { try await controller.request(CXTransaction(action: CXAnswerCallAction(call: uuid))) } catch {
            NSLog("[Chaggu] CallKit: no se pudo contestar en el sistema: \(error.localizedDescription)")
            provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
            return nil
        }
        return uuid
    }

    /// Espera a que CallKit active la sesión de audio (provider(_:didActivate:)). false si no llegó a tiempo.
    func waitForAudio(timeout: TimeInterval = CallKitRules.audioActivationTimeout) async -> Bool {
        if audioActive { return true }
        let token = UUID()
        return await withCheckedContinuation { cont in
            audioWaiters[token] = cont
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                // Solo esta espera: otra llamada posterior tiene la suya.
                self?.audioWaiters.removeValue(forKey: token)?.resume(returning: false)
            }
        }
    }

    private func resolveAudio(_ ok: Bool) {
        let waiters = audioWaiters.values
        audioWaiters = [:]
        for w in waiters { w.resume(returning: ok) }
    }

    /// Saliente ya conectada (Chime tiene audio): Recientes cuenta la duración desde aquí.
    func reportConnected(_ uuid: UUID) {
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    // MARK: Terminar y silenciar

    /// La llamada terminó en la app. Si colgué yo: CXEndCallAction (como colgar en Teléfono); si no, se informa el motivo.
    func end(_ uuid: UUID, cause: CallCenter.SystemEndCause) {
        resolveAudio(false)
        if cause == .local {
            Task { @MainActor [provider, controller] in
                do { try await controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) } catch {
                    provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
                }
            }
        } else {
            provider.reportCall(with: uuid, endedAt: Date(), reason: CallKitRules.endedReason(cause))
        }
    }

    /// El micrófono cambió en la app: el botón de silencio del sistema lo refleja.
    func setMuted(_ uuid: UUID, _ muted: Bool) {
        Task { @MainActor [controller] in
            try? await controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted)))
        }
    }

    // MARK: Delegado (en el hilo principal)

    fileprivate func didActivate() {
        audioActive = true
        resolveAudio(true)
    }

    fileprivate func didDeactivate() {
        audioActive = false
        resolveAudio(false)
        // De vuelta al modo de los sonidos de la app, si no hay otra llamada con audio propio.
        if center?.inCall != true { CallCenter.restoreAppAudioCategory() }
    }
}

extension CallKitBridge: CXProviderDelegate {
    /// La cola del delegado es la principal (setDelegate con queue nil).
    nonisolated private func main(_ f: @MainActor () -> Void) {
        MainActor.assumeIsolated(f)
    }

    nonisolated func providerDidReset(_ provider: CXProvider) {
        main {
            self.resolveAudio(false)
            self.center?.systemDidReset()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        main {
            // La categoría antes de que el sistema active la sesión (didActivate).
            _ = try? CallCenter.configureAudioCategory(video: self.pendingVideo)
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        main { _ = try? CallCenter.configureAudioCategory(video: self.pendingVideo) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let id = action.callUUID
        main { self.center?.systemEnded(id) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let id = action.callUUID, muted = action.isMuted
        main { self.center?.systemMuted(id, muted) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        // supportsHolding = false: no debería llegar.
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        main { self.didActivate() }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        main { self.didDeactivate() }
    }
}
