import Foundation

// Grupos, relaciones, DMs e invitaciones (docs/GRUPOS.md): las mismas reglas en web, iOS y Android.
//
//   Empresa (organización)
//     └── Grupo (conversación group/internal dentro de un espacio)
//           └── Asuntos abiertos

// MARK: - Árbol de Grupos

struct GroupsTree {
    enum Kind: String { case mine, relations, guest, other }
    /// Fila de grupo. `label`: «{espacio} · {grupo}» si otro grupo de la misma empresa se llama igual.
    /// `threadUnread`: respuestas sin leer de sus hilos (los hilos no se listan: viven en la barra del chat).
    struct ConvNode: Identifiable { var conv: ConversationDTO; var label: String? = nil; var threadUnread: Int = 0; var id: String { conv.id } }
    /// Espacio de una empresa: no se muestra (solo hay grupos y asuntos); sirve para «Nuevo grupo» e «Invitar».
    struct WsNode: Identifiable { var ws: WorkspaceDTO; var id: String { ws.id } }
    struct CompanyNode: Identifiable {
        /// id de la empresa, o "pending:<nombre>" para una relación cuya empresa aún no entra.
        var id: String
        var org: OrganizationDTO?
        var name: String
        /// «Invitación pendiente»: la otra empresa aún no entra (solo `counterpartName`).
        var pending: Bool
        var workspaces: [WsNode]
        /// Los grupos de todos sus espacios, directo bajo la empresa.
        var groups: [ConvNode] = []
    }
    struct Section: Identifiable {
        /// "mine:<orgId>", "relations", "guest" u "other".
        var id: String
        var kind: Kind
        /// Tu organización: la empresa de la sección.
        var org: OrganizationDTO?
        var companies: [CompanyNode]
        /// Grupos cuyo espacio no está en el snapshot (sección «Otros»).
        var orphans: [ConvNode] = []

        var allConvs: [ConversationDTO] { companies.flatMap { $0.groups.map(\.conv) } + orphans.map(\.conv) }
    }
    var pinned: [ConversationDTO] = []
    var sections: [Section] = []

    /// Sin ningún grupo que mostrar (las secciones vacías de «Tu organización» y «Relaciones» no cuentan).
    var isEmpty: Bool { pinned.isEmpty && sections.allSatisfy { $0.allConvs.isEmpty && $0.companies.isEmpty } }
    var hasGroups: Bool { !pinned.isEmpty || sections.contains { !$0.allConvs.isEmpty } }
    /// Firma del orden: cuando cambia (llega un mensaje y la fila sube) la lista se anima.
    var orderSignature: [String] {
        sections.flatMap { s in [s.id] + s.companies.flatMap { [$0.id] + $0.groups.map(\.id) } + s.orphans.map(\.id) }
    }
}

extension Naming {
    /// Dónde va un espacio en el árbol (regla exacta de docs/GRUPOS.md).
    enum Placement: Equatable {
        /// «Tu organización · org(owningOrgId)».
        case mine(orgId: String)
        /// «Relaciones», bajo la empresa contraparte.
        case relation(orgId: String)
        /// «Relaciones», bajo `counterpartName` (la empresa aún no entra).
        case pending(name: String)
        /// «Invitado en», bajo la empresa anfitriona.
        case guest(orgId: String)

        /// Clave de la empresa dentro de su sección.
        var companyKey: String {
            switch self {
            case .mine(let id), .relation(let id), .guest(let id): return id
            case .pending(let name): return "pending:" + name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            }
        }
    }

    static func myOrgIds(_ d: BootstrapDTO) -> Set<String> { Set(d.organizations.filter { $0.myRole != nil }.map(\.id)) }

