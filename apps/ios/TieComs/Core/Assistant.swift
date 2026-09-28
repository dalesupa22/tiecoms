import Foundation

/// gg (se pronuncia «yiyi»), el asistente de Chaggu: modelos, historial local y API (docs/ASISTENTE.md).
/// Igual que la web (apps/web/src/screens/Assistant.tsx).

/// Acción que gg preparó o hizo (`AssistantActionDTO` de packages/contracts). Decodificación tolerante.
struct AssistantActionDTO: Codable, Equatable, Identifiable {
    enum Kind: String, Codable, CaseIterable {
        case sendMessage = "send_message", createGroup = "create_group", createIssue = "create_issue", updateIssue = "update_issue"
        case createEvent = "create_event", cancelEvent = "cancel_event", markRead = "mark_read", unknown
    }
    enum Status: String, Codable { case pending, done, failed, undone }

    var id: String
    var kind: Kind
    var status: Status
    var target: String
    var text: String
    var detail: String?
    var token: String?
    var undoToken: String?
    var link: String?
    var error: String?

    init(id: String, kind: Kind, status: Status, target: String = "", text: String = "", detail: String? = nil,
         token: String? = nil, undoToken: String? = nil, link: String? = nil, error: String? = nil) {
        self.id = id; self.kind = kind; self.status = status; self.target = target; self.text = text
        self.detail = detail; self.token = token; self.undoToken = undoToken; self.link = link; self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        kind = Kind(rawValue: (try? c.decode(String.self, forKey: .kind)) ?? "") ?? .unknown
        status = Status(rawValue: (try? c.decode(String.self, forKey: .status)) ?? "") ?? .failed
        target = (try? c.decodeIfPresent(String.self, forKey: .target)) ?? ""
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        token = try? c.decodeIfPresent(String.self, forKey: .token)
        undoToken = try? c.decodeIfPresent(String.self, forKey: .undoToken)
        link = try? c.decodeIfPresent(String.self, forKey: .link)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }

    /// Íconos por tipo (iguales en web, iOS y Android).
    var icon: String {
        switch kind {
        case .sendMessage: return "✉\u{FE0E}"
        case .createGroup: return "▦\u{FE0E}"
        case .createIssue: return "◆\u{FE0E}"
        case .updateIssue: return "✓\u{FE0E}"
        case .createEvent: return "▤\u{FE0E}"
        case .cancelEvent: return "⊘\u{FE0E}"
        case .markRead: return "◉\u{FE0E}"
        case .unknown: return "•"
        }
    }

    /// Texto del botón principal de una acción pendiente.
    var verbKey: String {
        switch kind {
        case .sendMessage: return "ai.send"
        case .createGroup: return "ai.create"
        case .cancelEvent: return "ai.cancelEvent"
        default: return "ai.confirm"
        }
    }
}

struct AssistantTurnDTO: Decodable, Equatable {
    var reply: String
    var actions: [AssistantActionDTO]
    init(reply: String, actions: [AssistantActionDTO]) { self.reply = reply; self.actions = actions }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reply = (try? c.decode(String.self, forKey: .reply)) ?? ""
        actions = (try? c.decodeIfPresent([AssistantActionDTO].self, forKey: .actions)) ?? []
    }
    private enum CodingKeys: String, CodingKey { case reply, actions }
}

/// Un turno de la conversación con gg (se guarda en el dispositivo).
struct AssistantTurn: Codable, Equatable, Identifiable {
    enum Role: String, Codable { case user, assistant }
    var id = UUID()
    var role: Role
    var content: String
    var actions: [AssistantActionDTO]?
    var at = Date()
}

enum Assistant {
    /// Últimos turnos que se guardan y que se mandan al modelo.
    static let maxKeep = 40
    static let maxSend = 20
    /// Mantener presionada la burbuja (s) para hablar.
    static let holdSeconds = 0.45

