package com.tiecoms.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.*
import kotlinx.coroutines.launch
import java.time.*

/** Calendar availability is queried only on explicit request; the server rechecks before creating. */
@Composable
fun GgCalendarSheet(source: String, messageIds: List<String>, onClose: () -> Unit) {
    val client = LocalClient.current; val ctx = LocalContext.current; val scope = rememberCoroutineScope()
    var zone by remember { mutableStateOf(ZoneId.systemDefault().id) }
    val state by client.state.collectAsState()
    val people = state.data?.let { data -> if (source.startsWith("c:")) humansOf(data, source.removePrefix("c:")) else emptyList() }.orEmpty()
    var invitees by remember { mutableStateOf(emptyList<String>()) }
    var attendeeText by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var from by remember { mutableStateOf(LocalDate.now().plusDays(1).toString()) }
    var to by remember { mutableStateOf(LocalDate.now().plusDays(3).toString()) }
    var title by remember { mutableStateOf("") }
    var duration by remember { mutableStateOf("30") }
    var response by remember { mutableStateOf<GgCalendarSlots?>(null) }
    var chosen by remember { mutableStateOf<GgCalendarSlot?>(null) }
    var result by remember { mutableStateOf<MeetingDTO?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val attempts = remember(source, client.myId) { ctx.getSharedPreferences("calendar_attempts", android.content.Context.MODE_PRIVATE) }
    FormSheet(stringResource(R.string.calendar_find_slots), onClose, tag = "ggCalendar") {
        OutlinedTextField(zone, { zone = it; response = null; chosen = null }, label = { Text(stringResource(R.string.calendar_timezone)) }, modifier = Modifier.fillMaxWidth().testTag("slotsTimezone"))
        Text(stringResource(R.string.calendar_daily_window), style = MaterialTheme.typography.labelSmall)
        OutlinedTextField(from, { from = it; response = null; chosen = null }, label = { Text(stringResource(R.string.calendar_from_date)) }, modifier = Modifier.fillMaxWidth().testTag("slotsFrom"))
        OutlinedTextField(to, { to = it; response = null; chosen = null }, label = { Text(stringResource(R.string.calendar_to_date)) }, modifier = Modifier.fillMaxWidth().testTag("slotsTo"))
        OutlinedTextField(duration, { duration = it; response = null; chosen = null }, label = { Text(stringResource(R.string.calendar_duration)) }, modifier = Modifier.fillMaxWidth().testTag("slotsDuration"))
        Button(onClick = {
            scope.launch { busy = true; error = null
                try {
                    val start = LocalDate.parse(from).atStartOfDay(ZoneId.of(zone)).toInstant(); val end = LocalDate.parse(to).plusDays(1).atStartOfDay(ZoneId.of(zone)).toInstant()
                    require(end > start && java.time.Duration.between(start, end).toDays() <= 14)
                    val minutes = duration.toInt(); require(minutes in 15..120)
                    response = client.ggCalendarSlots(source, messageIds, start.toString(), end.toString(), minutes, zone); chosen = null
                } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = errorText(ctx, e) }
                finally { busy = false }
            }
        }, enabled = !busy, modifier = Modifier.testTag("slotsQuery")) { Text(stringResource(R.string.calendar_check)) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorText(error)
        response?.let { r ->
            when (r.status) {
                "needs_connect", "reconnect" -> { Text(stringResource(R.string.calendar_connect)); MeetingsSettingsSection() }
                "ready" -> {
                    Text("${r.provider ?: ""} · ${r.checkedAt ?: ""}", style = MaterialTheme.typography.labelSmall)
                    if (r.slots.isEmpty()) Text(stringResource(R.string.calendar_no_slots))
                    r.slots.forEach { slot -> FilterChip(chosen == slot, { chosen = slot }, label = { Text(runCatching { Instant.parse(slot.startsAt).atZone(ZoneId.of(r.timezone)).toString() }.getOrDefault(slot.startsAt)) }, modifier = Modifier.testTag("slot-${slot.startsAt}")) }
                }
                else -> Text(r.error ?: stringResource(R.string.ggs_error), color = MaterialTheme.colorScheme.error)
            }
        }
        chosen?.let { slot ->
            OutlinedTextField(title, { title = it.take(200) }, label = { Text(stringResource(R.string.issue_title)) }, modifier = Modifier.fillMaxWidth().testTag("slotsTitle"))
            OutlinedTextField(description, { description = it.take(4000) }, label = { Text(stringResource(R.string.calendar_description)) }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(attendeeText, { attendeeText = it.take(3000) }, label = { Text(stringResource(R.string.calendar_attendee_emails)) }, modifier = Modifier.fillMaxWidth().testTag("slotsEmails"))
            if (people.isNotEmpty()) AssigneesPicker(people, invitees, label = stringResource(R.string.calendar_invitees)) { invitees = it }
            Button(onClick = {
                val r = response ?: return@Button; val p = r.provider ?: return@Button
                val identity = listOf(source, p, slot.startsAt, slot.endsAt, title.trim(), description, attendeeText, invitees.sorted().joinToString(",")).joinToString("|")
                val digest = java.security.MessageDigest.getInstance("SHA-256").digest((client.myId + identity).toByteArray()).joinToString("") { "%02x".format(it) }
                val key = attempts.getString(digest, null) ?: java.util.UUID.randomUUID().toString().also { check(attempts.edit().putString(digest, it).commit()) { "Unable to preserve calendar request" } }
                scope.launch { busy = true; error = null
                    try {
                        val emails = attendeeText.split(',', ';', '\n').map(String::trim).filter(String::isNotEmpty).distinct()
                        require(emails.size <= 20 && emails.all { android.util.Patterns.EMAIL_ADDRESS.matcher(it).matches() })
                        result = client.ggCalendarConfirm(source, messageIds, p, key, title.trim(), slot, zone, description, emails, invitees)
                    }
                    catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = errorText(ctx, e) }
                    finally { busy = false }
                }
            }, enabled = !busy && title.trim().length >= 2 && result == null, modifier = Modifier.testTag("slotsConfirm")) { Text(stringResource(R.string.calendar_confirm)) }
        }
        result?.let { meeting ->
            Text(meeting.title, style = MaterialTheme.typography.titleMedium)
            meeting.usableUrl?.let { url -> TextButton(onClick = { openUrl(ctx, url) }) { Text(stringResource(R.string.calendar_open_meeting)) } }
            meeting.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}
