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
    /// Con el sonido del chat (docs/SONIDOS.md). Por defecto, el de siempre.
    func playReceive(sound: String, mention: Bool)
    /// Encolar no significa admitir: el id y dueño viajan hasta willPresent.
    func notifyMessage(_ message: ForegroundMessage, title: String, author: String, body: String)
    func cancelPendingMessages()
    /// Aviso de reunión 10 min antes (evento de cuenta `event.soon`).
    func notifyEventSoon(conversationId: String, eventId: String, title: String, subtitle: String?, body: String)
}

extension FeedbackSink {
    /// Sonido del chat (docs/SONIDOS.md): por defecto, el de siempre.
    func playReceive(sound: String, mention: Bool) { playReceive() }
    func cancelPendingMessages() {}
    func notifyMessage(_ message: ForegroundMessage, title: String, author: String, body: String) {
        notifyIncoming(conversationId: message.conversationId, title: title, author: author, body: body)
    }

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

/// Adaptador injectable: las pruebas controlan permiso, rechazo y orden del callback de presentación.
@MainActor
protocol LocalNotificationCenter: AnyObject {
    func isAuthorized() async -> Bool
    func add(_ request: UNNotificationRequest, completion: @escaping @MainActor (Bool) -> Void)
    func removePending(_ identifiers: [String])
}

@MainActor
private final class SystemLocalNotificationCenter: LocalNotificationCenter {
    func isAuthorized() async -> Bool {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        return s.authorizationStatus == .authorized || s.authorizationStatus == .provisional || s.authorizationStatus == .ephemeral
    }
    func add(_ request: UNNotificationRequest, completion: @escaping @MainActor (Bool) -> Void) {
        // Ni el éxito de add ni su fallo consumen el aviso: sólo willPresent lo admite.
        UNUserNotificationCenter.current().add(request) { error in
            let accepted = error == nil
            Task { @MainActor in completion(accepted) }
        }
    }
    func removePending(_ identifiers: [String]) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
    }
}

/// Sonidos y presentación de notificaciones locales y remotas.
@MainActor
final class AppFeedback: NSObject, FeedbackSink, UNUserNotificationCenterDelegate {
    static let shared = AppFeedback()
    let sounds = SoundPlayer()
    /// Conversación visible ahora mismo (en pantalla, app activa y cargada) para decidir si se presenta el banner.
    var openConversationId: (() -> String?)?
    /// Push remoto de un mensaje en primer plano: el store decide con el registro de ids ya anunciados.
    var presentsMessage: ((PushPayload, String?, Bool) -> Bool)?
    /// Toque en una notificación.
    var onOpenConversation: ((String) -> Void)?
    /// Toque en un push de sidechat: (origen, sidechat).
    var onOpenSide: ((String, String) -> Void)?
    /// Toque en un push de reacción: (conversación, mensaje).
    var onOpenMessage: ((String, String) -> Void)?
    /// Push de tarea asignada: (issueId, conversationId, inChat).
    var onOpenIssue: ((String, String, Bool) -> Void)?
    /// Acción «Responder» desde la notificación (envía por HTTP).
    var onReply: ((String, String) async -> Void)?
    /// Push de llamada: «Contestar» (o tocarlo) entra a la llamada.
    var onAnswerCall: ((String) -> Void)?
    /// Acción «Marcar como leído».
    var onMarkRead: ((String) async -> Void)?
    /// El socket está en línea: los push en primer plano que no son de mensajes (recordatorio, reacción, tarea,
    /// aviso de reunión) sobran porque el socket ya los avisó. Los de mensajes usan `presentsMessage`.
    var socketOnline: (() -> Bool)?
    /// «No molestar» activo: en primer plano no se presenta ningún aviso (ni local ni push).
    var dndActive: (() -> Bool)?
    private(set) var authorized = false
    private let localCenter: LocalNotificationCenter
    var foregroundSession: (() -> String?)?
    private var pendingMessages: Set<String> = []
    private var queueGeneration = UUID()
    private var fallbackSounds = AnnouncedLedger(capacity: 300)
    private let playNotificationSound: (() -> Void)?

    init(localCenter: LocalNotificationCenter? = nil, playNotificationSound: (() -> Void)? = nil) {
        self.localCenter = localCenter ?? SystemLocalNotificationCenter()
        self.playNotificationSound = playNotificationSound
        super.init()
    }