    /// «envíalos», «mándalos», «dale», «sí, envía»… confirman aquí mismo los borradores pendientes.
    static func isSendAll(_ text: String) -> Bool {
        let re = #"^\s*(s[ií],?\s*)?(env[ií]a(los|las|lo|la)?|m[aá]nda(los|las|lo|la)?|dale|send( them| it)?)\s*[.!]?\s*$"#
        return text.range(of: re, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// gg se pronuncia «yiyi»: se reemplaza antes de leer en voz alta.
    static func speakable(_ text: String) -> String {
        text.replacingOccurrences(of: #"\bgg\b"#, with: "yiyi", options: [.regularExpression, .caseInsensitive])
    }

    /// Historial para /assistant/turn: los últimos 20 turnos; si un turno tuvo acciones, se le suma un resumen sin tokens.
    static func payload(_ turns: [AssistantTurn]) -> [[String: String]] {
        turns.suffix(maxSend).map { t in
            var content = t.content
            if let acts = t.actions, !acts.isEmpty {
                content += "\n[" + acts.map { "\($0.status.rawValue): \($0.kind.rawValue) → \($0.target): \($0.text)" }.joined(separator: " | ") + "]"
            }
            return ["role": t.role.rawValue, "content": String(content.prefix(4000))]
        }
    }

    /// Acciones que esperan confirmación, en orden.
    static func pending(_ turns: [AssistantTurn]) -> [AssistantActionDTO] {
        turns.flatMap { $0.actions ?? [] }.filter { $0.status == .pending && $0.token != nil }
    }

    /// Cambia una acción donde esté.
    static func patch(_ turns: inout [AssistantTurn], _ id: String, _ change: (inout AssistantActionDTO) -> Void) {
        for i in turns.indices {
            guard var acts = turns[i].actions, let j = acts.firstIndex(where: { $0.id == id }) else { continue }
            change(&acts[j])
            turns[i].actions = acts
        }
    }

    /// Enlace de una acción (/c/<id>, /agenda, /asuntos) como destino de la app.
    static func deepLink(_ link: String?) -> DeepLink? {
        guard let link, link.hasPrefix("/") else { return nil }
        return URL(string: "chaggu://" + link.dropFirst()).flatMap(DeepLink.parse)
    }

    /// La burbuja solo se ve en las listas (la raíz de cada pestaña), nunca dentro de un chat ni de otra pantalla.
    static func bubbleVisible(path: [Route], openConversationId: String?) -> Bool {
        path.isEmpty && openConversationId == nil
    }
}

/// Historial solo en este dispositivo y por persona (`assistant:<userId>`). El de otra cuenta se descarta al abrir
/// y todo se borra al cerrar sesión.
enum AssistantHistory {
    static let prefix = "assistant:"
    static let speakKey = "tc.assistantSpeak"

    static func load(_ userId: String, defaults: UserDefaults = .standard) -> [AssistantTurn] {
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix(prefix) && k != prefix + userId {
            defaults.removeObject(forKey: k)
        }
        guard let data = defaults.data(forKey: prefix + userId),
              let turns = try? JSONDecoder().decode([AssistantTurn].self, from: data) else { return [] }
        return turns
    }

    static func save(_ userId: String, _ turns: [AssistantTurn], defaults: UserDefaults = .standard) {
        let keep = Array(turns.suffix(Assistant.maxKeep))
        if keep.isEmpty { defaults.removeObject(forKey: prefix + userId); return }
        if let data = try? JSONEncoder().encode(keep) { defaults.set(data, forKey: prefix + userId) }
    }

    static func clearAll(defaults: UserDefaults = .standard) {
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix(prefix) { defaults.removeObject(forKey: k) }
    }

    /// Leer las respuestas en voz alta (🔊). Encendido por defecto, como en la web.
    static var speakOn: Bool {
        get { UserDefaults.standard.object(forKey: speakKey) == nil ? true : UserDefaults.standard.bool(forKey: speakKey) }
        set { UserDefaults.standard.set(newValue, forKey: speakKey) }
    }
}

extension APIClient {
    func assistantTurn(_ turns: [AssistantTurn], timezone: String = TimeZone.current.identifier, lang: String = L10n.lang) async throws -> AssistantTurnDTO {
        try await request("/assistant/turn", method: "POST",
                          json: ["messages": Assistant.payload(turns), "timezone": timezone, "lang": lang])
    }

    /// Confirma una acción pendiente (`token`) o deshace una hecha (`undoToken`). `text`: mensaje editado.
    func assistantRun(token: String, text: String? = nil) async throws -> AssistantActionDTO {
        var body: [String: Any] = ["token": token]
        if let text { body["text"] = text }
        return try await request("/assistant/run", method: "POST", json: body)
    }
}
