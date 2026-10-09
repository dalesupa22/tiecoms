import SwiftUI

/// Color estable por persona (avatar con iniciales y nombre del autor en grupos).
/// Mismo algoritmo en iOS, Android y web: FNV-1a de 32 bits sobre los bytes UTF-8 del id
/// en minúsculas, índice = hash % 8. Paleta sin naranja (el naranja es de "mis" mensajes);
/// el tono claro es el fondo del avatar con iniciales blancas y el texto del nombre en modo claro,
/// el tono oscuro es el texto del nombre en modo oscuro.
enum PersonColor {
    /// Igual que personColor() de la web (apps/web/src/ui.tsx). El tono oscuro (texto del nombre en modo
    /// oscuro) es el mismo color aclarado un 40 % hacia el blanco.
    static let hexes: [UInt32] = [0x2F6FDB, 0x1A7F51, 0x7C4DDB, 0x0A7C87, 0xB83280, 0x4C51BF, 0x52606D, 0xC53030]
    static let fallback: UInt32 = 0x8A8177

    struct Pair: Equatable { let light: UInt32; let dark: UInt32 }
    static let palette: [Pair] = hexes.map { Pair(light: $0, dark: lighten($0, 0.4)) }

    static func lighten(_ c: UInt32, _ k: Double) -> UInt32 {
        func ch(_ v: UInt32) -> UInt32 { UInt32((Double(v) + (255 - Double(v)) * k).rounded()) }
        return ch((c >> 16) & 0xFF) << 16 | ch((c >> 8) & 0xFF) << 8 | ch(c & 0xFF)
    }

    /// FNV-1a 32 bits: por cada carácter del id en minúsculas, h ^= código (UTF-16) y h *= 0x01000193.
    static func fnv1a(_ s: String) -> UInt32 {
        var h: UInt32 = 0x811C9DC5
        for scalar in s.lowercased().unicodeScalars {
            let code = String(scalar).utf16.first.map(UInt32.init) ?? 0
            h ^= code
            h = h &* 0x01000193
        }
        return h
    }

    static func index(_ id: String) -> Int { Int(fnv1a(id) % UInt32(hexes.count)) }
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
