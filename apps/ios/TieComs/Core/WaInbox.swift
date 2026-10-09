import Foundation
import Observation

// WhatsApp en la bandeja (docs/CONTRATO-GG-CHAT-WA-INBOX.md, parte A): un chat de WhatsApp «movido a mi lista principal»
// vive en Grupos (`inboxPlace = groups`) o en DMs (`dms`) como una conversación más, con el MISMO orden y los mismos
// separadores (Fijados · Sin leer · Recientes). Grupos y DMs siguen separados: no hay una lista nueva.

/// Una fila de una lista plana de la bandeja: de chaggu o de WhatsApp.
enum InboxMix<T: Identifiable>: Identifiable where T.ID == String {
    case chaggu(T)
    case wa(WaChatDTO)
    var id: String {
        switch self {
        case .chaggu(let x): return x.id
        case .wa(let w): return w.inboxKey
        }
    }
}

enum WaInbox {
    static let groups = "groups", dms = "dms"

    /// `inboxPinnedAt` hace de `pinnedAt`; sin leer si `unread > 0`; si no, Recientes.
    static func bucket(_ w: WaChatDTO) -> InboxBucket {
        if w.inboxPinnedAt != nil { return .pinned }
        return w.unread > 0 ? .unread : .recent
    }

    static func activity(_ w: WaChatDTO) -> String { w.lastMessageAt ?? "" }

    /// Orden dentro de la bandeja: fijados, sin leer y luego por actividad (como HomeOrder.before).
    static func before(_ a: WaChatDTO, _ b: WaChatDTO) -> Bool {
        let pa = a.inboxPinnedAt != nil, pb = b.inboxPinnedAt != nil
        if pa != pb { return pa }
        let ua = a.unread > 0, ub = b.unread > 0
        if ua != ub { return ua }
        let xa = activity(a), xb = activity(b)
        return xa == xb ? a.inboxKey < b.inboxKey : xa > xb
    }

    /// Los de una sección (Grupos o DMs), con el filtro de chips y la búsqueda. «Menciones» y «Tareas» no aplican a WhatsApp.
    /// `workOnly` («💼 Solo trabajo»): sin familia, amigos, comunidad ni otros, salvo los fijados en la pantalla principal.
    static func rows(_ all: [WaChatDTO], place: String, query: String = "", filter: HomeFilter = .all, workOnly: Bool = false) -> [WaChatDTO] {
        let q = query.trimmingCharacters(in: .whitespaces).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        return all.filter { w in
            guard w.inboxPlace == place, !w.hidden else { return false }
            if workOnly && w.inboxPinnedAt == nil && !WaWorkOnly.categories.contains(w.category) { return false }
            switch filter {
            case .all: break
            case .unread: if w.unread <= 0 { return false }
            default: return false
            }
            guard !q.isEmpty else { return true }
            return [w.name, w.accountLabel].contains { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).contains(q) }
        }
        .sorted(by: before)
    }

    /// Mezcla los bloques ya ordenados de chaggu con los chats de WhatsApp de la misma sección. Dentro de cada bloque
    /// se intercalan por actividad; una fila de chaggu con mención sin leer va antes (como en HomeOrder.before).
    static func mix<T>(_ split: [(bucket: InboxBucket, items: [T])], wa: [WaChatDTO], activity: (T) -> String,
                       urgent: (T) -> Bool = { _ in false }) -> [(bucket: InboxBucket, items: [InboxMix<T>])] {
        var byBucket: [InboxBucket: [WaChatDTO]] = [:]
        for w in wa.sorted(by: before) { byBucket[bucket(w), default: []].append(w) }
        var chaggu: [InboxBucket: [T]] = [:]
        for b in split { chaggu[b.bucket] = b.items }
        return InboxBucket.allCases.compactMap { b -> (bucket: InboxBucket, items: [InboxMix<T>])? in
            let cs = chaggu[b] ?? [], ws = byBucket[b] ?? []
            guard !cs.isEmpty || !ws.isEmpty else { return nil }
            var out: [InboxMix<T>] = []
            out.reserveCapacity(cs.count + ws.count)
            var i = 0, j = 0
            while i < cs.count || j < ws.count {
                if j >= ws.count { out.append(.chaggu(cs[i])); i += 1; continue }
                if i >= cs.count { out.append(.wa(ws[j])); j += 1; continue }
                if !urgent(cs[i]) && Self.activity(ws[j]) > activity(cs[i]) { out.append(.wa(ws[j])); j += 1 } else { out.append(.chaggu(cs[i])); i += 1 }
            }
            return (b, out)
        }
    }

    /// Lo que se manda en el PATCH para moverlo a una sección (o sacarlo con nil).
    static func placePatch(_ place: String?) -> [String: Any] { ["inboxPlace": place ?? NSNull()] }
    static func pinPatch(_ pinned: Bool) -> [String: Any] { ["inboxPinned": pinned] }
    /// «📌 Fijar en WhatsApp»: arriba en la pantalla WhatsApp (no toca la bandeja).
    static func waPinPatch(_ pinned: Bool) -> [String: Any] { ["pinned": pinned] }
    static func hidePatch(_ hidden: Bool) -> [String: Any] { ["hidden": hidden] }

    /// Aplica el cambio en local (optimista), igual que el servidor: fijar sin estar en la bandeja lo mueve a la sugerida;
    /// sacarlo quita también el fijado.
    static func applying(_ c: WaChatDTO, place: String?? = nil, pinned: Bool? = nil, now: String = ISODate.string()) -> WaChatDTO {
        var x = c
        if let place {
            x.inboxPlace = place
            if place == nil { x.inboxPinnedAt = nil }
        }
        if let pinned {
            if pinned {
                if x.inboxPlace == nil { x.inboxPlace = x.suggestedPlace }
                x.inboxPinnedAt = x.inboxPinnedAt ?? now
            } else { x.inboxPinnedAt = nil }
        }
        return x
    }
}

