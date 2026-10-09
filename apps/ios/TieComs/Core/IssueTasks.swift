import Foundation

/// Tareas derivadas de un asunto y su visibilidad (docs/TAREAS.md): un solo nivel (las tareas no tienen subtareas).
/// Mismas reglas que la web (Issues.tsx: childrenOf, tops, defaultVisibility, TaskQuickAdd).
enum IssueTasks {
    /// Tareas hijas que veo (el servidor solo manda esas): primero las abiertas, luego por creación.
    static func children(_ all: [String: IssueDTO], of parentId: String) -> [IssueDTO] {
        all.values.filter { $0.parentIssueId == parentId }.sorted { a, b in
            if a.status.closed != b.status.closed { return !a.status.closed }
            return a.createdAt < b.createdAt
        }
    }

    /// «☑ 1/3»: hechas y total (nil sin tareas).
    static func progress(_ all: [String: IssueDTO], of parentId: String) -> (done: Int, total: Int)? {
        let k = children(all, of: parentId)
        return k.isEmpty ? nil : (k.filter { $0.status.closed }.count, k.count)
    }

    /// Principales de una lista: los que no son hijos, o hijos cuyo asunto no está en la lista (o no lo veo).
    static func tops(_ list: [IssueDTO], _ all: [String: IssueDTO]) -> [IssueDTO] {
        let ids = Set(list.map(\.id))
        return list.filter { i in
            guard let p = i.parentIssueId else { return true }
            return all[p] == nil || !ids.contains(p)
        }
    }

    /// Lo que se lista en un chat: sus asuntos principales; las tareas de un asunto de este chat van debajo de él
    /// (aunque vivan en un sidechat). Las tareas de un asunto de otro chat (sidechat) se muestran sueltas.
    static func listed(in conversationId: String, _ all: [String: IssueDTO]) -> [IssueDTO] {
        let here = all.values.filter { $0.conversationId == conversationId }
        return tops(Array(here), all).filter { i in
            guard let p = i.parentIssueId else { return true }
            return all[p]?.conversationId != conversationId
        }
    }

    /// Clave de la sección «Personal · solo tú» en Asuntos › Por grupo.
    static let personalKey = "__personal"

    /// La conversación donde se agrupa (Asuntos › Por grupo): la de su asunto, si lo veo; los personales, aparte.
    static func groupConversation(_ i: IssueDTO, _ all: [String: IssueDTO]) -> String {
        if let p = i.parentIssueId, let parent = all[p] { return parent.conversationId ?? personalKey }
        return i.conversationId ?? personalKey
    }

    /// Visibilidad por defecto: si en el chat hay más de una empresa, «solo mi empresa».
    static func defaultVisibility(members: [PersonDTO], myOrg: String?) -> IssueVisibility {
        let orgs = Set(members.map { $0.orgId ?? "guest" })
        return orgs.count > 1 && myOrg != nil ? .org : .all
    }

    /// Si quien la hace no está en el chat, no puede ser «de todo el chat»: queda privada.
    static func effective(_ v: IssueVisibility, outsider: Bool) -> IssueVisibility { outsider && v == .all ? .private : v }

    /// «Solo Xertify» / «Privada» / «Todo el chat».
    static func label(_ v: IssueVisibility, orgName: String?) -> String {
        switch v {
        case .org: return L("task.visOrg", ["org": orgName ?? ""])
        case .private: return L("task.visPrivate")
        case .all: return L("task.visAll")
        }
    }
}

/// Independent dimensions: OR within a dimension, AND between responsible people and statuses.
struct IssueTaskFilter: Equatable {
    static let me = "__me"
    static let unassigned = "__unassigned"
    static let pending: Set<IssueStatus> = [.open, .in_progress, .waiting]
    var assignees: Set<String> = [me]
    var statuses: Set<IssueStatus> = pending
    var onlyClosed: Bool { !statuses.isEmpty && statuses.allSatisfy(\.closed) }

    func matches(_ issue: IssueDTO, me: String) -> Bool {
        let people = Set(assignees.map { $0 == Self.me ? me : $0 })
        let personMatches = people.isEmpty || !people.isDisjoint(with: issue.assignedIds)
            || (people.contains(Self.unassigned) && issue.assignedIds.isEmpty)
        return personMatches && (statuses.isEmpty || statuses.contains(issue.status))
    }
    func apply(_ list: [IssueDTO], me: String) -> [IssueDTO] {
        var seen = Set<String>()
        return list.filter { matches($0, me: me) && seen.insert($0.id).inserted }
    }
}
