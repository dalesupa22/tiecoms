import Foundation
import Observation

// gg dentro del chat (docs/CONTRATO-GG-CHAT-WA-INBOX.md, parte B): una conversación PRIVADA de la persona con gg sobre
// UN chat (`c:<conversationId>`) o un chat de WhatsApp (`wa:<accountId>:<jid>`). El chat general de gg sigue aparte.
// Nada se ejecuta desde aquí: gg devuelve borradores y sugerencias, y la persona confirma en los diálogos de siempre.

enum GgSource {
    static func conversation(_ id: String) -> String { "c:\(id)" }
    static func whatsapp(_ c: WaChatDTO) -> String { c.inboxKey }
    static func query(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s }
}

struct GgQuote: Codable, Equatable, Hashable, Identifiable, Sendable {
    var id: String
    var author: String
    var text: String
    init(id: String, author: String, text: String) { self.id = id; self.author = author; self.text = text }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", ""); author = c.v("author", ""); text = c.v("text", "")
    }
}

/// Acción que propone el borrador «Con acción» (tarea o recordatorio, siempre con su diálogo).
struct GgDraftAction: Codable, Equatable, Hashable, Sendable {
    var kind: String
    var title: String
    var assigneeName: String?
    var due: String?
    init(kind: String, title: String, assigneeName: String? = nil, due: String? = nil) { self.kind = kind; self.title = title; self.assigneeName = assigneeName; self.due = due }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        kind = c.v("kind", "task"); title = c.v("title", ""); assigneeName = c.o("assigneeName"); due = c.o("due")
    }
}

/// Una de las 3 opciones de «Responder por mí»: corta, cálida o con acción.
struct GgDraft: Codable, Equatable, Hashable, Identifiable, Sendable {
    var style: String
    var text: String
    var action: GgDraftAction?
    var id: String { "\(style)|\(text)" }
    init(style: String, text: String, action: GgDraftAction? = nil) { self.style = style; self.text = text; self.action = action }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        style = c.v("style", "short"); text = c.v("text", ""); action = c.o("action")
    }
    /// «Corta», «Cálida», «Con acción».
    var labelKey: String { "ggs.style.\(["short", "warm", "action"].contains(style) ? style : "short")" }
}

/// Sugerencia de «✨ Pedir a gg (N)»: responder, tarea, recordatorio, escribirle a alguien o resumir.
struct GgSuggestion: Codable, Equatable, Hashable, Identifiable, Sendable {
    var id: String
    var kind: String
    var title: String
    var detail: String?
    var draft: String?
    var params: [String: String]?
    var forMessageIds: [String]
    init(id: String, kind: String, title: String, detail: String? = nil, draft: String? = nil, params: [String: String]? = nil, forMessageIds: [String] = []) {
        self.id = id; self.kind = kind; self.title = title; self.detail = detail; self.draft = draft; self.params = params; self.forMessageIds = forMessageIds
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", UUID().uuidString); kind = c.v("kind", "summary"); title = c.v("title", "")
        detail = c.o("detail"); draft = c.o("draft")
        // `params` es libre: solo se toman los valores de texto (responsable, fecha, persona, título).
        if let raw: [String: GgLoose] = c.o("params") { params = raw.compactMapValues(\.text) } else { params = nil }
        forMessageIds = c.v("forMessageIds", [])
    }
    var icon: String {
        switch kind {
        case "reply": return "arrowshape.turn.up.left"
        case "task": return "checklist"
        case "reminder": return "alarm"
        case "message_person": return "person.bubble"
        default: return "text.alignleft"
        }
    }
    func param(_ keys: String...) -> String? { keys.lazy.compactMap { self.params?[$0] }.first { !$0.isEmpty } }
}

/// Valor JSON cualquiera, del que solo interesa el texto (o el número como texto).
struct GgLoose: Decodable, Sendable {
    var text: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { text = s }
        else if let n = try? c.decode(Double.self) { text = n == n.rounded() ? String(Int(n)) : String(n) }
        else { text = nil }
    }
}

struct GgPendingItem: Codable, Equatable, Hashable, Sendable {
    var text: String
    var messageId: String?
    init(from decoder: Decoder) throws { let c = try container(decoder); text = c.v("text", ""); messageId = c.o("messageId") }
}

