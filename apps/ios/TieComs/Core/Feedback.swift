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
    /// Aviso de reunión 10 min antes (evento de cuenta `event.soon`).
    func notifyEventSoon(conversationId: String, eventId: String, title: String, subtitle: String?, body: String)
}

extension FeedbackSink {
    func notifyEventSoon(conversationId: String, eventId: String, title: String, subtitle: String?, body: String) {
        notifyIncoming(conversationId: conversationId, title: title, author: subtitle ?? "", body: body)
    }
}

enum SoundName: String, CaseIterable { case send = "tc_send", receive = "tc_receive", notify = "tc_notify", splash = "tc_splash" }

/// Háptico ligero (al enviar y en el "nudo" del splash).
@MainActor
enum Haptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    static func prepare() { light.prepare() }
    static func tap() { light.impactOccurred() }
}

/// Reproduce los .caf del bundle con la categoría `.ambient`: respeta el interruptor
/// de silencio y se mezcla con la música de otras apps sin interrumpirla.
@MainActor
final class SoundPlayer {
    private var players: [SoundName: AVAudioPlayer] = [:]
    private var configured = false

    func configure() {
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
    /// Toque en un push de sidechat: (origen, sidechat).
    var onOpenSide: ((String, String) -> Void)?
    /// Acción «Responder» desde la notificación (envía por HTTP).
    var onReply: ((String, String) async -> Void)?
    /// Acción «Marcar como leído».
    var onMarkRead: ((String) async -> Void)?
    /// El socket está en línea: los push en primer plano sobran (el aviso local ya salió).
    var socketOnline: (() -> Bool)?
    private(set) var authorized = false

    func install() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(PushRegistration.categories())
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

    func playSend() { sounds.play(.send); Haptics.tap() }
    func playSplash() { sounds.play(.splash) }
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
        content.categoryIdentifier = PushPayload.messageCategory
        if Prefs.soundsEnabled { content.sound = UNNotificationSound(named: UNNotificationSoundName("tc_notify.caf")) }
        let req = UNNotificationRequest(identifier: "msg-\(conversationId)-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    func notifyEventSoon(conversationId: String, eventId: String, title: String, subtitle: String?, body: String) {
        guard Prefs.notificationsEnabled, authorized else {
            if UIApplication.shared.applicationState == .active { sounds.play(.notify) }
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        if let subtitle { content.subtitle = subtitle }
        content.body = body
        content.threadIdentifier = conversationId
        content.userInfo = ["conversationId": conversationId, "eventId": eventId, "type": "event", "minutes": 10]
        content.categoryIdentifier = PushPayload.eventCategory
        content.interruptionLevel = .timeSensitive
        if Prefs.soundsEnabled { content.sound = UNNotificationSound(named: UNNotificationSoundName("tc_notify.caf")) }
        // Mismo id que el push (evento): si llegan los dos, iOS muestra uno.
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "event-soon-\(eventId)", content: content, trigger: nil))
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
        let isRemote = notification.request.trigger is UNPushNotificationTrigger
        let (open, online) = await MainActor.run { (AppFeedback.shared.openConversationId?(), AppFeedback.shared.socketOnline?() ?? false) }
        let info = notification.request.content.userInfo
        let isEventSoon = (info["type"] as? String) == "event" && info["minutes"] != nil
        // El aviso de reunión se muestra siempre (aunque sea el chat abierto), salvo el push duplicado del aviso local.
        if isEventSoon { return isRemote && online ? [] : [.banner, .list, .sound] }
        // En primer plano: nada si es la conversación abierta (ya sonó tc_receive).
        if let conv, conv == open { return [] }
        // Con el socket en línea el aviso local ya salió: el push remoto sería un duplicado.
        if isRemote && online { return [] }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let conv = response.notification.request.content.userInfo["conversationId"] as? String else { return }
        switch response.actionIdentifier {
        case PushRegistration.replyAction:
            let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.isEmpty, let reply = await MainActor.run(body: { AppFeedback.shared.onReply }) { await reply(conv, text) }
        case PushRegistration.markReadAction:
            if let mark = await MainActor.run(body: { AppFeedback.shared.onMarkRead }) { await mark(conv) }
        default:
            let p = PushPayload(userInfo: response.notification.request.content.userInfo)
            await MainActor.run {
                if p?.kind == .side, let origin = p?.sideOfConversationId { AppFeedback.shared.onOpenSide?(origin, conv) }
                else { AppFeedback.shared.onOpenConversation?(conv) }
            }
        }
    }
}

/// Push remoto (APNs): registro del token con el API y categorías con acciones.
/// El servidor envía por cada mensaje, recordatorio o reunión (ver PushPayload); la Notification
/// Service Extension (TieComsNotifications) la convierte en notificación de comunicación con la foto del autor.
enum PushRegistration {
    static let enabled = true
    private(set) static var token: String?
    /// Se llama con el token en hexadecimal (lo registra el AppStore con PUT /push/token).
    @MainActor static var onToken: ((String) -> Void)?

    @MainActor static func registerIfEnabled() {
        guard enabled else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    @MainActor static func tokenReceived(_ data: Data) {
        let hex = PushEnvironment.hex(data)
        token = hex
        onToken?(hex)
    }

    static let replyAction = "TC_REPLY"
    static let markReadAction = "TC_MARK_READ"

    /// Categorías: TC_MESSAGE con Responder (texto) y Marcar como leído; TC_REMINDER y TC_EVENT abren la conversación.
    static func categories() -> Set<UNNotificationCategory> {
        let reply = UNTextInputNotificationAction(identifier: replyAction, title: L("push.reply"), options: [],
                                                  textInputButtonTitle: L("chat.send"), textInputPlaceholder: L("push.replyPh"))
        let read = UNNotificationAction(identifier: markReadAction, title: L("push.markRead"), options: [])
        return [
            UNNotificationCategory(identifier: PushPayload.messageCategory, actions: [reply, read], intentIdentifiers: ["INSendMessageIntent"],
                                   options: [.hiddenPreviewsShowTitle]),
            UNNotificationCategory(identifier: PushPayload.reminderCategory, actions: [], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: PushPayload.eventCategory, actions: [], intentIdentifiers: [], options: []),
            // Sidechat: «Responder» en línea envía al sidechat sin abrir la app.
            UNNotificationCategory(identifier: PushPayload.sideCategory, actions: [reply, read], intentIdentifiers: ["INSendMessageIntent"],
                                   options: [.hiddenPreviewsShowTitle]),
        ]
    }
}
