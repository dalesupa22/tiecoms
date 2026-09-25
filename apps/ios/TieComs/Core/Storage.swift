import Foundation
import Security

/// Dónde se guarda el refresh token.
protocol SecretStore: AnyObject {
    func get() -> String?
    func set(_ value: String?)
}

/// Refresh token en el Keychain, solo en este dispositivo y tras el primer desbloqueo.
/// Se guarda en el grupo compartido `group.com.tiecoms.app` para que la extensión de
/// Compartir use la misma sesión. Si el grupo no está disponible (build sin firma),
/// se usa el Keychain propio de la app. Lee y migra el ítem antiguo sin grupo.
final class KeychainSecretStore: SecretStore {
    static let sharedGroup = "group.com.tiecoms.app"
    private let service: String
    private static let legacyAccount = "refreshToken"
    private let account: String
    private let group: String?

    /// La sesión se guarda por servidor: cambiar de API (producción, 3043, otro puerto) nunca borra
    /// la sesión de otro. Producción conserva la cuenta histórica "refreshToken".
    static func account(for apiURL: URL?) -> String {
        guard let apiURL, let host = apiURL.host?.lowercased(), host != URL(string: AppConfig.defaultAPI)?.host else { return legacyAccount }
        return "refreshToken@\(host):\(apiURL.port ?? (apiURL.scheme == "http" ? 80 : 443))"
    }

    init(service: String = "com.tiecoms.app.session", group: String? = KeychainSecretStore.sharedGroup, apiURL: URL? = nil) {
        self.service = service
        self.group = group
        self.account = KeychainSecretStore.account(for: apiURL)
    }

    private func query(group: String?, account: String? = nil) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account ?? self.account]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    private func read(group: String?, account: String? = nil) -> String? {
        var q = query(group: group, account: account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func get() -> String? {
        if let group, let v = read(group: group) { return v }
        // Ítem de la versión 1.0 (sin grupo) o grupo no disponible.
        if let legacy = read(group: nil) {
            if group != nil { set(legacy) }
            return legacy
        }
        // Migración (build 6): antes había una sola cuenta para cualquier servidor. Se copia sin borrarla;
        // si no era de este servidor, el refresh dará 401 y solo se limpia la copia de este servidor.
        guard account != Self.legacyAccount else { return nil }
        let migrated = group.flatMap { read(group: $0, account: Self.legacyAccount) } ?? read(group: nil, account: Self.legacyAccount)
        if let migrated { set(migrated) }
        return migrated
    }

    func set(_ value: String?) {
        if let group { SecItemDelete(query(group: group) as CFDictionary) }
        SecItemDelete(query(group: nil) as CFDictionary)
        guard let value, let data = value.data(using: .utf8) else { return }
        func add(_ group: String?) -> OSStatus {
            var q = query(group: group)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            return SecItemAdd(q as CFDictionary, nil)
        }
        var status = add(group)
        if status != errSecSuccess && group != nil { status = add(nil) }
        if status != errSecSuccess { NSLog("[TieComs] Keychain SecItemAdd falló: \(status)") }
    }
}

/// Lista de conversaciones para la extensión de Compartir (App Group). Solo títulos, sin mensajes.
enum ShareTargets {
    static let suite = "group.com.tiecoms.app"
    /// Lo que la extensión necesita para agrupar como Inicio (Empresa · Espacio, Chats) y mostrar la foto.
    struct Target: Codable, Equatable, Identifiable {
        var id: String
        var title: String
        var subtitle: String
        /// «Empresa · Espacio» o nil (chats).
        var group: String? = nil
        var kind: String = "group"
        var lastMessageAt: String? = nil
        var avatarPath: String? = nil
        var isSide: Bool = false

        init(id: String, title: String, subtitle: String, group: String? = nil, kind: String = "group", lastMessageAt: String? = nil,
             avatarPath: String? = nil, isSide: Bool = false) {
            self.id = id; self.title = title; self.subtitle = subtitle; self.group = group; self.kind = kind
            self.lastMessageAt = lastMessageAt; self.avatarPath = avatarPath; self.isSide = isSide
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self)
            id = try c.decode(String.self, forKey: AnyKey("id"))
            title = c.v("title", "")
            subtitle = c.v("subtitle", "")
            group = c.o("group")
            kind = c.v("kind", "group")
            lastMessageAt = c.o("lastMessageAt")
            avatarPath = c.o("avatarPath")
            isSide = c.v("isSide", false)
        }
    }

    static func targets(_ d: BootstrapDTO) -> [Target] {
        d.conversations.filter(\.canPost).map { c in
            Target(id: c.id, title: Naming.title(d, c),
                   subtitle: d.workspaces.first(where: { $0.id == c.workspaceId })?.name ?? Naming.subtitle(d, c),
                   group: Naming.route(d, c), kind: c.kind.rawValue, lastMessageAt: c.lastMessageAt,
                   avatarPath: c.avatarUrl ?? (c.kind == .direct ? Naming.otherInDirect(d, c)?.avatarUrl : nil), isSide: Naming.isSide(c))
        }
    }

    static func save(_ d: BootstrapDTO, apiURL: URL) {
        guard let defaults = UserDefaults(suiteName: suite) else { return }
        let list = targets(d)
        defaults.set(try? JSONEncoder().encode(list), forKey: "targets")
        defaults.set(apiURL.absoluteString, forKey: "apiURL")
        defaults.set(Prefs.deviceId, forKey: "deviceId")
    }

    static func load() -> (targets: [Target], apiURL: URL?, deviceId: String?) {
        guard let defaults = UserDefaults(suiteName: suite) else { return ([], nil, nil) }
        let list = (defaults.data(forKey: "targets")).flatMap { try? JSONDecoder().decode([Target].self, from: $0) } ?? []
        return (list, defaults.string(forKey: "apiURL").flatMap(URL.init(string:)), defaults.string(forKey: "deviceId"))
    }

    static func clear() { UserDefaults(suiteName: suite)?.removeObject(forKey: "targets") }
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

    /// Ya se mostró la pantalla previa al permiso de notificaciones.
    static var pushPrompted: Bool {
        get { defaults.bool(forKey: "tc.pushPrompted") }
        set { defaults.set(newValue, forKey: "tc.pushPrompted") }
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
    var forwarded: ForwardedInfo?
    /// Adjuntos ya subidos (pendientes en el servidor hasta que este mensaje los use).
    var attachmentIds: [String]? = nil
    /// Reenvío: adjuntos de mensajes que puedo leer (el servidor copia la referencia).
    var forwardAttachmentIds: [String]? = nil
    /// Copia local para mostrar la burbuja mientras se envía.
    var attachments: [AttachmentDTO]? = nil
    var createdAt: String
    var attempts: Int
    var status: Status
    var error: String?
    var nextAttemptAt: Double

    var id: String { clientMessageId }
}
