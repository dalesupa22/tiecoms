import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// SPEC-invitar: «Agregar al grupo» con buscador, invitar por correo, copiar enlace, tipo de persona y pendientes.
final class AddInviteTests: XCTestCase {
    private var saved: L10n.Choice = .system
    override func setUp() { saved = L10n.choice; L10n.choice = .es }
    override func tearDown() { L10n.choice = saved }

    /// Xertify (mía), Ongoing (relación), relación pendiente con «Nestlé», espacio de Acme donde soy tercero.
    private func boot() throws -> BootstrapDTO {
        try dec(BootstrapDTO.self, #"""
        {"contract":"2026-09-28","serverTime":"","me":{"id":"me","name":"Ana Ruiz","kind":"human","primaryOrgId":"oA"},
         "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"},{"id":"oB","name":"Ongoing"},{"id":"oC","name":"Acme"}],
         "workspaces":[
           {"id":"wHome","name":"Xertify","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me","col","gus"],"myRole":"member","isOrgHome":true,"createdAt":""},
           {"id":"wRel","name":"Mentorías","owningOrgId":"oA","organizationIds":["oA","oB"],"memberIds":["me","bob","col","álvaro"],"myRole":"lead","createdAt":""},
           {"id":"wPend","name":"Nestlé","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","counterpartName":"Nestlé","createdAt":""},
           {"id":"wLegacy","name":"Proyectos","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","createdAt":""},
           {"id":"wGuest","name":"Programa","owningOrgId":"oC","organizationIds":["oC"],"memberIds":["me"],"myRole":"guest","createdAt":""}],
         "conversations":[
           {"id":"home","workspaceId":"wHome","kind":"group","name":"Pagos","memberIds":["me"],"canManage":true},
           {"id":"int","workspaceId":"wHome","kind":"internal","internalOrgId":"oA","name":"Equipo","memberIds":["me"],"canManage":true},
           {"id":"rel","workspaceId":"wRel","kind":"group","name":"Mentoría 1","memberIds":["me","bob"],"canManage":true},
           {"id":"pend","workspaceId":"wPend","kind":"group","name":"Pagos Nestlé","memberIds":["me"],"canManage":true},
           {"id":"leg","workspaceId":"wLegacy","kind":"group","name":"Roadmap","memberIds":["me"],"canManage":true},
           {"id":"guest","workspaceId":"wGuest","kind":"group","name":"Cohorte","memberIds":["me"]},
           {"id":"multi","kind":"multi","name":"Café","memberIds":["me","bob"],"canManage":true}],
         "people":[{"id":"me","name":"Ana Ruiz","kind":"human","orgId":"oA"},{"id":"col","name":"Carla Gómez","kind":"human","orgId":"oA"},
                   {"id":"gus","name":"Gustavo","kind":"human","guest":true},
                   {"id":"álvaro","name":"Álvaro Núñez","kind":"human","orgId":"oB","title":"Mentor"},
                   {"id":"bob","name":"Bob","kind":"human","orgId":"oB"},{"id":"bot","name":"Asistente","kind":"agent","orgId":"oA"}]}
        """#)
    }

    private func conv(_ d: BootstrapDTO, _ id: String) -> ConversationDTO { d.conversations.first { $0.id == id }! }

    // MARK: Correo válido

    func testValidEmail() {
        XCTAssertEqual(AddInvite.email("  Laura.Pérez@Empresa.CO "), "laura.pérez@empresa.co")
        XCTAssertEqual(AddInvite.email("ana+qa@xertify.co"), "ana+qa@xertify.co")
        XCTAssertEqual(AddInvite.email("<ana@xertify.co>"), "ana@xertify.co")
        for bad in ["", "ana", "ana@", "ana@xertify", "@xertify.co", "ana @xertify.co", "a@b.co, c@d.co", "a@b.co c@d.co", "a@@b.co"] {
            XCTAssertNil(AddInvite.email(bad), bad)
        }
    }

    // MARK: Tipos de persona y el de por defecto

    func testChipsAndDefaultInMyOrganization() throws {
        let d = try boot()
        let home = conv(d, "home")
        XCTAssertEqual(AddInvite.chips(d, home).map(\.label), ["De Xertify", "Tercero (asesor, mentor, cliente…)"],
                       "Tu organización: sin chips de otras empresas")
        XCTAssertEqual(AddInvite.defaultKind(d, home), .myOrg(orgId: "oA"))
        // Otro espacio solo de mi empresa también es «Tu organización».
        XCTAssertEqual(AddInvite.defaultKind(d, conv(d, "leg")), .myOrg(orgId: "oA"))
        // Un grupo interno solo admite a mi empresa.
        XCTAssertEqual(AddInvite.chips(d, conv(d, "int")).map(\.kind), [.myOrg(orgId: "oA")])
        XCTAssertEqual(AddInvite.defaultKind(d, conv(d, "int")), .myOrg(orgId: "oA"))
    }

    func testDefaultInRelationIsCounterpart() throws {
        let d = try boot()
        let rel = conv(d, "rel")
        XCTAssertEqual(AddInvite.chips(d, rel).map(\.label), ["De Xertify", "De Ongoing", "Tercero (asesor, mentor, cliente…)"])
        XCTAssertEqual(AddInvite.defaultKind(d, rel), .company(orgId: "oB", name: "Ongoing"))
        // Relación pendiente: «De {counterpartName}», sin organización todavía.
        let pend = conv(d, "pend")
        XCTAssertEqual(AddInvite.chips(d, pend).map(\.label), ["De Xertify", "De Nestlé", "Tercero (asesor, mentor, cliente…)"])
        XCTAssertEqual(AddInvite.defaultKind(d, pend), .company(orgId: nil, name: "Nestlé"))
    }

    func testGuestsCannotInviteAndChatsHaveNoInviteSection() throws {
        let d = try boot()
        XCTAssertTrue(AddInvite.chips(d, conv(d, "guest")).isEmpty, "un tercero no invita: «Solo los miembros pueden invitar»")
        XCTAssertNil(AddInvite.defaultKind(d, conv(d, "guest")))
        XCTAssertTrue(AddInvite.supportsInvite(d, conv(d, "guest")))
        XCTAssertFalse(AddInvite.supportsInvite(d, conv(d, "multi")), "un chat grupal no tiene espacio al que invitar")
        XCTAssertTrue(AddInvite.chips(d, conv(d, "multi")).isEmpty)
    }

    func testEnglishLabels() throws {
        L10n.choice = .en
        let d = try boot()
        XCTAssertEqual(AddInvite.chips(d, conv(d, "rel")).map(\.label), ["From Xertify", "From Ongoing", "Guest (advisor, mentor, client…)"])
    }

    // MARK: Candidatos y buscador

    func testCandidatesFromTheSpaceWithAccentInsensitiveSearch() throws {
        let d = try boot()
        let rel = conv(d, "rel")
        XCTAssertEqual(AddInvite.candidates(d, rel, query: "").map(\.id), ["álvaro", "col"], "del espacio, sin los del grupo ni agentes")
        // Mis colegas aunque no estén en el espacio (Carla no está en «Proyectos»); los terceros de otro espacio no.
        XCTAssertEqual(AddInvite.candidates(d, conv(d, "leg"), query: "").map(\.id), ["col"])
        XCTAssertEqual(AddInvite.candidates(d, rel, query: "ALVARO").map(\.id), ["álvaro"], "tildes y mayúsculas da igual")
        XCTAssertEqual(AddInvite.candidates(d, rel, query: "ongoing").map(\.id), ["álvaro"], "también por empresa")
        XCTAssertTrue(AddInvite.candidates(d, rel, query: "laura@empresa.co").isEmpty)
        XCTAssertEqual(AddInvite.personLine(d, d.people.first { $0.id == "gus" }!), "Tercero invitado")
        XCTAssertEqual(AddInvite.personLine(d, d.people.first { $0.id == "bob" }!), "Ongoing")
        // Grupo interno: solo personas de su empresa.
        XCTAssertEqual(AddInvite.candidates(d, conv(d, "int"), query: "").map(\.id), ["col"])
    }

    // MARK: Texto para compartir y solicitudes

    func testShareText() {
        let link = InviteLink(url: "https://app.chaggu.com/invite/abc", code: "K7QM-4XPA", expiresAt: Date())
        XCTAssertEqual(AddInvite.shareText(group: "Pagos", link: link), "Te invito a Pagos en chaggu: https://app.chaggu.com/invite/abc (código K7QM-4XPA)")
        XCTAssertEqual(AddInvite.shareText(group: "Pagos", link: InviteLink(url: "https://x.test/i", code: nil, expiresAt: Date())),
                       "Te invito a Pagos en chaggu: https://x.test/i")
        L10n.choice = .en
        XCTAssertEqual(AddInvite.shareText(group: "Pagos", link: link), "Join Pagos on chaggu: https://app.chaggu.com/invite/abc (code K7QM-4XPA)")
    }

    func testRequests() {
        let byMail = AddInvite.request(kind: .guest, workspaceId: "w", conversationId: "g", email: "a@b.co", history: "all", lang: "en")
        XCTAssertEqual(byMail.path, "/workspaces/w/invitations")
        XCTAssertEqual(byMail.body["role"] as? String, "guest")
        XCTAssertEqual(byMail.body["email"] as? String, "a@b.co")
        XCTAssertEqual(byMail.body["conversationIds"] as? [String], ["g"])
        XCTAssertEqual(byMail.body["history"] as? String, "all")
        XCTAssertEqual(byMail.body["lang"] as? String, "en")
        XCTAssertNil(byMail.body["multiUse"])

        let link = AddInvite.request(kind: .company(orgId: "oB", name: "Ongoing"), workspaceId: "w", conversationId: "g", email: nil, history: "now", lang: "es")
        XCTAssertEqual(link.body["role"] as? String, "member")
        XCTAssertEqual(link.body["multiUse"] as? Bool, true)
        XCTAssertEqual(link.body["expiresInDays"] as? Int, 14)
        XCTAssertNil(link.body["email"])

        let pending = AddInvite.request(kind: .company(orgId: nil, name: "Nestlé"), workspaceId: "w", conversationId: "g", email: nil, history: "now", lang: "es")
        XCTAssertEqual(pending.path, "/workspaces/w/invitations", "relación pendiente: invitación del espacio")

        let colleague = AddInvite.request(kind: .myOrg(orgId: "oA"), workspaceId: "w", conversationId: "g", email: "c@xertify.co", history: "now", lang: "es")
        XCTAssertEqual(colleague.path, "/organizations/oA/invitations", "«De mi empresa» entra a mi organización")
        XCTAssertEqual(colleague.body["workspaceId"] as? String, "w")
        XCTAssertEqual(colleague.body["conversationIds"] as? [String], ["g"])
    }

    @MainActor
    func testLinkCacheReusesOnlyValidLinks() {
        let now = Date()
        AddInvite.links[AddInvite.linkKey(.guest, "g")] = InviteLink(url: "u", code: nil, expiresAt: now.addingTimeInterval(14 * 86400))
        XCTAssertEqual(AddInvite.cachedLink(.guest, "g", now: now)?.url, "u")
        XCTAssertNil(AddInvite.cachedLink(.myOrg(orgId: "oA"), "g", now: now), "otro tipo, otro enlace")
        XCTAssertNil(AddInvite.cachedLink(.guest, "g", now: now.addingTimeInterval(15 * 86400)), "vencido: se crea otro")
        AddInvite.links = [:]
    }

    func testPendingForGroup() throws {
        let list = try dec([PendingInvitationDTO].self, #"""
        [{"id":"1","email":"a@b.co","role":"member","expiresAt":"","conversationIds":["g"],"canManage":true},
         {"id":"2","email":"c@d.co","role":"guest","expiresAt":"","conversationIds":["otro"]},
         {"id":"3","email":"e@f.co","role":"member","expiresAt":""}]
        """#)
        XCTAssertEqual(AddInvite.pendingForGroup(list, conversationId: "g").map(\.id), ["1", "3"], "API viejo sin conversationIds: las del espacio")
    }
}
