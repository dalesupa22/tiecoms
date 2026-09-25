import Foundation

/// Texto localizado (es/en según el idioma del sistema; en cualquier otro idioma, inglés).
/// Las variables van como `{nombre}` igual que en la web (apps/web/src/i18n.ts).
func L(_ key: String, _ vars: [String: CustomStringConvertible] = [:]) -> String {
    var s = Bundle.main.localizedString(forKey: key, value: nil, table: nil)
    if s == key, let en = L10n.englishBundle { s = en.localizedString(forKey: key, value: key, table: nil) }
    for (k, v) in vars { s = s.replacingOccurrences(of: "{\(k)}", with: v.description) }
    return s
}

enum L10n {
    static let englishBundle: Bundle? = Bundle.main.path(forResource: "en", ofType: "lproj").flatMap(Bundle.init(path:))

    /// Idioma efectivo de la interfaz ("es" o "en").
    static var lang: String { Bundle.main.preferredLocalizations.first?.hasPrefix("es") == true ? "es" : "en" }
    static var locale: Locale { Locale(identifier: lang == "es" ? "es-CO" : "en-US") }

    /// Mensaje legible a partir del código de error del API.
    static func errorText(_ error: Error) -> String {
        guard let e = error as? ApiRequestError else { return L("common.error") }
        if e.isNetwork { return L("err.network") }
        if e.code == "bad_request", !e.paths.isEmpty {
            return L("err.bad_request") + ": " + Array(Set(e.paths)).sorted().joined(separator: ", ")
        }
        return codeText(e.code, message: e.message)
    }

    /// Texto por código de error (err.<código> de la web). El servidor responde en español:
    /// en español se usa su texto, que es más preciso; en inglés, la traducción del código.
    static func codeText(_ code: String, message: String?) -> String {
        let key = "err.\(code)"
        if L(key) != key {
            if lang == "es", let message, !message.isEmpty { return message }
            return L(key)
        }
        if let message, !message.isEmpty { return message }
        return L("common.error")
    }

    /// Los mensajes de sistema llegan como {"k": clave, ...datos}; los antiguos, como texto plano.
    static func systemText(_ body: String) -> String {
        guard body.hasPrefix("{") else { return body }
        var obj: [String: Any]
        if let data = body.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            obj = o
        } else if let o = lenientSystemObject(body) {
            // La vista previa del API viene cortada a 140 caracteres: JSON incompleto.
            obj = o
        } else { return body }
        guard let k = obj["k"] as? String else { return body }
        var key = (k == "members.added" && (obj["history"] as? String) == "all") ? "sys.members.added.all" : "sys.\(k)"
        if k == "side.started", let p = obj["parentName"] as? String, !p.isEmpty { key = "sys.side.startedIn" }
        let s = L(key)
        if s == key { return body }
        var vars: [String: CustomStringConvertible] = [:]
        for (name, value) in obj {
            if let v = value as? String { vars[name] = v }
            else if let v = value as? NSNumber { vars[name] = v.stringValue }
            else if let arr = value as? [String] { vars[name] = arr.joined(separator: ", ") }
        }
        // El API envía startsAt; la plantilla usa una fecha localizada para {when}.
        if let startsAt = obj["startsAt"] as? String, let date = ISODate.parse(startsAt) {
            vars["when"] = dateTime(date)
        }
        var out = s
        for (k, v) in vars { out = out.replacingOccurrences(of: "{\(k)}", with: v.description) }
        // Variables que no llegaron (vista previa cortada): se quitan sin dejar llaves.
        out = out.replacingOccurrences(of: "\\s*\\{\\w+\\}", with: " …", options: .regularExpression)
        return out
    }

    /// Pares "clave":"texto" completos de un JSON cortado (el resto se ignora).
    static func lenientSystemObject(_ body: String) -> [String: Any]? {
        guard let re = try? NSRegularExpression(pattern: #""(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)""#) else { return nil }
        let ns = body as NSString
        var out: [String: Any] = [:]
        for m in re.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            let raw = ns.substring(with: m.range(at: 2))
            let value = (try? JSONSerialization.jsonObject(with: Data("\"\(raw)\"".utf8), options: .fragmentsAllowed)) as? String ?? raw
            out[ns.substring(with: m.range(at: 1))] = value
        }
        return out["k"] == nil ? nil : out
    }

    static func preview(_ body: String?) -> String? { body.map(systemText) }

    // MARK: Fechas

    static func timeLabel(_ iso: String?, now: Date = Date()) -> String {
        guard let d = ISODate.parse(iso) else { return "" }
        let cal = Calendar.current
        if cal.isDate(d, inSameDayAs: now) {
            return d.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
        }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(d, inSameDayAs: y) { return L("day.yesterday") }
        return d.formatted(Date.FormatStyle().day().month(.abbreviated).locale(locale))
    }

    static func clock(_ iso: String) -> String {
        guard let d = ISODate.parse(iso) else { return "" }
        return d.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
    }

    static func dayLabel(_ d: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        if cal.isDate(d, inSameDayAs: now) { return L("day.today") }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(d, inSameDayAs: y) { return L("day.yesterday") }
        return d.formatted(Date.FormatStyle().weekday(.wide).day().month(.wide).locale(locale))
    }

    /// «Jueves, 25 de septiembre · 10:00–11:00» (como fmtWhen de la web).
    static func eventWhen(_ ev: CalendarEventDTO) -> String {
        let day = ev.start.formatted(Date.FormatStyle().weekday(.wide).day().month(.wide).locale(locale))
        let t = Date.FormatStyle(date: .omitted, time: .shortened).locale(locale)
        return "\(day.prefix(1).uppercased())\(day.dropFirst()) · \(ev.start.formatted(t))–\(ev.end.formatted(t))"
    }

    static func dateTime(_ d: Date) -> String {
        d.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).hour().minute().locale(locale))
    }

    static func shortDate(_ iso: String?) -> String {
        guard let d = ISODate.parse(iso) else { return "" }
        return d.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted).locale(locale))
    }
}
