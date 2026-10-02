package com.tiecoms.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.AvailabilityDTO
import kotlinx.coroutines.launch

internal fun availabilityLabel(mode: String?) = when (mode) {
    "available" -> R.string.availability_available; "busy" -> R.string.availability_busy; "focus" -> R.string.availability_focus
    "dnd" -> R.string.availability_dnd; "rest" -> R.string.availability_rest; else -> R.string.availability_title
}
@Composable
fun AvailabilityBadge(value: AvailabilityDTO?) {
    val now = rememberSilenceNow(value?.until)
    if (value?.active(now) != true) return
    val label = stringResource(availabilityLabel(value.mode))
    Text(when (value.mode) { "available" -> "●"; "busy" -> "◆"; "focus" -> "◎"; else -> "🌙" },
        style = MaterialTheme.typography.labelSmall, modifier = Modifier.testTag("availability-${value.mode}").semantics { contentDescription = label },
        color = if (value.mode == "available") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
}
@Composable
fun AvailabilityRow() {
    val client = LocalClient.current; val ctx = LocalContext.current; val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle(); val scope = rememberCoroutineScope()
    val availability = st.data?.me?.availability
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().clickable { open = true }.heightIn(min = 56.dp).padding(16.dp).testTag("availabilityRow")) {
        Text("◉", Modifier.padding(end = 12.dp)); Column {
            Text(stringResource(R.string.availability_title), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(availabilityLabel(availability?.mode)), style = MaterialTheme.typography.bodySmall)
        }
    }
    if (open) ActionSheet(ctx.getString(R.string.availability_title), listOf("available", "busy", "focus", "dnd", "rest").map { mode ->
        SheetItem(ctx.getString(availabilityLabel(mode)), subtitle = if (mode in setOf("focus", "dnd", "rest")) ctx.getString(R.string.availability_silent) else null, tag = "availabilityPick-$mode") {
            scope.launch {
                try { client.setAvailability(mode, if (mode in setOf("focus", "dnd", "rest")) java.time.Instant.now().plusSeconds(3600).toString() else null) }
                catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; container.toast(errorText(ctx, e)) }
            }
        }
    } + SheetItem(ctx.getString(R.string.dnd_turn_off), tag = "availabilityOff") { scope.launch { runCatching { client.setAvailability(null) }.onFailure { container.toast(errorText(ctx, it)) } } }, { open = false })
}