/// «💼 Solo trabajo» en la pantalla WhatsApp (y en sus filas de Grupos/DMs): solo Trabajo y Clientes. Por dispositivo.
enum WaWorkOnly {
    static let key = "tc.wa.workOnly"
    static let categories: Set<WaCategory> = [.trabajo, .clientes]
    static func load(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: key) }
    static func save(_ on: Bool, _ defaults: UserDefaults = .standard) { defaults.set(on, forKey: key) }
    static func filter(_ chats: [WaChatDTO], on: Bool) -> [WaChatDTO] { on ? chats.filter { categories.contains($0.category) } : chats }
    /// Cuántos chats hay en total (o solo de Trabajo y Clientes) según los contadores del API.
    static func total(_ counts: [String: WaChatsPage.Count], on: Bool) -> Int {
        counts.filter { !on || categories.contains(WaCategory(rawValue: $0.key) ?? .otros) }.values.reduce(0) { $0 + $1.total }
    }
}

extension AppStore {
    /// Bandeja de WhatsApp del bootstrap (solo los que tienen sección; los ocultos no salen).
    func applyWaInbox(_ list: [WaChatDTO]) {
        let next = list.filter { $0.inInbox && !$0.hidden && waPrivacy.allows($0.inboxKey) }
        if next != waInbox { waInbox = next }
    }

    /// Evento wa.inbox o respuesta del PATCH: actualiza, agrega o saca la fila sin recargar el bootstrap.
    func upsertWaInbox(_ c: WaChatDTO) {
        var next = waInbox.filter { $0.id != c.id }
        if c.inInbox && !c.hidden && waPrivacy.allows(c.inboxKey) { next.append(c) }
        if next != waInbox { waInbox = next }
    }

    /// «Mover a Grupos/DMs», «Mover a mi lista principal» (con 'auto' si no se elige) y «Sacar de mi lista principal» (nil).
    @discardableResult
    func waSetInboxPlace(_ c: WaChatDTO, _ place: String?) async throws -> WaChatDTO {
        let before = waInbox, revision = waPrivacy.revision, stamp = sessionStamp
        _ = try requireWaSource(c.inboxKey)
        upsertWaInbox(WaInbox.applying(c, place: .some(place)))
        do {
            let up = try await waPatchChat(c, WaInbox.placePatch(place))
            upsertWaInbox(place != nil && up.inboxPlace == nil ? WaInbox.applying(up, place: .some(place)) : up)
            return up
        } catch { if revision == waPrivacy.revision && stamp == sessionStamp { applyWaInbox(before) }; throw error }
    }

    /// «Fijar» / «Quitar de fijados» en la bandeja (fijar sin haberlo movido lo mueve a la sección sugerida).
    @discardableResult
    func waSetInboxPinned(_ c: WaChatDTO, _ pinned: Bool) async throws -> WaChatDTO {
        let before = waInbox, revision = waPrivacy.revision, stamp = sessionStamp
        _ = try requireWaSource(c.inboxKey)
        upsertWaInbox(WaInbox.applying(c, pinned: pinned))
        do {
            let up = try await waPatchChat(c, WaInbox.pinPatch(pinned))
            // Un servidor sin la migración 081 no devuelve los campos: se deja el cambio local.
            upsertWaInbox(up.inInbox || !pinned ? up : WaInbox.applying(up, pinned: pinned))
            return up
        } catch { if revision == waPrivacy.revision && stamp == sessionStamp { applyWaInbox(before) }; throw error }
    }
}

