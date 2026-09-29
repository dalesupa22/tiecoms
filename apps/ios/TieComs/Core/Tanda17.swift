import Foundation

// Tanda 1.7: comentarios de eventos (docs/TANDA-1.7.md §5) y las refs #grupo (§1).

struct EventCommentsPage: Decodable, Sendable {
    var comments: [EventCommentDTO]
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        comments = c.lossyArray("comments")
    }
}

extension AppStore {
    func eventComments(_ id: String) async throws -> [EventCommentDTO] {
        let r: EventCommentsPage = try await api.request("/events/\(id)/comments")
        return r.comments
    }

    /// Comentar un evento; el aviso agrupado del chat lo pone el servidor.
    @discardableResult
    func commentEvent(_ id: String, body: String) async throws -> EventCommentDTO? {
        let data = try await api.requestData("/events/\(id)/comments", method: "POST", json: ["body": body])
        let c = try? JSONDecoder().decode(EventCommentDTO.self, from: data)
        if var e = events[id] {
            e.commentCount += 1
            if let c { e.lastComments = Array((e.lastComments + [c]).suffix(2)) }
            events[id] = e
        }
        return c
    }

    /// Nombre con que se guardó una ref (lo que dice el texto del mensaje).
    func refName(_ conversationId: String) -> String {
        for s in conversations.values { for m in s.messages { if let r = m.refs.first(where: { $0.conversationId == conversationId }) { return r.name } } }
        return ""
    }
}
