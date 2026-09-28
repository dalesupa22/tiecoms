import Foundation

/// Opciones de «No molestar» (SPEC-silencio §3): 1 hora · 8 horas · Hasta mañana (8:00 hora local) · Hasta que lo reactive.
enum DndOption: CaseIterable {
    case hour, eightHours, tomorrow, forever
    var labelKey: String {
        switch self {
        case .hour: return "mute.1h"
        case .eightHours: return "mute.8h"
        case .tomorrow: return "dnd.tomorrow"
        case .forever: return "mute.forever"
        }
    }
    var id: String { ["hour", "8h", "tomorrow", "forever"][DndOption.allCases.firstIndex(of: self)!] }
}

/// Silencio de un chat y «No molestar»: fechas, textos «Silenciado hasta…» y reglas de avisos locales.
enum Silence {
    /// «Hasta que lo reactive»: el API lo guarda como esta fecha (igual en web, iOS y Android).
    static let foreverISO = "9999-12-31T00:00:00Z"
    static var forever: Date { ISODate.parse(foreverISO)! }

    /// Más de 366 días = «hasta que lo reactive» (el mismo umbral que usa el servidor para las menciones).
    static func isForever(_ until: Date, now: Date = Date()) -> Bool { until > now.addingTimeInterval(366 * 86400) }

    static func isActive(_ until: Date?, now: Date = Date()) -> Bool { (until ?? .distantPast) > now }

    /// Hasta cuándo dura «No molestar» con cada opción. «Hasta mañana» = mañana a las 8:00 (hora local).
    static func dndUntil(_ option: DndOption, now: Date = Date(), calendar: Calendar = .current) -> Date {
        switch option {
        case .hour: return now.addingTimeInterval(3600)
        case .eightHours: return now.addingTimeInterval(8 * 3600)
        case .tomorrow:
            let next = calendar.date(byAdding: .day, value: 1, to: now)!
            return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: next)!
        case .forever: return forever
        }
    }

    /// Cuerpo del PUT: la fecha ISO o, para «hasta que lo reactive», el valor fijo del contrato.
    static func wire(_ until: Date?) -> Any {
        guard let until else { return NSNull() }
        return isForever(until) ? foreverISO : ISODate.string(until)
    }

    /// Qué frase se arma: estado del chat, fila «No molestar» de Tú o la franja de arriba de las listas.
    enum Phrase: String {
        /// «Silenciado hasta las 18:00» / «Silenciado».
        case muted = "mute.state"
        /// «Activo hasta las 18:00» / «Activo».
        case dndStatus = "dnd.status"
        /// «No molestar hasta las 18:00» / «No molestar».
        case dndBanner = "dnd.banner"
    }

    /// Texto del tiempo restante: hoy «… hasta las 18:00», mañana «… hasta mañana a las 8:00», otro día
    /// «… hasta el lun 29 sep, 18:00» y sin fin (o más de un año) solo «Silenciado».
    static func text(_ phrase: Phrase, until: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = L10n.locale) -> String {
        let base = phrase.rawValue
        if isForever(until, now: now) { return L("\(base).forever") }
        var cal = calendar
        cal.locale = locale
        let time = until.formatted(Date.FormatStyle(date: .omitted, time: .shortened, calendar: cal, timeZone: cal.timeZone).locale(locale))
        if cal.isDate(until, inSameDayAs: now) { return L("\(base).today", ["time": time]) }
        if let t = cal.date(byAdding: .day, value: 1, to: now), cal.isDate(until, inSameDayAs: t) { return L("\(base).tomorrow", ["time": time]) }
        var style = Date.FormatStyle(calendar: cal, timeZone: cal.timeZone).weekday(.abbreviated).day().month(.abbreviated).hour().minute()
        style = style.locale(locale)
        return L("\(base).date", ["date": until.formatted(style)])
    }
}

/// Qué hace la app con un mensaje recibido en vivo (en primer plano). El servidor aplica lo mismo al push.
enum NotifyRule {
    enum Outcome: Equatable {
        /// Nada: ni sonido ni aviso (sigue contando como no leído).
        case none
        /// Sonido corto: es el chat que estoy viendo.
        case sound
        /// Notificación local normal.
        case notify
        /// Notificación «Te mencionó».
        case mention
    }

    struct Input: Equatable {
        var mine = false
        var system = false
        var blocked = false
        /// Es el chat abierto y la app está activa.
        var openAndActive = false
        var muted = false
        var mutedForever = false
        var mentionsMe = false
        /// «No molestar» activo.
        var dnd = false
    }

    /// Silenciado = sin sonido ni aviso, salvo que me mencionen (no con el silencio «hasta que lo reactive»).
    /// «No molestar» apaga todo, también las menciones.
    static func incoming(_ i: Input) -> Outcome {
        if i.mine || i.system || i.blocked || i.dnd { return .none }
        let mentionPasses = i.mentionsMe && !i.mutedForever
        if i.openAndActive { return !i.muted || mentionPasses ? .sound : .none }
        if mentionPasses { return .mention }
        return i.muted ? .none : .notify
    }

    /// Recordatorios, avisos de reunión y reuniones nuevas: «No molestar» los apaga; el silencio del chat solo apaga
    /// las reuniones nuevas (el aviso de 10 min y los recordatorios son personales).
    static func accountAlert(dnd: Bool, muted: Bool = false, respectsMute: Bool = false) -> Bool {
        !dnd && !(respectsMute && muted)
    }

    /// Presentación en primer plano (willPresent): con «No molestar» nada se muestra.
    static func presentsInForeground(dnd: Bool) -> Bool { !dnd }
}