    static func placement(_ d: BootstrapDTO, _ w: WorkspaceDTO, myOrgs: Set<String>? = nil) -> Placement {
        if w.myRole == "guest" { return .guest(orgId: w.owningOrgId) }
        let mine = myOrgs ?? myOrgIds(d)
        if let other = w.organizationIds.first(where: { !mine.contains($0) }) { return .relation(orgId: other) }
        if let name = w.counterpartName?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return .pending(name: name) }
        return .mine(orgId: w.owningOrgId)
    }

    /// Mi espacio casa de una empresa (si ya existe).
    static func orgHome(_ d: BootstrapDTO, orgId: String) -> WorkspaceDTO? {
        d.workspaces.first { $0.isOrgHome && $0.owningOrgId == orgId && $0.myRole != "guest" }
    }

    /// ¿Soy tercero (guest) en el espacio de esta conversación? Los terceros no crean asuntos ni grupos.
    static func isGuest(_ d: BootstrapDTO, _ c: ConversationDTO) -> Bool {
        guard let wid = c.workspaceId else { return false }
        return d.workspaces.first { $0.id == wid }?.myRole == "guest"
    }

    /// Mis empresas en el orden de las secciones: la principal primero.
    static func myOrgsOrdered(_ d: BootstrapDTO) -> [OrganizationDTO] {
        let mine = d.organizations.filter { $0.myRole != nil }
        return mine.filter { $0.id == d.me.primaryOrgId } + mine.filter { $0.id != d.me.primaryOrgId }
    }

    /// Relaciones donde puedo crear grupos (las existentes y las pendientes), para «Nuevo grupo».
    static func relations(_ d: BootstrapDTO) -> [GroupsTree.CompanyNode] {
        let mine = myOrgIds(d)
        var order: [String] = []
        var map: [String: GroupsTree.CompanyNode] = [:]
        for w in d.workspaces {
            let p = placement(d, w, myOrgs: mine)
            let name: String
            var org: OrganizationDTO?
            switch p {
            case .relation(let id): org = self.org(d, id); name = org?.name ?? w.name
            case .pending(let n): name = n
            default: continue
            }
            let key = p.companyKey
            if map[key] == nil { order.append(key); map[key] = .init(id: key, org: org, name: name, pending: org == nil, workspaces: []) }
            map[key]!.workspaces.append(.init(ws: w))
        }
        return order.compactMap { map[$0] }
            .map { var c = $0; c.workspaces.sort { $0.ws.name.localizedCaseInsensitiveCompare($1.ws.name) == .orderedAscending }; return c }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Grupos: Tu organización (una por cada empresa mía) · Relaciones · Invitado en (+ Otros).
    /// `tab` es el filtro de chips (Todo/No leídos/Menciones/Asuntos); chats y sidechats viven en DMs.
    /// Grupos: Tu organización (una por cada empresa mía) · Relaciones · Invitado en (+ Otros).
    /// Solo hay grupos y asuntos: ningún espacio se muestra; los grupos de todos los espacios van bajo su empresa.
    /// `tab` es el filtro de chips (Todo/No leídos/Menciones/Asuntos); chats y sidechats viven en DMs.
    static func groupsTree(_ d: BootstrapDTO, query: String = "", filterWorkspace: String? = nil, tab: HomeFilter = .all) -> GroupsTree {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        let mine = myOrgIds(d)
        func matches(_ c: ConversationDTO) -> Bool {
            guard !q.isEmpty else { return true }
            var hay = [title(d, c), subtitle(d, c)]
            if let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) {
                hay.append(ws.name)
                if let n = ws.counterpartName { hay.append(n) }
                if let o = counterpartOrg(d, ws) { hay.append(o.name) }
            }
            hay += c.memberIds.compactMap { person(d, $0)?.name }
            return hay.contains { fold($0).contains(q) }
        }
        let rows = d.conversations.filter { isGroupRow($0) && !isThread($0) }
        // Respuestas sin leer de los hilos de cada grupo («💬 N» en su fila).
        var threadUnread: [String: Int] = [:]
        for t in d.conversations where isThread(t) { if let p = t.parentId { threadUnread[p, default: 0] += HomeOrder.pending(t) } }
        func node(_ c: ConversationDTO) -> GroupsTree.ConvNode? {
            let tu = threadUnread[c.id] ?? 0
            guard matches(c) && (tab.includes(c) || (tab == .unread && tu > 0)) else { return nil }
            return .init(conv: c, threadUnread: tu)
        }
        var tree = GroupsTree()
        let showEmpty = filterWorkspace == nil && tab == .all && q.isEmpty
        if filterWorkspace == nil && tab == .all {
            tree.pinned = rows.filter { $0.pinnedAt != nil && matches($0) }.sorted { ($0.pinnedAt ?? "") < ($1.pinnedAt ?? "") }
        }
        // Empresas por sección, en orden de aparición; luego se ordenan.
        var companies: [GroupsTree.Kind: [String: GroupsTree.CompanyNode]] = [:]
        var mineOrder: [String] = []
        for ws in d.workspaces where filterWorkspace == nil || ws.id == filterWorkspace {
            let convs = rows.filter { $0.workspaceId == ws.id }.compactMap(node)
            let p = placement(d, ws, myOrgs: mine)
            let kind: GroupsTree.Kind
            let org: OrganizationDTO?
            var name: String
            var pending = false
            switch p {
            case .mine(let id): kind = .mine; org = self.org(d, id); name = org?.name ?? ""
                if !mineOrder.contains(id) { mineOrder.append(id) }
            case .relation(let id): kind = .relations; org = self.org(d, id); name = org?.name ?? L("common.noCompany")
            case .pending(let n): kind = .relations; org = nil; name = n; pending = true
            case .guest(let id): kind = .guest; org = self.org(d, id); name = org?.name ?? L("common.noCompany")
            }
            // Un espacio sin grupos no aparece; una relación pendiente sin grupos sí (con Todo y sin buscar, o si su nombre coincide).
            if convs.isEmpty && !(pending && tab == .all && (q.isEmpty || fold(name).contains(q))) { continue }
            let key = p.companyKey
            // Un pendiente con el mismo nombre que otro: se muestra con el nombre tal como se escribió la primera vez.
            if let prev = companies[kind]?[key] { name = prev.name }
            var co = companies[kind]?[key] ?? .init(id: key, org: org, name: name, pending: pending, workspaces: [])
            co.workspaces.append(.init(ws: ws))
            co.groups += convs
            companies[kind, default: [:]][key] = co
        }
        func finish(_ list: [GroupsTree.CompanyNode]) -> [GroupsTree.CompanyNode] {
            list.map { var c = $0
                c.groups.sort { HomeOrder.before($0.conv, $1.conv) }
                // Dos grupos de la misma empresa con el mismo nombre: «{espacio} · {grupo}» (nunca en el espacio casa).
                let counts = Dictionary(grouping: c.groups, by: { fold(title(d, $0.conv)) }).mapValues(\.count)
                for i in c.groups.indices where (counts[fold(title(d, c.groups[i].conv))] ?? 0) > 1 {
                    if let ws = d.workspaces.first(where: { $0.id == c.groups[i].conv.workspaceId }), !ws.isOrgHome {
                        c.groups[i].label = "\(ws.name) · \(title(d, c.groups[i].conv))"
                    }
                }
                return c
            }
            .sorted { a, b in
                let ra = HomeOrder.rank(a.groups.map(\.conv)), rb = HomeOrder.rank(b.groups.map(\.conv))
                return ra == rb ? a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending : HomeOrder.rankBefore(ra, rb)
            }
        }
        // Tu organización: una sección por cada empresa mía (la principal primero) aunque aún no tenga grupos.
        let mineMap = companies[.mine] ?? [:]
        var mineIds = myOrgsOrdered(d).map(\.id)
        mineIds += mineOrder.filter { !mineIds.contains($0) }
        for id in mineIds {
            let co = mineMap[id]
            if co == nil && !showEmpty { continue }
            tree.sections.append(.init(id: "mine:\(id)", kind: .mine, org: self.org(d, id), companies: co.map { finish([$0]) } ?? []))
        }
        let rel = finish(Array((companies[.relations] ?? [:]).values))
        if !rel.isEmpty || showEmpty { tree.sections.append(.init(id: "relations", kind: .relations, org: nil, companies: rel)) }
        let guest = finish(Array((companies[.guest] ?? [:]).values))
        if !guest.isEmpty { tree.sections.append(.init(id: "guest", kind: .guest, org: nil, companies: guest)) }
        if filterWorkspace == nil {
            let wsIds = Set(d.workspaces.map(\.id))
            let orphans = rows.filter { !($0.workspaceId.map(wsIds.contains) ?? false) }.sorted(by: HomeOrder.before).compactMap(node)
            if !orphans.isEmpty { tree.sections.append(.init(id: "other", kind: .other, org: nil, companies: [], orphans: orphans)) }
        }
        return tree
    }

    // MARK: DMs

    /// DMs: directos y chats grupales, incluidos los sidechats, en el orden de Inicio (compareConversations).
    /// Los hilos de un directo o chat grupal (deriveKind 'same', sin espacio) no se listan: viven en la barra del chat.
    static func dms(_ d: BootstrapDTO, query: String = "") -> [ConversationDTO] {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        return d.conversations.filter { $0.kind.isChat && !isThread($0) }
            .filter { c in q.isEmpty || ([title(d, c), subtitle(d, c)] + c.memberIds.compactMap { person(d, $0)?.name }).contains { fold($0).contains(q) } }
            .sorted(by: HomeOrder.before)
    }

    /// Título de un sidechat en DMs, donde ya lleva su burbuja: sin el prefijo «Sidechat · » / «Consulta · ».
    static func sideRowTitle(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        let t = title(d, c)
        guard isSide(c) else { return t }
        let stripped = t.replacingOccurrences(of: #"^(Sidechat|Consulta)\s*·\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
        return stripped.isEmpty ? t : stripped
    }

    /// Origen visible de un sidechat («desde #Nombre del grupo»).
    static func sideOrigin(_ d: BootstrapDTO, _ c: ConversationDTO) -> ConversationDTO? {
        guard isSide(c), let p = c.parentId else { return nil }
        return d.conversations.first { $0.id == p }
    }

    /// Globo de la pestaña Grupos: no leídos de conversaciones con espacio (no silenciadas).
    static func groupsUnread(_ d: BootstrapDTO) -> Int { unreadCount(d.conversations.filter { $0.workspaceId != nil && !$0.kind.isChat }) }
    /// Respuestas sin leer de los hilos de cada directo o chat grupal (chip «💬 N» en su fila de DMs).
    static func chatThreadUnread(_ d: BootstrapDTO) -> [String: Int] {
        var out: [String: Int] = [:]
        for t in d.conversations where t.kind.isChat && isThread(t) { if let p = t.parentId { out[p, default: 0] += HomeOrder.pending(t) } }
        return out
    }

    /// Globo de la pestaña DMs: no leídos de directos y chats (sidechats e hilos de chats incluidos).
    static func dmsUnread(_ d: BootstrapDTO) -> Int { unreadCount(d.conversations.filter { $0.kind.isChat }) }
}

