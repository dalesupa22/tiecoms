import Foundation

/// Reglas de las reacciones (mismas que packages/contracts: QUICK_REACTIONS, normalizeEmoji, MAX_REACTIONS_PER_MESSAGE).
enum Reactions {
    /// Barra rápida (mismo orden en web, iOS y Android).
    static let quick = ["👍", "❤️", "😂", "👀", "✅", "🙏"]
    /// 👀 «Lo reviso» y ✅ «Hecho» tienen acción si la empresa la tiene activa.
    static let look = "👀"
    static let done = "✅"
    /// Máximo de emojis distintos por mensaje (el API responde 409 pasado el límite).
    static let maxPerMessage = 20

    /// Emojis comunes del selector completo (el teclado del sistema trae el resto).
    static let common: [String] = [
        "👍", "👎", "❤️", "😂", "🤣", "😊", "😍", "🥰", "😘", "😉", "😎", "🤩", "🥳", "😅", "😆", "🙂",
        "🤔", "🤨", "😐", "🙄", "😏", "😬", "😮", "😯", "😲", "😳", "🥺", "😢", "😭", "😤", "😡", "🤯",
        "😴", "🤒", "🤗", "🤭", "🫡", "🫠", "🙃", "😇", "👀", "✅", "☑️", "✔️", "❌", "⚠️", "❗", "❓",
        "🙏", "👏", "🙌", "💪", "🤝", "👋", "✌️", "🤞", "👌", "🤙", "👉", "👆", "💯", "🔥", "✨", "⭐",
        "🎉", "🎊", "🚀", "💡", "📌", "📎", "📝", "📅", "⏰", "⏳", "💰", "📈", "📉", "🏆", "🎯", "☕",
        "🍕", "🍺", "🥂", "💚", "💙", "💜", "🧡", "💛", "🖤", "🤍", "💔", "🇨🇴", "🇲🇽", "🇵🇪", "🇪🇸", "🇺🇸",
    ]

    /// ¿Es parte de Extended_Pictographic? (Swift no expone la propiedad: isEmoji sin dígitos, #, *,
    /// indicadores regionales ni modificadores de tono).
    static func isPictographic(_ s: Unicode.Scalar) -> Bool {
        let p = s.properties
        guard p.isEmoji else { return false }
        if s.isASCII { return false }
        if (0x1F1E6...0x1F1FF).contains(s.value) { return false }
        if p.isEmojiModifier { return false }
        return true
    }

    private static func isRegional(_ s: Unicode.Scalar) -> Bool { (0x1F1E6...0x1F1FF).contains(s.value) }

