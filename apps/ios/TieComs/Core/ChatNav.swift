import Foundation

/// Navegar un chat largo (1.6.4, SPEC-bandeja D): abrir en el primer no leído con la línea «N mensajes nuevos»,
/// botón ⌄ «Ir al final», píldora «↑ N nuevos» y botón «@» a la siguiente mención. Reglas puras (sin vista).
enum ChatNav {
    /// Lo que había sin leer al abrir el chat (se toma antes de marcar leído; la línea queda hasta salir del chat).
    struct Snapshot: Equatable {
        var lastReadSeq: Int
        var unread: Int
    }

    /// Máximo de páginas antiguas que se cargan para llegar al primer no leído (si no, se abre al final).
    static let maxOlderPages = 3

    /// Índice del primer mensaje no leído en `messages` (orden por seq), o nil si no hay o no está cargado.
    /// Con `lastReadSeq` > 0: el primero después de él que no es mío ni de sistema. Sin él: los últimos `unread`.
    /// `hasMore`: hay mensajes más antiguos sin cargar (entonces un primer mensaje cargado ya no leído no basta).
    static func firstUnreadIndex(_ messages: [MessageDTO], snapshot s: Snapshot, me: String, hasMore: Bool = false) -> Int? {
        guard s.unread > 0, !messages.isEmpty else { return nil }
        let counted = messages.indices.filter { !messages[$0].isSystem && messages[$0].authorId != me }
        if s.lastReadSeq > 0 {
            // El primer no leído no está cargado todavía: lo cargado empieza después de lo leído y hay más atrás.
            if hasMore, let first = messages.first, first.seq > s.lastReadSeq + 1 { return nil }
            return counted.first(where: { messages[$0].seq > s.lastReadSeq })
        }
        guard counted.count >= s.unread else { return hasMore ? nil : counted.first }
        return counted[counted.count - s.unread]
    }

    /// ¿Hay que cargar mensajes más antiguos para llegar al primer no leído?
    static func needsOlder(_ messages: [MessageDTO], snapshot s: Snapshot, me: String, hasMore: Bool) -> Bool {
        guard s.unread > 0, hasMore else { return false }
        return firstUnreadIndex(messages, snapshot: s, me: me, hasMore: true) == nil
    }

    /// Mensajes posteriores a lo leído al abrir que me mencionan (a mí o a todos), en orden.
    static func mentionIds(_ messages: [MessageDTO], after lastReadSeq: Int, me: String) -> [String] {
        messages.filter { $0.seq > lastReadSeq && $0.deletedAt == nil && MentionText.mentionsMe($0.mentions, me: me, authorId: $0.authorId) }.map(\.id)
    }

    /// Distancia del final a partir de la cual aparece el botón ⌄ (≈ una pantalla).
    static func showsJumpToLatest(distanceFromBottom: CGFloat, viewport: CGFloat) -> Bool {
        viewport > 0 && distanceFromBottom > viewport
    }
}