// MARK: - Códigos de invitación

/// Código corto de invitación (K7QM-4XPA): 8 caracteres sin los que se confunden (0/O, 1/I/L), igual que el API.
enum InviteCode {
    static let alphabet = Set("ABCDEFGHJKMNPQRSTUVWXYZ23456789")

    /// Lo que la persona escribió (minúsculas, espacios, sin guion) → "K7QM4XPA", o nil si no parece un código.
    static func normalize(_ raw: String) -> String? {
        let s = raw.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        return s.count == 8 && s.allSatisfy(alphabet.contains) ? s : nil
    }

    /// "K7QM-4XPA" (nil si no es un código).
    static func format(_ raw: String) -> String? {
        normalize(raw).map { "\($0.prefix(4))-\($0.suffix(4))" }
    }

    /// Mientras se escribe: mayúsculas, solo letras y números y el guion tras el cuarto carácter.
    static func typing(_ raw: String) -> String {
        let s = String(raw.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(8))
        return s.count > 4 ? "\(s.prefix(4))-\(s.dropFirst(4))" : s
    }

    /// Código escrito o enlace pegado (…/invite/<token>): lo que se manda a /invitations/{…}.
    static func lookupKey(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = t.range(of: "/invite/") {
            let token = t[r.upperBound...].split(whereSeparator: { "?#/ ".contains($0) }).first.map(String.init) ?? ""
            return token.isEmpty ? nil : token
        }
        return format(t)
    }
}

