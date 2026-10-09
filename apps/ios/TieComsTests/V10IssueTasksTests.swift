import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// 1.6.4 (20): asuntos como tareas (paridad con la web 8174998 y 861306c): completar con un toque y «Deshacer»,
/// fechas de un toque en hora local, orden por urgencia, filtros y secciones por grupo o por responsable.
@MainActor
final class V10IssueTasksTests: XCTestCase {
    private var savedLang: L10n.Choice = .system
    private var savedTZ = NSTimeZone.default

    override func setUp() {
        savedLang = L10n.choice; L10n.choice = .es
        savedTZ = NSTimeZone.default
        MockURLProtocol.routes = [:]
        MockURLProtocol.requests = []
    }

    override func tearDown() {
        L10n.choice = savedLang
        NSTimeZone.default = savedTZ
    }

    private func issueJSON(_ id: String, status: String = "open", due: String? = nil, owner: String? = nil, conv: String = "g1",
                           statusSince: String = "2026-09-27T10:00:00.000Z", createdAt: String = "2026-09-20T10:00:00.000Z", closedAt: String? = nil) -> String {
        let q = { (s: String?) in s.map { "\"\($0)\"" } ?? "null" }
        return #"{"id":"\#(id)","conversationId":"\#(conv)","workspaceId":"wHome","title":"Asunto \#(id)","status":"\#(status)","ownerId":\#(q(owner)),"dueDate":\#(q(due)),"statusSince":"\#(statusSince)","createdAt":"\#(createdAt)","updatedAt":"\#(statusSince)","closedAt":\#(q(closedAt)),"createdBy":"me","commentCount":0}"#
    }

    private func issue(_ id: String, status: String = "open", due: String? = nil, owner: String? = nil, conv: String = "g1",
                       statusSince: String = "2026-09-27T10:00:00.000Z", createdAt: String = "2026-09-20T10:00:00.000Z", closedAt: String? = nil) throws -> IssueDTO {
        try dec(IssueDTO.self, issueJSON(id, status: status, due: due, owner: owner, conv: conv, statusSince: statusSince, createdAt: createdAt, closedAt: closedAt))
    }

