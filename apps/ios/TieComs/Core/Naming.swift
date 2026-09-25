import Foundation

/// Selectores sobre el snapshot (mismas reglas que apps/web/src/ui.tsx).
enum Naming {
    static func org(_ d: BootstrapDTO, _ id: String?) -> OrganizationDTO? {
        guard let id else { return nil }
        return d.organizations.first { $0.id == id }
    }

    static func person(_ d: BootstrapDTO, _ id: String?) -> PersonDTO? {
        guard let id else { return nil }
        return d.people.first { $0.id == id }
    }

    static func otherInDirect(_ d: BootstrapDTO, _ c: ConversationDTO) -> PersonDTO? {
        person(d, c.memberIds.first { $0 != d.me.id })
    }

    /// `group` usa `name`; `internal` igual (con candado en la interfaz); `direct` = la otra persona.
    static func title(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        switch c.kind {
        case .direct: return otherInDirect(d, c)?.name ?? L("chat.aDirect")
        case .internal:
            // Nombre por defecto del sistema: se muestra en el idioma de quien lee.
            if c.name == "Equipo interno" { return L("conv.defaultInternal") }
            return c.name ?? L("conv.defaultInternal")
        case .group: return c.name ?? L("chat.aConversation")
        case .multi:
            if let n = c.name, !n.isEmpty { return n }
            return multiTitle(d, c)
        }
    }

    /// Chat grupal sin nombre: primeros nombres de los demás («Mateo, Ana, Laura y 2 más»).
    static func multiTitle(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        let names = c.memberIds.filter { $0 != d.me.id }.compactMap { person(d, $0)?.name.split(separator: " ").first.map(String.init) }
        if names.isEmpty { return L("chat.groupChat") }
        if names.count > 3 { return names.prefix(3).joined(separator: ", ") + " " + L("chat.andMore", ["n": names.count - 3]) }
        return names.joined(separator: ", ")
    }

    /// Personas del chat distintas de mí (para avatares apilados).
    static func others(_ d: BootstrapDTO, _ c: ConversationDTO) -> [PersonDTO] {
        c.memberIds.filter { $0 != d.me.id }.compactMap { person(d, $0) }
    }

