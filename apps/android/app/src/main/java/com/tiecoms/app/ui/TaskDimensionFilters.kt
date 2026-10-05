package com.tiecoms.app.ui

import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.*

/** Selecting a status never resets people, and selecting people never resets status. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDimensionFilters(data: BootstrapDTO, issues: List<IssueDTO>, selected: TaskFilters, onChange: (TaskFilters) -> Unit) {
    var dimension by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    val myId = data.me.id
    val meLabel = stringResource(R.string.task_filter_me)
    val allPeople = stringResource(R.string.task_filter_everyone)
    val unassigned = stringResource(R.string.issue_no_owner)
    val people = remember(data, issues) {
        val known = (data.people + PersonDTO(id = myId, name = data.me.name)).associateBy { it.id }
        val ids = (issues.flatMap { it.assigneeIds + listOfNotNull(it.ownerId) } + myId).distinct()
        ids.map { known[it] ?: PersonDTO(id = it, name = it.take(8)) }.sortedWith(compareByDescending<PersonDTO> { it.id == myId }.thenBy { it.name.lowercase() })
    }
    val statuses = listOf("pending" to stringResource(R.string.task_filter_pending), "done" to stringResource(R.string.task_filter_completed), "cancelled" to stringResource(R.string.task_filter_cancelled))
    val personLabel = when {
        selected.assignees.isEmpty() -> allPeople
        selected.assignees.size > 1 -> stringResource(R.string.task_filter_people_count, selected.assignees.size)
        selected.assignees.single() == myId -> meLabel
        selected.assignees.single() == IssueTasks.NO_OWNER -> unassigned
        else -> people.firstOrNull { it.id == selected.assignees.single() }?.name ?: stringResource(R.string.common_participant)
    }
    val statusLabel = if (selected.statuses.isEmpty()) stringResource(R.string.task_filter_all_statuses)
        else statuses.filter { it.first in selected.statuses }.joinToString(" + ") { it.second }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = selected.assignees.isNotEmpty(), onClick = { query = ""; dimension = "people" },
            label = { Text(personLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            trailingIcon = { Icon(Icons.Filled.KeyboardArrowDown, null) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("taskFilterPeople"))
        FilterChip(selected = selected.statuses.isNotEmpty(), onClick = { dimension = "status" },
            label = { Text(statusLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            trailingIcon = { Icon(Icons.Filled.KeyboardArrowDown, null) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("taskFilterStatus"))
    }
    Text(stringResource(R.string.task_filter_result_count, issues.count(selected::matches)), style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("taskFilterCount"))
    if (dimension != null) {
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { dimension = null }, sheetState = sheet, modifier = Modifier.testTag("taskFilterSheet")) {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp)) {
                Text(stringResource(if (dimension == "people") R.string.task_filter_assignees else R.string.task_filter_status), style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(8.dp))
                if (dimension == "people") {
                    OutlinedTextField(query, { query = it }, singleLine = true, placeholder = { Text(stringResource(R.string.task_filter_search)) }, modifier = Modifier.fillMaxWidth().testTag("taskFilterSearch"))
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 350.dp)) {
                        item { TaskFilterOption(allPeople, selected.assignees.isEmpty(), "taskPerson-all") { onChange(selected.copy(assignees = emptySet())) } }
                        item { TaskFilterOption(unassigned, IssueTasks.NO_OWNER in selected.assignees, "taskPerson-none") { onChange(selected.copy(assignees = toggleTaskSelection(selected.assignees, IssueTasks.NO_OWNER))) } }
                        items(people.filter { query.isBlank() || it.name.contains(query, ignoreCase = true) }, key = { it.id }) { p ->
                            TaskFilterOption(if (p.id == myId) "$meLabel · ${p.name}" else p.name, p.id in selected.assignees, "taskPerson-${p.id}") {
                                onChange(selected.copy(assignees = toggleTaskSelection(selected.assignees, p.id)))
                            }
                        }
                    }
                } else {
                    TaskFilterOption(stringResource(R.string.task_filter_all_statuses), selected.statuses.isEmpty(), "taskStatus-all") { onChange(selected.copy(statuses = emptySet())) }
                    statuses.forEach { (id, title) -> TaskFilterOption(title, id in selected.statuses, "taskStatus-$id") { onChange(selected.copy(statuses = toggleTaskSelection(selected.statuses, id))) } }
                }
                Button(onClick = { dimension = null }, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp).testTag("taskFilterApply")) { Text(stringResource(R.string.task_filter_apply)) }
            }
        }
    }
}

private fun toggleTaskSelection(values: Set<String>, id: String): Set<String> = if (id in values) values - id else values + id

@Composable
private fun TaskFilterOption(title: String, checked: Boolean, tag: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 50.dp).toggleable(value = checked, role = Role.Checkbox, onValueChange = { onClick() }).testTag(tag), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked, null)
        Spacer(Modifier.width(10.dp))
        Text(title, modifier = Modifier.weight(1f))
    }
}
