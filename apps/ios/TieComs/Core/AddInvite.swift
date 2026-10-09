import Foundation

// «Agregar al grupo» con invitar (SPEC-invitar, 28-sep-2026): buscador, candidatos, invitar por correo, copiar enlace,
// Compartir…, tipo de persona y pendientes. La misma estructura en web, iOS y Android.

/// Tipo de persona a la que se invita desde «Agregar al grupo».
enum InviteKind: Hashable, Sendable {
    /// «De {mi empresa}»: colega que aún no usa Chaggu; entra a mi organización y al grupo.
    case myOrg(orgId: String)
    /// «De {otra empresa del grupo}»: invitación del espacio con `role: member`.
    /// `orgId` nil: relación pendiente (solo `counterpartName`).
    case company(orgId: String?, name: String)
    /// «Tercero (asesor, mentor, cliente…)»: `role: guest`.
    case guest

    /// Clave estable (caché de enlaces, identificadores de accesibilidad).
    var key: String {
        switch self {
        case .myOrg(let id): return "org.\(id)"
        case .company(let id, let name): return "company.\(id ?? "pending:" + name)"
        case .guest: return "guest"
        }
    }
}

struct InviteChip: Identifiable, Hashable {
    var kind: InviteKind
    var label: String
    var id: String { kind.key }
}

/// Una invitación de varios usos guardada en memoria durante la sesión (se reutiliza si sigue vigente).
struct InviteLink: Equatable, Sendable {
    var url: String
    var code: String?
    var expiresAt: Date
}

/// Invitación pendiente (GET /{workspaces|organizations}/{id}/invitations).
struct PendingInvitationDTO: Decodable, Identifiable, Sendable, Equatable {
    var id: String
    var email: String
    var role: String
    var expiresAt: String
    var expired: Bool
    var emailStatus: String?
    var canManage: Bool
    /// Grupos de la invitación (API nuevo); nil en API viejos.
    var conversationIds: [String]?
    /// De qué lista vino (para reenviar o anular en el mismo lugar).
    var scope: String = "workspaces"
    var scopeId: String = ""

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", "")
        email = c.v("email", "")
        role = c.v("role", "member")
        expiresAt = c.v("expiresAt", "")
        expired = c.v("expired", false)
        emailStatus = c.o("emailStatus")
        canManage = c.v("canManage", false)
        conversationIds = c.o("conversationIds")
    }
}

