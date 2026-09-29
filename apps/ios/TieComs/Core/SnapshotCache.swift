import Foundation
import os

// 1.7.0 · Velocidad: pintar desde la caché local y revalidar en segundo plano.
// Por usuario: el bootstrap, los bloqueos y los últimos 50 mensajes de las ~30 conversaciones más recientes.
// En Application Support (sin copia en iCloud) y se borra al cerrar sesión. Los mensajes de una sola vista no traen
// contenido (el API los manda vacíos), así que nunca quedan en disco.

struct CachedConversation: Codable, Equatable {
    var messages: [MessageDTO]
    var lastEventSeq: Int
    var hasMore: Bool
}

struct AppSnapshot: Codable {
    static let version = 1
    var version = AppSnapshot.version
    var contract: String = Contract.version
    var savedAt: String
    var bootstrap: BootstrapDTO
    var blocked: [String]
    var conversations: [String: CachedConversation]
}

enum SnapshotCache {
    static let maxConversations = 30
    static let maxMessages = 50

    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("snapshots", isDirectory: true)
        if !FileManager.default.fileExists(atPath: base.path) {
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            var u = base; var rv = URLResourceValues(); rv.isExcludedFromBackup = true; try? u.setResourceValues(rv)
        }
        return base
    }
    static func file(_ userId: String, apiHost: String) -> URL {
        let safe = (apiHost + "-" + userId).replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
        return dir.appendingPathComponent("\(safe).json")
    }

    /// Qué se guarda: las 30 conversaciones más recientes con mensajes cargados, los últimos 50 de cada una.
    static func make(_ d: BootstrapDTO, blocked: Set<String>, conversations: [String: ConversationState]) -> AppSnapshot {
        let recent = d.conversations.sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }.prefix(maxConversations).map(\.id)
        var out: [String: CachedConversation] = [:]
        for id in recent {
            guard let s = conversations[id], s.loaded, !s.messages.isEmpty else { continue }
            let tail = Array(s.messages.suffix(maxMessages))
            // Si se recorta, ya no es la historia completa: hay más atrás.
            out[id] = CachedConversation(messages: tail, lastEventSeq: s.lastEventSeq, hasMore: s.hasMore || tail.count < s.messages.count)
        }
        return AppSnapshot(savedAt: ISODate.string(), bootstrap: d, blocked: Array(blocked).sorted(), conversations: out)
    }

    static func load(userId: String, apiHost: String) -> AppSnapshot? {
        guard let data = try? Data(contentsOf: file(userId, apiHost: apiHost)),
              let s = try? JSONDecoder().decode(AppSnapshot.self, from: data),
              s.version == AppSnapshot.version, s.contract == Contract.version, s.bootstrap.me.id == userId else { return nil }
        return s
    }

    private static let queue = DispatchQueue(label: "chaggu.snapshot", qos: .utility)
    static func save(_ s: AppSnapshot, apiHost: String) {
        let url = file(s.bootstrap.me.id, apiHost: apiHost)
        queue.async {
            guard let data = try? JSONEncoder().encode(s) else { return }
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    static func clearAll() {
        queue.async { try? FileManager.default.removeItem(at: dir) }
    }
}

/// Marcas de tiempo (os_signpost + log) para medir el arranque y abrir un chat en Instruments.
enum Perf {
    static let log = Logger(subsystem: "com.chaggu.app", category: "perf")
    static let signposter = OSSignposter(subsystem: "com.chaggu.app", category: "perf")
    /// Arranque real del proceso (sysctl), para medir desde que el sistema lanza la app.
    static let processStart: Date = {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return Date() }
        let t = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: TimeInterval(t.tv_sec) + TimeInterval(t.tv_usec) / 1_000_000)
    }()
    static func mark(_ name: StaticString, _ detail: String = "") {
        signposter.emitEvent(name)
        log.notice("\(name, privacy: .public) +\(Int(Date().timeIntervalSince(processStart) * 1000), privacy: .public) ms \(detail, privacy: .public)")
    }
}

