import SwiftUI

/// Color estable por persona (avatar con iniciales y nombre del autor en grupos).
/// Mismo algoritmo en iOS, Android y web: FNV-1a de 32 bits sobre los bytes UTF-8 del id
/// en minúsculas, índice = hash % 8. Paleta sin naranja (el naranja es de "mis" mensajes);
/// el tono claro es el fondo del avatar con iniciales blancas y el texto del nombre en modo claro,
/// el tono oscuro es el texto del nombre en modo oscuro.
enum PersonColor {
    struct Pair: Equatable { let light: UInt32; let dark: UInt32 }

    static let palette: [Pair] = [
        Pair(light: 0x2563EB, dark: 0x7AA7FF), // azul
        Pair(light: 0x0F766E, dark: 0x4FD1C5), // verde azulado
        Pair(light: 0x15803D, dark: 0x6BD68B), // verde
        Pair(light: 0x7C3AED, dark: 0xB794F6), // violeta
        Pair(light: 0xBE185D, dark: 0xF58FBF), // fucsia
        Pair(light: 0x4338CA, dark: 0x9FA8FF), // índigo
        Pair(light: 0x0E7490, dark: 0x5CCFE6), // cian
        Pair(light: 0x475569, dark: 0xA7B4C8), // pizarra
    ]

    static func fnv1a(_ s: String) -> UInt32 {
        var h: UInt32 = 0x811C9DC5
        for b in s.lowercased().utf8 { h ^= UInt32(b); h = h &* 0x01000193 }
        return h
    }

    static func index(_ id: String) -> Int { Int(fnv1a(id) % UInt32(palette.count)) }
    static func pair(_ id: String) -> Pair { palette[index(id)] }
    /// Fondo del avatar (iniciales en blanco).
    static func fill(_ id: String) -> Color { Color(hex: pair(id).light) }
    /// Texto del nombre del autor (claro/oscuro).
    static func text(_ id: String) -> Color { let p = pair(id); return Color(light: p.light, dark: p.dark) }
}

/// Rachas de mensajes: nombre y avatar solo en el primero de una racha del mismo autor (< 5 min).
enum ChatGrouping {
    static let window: TimeInterval = 300

    static func startsRun(previous: MessageDTO?, current m: MessageDTO) -> Bool {
        guard let p = previous, !p.isSystem, !m.isSystem, p.authorId == m.authorId, m.replyTo == nil, m.forwarded == nil else { return true }
        guard let a = ISODate.parse(p.createdAt), let b = ISODate.parse(m.createdAt) else { return true }
        return b.timeIntervalSince(a) >= window
    }

    /// En directos no hace falta avatar en cada burbuja.
    static func showsAvatars(_ kind: ConversationKind) -> Bool { kind != .direct }
}
