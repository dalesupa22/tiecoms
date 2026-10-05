package com.tiecoms.app.core

/** Empty dimension means all; dimensions intersect, selections within a dimension are alternatives. */
data class TaskFilters(val assignees: Set<String>, val statuses: Set<String> = setOf("pending")) {
    fun matches(i: IssueDTO): Boolean {
        val owners = (i.assigneeIds + listOfNotNull(i.ownerId)).toSet()
        val person = assignees.isEmpty() || owners.any { it in assignees } || (owners.isEmpty() && IssueTasks.NO_OWNER in assignees)
        val status = statuses.isEmpty() || statuses.any { selected ->
            when (selected) { "pending" -> i.status in setOf("open", "in_progress", "waiting"); else -> i.status == selected }
        }
        return person && status
    }

    val closedOnly: Boolean get() = statuses.isNotEmpty() && statuses.all { it == "done" || it == "cancelled" }

    /** Include an accessible parent as labelled context, never its nonmatching children. */
    fun roots(matches: List<IssueDTO>, accessible: Map<String, IssueDTO>): List<IssueDTO> {
        val out = linkedMapOf<String, IssueDTO>()
        for (item in matches) {
            val parent = item.parentIssueId?.let { accessible[it] }
            val root = parent ?: item
            out.putIfAbsent(root.id, root)
        }
        return out.values.toList()
    }
}
