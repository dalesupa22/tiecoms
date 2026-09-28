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
}