extension AppStore {
    /// «📌 Fijar en WhatsApp» / «Quitar de fijados en WhatsApp» (`pinned`). Si el chat también está en la bandeja, su fila se actualiza.
    @discardableResult
    func waSetPinned(_ c: WaChatDTO, _ pinned: Bool) async throws -> WaChatDTO {
        _ = try requireWaSource(c.inboxKey)
        var up = try await waPatchChat(c, WaInbox.waPinPatch(pinned))
        if up.jid.isEmpty { up = c; up.pinned = pinned }
        if waInbox.contains(where: { $0.id == up.id }) { upsertWaInbox(up) }
        return up
    }

    /// Ocultar o volver a mostrar un chat (también lo saca de la bandeja mientras esté oculto).
    @discardableResult
    func waSetHidden(_ c: WaChatDTO, _ hidden: Bool) async throws -> WaChatDTO {
        _ = try requireWaSource(c.inboxKey)
        let up = try await waPatchChat(c, WaInbox.hidePatch(hidden))
        if hidden { waInbox.removeAll { $0.id == c.id } } else { upsertWaInbox(up) }
        return up
    }

    /// Responder un chat desde chaggu (POST …/send {text}); solo si la cuenta tiene «Responder desde chaggu».
    func waSend(_ c: WaChatDTO, text: String) async throws -> WaSendResult {
        _ = try requireWaSource(c.inboxKey)
        return try await api.request("/whatsapp/chats/\(c.accountId)/\(waEnc(c.jid))/send", method: "POST", json: ["text": text])
    }

    /// «Responder desde chaggu» en una cuenta (PATCH /whatsapp/accounts/:id {sendEnabled}).
    func waSetSendEnabled(_ accountId: String, _ on: Bool) async throws -> WaAccountDTO {
        try await api.request("/whatsapp/accounts/\(accountId)", method: "PATCH", json: ["sendEnabled": on])
    }

    private func waEnc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s }
}

/// Respuesta de POST …/send: sent, queued (el puente lo manda en cuanto pueda) o failed.
struct WaSendResult: Decodable, Equatable, Sendable {
    var id: String
    var status: String
    var error: String?
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", ""); status = c.v("status", "queued"); error = c.o("error")
    }
}

// MARK: - Accesos con logo (WhatsApp, Gmail, Outlook)

/// Lo conectado y sus no leídos para los chips del inicio de la fila de filtros. Se pide como mucho cada 60 s.
@MainActor
@Observable
final class ChannelAccess {
    var waConnected = false
    var waUnread = 0
    var mail: [MailConnectionDTO] = []
    var mailUnread = 0
    @ObservationIgnored private var lastWa: Date?
    @ObservationIgnored private var lastMail: Date?
    @ObservationIgnored private var waRevisionSeen = -1

    static let ttl: TimeInterval = 60

    var activeMail: [MailConnectionDTO] { mail.filter(\.isActive) }
    var hasAny: Bool { waConnected || !activeMail.isEmpty }

    func invalidateWhatsApp() { waUnread = 0; lastWa = nil; waRevisionSeen = -1 }

    func reset() { waConnected = false; waUnread = 0; mail = []; mailUnread = 0; lastWa = nil; lastMail = nil; waRevisionSeen = -1 }

    func refresh(_ store: AppStore, force: Bool = false) async {
        let now = Date()
        if force || store.waRevision != waRevisionSeen || lastWa.map({ now.timeIntervalSince($0) > Self.ttl }) ?? true {
            lastWa = now; waRevisionSeen = store.waRevision
            if let r = try? await store.waAccounts() {
                waConnected = !r.accounts.isEmpty
                if waConnected, let page = try? await store.waChats(accountId: nil, category: nil, onlyGroups: false, showHidden: false, query: "", limit: 1) {
                    waUnread = page.categories.values.reduce(0) { $0 + $1.unread }
                } else if !waConnected { waUnread = 0 }
            }
        }
        if !store.mailEnabled { mail = []; mailUnread = 0; return }
        if force || lastMail.map({ now.timeIntervalSince($0) > Self.ttl }) ?? true {
            lastMail = now
            if let l = try? await store.mailConnections() {
                mail = l
                store.mailConnectionsKnown = l
                mailUnread = l.contains(where: \.isActive) ? ((try? await store.mailUnread()) ?? mailUnread) : 0
            }
        }
    }
}