enum AddInvite {
    /// Un solo correo válido (lo que se escribe en el buscador). Acepta mayúsculas y espacios alrededor.
    static func email(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !t.contains(where: { $0.isWhitespace || $0 == "," || $0 == ";" }) else { return nil }
        let p = InviteEmails.parse(t)
        return p.invalid.isEmpty && p.valid.count == 1 ? p.valid[0] : nil
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).trimmingCharacters(in: .whitespaces)
    }

    /// Candidatos: personas del espacio y de mis empresas (todas en un chat grupal) que no están en el grupo, filtradas por
    /// nombre o correo (tildes y mayúsculas da igual). Un grupo interno solo admite a su empresa.
    static func candidates(_ d: BootstrapDTO, _ c: ConversationDTO, query: String) -> [PersonDTO] {
        let inGroup = Set(c.memberIds)
        let ws = c.workspaceId.flatMap { wid in d.workspaces.first { $0.id == wid } }
        // En un grupo de un espacio también mis colegas que aún no están en él (entran al espacio como de mi empresa).
        let mine = Naming.myOrgIds(d)
        let pool: Set<String>? = (c.kind.isChat || Naming.isSide(c)) ? nil
            : Set(ws?.memberIds ?? []).union(d.people.filter { !$0.guest && $0.orgId.map(mine.contains) == true }.map(\.id))
        let q = fold(query)
        return d.people
            .filter { $0.kind == "human" && $0.id != d.me.id && !inGroup.contains($0.id) && (pool?.contains($0.id) ?? true) }
            .filter { c.kind != .internal || $0.orgId == c.internalOrgId }
            .filter { p in q.isEmpty || [p.name, p.title, p.area, Naming.org(d, p.orgId)?.name].compactMap { $0 }.contains { fold($0).contains(q) } }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// «· Empresa» o «· Tercero invitado» junto al nombre.
    static func personLine(_ d: BootstrapDTO, _ p: PersonDTO) -> String {
        if p.guest { return L("common.guest") }
        return Naming.org(d, p.orgId)?.name ?? L("common.guest")
    }

    /// ¿Este grupo admite invitar a alguien nuevo? Solo grupos de un espacio (no chats, laterales ni hilos).
    static func supportsInvite(_ d: BootstrapDTO, _ c: ConversationDTO) -> Bool {
        guard let wid = c.workspaceId, !c.kind.isChat, !Naming.isSide(c), c.parentId == nil || c.kind == .group else { return false }
        return d.workspaces.contains { $0.id == wid }
    }

    /// Mi empresa en el espacio del grupo: la que participa en él (o mi principal).
    static func myOrg(_ d: BootstrapDTO, _ ws: WorkspaceDTO) -> OrganizationDTO? {
        let mine = Naming.myOrgIds(d)
        if let id = ws.organizationIds.first(where: { mine.contains($0) && $0 == d.me.primaryOrgId }) ?? ws.organizationIds.first(where: mine.contains) {
            return Naming.org(d, id)
        }
        return Naming.org(d, d.me.primaryOrgId)
    }

    /// Chips de «Tipo de persona»: mi empresa, cada empresa contraparte (o la pendiente) y Tercero.
    /// Un grupo interno solo admite a mi empresa. Un tercero no invita (lista vacía).
    static func chips(_ d: BootstrapDTO, _ c: ConversationDTO) -> [InviteChip] {
        guard supportsInvite(d, c), let ws = d.workspaces.first(where: { $0.id == c.workspaceId }), ws.myRole != "guest" else { return [] }
        var out: [InviteChip] = []
        if let o = myOrg(d, ws) { out.append(.init(kind: .myOrg(orgId: o.id), label: L("addinv.from", ["company": o.name]))) }
        if c.kind == .internal { return out }
        if !ws.isOrgHome {
            let mine = Naming.myOrgIds(d)
            for id in ws.organizationIds where !mine.contains(id) {
                let name = Naming.org(d, id)?.name ?? ws.name
                out.append(.init(kind: .company(orgId: id, name: name), label: L("addinv.from", ["company": name])))
            }
            if let n = ws.counterpartName?.trimmingCharacters(in: .whitespaces), !n.isEmpty,
               !out.contains(where: { if case .company(_, let name) = $0.kind { return fold(name) == fold(n) }; return false }) {
                out.append(.init(kind: .company(orgId: nil, name: n), label: L("addinv.from", ["company": n])))
            }
        }
        out.append(.init(kind: .guest, label: L("addinv.guest")))
        return out
    }

    /// Por defecto: en un grupo de Tu organización, «De {mi empresa}»; en una relación, la contraparte; si no, Tercero.
    static func defaultKind(_ d: BootstrapDTO, _ c: ConversationDTO) -> InviteKind? {
        let list = chips(d, c)
        guard !list.isEmpty, let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) else { return nil }
        if c.kind == .internal { return list.first?.kind }
        switch Naming.placement(d, ws) {
        case .mine:
            if let k = list.first(where: { if case .myOrg = $0.kind { return true }; return false })?.kind { return k }
        case .relation, .pending:
            if let k = list.first(where: { if case .company = $0.kind { return true }; return false })?.kind { return k }
        case .guest: break
        }
        return .guest
    }

    /// Texto para copiar o compartir: «Te invito a {grupo} en Chaggu: {url} (código {code})».
    static func shareText(group: String, link: InviteLink) -> String {
        InviteShareData(name: group, url: link.url, code: link.code, expiresAt: link.expiresAt, conversationId: nil).shareText
    }

    /// Ruta y cuerpo de la invitación: por correo (`email`) o, sin correo, enlace y código de varios usos por 14 días.
    static func request(kind: InviteKind, workspaceId: String, conversationId: String, email: String?, history: String, lang: String) -> (path: String, body: [String: Any]) {
        var body: [String: Any] = ["conversationIds": [conversationId], "history": history, "lang": lang]
        if let email { body["email"] = email } else { body["multiUse"] = true; body["expiresInDays"] = 14 }
        switch kind {
        case .myOrg(let orgId):
            // Contrato nuevo (web-invitar): la persona entra a mi organización y además al grupo (y al espacio si es una relación).
            body["role"] = "member"
            body["workspaceId"] = workspaceId
            return ("/organizations/\(orgId)/invitations", body)
        case .company:
            // La persona queda asociada a la otra empresa al aceptar (regla de Viralidad de docs/GRUPOS.md).
            body["role"] = "member"
            return ("/workspaces/\(workspaceId)/invitations", body)
        case .guest:
            body["role"] = "guest"
            return ("/workspaces/\(workspaceId)/invitations", body)
        }
    }

    /// Enlaces de varios usos creados en esta sesión, por tipo y grupo.
    @MainActor static var links: [String: InviteLink] = [:]
    static func linkKey(_ kind: InviteKind, _ conversationId: String) -> String { "\(conversationId)|\(kind.key)" }

    /// Enlace vigente guardado para este tipo y grupo.
    @MainActor static func cachedLink(_ kind: InviteKind, _ conversationId: String, now: Date = Date()) -> InviteLink? {
        guard let l = links[linkKey(kind, conversationId)], l.expiresAt > now.addingTimeInterval(60) else { return nil }
        return l
    }

    /// Pendientes de este grupo: las que nombran el grupo; en API viejos (sin `conversationIds`), las del espacio.
    static func pendingForGroup(_ list: [PendingInvitationDTO], conversationId: String) -> [PendingInvitationDTO] {
        list.filter { $0.conversationIds?.contains(conversationId) ?? ($0.scope == "workspaces") }
    }
}

