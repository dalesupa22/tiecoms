import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// docs/GRUPOS.md: árbol de Grupos (Tu organización · Relaciones · Invitado en), DMs, códigos de invitación y API nueva.
final class GroupsTests: XCTestCase {
    /// Xertify (mía, owner) y Labs (mía, member, sin espacios); Ongoing con dos espacios, Delta con uno,
    /// una relación pendiente con «Nestlé» y un espacio de Acme donde soy tercero.
    private func boot() throws -> BootstrapDTO {
        try dec(BootstrapDTO.self, #"""
        {"contract":"2026-09-25","serverTime":"","me":{"id":"me","name":"Ana Ruiz","kind":"human","primaryOrgId":"oA"},
         "organizations":[{"id":"oE","name":"Labs","myRole":"member"},{"id":"oA","name":"Xertify","myRole":"owner"},
                          {"id":"oB","name":"Ongoing"},{"id":"oC","name":"Acme"},{"id":"oD","name":"Delta"}],
         "workspaces":[
           {"id":"wHome","name":"Xertify","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me","col"],"myRole":"member","isOrgHome":true,"createdAt":"2026-09-01"},
           {"id":"wLegacy","name":"Proyectos internos","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","createdAt":"2026-09-01"},
           {"id":"wRel1","name":"Mentorías","owningOrgId":"oB","organizationIds":["oB","oA"],"memberIds":["me","bob"],"myRole":"member","createdAt":"2026-09-01"},
           {"id":"wRel2","name":"Soporte","owningOrgId":"oA","organizationIds":["oA","oB"],"memberIds":["me","bob"],"myRole":"member","createdAt":"2026-09-01"},
           {"id":"wSingle","name":"Delta · Xertify","owningOrgId":"oA","organizationIds":["oA","oD"],"memberIds":["me"],"myRole":"member","createdAt":"2026-09-01"},
           {"id":"wPend","name":"Nestlé","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","counterpartName":"Nestlé","createdAt":"2026-09-01"},
           {"id":"wEmpty","name":"Sin grupos","owningOrgId":"oB","organizationIds":["oB","oA"],"memberIds":["me"],"myRole":"member","createdAt":"2026-09-01"},
           {"id":"wPend2","name":"Acme Foods","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","counterpartName":"Acme Foods","createdAt":"2026-09-01"},
           {"id":"wGuest","name":"Programa","owningOrgId":"oC","organizationIds":["oC"],"memberIds":["me"],"myRole":"guest","createdAt":"2026-09-01"}],
         "conversations":[
           {"id":"g1","workspaceId":"wHome","kind":"group","name":"Pagos","memberIds":["me","col"],"lastMessageAt":"2026-09-25T10:00:00Z","unread":2},
           {"id":"g2","workspaceId":"wHome","kind":"internal","name":"Equipo interno","memberIds":["me"],"lastMessageAt":"2026-09-24T10:00:00Z"},
           {"id":"gL","workspaceId":"wLegacy","kind":"group","name":"Roadmap","memberIds":["me"]},
           {"id":"r1","workspaceId":"wRel1","kind":"group","name":"Mentoría 1","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T09:00:00Z"},
           {"id":"der1","workspaceId":"wRel1","kind":"group","name":"Hilo · seguimiento","parentId":"r1","deriveKind":"same","memberIds":["me","bob"],"unread":2},
           {"id":"gen1","workspaceId":"wRel1","kind":"group","name":"General","memberIds":["me","bob"]},
           {"id":"gen2","workspaceId":"wRel2","kind":"group","name":"General","memberIds":["me","bob"]},
           {"id":"homeGen","workspaceId":"wHome","kind":"group","name":"General","memberIds":["me"]},
           {"id":"legGen","workspaceId":"wLegacy","kind":"group","name":"General","memberIds":["me"]},
           {"id":"r2","workspaceId":"wRel2","kind":"group","name":"Tickets","memberIds":["me","bob"]},
           {"id":"s1","workspaceId":"wSingle","kind":"group","name":"Compras","memberIds":["me"]},
           {"id":"p1","workspaceId":"wPend","kind":"group","name":"Pagos Nestlé","memberIds":["me"]},
           {"id":"x1","workspaceId":"wGuest","kind":"group","name":"Cohorte","memberIds":["me"],"unread":1,"mutedUntil":"2099-01-01T00:00:00Z"},
           {"id":"d1","kind":"direct","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T11:00:00Z","unread":3},
           {"id":"m1","kind":"multi","name":"Café","memberIds":["me","bob","col"],"lastMessageAt":"2026-09-20T11:00:00Z"},
           {"id":"side1","workspaceId":"wRel1","kind":"multi","deriveKind":"side","parentId":"r1","parentMessageId":"mm","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T12:00:00Z","unread":1}],
         "people":[{"id":"me","name":"Ana Ruiz","kind":"human","orgId":"oA"},{"id":"col","name":"Carla","kind":"human","orgId":"oA"},
                   {"id":"bob","name":"Bob","kind":"human","orgId":"oB"}]}
        """#)
    }

    private func ids(_ n: [GroupsTree.ConvNode]) -> [String] { n.map(\.conv.id) }

    func testSectionsInFixedOrder() throws {
        let t = Naming.groupsTree(try boot())
        // Una sección por cada empresa mía (la principal primero, aunque la otra no tenga grupos), Relaciones, Invitado en.
        XCTAssertEqual(t.sections.map(\.id), ["mine:oA", "mine:oE", "relations", "guest"])
        XCTAssertEqual(t.sections[0].org?.name, "Xertify")
        XCTAssertTrue(t.sections[1].companies.isEmpty, "Labs sin espacios: sección vacía para su «+»")
        XCTAssertTrue(t.hasGroups)
    }

    func testOnlyGroupsNoSpacesUnderMyOrganization() throws {
        let mine = Naming.groupsTree(try boot()).sections[0]
        XCTAssertEqual(mine.companies.count, 1)
        let g = mine.companies[0].groups
        // Los grupos del espacio casa y de otros espacios de mi empresa, directo (no leídos primero, luego actividad).
        XCTAssertEqual(g.first?.id, "g1")
        XCTAssertEqual(Set(g.map(\.id)), ["g1", "g2", "gL", "homeGen", "legGen"])
        let labels = Dictionary(uniqueKeysWithValues: g.map { ($0.id, $0.label) })
        XCTAssertNil(labels["homeGen"]!, "el espacio casa nunca lleva prefijo")
        XCTAssertEqual(labels["legGen"]!, "Proyectos internos · General", "mismo nombre en la misma empresa: «{espacio} · {grupo}»")
        XCTAssertNil(labels["g1"]!)
    }

    func testRelationsFlatDuplicatesPendingAndEmptySpaces() throws {
        let rel = Naming.groupsTree(try boot()).sections.first { $0.kind == .relations }!
        let byId = Dictionary(uniqueKeysWithValues: rel.companies.map { ($0.id, $0) })
        XCTAssertEqual(Set(byId.keys), ["oB", "oD", "pending:nestle", "pending:acme foods"])
        // Ongoing: los grupos de sus dos espacios juntos; el espacio sin grupos no aparece.
        let ongoing = byId["oB"]!
        XCTAssertEqual(Set(ongoing.groups.map(\.id)), ["r1", "r2", "gen1", "gen2"])
        XCTAssertFalse(ongoing.workspaces.contains { $0.id == "wEmpty" }, "un espacio sin grupos no aparece")
        let labels = Dictionary(uniqueKeysWithValues: ongoing.groups.map { ($0.id, $0.label) })
        XCTAssertEqual(labels["gen1"]!, "Mentorías · General")
        XCTAssertEqual(labels["gen2"]!, "Soporte · General")
        XCTAssertNil(labels["r1"]!)
        XCTAssertEqual(byId["oD"]!.groups.map(\.id), ["s1"])
        // Relación pendiente: nombre escrito, marca y sin organización; sin grupos también aparece.
        let p = byId["pending:nestle"]!
        XCTAssertTrue(p.pending)
        XCTAssertNil(p.org)
        XCTAssertEqual(p.name, "Nestlé")
        XCTAssertEqual(p.groups.map(\.id), ["p1"])
        XCTAssertTrue(byId["pending:acme foods"]!.groups.isEmpty)
        XCTAssertFalse(ongoing.pending)
    }

    func testGuestSectionUnderHostCompany() throws {
        let g = Naming.groupsTree(try boot()).sections.first { $0.kind == .guest }!
        XCTAssertEqual(g.companies.map(\.id), ["oC"])
        XCTAssertEqual(g.companies[0].name, "Acme")
        XCTAssertEqual(g.companies[0].groups.map(\.id), ["x1"])
        XCTAssertEqual(Naming.placement(try boot(), try boot().workspaces.first { $0.id == "wGuest" }!), .guest(orgId: "oC"))
    }

    func testSidechatsAndChatsGoToDMsNotGroups() throws {
        let d = try boot()
        let t = Naming.groupsTree(d)
        let all = Set(t.sections.flatMap { $0.allConvs.map(\.id) })
        XCTAssertFalse(all.contains("side1"), "los sidechats ya no cuelgan bajo los grupos")
        XCTAssertFalse(all.contains("d1"))
        XCTAssertFalse(all.contains("m1"))
        let dms = Naming.dms(d).map(\.id)
        XCTAssertEqual(Set(dms), ["d1", "m1", "side1"])
        XCTAssertEqual(Array(dms.prefix(2)), ["side1", "d1"], "orden de Inicio: no leídos primero y por actividad")
        XCTAssertEqual(Naming.sideOrigin(d, d.conversations.first { $0.id == "side1" }!)?.id, "r1")
        XCTAssertEqual(Naming.dms(d, query: "café").map(\.id), ["m1"])
        var side = d.conversations.first { $0.id == "side1" }!
        side.name = "Sidechat · ¿Movemos la mentoría?"
        XCTAssertEqual(Naming.sideRowTitle(d, side), "¿Movemos la mentoría?", "la burbuja ya dice Sidechat")
        side.name = "Consulta · Presupuesto"
        XCTAssertEqual(Naming.sideRowTitle(d, side), "Presupuesto")
        XCTAssertEqual(Naming.sideRowTitle(d, d.conversations.first { $0.id == "m1" }!), "Café")
    }

    func testThreadsNotListedAndUnreadChipOnParent() throws {
        let t = Naming.groupsTree(try boot())
        XCTAssertFalse(t.sections.flatMap { $0.allConvs.map(\.id) }.contains("der1"), "los hilos viven en la barra del chat")
        let r1 = t.sections.first { $0.kind == .relations }!.companies.first { $0.id == "oB" }!.groups.first { $0.id == "r1" }!
        XCTAssertEqual(r1.threadUnread, 2, "«💬 N» en la fila del grupo")
    }

    func testFiltersAndSearchDropEmptySections() throws {
        let d = try boot()
        let unread = Naming.groupsTree(d, tab: .unread)
        XCTAssertEqual(unread.sections.map(\.id), ["mine:oA", "relations"], "silenciada sin mención no cuenta; un grupo con hilos sin leer sí; sin secciones vacías")
        XCTAssertEqual(unread.sections[1].companies.flatMap { $0.groups.map(\.id) }, ["r1"])
        XCTAssertTrue(unread.pinned.isEmpty)
        let q = Naming.groupsTree(d, query: "nestle")
        XCTAssertEqual(q.sections.map(\.id), ["relations"], "busca también por el nombre de la empresa pendiente")
        XCTAssertEqual(q.sections[0].companies.map(\.id), ["pending:nestle"])
        XCTAssertEqual(Naming.groupsTree(d, query: "acme foods").sections.first?.companies.map(\.id), ["pending:acme foods"], "la pendiente sin grupos se encuentra por su nombre")
        XCTAssertTrue(Naming.groupsTree(d, query: "zzz").isEmpty)
        XCTAssertEqual(HomeFilter.unread.groupCount(d), 1, "los chips de Grupos cuentan solo grupos")
    }

    func testUnreadBadgesPerTab() throws {
        let d = try boot()
        XCTAssertEqual(Naming.groupsUnread(d), 4, "grupos (y sus hilos) con espacio no silenciados")
        XCTAssertEqual(Naming.dmsUnread(d), 4, "directos y chats, sidechats incluidos")
    }

    func testRelationsForNewGroupAndGuestRole() throws {
        let d = try boot()
        // Acme Foods y Nestlé (pendientes), Delta y Ongoing, por nombre; ni mi organización ni donde soy tercero.
        XCTAssertEqual(Naming.relations(d).map(\.id), ["pending:acme foods", "oD", "pending:nestle", "oB"])
        XCTAssertEqual(Naming.relations(d).last?.workspaces.count, 3, "para «Nuevo grupo» también cuenta el espacio sin grupos")
        XCTAssertTrue(Naming.isGuest(d, d.conversations.first { $0.id == "x1" }!))
        XCTAssertFalse(Naming.isGuest(d, d.conversations.first { $0.id == "g1" }!))
        XCTAssertFalse(Naming.isGuest(d, d.conversations.first { $0.id == "d1" }!))
        XCTAssertEqual(Naming.orgHome(d, orgId: "oA")?.id, "wHome")
    }

    func testPinnedOnlyGroups() throws {
        var d = try boot()
        for i in d.conversations.indices where ["g2", "d1"].contains(d.conversations[i].id) { d.conversations[i].pinnedAt = "2026-09-25T00:00:00Z" }
        XCTAssertEqual(Naming.groupsTree(d).pinned.map(\.id), ["g2"], "los DMs fijados no van en Grupos")
    }

    // MARK: Decodificación tolerante

    func testDecodesNewFieldsTolerantly() throws {
        let old = try dec(WorkspaceDTO.self, #"{"id":"w","name":"X","owningOrgId":"o","organizationIds":["o"]}"#)
        XCTAssertFalse(old.isOrgHome)
        XCTAssertNil(old.counterpartName)
        let home = try dec(WorkspaceDTO.self, #"{"id":"w","isOrgHome":true,"counterpartName":null}"#)
        XCTAssertTrue(home.isOrgHome)
        let inv = try dec(InvitationPreviewDTO.self, #"{"workspaceName":"W","invitedByName":"Ana","role":"guest","valid":true,"groupNames":["Pagos",""],"multiUse":true,"orgHome":true}"#)
        XCTAssertEqual(inv.groupNames, ["Pagos"])
        XCTAssertTrue(inv.multiUse && inv.orgHome)
        let oldInv = try dec(InvitationPreviewDTO.self, #"{"workspaceName":"W","valid":true}"#)
        XCTAssertEqual(oldInv.groupNames, [])
        let g = try dec(CreateGroupResultDTO.self, #"{"workspaceId":"w","conversationId":"c","invited":2,"inviteUrl":"https://app.tiecoms.com/invite/t","inviteCode":"K7QM-4XPA"}"#)
        XCTAssertEqual(g.inviteCode, "K7QM-4XPA")
        XCTAssertNil(try dec(CreateGroupResultDTO.self, #"{"workspaceId":"w","conversationId":"c","invited":0}"#).inviteUrl)
        let created = try dec(InvitationCreatedDTO.self, #"{"id":"i","token":"t","url":"u","code":null,"expiresAt":"2026-10-09T00:00:00.000Z","emailSent":true,"emailStatus":"sent"}"#)
        XCTAssertNil(created.code)
        let o = try dec(OversightDTO.self, #"{"orgId":"oA","groups":[{"conversationId":"c1","name":"Pagos","kind":"group","workspaceId":"w","workspaceName":"W","memberCount":"4","myOrgMemberIds":["a"],"iAmMember":false},{"bad":1}]}"#)
        XCTAssertEqual(o.groups.count, 1, "un elemento defectuoso se descarta")
        XCTAssertEqual(o.groups[0].memberCount, 4)
        XCTAssertFalse(o.groups[0].iAmMember)
    }

    // MARK: Códigos de invitación y correos

    func testInviteCodeNormalizationAndFormat() {
        XCTAssertEqual(InviteCode.normalize("k7qm 4xpa"), "K7QM4XPA")
        XCTAssertEqual(InviteCode.normalize(" K7QM-4XPA "), "K7QM4XPA")
        XCTAssertEqual(InviteCode.format("k7qm4xpa"), "K7QM-4XPA")
        XCTAssertNil(InviteCode.normalize("K7QM-4XP"), "7 caracteres")
        XCTAssertNil(InviteCode.normalize("K7QM-4XPAA"), "9 caracteres")
        XCTAssertNil(InviteCode.normalize("K0QM-4XPA"), "sin 0/O, 1/I/L")
        XCTAssertNil(InviteCode.normalize("KIQM-4XPA"))
        XCTAssertNil(InviteCode.normalize("ñ7qm-4xpa"))
        XCTAssertEqual(InviteCode.typing("k7qm"), "K7QM")
        XCTAssertEqual(InviteCode.typing("k7qm4"), "K7QM-4")
        XCTAssertEqual(InviteCode.typing("K7QM-4XPA-ZZ"), "K7QM-4XPA", "tope de 8")
        XCTAssertEqual(InviteCode.lookupKey("k7qm 4xpa"), "K7QM-4XPA")
        XCTAssertEqual(InviteCode.lookupKey("https://app.tiecoms.com/invite/abc_DEF-123?utm=1"), "abc_DEF-123", "un enlace pegado usa su token")
        XCTAssertNil(InviteCode.lookupKey("hola"))
    }

    func testInviteEmailsParsing() {
        let r = InviteEmails.parse("Ana@Nestle.com, luis@nestle.com;  ana@nestle.com\n<eva@x.co> malo@")
        XCTAssertEqual(r.valid, ["ana@nestle.com", "luis@nestle.com", "eva@x.co"])
        XCTAssertEqual(r.invalid, ["malo@"])
        XCTAssertTrue(InviteEmails.parse("  ").valid.isEmpty)
    }

    func testGroupTargetJSON() {
        XCTAssertEqual(GroupTarget.org(orgId: nil).json as NSDictionary, ["kind": "org"])
        XCTAssertEqual(GroupTarget.workspace("w1").json as NSDictionary, ["kind": "workspace", "workspaceId": "w1"])
        XCTAssertEqual(GroupTarget.company(name: " Nestlé ", orgId: "oA").json as NSDictionary, ["kind": "company", "companyName": "Nestlé", "orgId": "oA"])
    }

    // MARK: API

    @MainActor
    func testCreateGroupAndLinkInvitationBodies() async throws {
        MockURLProtocol.routes = [
            "/api/v1/groups": (201, #"{"workspaceId":"w","conversationId":"c","invited":1,"inviteUrl":"https://app.tiecoms.com/invite/t","inviteCode":"K7QM-4XPA"}"#),
            "/api/v1/blocks": (200, #"{"userIds":[]}"#),
            "/api/v1/bootstrap": (200, #"{"contract":"x","serverTime":"","me":{"id":"me","name":"Ana"},"organizations":[],"workspaces":[],"conversations":[],"people":[]}"#),
            "/api/v1/workspaces/w/invitations": (201, #"{"id":"i","token":"t","url":"https://app.tiecoms.com/invite/t","code":"K7QM-4XPA","expiresAt":"2026-10-09T00:00:00.000Z","emailSent":false}"#),
        ]
        MockURLProtocol.requests = []
        let store = AppStore(baseURL: URL(string: "https://mock.tiecoms.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil, session: MockURLProtocol.session())
        let r = try await store.createGroup(name: " Pagos ", target: .company(name: "Nestlé", orgId: nil), memberIds: ["col"],
                                            inviteEmails: ["ana@nestle.com"], inviteRole: "member", shareLink: true)
        XCTAssertEqual(r.inviteCode, "K7QM-4XPA")
        let body = try XCTUnwrap(MockURLProtocol.requests.first { $0.path == "/api/v1/groups" }?.body)
        XCTAssertEqual(body["name"] as? String, "Pagos")
        XCTAssertEqual((body["target"] as? [String: Any])?["kind"] as? String, "company")
        XCTAssertEqual((body["target"] as? [String: Any])?["companyName"] as? String, "Nestlé")
        XCTAssertEqual(body["inviteEmails"] as? [String], ["ana@nestle.com"])
        XCTAssertEqual(body["inviteRole"] as? String, "member")
        XCTAssertEqual(body["shareLink"] as? Bool, true)
        XCTAssertNotNil(body["lang"])
        XCTAssertTrue(MockURLProtocol.requests.contains { $0.path == "/api/v1/bootstrap" }, "después de crear se refresca el bootstrap")

        let link = try await store.createInvitation(workspaceId: "w", conversationIds: ["c"], email: nil, role: "guest")
        XCTAssertEqual(link.code, "K7QM-4XPA")
        let lb = try XCTUnwrap(MockURLProtocol.requests.last?.body)
        XCTAssertEqual(lb["multiUse"] as? Bool, true)
        XCTAssertEqual(lb["expiresInDays"] as? Int, 14)
        XCTAssertEqual(lb["history"] as? String, "all")
        XCTAssertEqual(lb["conversationIds"] as? [String], ["c"])
        XCTAssertNil(lb["email"])
        _ = try await store.createInvitation(workspaceId: "w", conversationIds: ["c"], email: "eva@x.co", role: "member")
        let eb = try XCTUnwrap(MockURLProtocol.requests.last?.body)
        XCTAssertEqual(eb["email"] as? String, "eva@x.co")
        XCTAssertNil(eb["multiUse"], "con correo no es de varios usos")
    }

    @MainActor
    func testArchiveGroupCallsAPIAndRefreshes() async throws {
        MockURLProtocol.routes = [
            "/api/v1/conversations/g1/archive": (200, #"{"archived":true,"workspaceArchived":false}"#),
            "/api/v1/blocks": (200, #"{"userIds":[]}"#),
            "/api/v1/bootstrap": (200, #"{"contract":"x","serverTime":"","me":{"id":"me","name":"Ana"},"organizations":[],"workspaces":[],"conversations":[],"people":[]}"#),
        ]
        MockURLProtocol.requests = []
        let store = AppStore(baseURL: URL(string: "https://mock.tiecoms.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil, session: MockURLProtocol.session())
        store.seedForTesting(try boot())
        store.homePath = [.conversation("g1")]
        let r = try await store.archiveGroup("g1")
        XCTAssertTrue(r.archived)
        XCTAssertFalse(r.workspaceArchived)
        XCTAssertEqual(MockURLProtocol.httpRequests.first { $0.url?.path == "/api/v1/conversations/g1/archive" }?.httpMethod, "POST")
        XCTAssertTrue(MockURLProtocol.requests.contains { $0.path == "/api/v1/bootstrap" }, "después de archivar se refresca el bootstrap")
        XCTAssertTrue(store.homePath.isEmpty, "si estaba abierto, se cierra")
    }

    /// Una conversación de DMs se abre en la pestaña DMs; un grupo, en Grupos.
    @MainActor
    func testNavigateOpensConversationInItsTab() throws {
        let store = AppStore(baseURL: URL(string: "https://mock.tiecoms.test")!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil, session: MockURLProtocol.session())
        store.seedForTesting(try boot())
        store.navigate(to: .conversation("side1"))
        XCTAssertEqual(store.tab, .dms)
        XCTAssertEqual(store.dmsPath, [.conversation("side1")])
        store.navigate(to: .conversation("g1"))
        XCTAssertEqual(store.tab, .home)
        XCTAssertEqual(store.homePath, [.conversation("g1")])
        store.tab = .settings
        store.push(.oversight("oA"))
        XCTAssertEqual(store.settingsPath, [.oversight("oA")])
        XCTAssertTrue(store.isGuest("x1"))
    }
}
