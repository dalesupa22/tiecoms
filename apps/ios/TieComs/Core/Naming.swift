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
        }
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
        return companies(d, c).map(\.name).joined(separator: " · ")
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

    /// Inicio: por espacio (grupos e internos), directos al final.
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
            let convs = d.conversations.filter { $0.workspaceId == ws.id && $0.kind != .direct && !pinnedIds.contains($0.id) && matches($0) }.sorted(by: byActivity)
            if !convs.isEmpty { out.append(Section(id: ws.id, title: ws.name, workspace: ws, conversations: convs)) }
        }
        if filterWorkspace == nil {
            let wsIds = Set(d.workspaces.map(\.id))
            let orphans = d.conversations.filter { c in c.kind != .direct && !pinnedIds.contains(c.id) && !(c.workspaceId.map(wsIds.contains) ?? false) && matches(c) }
            if !orphans.isEmpty { out.append(Section(id: "_other", title: L("home.other"), workspace: nil, conversations: orphans.sorted(by: byActivity))) }
            let directs = d.conversations.filter { $0.kind == .direct && !pinnedIds.contains($0.id) && matches($0) }.sorted(by: byActivity)
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
