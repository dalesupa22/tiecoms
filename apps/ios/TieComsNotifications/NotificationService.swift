import Intents
import UserNotifications

/// Notification Service Extension: convierte el push de un mensaje en una **notificación de comunicación**
/// (foto del remitente, nombre del grupo) donando un `INSendMessageIntent`. Agrupa por `thread-id`.
/// Si algo falla o se acaba el tiempo, se muestra el push tal cual llegó.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        best = content
        guard let p = PushPayload(userInfo: request.content.userInfo) else { contentHandler(content); return }
        content.threadIdentifier = p.threadId ?? p.conversationId
        guard p.kind == .message, let authorId = p.authorId else { contentHandler(content); return }
        let base = UserDefaults(suiteName: "group.com.tiecoms.app")?.string(forKey: "apiURL").flatMap(URL.init(string:))
        Task {
            var image: INImage?
            if let url = p.avatarURL(base: base) {
                var req = URLRequest(url: url)
                req.timeoutInterval = 6
                if let (data, res) = try? await URLSession.shared.data(for: req), (res as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty {
                    image = INImage(imageData: data)
                }
            }
            let updated = CommunicationNotification.update(content, payload: p, authorId: authorId, image: image) ?? content
            contentHandler(updated)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let best { contentHandler(best) }
    }
}
