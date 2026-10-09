import Foundation

/// Mensajes programados (docs/PROGRAMADOS.md): lógica de fechas y store. Los DTO van en ModelsV2.swift (los usa la
/// extensión Compartir a través de AccountEvent).
/// Opciones de un toque y textos de «cuándo».
enum Schedule {
    struct Option: Equatable { var key: String; var at: Date }

    private static func at(_ now: Date, days: Int, hour: Int, minute: Int = 0, _ cal: Calendar) -> Date {
        let day = cal.date(byAdding: .day, value: days, to: now) ?? now
        return cal.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    /// «En 1 hora» (redondeado a 5 min), «Esta tarde» 18:00 (solo antes de las 16:00), «Mañana temprano» 8:00 y
    /// «El lunes temprano» 8:00 (si mañana no es lunes).
    static func options(now: Date = Date(), calendar: Calendar = .current) -> [Option] {
        let step: TimeInterval = 5 * 60
        let inHour = Date(timeIntervalSince1970: (ceil((now.timeIntervalSince1970 + 3600) / step) * step))
        var out = [Option(key: "sched.inHour", at: inHour)]
        if calendar.component(.hour, from: now) < 16 { out.append(Option(key: "sched.thisAfternoon", at: at(now, days: 0, hour: 18, calendar))) }
        out.append(Option(key: "sched.tomorrowMorning", at: at(now, days: 1, hour: 8, calendar)))
        let dow = calendar.component(.weekday, from: now) - 1 // 0 = domingo
        let toMonday = (1 - dow + 7) % 7 == 0 ? 7 : (1 - dow + 7) % 7
        if toMonday > 1 { out.append(Option(key: "sched.monday", at: at(now, days: toMonday, hour: 8, calendar))) }
        return out
    }

    /// Mínimo para «Elegir fecha y hora…» (el API acepta desde +30 s).
    static func isValidPick(_ d: Date, now: Date = Date()) -> Bool { d.timeIntervalSince(now) > 60 }

    static func time(_ d: Date, calendar: Calendar = .current) -> String {
        var f = Date.FormatStyle().hour(.defaultDigits(amPM: .abbreviated)).minute(.twoDigits).locale(L10n.locale)
        f.timeZone = calendar.timeZone
        return d.formatted(f)
    }

    /// «hoy a las 6:00 p. m.», «mañana a las 8:00 a. m.», «el lun, 5 oct a las 8:00 a. m.».
    static func whenLabel(_ d: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let t = time(d, calendar: calendar)
        let diff = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: d)).day ?? 99
        if diff == 0 { return L("sched.todayAt", ["time": t]) }
        if diff == 1 { return L("sched.tomorrowAt", ["time": t]) }
        var f = Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).locale(L10n.locale)
        f.timeZone = calendar.timeZone
        return L("sched.dayAt", ["day": d.formatted(f), "time": t])
    }

    static func whenLabel(_ iso: String) -> String { ISODate.parse(iso).map { whenLabel($0) } ?? iso }

    /// Franja sobre el compositor: «🕒 2 mensajes programados · el próximo sale mañana a las 8:00 a. m.».
    static func stripText(_ list: [ScheduledMessageDTO]) -> String {
        let failed = list.filter(\.failed).count
        if failed > 0 { return "⚠ " + L("sched.failedCount", ["n": failed]) }
        let head = "🕒 " + (list.count == 1 ? L("sched.oneHere") : L("sched.manyHere", ["n": list.count]))
        guard let next = list.filter({ !$0.failed }).min(by: { $0.sendAt < $1.sendAt }) else { return head }
        return head + " · " + L("sched.next", ["when": whenLabel(next.sendAt)])
    }
}

extension AppStore {
    /// Lo que devuelve el API (o el evento `scheduled.updated`): entra, cambia o sale de la lista.
    func putScheduled(_ x: ScheduledMessageDTO) {
        var rest = scheduled.filter { $0.id != x.id }
        if x.isListed { rest.append(x) }
        scheduled = rest.sorted { $0.sendAt < $1.sendAt }
    }

    @discardableResult
    func loadScheduled() async -> [ScheduledMessageDTO] {
        do {
            let r: ScheduledList = try await api.request("/scheduled")
            scheduled = r.scheduled.filter(\.isListed).sorted { $0.sendAt < $1.sendAt }
        } catch {} // servidor viejo sin /scheduled
        return scheduled
    }

    @discardableResult
    func scheduleMessage(_ conversationId: String, body: String, sendAt: Date, mentions: [Mention] = [], replyTo: String? = nil) async throws -> ScheduledMessageDTO {
        var json: [String: Any] = ["body": body, "sendAt": ISODate.string(sendAt)]
        if !mentions.isEmpty { json["mentions"] = mentions.map { ["userId": $0.userId, "start": $0.start, "length": $0.length] } }
        if let replyTo { json["replyTo"] = replyTo }
        let x: ScheduledMessageDTO = try await api.request("/conversations/\(conversationId)/scheduled", method: "POST", json: json)
        putScheduled(x)
        return x
    }

    func updateScheduled(_ id: String, body: String? = nil, sendAt: Date? = nil) async throws {
        var json: [String: Any] = [:]
        if let body { json["body"] = body }
        if let sendAt { json["sendAt"] = ISODate.string(sendAt) }
        let x: ScheduledMessageDTO = try await api.request("/scheduled/\(id)", method: "PATCH", json: json)
        putScheduled(x)
    }

    func cancelScheduled(_ id: String) async throws {
        let x: ScheduledMessageDTO = try await api.request("/scheduled/\(id)", method: "DELETE")
        putScheduled(x)
    }

    func sendScheduledNow(_ id: String) async throws {
        let x: ScheduledMessageDTO = try await api.request("/scheduled/\(id)/send", method: "POST", json: [:])
        putScheduled(x)
    }

    func scheduled(in conversationId: String) -> [ScheduledMessageDTO] { scheduled.filter { $0.conversationId == conversationId } }

    /// Programa desde el compositor con «Deshacer» (cancela y devuelve el texto). Devuelve false si falló.
    func scheduleFromComposer(_ conversationId: String, body: String, at: Date, mentions: [Mention], replyTo: String?,
                              restore: @escaping (String, [Mention]) -> Void) async -> Bool {
        do {
            let x = try await scheduleMessage(conversationId, body: body, sendAt: at, mentions: mentions, replyTo: replyTo)
            Haptics.tap()
            show("🕒 " + L("sched.done", ["when": Schedule.whenLabel(x.sendAt)])) { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    do { try await self.cancelScheduled(x.id); restore(body, mentions) } catch { self.show(L10n.errorText(error)) }
                }
            }
            return true
        } catch {
            show(L10n.errorText(error))
            return false
        }
    }
}
