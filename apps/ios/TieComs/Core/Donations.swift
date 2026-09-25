import Foundation
import Intents

/// Donaciones de `INSendMessageIntent`: así iOS sugiere las conversaciones de TieComs en la fila de
/// arriba de la hoja de compartir (como los contactos de WhatsApp). Se donan al enviar un mensaje y al
/// abrir una conversación; se borran al cerrar sesión, eliminar la cuenta o salir de la conversación.
@MainActor
enum Donations {
    /// Deshabilitado en pruebas unitarias (no tocar el índice de sugerencias del simulador).
    static var enabled = !AppConfig.isRunningUnitTests
    private static var imageCache: [String: Data] = [:]
    private static var lastDonation: [String: Date] = [:]

    /// Intent de una conversación (función pura, se prueba en unitarias).
    static func intent(_ d: BootstrapDTO, _ c: ConversationDTO, image: INImage?) -> INSendMessageIntent {
        let me = Naming.person(d, d.me.id)
        let others = c.memberIds.filter { $0 != d.me.id }.compactMap { Naming.person(d, $0) }
        let recipients = others.prefix(10).map { p in
            INPerson(personHandle: INPersonHandle(value: p.id, type: .unknown), nameComponents: nil, displayName: p.name,
                     image: c.kind == .direct ? image : nil, contactIdentifier: nil, customIdentifier: p.id)
        }
        let sender = INPerson(personHandle: INPersonHandle(value: d.me.id, type: .unknown), nameComponents: nil,
                              displayName: me?.name ?? d.me.name, image: nil, contactIdentifier: nil, customIdentifier: d.me.id, isMe: true)
        let isGroup = c.kind != .direct
        let intent = INSendMessageIntent(recipients: Array(recipients), outgoingMessageType: .outgoingMessageText, content: nil,
                                         speakableGroupName: isGroup ? INSpeakableString(spokenPhrase: Naming.title(d, c)) : nil,
                                         conversationIdentifier: c.id, serviceName: "TieComs", sender: sender, attachments: nil)
        if isGroup, let image { intent.setImage(image, forParameterNamed: \.speakableGroupName) }
        return intent
    }

    /// Foto que representa la conversación: la del grupo, o la de la otra persona en un directo.
    static func photoPath(_ d: BootstrapDTO, _ c: ConversationDTO) -> String? {
        if let p = c.avatarUrl { return p }
        if c.kind == .direct { return Naming.otherInDirect(d, c)?.avatarUrl }
        return nil
    }

    static func donate(_ store: AppStore, conversationId: String, minInterval: TimeInterval = 0) {
        guard enabled, let d = store.data, let c = store.meta(conversationId) else { return }
        if minInterval > 0, let last = lastDonation[conversationId], Date().timeIntervalSince(last) < minInterval { return }
        lastDonation[conversationId] = Date()
        Task { @MainActor in
            var image: INImage?
            if let path = photoPath(d, c), let url = MediaURL.absolute(path) {
                if let cached = imageCache[path] { image = INImage(imageData: cached) }
                else if let (data, res) = try? await URLSession.shared.data(from: url), (res as? HTTPURLResponse)?.statusCode == 200 {
                    imageCache[path] = data
                    image = INImage(imageData: data)
                }
            }
            let interaction = INInteraction(intent: intent(d, c, image: image), response: nil)
            interaction.direction = .outgoing
            interaction.groupIdentifier = c.id
            try? await interaction.donate()
        }
    }

    static func deleteAll() {
        lastDonation = [:]
        INInteraction.deleteAll { _ in }
    }

    static func delete(conversationId: String) {
        lastDonation[conversationId] = nil
        INInteraction.delete(with: conversationId) { _ in }
    }
}