extension AppStore {
    /// Crea una invitación desde «Agregar al grupo» (correo o enlace de varios usos).
    func createGroupInvite(kind: InviteKind, workspaceId: String, conversationId: String, email: String?, history: String) async throws -> InvitationCreatedDTO {
        let r = AddInvite.request(kind: kind, workspaceId: workspaceId, conversationId: conversationId, email: email, history: history, lang: L10n.lang)
        var inv: InvitationCreatedDTO = try await api.request(r.path, method: "POST", json: r.body)
        // API viejo de empresa: sin `url`; el enlace de registro con la invitación.
        if inv.url.isEmpty, case .myOrg = kind, !inv.token.isEmpty {
            inv.url = "\(api.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/signup?org=\(inv.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? inv.token)"
        }
        return inv
    }

    /// Enlace de varios usos para este tipo y grupo: el vigente de la sesión o uno nuevo.
    func groupInviteLink(kind: InviteKind, workspaceId: String, conversationId: String, history: String) async throws -> InviteLink {
        if let l = AddInvite.cachedLink(kind, conversationId) { return l }
        let inv = try await createGroupInvite(kind: kind, workspaceId: workspaceId, conversationId: conversationId, email: nil, history: history)
        let l = InviteLink(url: inv.url, code: inv.code.flatMap { InviteCode.format($0) ?? $0 },
                           expiresAt: ISODate.parse(inv.expiresAt) ?? Date().addingTimeInterval(14 * 86400))
        AddInvite.links[AddInvite.linkKey(kind, conversationId)] = l
        return l
    }

    private struct PendingList: Decodable {
        var invitations: [PendingInvitationDTO]
        init(from d: Decoder) throws { invitations = try container(d).lossyArray("invitations") }
    }

    /// Pendientes del espacio y las de mi empresa que nombran este grupo.
    func groupPendingInvites(workspaceId: String, orgId: String?, conversationId: String) async -> [PendingInvitationDTO] {
        var all: [PendingInvitationDTO] = []
        if let r: PendingList = try? await api.request("/workspaces/\(workspaceId)/invitations") {
            all += r.invitations.map { var x = $0; x.scope = "workspaces"; x.scopeId = workspaceId; return x }
        }
        // Un miembro que no administra ve solo las suyas; API viejo: 403 y se ignora.
        if let orgId, let r: PendingList = try? await api.request("/organizations/\(orgId)/invitations") {
            all += r.invitations.map { var x = $0; x.scope = "organizations"; x.scopeId = orgId; return x }
        }
        return AddInvite.pendingForGroup(all, conversationId: conversationId)
    }

    func resendInvite(_ p: PendingInvitationDTO) async throws {
        _ = try await api.requestData("/\(p.scope)/\(p.scopeId)/invitations/\(p.id)/resend", method: "POST", json: [:])
    }

    func revokeInvite(_ p: PendingInvitationDTO) async throws {
        _ = try await api.requestData("/\(p.scope)/\(p.scopeId)/invitations/\(p.id)", method: "DELETE")
    }
}
