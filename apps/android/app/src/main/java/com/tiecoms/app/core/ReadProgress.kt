package com.tiecoms.app.core

/** Only advance over a contiguous prefix of messages actually seen during this chat visit. */
class ReadProgress {
    private val seen = mutableSetOf<Long>()

    fun observe(cursor: Long, historyFrom: Long, loaded: List<MessageDTO>, visible: Set<Long>, myId: String, blocked: Set<String>): Long {
        val base = maxOf(cursor, historyFrom)
        seen.removeAll { it <= base }
        val known = loaded.associateBy { it.seq }
        seen += visible.filter { it > base && it in known }
        var next = base
        while (true) {
            val message = known[next + 1] ?: break
            // Our own content and explicitly hidden authors do not require reading a visible row.
            if (message.seq !in seen && message.authorId != myId && message.authorId !in blocked) break
            next = message.seq
        }
        return next
    }
}
