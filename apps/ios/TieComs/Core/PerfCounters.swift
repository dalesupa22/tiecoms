import Foundation

/// Contadores de rendimiento (1.7.1), solo con `-TCPerfOut <ruta>` (pruebas): cuántas veces se evalúa cada vista o
/// selector y cuánto tardan, en un JSON que se reescribe cada medio segundo. Sin el argumento no hacen nada.
enum PerfCounters {
    static let outPath: String? = {
        let p = UserDefaults.standard.string(forKey: "TCPerfOut")
        return (p?.isEmpty ?? true) ? nil : p
    }()
    static var enabled: Bool { outPath != nil }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var counts: [String: Int] = [:]
    nonisolated(unsafe) private static var micros: [String: Double] = [:]
    nonisolated(unsafe) private static var timer: DispatchSourceTimer?

    @inline(__always) static func bump(_ name: String, _ n: Int = 1) {
        guard enabled else { return }
        lock.lock(); counts[name, default: 0] += n; lock.unlock()
    }

    /// Mide `body` (tiempo de pared) bajo `name`.
    @inline(__always) static func measure<T>(_ name: String, _ body: () throws -> T) rethrows -> T {
        guard enabled else { return try body() }
        let t0 = DispatchTime.now().uptimeNanoseconds
        defer {
            let us = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1000
            lock.lock(); counts[name, default: 0] += 1; micros[name, default: 0] += us; lock.unlock()
        }
        return try body()
    }

    static func start() {
        guard let path = outPath, timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        t.schedule(deadline: .now() + 0.5, repeating: 0.5)
        t.setEventHandler {
            lock.lock()
            var obj: [String: Any] = ["counts": counts, "micros": micros.mapValues { Int($0) }]
            lock.unlock()
            obj["bubbleHits"] = RichTextStats.hits; obj["bubbleMisses"] = RichTextStats.misses
            if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) {
                try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
            }
        }
        t.resume()
        timer = t
    }
}

/// Aciertos de la caché de burbujas (la extensión Compartir no compila las vistas del chat).
enum RichTextStats {
    nonisolated(unsafe) static var hits = 0
    nonisolated(unsafe) static var misses = 0
}
