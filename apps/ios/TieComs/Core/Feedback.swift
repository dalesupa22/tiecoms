import AVFoundation
import Foundation
import UIKit
@preconcurrency import UserNotifications

/// Sonidos y avisos. Protocolo para poder observarlos en pruebas.
@MainActor
protocol FeedbackSink: AnyObject {
    func playSend()
    func playReceive()
    /// Mensaje de otra persona en una conversación que no está abierta (app en primer plano).
    func notifyIncoming(conversationId: String, title: String, author: String, body: String)
}

enum SoundName: String, CaseIterable { case send = "tc_send", receive = "tc_receive", notify = "tc_notify" }

/// Reproduce los .caf del bundle con la categoría `.ambient`: respeta el interruptor
/// de silencio y se mezcla con la música de otras apps sin interrumpirla.
@MainActor
final class SoundPlayer {
    private var players: [SoundName: AVAudioPlayer] = [:]
    private var configured = false

    private func configure() {
        guard !configured else { return }
        configured = true
        try? AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        for s in SoundName.allCases {
            guard let url = Bundle.main.url(forResource: s.rawValue, withExtension: "caf"),
                  let p = try? AVAudioPlayer(contentsOf: url) else { continue }
            p.prepareToPlay()
            players[s] = p
        }
    }

    func play(_ s: SoundName) {
        guard Prefs.soundsEnabled else { return }
        configure()
        guard let p = players[s] else { return }
        p.currentTime = 0
        p.play()
    }
}

/// Sonidos + notificaciones locales. Push remoto (APNs) aún no existe en el
/// backend: ver `PushRegistration`.
@MainActor
final class AppFeedback: NSObject, FeedbackSink, UNUserNotificationCenterDelegate {
    static let shared = AppFeedback()
    let sounds = SoundPlayer()
    /// Conversación visible ahora mismo (para decidir si se presenta el banner).
    var openConversationId: (() -> String?)?
    /// Toque en una notificación.
    var onOpenConversation: ((String) -> Void)?
    private(set) var authorized = false

    func install() {
        UNUserNotificationCenter.current().delegate = self
        Task { await refreshAuthorization() }
    }

    func refreshAuthorization() async {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        authorized = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional || s.authorizationStatus == .ephemeral
    }

    /// Se pide permiso tras entrar por primera vez (no en la pantalla de login).
    func requestAuthorizationIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let s = await center.notificationSettings()
        if s.authorizationStatus == .notDetermined && Prefs.notificationsEnabled {
            authorized = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        } else {
            await refreshAuthorization()
        }
        PushRegistration.registerIfEnabled()
    }

    func playSend() { sounds.play(.send) }
    func playReceive() { sounds.play(.receive) }

    func notifyIncoming(conversationId: String, title: String, author: String, body: String) {
        let appActive = UIApplication.shared.applicationState == .active
        guard Prefs.notificationsEnabled, authorized else {
            if appActive { sounds.play(.notify) }
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = author
        content.body = String(body.prefix(240))
        content.threadIdentifier = conversationId
        content.userInfo = ["conversationId": conversationId]
        if Prefs.soundsEnabled { content.sound = UNNotificationSound(named: UNNotificationSoundName("tc_notify.caf")) }
        let req = UNNotificationRequest(identifier: "msg-\(conversationId)-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    func clearNotifications(conversationId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { list in
            let ids = list.filter { $0.request.content.threadIdentifier == conversationId }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let conv = notification.request.content.userInfo["conversationId"] as? String
        let open = await MainActor.run { AppFeedback.shared.openConversationId?() }
        // En primer plano: banner solo si el mensaje es de otra conversación.
        if let conv, conv == open { return [] }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let conv = response.notification.request.content.userInfo["conversationId"] as? String else { return }
        await MainActor.run { AppFeedback.shared.onOpenConversation?(conv) }
    }
}

/// Punto de extensión para push remoto (APNs).
///
/// El backend todavía no acepta tokens de dispositivo. Cuando exista el endpoint
/// (p. ej. `POST /api/v1/devices/push {platform:"ios", token}`):
///   1. Activar la capacidad "Push Notifications" (entitlement `aps-environment`).
///   2. Poner `enabled = true`.
///   3. Enviar `token` en `tokenReceived` con el APIClient.
enum PushRegistration {
    static let enabled = false
    private(set) static var token: String?

    @MainActor static func registerIfEnabled() {
        guard enabled else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    static func tokenReceived(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        // Aún no se envía a ningún lado (no hay endpoint en el API).
    }
}