struct GgSideExtra: Codable, Equatable, Sendable {
    var followUps: [String] = []
    var drafts: [GgDraft] = []
    var suggestions: [GgSuggestion] = []
    var pending: [GgPendingItem] = []
    init(followUps: [String] = [], drafts: [GgDraft] = [], suggestions: [GgSuggestion] = []) { self.followUps = followUps; self.drafts = drafts; self.suggestions = suggestions }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        followUps = c.v("followUps", [])
        drafts = c.lossyArray("drafts")
        suggestions = c.lossyArray("suggestions")
        pending = c.lossyArray("pending")
    }
}

struct GgSideMessageDTO: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var role: String
    var body: String
    var quoted: [GgQuote]?
    var extra: GgSideExtra?
    var createdAt: String
    var isGg: Bool { role == "gg" }
    init(id: String = UUID().uuidString, role: String, body: String, quoted: [GgQuote]? = nil, extra: GgSideExtra? = nil, createdAt: String = ISODate.string()) {
        self.id = id; self.role = role; self.body = body; self.quoted = quoted; self.extra = extra; self.createdAt = createdAt
    }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", UUID().uuidString); role = c.v("role", "gg"); body = c.v("body", "")
        quoted = c.contains(AnyKey("quoted")) ? c.lossyArray("quoted") : nil
        extra = c.o("extra"); createdAt = c.v("createdAt", "")
    }
}

/// El hilo privado de una fuente.
struct GgSideThread: Equatable, Sendable {
    var session = 1
    var messages: [GgSideMessageDTO] = []
    var loaded = false
}

@MainActor
@Observable
final class GgSideCenter {
    /// nil: aún no se sabe; false: el API no tiene gg en el chat (404) y el botón no sale; true: listo.
    var available: Bool?
    /// Número del botón gg por fuente (cosas que esperan algo de ti; caché del API, sin IA).
    var pending: [String: Int] = [:]
    var threads: [String: GgSideThread] = [:]
    /// Fuentes con historial: «Seguir con gg» sobre el compositor.
    var used: Set<String> = []
    /// Permiso de IA dado en esta sesión de la app (el banner de siempre lo pide una vez).
    var consented = false
    /// «Abrir en gg»: RootView abre el asistente general cuando sube.
    var openGeneral = 0
    @ObservationIgnored private var pendingAt: [String: Date] = [:]
    @ObservationIgnored private var recalculatedAt: [String: Date] = [:]

    func purge(where affected: (String) -> Bool) {
        pending = pending.filter { !affected($0.key) }; threads = threads.filter { !affected($0.key) }
        used = used.filter { !affected($0) }; pendingAt = pendingAt.filter { !affected($0.key) }
        recalculatedAt = recalculatedAt.filter { !affected($0.key) }
    }

    func reset() { available = nil; pending = [:]; threads = [:]; used = []; consented = false; pendingAt = [:]; recalculatedAt = [:] }

    /// ¿Se piden de nuevo los pendientes? (como mucho cada 2 min por fuente, salvo `force`).
    func shouldRefreshPending(_ source: String, force: Bool) -> Bool {
        if force { return true }
        guard let at = pendingAt[source] else { return true }
        return Date().timeIntervalSince(at) > 120
    }
    func markPending(_ source: String) { pendingAt[source] = Date() }
    func beginRecalculation(_ source: String, now: Date = Date()) -> Bool {
        if let last = recalculatedAt[source], now.timeIntervalSince(last) < 600 { return false }
        recalculatedAt[source] = now
        return true
    }
}

/// 403 `ai_consent_required`: la UI muestra el permiso de IA y reintenta.
extension ApiRequestError {
    var needsAIConsent: Bool { status == 403 && code == "ai_consent_required" }
}

extension AppStore {
    /// ¿Ya dio el permiso de IA? (bootstrap `me.aiConsent` o el «Permitir» de esta sesión).
    var ggConsented: Bool { ggSide.consented || data?.me.aiConsent == true }

    /// «Permitir»: guarda el permiso de IA (POST /assistant/consent, el mismo de gg) y reintenta.
    func ggSideGrantConsent() async throws {
        _ = try await api.requestData("/assistant/consent", method: "POST", json: ["on": true])
        ggSide.consented = true
        patchMe { $0.aiConsent = true }
    }

