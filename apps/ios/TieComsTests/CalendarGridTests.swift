import XCTest
@testable import TieComs

/// 1.6.6 · Calendario Día / Semana / Mes: cuadrícula 6×7 desde el lunes, meses de 28 a 31 días, cambio de horario.
final class CalendarGridTests: XCTestCase {
    private func cal(_ tz: String = "America/Bogota") -> Calendar { CalendarGrid.calendar(TimeZone(identifier: tz)!, locale: Locale(identifier: "es_CO")) }
    private func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12, _ c: Calendar) -> Date { c.date(from: DateComponents(year: y, month: m, day: d, hour: h))! }
    private func ymd(_ d: Date, _ c: Calendar) -> String { let x = c.dateComponents([.year, .month, .day], from: d); return "\(x.year!)-\(x.month!)-\(x.day!)" }

    func testMonthGridsFor28To31DayMonthsStartOnMonday() {
        let c = cal()
        // (año, mes, días, primer día de la cuadrícula): feb-2027 empieza en lunes (28 días), feb-2028 bisiesto,
        // abril 30, agosto-2026 empieza en sábado (31 días: necesita las 6 filas).
        let cases: [(Int, Int, Int, String)] = [(2027, 2, 28, "2027-2-1"), (2028, 2, 29, "2028-1-31"), (2026, 4, 30, "2026-3-30"),
                                                  (2026, 8, 31, "2026-7-27"), (2026, 9, 30, "2026-8-31"), (2026, 3, 31, "2026-2-23")]
        for (y, m, n, first) in cases {
            let g = CalendarGrid.monthGrid(date(y, m, 15, 12, c), c)
            XCTAssertEqual(g.count, 42, "6×7")
            XCTAssertEqual(ymd(g[0], c), first, "\(y)-\(m)")
            XCTAssertEqual(c.component(.weekday, from: g[0]), 2, "empieza en lunes")
            XCTAssertEqual(CalendarGrid.daysInMonth(date(y, m, 1, 12, c), c), n)
            XCTAssertEqual(g.filter { c.component(.month, from: $0) == m }.count, n, "todos los días del mes están")
            XCTAssertEqual(Set(g.map { ymd($0, c) }).count, 42, "sin días repetidos")
        }
    }

    func testDaylightSavingChangeKeepsOneCellPerDay() {
        for tz in ["Europe/Madrid", "America/Santiago", "America/New_York"] {
            let c = cal(tz)
            for m in 1...12 {
                let g = CalendarGrid.monthGrid(date(2026, m, 10, 12, c), c)
                XCTAssertEqual(Set(g.map { ymd($0, c) }).count, 42, "\(tz) \(m)")
                // El inicio de cada día local (en Santiago el cambio es a medianoche: ese día empieza a la 1:00).
                XCTAssertTrue(g.allSatisfy { c.startOfDay(for: $0) == $0 }, "inicio del día local aun con cambio de horario (\(tz) \(m))")
            }
        }
        let c = cal("Europe/Madrid")
        let r = CalendarGrid.range(.day, date(2026, 3, 29, 12, c), c)  // día de 23 horas
        XCTAssertEqual(r.duration, 23 * 3600)
    }

    func testRangesAndNavigation() {
        let c = cal()
        let wed = date(2026, 9, 30, 15, c)
        XCTAssertEqual(ymd(CalendarGrid.range(.week, wed, c).start, c), "2026-9-28")
        XCTAssertEqual(ymd(CalendarGrid.range(.week, wed, c).end, c), "2026-10-5")
        XCTAssertEqual(ymd(CalendarGrid.range(.month, wed, c).start, c), "2026-8-31")
        XCTAssertEqual(ymd(CalendarGrid.range(.month, wed, c).end, c), "2026-10-12")
        XCTAssertEqual(ymd(CalendarGrid.shift(.month, date(2027, 1, 31, 12, c), by: 1, c), c), "2027-2-1", "‹ › de mes va al 1")
        XCTAssertEqual(ymd(CalendarGrid.shift(.week, wed, by: -1, c), c), "2026-9-23")
        XCTAssertEqual(ymd(CalendarGrid.shift(.day, date(2026, 12, 31, 12, c), by: 1, c), c), "2027-1-1")
        XCTAssertEqual(c.component(.hour, from: CalendarGrid.slot(wed, hour: 16, c)), 16)
        XCTAssertEqual(c.component(.hour, from: CalendarGrid.slot(wed, hour: nil, c)), 10)
    }

    func testModeDefaultsToWeekAndIsRemembered() {
        let d = UserDefaults(suiteName: "cal-\(UUID().uuidString)")!
        XCTAssertEqual(CalendarMode.load(d), .week, "Semana por defecto")
        CalendarMode.save(.month, d)
        XCTAssertEqual(CalendarMode.load(d), .month)
        d.set("zzz", forKey: CalendarMode.key)
        XCTAssertEqual(CalendarMode.load(d), .week)
    }

    private func ev(_ id: String, _ s: Date, _ minutes: Int, location: String? = nil, cancelled: Bool = false) throws -> CalendarEventDTO {
        let loc = location.map { "\"\($0)\"" } ?? "null"
        return try JSONDecoder().decode(CalendarEventDTO.self, from: Data(#"{"id":"\#(id)","conversationId":"c","title":"E \#(id)","startsAt":"\#(ISODate.string(s))","endsAt":"\#(ISODate.string(s.addingTimeInterval(TimeInterval(minutes * 60))))","location":\#(loc)\#(cancelled ? #","cancelledAt":"2026-01-01T00:00:00Z""# : "")}"#.utf8))
    }

    func testEventsPerDayCellMoreAndVideoMark() throws {
        let c = cal()
        let day = date(2026, 9, 30, 0, c)
        let list = try [ev("a", date(2026, 9, 30, 9, c), 45), ev("b", date(2026, 9, 30, 11, c), 45), ev("x", date(2026, 9, 30, 12, c), 30, cancelled: true),
                        ev("c", date(2026, 9, 30, 13, c), 45, location: "https://meet.google.com/abc-defg-hij"), ev("d", date(2026, 9, 30, 23, c), 120),
                        ev("e", date(2026, 10, 1, 9, c), 30)]
        let on = CalendarGrid.events(list, on: day, c)
        XCTAssertEqual(on.map(\.id), ["a", "b", "c", "d"], "sin cancelados ni otros días, por hora")
        XCTAssertEqual(CalendarGrid.events(list, on: date(2026, 10, 1, 0, c), c).map(\.id), ["d", "e"], "el que cruza la medianoche también sale al día siguiente")
        let cell = CalendarGrid.cell(on)
        XCTAssertEqual(cell.shown.map(\.id), ["a", "b"]); XCTAssertEqual(cell.more, 2, "«+2 más»")
        XCTAssertTrue(CalendarGrid.isVideoLink("https://meet.google.com/abc-defg-hij"))
        XCTAssertTrue(CalendarGrid.isVideoLink("https://teams.microsoft.com/l/meetup-join/x"))
        XCTAssertTrue(CalendarGrid.isVideoLink("https://us02web.zoom.us/j/123"))
        XCTAssertFalse(CalendarGrid.isVideoLink("Oficina 301"))
        XCTAssertFalse(CalendarGrid.isVideoLink("https://meet.google.com.evil.example/x"))
        XCTAssertFalse(CalendarGrid.isVideoLink("http://zoom.us/j/1"))
    }

    func testWeekdayHeadersStartOnMonday() {
        XCTAssertEqual(AgendaScreen.weekdaySymbols(cal()), ["L", "M", "X", "J", "V", "S", "D"])
        let en = CalendarGrid.calendar(TimeZone(identifier: "UTC")!, locale: Locale(identifier: "en_US"))
        XCTAssertEqual(AgendaScreen.weekdaySymbols(en), ["M", "T", "W", "T", "F", "S", "S"])
    }

    // MARK: Agenda: un color por grupo, día completo y grupos ocultos (docs/AGENDA-COLORES.md)

    private func gev(_ id: String, conv: String, _ s: Date, _ e: Date) throws -> CalendarEventDTO {
        try JSONDecoder().decode(CalendarEventDTO.self, from: Data(#"{"id":"\#(id)","conversationId":"\#(conv)","title":"E \#(id)","startsAt":"\#(ISODate.string(s))","endsAt":"\#(ISODate.string(e))"}"#.utf8))
    }

    func testGroupColorIndexMatchesWebSpec() {
        // Los dos casos de la tabla de la spec (mismos que groupColorIndex de client-core).
        XCTAssertEqual(GroupColor.index("3a916cc9-0411-4068-be9d-f22075045494"), 1)
        XCTAssertEqual(GroupColor.index("e1c94905-862f-4e70-9653-5d0e195910e9"), 4)
        XCTAssertEqual(GroupColor.pair("3a916cc9-0411-4068-be9d-f22075045494"), GroupColor.Pair(bg: 0xD7F0E2, fg: 0x17603D), "verde")
        XCTAssertEqual(GroupColor.pair("e1c94905-862f-4e70-9653-5d0e195910e9"), GroupColor.Pair(bg: 0xFBDDEB, fg: 0x962868), "rosado")
        XCTAssertEqual(GroupColor.palette.count, 10)
        XCTAssertEqual(GroupColor.index(""), 0)
        // Desborde de uint32 (ids largos) y unidades UTF-16 fuera del ASCII: sin fallar y siempre en 0…9.
        XCTAssertTrue((0..<10).contains(GroupColor.index(String(repeating: "zz-éñ😀", count: 200))))
        // "a" = 97 → 7; "ab" = 97*31 + 98 = 3105 → 5.
        XCTAssertEqual(GroupColor.index("a"), 7)
        XCTAssertEqual(GroupColor.index("ab"), 5)
    }

    func testAllDayRule() throws {
        let c = cal()
        let d0 = date(2026, 9, 30, 0, c)
        let next = date(2026, 10, 1, 0, c)
        let at2359 = c.date(bySettingHour: 23, minute: 59, second: 0, of: d0)!
        XCTAssertTrue(CalendarGrid.isAllDay(start: d0, end: at2359, c), "00:00 → 23:59")
        XCTAssertTrue(CalendarGrid.isAllDay(start: d0, end: next, c), "00:00 → 00:00 del día siguiente")
        XCTAssertTrue(CalendarGrid.isAllDay(start: d0, end: date(2026, 10, 2, 0, c), c), "varios días")
        XCTAssertFalse(CalendarGrid.isAllDay(start: d0, end: date(2026, 9, 30, 12, c), c), "medio día")
        XCTAssertFalse(CalendarGrid.isAllDay(start: date(2026, 9, 30, 1, c), end: next, c), "no empieza a las 00:00")
        XCTAssertFalse(CalendarGrid.isAllDay(start: d0, end: d0, c), "dura cero")
        XCTAssertFalse(CalendarGrid.isAllDay(start: d0, end: date(2026, 10, 1, 12, c), c), "termina a mediodía")
        // En la hora de quien mira: medianoche de Bogotá no es día completo visto desde Madrid.
        let madrid = cal("Europe/Madrid")
        XCTAssertFalse(CalendarGrid.isAllDay(start: d0, end: next, madrid))

        // Orden: los de día completo antes que los de hora, en el día y en listas.
        let list = try [gev("t8", conv: "g", date(2026, 9, 30, 8, c), date(2026, 9, 30, 9, c)),
                        gev("all", conv: "g", d0, at2359),
                        gev("t0", conv: "g", d0, date(2026, 9, 30, 1, c))]
        XCTAssertEqual(CalendarGrid.events(list, on: d0, c).map(\.id), ["all", "t0", "t8"])
        XCTAssertEqual(CalendarGrid.sorted(list, c).map(\.id), ["all", "t0", "t8"])
    }

    func testHiddenGroupsFilterLegendAndPersistence() throws {
        let c = cal()
        let a = "3a916cc9-0411-4068-be9d-f22075045494", b = "e1c94905-862f-4e70-9653-5d0e195910e9"
        let list = try [gev("1", conv: a, date(2026, 9, 30, 8, c), date(2026, 9, 30, 9, c)),
                        gev("2", conv: b, date(2026, 9, 30, 10, c), date(2026, 9, 30, 11, c)),
                        gev("3", conv: a, date(2026, 9, 30, 12, c), date(2026, 9, 30, 13, c))]
        XCTAssertEqual(AgendaHidden.legendIds(list), [a, b], "un grupo por color, en orden de aparición")
        XCTAssertEqual(AgendaHidden.visible(list, hidden: []).map(\.id), ["1", "2", "3"])
        var hidden = AgendaHidden.toggle(a, in: [])
        XCTAssertEqual(hidden, [a])
        XCTAssertEqual(AgendaHidden.visible(list, hidden: hidden).map(\.id), ["2"], "ocultar un grupo quita sus eventos")
        XCTAssertEqual(AgendaHidden.legendIds(list), [a, b], "el oculto sigue en la leyenda para volver a mostrarlo")
        hidden = AgendaHidden.toggle(b, in: hidden)
        XCTAssertTrue(AgendaHidden.visible(list, hidden: hidden).isEmpty)
        hidden = AgendaHidden.toggle(a, in: hidden)
        XCTAssertEqual(hidden, [b], "tocar otra vez lo muestra")

        let d = UserDefaults(suiteName: "agenda-\(UUID().uuidString)")!
        XCTAssertEqual(AgendaHidden.load(d), [])
        AgendaHidden.save(hidden, d)
        XCTAssertEqual(AgendaHidden.load(d), [b], "se recuerda en UserDefaults")
        AgendaHidden.save([], d)
        XCTAssertEqual(AgendaHidden.load(d), [], "«Mostrar todos» limpia los ocultos")
    }
}
