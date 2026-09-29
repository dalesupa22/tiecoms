import Foundation
import SwiftUI

// Temas del chat (docs/TEMAS.md): etiquetas de los mensajes que se ven como banderitas arriba del chat.
// Un chat sigue siendo un solo chat; los temas no son hilos ni tareas. Igual que apps/web/src/screens/Topics.tsx.

/// Reglas puras de los temas (sin red), compartidas por la vista y las pruebas.
enum TopicRules {
    /// Tope técnico del servidor (TOPIC_LIMIT). No hay límite práctico: si el servidor responde 409, se muestra su mensaje.
    static let serverLimit = 50
    static let colors = ["blue", "green", "orange", "violet", "magenta", "aqua", "red", "yellow"]
    static let icons = ["🌐", "🌱", "💰", "📣", "📈", "🤝", "🎯", "🧾", "⚙️", "📦", "🎓", "⚖️"]

    /// Activos en el orden de la fila (el servidor ya los manda así; se ordena por si acaso).
    static func active(_ list: [TopicDTO]) -> [TopicDTO] {
        list.filter { !$0.isArchived }.sorted { $0.position == $1.position ? $0.createdAt < $1.createdAt : $0.position < $1.position }
    }
    static func archived(_ list: [TopicDTO]) -> [TopicDTO] { list.filter(\.isArchived) }

    /// Mensajes (no eliminados) por tema, para el conteo de cada banderita.
    static func counts(_ messages: [MessageDTO]) -> [String: Int] {
        var n: [String: Int] = [:]
        for m in messages where m.deletedAt == nil { if let t = m.topicId { n[t, default: 0] += 1 } }
        return n
    }

    /// El filtro solo vale para un tema activo que exista (si lo archivan o quitan, el chat vuelve a «Todo»).
    static func effectiveFilter(_ filter: String?, in list: [TopicDTO]) -> String? {
        guard let filter, list.contains(where: { $0.id == filter && !$0.isArchived }) else { return nil }
        return filter
    }

    /// ¿Se ve este mensaje con el filtro? Sin filtro, todos.
    static func matches(_ m: MessageDTO, filter: String?) -> Bool { filter == nil || m.topicId == filter }

    // «Todo» con temas activos (docs/TEMAS.md › «Todo», 29-sep-2026; web Conversation.tsx hideTopicsInAll/topicUnread).

    /// Ids de los temas activos (los archivados cuentan como sin tema).
    static func activeIds(_ list: [TopicDTO]) -> Set<String> { Set(list.filter { !$0.isArchived }.map(\.id)) }

    /// En «Todo» se esconde lo ya leído (al abrir) que tiene un tema activo, salvo los mensajes a los que se saltó.
    static func hiddenInAll(_ m: MessageDTO, filter: String?, active: Set<String>, baseRead: Int, revealed: Set<Int>) -> Bool {
        guard filter == nil, !active.isEmpty, let t = m.topicId, active.contains(t) else { return false }
        return m.seq <= baseRead && !revealed.contains(m.seq)
    }

    /// ¿Cuenta como no leído para las banderitas? Texto de otra persona, no eliminado, después de lo leído.
    static func countsAsUnread(_ m: MessageDTO, after read: Int, me: String) -> Bool {
        m.seq > read && m.deletedAt == nil && m.kind == "text" && m.authorId != me
    }

    /// Sin leer por tema activo; la clave "" es lo sin tema (el número de «Todo»). Sin pendientes, no hay clave.
    static func unreadCounts(_ messages: [MessageDTO], read: Int, me: String, active: Set<String>) -> [String: Int] {
        var n: [String: Int] = [:]
        for m in messages where countsAsUnread(m, after: read, me: me) {
            n[m.topicId.flatMap { active.contains($0) ? $0 : nil } ?? "", default: 0] += 1
        }
        return n
    }

    /// Al abrir con no leídos: si todos están en un solo tema activo, ese tema (el chat abre filtrado); si no, nil («Todo»).
    static func autoTopic(_ messages: [MessageDTO], after read: Int, me: String, active: Set<String>) -> String? {
        let keys = Set(unreadCounts(messages, read: read, me: me, active: active).keys)
        guard keys.count == 1, let only = keys.first, !only.isEmpty else { return nil }
        return only
    }