    /// Al entrar a un chat con mensajes nuevos de otra persona: el API recalcula (tope 1 cada 10 min por fuente).
    func ggSideRefreshPending(_ source: String) async {
        guard ggSide.available == true, ggConsented, waPrivacy.allows(source), ggSide.beginRecalculation(source) else { return }
        let stamp = sessionStamp, revision = waPrivacy.revision
        struct R: Decodable { var pending: Int; init(from decoder: Decoder) throws { pending = (try container(decoder)).int("pending") } }
        if let r: R = try? await api.request("/gg/side/pending/refresh", method: "POST", json: ["source": source]),
           stamp == sessionStamp, !Task.isCancelled, revision == waPrivacy.revision, waPrivacy.allows(source) { ggSide.pending[source] = max(0, r.pending) }
    }

    private func ggBody(_ base: [String: Any]) -> [String: Any] {
        var b = base
        if ggSide.consented { b["aiConsent"] = true }
        return b
    }

    private func ggGuard<T>(_ f: () async throws -> T) async throws -> T {
        do {
            let r = try await f()
            if ggSide.available != true { ggSide.available = true }
            return r
        } catch let e as ApiRequestError where e.status == 404 {
            // Solo un servidor SIN la ruta de gg esconde el botón. Un 404 de un chat (p. ej. un WhatsApp bloqueado o borrado)
            // escondía gg en TODOS los chats hasta reiniciar la app (2-oct-2026).
            if Self.ggRouteMissing(e) { ggSide.available = false }
            throw e
        }
    }

    /// 404 de «Ruta no encontrada» (el API no tiene gg), no de un chat que no existe.
    nonisolated static func ggRouteMissing(_ e: ApiRequestError) -> Bool {
        e.status == 404 && (e.code == "route_not_found" || e.message.contains("Ruta no encontrada") || e.message.lowercased().contains("route"))
    }

    /// Número del botón (GET /gg/side/pending, sin IA). Un 404 esconde el botón.
    func ggSidePending(_ sources: [String], force: Bool = false) async {
        let revision = waPrivacy.revision, stamp = sessionStamp
        let want = sources.filter { waPrivacy.allows($0) && ggSide.shouldRefreshPending($0, force: force) }
        guard !want.isEmpty, ggSide.available != false else { return }
        want.forEach(ggSide.markPending)
        struct R: Decodable {
            var map: [String: Int]
            init(from decoder: Decoder) throws {
                let c = try container(decoder)
                var m: [String: Int] = [:]
                for k in c.allKeys { m[k.stringValue] = (try? c.decode(Int.self, forKey: k)) ?? 0 }
                map = m
            }
        }
        do {
            let r: R = try await ggGuard { try await api.request("/gg/side/pending?sources=\(want.map(GgSource.query).joined(separator: ","))") }
            guard stamp == sessionStamp, !Task.isCancelled else { return }
            for s in want where !s.hasPrefix("wa:") || (revision == waPrivacy.revision && waPrivacy.allows(s)) { ggSide.pending[s] = max(0, r.map[s] ?? 0) }
        } catch let e as ApiRequestError where e.status == 404 {
            if Self.ggRouteMissing(e) { ggSide.available = false }
        } catch {}
    }

    /// Abre el hilo: GET /gg/side y, si no hay mensajes, el saludo con pendientes (POST /gg/side/open).
    func ggSideLoad(_ source: String) async throws {
        struct R: Decodable {
            var session: Int; var messages: [GgSideMessageDTO]; var pending: Int?
            init(from decoder: Decoder) throws { let c = try container(decoder); session = c.int("session", 1); messages = c.lossyArray("messages"); pending = c.intOpt("pending") }
        }
        let r: R = try await ggGuard { try await api.request("/gg/side?source=\(GgSource.query(source))") }
        ggSide.threads[source] = GgSideThread(session: r.session, messages: r.messages, loaded: true)
        if let p = r.pending { ggSide.pending[source] = max(0, p) }
        if r.messages.isEmpty { try await ggSideOpen(source) } else { ggSide.used.insert(source) }
    }

    func ggSideOpen(_ source: String) async throws {
        struct R: Decodable { var message: GgSideMessageDTO }
        let r: R = try await ggGuard { try await api.request("/gg/side/open", method: "POST", json: ggBody(["source": source])) }
        appendGg(source, r.message)
        ggSide.pending[source] = r.message.extra?.pending.count ?? ggSide.pending[source] ?? 0
    }

