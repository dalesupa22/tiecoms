import Foundation

/// «No molestar» (SPEC-silencio §3): estado sincronizado con el bootstrap (`me.dndUntil`), el evento `me.dnd` y
/// PUT /me/dnd. Si el API no conoce la ruta (404), se guarda solo en el dispositivo y se avisa en silencio.
extension AppStore {
    /// Hasta cuándo está activo: lo más lejano entre lo del servidor y lo guardado en el dispositivo.
    var dndUntil: Date? {
        _ = dndTick
        let now = Date()
        return [ISODate.parse(data?.me.dndUntil), localDndUntil]
            .compactMap { $0 }.filter { $0 > now }.max()
    }

    var dndActive: Bool { dndUntil != nil }

    /// Cambia «No molestar» (nil = apagar). Optimista; el servidor responde `{ dndUntil }` y avisa a mis otras sesiones.
    func setDoNotDisturb(until: Date?) async {
        let before = data?.me.dndUntil
        let beforeLocal = localDndUntil
        patchMe { $0.dndUntil = until.map { ISODate.string($0) } }
        setLocalDnd(nil)
        scheduleDndExpiry()
        do {
            let r: DndResponse = try await api.request("/me/dnd", method: "PUT", json: ["until": Silence.wire(until)])
            patchMe { $0.dndUntil = r.dndUntil }
            dndLocalOnly = false
            show(L(until == nil ? "toast.dndOff" : "toast.dndOn"))
        } catch let e as ApiRequestError where e.status == 404 {
            // Servidor viejo: queda en este dispositivo (la app no muestra avisos locales; el push sí puede llegar).
            patchMe { $0.dndUntil = nil }
            setLocalDnd(until)
            dndLocalOnly = true
            show(L(until == nil ? "toast.dndOff" : "toast.dndOn"))
        } catch {
            patchMe { $0.dndUntil = before }
            setLocalDnd(beforeLocal)
            show(L10n.errorText(error))
        }
        scheduleDndExpiry()
    }

    /// Estado que llega del servidor (evento `me.dnd`).
    func applyServerDnd(_ until: String?) {
        patchMe { $0.dndUntil = until }
        // El servidor conoce «No molestar»: lo guardado solo en el dispositivo sobra.
        setLocalDnd(nil)
        dndLocalOnly = false
        scheduleDndExpiry()
    }

    func loadLocalDnd() {
        guard let me = data?.me.id else { return }
        let saved = Prefs.localDndUntil(userId: me)
        if saved.map({ $0 > Date() }) == true {
            localDndUntil = saved
            dndLocalOnly = true
        } else {
            if saved != nil { Prefs.setLocalDndUntil(nil, userId: me) }
            localDndUntil = nil
        }
        scheduleDndExpiry()
    }

    func setLocalDnd(_ until: Date?) {
        localDndUntil = until
        if let me = data?.me.id { Prefs.setLocalDndUntil(until, userId: me) }
    }

    /// Redibuja la lunita y la franja cuando vence (sin esperar a otro evento).
    func scheduleDndExpiry() {
        dndExpiryTask?.cancel()
        guard let until = dndUntil, !Silence.isForever(until) else { dndExpiryTask = nil; return }
        let wait = max(0, until.timeIntervalSinceNow) + 0.5
        dndExpiryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.dndTick += 1
        }
    }

    #if DEBUG
    func setDndForTesting(server: String?, local: Date? = nil) {
        patchMe { $0.dndUntil = server }
        localDndUntil = local
    }
    #endif
}

struct DndResponse: Decodable, Sendable {
    var dndUntil: String?
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        dndUntil = c.o("dndUntil")
    }
}

extension Prefs {
    private static func dndKey(_ userId: String) -> String { "tc.dndUntil.\(userId)" }
    static func localDndUntil(userId: String) -> Date? { ISODate.parse(defaults.string(forKey: dndKey(userId))) }
    static func setLocalDndUntil(_ until: Date?, userId: String) {
        if let until { defaults.set(ISODate.string(until), forKey: dndKey(userId)) } else { defaults.removeObject(forKey: dndKey(userId)) }
    }
}
