import Foundation

/// Navegar un chat largo (1.6.4, SPEC-bandeja D): abrir en el primer no leído con la línea «N mensajes nuevos»,
/// botón ⌄ «Ir al final», píldora «↑ N nuevos» y botón «@» a la siguiente mención. Reglas puras (sin vista).
enum ChatNav {
    /// Lo que había sin leer al abrir el chat (se toma antes de marcar leído; la línea queda hasta salir del chat).
    struct Snapshot: Equatable {
        var lastReadSeq: Int
        var unread: Int
    }

    enum PositionError: Error { case historyGap }

    /// A numeric read cursor cannot skip an unseen row, even after jumping to a mention or the bottom.
    static func visibleReadCursor(_ messages: [MessageDTO], after cursor: Int, seen: Set<Int>, me: String) -> Int {
        var result = cursor
        for m in messages where m.seq > cursor {
            guard m.seq == result + 1 else { break }
            guard seen.contains(m.seq) || m.isSystem || m.deletedAt != nil || m.authorId == me else { break }
            result = m.seq
        }
        return result
    }

    static func isVisible(midY: CGFloat, viewport: CGFloat) -> Bool { viewport > 0 && midY >= 0 && midY < viewport }


    /// The unread boundary must be loaded without gaps; a count never proves that an older message was seen.
    static func firstUnreadIndex(_ messages: [MessageDTO], snapshot s: Snapshot, me: String, hasMore: Bool = false) -> Int? {
        guard s.unread > 0 else { return nil }
        var cursor = s.lastReadSeq
        for index in messages.indices where messages[index].seq > cursor {
            let message = messages[index]
            guard message.seq == cursor + 1 else { return nil }
            cursor = message.seq
            if !message.isSystem && message.deletedAt == nil && message.authorId != me { return index }
        }
        return nil
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