    private func store() -> AppStore {
        AppStore(baseURL: URL(string: "https://mock.chaggu.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()),
                 feedback: nil, session: MockURLProtocol.session())
    }

    // MARK: Completar con un toque

    func testToggledStatus() {
        XCTAssertEqual(IssueActions.toggled(.open), .done)
        XCTAssertEqual(IssueActions.toggled(.in_progress), .done)
        XCTAssertEqual(IssueActions.toggled(.waiting), .done)
        XCTAssertEqual(IssueActions.toggled(.done), .open, "lo hecho se reabre")
        XCTAssertEqual(IssueActions.toggled(.cancelled), .open, "lo descartado también se reabre")
    }

    func testToggleDoneCompletesWithUndo() async throws {
        let s = store()
        s.issues["i1"] = try issue("i1", status: "waiting")
        MockURLProtocol.routes = ["/api/v1/issues/i1": (200, issueJSON("i1", status: "done"))]
        IssueActions.toggleDone(s, s.issues["i1"]!)
        try await waitUntil(3, "optimista") { s.issues["i1"]?.status == .done }
        try await waitUntil(3, "aviso") { s.toast == "Tarea completada" }
        XCTAssertNotNil(s.toastUndo, "el aviso trae «Deshacer»")
        XCTAssertEqual(MockURLProtocol.requests.last?.body["status"] as? String, "done")
        // Deshacer vuelve al estado anterior (esperando), no a «abierto».
        MockURLProtocol.routes = ["/api/v1/issues/i1": (200, issueJSON("i1", status: "waiting"))]
        s.toastUndo?()
        try await waitUntil(3, "deshacer") { s.issues["i1"]?.status == .waiting }
        XCTAssertEqual(MockURLProtocol.requests.last?.body["status"] as? String, "waiting")
    }

    func testToggleDoneReopensClosed() async throws {
        let s = store()
        s.issues["i2"] = try issue("i2", status: "done", closedAt: "2026-09-27T11:00:00.000Z")
        MockURLProtocol.routes = ["/api/v1/issues/i2": (200, issueJSON("i2", status: "open"))]
        IssueActions.toggleDone(s, s.issues["i2"]!)
        try await waitUntil(3, "reabierto") { s.issues["i2"]?.status == .open && s.toast == "Tarea reabierta" }
        XCTAssertEqual(MockURLProtocol.requests.last?.body["status"] as? String, "open")
    }

    func testToggleDoneRevertsWhenTheAPIFails() async throws {
        let s = store()
        s.issues["i3"] = try issue("i3")
        MockURLProtocol.routes = [:] // 404
        IssueActions.toggleDone(s, s.issues["i3"]!)
        try await waitUntil(3, "error") { s.toast != nil && s.toast != "Tarea completada" }
        XCTAssertEqual(s.issues["i3"]?.status, .open, "si el API falla se revierte")
        XCTAssertNil(s.toastUndo, "un error no ofrece «Deshacer»")
    }

    /// 1.7.13: cambiar responsable y fecha desde la lista o el detalle: optimista y con vuelta atrás si el API falla.
    func testChangeOwnerAndDueOptimistic() async throws {
        let s = store()
        s.issues["i5"] = try issue("i5", owner: "me")
        MockURLProtocol.routes = ["/api/v1/issues/i5": (200, issueJSON("i5", due: "2026-10-09", owner: "bob"))]
        IssueActions.setAssignees(s, s.issues["i5"]!, ["bob"])
        XCTAssertEqual(s.issues["i5"]?.assignedIds, ["bob"], "al instante")
        try await waitUntil(3, "PATCH responsable") { (MockURLProtocol.requests.last?.body["assigneeIds"] as? [String]) == ["bob"] }
        IssueActions.setDue(s, s.issues["i5"]!, "2026-10-09")
        XCTAssertEqual(s.issues["i5"]?.dueDate, "2026-10-09")
        try await waitUntil(3, "PATCH fecha") { MockURLProtocol.requests.last?.body["dueDate"] as? String == "2026-10-09" }
        // Sin responsable: assigneeIds vacío y ownerId null.
        MockURLProtocol.routes = ["/api/v1/issues/i5": (200, issueJSON("i5", due: "2026-10-09"))]
        IssueActions.setAssignees(s, s.issues["i5"]!, [])
        XCTAssertTrue(s.issues["i5"]?.assignedIds.isEmpty == true)
        try await waitUntil(3, "PATCH sin responsable") { MockURLProtocol.requests.last?.body["ownerId"] is NSNull }
        // El API lo rechaza (p. ej. sin permiso): vuelve a como estaba y avisa.
        MockURLProtocol.routes = [:]
        try await waitUntil(3, "respuesta anterior aplicada") { s.issues["i5"]?.ownerId == nil }
        IssueActions.setDue(s, s.issues["i5"]!, nil)
        XCTAssertNil(s.issues["i5"]?.dueDate)
        try await waitUntil(3, "revertido") { s.issues["i5"]?.dueDate == "2026-10-09" && s.toast?.hasPrefix("No se guardó el cambio") == true }
    }

    func testIssueFieldsDecode() throws {
        let json = issueJSON("f1").replacingOccurrences(of: #""commentCount":0"#, with: #""commentCount":0,"fields":{"Prioridad":"Alta","Horas":3,"Facturable":true}"#)
        let i = try dec(IssueDTO.self, json)
        XCTAssertEqual(i.fields["Prioridad"], .text("Alta"))
        XCTAssertEqual(i.fields["Horas"], .number(3))
        XCTAssertEqual(i.fields["Facturable"], .bool(true))
        XCTAssertEqual(i.fields["Horas"]?.display, "3")
        XCTAssertTrue(try issue("f2").fields.isEmpty, "servidor anterior: sin campos")
    }

    /// 1.7.14: archivos de una tarea.
    func testTaskAttachmentRules() throws {
        let json = issueJSON("a1").replacingOccurrences(of: #""commentCount":0"#, with: #""commentCount":0,"attachments":[{"id":"x1","name":"plan.pdf","contentType":"application/pdf","sizeBytes":10,"url":"/api/v1/attachments/x1"},{"bad":true}]"#)
        let i = try dec(IssueDTO.self, json)
        XCTAssertEqual(i.attachments.map(\.id), ["x1"], "lee los adjuntos y salta los dañados")
        XCTAssertTrue(try issue("a2").attachments.isEmpty, "servidor anterior: sin archivos")
        XCTAssertEqual(TaskAttachmentRules.merged(i.attachments, adding: ["n1", "x1", "n2"]), ["x1", "n1", "n2"], "los de antes primero, sin repetir")
        let small = LocalAttachment(name: "a.txt", contentType: "text/plain", data: Data([1]))
        XCTAssertNil(TaskAttachmentRules.problem(existing: 19, adding: [small]))
        XCTAssertNotNil(TaskAttachmentRules.problem(existing: 20, adding: [small]), "máximo 20 por tarea")
        let big = LocalAttachment(name: "big.mov", contentType: "video/quicktime", data: Data(count: AttachmentRules.maxBytes + 1))
        XCTAssertEqual(TaskAttachmentRules.problem(existing: 0, adding: [big]), L("att.tooBig", ["name": "big.mov"]))
        XCTAssertEqual(TaskAttachmentRules.title(fromFileName: "Contrato_Nestlé 2026.pdf"), "Contrato Nestlé 2026")
        XCTAssertEqual(TaskAttachmentRules.title(fromFileName: ".pdf"), ".pdf")
    }

    func testDropHasUndoToPreviousStatus() async throws {
        let s = store()
        s.issues["i4"] = try issue("i4", status: "in_progress")
        MockURLProtocol.routes = ["/api/v1/issues/i4": (200, issueJSON("i4", status: "cancelled"))]
        IssueActions.drop(s, s.issues["i4"]!)
        try await waitUntil(3, "descartado") { s.issues["i4"]?.status == .cancelled && s.toast == "Tarea descartada" }
        MockURLProtocol.routes = ["/api/v1/issues/i4": (200, issueJSON("i4", status: "in_progress"))]
        s.toastUndo?()
        try await waitUntil(3, "deshacer") { s.issues["i4"]?.status == .in_progress }
    }

    // MARK: Fechas de un toque (hora local)

    private func bogota() -> Calendar {
        var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "America/Bogota")!; return c
    }

    private func at(_ iso: String) -> Date { ISODate.parse(iso)! }

    private func shortcuts(_ iso: String) -> [String] {
        IssueDates.shortcuts(now: at(iso), calendar: bogota()).map { "\($0.key.replacingOccurrences(of: "issue.d", with: "")):\($0.iso)" }
    }

    func testDateShortcuts() {
        // Lunes 28-sep-2026, 10:00 en Bogotá.
        XCTAssertEqual(shortcuts("2026-09-28T15:00:00.000Z"), ["Today:2026-09-28", "Tomorrow:2026-09-29", "Friday:2026-10-02", "NextWeek:2026-10-05"])
        // Miércoles: el viernes a dos días sí aparece.
        XCTAssertEqual(shortcuts("2026-09-30T15:00:00.000Z"), ["Today:2026-09-30", "Tomorrow:2026-10-01", "Friday:2026-10-02", "NextWeek:2026-10-05"])
        // Jueves: el viernes es mañana → no se repite.
        XCTAssertEqual(shortcuts("2026-10-01T15:00:00.000Z"), ["Today:2026-10-01", "Tomorrow:2026-10-02", "NextWeek:2026-10-05"])
        // Viernes: tampoco (sería hoy).
        XCTAssertEqual(shortcuts("2026-10-02T15:00:00.000Z"), ["Today:2026-10-02", "Tomorrow:2026-10-03", "NextWeek:2026-10-05"])
        // Sábado y domingo: el viernes que viene y el lunes próximo.
        XCTAssertEqual(shortcuts("2026-10-03T15:00:00.000Z"), ["Today:2026-10-03", "Tomorrow:2026-10-04", "Friday:2026-10-09", "NextWeek:2026-10-05"])
        XCTAssertEqual(shortcuts("2026-10-04T15:00:00.000Z"), ["Today:2026-10-04", "Tomorrow:2026-10-05", "Friday:2026-10-09", "NextWeek:2026-10-05"])
    }

    func testDateShortcutsUseLocalDayNotUTC() {
        // Domingo 27-sep a las 22:30 en Bogotá = lunes 28 a las 03:30 UTC: «Hoy» es el 27.
        let s = shortcuts("2026-09-28T03:30:00.000Z")
        XCTAssertEqual(s.first, "Today:2026-09-27")
        XCTAssertEqual(s.last, "NextWeek:2026-09-28", "el próximo lunes (local) es el 28")
    }

    func testOverdueAndDueTodayInLocalTime() throws {
        NSTimeZone.default = TimeZone(identifier: "America/Bogota")!
        let night = at("2026-09-28T03:30:00.000Z") // 27-sep 22:30 en Bogotá
        let dueToday = try issue("a", due: "2026-09-27", statusSince: "2026-09-27T20:00:00.000Z")
        let f = IssueSort.flags(dueToday, now: night)
        XCTAssertFalse(f.overdue, "de noche en Colombia UTC ya es mañana, pero no está vencido")
        XCTAssertTrue(f.dueToday)
        XCTAssertTrue(IssueSort.flags(try issue("b", due: "2026-09-26", statusSince: "2026-09-27T20:00:00.000Z"), now: night).overdue)
        XCTAssertFalse(IssueSort.flags(try issue("c", status: "done", due: "2026-09-01"), now: night).overdue, "lo cerrado no se vence")
        XCTAssertEqual(IssueDates.iso(night), "2026-09-27")
    }

    // MARK: Orden, filtros y secciones

    func testByUrgency() throws {
        let now = at("2026-09-28T15:00:00.000Z")
        let recent = "2026-09-28T14:00:00.000Z"
        let list = [
            try issue("new", statusSince: recent, createdAt: "2026-09-27T10:00:00.000Z"),
            try issue("old", statusSince: recent, createdAt: "2026-09-01T10:00:00.000Z"),
            try issue("doing", status: "in_progress", statusSince: recent, createdAt: "2026-09-01T09:00:00.000Z"),
            try issue("soon", due: "2026-09-30", statusSince: recent),
            try issue("later", due: "2026-10-09", statusSince: recent),
            try issue("stalled5", statusSince: "2026-09-23T14:00:00.000Z"),
            try issue("stalled3", statusSince: "2026-09-25T14:00:00.000Z"),
            try issue("overdue", due: "2026-09-20", statusSince: recent),
        ]
        let sorted = list.sorted { IssueSort.byUrgency($0, $1, now: now) }.map(\.id)
        XCTAssertEqual(sorted, ["overdue", "stalled5", "stalled3", "soon", "later", "doing", "new", "old"])
    }

    func testFiltersAndSectionsByOwner() throws {
        let list = [try issue("1", owner: "me"), try issue("2", owner: "bob"), try issue("3"), try issue("4", status: "done", owner: "me"),
                    try issue("5", owner: "ana", conv: "g2"), try issue("6", owner: "bob", conv: "g2")]
        XCTAssertEqual(IssueTree.filter(list, .mine, me: "me").map(\.id), ["1"])
        XCTAssertEqual(IssueTree.filter(list, .open, me: "me").map(\.id), ["1", "2", "3", "5", "6"])
        XCTAssertEqual(IssueTree.filter(list, .closed, me: "me").map(\.id), ["4"])
        let names = ["me": "Ana Ruiz", "bob": "Beto", "ana": "Alicia", IssueTree.noOwner: "Sin responsable", "g1": "Pagos", "g2": "Ventas"]
        let open = IssueTree.filter(list, .open, me: "me")
        let byPerson = IssueTree.sections(open, by: .person, me: "me") { names[$0] ?? $0 }
        XCTAssertEqual(byPerson.map(\.id), ["me", "ana", "bob", IssueTree.noOwner], "yo primero y «Sin responsable» al final")
        XCTAssertEqual(byPerson.first { $0.id == "bob" }?.issues.map(\.id), ["2", "6"])
        let byGroup = IssueTree.sections(open, by: .group, me: "me") { names[$0] ?? $0 }
        XCTAssertEqual(byGroup.map(\.id), ["g1", "g2"], "el grupo con más asuntos primero (3 contra 2)")
    }

    /// 1.7.13: la pestaña de Tareas agrupa por fecha (Vencidas · Hoy · Esta semana · Más adelante · Sin fecha).
    func testDateSectionsAndChips() throws {
        let cal = Calendar.current
        // Jueves 1-oct-2026, 15:00 hora local: la semana llega hasta el domingo 4.
        let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 1, hour: 15))!
        let recent = "2026-10-01T12:00:00.000Z"
        let list = [try issue("nodate", statusSince: recent), try issue("later", due: "2026-10-05", statusSince: recent),
                    try issue("sunday", due: "2026-10-04", statusSince: recent), try issue("today", due: "2026-10-01", statusSince: recent),
                    try issue("old", due: "2026-09-28", statusSince: recent), try issue("yday", due: "2026-09-30", statusSince: recent),
                    try issue("tomorrow", due: "2026-10-02", statusSince: recent)]
        let s = IssueTree.dateSections(list, now: now, calendar: cal)
        XCTAssertEqual(s.map(\.id), ["due.overdue", "due.today", "due.week", "due.later", "due.none"])
        XCTAssertEqual(s[0].issues.map(\.id), ["old", "yday"], "la más vieja primero")
        XCTAssertEqual(s[2].issues.map(\.id), ["tomorrow", "sunday"])
        XCTAssertTrue(IssueTree.dateSections([try issue("x", statusSince: recent)], now: now, calendar: cal).map(\.id) == ["due.none"], "sin franjas vacías")

        let chip = { (id: String) in IssueSort.dueChip(list.first { $0.id == id }!, now: now, calendar: cal) }
        XCTAssertEqual(chip("old")?.text, "Venció hace 3 días")
        XCTAssertEqual(chip("old")?.tone, .overdue)
        XCTAssertEqual(chip("yday")?.text, "Venció ayer")
        XCTAssertEqual(chip("today")?.text, "Vence hoy")
        XCTAssertEqual(chip("tomorrow")?.text, "Mañana")
        XCTAssertEqual(chip("sunday")?.tone, .normal)
        XCTAssertNil(chip("nodate"))

        // «Sin movimiento N d»: desde 5 días y nunca si ya está vencida.
        let quiet = try issue("q", statusSince: "2026-09-25T12:00:00.000Z")
        XCTAssertEqual(IssueSort.quietLabel(quiet, now: now), "Sin movimiento 6 d")
        XCTAssertNil(IssueSort.quietLabel(try issue("q3", statusSince: "2026-09-28T12:00:00.000Z"), now: now))
        XCTAssertNil(IssueSort.quietLabel(try issue("qo", due: "2026-09-20", statusSince: "2026-09-20T12:00:00.000Z"), now: now))
    }

