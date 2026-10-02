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
    static func rows(_ all: [WaChatDTO], place: String, query: String = "", filter: HomeFilter = .all) -> [WaChatDTO] {
        let q = query.trimmingCharacters(in: .whitespaces).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        return all.filter { w in
            guard w.inboxPlace == place, !w.hidden else { return false }
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

extension AppStore {
    /// Bandeja de WhatsApp del bootstrap (solo los que tienen sección; los ocultos no salen).
    func applyWaInbox(_ list: [WaChatDTO]) {
        let next = list.filter { $0.inInbox && !$0.hidden }
        if next != waInbox { waInbox = next }
    }

    /// Evento wa.inbox o respuesta del PATCH: actualiza, agrega o saca la fila sin recargar el bootstrap.
    func upsertWaInbox(_ c: WaChatDTO) {
        var next = waInbox.filter { $0.id != c.id }
        if c.inInbox && !c.hidden { next.append(c) }
        if next != waInbox { waInbox = next }
    }

    /// «Mover a Grupos/DMs», «Mover a mi lista principal» (con 'auto' si no se elige) y «Sacar de mi lista principal» (nil).
    @discardableResult
    func waSetInboxPlace(_ c: WaChatDTO, _ place: String?) async throws -> WaChatDTO {
        let before = waInbox
        upsertWaInbox(WaInbox.applying(c, place: .some(place)))
        do {
            let up = try await waPatchChat(c, WaInbox.placePatch(place))
            upsertWaInbox(place != nil && up.inboxPlace == nil ? WaInbox.applying(up, place: .some(place)) : up)
            return up
        } catch { waInbox = before; throw error }
    }

    /// «Fijar» / «Quitar de fijados» en la bandeja (fijar sin haberlo movido lo mueve a la sección sugerida).
    @discardableResult
    func waSetInboxPinned(_ c: WaChatDTO, _ pinned: Bool) async throws -> WaChatDTO {
        let before = waInbox
        upsertWaInbox(WaInbox.applying(c, pinned: pinned))
        do {
            let up = try await waPatchChat(c, WaInbox.pinPatch(pinned))
            // Un servidor sin la migración 081 no devuelve los campos: se deja el cambio local.
            upsertWaInbox(up.inInbox || !pinned ? up : WaInbox.applying(up, pinned: pinned))
            return up
        } catch { waInbox = before; throw error }
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
