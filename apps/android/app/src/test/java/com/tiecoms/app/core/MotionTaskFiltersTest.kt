package com.tiecoms.app.core

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class MotionTaskFiltersTest {
    private fun issue(id: String, owner: String? = "me", status: String = "open", parent: String? = null, assignees: List<String> = emptyList()) =
        IssueDTO(id = id, ownerId = owner, status = status, parentIssueId = parent, assigneeIds = assignees)

    @Test fun dimensionsIntersectAndSelectionsWithinEachAreAlternatives() {
        val f = TaskFilters(setOf("me", "lorena"), setOf("pending", "done"))
        assertTrue(f.matches(issue("1", "me", "waiting")))
        assertTrue(f.matches(issue("2", "lorena", "done")))
        assertTrue(f.matches(issue("3", "other", "done", assignees = listOf("lorena"))))
        assertFalse(f.matches(issue("4", "other", "done")))
        assertFalse(f.matches(issue("5", "me", "cancelled")))
        assertFalse(f.matches(issue("6", "me", "unknown-future")))
    }
    @Test fun completedIsDoneOnlyAndUnassignedDoesNotIncludeAssignedTasks() {
        val completed = TaskFilters(setOf("lorena"), setOf("done"))
        assertTrue(completed.matches(issue("1", "lorena", "done")))
        assertFalse(completed.matches(issue("2", "lorena", "cancelled")))
        assertTrue(TaskFilters(setOf(IssueTasks.NO_OWNER)).matches(issue("3", null)))
        assertFalse(TaskFilters(setOf(IssueTasks.NO_OWNER)).matches(issue("4", null, assignees = listOf("me"))))
        assertTrue(TaskFilters(emptySet(), emptySet()).matches(issue("5", "someone", "cancelled")))
    }
    @Test fun childrenMustMatchCompletePredicateAndParentIsContextOnly() {
        val p = issue("parent", "other", "open")
        val hit = issue("hit", "lorena", "done", "parent")
        val wrongStatus = issue("pending", "lorena", "open", "parent")
        val wrongPerson = issue("other", "other", "done", "parent")
        val hiddenParentChild = issue("orphan", "lorena", "done", "hidden")
        val all = listOf(p, hit, wrongStatus, wrongPerson, hiddenParentChild)
        val f = TaskFilters(setOf("lorena"), setOf("done"))
        val matches = all.filter(f::matches)
        assertEquals(listOf("hit", "orphan"), matches.map { it.id })
        assertEquals(listOf("parent", "orphan"), f.roots(matches, all.associateBy { it.id }).map { it.id })
        assertFalse(f.matches(p))
    }
    @Test fun paginationExceedsFiveHundredDeduplicatesAndStopsAtNull() = runBlocking {
        val offsets = mutableListOf<Int>()
        val all = IssuesPagination.collect(true) { offset ->
            offsets += offset
            IssuesPage((offset until minOf(650, offset + 200)).map { issue("$it") } +
                if (offset == 200) listOf(issue("0").copy(title = "new", updatedAt = "2026-10-05")) else emptyList(),
                if (offset + 200 < 650) offset + 200 else null)
        }
        assertEquals(listOf(0, 200, 400, 600), offsets)
        assertEquals(650, all.size)
        assertEquals("new", all.first().title)
    }
    @Test fun legacyResponseAndConversationLoadsStopWithoutGuessing() = runBlocking {
        var calls = 0
        IssuesPagination.collect(true) { calls++; TcJson.decodeFromString(IssuesPage.serializer(), """{"issues":[]}""") }
        assertEquals(1, calls)
        IssuesPagination.collect(false) { calls++; IssuesPage(emptyList(), 200) }
        assertEquals(2, calls)
    }
    @Test fun repeatedCursorFailsAndCancellationNeverReturnsPartialPages() = runBlocking {
        assertTrue(runCatching { IssuesPagination.collect(true) { IssuesPage(emptyList(), 0) } }.exceptionOrNull() is IllegalStateException)
        var calls = 0
        val job = launch {
            IssuesPagination.collect(true) {
                calls++
                currentCoroutineContext().cancel()
                IssuesPage(listOf(issue("1")), 200)
            }
            fail("Cancelled pagination must not return accumulated records")
        }
        job.join()
        assertTrue(job.isCancelled)
        assertEquals(1, calls)
    }
}
