import Foundation

/// Búsqueda rápida de Grupos, DMs y «Mensaje nuevo»: personas, grupos y chats a la vez, para escribirle a alguien
/// o entrar a un grupo sin pasar por su empresa. Una persona sin directo también sale: al tocarla se abre (POST /chats).
enum QuickSearch {
    struct Results: Equatable {
        var people: [PersonDTO] = []
        var groups: [ConversationDTO] = []
        var chats: [ConversationDTO] = []
        var isEmpty: Bool { people.isEmpty && groups.isEmpty && chats.isEmpty }
    }

    private static func fold(_ s: String) -> String { s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }

    /// Personas (humanas, sin mí) cuyo nombre, cargo, área o empresa coincide; primero con las que ya hablo.
    static func people(_ d: BootstrapDTO, query: String, exclude: Set<String> = []) -> [PersonDTO] {
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        guard !q.isEmpty else { return [] }
        let order = recentPeopleIds(d)
        let rank = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($1, $0) })
        return d.people
            .filter { $0.kind == "human" && $0.id != d.me.id && !exclude.contains($0.id) }
            .filter { p in [p.name, p.title, p.area, Naming.org(d, p.orgId)?.name].compactMap { $0 }.contains { fold($0).contains(q) } }
            .sorted { a, b in
                // Quien empieza con lo escrito va antes que quien solo lo contiene (Ana antes que Mariana).
                let pa = fold(a.name).hasPrefix(q), pb = fold(b.name).hasPrefix(q)
                if pa != pb { return pa }
                let ra = rank[a.id] ?? .max, rb = rank[b.id] ?? .max
                if ra != rb { return ra < rb }
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
    }

    /// Grupos (con espacio, sin hilos) por nombre, espacio o empresa de la otra parte.
    static func groups(_ d: BootstrapDTO, query: String) -> [ConversationDTO] {
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        guard !q.isEmpty else { return [] }
        return d.conversations.filter { Naming.isGroupRow($0) && !Naming.isThread($0) }
            .filter { c in
                var hay = [Naming.title(d, c)]
                if let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) {
                    hay.append(ws.name)
                    if let n = ws.counterpartName { hay.append(n) }
                    if let o = Naming.counterpartOrg(d, ws) { hay.append(o.name) }
                }
                return hay.contains { fold($0).contains(q) }
            }
            .sorted(by: HomeOrder.before)
    }

    static func run(_ d: BootstrapDTO, query: String) -> Results {
        Results(people: people(d, query: query), groups: groups(d, query: query), chats: Naming.dms(d, query: query))
    }

    /// El directo que ya tengo con esa persona (si existe).
    static func direct(_ d: BootstrapDTO, with personId: String) -> ConversationDTO? {
        d.conversations.first { $0.kind == .direct && $0.memberIds.contains(personId) && !Naming.isThread($0) }
    }

    /// Personas de mis directos, de la conversación más reciente a la más vieja (fila «Recientes»).
    static func recentPeopleIds(_ d: BootstrapDTO) -> [String] {
        var seen = Set<String>()
        return d.conversations.filter { $0.kind == .direct && !Naming.isThread($0) }
            .sorted { HomeOrder.activity($0) > HomeOrder.activity($1) }
            .compactMap { c in c.memberIds.first { $0 != d.me.id } }
            .filter { id in Naming.person(d, id)?.kind == "human" && seen.insert(id).inserted }
    }
}