/// La última cuenta de correo usada (abre la bandeja directo en ella). Por dispositivo.
enum MailLastProvider {
    static let key = "tc.mail.lastProvider"
    static func load(_ defaults: UserDefaults = .standard) -> MailProvider? { defaults.string(forKey: key).flatMap(MailProvider.init(rawValue:)) }
    static func save(_ p: MailProvider, _ defaults: UserDefaults = .standard) { defaults.set(p.rawValue, forKey: key) }
}


/// Session privacy ledger. Only a new authoritative list can restore a revoked chat.
struct WaPrivacy {
    private(set) var revision = 0
    var knownAccounts: Set<String> = []
    private(set) var accounts: Set<String> = []
    private(set) var sources: Set<String> = []
    private var accountEpoch: [String: Int] = [:]
    private var sourceEpoch: [String: Int] = [:]
    static func source(_ account: String, _ jid: String) -> String { "wa:\(account):\(jid)" }
    static func account(_ source: String) -> String? {
        guard source.hasPrefix("wa:") else { return nil }
        return source.dropFirst(3).split(separator: ":", maxSplits: 1).first.map(String.init)
    }
    static func requestSource(_ path: String, json: [String: Any]? = nil) -> String? { APIClient.waSource(path, json: json) }
    func allows(_ source: String) -> Bool {
        guard let a = Self.account(source) else { return true }
        return !accounts.contains(a) && !sources.contains(source)
    }
    func token(_ source: String) -> Int {
        (Self.account(source).flatMap { accountEpoch[$0] } ?? 0) + (sourceEpoch[source] ?? 0)
    }
    mutating func revoke(account: String, jids: [String], reset: Bool) {
        guard !account.isEmpty, reset || !jids.isEmpty else { return }
        knownAccounts.insert(account)
        revision += 1
        if reset { accounts.insert(account); accountEpoch[account] = revision }
        for jid in jids where !jid.isEmpty { let s = Self.source(account, jid); sources.insert(s); sourceEpoch[s] = revision }
    }
    mutating func ready(_ account: String) { knownAccounts.insert(account); accounts.remove(account) }
    mutating func accept(_ chats: [WaChatDTO]) {
        knownAccounts.formUnion(chats.map(\.accountId))
        for c in chats where !accounts.contains(c.accountId) { sources.remove(c.inboxKey) }
    }
}

extension AppStore {
    func requireWaSource(_ source: String) throws -> Int {
        if let account = WaPrivacy.account(source) { waPrivacy.knownAccounts.insert(account) }
        guard waPrivacy.allows(source) else { throw ApiRequestError(status: 404, code: "not_found", message: L("wa.noMessages")) }
        return waPrivacy.token(source)
    }
    func revokeWaPrivacy(accountId: String, jids: [String] = [], reset: Bool = false) {
        guard !accountId.isEmpty, reset || !jids.isEmpty else { return }
        waPrivacy.revoke(account: accountId, jids: jids, reset: reset)
        func affected(_ s: String) -> Bool { WaPrivacy.account(s) == accountId && (reset || jids.contains(where: { WaPrivacy.source(accountId, $0) == s })) }
        waInbox.removeAll { affected($0.inboxKey) }
        purgeWaBootstrap(where: affected)
        ggSide.purge(where: affected)
        AttachmentCache.shared.purgeWhatsApp(where: affected)
        VoicePlayer.shared.stopWhatsApp(where: affected)
        channels.invalidateWhatsApp()
        waRevision += 1
        scheduleSnapshot()
    }
    func invalidateKnownWaPrivacy() {
        for account in waPrivacy.knownAccounts.union(waInbox.map(\.accountId)) { revokeWaPrivacy(accountId: account, reset: true) }
    }
    func denyWaListing(accountId: String? = nil) {
        let accounts = accountId.map { Set([$0]) } ?? waPrivacy.knownAccounts.union(waInbox.map(\.accountId))
        for account in accounts where !waPrivacy.accounts.contains(account) { revokeWaPrivacy(accountId: account, reset: true) }
    }
    func denyWaSource(_ source: String) {
        guard let a = WaPrivacy.account(source) else { return }
        let prefix = "wa:\(a):"
        revokeWaPrivacy(accountId: a, jids: [String(source.dropFirst(prefix.count))])
    }
}
