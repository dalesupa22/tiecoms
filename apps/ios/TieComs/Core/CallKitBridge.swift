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
// - CH029, con PushKit (VoipPush.swift): una llamada entrante llega por push VoIP y timbra con la pantalla del sistema
//   (reportIncomingPush, con el tono elegido en la app), con la app cerrada o el teléfono bloqueado. Contestar
//   (CXAnswerCallAction) entra a la llamada de chaggu; colgar antes de contestar (CXEndCallAction) la rechaza. Si
//   cuelga quien llama, contesto en otro dispositivo o pasan 45 s, se termina en el sistema (perdida en Recientes).

/// Reglas puras (las usan el puente y las pruebas).
enum CallKitRules {
    /// Espera máxima a que CallKit active el audio antes de seguir como sin CallKit.
    static let audioActivationTimeout: TimeInterval = 4
    /// Timbre de CallKit al contestar desde el aviso de la app: silencio (la app ya hizo sonar su propio tono, ver RingTone).
    static let silentRingtone = "callkit_silence.wav"
    /// Timbre de una llamada que llega por push VoIP: el tono elegido en la app (el mismo que usa el aviso, ring_*.caf).
    static func pushRingtone(_ sharedFile: String?) -> String { "\(sharedFile ?? ChatSounds.ringFile(nil)).caf" }
    /// Cuánto suena en el sistema una llamada que llegó por push (igual que el aviso de la app).
    static let incomingRingSeconds: TimeInterval = TimeInterval(CallRules.ringSeconds)

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
    /// CH029: llamadas que llegaron por push VoIP y están sonando en el sistema (aún sin contestar).
    private var incoming: [UUID: VoipCallPush] = [:]
    private var incomingTimeouts: [UUID: Task<Void, Never>] = [:]

    private static func configuration(ringtone: String) -> CXProviderConfiguration {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true
        config.ringtoneSound = ringtone
        if let icon = UIImage(named: "CallKitIcon")?.pngData() { config.iconTemplateImageData = icon }
        return config
    }

    override init() {
        provider = CXProvider(configuration: Self.configuration(ringtone: CallKitRules.silentRingtone))
        super.init()
        // Cola nil = principal: los métodos del delegado llegan en el hilo principal.
        provider.setDelegate(self, queue: nil)
    }

    // MARK: Empezar

    /// Registra la llamada en el sistema. `outgoing`: la empecé yo (o entré a una en curso); si no, contesté una entrante.
    /// Devuelve el UUID de CallKit, o nil si el sistema no la aceptó (la llamada sigue sin CallKit).
    func begin(outgoing: Bool, name: String, video: Bool) async -> UUID? {
        let uuid = UUID()
        // Contestar desde el aviso de la app: sin timbre del sistema (la app ya sonó).
        if incoming.isEmpty { provider.configuration = Self.configuration(ringtone: CallKitRules.silentRingtone) }
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

    // MARK: Entrante por push VoIP (CH029)

    /// Reporta al sistema el push VoIP recibido (obligatorio en cada uno). Si no es una llamada válida, se reporta y se
    /// termina en el acto. La pantalla de llamada suena con el tono de la app.
    func reportIncomingPush(_ push: VoipCallPush?) {
        provider.configuration = Self.configuration(ringtone: CallKitRules.pushRingtone(L10n.defaults.string(forKey: PushPayload.ringtoneKey)))
        let update = CXCallUpdate()
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        guard let push else {
            let uuid = UUID()
            update.remoteHandle = CXHandle(type: .generic, value: "chaggu")
            provider.reportNewIncomingCall(with: uuid, update: update) { _ in
                Task { @MainActor [weak self] in self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed) }
            }
            return
        }
        // Un UUID nuevo por timbre; si esta llamada ya suena, el mismo (el sistema la muestra una vez). Volver a llamar
        // después de que terminó de sonar es otro timbre.
        let existing = incoming.first { $0.value.callId == push.callId }?.key
        let uuid = existing ?? UUID()
        update.remoteHandle = CXHandle(type: .generic, value: push.displayName)
        update.localizedCallerName = push.displayName
        update.hasVideo = push.video
        let isNew = existing == nil
        incoming[uuid] = push
        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let error {
                    // Ya estaba sonando (dos push de la misma llamada) no es un problema; otro error sí.
                    if !isNew, (error as? CXErrorCodeIncomingCallError)?.code == .callUUIDAlreadyExists { return }
                    NSLog("[Chaggu] CallKit: no se pudo mostrar la llamada entrante: \(error.localizedDescription)")
                    self.forgetIncoming(uuid)
                    return
                }
                guard isNew else { return }
                self.incomingTimeouts[uuid] = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(CallKitRules.incomingRingSeconds * 1_000_000_000))
                    guard !Task.isCancelled, let self, self.incoming[uuid] != nil else { return }
                    self.forgetIncoming(uuid)
                    self.provider.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
                }
                self.center?.systemIncomingRinging(push)
            }
        }
    }

    /// La llamada que suena en el sistema por un push (sin contestar todavía).
    func hasIncoming(_ callId: String) -> Bool { incoming.values.contains { $0.callId == callId } }

    /// Deja de sonar en el sistema: colgó quien llama, contesté o rechacé en otro dispositivo, o ya estoy dentro.
    func endIncoming(_ callId: String, reason: CXCallEndedReason) {
        for (uuid, p) in incoming where p.callId == callId {
            forgetIncoming(uuid)
            provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
        }
    }

    private func forgetIncoming(_ uuid: UUID) {
        incoming[uuid] = nil
        incomingTimeouts.removeValue(forKey: uuid)?.cancel()
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
        let id = action.callUUID
        main {
            // Contesté en la pantalla del sistema una llamada que llegó por push: se entra a la de chaggu.
            if let push = self.incoming[id] {
                self.forgetIncoming(id)
                self.pendingVideo = push.video
                self.audioActive = false
                _ = try? CallCenter.configureAudioCategory(video: push.video)
                self.center?.systemAnswered(id, push)
            } else {
                _ = try? CallCenter.configureAudioCategory(video: self.pendingVideo)
            }
        }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let id = action.callUUID
        main {
            // Colgar mientras suena (sin contestar) = rechazar.
            if let push = self.incoming[id] {
                self.forgetIncoming(id)
                self.center?.systemDeclined(push)
            } else {
                self.center?.systemEnded(id)
            }
        }
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