    /// Pregunta a gg (con los mensajes citados como contexto). La respuesta trae 2–4 siguientes preguntas.
    func ggSideAsk(_ source: String, text: String, quotes: [GgQuote]) async throws {
        _ = try requireWaSource(source)
        let mine = GgSideMessageDTO(role: "user", body: text, quoted: quotes.isEmpty ? nil : quotes)
        appendGg(source, mine)
        do {
            struct R: Decodable { var message: GgSideMessageDTO; var question: GgSideMessageDTO? }
            var body: [String: Any] = ["source": source, "text": text]
            if !quotes.isEmpty { body["quotedMessageIds"] = quotes.map(\.id) }
            let r: R = try await ggGuard { try await api.request("/gg/side", method: "POST", json: ggBody(body)) }
            // La pregunta guardada (con los citados validados) reemplaza a la local.
            if let q = r.question, let i = ggSide.threads[source]?.messages.firstIndex(where: { $0.id == mine.id }) { ggSide.threads[source]?.messages[i] = q }
            appendGg(source, r.message)
        } catch {
            ggSide.threads[source]?.messages.removeAll { $0.id == mine.id }
            throw error
        }
    }

    /// «Responder por mí»: 3 borradores (corta, cálida, con acción). Queda guardado también como mensaje de gg.
    func ggSideReplyForMe(_ source: String, tone: String? = nil, quotes: [GgQuote] = [], record: Bool = true) async throws -> [GgDraft] {
        struct R: Decodable { var drafts: [GgDraft]; init(from decoder: Decoder) throws { drafts = (try container(decoder)).lossyArray("drafts") } }
        var body: [String: Any] = ["source": source]
        if let tone { body["tone"] = tone }
        if !quotes.isEmpty { body["quotedMessageIds"] = quotes.map(\.id) }
        let r: R = try await ggGuard { try await api.request("/gg/side/reply-for-me", method: "POST", json: ggBody(body)) }
        if record { appendGg(source, GgSideMessageDTO(role: "gg", body: "", extra: GgSideExtra(drafts: r.drafts))) }
        return r.drafts
    }

    /// Sugerencias para varios mensajes elegidos (2 a 6, sin repetir y ordenadas).
    func ggSideSuggest(_ source: String, messageIds: [String]) async throws -> [GgSuggestion] {
        struct R: Decodable { var suggestions: [GgSuggestion]; init(from decoder: Decoder) throws { suggestions = (try container(decoder)).lossyArray("suggestions") } }
        let r: R = try await ggGuard { try await api.request("/gg/side/suggest", method: "POST", json: ggBody(["source": source, "messageIds": messageIds])) }
        return r.suggestions
    }

    /// «Nueva conversación»: sube la sesión y vuelve a saludar.
    func ggSideNew(_ source: String) async throws {
        _ = try await ggGuard { try await api.requestData("/gg/side/new", method: "POST", json: ["source": source]) }
        let next = (ggSide.threads[source]?.session ?? 1) + 1
        ggSide.threads[source] = GgSideThread(session: next, messages: [], loaded: true)
        try await ggSideOpen(source)
    }

    private func appendGg(_ source: String, _ m: GgSideMessageDTO) {
        guard waPrivacy.allows(source) else { return }
        var t = ggSide.threads[source] ?? GgSideThread(loaded: true)
        if !t.messages.contains(where: { $0.id == m.id }) { t.messages.append(m) }
        ggSide.threads[source] = t
        ggSide.used.insert(source)
    }
}

/// Prellenado de los diálogos de siempre (crear tarea, recordatorio) desde gg.
struct GgPrefill: Equatable, Hashable, Identifiable, Sendable {
    var title: String
    var assigneeName: String?
    var due: String?
    var messageId: String?
    var id: String { "\(title)|\(assigneeName ?? "")|\(due ?? "")" }

    init(title: String, assigneeName: String? = nil, due: String? = nil, messageId: String? = nil) {
        self.title = title; self.assigneeName = assigneeName; self.due = due; self.messageId = messageId
    }
    init(_ s: GgSuggestion) {
        self.init(title: s.param("title") ?? s.title, assigneeName: s.param("assigneeName", "assignee", "owner", "person"),
                  due: s.param("due", "dueDate", "date", "at"), messageId: s.forMessageIds.first)
    }
    init(_ a: GgDraftAction) { self.init(title: a.title, assigneeName: a.assigneeName, due: a.due) }

