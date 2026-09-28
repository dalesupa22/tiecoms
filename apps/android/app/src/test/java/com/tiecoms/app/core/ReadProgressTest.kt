package com.tiecoms.app.core

import org.junit.Assert.*
import org.junit.Test

class ReadProgressTest {
    private fun messages(range: IntRange) = range.map { MessageDTO(id = "m$it", seq = it.toLong(), authorId = "other") }

    @Test fun `jumping to the end or a mention never reads the skipped middle`() {
        val progress = ReadProgress(); val loaded = messages(1..300)
        assertEquals(0L, progress.observe(0, 0, loaded, (280L..300L).toSet(), "me", emptySet()))
        assertEquals(3L, progress.observe(0, 0, loaded, setOf(1, 2, 3), "me", emptySet()))
        assertEquals(3L, progress.observe(3, 0, loaded, setOf(90, 91), "me", emptySet()))
        assertEquals(300L, progress.observe(3, 0, loaded, (4L..279L).toSet(), "me", emptySet()))
    }

    @Test fun `unloaded pages are a gap even with the last page visible`() {
        val progress = ReadProgress()
        assertEquals(2L, progress.observe(2, 0, messages(151..200), (151L..200L).toSet(), "me", emptySet()))
        assertEquals(2L, progress.observe(2, 0, messages(3..200), emptySet(), "me", emptySet()))
    }

    @Test fun `acknowledgement and a newer arrival retain the unseen message`() {
        val progress = ReadProgress()
        assertEquals(5L, progress.observe(2, 0, messages(1..5), setOf(3, 4, 5), "me", emptySet()))
        // A failed POST leaves cursor2; the same candidate can be retried.
        assertEquals(5L, progress.observe(2, 0, messages(1..6), emptySet(), "me", emptySet()))
        assertEquals(5L, progress.observe(5, 0, messages(1..6), emptySet(), "me", emptySet()))
    }

    @Test fun `membership history and own or blocked content do not create false gaps`() {
        val loaded = messages(10..14).map { if (it.seq == 12L) it.copy(authorId = "me") else if (it.seq == 13L) it.copy(authorId = "blocked") else it }
        assertEquals(14L, ReadProgress().observe(0, 10, loaded, setOf(11, 14), "me", setOf("blocked")))
    }

    @Test fun `a terminal page cannot silently skip the unread boundary`() {
        assertEquals(ChatNav.Position.Incomplete, ChatNav.position(messages(50..100), 10, 90, "me", 100))
        assertEquals(ChatNav.Position.Incomplete, ChatNav.position(messages(11..12).map { it.copy(authorId = "me") } + messages(50..100), 10, 90, "me", 100))
        assertEquals(ChatNav.Position.Ready(null), ChatNav.position(messages(11..14).map { it.copy(authorId = "me") }, 10, 4, "me", 14))
        assertEquals(ChatNav.Position.Ready(11), ChatNav.position(messages(11..100), 10, 90, "me", 100))
    }
}
