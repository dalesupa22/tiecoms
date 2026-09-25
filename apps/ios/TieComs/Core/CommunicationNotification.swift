import Foundation
import Intents
import UserNotifications

/// Notificación de comunicación (foto del remitente, nombre del grupo) a partir de un push de TieComs.
/// La usa la Notification Service Extension; vive en Core para poder probarla.
enum CommunicationNotification {
    static func intent(payload p: PushPayload, authorId: String, image: INImage?) -> INSendMessageIntent {
        let senderName = p.authorName ?? (p.isGroup ? (p.subtitle ?? "") : p.title)
        let sender = INPerson(personHandle: INPersonHandle(value: authorId, type: .unknown), nameComponents: nil,
                              displayName: senderName, image: image, contactIdentifier: nil, customIdentifier: authorId)
        let me = INPerson(personHandle: INPersonHandle(value: "me", type: .unknown), nameComponents: nil, displayName: nil,
                          image: nil, contactIdentifier: nil, customIdentifier: nil, isMe: true)
        return INSendMessageIntent(recipients: p.isGroup ? [me, sender] : [me], outgoingMessageType: .outgoingMessageText,
                                   content: p.body, speakableGroupName: p.isGroup ? INSpeakableString(spokenPhrase: p.title) : nil,
                                   conversationIdentifier: p.conversationId, serviceName: "TieComs", sender: sender, attachments: nil)
    }

    /// Dona el intent y devuelve el contenido actualizado (nil si el sistema no lo acepta, p. ej. sin el entitlement).
    static func update(_ content: UNMutableNotificationContent, payload p: PushPayload, authorId: String, image: INImage?) -> UNNotificationContent? {
        let intent = intent(payload: p, authorId: authorId, image: image)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate(completion: nil)
        return try? content.updating(from: intent)
    }
}