    /// «2026-10-03», «2026-10-03T15:00:00Z» o «2026-10-03 15:00» → fecha local.
    var dueDate: Date? { GgPrefill.parseDue(due) }
    static func parseDue(_ s: String?) -> Date? {
        guard let s = s?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        if let d = ISODate.parse(s) { return d }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = .current
        for fmt in ["yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
            f.dateFormat = fmt
            if let d = f.date(from: s) { return fmt == "yyyy-MM-dd" ? Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: d) : d }
        }
        return nil
    }
}

// MARK: - gg propone, la persona confirma: reunión y correo (API gg-actions.ts, 2-oct-2026)
//
// POST /gg/meeting-draft y /gg/mail-draft solo devuelven borradores; nada se agenda ni se envía desde ahí. La reunión se
// crea con /gg/calendar/confirm y el correo sale con /gg/mail-send, siempre tras el toque y la confirmación de la persona.

/// Persona del chat de chaggu que gg propone invitar (se invita por id, nunca por un correo que chaggu revele).
struct GgInvitee: Codable, Equatable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    init(id: String, name: String) { self.id = id; self.name = name }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", ""); name = c.v("name", "")
    }
}

/// POST /gg/meeting-draft.
struct GgMeetingDraft: Decodable, Equatable, Sendable {
    var title: String
    var durationMin: Int
    var attendeeEmails: [String]
    var invitees: [GgInvitee]
    var missingPeople: [String]
    var links: [String]
    var description: String
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        title = c.v("title", "")
        let d = c.int("durationMin", 30)
        durationMin = (15...240).contains(d) ? d : 30
        attendeeEmails = c.v("attendeeEmails", [String]())
        invitees = c.v("invitees", [GgInvitee]()).filter { !$0.id.isEmpty }
        missingPeople = c.v("missingPeople", [String]())
        links = c.v("links", [String]())
        description = c.v("description", "")
    }
}

/// POST /gg/mail-draft. `status` = `ready` (hay buzón conectado) o `needs_connect`.
struct GgMailDraft: Decodable, Equatable, Sendable {
    var provider: String?
    var from: String?
    var status: String
    var to: [String]
    var cc: [String]
    var missingPeople: [String]
    var subject: String
    var body: String
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        let p: String? = c.o("provider")
        provider = ["google", "microsoft"].contains(p ?? "") ? p : nil
        from = c.o("from")
        let s = c.v("status", "needs_connect")
        status = s == "ready" && provider != nil ? "ready" : "needs_connect"
        to = c.v("to", [String]()); cc = c.v("cc", [String]())
        missingPeople = c.v("missingPeople", [String]())
        subject = c.v("subject", ""); body = c.v("body", "")
    }
    var ready: Bool { status == "ready" && provider != nil }
    /// «Desde»: la cuenta conectada o, si el API no la dice, el nombre del servicio.
    var fromLabel: String { from.flatMap { $0.isEmpty ? nil : $0 } ?? (provider == "microsoft" ? "Outlook" : "Gmail") }
}

/// POST /gg/mail-send → `{ok, already}` (`already`: esa clave ya se había enviado; no sale dos veces).
struct GgMailSendResult: Decodable, Equatable, Sendable {
    var ok: Bool
    var already: Bool
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        ok = c.v("ok", false); already = c.v("already", false)
    }
}

/// Listas de correos como las escribe la persona («a@x.co, b@y.co; c@z.co»).
enum GgEmails {
    static func parse(_ s: String) -> [String] {
        var seen = Set<String>(), out: [String] = []
        for raw in s.split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace }) {
            let e = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !e.isEmpty && seen.insert(e).inserted { out.append(e) }
        }
        return out
    }
    /// Misma regla que la web y el API (algo@algo.algo, sin espacios ni dos @).
    static func valid(_ e: String) -> Bool {
        let parts = e.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !e.contains(where: \.isWhitespace) else { return false }
        let domain = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        return domain.count >= 2 && domain.allSatisfy { !$0.isEmpty } && e.count <= 254
    }
    static func invalid(_ list: [String]) -> [String] { list.filter { !valid($0) } }
}