    /// Empresas que participan en la conversación (por sus miembros).
    static func companies(_ d: BootstrapDTO, _ c: ConversationDTO) -> [OrganizationDTO] {
        var seen = Set<String>()
        var out: [OrganizationDTO] = []
        for id in c.memberIds {
            guard let p = person(d, id), let oid = p.orgId, !seen.contains(oid), let o = org(d, oid) else { continue }
            seen.insert(oid)
            out.append(o)
        }
        if out.isEmpty, let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) {
            out = ws.organizationIds.compactMap { org(d, $0) }
        }
        return out
    }

    static func subtitle(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        if c.kind == .direct {
            guard let other = otherInDirect(d, c) else { return "" }
            return [other.title, org(d, other.orgId)?.name ?? (other.guest ? L("common.guest") : nil)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
        if c.kind == .multi {
            let orgs = companies(d, c).prefix(3).map(\.name).joined(separator: ", ")
            return [L("chat.groupChat"), orgs].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        return companies(d, c).map(\.name).joined(separator: " · ")
    }

    /// «cargo · área» de una persona (vacío si no tiene ninguno).
    static func roleLine(_ p: PersonDTO) -> String {
        [p.title, p.area].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    struct OrgGroup: Identifiable {
        /// id de la empresa, o "_guests" para terceros sin empresa.
        var id: String
        var org: OrganizationDTO?
        var isMine: Bool
        var people: [PersonDTO]
    }

    /// Personas para un chat nuevo: solo humanas, sin mí ni `exclude`, filtradas por nombre, cargo, área o empresa,
    /// agrupadas: primero mi empresa, luego las demás por nombre y al final los terceros (como PeoplePicker de la web).
    static func peopleByOrg(_ d: BootstrapDTO, query: String, exclude: Set<String> = []) -> [OrgGroup] {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        let people = d.people.filter { $0.kind == "human" && $0.id != d.me.id && !exclude.contains($0.id) }
            .filter { p in q.isEmpty || [p.name, p.title, p.area, org(d, p.orgId)?.name].compactMap { $0 }.contains { fold($0).contains(q) } }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        var groups: [String: [PersonDTO]] = [:]
        for p in people { groups[p.orgId.flatMap { org(d, $0) == nil ? nil : $0 } ?? "_guests", default: []].append(p) }
        let mine = d.me.primaryOrgId
        return groups.map { OrgGroup(id: $0.key, org: org(d, $0.key), isMine: $0.key == mine, people: $0.value) }
            .sorted { a, b in
                if a.isMine != b.isMine { return a.isMine }
                if (a.id == "_guests") != (b.id == "_guests") { return b.id == "_guests" }
                return (a.org?.name ?? "").localizedCaseInsensitiveCompare(b.org?.name ?? "") == .orderedAscending
            }
    }

    static func authorLine(_ d: BootstrapDTO, _ authorId: String) -> (name: String, org: String?) {
        guard let p = person(d, authorId) else { return (L("chat.formerParticipant"), nil) }
        return (p.name, org(d, p.orgId)?.name ?? (p.guest ? L("common.guest") : nil))
    }

    struct Section: Identifiable {
        var id: String
        var title: String
        var workspace: WorkspaceDTO?
        var conversations: [ConversationDTO]
    }

    /// Inicio: por espacio (grupos e internos); directos y chats grupales juntos al final.
    static func sections(_ d: BootstrapDTO, filterWorkspace: String?, query: String) -> [Section] {
        let q = query.trimmingCharacters(in: .whitespaces).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        func matches(_ c: ConversationDTO) -> Bool {
            guard !q.isEmpty else { return true }
            var hay = [title(d, c), subtitle(d, c)]
            if let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) { hay.append(ws.name) }
            hay += c.memberIds.compactMap { person(d, $0)?.name }
            return hay.contains { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).contains(q) }
        }
        let byActivity: (ConversationDTO, ConversationDTO) -> Bool = { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
        var out: [Section] = []
        // Fijadas arriba (preferencia personal), fuera de su espacio.
        let pinned = d.conversations.filter { $0.pinnedAt != nil && (filterWorkspace == nil || $0.workspaceId == filterWorkspace) && matches($0) }
            .sorted { ($0.pinnedAt ?? "") < ($1.pinnedAt ?? "") }
        let pinnedIds = Set(pinned.map(\.id))
        if !pinned.isEmpty { out.append(Section(id: "_pinned", title: L("side.pinned"), workspace: nil, conversations: pinned)) }
        let workspaces = d.workspaces
            .filter { filterWorkspace == nil || $0.id == filterWorkspace }
            .sorted { a, b in
                if (a.pinnedAt != nil) != (b.pinnedAt != nil) { return a.pinnedAt != nil }
                let la = d.conversations.filter { $0.workspaceId == a.id }.compactMap(\.lastMessageAt).max() ?? a.createdAt
                let lb = d.conversations.filter { $0.workspaceId == b.id }.compactMap(\.lastMessageAt).max() ?? b.createdAt
                return la > lb
            }
        for ws in workspaces {
            let convs = d.conversations.filter { $0.workspaceId == ws.id && !$0.kind.isChat && !pinnedIds.contains($0.id) && matches($0) }.sorted(by: byActivity)
            if !convs.isEmpty { out.append(Section(id: ws.id, title: ws.name, workspace: ws, conversations: convs)) }
        }
        if filterWorkspace == nil {
            let wsIds = Set(d.workspaces.map(\.id))
            let orphans = d.conversations.filter { c in !c.kind.isChat && !pinnedIds.contains(c.id) && !(c.workspaceId.map(wsIds.contains) ?? false) && matches(c) }
            if !orphans.isEmpty { out.append(Section(id: "_other", title: L("home.other"), workspace: nil, conversations: orphans.sorted(by: byActivity))) }
            let directs = d.conversations.filter { $0.kind.isChat && !pinnedIds.contains($0.id) && matches($0) }.sorted(by: byActivity)
            if !directs.isEmpty { out.append(Section(id: "_directs", title: L("home.directs"), workspace: nil, conversations: directs)) }
        }
        return out
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(whereSeparator: \.isWhitespace)
        let a = parts.first?.first.map(String.init) ?? ""
        let b = parts.count > 1 ? parts.last?.first.map(String.init) ?? "" : ""
        return (a + b).uppercased()
    }
}

// MARK: - Jerarquía de Inicio: Empresa → Espacio → Conversaciones (→ laterales) y Chats
// Misma agrupación que la barra lateral de la web (apps/web/src/screens/Shell.tsx):
// cada espacio va con su empresa "contraparte" (counterpartOrg) y dentro sus conversaciones.

struct HomeTree {
    struct ConvNode: Identifiable { var conv: ConversationDTO; var sides: [ConversationDTO]; var id: String { conv.id } }
    struct WsNode: Identifiable { var ws: WorkspaceDTO; var convs: [ConvNode]; var id: String { ws.id } }
    struct CompanyNode: Identifiable { var id: String; var org: OrganizationDTO?; var workspaces: [WsNode] }
    var pinned: [ConversationDTO] = []
    var companies: [CompanyNode] = []
    var chats: [ConvNode] = []

    var isEmpty: Bool { pinned.isEmpty && companies.isEmpty && chats.isEmpty }
}

extension Naming {
    /// Empresa "contraparte" de un espacio desde mi punto de vista (counterpartOrg de la web).
    static func counterpartOrg(_ d: BootstrapDTO, _ ws: WorkspaceDTO) -> OrganizationDTO? {
        let mine = Set(d.organizations.filter { $0.myRole != nil }.map(\.id))
        let other = ws.organizationIds.first { !mine.contains($0) }
        return org(d, other ?? ws.owningOrgId)
    }

    /// Conversación lateral (consulta privada que cuelga de un mensaje).
    static func isSide(_ c: ConversationDTO) -> Bool { c.deriveKind == "side" }

    /// «Empresa · Espacio» para la cabecera del chat (nil fuera de un espacio).
    static func route(_ d: BootstrapDTO, _ c: ConversationDTO) -> String? {
        guard let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) else { return nil }
        return [counterpartOrg(d, ws)?.name, ws.name].compactMap { $0 }.joined(separator: " · ")
    }

    static func unreadCount(_ list: [ConversationDTO]) -> Int { list.reduce(0) { $0 + ($1.isMuted ? 0 : $1.unread) } }

    static func homeTree(_ d: BootstrapDTO, query: String = "", filterWorkspace: String? = nil) -> HomeTree {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        func matches(_ c: ConversationDTO) -> Bool {
            guard !q.isEmpty else { return true }
            var hay = [title(d, c), subtitle(d, c)]
            if let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) { hay.append(ws.name); if let o = counterpartOrg(d, ws) { hay.append(o.name) } }
            hay += c.memberIds.compactMap { person(d, $0)?.name }
            return hay.contains { fold($0).contains(q) }
        }
        let visible = Set(d.conversations.map(\.id))
        // Laterales cuyo origen veo: cuelgan de él; si no, van con los chats.
        let sides = d.conversations.filter { isSide($0) && $0.parentId.map(visible.contains) == true }
        let sideIds = Set(sides.map(\.id))
        func sidesOf(_ id: String) -> [ConversationDTO] {
            sides.filter { $0.parentId == id }.sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
        }
        func node(_ c: ConversationDTO) -> HomeTree.ConvNode? {
            let s = sidesOf(c.id).filter(matches)
            guard matches(c) || !s.isEmpty else { return nil }
            return HomeTree.ConvNode(conv: c, sides: s)
        }
        var tree = HomeTree()
        if filterWorkspace == nil {
            tree.pinned = d.conversations.filter { $0.pinnedAt != nil && !sideIds.contains($0.id) && matches($0) }.sorted { ($0.pinnedAt ?? "") < ($1.pinnedAt ?? "") }
        }
        var order: [String] = []
        var byOrg: [String: HomeTree.CompanyNode] = [:]
        for ws in d.workspaces where filterWorkspace == nil || ws.id == filterWorkspace {
            let convs = d.conversations.filter { $0.workspaceId == ws.id && $0.kind != .direct && $0.kind != .multi && !sideIds.contains($0.id) }
                .sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
                .compactMap(node)
            let wsMatches = !q.isEmpty && fold(ws.name).contains(q)
            if convs.isEmpty && !(q.isEmpty || wsMatches) { continue }
            let o = counterpartOrg(d, ws)
            let key = o?.id ?? "none"
            if byOrg[key] == nil { order.append(key); byOrg[key] = HomeTree.CompanyNode(id: key, org: o, workspaces: []) }
            byOrg[key]!.workspaces.append(HomeTree.WsNode(ws: ws, convs: convs))
        }
        tree.companies = order.compactMap { byOrg[$0] }.map { var c = $0
            c.workspaces.sort { a, b in
                if (a.ws.pinnedAt != nil) != (b.ws.pinnedAt != nil) { return a.ws.pinnedAt != nil }
                return a.ws.name.localizedCaseInsensitiveCompare(b.ws.name) == .orderedAscending
            }
            return c
        }
        if filterWorkspace == nil {
            let wsIds = Set(d.workspaces.map(\.id))
            tree.chats = d.conversations
                .filter { ($0.kind == .direct || $0.kind == .multi || !($0.workspaceId.map(wsIds.contains) ?? false)) && !sideIds.contains($0.id) }
                .sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
                .compactMap(node)
        }
        return tree
    }
}