    func install() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(PushRegistration.categories())
        Task { await refreshAuthorization() }
    }

    func refreshAuthorization() async {
        authorized = await localCenter.isAuthorized()
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
    }

    func playSend() { sounds.play(.send); Haptics.tap() }
    func playSplash() { sounds.play(.splash) }
    func playReceive() { sounds.play(.receive) }
    /// Mensaje en vivo con el sonido del chat ("none" = nada).
    func playReceive(sound: String, mention: Bool) { ChoiceSoundPlayer.shared.play(ChatSounds.file(sound, mention: mention)) }

    func notifyIncoming(conversationId: String, title: String, author: String, body: String) {
        notifyIncoming(conversationId: conversationId, title: title, author: author, body: body, sound: SoundName.notify.rawValue)
    }

    /// `sound`: archivo del sonido del chat (sin extensión); nil = sin sonido.
    func notifyIncoming(conversationId: String, title: String, author: String, body: String, sound: String?) {
        let appActive = UIApplication.shared.applicationState == .active
        guard Prefs.notificationsEnabled, authorized else {
            if appActive, let sound { ChoiceSoundPlayer.shared.play(sound) }
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = author
        content.body = String(body.prefix(240))
        content.threadIdentifier = conversationId
        content.userInfo = ["conversationId": conversationId]
        content.categoryIdentifier = PushPayload.messageCategory
        if Prefs.soundsEnabled, let sound { content.sound = UNNotificationSound(named: UNNotificationSoundName("\(sound).caf")) }
        let req = UNNotificationRequest(identifier: "msg-\(conversationId)-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    func notifyMessage(_ message: ForegroundMessage, title: String, author: String, body: String) {
        guard foregroundSession?() == message.owner else { return }
        guard Prefs.notificationsEnabled, authorized else {
            let key = "\(message.owner)|\(message.messageId)"
            if Prefs.soundsEnabled, message.soundFile != nil, fallbackSounds.record(key, .sound) {
                if let playNotificationSound { playNotificationSound() } else { ChoiceSoundPlayer.shared.play(message.soundFile) }
            }
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = author
        content.body = String(body.prefix(240))
        content.threadIdentifier = message.conversationId
        content.userInfo = message.userInfo
        content.categoryIdentifier = PushPayload.messageCategory
        if Prefs.soundsEnabled, let file = message.soundFile { content.sound = UNNotificationSound(named: UNNotificationSoundName("\(file).caf")) }
        let id = "msg-\(message.owner)-\(message.messageId)", generation = queueGeneration
        pendingMessages.insert(id)
        localCenter.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { [weak self] accepted in
            guard let self else { return }
            if !accepted { self.pendingMessages.remove(id); return }
            if generation != self.queueGeneration || self.foregroundSession?() != message.owner {
                self.localCenter.removePending([id])
                self.pendingMessages.remove(id)
            }
        }
    }

    func cancelPendingMessages() {
        queueGeneration = UUID()
        localCenter.removePending(Array(pendingMessages))
        pendingMessages.removeAll()
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
        let info = notification.request.content.userInfo
        let remote = notification.request.trigger is UNPushNotificationTrigger
        if !remote { _ = await MainActor.run { pendingMessages.remove(notification.request.identifier) } }
        return await presentationOptions(userInfo: info, isRemote: remote)
    }

    /// Único punto de admisión para mensajes locales y remotos. Se ejecuta en MainActor sin awaits entre
    /// consultar y registrar la decisión, aunque add o el socket terminen en el orden contrario.
    func presentationOptions(userInfo: [AnyHashable: Any], isRemote: Bool) -> UNNotificationPresentationOptions {
        guard Prefs.notificationsEnabled else { return [] }
        let open = openConversationId?()
        let online = socketOnline?() ?? false
        let options: UNNotificationPresentationOptions = Prefs.soundsEnabled ? [.banner, .list, .sound] : [.banner, .list]
        if let payload = PushPayload(userInfo: userInfo), payload.messageId != nil, ForegroundPush.isMessage(payload.kind) {
            // Los avisos locales nuevos siempre tienen dueño. Un callback local sin dueño no puede consumir un id.
            let owner = isRemote ? nil : userInfo[ForegroundMessage.ownerKey] as? String
            guard isRemote || (owner != nil && foregroundSession?() == owner) else { return [] }
            let currentOwner = foregroundSession?()
            let played = currentOwner.map { fallbackSounds.contains("\($0)|\(payload.messageId ?? "")") } ?? false
            let present = presentsMessage?(payload, owner, played) ?? false
            guard present else { return [] }
            var messageOptions = options
            if played { messageOptions.remove(.sound) }
            return messageOptions
        }
        guard NotifyRule.presentsInForeground(dnd: dndActive?() ?? false) else { return [] }
        let isEventSoon = (userInfo["type"] as? String) == "event" && userInfo["minutes"] != nil
        if isEventSoon { return isRemote && online ? [] : options }
        // Llamada: con la app abierta y en línea ya suena el aviso propio (call.ringing).
        if (userInfo["type"] as? String) == "call" { return online ? [] : options }
        if let conv = userInfo["conversationId"] as? String, conv == open { return [] }
        if isRemote && online { return [] }
        return options
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let conv = response.notification.request.content.userInfo["conversationId"] as? String else { return }
        switch response.actionIdentifier {
        case PushRegistration.replyAction:
            let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.isEmpty, let reply = await MainActor.run(body: { AppFeedback.shared.onReply }) { await reply(conv, text) }
        case PushRegistration.markReadAction:
            if let mark = await MainActor.run(body: { AppFeedback.shared.onMarkRead }) { await mark(conv) }
        case PushRegistration.callDeclineAction, UNNotificationDismissActionIdentifier:
            break
        case PushRegistration.callAnswerAction where PushPayload(userInfo: response.notification.request.content.userInfo)?.callId != nil:
            let id = PushPayload(userInfo: response.notification.request.content.userInfo)?.callId ?? ""
            await MainActor.run { AppFeedback.shared.onAnswerCall?(id) }
        default:
            let p = PushPayload(userInfo: response.notification.request.content.userInfo)
            await MainActor.run {
                if p?.kind == .call, let callId = p?.callId { AppFeedback.shared.onAnswerCall?(callId) }
                else if p?.kind == .issue, let issue = p?.issueId { AppFeedback.shared.onOpenIssue?(issue, conv, p?.inChat ?? true) }
                else if p?.kind == .side, let origin = p?.sideOfConversationId { AppFeedback.shared.onOpenSide?(origin, conv) }
                else if p?.kind == .reaction, let mid = p?.messageId, let open = AppFeedback.shared.onOpenMessage { open(conv, mid) }
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
        guard enabled, Prefs.notificationsEnabled, AppFeedback.shared.authorized else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    @MainActor static func unregister() {
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    @MainActor static func tokenReceived(_ data: Data) {
        let hex = PushEnvironment.hex(data)
        token = hex
        onToken?(hex)
    }

    static let replyAction = "TC_REPLY"
    static let callAnswerAction = "TC_CALL_ANSWER"
    static let callDeclineAction = "TC_CALL_DECLINE"
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
            // Llamada entrante: Contestar abre la app y entra; Ahora no solo cierra el aviso.
            UNNotificationCategory(identifier: PushPayload.callCategory,
                                   actions: [UNNotificationAction(identifier: callAnswerAction, title: L("call.answer"), options: [.foreground]),
                                             UNNotificationAction(identifier: callDeclineAction, title: L("call.decline"), options: [.destructive])],
                                   intentIdentifiers: [], options: [.customDismissAction]),
        ]
    }
}

/// Serializa PUT/DELETE: un apagado durante un PUT siempre termina en DELETE.
/// Los fallos conservan el estado pendiente para el siguiente intento, sin un bucle de red.
@MainActor
final class PushTokenSync {
    enum Operation: Equatable { case register(String), unregister }
    private let send: (Operation) async throws -> Void
    private var active = false
    private var generation = 0
    private var enabled = false
    private var token: String?
    private var serverCleared = false
    private var dirty = false
    private var task: Task<Void, Never>?
    private(set) var registeredToken: String?
    /// Idioma con el que quedó registrado el token: el mismo token en otro idioma se vuelve a registrar.
    private(set) var registeredLang: String?
    /// Idioma actual (el del PUT). Inyectable en pruebas.
    private let currentLang: () -> String

    init(lang: @escaping () -> String = { L10n.lang }, send: @escaping (Operation) async throws -> Void) {
        self.currentLang = lang
        self.send = send
    }

    func startSession() {
        generation += 1
        active = true
        enabled = false
        registeredToken = nil
        registeredLang = nil
        serverCleared = false
        dirty = true
    }

    func endSession() {
        generation += 1
        active = false
        registeredToken = nil
        registeredLang = nil
        serverCleared = false
    }

    func setEnabled(_ value: Bool) {
        if enabled != value { enabled = value; dirty = true }
    }

    /// Vuelve a mandar el mismo token (p. ej. cambió el idioma: el servidor arma los avisos en ese `lang`).
    func resendToken() {
        registeredToken = nil
        registeredLang = nil
        dirty = true
    }

    func receive(_ value: String) {
        if token != value { token = value; dirty = true }
    }

    func synchronize() async {
        guard active else { return }
        dirty = true
        if let task { await task.value; return }
        let next = Task { await run() }
        task = next
        await next.value
    }

    private func run() async {
        defer { task = nil }
        while active && dirty {
            dirty = false
            let operation: Operation
            let lang = currentLang()
            if enabled {
                // Se compara token E idioma: si el idioma cambió durante un PUT en curso, sale otro PUT con el nuevo.
                guard let token, token != registeredToken || lang != registeredLang else { continue }
                operation = .register(token)
                // Una respuesta perdida no prueba que el servidor no guardó el token.
                serverCleared = false
                registeredToken = nil
            } else {
                guard !serverCleared else { continue }
                operation = .unregister
            }
            let currentGeneration = generation
            do {
                try await send(operation)
                guard active, generation == currentGeneration else { continue }
                switch operation {
                case .register(let token): registeredToken = token; registeredLang = lang
                case .unregister: registeredToken = nil; registeredLang = nil; serverCleared = true
                }
            } catch {
                NSLog("[Chaggu] registro push pendiente; se reintentará al volver o recuperar la red")
            }
        }
    }
}
