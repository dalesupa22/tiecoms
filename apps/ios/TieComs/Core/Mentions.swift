import Foundation
import SwiftUI

/// Un elemento de la bandeja de menciones.
struct MentionItem: Decodable, Identifiable, Sendable {
    var message: MessageDTO
    var conversationId: String
    var all: Bool
    var read: Bool
    var createdAt: String
    var id: String { message.id }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        message = try c.decode(MessageDTO.self, forKey: AnyKey("message"))
        conversationId = c.v("conversationId", message.conversationId)
        all = c.v("all", false); read = c.v("read", false); createdAt = c.v("createdAt", message.createdAt)
    }
}

struct MentionsPage: Decodable, Sendable {
    var mentions: [MentionItem]
    var hasMore: Bool
    init(from decoder: Decoder) throws { let c = try container(decoder); mentions = c.lossyArray("mentions"); hasMore = c.v("hasMore", false) }
}

/// Lógica pura de menciones (se prueba en unitarias, con emojis y tildes).
enum MentionText {
    static let maxMentions = 50
    static let maxAllMembers = 100

    /// «@consulta» que se está escribiendo al final del texto (al inicio o tras un espacio): offset UTF-16 del "@" y la consulta.
    static func activeQuery(in text: String) -> (start: Int, query: String)? {
        let u = Array(text.utf16)
        guard let at = u.lastIndex(of: 0x40) else { return nil } // "@"
        if at > 0, let prev = Unicode.Scalar(u[at - 1]), !CharacterSet.whitespacesAndNewlines.contains(prev) { return nil }
        let q = String(utf16CodeUnits: Array(u[(at + 1)...]), count: u.count - at - 1)
        guard q.count <= 30, !q.contains("\n"), q.split(separator: " ").count <= 2, !q.hasSuffix("  ") else { return nil }
        return (at, q)
    }

    /// Reemplaza «@consulta» (desde `start`) por «@Nombre » y devuelve el texto y la mención nueva.
    static func insert(name: String, userId: String, into text: String, at start: Int, mentions: [Mention]) -> (text: String, mentions: [Mention]) {
        let u = Array(text.utf16)
        guard start >= 0, start <= u.count else { return (text, mentions) }
        let token = "@" + name
        let before = String(utf16CodeUnits: Array(u[..<start]), count: start)
        let out = before + token + " "
        let m = Mention(userId: userId, start: start, length: token.utf16.count)
        return (out, (mentions.filter { $0.end <= start } + [m]).sorted { $0.start < $1.start })
    }

    /// Ajusta las menciones a una edición del texto. Si la edición toca un token, el token se borra entero
    /// (un retroceso sobre «@Laura Gómez» lo quita completo); las menciones después de la edición se corren.
    static func reconcile(old: String, new: String, mentions: [Mention]) -> (text: String, mentions: [Mention]) {
        guard !mentions.isEmpty, old != new else { return (new, mentions) }
        let a = Array(old.utf16), b = Array(new.utf16)
        var p = 0
        while p < a.count, p < b.count, a[p] == b[p] { p += 1 }
        var s = 0
        while s < a.count - p, s < b.count - p, a[a.count - 1 - s] == b[b.count - 1 - s] { s += 1 }
        let ea = a.count - s, eb = b.count - s, delta = eb - ea
        var kept: [Mention] = []
        var cuts: [Range<Int>] = []           // en coordenadas del texto nuevo
        for m in mentions {
            if m.end <= p { kept.append(m) }
            else if m.start >= ea { kept.append(Mention(userId: m.userId, start: m.start + delta, length: m.length)) }
            else {
                if m.start < p { cuts.append(m.start..<p) }
                if m.end > ea { cuts.append(eb..<(m.end + delta)) }
            }
        }
        var text = b
        for r in cuts.sorted(by: { $0.lowerBound > $1.lowerBound }) where r.lowerBound < r.upperBound && r.upperBound <= text.count {
            text.removeSubrange(r)
            kept = kept.map { $0.start >= r.upperBound ? Mention(userId: $0.userId, start: $0.start - r.count, length: $0.length) : $0 }
        }
        return (String(utf16CodeUnits: text, count: text.count), kept.sorted { $0.start < $1.start })
    }

