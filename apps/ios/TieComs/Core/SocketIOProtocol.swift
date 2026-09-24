import Foundation

/// Protocolo Engine.IO v4 + Socket.IO v5 sobre WebSocket (solo texto, espacio de nombres "/").
///
/// Trama WebSocket = paquete Engine.IO: un dígito de tipo + datos.
///   0 open · 1 close · 2 ping · 3 pong · 4 message · 5 upgrade · 6 noop
/// Dentro de un "message" (4) va un paquete Socket.IO: tipo, espacio de nombres
/// opcional ("/x,"), id de ACK opcional (dígitos) y JSON.
///   0 CONNECT · 1 DISCONNECT · 2 EVENT · 3 ACK · 4 CONNECT_ERROR · 5/6 binarios (no usados)
enum EnginePacket: Equatable {
    case open(OpenInfo)
    case close
    case ping
    case pong
    case message(SocketPacket)
    case upgrade
    case noop
    case invalid(String)

    struct OpenInfo: Equatable {
        var sid: String
        var pingInterval: Int
        var pingTimeout: Int
        var maxPayload: Int
    }

    static func parse(_ text: String) -> EnginePacket {
        guard let first = text.first else { return .invalid(text) }
        let rest = String(text.dropFirst())
        switch first {
        case "0":
            guard let data = rest.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sid = obj["sid"] as? String else { return .invalid(text) }
            return .open(OpenInfo(
                sid: sid,
                pingInterval: (obj["pingInterval"] as? NSNumber)?.intValue ?? 25_000,
                pingTimeout: (obj["pingTimeout"] as? NSNumber)?.intValue ?? 20_000,
                maxPayload: (obj["maxPayload"] as? NSNumber)?.intValue ?? 1_000_000))
        case "1": return .close
        case "2": return .ping
        case "3": return .pong
        case "4":
            guard let p = SocketPacket.parse(rest) else { return .invalid(text) }
            return .message(p)
        case "5": return .upgrade
        case "6": return .noop
        default: return .invalid(text)
        }
    }

    var encoded: String {
        switch self {
        case .open: return "0"
        case .close: return "1"
        case .ping: return "2"
        case .pong: return "3"
        case .message(let p): return "4" + p.encoded
        case .upgrade: return "5"
        case .noop: return "6"
        case .invalid(let s): return s
        }
    }
}

struct SocketPacket: Equatable {
    enum Kind: Int { case connect = 0, disconnect = 1, event = 2, ack = 3, connectError = 4, binaryEvent = 5, binaryAck = 6 }

    var kind: Kind
    var namespace: String = "/"
    var ackId: Int?
    /// JSON crudo del cuerpo (objeto para CONNECT/CONNECT_ERROR, arreglo para EVENT/ACK).
    var json: String?

    static func parse(_ s: String) -> SocketPacket? {
        var i = s.startIndex
        guard i < s.endIndex, let t = s[i].wholeNumberValue, let kind = Kind(rawValue: t) else { return nil }
        i = s.index(after: i)
        // Paquetes binarios: "<n>-" adjuntos. No se usan; se descarta el prefijo.
        if kind == .binaryEvent || kind == .binaryAck {
            while i < s.endIndex, s[i] != "-" { i = s.index(after: i) }
            if i < s.endIndex { i = s.index(after: i) }
        }
        var nsp = "/"
        if i < s.endIndex, s[i] == "/" {
            guard let comma = s[i...].firstIndex(of: ",") else { return nil }
            nsp = String(s[i..<comma])
            i = s.index(after: comma)
        }
        var digits = ""
        while i < s.endIndex, let _ = s[i].wholeNumberValue { digits.append(s[i]); i = s.index(after: i) }
        let body = String(s[i...])
        return SocketPacket(kind: kind, namespace: nsp, ackId: digits.isEmpty ? nil : Int(digits), json: body.isEmpty ? nil : body)
    }

    var encoded: String {
        var out = String(kind.rawValue)
        if namespace != "/" { out += namespace + "," }
        if let ackId { out += String(ackId) }
        if let json { out += json }
        return out
    }

    /// EVENT: nombre y argumentos.
    var event: (name: String, args: [Any])? {
        guard kind == .event || kind == .binaryEvent, let arr = jsonArray, let name = arr.first as? String else { return nil }
        return (name, Array(arr.dropFirst()))
    }

    var jsonArray: [Any]? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? [Any]
    }

    var jsonObject: [String: Any]? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: Constructores

    static func connect(auth: [String: Any]) -> SocketPacket {
        SocketPacket(kind: .connect, json: jsonString(auth))
    }

    static func event(_ name: String, _ payload: Any?, ackId: Int? = nil) -> SocketPacket {
        var arr: [Any] = [name]
        if let payload { arr.append(payload) }
        return SocketPacket(kind: .event, ackId: ackId, json: jsonString(arr))
    }

    static func jsonString(_ obj: Any) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// Convierte un valor JSON ya parseado en un DTO Decodable (tolerante).
enum JSONBridge {
    static func decode<T: Decodable>(_ type: T.Type, from value: Any?) -> T? {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