    /// Primer ícono y color que el chat aún no usa (como la web).
    static func suggestedIcon(_ list: [TopicDTO]) -> String { icons.first { i in !list.contains { $0.icon == i } } ?? icons[0] }
    static func suggestedColor(_ list: [TopicDTO]) -> String { colors.first { c in !list.contains { $0.color == c } } ?? "blue" }

    /// «· tema puesto por X» cuando no lo puso el autor («Tú» si fui yo).
    static func byLine(_ m: MessageDTO, me: String, name: (String) -> String?) -> String? {
        guard let by = m.topicBy, m.topicId != nil, by != m.authorId else { return nil }
        let who = by == me ? L("common.youShort") : (name(by)?.split(separator: " ").first.map(String.init) ?? "")
        return L("topic.by", ["name": who])
    }
}

/// Colores pastel de las banderitas (apps/web/src/styles.css, .c-<color>): fondo e tinta, con variante oscura.
enum TopicPalette {
    private static let table: [String: (bg: UInt32, ink: UInt32, darkBg: UInt32, darkInk: UInt32)] = [
        "blue": (0xDBE8F8, 0x1D4F8C, 0x1E3350, 0xB9D3F2),
        "green": (0xDCEFD6, 0x2F6B2A, 0x21381E, 0xBEE0B4),
        "orange": (0xFBE2CF, 0x9A4A14, 0x442A17, 0xF5C8A6),
        "violet": (0xE6E1F8, 0x4D3A9E, 0x2C2550, 0xCFC6F2),
        "magenta": (0xF7DBE9, 0x8E2A5E, 0x44203A, 0xEEBDD6),
        "aqua": (0xD5F0EC, 0x17665D, 0x173B37, 0xAEE2DA),
        "red": (0xF9DCD6, 0x9A2E1C, 0x46221C, 0xF2BDB2),
        "yellow": (0xF8EDC5, 0x7A5A06, 0x3E3313, 0xEDDB98),
    ]
    static func bg(_ color: String) -> Color {
        let t = table[color] ?? table["blue"]!
        return Color(light: t.bg, dark: t.darkBg)
    }
    static func ink(_ color: String) -> Color {
        let t = table[color] ?? table["blue"]!
        return Color(light: t.ink, dark: t.darkInk)
    }
    /// Archivado: gris.
    static let grayBg = Color(light: 0xEFEBE6, dark: 0x2E2A27)
    static let grayInk = Theme.textSecondary
}

// MARK: - Red

extension AppStore {
    func loadTopics(_ conversationId: String) async throws {
        let stamp = sessionStamp
        let r: TopicsResult = try await api.request("/conversations/\(conversationId)/topics")
        try requireSession(stamp)
        topics[conversationId] = r.topics
    }

    /// Crea un tema; 409 = nombre repetido o tope técnico (se muestra el mensaje del servidor).
    @discardableResult
    func createTopic(_ conversationId: String, name: String, icon: String, color: String) async throws -> TopicDTO? {
        let r: TopicsResult = try await api.request("/conversations/\(conversationId)/topics", method: "POST",
                                                    json: ["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "icon": icon, "color": color])
        topics[conversationId] = r.topics
        return r.topic ?? r.topics.first { $0.name == name.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    /// PATCH /topics/:id con `{ name?, color?, icon?, archived?, position? }`.
    func updateTopic(_ t: TopicDTO, _ patch: [String: Any]) async throws {
        let r: TopicsResult = try await api.request("/topics/\(t.id)", method: "PATCH", json: patch)
        topics[t.conversationId] = r.topics
    }

    /// Quitar: se borra la banderita y sus mensajes quedan sin tema (no se borra ningún mensaje).
    func deleteTopic(_ t: TopicDTO) async throws {
        let r: TopicsResult = try await api.request("/topics/\(t.id)", method: "DELETE")
        topics[t.conversationId] = r.topics
        // Sin esperar los message.updated: la etiqueta desaparece al momento.
        clearTopicLocally(t.id, in: t.conversationId)
    }

    /// Etiquetar cualquier mensaje del chat con un tema activo (o `nil` = sin tema).
    @discardableResult
    func setMessageTopic(_ m: MessageDTO, _ topicId: String?) async throws -> MessageDTO {
        let out: MessageDTO = try await api.request("/messages/\(m.id)/topic", method: "PUT", json: ["topicId": topicId ?? NSNull()])
        upsertLocal(out)
        return out
    }
}
