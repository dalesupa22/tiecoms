import Foundation

/// Registro acotado de los mensajes que ya pasaron por la decisión de aviso en primer plano,
/// venga del socket (`announce`) o del push remoto (`willPresent`). El primero decide; el segundo
/// ve el id registrado y no repite nada. Así un push remoto solo se calla si de verdad hubo decisión local
/// (antes se callaba siempre que el socket estaba en línea, y se perdían los avisos de conversaciones
/// desconocidas, huecos, catch-up y reconexiones).
struct AnnouncedLedger {
    let capacity: Int
    private var order: [String] = []
    private var decisions: [String: NotifyRule.Outcome] = [:]

    init(capacity: Int = 300) { self.capacity = max(1, capacity) }

    var count: Int { order.count }

    func decision(_ messageId: String) -> NotifyRule.Outcome? { decisions[messageId] }

    func contains(_ messageId: String) -> Bool { decisions[messageId] != nil }

    /// Registra la decisión si el id es nuevo. Devuelve false si ya estaba (la primera decisión manda).
    @discardableResult
    mutating func record(_ messageId: String, _ outcome: NotifyRule.Outcome) -> Bool {
        if decisions[messageId] != nil {
            // Uso reciente: pasa al final para no expulsarlo antes que otros más viejos.
            if let i = order.firstIndex(of: messageId) { order.remove(at: i); order.append(messageId) }
            return false
        }
        decisions[messageId] = outcome
        order.append(messageId)
        while order.count > capacity { decisions[order.removeFirst()] = nil }
        return true
    }

    mutating func removeAll() { order = []; decisions = [:] }
}

/// Decisión para un push remoto de mensaje (message, mention, side) recibido con la app en primer plano.
enum ForegroundPush {
    struct Input: Equatable {
        /// El id ya pasó por `announce` o por otro push.
        var alreadyAnnounced = false
        var dnd = false
        /// La conversación está en pantalla, la app activa y los mensajes cargados (no el error de un 502).
        var openActiveLoaded = false
        var muted = false
        var mutedForever = false
        var mentionsMe = false
        var blocked = false
        var mine = false
    }

    /// Mismas reglas que el aviso local (`NotifyRule.incoming`). `outcome` nil = ya decidido: no se registra ni muestra.
    static func decide(_ i: Input) -> (present: Bool, outcome: NotifyRule.Outcome?) {
        if i.alreadyAnnounced { return (false, nil) }
        guard NotifyRule.presentsInForeground(dnd: i.dnd) else { return (false, .none) }
        let o = NotifyRule.incoming(.init(mine: i.mine, system: false, blocked: i.blocked, openAndActive: i.openActiveLoaded,
                                          muted: i.muted, mutedForever: i.mutedForever, mentionsMe: i.mentionsMe, dnd: i.dnd))
        switch o {
        case .notify, .mention: return (true, o)
        case .sound, .none: return (false, o)
        }
    }

    /// Tipos de push que corresponden a un mensaje y pasan por el registro.
    static func isMessage(_ kind: PushPayload.Kind) -> Bool { kind == .message || kind == .mention || kind == .side }
}