    /// Solo las menciones válidas para enviar (dentro del texto, empiezan con "@", sin solaparse, máx. 50).
    static func valid(_ mentions: [Mention], in text: String) -> [Mention] {
        let u = Array(text.utf16)
        var last = -1
        return Array(mentions.sorted { $0.start < $1.start }.filter { m in
            guard m.start >= 0, m.length > 1, m.end <= u.count, u[m.start] == 0x40, m.start >= last else { return false }
            last = m.end
            return true
        }.prefix(maxMentions))
    }

    /// Recorta espacios al inicio y al final (como el servidor) y corre los offsets.
    static func trimmed(_ text: String, mentions: [Mention]) -> (String, [Mention]) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !mentions.isEmpty, !t.isEmpty, let r = text.range(of: t) else { return (t, mentions) }
        let lead = text.utf16.distance(from: text.utf16.startIndex, to: r.lowerBound.samePosition(in: text.utf16) ?? text.utf16.startIndex)
        let n = t.utf16.count
        return (t, mentions.map { Mention(userId: $0.userId, start: $0.start - lead, length: $0.length) }.filter { $0.start >= 0 && $0.end <= n })
    }

    /// Silencio «siempre» (el API lo guarda como una fecha muy lejana).
    static func mutedForever(_ c: ConversationDTO) -> Bool {
        (ISODate.parse(c.mutedUntil) ?? .distantPast) > Date().addingTimeInterval(20 * 365 * 86400)
    }

    static func mentionsMe(_ mentions: [Mention], me: String, authorId: String) -> Bool {
        authorId != me && mentions.contains { $0.userId == me || $0.isAll }
    }

    /// Texto con las menciones en negrita y el color de cada persona (link tiecoms-mention://<userId>).
    static func attributed(_ base: AttributedString, text: String, mentions: [Mention], mine: Bool, links: Bool = true) -> AttributedString {
        var out = base
        let u16 = text.utf16
        for m in valid(mentions, in: text) {
            guard let lo16 = u16.index(u16.startIndex, offsetBy: m.start, limitedBy: u16.endIndex),
                  let hi16 = u16.index(u16.startIndex, offsetBy: m.end, limitedBy: u16.endIndex),
                  let lo = String.Index(lo16, within: text), let hi = String.Index(hi16, within: text),
                  let alo = AttributedString.Index(lo, within: out), let ahi = AttributedString.Index(hi, within: out) else { continue }
            out[alo..<ahi].font = .body.bold()
            out[alo..<ahi].foregroundColor = mine ? .white : (m.isAll ? Theme.accentText : PersonColor.text(m.userId))
            if links && !m.isAll { out[alo..<ahi].link = URL(string: "tiecoms-mention://\(m.userId)") }
        }
        return out
    }

    /// Candidatos del buscador: participantes (sin mí), primero los que más escriben ahí; filtro sin tildes por nombre, apellido o correo.
    static func candidates(_ d: BootstrapDTO, _ c: ConversationDTO, query: String, messages: [MessageDTO]) -> [PersonDTO] {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        var freq: [String: Int] = [:]
        for m in messages.suffix(200) where !m.isSystem { freq[m.authorId, default: 0] += 1 }
        let people: [PersonDTO] = c.memberIds.filter { $0 != d.me.id }.compactMap { Naming.person(d, $0) }
        let matching: [PersonDTO] = people.filter { p in
            guard !q.isEmpty else { return true }
            var parts: [String] = [p.name]
            parts += p.name.split(separator: " ").map(String.init)
            return parts.contains { fold($0).hasPrefix(q) } || fold(p.name).contains(q)
        }
        return matching.sorted { a, b in
            let fa = freq[a.id] ?? 0, fb = freq[b.id] ?? 0
            if fa != fb { return fa > fb }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    /// «@todos» solo en grupos, multi y sidechats (no en directos) y con ≤ 100 miembros o si puedo administrar.
    static func allowsAll(_ c: ConversationDTO) -> Bool {
        c.kind != .direct && (c.memberIds.count <= maxAllMembers || c.canManage)
    }

    /// Nombres de personas que NO están en la conversación y coinciden con la consulta (para «Añadirla» / «Preguntarle en un sidechat»).
    static func outsiders(_ d: BootstrapDTO, _ c: ConversationDTO, query: String) -> [PersonDTO] {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        guard q.count >= 2 else { return [] }
        let members = Set(c.memberIds)
        return d.people.filter { !members.contains($0.id) && $0.kind == "human" && fold($0.name).split(separator: " ").contains { $0.hasPrefix(q) } }.prefix(3).map { $0 }
    }
}
