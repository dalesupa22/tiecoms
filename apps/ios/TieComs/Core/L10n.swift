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
        let key = "err.\(e.code)"
        let known = ["unauthorized", "conflict", "forbidden", "not_found", "rate_limited", "bad_request", "internal"]
        if known.contains(e.code) {
            // El servidor responde en español; en español se usa su texto, que es más preciso.
            return lang == "es" && !e.message.isEmpty ? e.message : L(key)
        }
        return e.message.isEmpty ? L("common.error") : e.message
    }

    /// Los mensajes de sistema llegan como {"k": clave, ...datos}; los antiguos, como texto plano.
    static func systemText(_ body: String) -> String {
        guard body.hasPrefix("{"), let data = body.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let k = obj["k"] as? String else { return body }
        let key = (k == "members.added" && (obj["history"] as? String) == "all") ? "sys.members.added.all" : "sys.\(k)"
        let s = L(key)
        if s == key { return body }
        var vars: [String: CustomStringConvertible] = [:]
        for (name, value) in obj {
            if let v = value as? String { vars[name] = v }
            else if let v = value as? NSNumber { vars[name] = v.stringValue }
            else if let arr = value as? [String] { vars[name] = arr.joined(separator: ", ") }
        }
        var out = s
        for (k, v) in vars { out = out.replacingOccurrences(of: "{\(k)}", with: v.description) }
        return out
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

    static func shortDate(_ iso: String?) -> String {
        guard let d = ISODate.parse(iso) else { return "" }
        return d.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted).locale(locale))
    }
}