/// Correos de «Invitar de fuera»: separados por coma, punto y coma o espacios.
enum InviteEmails {
    static func parse(_ raw: String) -> (valid: [String], invalid: [String]) {
        var valid: [String] = [], invalid: [String] = []
        for part in raw.split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace }) {
            let e = part.trimmingCharacters(in: CharacterSet(charactersIn: "<>\"'")).lowercased()
            guard !e.isEmpty else { continue }
            if e.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil {
                if !valid.contains(e) { valid.append(e) }
            } else { invalid.append(e) }
        }
        return (valid, invalid)
    }
}

// MARK: - DTOs

/// Respuesta de POST /groups.
struct CreateGroupResultDTO: Decodable, Sendable {
    var workspaceId: String
    var conversationId: String
    var invited: Int
    /// Con shareLink: el enlace y el código para compartir.
    var inviteUrl: String?
    var inviteCode: String?
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        workspaceId = c.v("workspaceId", "")
        conversationId = c.v("conversationId", "")
        invited = c.int("invited")
        inviteUrl = c.o("inviteUrl")
        inviteCode = c.o("inviteCode")
    }
}

/// Respuesta de crear una invitación: `url` para compartir y, sin correo, `code` para escribir en la app.
struct InvitationCreatedDTO: Decodable, Sendable {
    var id: String
    var token: String
    var url: String
    var code: String?
    var expiresAt: String
    var emailSent: Bool
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        id = c.v("id", "")
        token = c.v("token", "")
        url = c.v("url", "")
        code = c.o("code")
        expiresAt = c.v("expiresAt", "")
        emailSent = c.v("emailSent", false)
    }
}

