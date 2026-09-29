import Foundation

/// Texto localizado (es/en: el que eligió la persona en Tú › Idioma, o el del sistema; en otro idioma, inglés).
/// Las variables van como `{nombre}` igual que en la web (apps/web/src/i18n.ts).
func L(_ key: String, _ vars: [String: CustomStringConvertible] = [:]) -> String {
    var s = L10n.bundle.localizedString(forKey: key, value: nil, table: nil)
    if s == key, let en = L10n.englishBundle { s = en.localizedString(forKey: key, value: key, table: nil) }
    for (k, v) in vars { s = s.replacingOccurrences(of: "{\(k)}", with: v.description) }
    return s
}

enum L10n {
    static let englishBundle: Bundle? = Bundle.main.path(forResource: "en", ofType: "lproj").flatMap(Bundle.init(path:))

    static let spanishBundle: Bundle? = Bundle.main.path(forResource: "es", ofType: "lproj").flatMap(Bundle.init(path:))

    /// Idioma elegido en la app: automático (el del sistema), español o inglés.
    enum Choice: String, CaseIterable, Identifiable { case system, es, en; var id: String { rawValue } }

    /// Se guarda en el grupo compartido: la extensión Compartir usa el mismo idioma.
    static let choiceKey = "tc.lang"
    static var defaults: UserDefaults { UserDefaults(suiteName: "group.com.chaggu.app") ?? .standard }

    static var choice: Choice {
        get { Choice(rawValue: defaults.string(forKey: choiceKey) ?? "") ?? .system }
        set {
            defaults.set(newValue == .system ? nil : newValue.rawValue, forKey: choiceKey)
            // Los textos del sistema (permisos, «Copiar»…) siguen AppleLanguages desde el próximo arranque.
            if newValue == .system { UserDefaults.standard.removeObject(forKey: "AppleLanguages") }
            else { UserDefaults.standard.set([newValue == .es ? "es" : "en"], forKey: "AppleLanguages") }
        }
    }

    /// Idioma del sistema para esta app ("es" o "en"), sin la elección propia.
    static var systemLang: String {
        let preferred = Bundle.preferredLocalizations(from: ["es", "en"], forPreferences: Locale.preferredLanguages).first
        return preferred?.hasPrefix("es") == true ? "es" : "en"
    }

    /// Idioma efectivo de la interfaz ("es" o "en").
    static var lang: String { resolve(choice, system: systemLang) }
    static func resolve(_ c: Choice, system: String) -> String {
        switch c {
        case .system: return system
        case .es: return "es"
        case .en: return "en"
        }
    }

