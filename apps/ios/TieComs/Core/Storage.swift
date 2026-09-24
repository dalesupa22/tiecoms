import Foundation
import Security

/// Dónde se guarda el refresh token.
protocol SecretStore: AnyObject {
    func get() -> String?
    func set(_ value: String?)
}

/// Refresh token en el Keychain, solo en este dispositivo y tras el primer desbloqueo
/// (la app puede refrescar la sesión al volver del segundo plano).
final class KeychainSecretStore: SecretStore {
    private let service: String
    private let account = "refreshToken"

    init(service: String = "com.tiecoms.app.session") { self.service = service }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func get() -> String? {
        var q = baseQuery
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(_ value: String?) {
        SecItemDelete(baseQuery as CFDictionary)
        guard let value, let data = value.data(using: .utf8) else { return }
        var q = baseQuery
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        if status != errSecSuccess { NSLog("[TieComs] Keychain SecItemAdd falló: \(status)") }
    }
}

/// Para pruebas: en memoria.
final class MemorySecretStore: SecretStore {
    private var value: String?
    init(_ value: String? = nil) { self.value = value }
    func get() -> String? { value }
    func set(_ value: String?) { self.value = value }
}

/// Preferencias y datos locales no secretos.
enum Prefs {
    static let defaults = UserDefaults.standard
    private static let deviceKey = "tc.deviceId"
    private static let soundsKey = "tc.sounds"
    private static let notificationsKey = "tc.notifications"
    private static let apiURLKey = "tc.apiURL"

    /// Identificador estable del dispositivo (UUID guardado la primera vez).
    static var deviceId: String {
        if let v = defaults.string(forKey: deviceKey), !v.isEmpty { return v }
        let v = UUID().uuidString.lowercased()
        defaults.set(v, forKey: deviceKey)
        return v
    }

    static var soundsEnabled: Bool {
        get { defaults.object(forKey: soundsKey) as? Bool ?? true }
        set { defaults.set(newValue, forKey: soundsKey) }
    }

    static var notificationsEnabled: Bool {
        get { defaults.object(forKey: notificationsKey) as? Bool ?? true }
        set { defaults.set(newValue, forKey: notificationsKey) }
    }

    /// URL del API elegida en la pantalla oculta de depuración (nil = la de por defecto).
    static var customAPIURL: String? {
        get { defaults.string(forKey: apiURLKey) }
        set { if let newValue, !newValue.isEmpty { defaults.set(newValue, forKey: apiURLKey) } else { defaults.removeObject(forKey: apiURLKey) } }
    }
}

/// Cola de salida persistente (JSON en Application Support), por usuario.
final class OutboxStore {
    private let dir: URL

    init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("TieComs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    private func file(_ userId: String) -> URL { dir.appendingPathComponent("outbox-\(userId).json") }

    func load(userId: String) -> [PendingMessage] {
        guard let data = try? Data(contentsOf: file(userId)) else { return [] }
        return (try? JSONDecoder().decode([PendingMessage].self, from: data)) ?? []
    }

    func save(_ list: [PendingMessage], userId: String) {
        guard let data = try? JSONEncoder().encode(list) else { return }
        try? data.write(to: file(userId), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func clear(userId: String) { try? FileManager.default.removeItem(at: file(userId)) }
}

struct PendingMessage: Codable, Equatable, Identifiable, Sendable {
    enum Status: String, Codable, Sendable { case pending, sending, failed }
    var clientMessageId: String
    var conversationId: String
    var body: String
    var replyTo: String?
    var createdAt: String
    var attempts: Int
    var status: Status
    var error: String?
    var nextAttemptAt: Double

    var id: String { clientMessageId }
}
