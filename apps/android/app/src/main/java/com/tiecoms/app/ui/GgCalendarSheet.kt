package com.tiecoms.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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

/**
 * «Agendar» con gg (2-oct-2026): al abrir, gg prepara la reunión con el chat (POST /gg/meeting-draft: título, duración,
 * invitados del chat, correos escritos en el chat y enlaces) y busca horarios libres. Nada se agenda hasta «Confirmar y
 * agendar» (POST /gg/calendar/confirm, que el servidor revalida). Si gg no puede, el formulario queda vacío como antes.
 * [onConsent]: si falta el permiso de IA, la hoja de gg lo pide y reintenta el borrador.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GgCalendarSheet(source: String, messageIds: List<String>, onConsent: ((suspend () -> Unit) -> Unit)? = null, onClose: () -> Unit) {
    val client = LocalClient.current; val ctx = LocalContext.current; val scope = rememberCoroutineScope()
    var zone by remember { mutableStateOf(ZoneId.systemDefault().id) }
    val state by client.state.collectAsState()
    val people = state.data?.let { data -> if (source.startsWith("c:")) humansOf(data, source.removePrefix("c:")) else emptyList() }.orEmpty()
    var invitees by remember { mutableStateOf(emptyList<String>()) }
    var draftNames by remember { mutableStateOf(emptyMap<String, String>()) }
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
    /** null = preparando; false = sin borrador (formulario manual); true = borrador listo. */
    var drafted by remember { mutableStateOf<Boolean?>(null) }
    var draft by remember { mutableStateOf<GgMeetingDraft?>(null) }
    val attempts = remember(source, client.myId) { ctx.getSharedPreferences("calendar_attempts", android.content.Context.MODE_PRIVATE) }

    suspend fun search() {
        if (busy) return
        busy = true; error = null
        try {
            val start = LocalDate.parse(from).atStartOfDay(ZoneId.of(zone)).toInstant(); val end = LocalDate.parse(to).plusDays(1).atStartOfDay(ZoneId.of(zone)).toInstant()
            require(end > start && java.time.Duration.between(start, end).toDays() <= 14)
            val minutes = duration.toInt(); require(minutes in 15..240)
            response = client.ggCalendarSlots(source, messageIds, start.toString(), end.toString(), minutes, zone); chosen = null
        } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = errorText(ctx, e) }
        finally { busy = false }
    }
    suspend fun loadDraft() {
        drafted = null
        val d = client.ggMeetingDraft(source, messageIds)
        draft = d; drafted = true
        if (title.isBlank()) title = d.title.take(200)
        duration = GgMail.duration(d.durationMin).toString()
        if (attendeeText.isBlank()) attendeeText = d.attendeeEmails.joinToString(", ")
        if (description.isBlank()) description = d.description.take(4000)
        val ids = d.invitees.map { it.id }.filter { it.isNotBlank() }
        invitees = (invitees + ids).distinct().take(20)
        draftNames = d.invitees.associate { it.id to it.name }
        search()
    }
    LaunchedEffect(source, messageIds) {
        try { loadDraft() }
        catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            drafted = false
            if (e is ApiException && e.status == 403 && e.code == "ai_consent_required") onConsent?.invoke { loadDraft() }
        }
    }
    val nameOf = { id: String -> draftNames[id] ?: people.firstOrNull { it.id == id }?.name ?: id }

    FormSheet(stringResource(R.string.calendar_find_slots), onClose, tag = "ggCalendar") {
        when (drafted) {
            null -> Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, modifier = Modifier.testTag("ggMeetingPreparing")) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.ggm_preparing), style = MaterialTheme.typography.bodySmall)
            }
            true -> draft?.let { d ->
                Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().testTag("ggMeetingNote")) {
                    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(stringResource(R.string.ggm_note), style = MaterialTheme.typography.bodySmall)
                        if (d.missingPeople.isNotEmpty()) Text(stringResource(R.string.ggm_missing, d.missingPeople.joinToString(", ")), style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("ggMeetingMissing"))
                        if (d.links.isNotEmpty()) Text(stringResource(R.string.ggm_links, d.links.joinToString(" · ") { it.removePrefix("https://").removePrefix("http://").take(40) }), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            false -> {}
        }
        // Lo que se va a agendar, arriba desde el inicio.
        OutlinedTextField(title, { title = it.take(200) }, label = { Text(stringResource(R.string.ggm_title)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("ggMeetingTitle"))
        if (invitees.isNotEmpty()) {
            Text(stringResource(R.string.ggm_from_chat), style = MaterialTheme.typography.labelMedium)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("ggMeetingInvitees")) {
                invitees.forEach { id ->
                    val name = nameOf(id)
                    InputChip(selected = true, onClick = { invitees = invitees - id }, label = { Text(name) },
                        trailingIcon = { Icon(Icons.Filled.Close, stringResource(R.string.ggm_remove, name), Modifier.size(16.dp)) },
                        modifier = Modifier.testTag("ggMeetingInvitee-$id"))
                }
            }
        }
        if (people.isNotEmpty()) AssigneesPicker(people, invitees, label = stringResource(R.string.calendar_invitees)) { invitees = it }
        OutlinedTextField(attendeeText, { attendeeText = it.take(3000) }, label = { Text(stringResource(R.string.calendar_attendee_emails)) }, modifier = Modifier.fillMaxWidth().testTag("ggMeetingEmails"))
        OutlinedTextField(description, { description = it.take(4000) }, label = { Text(stringResource(R.string.calendar_description)) }, minLines = 2, modifier = Modifier.fillMaxWidth().testTag("ggMeetingDescription"))
        HorizontalDivider()
        OutlinedTextField(zone, { zone = it; response = null; chosen = null }, label = { Text(stringResource(R.string.calendar_timezone)) }, modifier = Modifier.fillMaxWidth().testTag("slotsTimezone"))
        Text(stringResource(R.string.calendar_daily_window), style = MaterialTheme.typography.labelSmall)
        OutlinedTextField(from, { from = it; response = null; chosen = null }, label = { Text(stringResource(R.string.calendar_from_date)) }, modifier = Modifier.fillMaxWidth().testTag("slotsFrom"))
        OutlinedTextField(to, { to = it; response = null; chosen = null }, label = { Text(stringResource(R.string.calendar_to_date)) }, modifier = Modifier.fillMaxWidth().testTag("slotsTo"))
        OutlinedTextField(duration, { duration = it; response = null; chosen = null }, label = { Text(stringResource(R.string.calendar_duration)) }, modifier = Modifier.fillMaxWidth().testTag("slotsDuration"))
        Button(onClick = { scope.launch { search() } }, enabled = !busy, modifier = Modifier.testTag("slotsQuery")) { Text(stringResource(R.string.calendar_check)) }
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
            val badEmails = stringResource(R.string.ggm_bad_emails)
            Button(onClick = {
                val r = response ?: return@Button; val p = r.provider ?: return@Button
                val emails = attendeeText.split(',', ';', ' ', '\n').map(String::trim).filter(String::isNotEmpty).distinct()
                if (emails.size > 20 || !emails.all { android.util.Patterns.EMAIL_ADDRESS.matcher(it).matches() }) { error = badEmails; return@Button }
                val identity = listOf(source, p, slot.startsAt, slot.endsAt, title.trim(), description, emails.joinToString(","), invitees.sorted().joinToString(",")).joinToString("|")
                val digest = java.security.MessageDigest.getInstance("SHA-256").digest((client.myId + identity).toByteArray()).joinToString("") { "%02x".format(it) }
                val key = attempts.getString(digest, null) ?: java.util.UUID.randomUUID().toString().also { check(attempts.edit().putString(digest, it).commit()) { "Unable to preserve calendar request" } }
                scope.launch { busy = true; error = null
                    try { result = client.ggCalendarConfirm(source, messageIds, p, key, title.trim(), slot, zone, description, emails, invitees) }
                    catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = errorText(ctx, e) }
                    finally { busy = false }
                }
            }, enabled = !busy && title.trim().length >= 2 && result == null, modifier = Modifier.testTag("slotsConfirm")) { Text(stringResource(R.string.ggm_confirm)) }
        }
        result?.let { meeting ->
            Text(stringResource(R.string.ggm_saved), modifier = Modifier.testTag("ggMeetingSaved"))
            Text(meeting.title, style = MaterialTheme.typography.titleMedium)
            meeting.usableUrl?.let { url -> TextButton(onClick = { openUrl(ctx, url) }) { Text(stringResource(R.string.calendar_open_meeting)) } }
            meeting.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}