    /// Forma canónica (normalizeEmoji del contrato): sin selectores de variación sobrantes y con U+FE0F donde
    /// hace falta (❤ → ❤️, 👍️ → 👍). nil si no es exactamente un emoji.
    static func normalize(_ input: String) -> String? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, raw.utf16.count <= 32 else { return nil }
        let vs16 = Unicode.Scalar(0xFE0F)!, zwj = Unicode.Scalar(0x200D)!, keycap = Unicode.Scalar(0x20E3)!
        var parts: [[Unicode.Scalar]] = [[]]
        for s in raw.unicodeScalars where s != vs16 {
            if s == zwj { parts.append([]) } else { parts[parts.count - 1].append(s) }
        }
        let fixed: [[Unicode.Scalar]] = parts.map { part in
            guard let first = part.first else { return part }
            // Tecla: 1⃣ → 1️⃣
            if part.count == 2, "0123456789#*".unicodeScalars.contains(first), part[1] == keycap { return [first, vs16, keycap] }
            let rest = Array(part.dropFirst())
            let skin = rest.first.map { (0x1F3FB...0x1F3FF).contains($0.value) } ?? false
            let needs = isPictographic(first) && !first.properties.isEmojiPresentation && !skin
            return needs ? [first, vs16] + rest : part
        }
        var out = String.UnicodeScalarView()
        for (i, p) in fixed.enumerated() {
            if i > 0 { out.append(zwj) }
            out.append(contentsOf: p)
        }
        let s = String(out)
        guard s.count == 1 else { return nil }
        guard s.unicodeScalars.contains(where: { isPictographic($0) || isRegional($0) || $0 == keycap }) else { return nil }
        return s
    }

    /// Solo emojis (de 1 a 3): el mensaje se muestra grande (isJumbo de la web).
    static func isJumbo(_ body: String) -> Bool {
        let s = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, s.utf16.count <= 40 else { return false }
        let chars = s.filter { !$0.isWhitespace }
        guard (1...3).contains(chars.count) else { return false }
        let keycap = Unicode.Scalar(0x20E3)!
        return chars.allSatisfy { ch in ch.unicodeScalars.contains { isPictographic($0) || isRegional($0) || $0 == keycap } }
    }

    /// Lista tras poner (`on`) o quitar mi reacción (optimista, como client.react de la web).
    static func toggled(_ list: [ReactionDTO], emoji: String, me: String, on: Bool) -> [ReactionDTO] {
        var next = list.map { r -> ReactionDTO in
            var x = r
            if r.emoji == emoji { x.userIds.removeAll { $0 == me } }
            return x
        }
        if on {
            if let i = next.firstIndex(where: { $0.emoji == emoji }) { next[i].userIds.append(me) }
            else { next.append(ReactionDTO(emoji: emoji, userIds: [me])) }
        }
        return next.filter { $0.count > 0 }
    }

    /// Recordatorio de 👀: en 3 horas, o mañana a las 9:00 si eso cae de noche (lookRemindAt de la web).
    static func lookRemindAt(_ now: Date = Date(), calendar: Calendar = .current) -> Date {
        let at = now.addingTimeInterval(3 * 3600)
        if calendar.component(.hour, from: at) >= 19 || !calendar.isDate(at, inSameDayAs: now) {
            let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? at
            return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? at
        }
        return at
    }

    /// «Laura (Xertify), Beto y Pedro · WhatsApp» (reactorsText de la web).
    static func reactorsText(_ d: BootstrapDTO, _ r: ReactionDTO) -> String {
        var names = r.userIds.map { u -> String in
            if u == d.me.id { return L("common.youShort") }
            guard let p = Naming.person(d, u) else { return L("chat.formerParticipant") }
            if let o = Naming.org(d, p.orgId), o.id != d.me.primaryOrgId { return "\(p.name) (\(o.name))" }
            return p.name
        }
        names += r.external.map { "\($0.name) · \(L("src.\($0.source.rawValue)"))" }
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " \(L("common.and")) " + names.last!
    }

    /// 👀 y ✅ con acción para la gente de mi empresa (activas por defecto).
    static func actionsEnabled(_ d: BootstrapDTO) -> Bool {
        Naming.org(d, d.me.primaryOrgId)?.reactionActions ?? true
    }
}

/// Respuesta de PUT/DELETE /messages/:id/reactions/:emoji.
struct ReactionResult: Decodable {
    var message: MessageDTO?
    var reminder: ReminderDTO?
    var closedReminderIds: [String]
    var openIssueId: String?

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        message = c.o("message")
        reminder = c.o("reminder")
        closedReminderIds = c.v("closedReminderIds", [])
        openIssueId = c.o("openIssueId")
    }
}

extension AppStore {
    /// Pone o quita mi reacción (optimista; se revierte si el API falla). 👀 manda la hora del recordatorio.
    @discardableResult
    func react(_ m: MessageDTO, emoji raw: String, on: Bool) async throws -> ReactionResult {
        guard let emoji = Reactions.normalize(raw), let d = data else {
            throw ApiRequestError(status: 400, code: "invalid_emoji", message: L("common.error"))
        }
        let current = conversations[m.conversationId]?.messages.first { $0.id == m.id } ?? m
        let prev = current.reactions
        var next = current
        next.reactions = Reactions.toggled(prev, emoji: emoji, me: d.me.id, on: on)
        upsertLocal(next)
        let path = "/messages/\(m.id)/reactions/\(emoji.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? emoji)"
        var body: [String: Any]? = nil
        if on {
            body = [:]
            if emoji == Reactions.look && Reactions.actionsEnabled(d) { body?["remindAt"] = ISODate.string(Reactions.lookRemindAt()) }
        }
        do {
            let r: ReactionResult = try await api.request(path, method: on ? "PUT" : "DELETE", json: body)
            if let msg = r.message { upsertLocal(msg) }
            if r.reminder != nil || !r.closedReminderIds.isEmpty {
                let closed = Set(r.closedReminderIds)
                reminders = (reminders.filter { !closed.contains($0.id) && $0.id != r.reminder?.id } + [r.reminder].compactMap { $0 })
                    .sorted { $0.remindAt < $1.remindAt }
            }
            return r
        } catch {
            var back = conversations[m.conversationId]?.messages.first { $0.id == m.id } ?? current
            back.reactions = prev
            upsertLocal(back)
            throw error
        }
    }
}
