package com.tiecoms.app.core

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Optional cursor: old servers omit it. Never guess more pages or loop on a repeated cursor. */
object IssuesPagination {
    suspend fun collect(paged: Boolean, fetch: suspend (Int) -> IssuesPage): List<IssueDTO> {
        val all = linkedMapOf<String, IssueDTO>()
        var offset = 0
        do {
            currentCoroutineContext().ensureActive()
            val page = fetch(offset)
            currentCoroutineContext().ensureActive()
            page.issues.forEach { incoming ->
                val old = all[incoming.id]
                if (old == null || incoming.updatedAt >= old.updatedAt) all[incoming.id] = incoming
            }
            val next = page.nextOffset ?: break
            if (!paged) break
            check(next > offset) { "Invalid task page cursor" }
            offset = next
        } while (true)
        return all.values.toList()
    }
}