    func testTextsMatchTheWeb() {
        XCTAssertEqual(L("issue.markDone"), "Marcar como hecho")
        XCTAssertEqual(L("issue.qWho"), "¿Quién lo hace?")
        XCTAssertEqual(L("issue.doneCount", ["n": 3]), "Completados · 3")
        XCTAssertEqual(L("issue.stalledPlain", ["n": 4]), "Nadie lo mueve hace 4 días")
        XCTAssertEqual(L("issue.quickPhIos"), "Añadir tarea…", "docs/TEMAS.md: los asuntos se llaman Tareas")
        XCTAssertEqual(L("issue.comment"), "Enviar")
        L10n.choice = .en
        XCTAssertEqual(L("issue.markDone"), "Mark as done")
        XCTAssertEqual(L("issue.dNextWeek"), "Next week")
        XCTAssertEqual(L("issue.closed"), "Completed")
    }
}

/// 1.6.4 (20): «Tamaño del texto» (Tú › Ajustes) se suma al Dynamic Type del sistema.
final class TextSizeTests: XCTestCase {
    func testStepsAddToSystemDynamicType() {
        XCTAssertEqual(TextSize.normal.applied(to: .large), .large, "Normal = el tamaño de hoy")
        XCTAssertEqual(TextSize.small.applied(to: .large), .medium)
        XCTAssertEqual(TextSize.large.applied(to: .large), .xLarge)
        XCTAssertEqual(TextSize.larger.applied(to: .large), .xxLarge)
        XCTAssertEqual(TextSize.largest.applied(to: .large), .accessibility1)
        // Se suma al del sistema, no lo reemplaza.
        XCTAssertEqual(TextSize.large.applied(to: .xxxLarge), .accessibility1)
        XCTAssertEqual(TextSize.normal.applied(to: .accessibility3), .accessibility3)
        // Límites.
        XCTAssertEqual(TextSize.small.applied(to: .xSmall), .xSmall)
        XCTAssertEqual(TextSize.largest.applied(to: .accessibility4), .accessibility5)
    }

    func testSavedInAppAndAppGroup() throws {
        let app = try XCTUnwrap(UserDefaults(suiteName: "tc-tests-\(UUID().uuidString)"))
        let group = try XCTUnwrap(UserDefaults(suiteName: "tc-tests-\(UUID().uuidString)"))
        XCTAssertEqual(TextSize.shared(group), .normal, "por defecto, Normal")
        TextSize.save(.larger, defaults: app, shared: group)
        XCTAssertEqual(app.integer(forKey: TextSize.key), TextSize.larger.rawValue)
        XCTAssertEqual(TextSize.shared(group), .larger, "la extensión lo lee del App Group")
    }

    func testFiveStepsWithTexts() {
        let saved = L10n.choice
        defer { L10n.choice = saved }
        L10n.choice = .es
        XCTAssertEqual(TextSize.allCases.map { L($0.labelKey) }, ["Pequeño", "Normal", "Grande", "Más grande", "Máximo"])
        XCTAssertEqual(L("textSize.title"), "Tamaño del texto")
        L10n.choice = .en
        XCTAssertEqual(TextSize.allCases.map { L($0.labelKey) }, ["Small", "Default", "Large", "Larger", "Largest"])
        XCTAssertEqual(L("textSize.title"), "Text size")
    }
}
