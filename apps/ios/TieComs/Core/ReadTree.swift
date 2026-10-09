import Foundation

// Pendientes del árbol y «Marcar como leído» (docs/TANDA-LECTURA-REUNIONES.md §1, contrato 2026-09-28).
//
// El caso de Danny: «Estudio Norte · General» tenía leídos todos sus mensajes (unread = 0), pero dos derivadas que
// nunca abrió sumaban 11 sin leer. La fila decía «💬 11», los filtros «No leídos 0» y el menú «Marcar como no leído».
// Regla común: pendientesDelÁrbol(g) = g.unread + Σ x.unread de las derivadas (x.parentId == g.id, deriveKind ≠ 'side')
// en las que participo. Los sidechats viven en DMs y cuentan allí. Las menciones del árbol se suman igual.

/// Lo pendiente de una fila y de sus derivadas.
struct TreePending: Equatable {
    /// Sin leer del grupo más sus derivadas (sin mirar el silencio): decide «Marcar como leído».
    var unread = 0
    /// Igual, pero como cuentan la bandeja y el globo: una conversación silenciada solo cuenta si tiene mención.
    var pending = 0
    /// Menciones sin leer del árbol.
    var mentions = 0
    /// Solo de las derivadas (chip «⑂ N» de la fila).
    var derivedUnread = 0
    var derivedMentions = 0
    /// Derivadas con algo pendiente (la franja «… en X conversaciones de este grupo»).
    var derivedCount = 0

    /// El menú ofrece «Marcar como leído».
    var canMarkRead: Bool { unread > 0 || mentions > 0 }
    /// Cuenta en «No leídos» y en el separador «Sin leer».
    var isUnread: Bool { pending > 0 || mentions > 0 }
}

/// Un elemento de POST /conversations/:id/read-tree: hasta el seq que el cliente conoce.
struct ReadTreeItem: Equatable, Hashable {
    var conversationId: String
    var seq: Int
    var json: [String: Any] { ["conversationId": conversationId, "seq": seq] }
}

enum ReadTree {
    /// Derivada que cuenta en el árbol de su padre (hilo, rama, interna o directiva; nunca un sidechat).
    static func isDerived(_ c: ConversationDTO) -> Bool { c.parentId != nil && !Naming.isSide(c) }

    /// Derivadas por padre, para no recorrer la lista una vez por fila.
    struct Index {
        let byParent: [String: [ConversationDTO]]
        let ids: Set<String>
        init(_ list: [ConversationDTO]) {
            var m: [String: [ConversationDTO]] = [:]
            for c in list where isDerived(c) { m[c.parentId!, default: []].append(c) }
            byParent = m
            ids = Set(list.map(\.id))
        }
        init(_ d: BootstrapDTO) { self.init(d.conversations) }

        func derived(of id: String) -> [ConversationDTO] { byParent[id] ?? [] }

        func pending(_ c: ConversationDTO) -> TreePending {
            var t = TreePending(unread: c.unread, pending: HomeOrder.pending(c), mentions: c.unreadMentions)
            for x in derived(of: c.id) {
                t.unread += x.unread
                t.pending += HomeOrder.pending(x)
                t.mentions += x.unreadMentions
                t.derivedUnread += HomeOrder.pending(x)
                t.derivedMentions += x.unreadMentions
                if x.unread > 0 || x.unreadMentions > 0 { t.derivedCount += 1 }
            }
            return t
        }

        /// Derivadas con pendientes: primero las que tienen mención, luego las de más sin leer, luego por actividad.
        func pendingDerived(of id: String) -> [ConversationDTO] {
            derived(of: id).filter { $0.unread > 0 || $0.unreadMentions > 0 }.sorted { a, b in
                if (a.unreadMentions > 0) != (b.unreadMentions > 0) { return a.unreadMentions > 0 }
                if a.unread != b.unread { return a.unread > b.unread }
                return (a.lastMessageAt ?? "") > (b.lastMessageAt ?? "")
            }
        }

        /// Lo que manda «Marcar como leído»: el grupo (siempre, con su último seq conocido) y cada derivada pendiente.
        /// Cada seq es el `lastMessageSeq` que el cliente conoce: lo que llegue después sigue sin leer.
        func items(for c: ConversationDTO) -> [ReadTreeItem] {
            [ReadTreeItem(conversationId: c.id, seq: c.lastMessageSeq)]
                + pendingDerived(of: c.id).map { ReadTreeItem(conversationId: $0.id, seq: $0.lastMessageSeq) }
        }
    }

    static func pending(_ d: BootstrapDTO, _ c: ConversationDTO) -> TreePending { Index(d).pending(c) }
    static func items(_ d: BootstrapDTO, _ c: ConversationDTO) -> [ReadTreeItem] { Index(d).items(for: c) }

    /// Estado local tras marcar hasta `seq` (el servidor nunca retrocede el cursor; lo nuevo sigue sin leer).
    static func applyRead(_ c: inout ConversationDTO, seq: Int) {
        if seq > c.lastReadSeq {
            c.lastReadSeq = seq
            c.unread = max(0, c.lastMessageSeq - max(seq, c.historyFromSeq))
        }
        if seq >= c.lastMessageSeq { c.unread = 0; c.unreadMentions = 0 }
    }
}

/// Respuesta de read-tree: el cursor de cada conversación que el servidor aceptó.
struct ReadTreeResult: Decodable, Sendable {
    struct Marked: Decodable, Sendable {
        var conversationId: String
        var lastReadSeq: Int
        var readRevision: Int?
        init(from d: Decoder) throws { let c = try container(d); conversationId = c.v("conversationId", ""); lastReadSeq = c.int("lastReadSeq"); readRevision = c.intOpt("readRevision") }
    }
    var marked: [Marked]
    init(from d: Decoder) throws { marked = (try container(d)).lossyArray("marked") }
}
