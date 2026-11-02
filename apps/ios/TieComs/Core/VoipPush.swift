import Foundation
import PushKit

// Llamada entrante con la app cerrada o el teléfono bloqueado (CH029), como WhatsApp.
//
// - PushKit da un token VoIP aparte del de avisos; se registra con PUT /push/token {provider:'apns_voip'} junto al de
//   avisos (mismas condiciones: notificaciones activas y permiso dado). Solo donde se puede usar CallKit (no en China).
// - El servidor manda a ese token un push VoIP por cada llamada entrante (y ya no el aviso normal a esa sesión).
// - Regla de iOS: cada push VoIP se reporta a CallKit en el momento (reportNewIncomingCall) o el sistema cierra la app
//   y deja de entregarlos. Lo hace CallKitBridge.reportIncomingPush, también si la llamada ya no aplica (se reporta y
//   se termina enseguida).

/// Lo que trae el push VoIP de llamada (docs/PUSH.md): type 'call', callId, conversationId, kind, callerName, subtitle.
struct VoipCallPush: Equatable, Sendable {
    var callId: String
    var conversationId: String
    var video: Bool
    var callerName: String
    /// Nombre del grupo (nil en un directo).
    var subtitle: String?

    init(callId: String, conversationId: String, video: Bool, callerName: String, subtitle: String?) {
        self.callId = callId; self.conversationId = conversationId; self.video = video; self.callerName = callerName; self.subtitle = subtitle
    }

    /// nil si no es un push de llamada (igual hay que reportarlo a CallKit: ver CallKitBridge.reportIncomingPush).
    init?(_ payload: [AnyHashable: Any]) {
        guard (payload["type"] as? String) == "call", let id = payload["callId"] as? String, !id.isEmpty else { return nil }
        callId = id
        conversationId = payload["conversationId"] as? String ?? ""
        video = (payload["kind"] as? String) == "video"
        callerName = (payload["callerName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let sub = (payload["subtitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        subtitle = sub.isEmpty ? nil : sub
    }

    /// Cómo se ve en la pantalla de llamada y en Recientes: «Danny» o «Danny · Ventas».
    var displayName: String {
        let who = CallKitRules.handleName(callerName)
        guard let subtitle else { return who }
        return CallKitRules.handleName("\(who) · \(subtitle)")
    }
}

/// Registro de PushKit (un solo registro para la app).
@MainActor
final class VoipPush: NSObject {
    static let shared = VoipPush()

    private var registry: PKPushRegistry?
    /// Token VoIP en hexadecimal (nil hasta que PushKit lo da o si lo invalidó).
    private(set) var token: String?
    /// Token nuevo → AppStore.registerVoipToken.
    var onToken: ((String) -> Void)?
    /// Push de llamada: el receptor lo reporta a CallKit ANTES de devolver (regla de iOS 13+).
    var onIncoming: ((VoipCallPush?, [AnyHashable: Any]) -> Void)?

    /// Se llama al arrancar la app (también cuando iOS la abre en segundo plano por un push VoIP).
    func start() {
        guard registry == nil, CallKitRules.enabled() else { return }
        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r
    }

    fileprivate func received(_ data: Data) {
        let hex = PushEnvironment.hex(data)
        token = hex
        onToken?(hex)
    }
}

extension VoipPush: PKPushRegistryDelegate {
    // La cola del registro es la principal.
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let data = pushCredentials.token
        MainActor.assumeIsolated { self.received(data) }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        MainActor.assumeIsolated { self.token = nil }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType,
                                  completion: @escaping () -> Void) {
        let dict = payload.dictionaryPayload
        MainActor.assumeIsolated {
            if type == .voIP { self.onIncoming?(VoipCallPush(dict), dict) }
            completion()
        }
    }
}