/// Supervisión: un grupo donde participa gente de mi empresa.
struct OversightGroupDTO: Decodable, Identifiable, Sendable {
    var conversationId: String
    var name: String?
    var kind: String
    var workspaceId: String
    var workspaceName: String
    var owningOrgId: String
    var organizationIds: [String]
    var memberCount: Int
    var myOrgMemberIds: [String]
    var lastMessageAt: String?
    var iAmMember: Bool
    var id: String { conversationId }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        conversationId = try c.decode(String.self, forKey: AnyKey("conversationId"))
        name = c.o("name")
        kind = c.v("kind", "group")
        workspaceId = c.v("workspaceId", "")
        workspaceName = c.v("workspaceName", "")
        owningOrgId = c.v("owningOrgId", "")
        organizationIds = c.v("organizationIds", [])
        memberCount = c.int("memberCount")
        myOrgMemberIds = c.v("myOrgMemberIds", [])
        lastMessageAt = c.o("lastMessageAt")
        iAmMember = c.v("iAmMember", false)
    }
}

struct OversightDTO: Decodable, Sendable {
    var orgId: String
    var groups: [OversightGroupDTO]
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        orgId = c.v("orgId", "")
        groups = c.lossyArray("groups")
    }
}

// MARK: - API

/// Destino del «+» de Grupos (POST /groups).
enum GroupTarget: Equatable {
    /// Grupo interno de mi empresa (espacio casa; el API lo crea si falta).
    case org(orgId: String?)
    /// Grupo dentro de una relación existente.
    case workspace(String)
    /// Relación nueva con otra empresa.
    case company(name: String, orgId: String?)

