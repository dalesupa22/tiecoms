import Foundation

extension AppStore {
    /// Loads until the unread boundary is present. Repeated/empty pages and network failures fail closed.
    func firstUnreadMessage(_ id: String, snapshot: ChatNav.Snapshot, eligible: ((MessageDTO) -> Bool)? = nil) async throws -> MessageDTO? {
        let stamp = sessionStamp
        guard snapshot.unread > 0 else { return nil }
        while true {
            try requireSession(stamp)
            guard let state = conversations[id], state.loaded, !state.loading else { throw ChatNav.PositionError.historyGap }
            let floor = max(snapshot.lastReadSeq, meta(id)?.historyFromSeq ?? 0)
            if let first = state.messages.first, first.seq <= floor + 1 {
                let after = state.messages.filter { $0.seq > floor }
                var cursor = floor
                for message in after {
                    guard message.seq == cursor + 1 else { throw ChatNav.PositionError.historyGap }
                    cursor = message.seq
                    if !message.isSystem && message.deletedAt == nil && message.authorId != me?.id && !blockedUserIds.contains(message.authorId) && (eligible?(message) ?? true) { return message }
                }
                if cursor >= (meta(id)?.lastMessageSeq ?? Int.max) { return nil }
                throw ChatNav.PositionError.historyGap
            }
            guard state.hasMore, await loadOlder(id) else { throw ChatNav.PositionError.historyGap }
        }
    }

    /// Explicit list action: acknowledge only server-confirmed rows, preserving messages arriving in flight.
    func markTreeRead(_ rootId: String) async throws {
        guard let d = data, let root = meta(rootId) else { return }
        let stamp = sessionStamp
        let items = ReadTree.Index(d).items(for: root)
        let revisions = Dictionary(uniqueKeysWithValues: items.map { ($0.conversationId, readRevision($0.conversationId)) })
        func applyConfirmed(_ id: String, _ seq: Int, _ revision: Int?) {
            guard applyConfirmedRead(id, seq: seq, revision: revision, legacyRevision: revisions[id] ?? -1) else { return }
            if seq >= (meta(id)?.lastMessageSeq ?? Int.max) { AppFeedback.shared.clearNotifications(conversationId: id) }
        }
        do {
            let r: ReadTreeResult = try await api.request("/conversations/\(rootId)/read-tree", method: "POST", json: ["items": items.map(\.json)])
            try requireSession(stamp)
            for m in r.marked { applyConfirmed(m.conversationId, m.lastReadSeq, m.readRevision) }
        } catch let e as ApiRequestError where e.status == 404 && !items.isEmpty {
            try requireSession(stamp)
            // An older server confirms each row separately. A failed row and all remaining rows stay unread.
            for it in items {
                let ack: LastRead = try await api.request("/conversations/\(it.conversationId)/read", method: "POST", json: ["seq": it.seq])
                try requireSession(stamp)
                applyConfirmed(it.conversationId, ack.lastReadSeq ?? it.seq, ack.readRevision)
            }
        }
    }
}