    /// Tabla de textos del idioma efectivo (cambia al instante, sin reiniciar).
    static var bundle: Bundle { (lang == "es" ? spanishBundle : englishBundle) ?? .main }
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
        var s = L(key)
        // Un aviso que esta versión no conoce nunca se muestra como JSON crudo (docs/CORREO.md: «mostrar el texto de sys.* o ignorarlos»).
        if s == key {
            if k.hasPrefix("mail.") { s = L("mail.fromChat") }
            else if k.hasPrefix("wa.") { s = L("wa.fromChat") }
            else { s = L("sys.unknown") }
            if s == "sys.unknown" { return "…" }
        }
        var vars: [String: CustomStringConvertible] = [:]
        for (name, value) in obj {
            if let v = value as? String { vars[name] = v }
            else if let v = value as? NSNumber { vars[name] = v.stringValue }
            else if let arr = value as? [String] { vars[name] = arr.joined(separator: ", ") }
        }
        // El API envía startsAt; la plantilla usa una fecha localizada para {when}.
        if let startsAt = obj["startsAt"] as? String, let date = ISODate.parse(startsAt) {
            // «Es hoy» (tanda 1.7): solo la hora.
            vars["when"] = k == "event.today" ? date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale)) : dateTime(date)
        }
        // Tarea vencida: «venció el vie, 3 oct».
        if let due = obj["dueDate"] as? String {
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
            vars["due"] = f.date(from: String(due.prefix(10))).map { $0.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(locale)) } ?? due
        }
        // Llamadas: «Terminó la llamada · m:ss» (el API manda durationSec).
        if let secs = (obj["durationSec"] as? NSNumber)?.intValue ?? (obj["durationSec"] as? String).flatMap(Int.init) {
            vars["duration"] = clockDuration(secs)
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
        // Números completos ("durationSec":83), p. ej. el fin de una llamada.
        if let num = try? NSRegularExpression(pattern: #""(\w+)"\s*:\s*(-?\d+)(?=[,}])"#) {
            for m in num.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
                let key = ns.substring(with: m.range(at: 1))
                if out[key] == nil, let n = Int(ns.substring(with: m.range(at: 2))) { out[key] = NSNumber(value: n) }
            }
        }
        return out["k"] == nil ? nil : out
    }

    /// m:ss a partir de segundos (duración de una llamada, como la web).
    static func clockDuration(_ seconds: Int) -> String {
        let s = max(0, seconds)
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    static func preview(_ body: String?) -> String? { body.map(systemText) }

    /// Vista previa de lista: prefiere el último mensaje de una persona si el último fue de sistema (lastHumanPreview).
    static func listPreview(_ c: ConversationDTO) -> String? {
        if let h = c.lastHumanPreview, h.viewOnce {
            if let a = h.attachments, a.voices > 0 { return L("vo.voice") }
            if let a = h.attachments, a.images > 0 { return L("vo.photo") }
            return L("vo.message")
        }
        if let h = c.lastHumanPreview {
            let text = h.body.trimmingCharacters(in: .whitespacesAndNewlines)
            let att = h.attachments.flatMap { countsLabel($0) }
            let out = [att, text.isEmpty ? nil : text].compactMap { $0 }.joined(separator: " · ")
            if !out.isEmpty { return out }
        }
        return preview(c.lastMessagePreview)
    }

    /// Igual que attachmentSummaryText de la web.
    static func countsLabel(_ a: HumanPreview.Counts) -> String? {
        guard a.count > 0 else { return nil }
        if a.voices > 0 && a.voices == a.count { return voiceLabel(a.voiceDurationMs) }
        if a.images + a.videos == a.count && a.images > 0 && a.videos > 0 { return L("att.media", ["n": a.count]) }
        if a.images == a.count { return a.count == 1 ? L("att.photo") : L("att.photos", ["n": a.count]) }
        if a.videos == a.count { return a.count == 1 ? L("att.video") : L("att.videos", ["n": a.count]) }
        if a.count == 1, let n = a.firstName { return L("att.file", ["name": n]) }
        return L("att.files", ["n": a.count])
    }

    /// «📷 Foto», «📷 3 fotos», «🎬 Video», «📎 nombre» (+ el texto si lo hay), como la web y el push.
    static func attachmentsLabel(_ list: [AttachmentDTO]) -> String? {
        guard !list.isEmpty else { return nil }
        let voices = list.filter(\.isVoice)
        if voices.count == list.count { return voiceLabel(voices.count == 1 ? voices[0].durationMs : voices.compactMap(\.durationMs).reduce(0, +)) }
        let images = list.filter(\.isImage).count, videos = list.filter(\.isVideo).count
        if images > 0 && videos > 0 && images + videos == list.count { return L("att.media", ["n": list.count]) }
        if images == list.count { return images == 1 ? L("att.photo") : L("att.photos", ["n": images]) }
        if videos == list.count { return videos == 1 ? L("att.video") : L("att.videos", ["n": videos]) }
        if list.count == 1 { return L("att.file", ["name": list[0].name]) }
        return L("att.files", ["n": list.count])
    }

    /// «🎤 Nota de voz (0:42)».
    static func voiceLabel(_ ms: Int?) -> String {
        guard let ms, ms > 0 else { return L("voice.previewShort") }
        return L("voice.preview", ["d": duration(ms)])
    }

    /// m:ss (como voiceDuration de la web).
    static func duration(_ ms: Int) -> String {
        let s = max(0, Int((Double(ms) / 1000).rounded()))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    static func messagePreview(_ m: MessageDTO) -> String {
        // Una sola vista: nunca el contenido (tanda 1.7 §7).
        if m.viewOnce {
            if m.attachments.contains(where: \.isVoice) { return L("vo.voice") }
            if m.attachments.contains(where: \.isImage) { return L("vo.photo") }
            return L("vo.message")
        }
        guard let att = attachmentsLabel(m.attachments) else { return m.body }
        let text = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? att : "\(att) · \(text)"
    }

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
