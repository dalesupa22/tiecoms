package com.tiecoms.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.PersonDTO

@Composable
fun AssigneesPicker(people: List<PersonDTO>, selected: List<String>, label: String? = null, onChange: (List<String>) -> Unit) {
    var open by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf(selected) }
    TextButton(onClick = { draft = selected; open = true }, modifier = Modifier.heightIn(min = 48.dp).testTag("assigneesPick")) {
        Text((label ?: stringResource(R.string.issue_owner)) + " · ${selected.distinct().size}")
    }
    if (open) AlertDialog(onDismissRequest = { open = false }, title = { Text(label ?: stringResource(R.string.issue_owner)) }, text = {
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            people.forEach { p -> Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Checkbox(p.id in draft, { checked -> draft = if (checked) (draft + p.id).distinct() else draft - p.id }, enabled = p.id in draft || draft.size < 20, modifier = Modifier.testTag("assignee-${p.id}"))
                Text(p.name, Modifier.weight(1f))
            } }
        }
    }, confirmButton = { TextButton(onClick = { onChange(draft.distinct()); open = false }, modifier = Modifier.testTag("assigneesSave")) { Text(stringResource(R.string.common_save)) } },
        dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(R.string.cancel)) } })
}