    var json: [String: Any] {
        var j: [String: Any]
        switch self {
        case .org(let id): j = ["kind": "org"]; if let id { j["orgId"] = id }
        case .workspace(let id): j = ["kind": "workspace", "workspaceId": id]
        case .company(let name, let id): j = ["kind": "company", "companyName": name.trimmingCharacters(in: .whitespaces)]; if let id { j["orgId"] = id }
        }
        return j
    }
}

extension AppStore {
    /// El «+» de Grupos. Recarga el snapshot para que el grupo ya esté en la lista al abrirlo.
    func createGroup(name: String, target: GroupTarget, memberIds: [String], inviteEmails: [String], inviteRole: String, shareLink: Bool) async throws -> CreateGroupResultDTO {
        let body: [String: Any] = ["name": String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120)), "target": target.json,
                                   "memberIds": memberIds, "inviteEmails": inviteEmails, "inviteRole": inviteRole,
                                   "shareLink": shareLink, "lang": L10n.lang]
        let r: CreateGroupResultDTO = try await api.request("/groups", method: "POST", json: body)
        try await loadBootstrap()
        return r
    }

    /// Invitación a un espacio (y sus grupos): por correo, o sin correo como enlace y código para varias personas.
    func createInvitation(workspaceId: String, conversationIds: [String], email: String?, role: String) async throws -> InvitationCreatedDTO {
        var body: [String: Any] = ["role": role, "conversationIds": conversationIds, "history": "all", "lang": L10n.lang]
        if let email { body["email"] = email } else { body["multiUse"] = true; body["expiresInDays"] = 14 }
        return try await api.request("/workspaces/\(workspaceId)/invitations", method: "POST", json: body)
    }

    /// Invitar a mi empresa por correo (owner/admin).
    func createOrgInvitation(orgId: String, email: String) async throws {
        try await api.requestData("/organizations/\(orgId)/invitations", method: "POST", json: ["email": email, "role": "member", "lang": L10n.lang])
    }

    struct ArchiveResult: Decodable {
        var archived: Bool; var workspaceArchived: Bool
        init(from d: Decoder) throws { let c = try container(d); archived = c.v("archived", false); workspaceArchived = c.v("workspaceArchived", false) }
    }

    /// Archivar grupo (canManage): sale de la lista de todos; si era el último de un espacio que no es casa, el espacio también.
    @discardableResult
    func archiveGroup(_ conversationId: String) async throws -> ArchiveResult {
        let r: ArchiveResult = try await api.request("/conversations/\(conversationId)/archive", method: "POST", json: [:])
        homePath.removeAll { $0 == .conversation(conversationId) || $0 == .details(conversationId) }
        try await loadBootstrap()
        return r
    }

    func loadOversight(orgId: String) async throws -> OversightDTO {
        try await api.request("/organizations/\(orgId)/oversight")
    }

    /// Lectura de supervisión: mensajes de un grupo donde no soy miembro (no pasa por la caché de conversaciones).
    func readOnlyMessages(_ conversationId: String, before: Int? = nil) async throws -> MessagesPage {
        try await api.request("/conversations/\(conversationId)/messages?limit=50" + (before.map { "&before=\($0)" } ?? ""))
    }

    /// Asuntos abiertos de mi alcance (bajo cada grupo del árbol). Al iniciar y cuando cambia el alcance.
    func loadOpenIssues() async {
        guard status == .ready else { return }
        _ = try? await loadIssues(open: true)
    }

    func isGuest(_ conversationId: String) -> Bool {
        guard let d = data, let c = meta(conversationId) else { return false }
        return Naming.isGuest(d, c)
    }
}
