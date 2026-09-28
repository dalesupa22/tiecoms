import Foundation

/// «No molestar todas las noches» (modo sueño, docs/PROGRAMADOS.md): un horario diario (22:00–07:00 por defecto) en la
/// zona horaria de la persona. Dentro de él el servidor no manda push. Mismas reglas que la web (Sleep.tsx).
enum SleepRules {
    static func minutes(_ hhmm: String) -> Int {
        let p = hhmm.split(separator: ":").compactMap { Int($0) }
        return (p.first ?? 0) * 60 + (p.count > 1 ? p[1] : 0)
    }

    /// Minutos del día en esa zona horaria.
    static func minutesIn(_ tz: String, at: Date) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: tz) ?? .current
        let c = cal.dateComponents([.hour, .minute], from: at)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    /// ¿Está en su ventana ahora? Soporta ventanas que cruzan la medianoche.
    static func sleepingNow(_ w: SleepWindow?, at: Date = Date()) -> Bool {
        guard let w else { return false }
        let s = minutes(w.start), e = minutes(w.end), n = minutesIn(w.tz, at: at)
        if s == e { return false }
        return s < e ? (n >= s && n < e) : (n >= s || n < e)
    }

    /// Cuándo se despierta: el próximo fin de la ventana, como fecha absoluta (al minuto).
    static func wakeAt(_ w: SleepWindow, at: Date = Date()) -> Date {
        var diff = (minutes(w.end) - minutesIn(w.tz, at: at) + 1440) % 1440
        if diff == 0 { diff = 1440 }
        let t = at.timeIntervalSince1970 + TimeInterval(diff * 60)
        return Date(timeIntervalSince1970: (t / 60).rounded(.down) * 60)
    }

    /// «10:00 p. m.» para un HH:MM.
    static func hourLabel(_ hhmm: String) -> String {
        let m = minutes(hhmm)
        var cal = Calendar(identifier: .gregorian); cal.timeZone = .current
        let d = cal.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()) ?? Date()
        return Schedule.time(d)
    }

    static func hhmm(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    static func date(_ hhmm: String) -> Date {
        let m = minutes(hhmm)
        return Calendar.current.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()) ?? Date()
    }

    static func summary(_ s: SleepDTO?) -> String {
        guard let s else { return L("sleep.off") }
        return s.on ? L("sleep.summary", ["from": hourLabel(s.start), "to": hourLabel(s.end)]) : L("sleep.off")
    }

    /// Aviso a quien escribe. En un directo con alguien que descansa, siempre (con el botón «Enviar a las …» mientras
    /// escribo); en grupos, solo mientras escribo.
    struct Notice: Equatable {
        var text: String
        /// Hora a la que se despierta (para «🕒 Enviar a las 7:00»), solo con una persona y mientras escribo.
        var wake: Date?
    }

    static func notice(me: String, members: [PersonDTO], typing: Bool, at: Date = Date()) -> Notice? {
        let others = members.filter { $0.id != me && $0.kind == "human" }
        let asleep = others.filter { sleepingNow($0.sleep, at: at) }
        guard !asleep.isEmpty else { return nil }
        let one = asleep.count == 1 ? asleep[0] : nil
        if one == nil && !typing { return nil }
        if others.count > 1 && !typing { return nil }
        if let one, others.count == 1, let w = one.sleep {
            let wake = wakeAt(w, at: at)
            let first = String(one.name.split(separator: " ").first ?? Substring(one.name))
            return Notice(text: L("sleep.noticeOne", ["name": first, "when": Schedule.whenLabel(wake, now: at)]), wake: typing ? wake : nil)
        }
        return Notice(text: L("sleep.noticeMany", ["n": asleep.count]), wake: nil)
    }
}

struct SleepResponse: Decodable, Sendable {
    var sleep: SleepDTO
    init(from decoder: Decoder) throws { sleep = try container(decoder).decode(SleepDTO.self, forKey: AnyKey("sleep")) }
}

extension AppStore {
    /// Mi ventana de descanso está activa ahora (la lunita del avatar también se enciende).
    var sleepActive: Bool {
        _ = clockTick
        return SleepRules.sleepingNow(data?.me.sleep?.window)
    }

    /// PUT /me/sleep { on?, start?, end?, tz?, tzAuto? } → { sleep }; el servidor avisa a mis otras sesiones (me.sleep).
    @discardableResult
    func setSleep(on: Bool? = nil, start: String? = nil, end: String? = nil, tz: String? = nil, tzAuto: Bool? = nil) async throws -> SleepDTO {
        var json: [String: Any] = [:]
        if let on { json["on"] = on }
        if let start { json["start"] = start }
        if let end { json["end"] = end }
        if let tz { json["tz"] = tz }
        if let tzAuto { json["tzAuto"] = tzAuto }
        let r: SleepResponse = try await api.request("/me/sleep", method: "PUT", json: json)
        patchMe { $0.sleep = r.sleep }
        return r.sleep
    }

    /// Mientras la persona no fije una zona a mano (tzAuto), se sigue la del dispositivo (viajes).
    func syncSleepTimeZone(device: String = TimeZone.current.identifier) async {
        guard let s = data?.me.sleep, s.tzAuto, !device.isEmpty, device != s.tz else { return }
        _ = try? await setSleep(tz: device, tzAuto: true)
    }
}
