import Foundation

/// Volver al frente (CH035, criterio de la web PERF-C1): si la app estuvo fuera menos de un minuto y el socket nunca se
/// cayó, no se perdió ningún evento y no hace falta pedir `/bootstrap` entero. Con cuentas de WhatsApp conocidas se pide
/// siempre (su privacidad se revalida en cada vuelta). Si el socket reconecta, su «ready» pide la vuelta completa.
enum ResyncRule {
    static let shortAway: TimeInterval = 60
    static func skipBootstrap(away: TimeInterval, socketConnected: Bool, waAccounts: Bool) -> Bool {
        socketConnected && !waAccounts && away >= 0 && away < shortAway
    }
}

/// Identidad de fila estable al confirmar un envío (CH035). Lo que mandé en esta sesión conserva el id de su burbuja
/// «enviando» (`p-<clientMessageId>`): para la lista es la misma fila, así que no hay quitar-y-poner ni un segundo
/// desplazamiento al final cuando el servidor confirma. Lo demás usa el id del mensaje, como siempre.
enum SentRows {
    /// Solo se toca desde el hilo principal (el store y la vista).
    private static var sent = Set<String>()
    static func note(_ clientMessageId: String) { sent.insert(clientMessageId) }
    static func pendingId(_ clientMessageId: String) -> String { "p-\(clientMessageId)" }
    static func rowId(_ m: MessageDTO) -> String {
        if let c = m.clientMessageId, sent.contains(c) { return pendingId(c) }
        return m.id
    }
    /// El id de fila de un mensaje por su id (para `scrollTo`); si no está cargado, el propio id.
    static func rowId(messageId: String, in messages: [MessageDTO]) -> String {
        messages.last { $0.id == messageId }.map(rowId) ?? messageId
    }
    static func reset() { sent.removeAll() }
}

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
    /// Primer no leído con lo que YA está en memoria (CH035), para colocar el chat antes del primer fotograma en vez de
    /// esperar a la red. `.some(m)`: ese es; `.some(nil)`: no queda ninguno; `nil`: con lo cargado no se puede saber
    /// (falta historial o hay un hueco) y decide el camino de siempre, que sí pide páginas (`firstUnreadMessage`).
    static func firstUnreadInMemory(_ messages: [MessageDTO], snapshot: Snapshot, historyFromSeq: Int, lastMessageSeq: Int,
                                    me: String?, blocked: Set<String>) -> MessageDTO?? {
        guard snapshot.unread > 0 else { return .some(nil) }
        let floor = max(snapshot.lastReadSeq, historyFromSeq)
        guard let first = messages.first, first.seq <= floor + 1 else { return nil }
        var cursor = floor
        for m in messages where m.seq > floor {
            guard m.seq == cursor + 1 else { return nil }
            cursor = m.seq
            if !m.isSystem && m.deletedAt == nil && m.authorId != me && !blocked.contains(m.authorId) { return .some(m) }
        }
        return cursor >= lastMessageSeq ? .some(nil) : nil
    }

    /// El tema con que abre el chat si se puede saber ya: `.some(tema o nil)`. `nil` = hay que esperar la lista de temas
    /// (el primer no leído trae tema y todavía no se sabe si está activo). Misma regla que `TopicRules.openFilter`.
    static func openFilterInMemory(_ messages: [MessageDTO], after read: Int, me: String, topics: [TopicDTO]?) -> String?? {
        if let topics { return .some(TopicRules.openFilter(messages, after: read, me: me, active: TopicRules.activeIds(topics))) }
        let first = messages.filter { TopicRules.countsAsUnread($0, after: read, me: me) }.min { $0.seq < $1.seq }
        return first?.topicId == nil ? .some(nil) : nil
    }

    static func mentionIds(_ messages: [MessageDTO], after lastReadSeq: Int, me: String) -> [String] {
        messages.filter { $0.seq > lastReadSeq && $0.deletedAt == nil && MentionText.mentionsMe($0.mentions, me: me, authorId: $0.authorId) }.map(\.id)
    }

    /// Distancia del final a partir de la cual aparece el botón ⌄ (≈ una pantalla).
    static func showsJumpToLatest(distanceFromBottom: CGFloat, viewport: CGFloat) -> Bool {
        viewport > 0 && distanceFromBottom > viewport
    }
}
