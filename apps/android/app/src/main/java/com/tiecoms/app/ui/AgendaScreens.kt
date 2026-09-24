package com.tiecoms.app.ui

import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.CalendarEventDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.TemporalAdjusters
import java.util.Locale

private val DEVICE_TZ: String get() = ZoneId.systemDefault().id
private val COMMON_TZ = listOf("America/Bogota", "America/Mexico_City", "America/Lima", "America/Santiago", "America/Argentina/Buenos_Aires", "America/Sao_Paulo", "America/New_York", "America/Los_Angeles", "Europe/Madrid", "UTC")
private fun tzList() = (listOf(DEVICE_TZ) + COMMON_TZ).distinct()

private fun fmtTime(iso: String, tz: ZoneId = ZoneId.systemDefault()) =
    parseInstant(iso)?.atZone(tz)?.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)) ?: ""

/** «Martes 30 de septiembre · 10:00–11:00» (como fmtWhen de la web). */
fun fmtWhen(ev: CalendarEventDTO): String {
    val s = parseInstant(ev.startsAt)?.atZone(ZoneId.systemDefault()) ?: return ""
    val day = s.format(DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.getDefault())).replaceFirstChar { it.uppercase() }
    return "$day · ${fmtTime(ev.startsAt)}–${fmtTime(ev.endsAt)}"
}

private fun isUrl(s: String?) = s != null && Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s.trim())

private fun eventColors(d: BootstrapDTO, ev: CalendarEventDTO): Pair<Color, Color> {
    val ws = d.workspaces.firstOrNull { it.id == ev.workspaceId }
    // Empresa contraparte: la primera del espacio que no es la mía.
    val org = ws?.organizationIds?.firstOrNull { it != d.me.primaryOrgId }?.let { Names.org(d, it) } ?: Names.org(d, ws?.owningOrgId)
    return parseColor(org?.colorBg, Color(0xFFE0DACE)) to parseColor(org?.colorFg, Color(0xFF1B1917))
}

private fun rsvpIcon(r: String) = when (r) { "yes" -> "✓"; "no" -> "✕"; "maybe" -> "?"; else -> "·" }
fun rsvpLabel(ctx: android.content.Context, r: String) = ctx.getString(when (r) { "yes" -> R.string.cal_rsvp_yes; "no" -> R.string.cal_rsvp_no; "maybe" -> R.string.cal_rsvp_maybe; else -> R.string.cal_rsvp_pending })

// ---------- Crear / editar ----------
@Composable
fun EventDialog(conversationId: String?, originMessageId: String? = null, defaultTitle: String = "", event: CalendarEventDTO? = null, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val groups = data.conversations.filter { it.canPost && it.workspaceId != null && it.kind != "direct" }
    val tz0 = event?.timezone ?: DEVICE_TZ
    val start0 = remember { event?.let { parseInstant(it.startsAt) } ?: LocalDate.now().plusDays(1).atTime(10, 0).atZone(ZoneId.systemDefault()).toInstant() }
    val end0 = remember { event?.let { parseInstant(it.endsAt) } ?: start0.plusSeconds(3600) }
    var conv by rememberSaveable { mutableStateOf(event?.conversationId ?: conversationId ?: groups.firstOrNull()?.id ?: "") }
    var title by rememberSaveable { mutableStateOf(event?.title ?: defaultTitle) }
    var tz by rememberSaveable { mutableStateOf(tz0) }
    var date by rememberSaveable { mutableStateOf(start0.atZone(ZoneId.of(tz0)).toLocalDate().toString()) }
    var start by rememberSaveable { mutableStateOf(start0.atZone(ZoneId.of(tz0)).toLocalTime().withSecond(0).withNano(0).toString()) }
    var end by rememberSaveable { mutableStateOf(end0.atZone(ZoneId.of(tz0)).toLocalTime().withSecond(0).withNano(0).toString()) }
    var loc by rememberSaveable { mutableStateOf(event?.location ?: "") }
    var desc by rememberSaveable { mutableStateOf(event?.description ?: "") }
    val humans = humansOf(data, conv)
    var invitees by remember(conv) { mutableStateOf(event?.invitees?.map { it.userId } ?: humans.map { it.id }) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    FormSheet(stringResource(if (event != null) R.string.cal_edit_title else R.string.cal_new_title), onClose, tag = "eventDialog") {
        OutlinedTextField(title, { title = it.take(200) }, label = { Text(stringResource(R.string.cal_title)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("eventTitle"))
        if (event == null) {
            Dropdown(stringResource(R.string.cal_conversation), groups.map { it.id to "${titleOf(ctx, it, data)} · ${data.workspaces.firstOrNull { w -> w.id == it.workspaceId }?.name ?: ""}" }, conv, { conv = it })
        }
        DateField(stringResource(R.string.cal_date), LocalDate.parse(date), { it?.let { d -> date = d.toString() } }, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TimeField(stringResource(R.string.cal_start), LocalTime.parse(start), { start = it.toString() }, Modifier.weight(1f))
            TimeField(stringResource(R.string.cal_end), LocalTime.parse(end), { end = it.toString() }, Modifier.weight(1f))
        }
        Dropdown(stringResource(R.string.cal_tz), tzList().map { it to it.replace('_', ' ') }, tz, { tz = it })
        OutlinedTextField(loc, { loc = it.take(500) }, label = { Text(stringResource(R.string.cal_location)) }, placeholder = { Text(stringResource(R.string.cal_location_ph)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        SectionHeader("${stringResource(R.string.cal_invitees)} · ${invitees.size}")
        humans.forEach { p ->
            val on = p.id in invitees
            Row(
                Modifier.fillMaxWidth().toggleable(on, enabled = p.id != data.me.id, role = Role.Checkbox) { invitees = if (on) invitees - p.id else invitees + p.id }.heightIn(min = 44.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(on, null, enabled = p.id != data.me.id)
                Spacer(Modifier.width(8.dp))
                Text(p.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        OutlinedTextField(desc, { desc = it.take(4000) }, label = { Text(stringResource(R.string.cal_description)) }, minLines = 2, modifier = Modifier.fillMaxWidth())
        ErrorText(error)
        DialogButtons(onClose, stringResource(if (event != null) R.string.cal_save else R.string.cal_create), enabled = !busy && conv.isNotBlank() && title.trim().length >= 2, confirmTag = "eventSave") {
            busy = true; error = null
            val zone = ZoneId.of(tz)
            val s = LocalDate.parse(date).atTime(LocalTime.parse(start)).atZone(zone).toInstant()
            var e = LocalDate.parse(date).atTime(LocalTime.parse(end)).atZone(zone).toInstant()
            if (!e.isAfter(s)) e = e.plusSeconds(86_400)
            val payload = buildJsonObject {
                put("title", JsonPrimitive(title.trim())); put("description", desc.ifBlank { null }?.let { JsonPrimitive(it) } ?: JsonNull)
                put("location", loc.ifBlank { null }?.let { JsonPrimitive(it) } ?: JsonNull)
                put("startsAt", JsonPrimitive(s.toString())); put("endsAt", JsonPrimitive(e.toString())); put("timezone", JsonPrimitive(tz))
                put("inviteeIds", JsonArray(invitees.map { JsonPrimitive(it) }))
                if (event == null) put("originMessageId", originMessageId?.let { JsonPrimitive(it) } ?: JsonNull)
            }
            scope.launch {
                try {
                    val ev = if (event != null) client.updateEvent(event.id, payload) else client.createEvent(conv, payload)
                    container.toast("${ev.title} · ${fmtWhen(ev)}")
                    onClose()
                } catch (ex: Exception) { error = errorText(ctx, ex) } finally { busy = false }
            }
        }
    }
}

// ---------- Detalle ----------
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun EventDetailScreen(id: String, onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val ev = st.events[id]
    var error by remember { mutableStateOf<String?>(null) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var confirmCancel by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(id) { if (ev == null) runCatching { client.getEvent(id) }.onFailure { error = errorText(ctx, it) } }
    SimpleScaffold(ev?.title ?: stringResource(R.string.nav_agenda), onBack) {
        if (ev == null) { if (error != null) ErrorText(error) else CircularProgressIndicator(Modifier.padding(24.dp)); return@SimpleScaffold }
        val conv = data.conversations.firstOrNull { it.id == ev.conversationId }
        val mine = ev.invitees.firstOrNull { it.userId == data.me.id }
        val canEdit = ev.organizerId == data.me.id || conv?.canManage == true
        val organizer = Names.person(data, ev.organizerId)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (ev.cancelledAt != null) Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.small) {
                Text(stringResource(R.string.cal_cancelled), Modifier.padding(10.dp), color = MaterialTheme.colorScheme.onErrorContainer)
            }
            Text(fmtWhen(ev), fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("eventWhen"))
            if (ev.timezone != DEVICE_TZ) {
                val z = runCatching { ZoneId.of(ev.timezone) }.getOrDefault(ZoneId.of("UTC"))
                Text("${stringResource(R.string.cal_event_tz)}: ${fmtTime(ev.startsAt, z)}–${fmtTime(ev.endsAt, z)} (${ev.timezone.replace('_', ' ')})", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("${conv?.let { titleOf(ctx, it, data) } ?: ""} · ${stringResource(R.string.cal_organizer, organizer?.name ?: "")}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            ev.location?.let { l ->
                if (isUrl(l)) Button(onClick = { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(l.trim()))) } }) { Text("▶ " + stringResource(R.string.cal_join)) }
                else Text("📍 $l")
            }
            ev.description?.let { Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) { Text(it, Modifier.padding(10.dp)) } }
            if (mine != null && ev.cancelledAt == null) {
                Segmented(listOf("yes" to stringResource(R.string.cal_rsvp_yes), "maybe" to stringResource(R.string.cal_rsvp_maybe), "no" to stringResource(R.string.cal_rsvp_no)),
                    mine.rsvp, { r -> scope.launch { runCatching { client.rsvp(ev.id, r) }.onFailure { error = errorText(ctx, it) } } }, Modifier.testTag("rsvp"))
            }
            SectionHeader("${stringResource(R.string.cal_invitees)} · ${ev.invitees.size}")
            ev.invitees.forEach { i ->
                val p = Names.person(data, i.userId)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(p?.name ?: stringResource(R.string.common_participant), Modifier.weight(1f))
                    Text("${rsvpIcon(i.rsvp)} ${rsvpLabel(ctx, i.rsvp)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            SectionHeader(stringResource(R.string.cal_add_to))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { addToDeviceCalendar(ctx, ev) }) { Text(stringResource(R.string.cal_add_device)) }
                OutlinedButton(onClick = { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(googleLink(ev)))) } }) { Text(stringResource(R.string.cal_add_google)) }
                OutlinedButton(onClick = { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(outlookLink(ev)))) } }) { Text(stringResource(R.string.cal_add_outlook)) }
            }
            ErrorText(error)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (conv != null) TextButton(onClick = { onOpenChat(conv.id) }) { Text(stringResource(R.string.cal_open_chat)) }
                if (canEdit && ev.cancelledAt == null) {
                    TextButton(onClick = { editing = true }) { Text(stringResource(R.string.cal_edit)) }
                    FilledTonalButton(onClick = { confirmCancel = true }) { Text(stringResource(R.string.cal_cancel)) }
                }
            }
        }
        if (editing) EventDialog(null, event = ev, onClose = { editing = false })
        if (confirmCancel) AlertDialog(
            onDismissRequest = { confirmCancel = false }, text = { Text(stringResource(R.string.cal_cancel_confirm)) },
            confirmButton = { TextButton(onClick = { confirmCancel = false; scope.launch { runCatching { client.cancelEvent(ev.id) }.onFailure { error = errorText(ctx, it) } } }) { Text(stringResource(R.string.cal_cancel)) } },
            dismissButton = { TextButton(onClick = { confirmCancel = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

private fun gstamp(iso: String) = (parseInstant(iso) ?: Instant.EPOCH).toString().replace("-", "").replace(":", "").replace(Regex("\\.\\d+"), "")
private fun details(ev: CalendarEventDTO) = listOfNotNull(ev.description, convLink(ev.conversationId)).joinToString("\n\n")
fun googleLink(ev: CalendarEventDTO) = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=${Uri.encode(ev.title)}&dates=${gstamp(ev.startsAt)}/${gstamp(ev.endsAt)}&details=${Uri.encode(details(ev))}&location=${Uri.encode(ev.location ?: "")}&ctz=${Uri.encode(ev.timezone)}"
fun outlookLink(ev: CalendarEventDTO) = "https://outlook.office.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${Uri.encode(ev.title)}&startdt=${Uri.encode(ev.startsAt)}&enddt=${Uri.encode(ev.endsAt)}&body=${Uri.encode(details(ev))}&location=${Uri.encode(ev.location ?: "")}"

/** Equivalente nativo del .ics: abre el calendario del teléfono con el evento prellenado. */
private fun addToDeviceCalendar(ctx: android.content.Context, ev: CalendarEventDTO) {
    val i = Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
        .putExtra(CalendarContract.Events.TITLE, ev.title)
        .putExtra(CalendarContract.Events.DESCRIPTION, details(ev))
        .putExtra(CalendarContract.Events.EVENT_LOCATION, ev.location ?: "")
        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, parseInstant(ev.startsAt)?.toEpochMilli() ?: 0L)
        .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, parseInstant(ev.endsAt)?.toEpochMilli() ?: 0L)
        .putExtra(CalendarContract.Events.EVENT_TIMEZONE, ev.timezone)
    runCatching { ctx.startActivity(i) }
}

// ---------- Filas y tarjetas ----------
@Composable
fun EventRow(ev: CalendarEventDTO, data: BootstrapDTO, showConv: Boolean = true, onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val (bg, fg) = eventColors(data, ev)
    val conv = data.conversations.firstOrNull { it.id == ev.conversationId }
    val mine = ev.invitees.firstOrNull { it.userId == data.me.id }
    Row(
        Modifier.fillMaxWidth().clickable { onOpen(ev.id) }.heightIn(min = 56.dp).padding(vertical = 6.dp).testTag("event-${ev.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.background(bg, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 6.dp).widthIn(min = 56.dp), contentAlignment = Alignment.Center) {
            Text(fmtTime(ev.startsAt), color = fg, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(ev.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                textDecoration = if (ev.cancelledAt != null) androidx.compose.ui.text.style.TextDecoration.LineThrough else null)
            val day = parseInstant(ev.startsAt)?.atZone(ZoneId.systemDefault())?.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault()))
            Text(listOfNotNull(if (showConv) conv?.let { titleOf(ctx, it, data) } else null, day, if (ev.cancelledAt != null) stringResource(R.string.cal_cancelled) else null).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        mine?.let { Text(rsvpIcon(it.rsvp), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp)) }
    }
}

/** Tarjeta de reunión dentro del chat (en el mensaje de sistema que la anuncia). */
@Composable
fun EventCard(ev: CalendarEventDTO, data: BootstrapDTO, onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val (bg, fg) = eventColors(data, ev)
    val mine = ev.invitees.firstOrNull { it.userId == data.me.id }
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp).clickable { onOpen(ev.id) }.testTag("eventCard-${ev.id}")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.background(bg, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp)) { Text("📅", color = fg) }
                Spacer(Modifier.width(8.dp))
                Text(ev.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(if (ev.cancelledAt != null) stringResource(R.string.cal_cancelled) else fmtWhen(ev), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (mine != null && ev.cancelledAt == null) {
                Segmented(listOf("yes" to stringResource(R.string.cal_rsvp_yes), "maybe" to stringResource(R.string.cal_rsvp_maybe), "no" to stringResource(R.string.cal_rsvp_no)),
                    mine.rsvp, { r -> scope.launch { runCatching { client.rsvp(ev.id, r) }.onFailure { (ctx.applicationContext as com.tiecoms.app.TieComsApp).container.toast(errorText(ctx, it)) } } })
            }
        }
    }
}

// ---------- Agenda semanal (vista de lista por día, como la web en móvil) ----------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgendaScreen(onOpenEvent: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    var weekStr by rememberSaveable { mutableStateOf(LocalDate.now().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).toString()) }
    val week = LocalDate.parse(weekStr)
    var error by remember { mutableStateOf<String?>(null) }
    var creating by rememberSaveable { mutableStateOf(false) }
    val zone = ZoneId.systemDefault()
    val from = week.atStartOfDay(zone).toInstant(); val to = week.plusDays(7).atStartOfDay(zone).toInstant()
    LaunchedEffect(weekStr) { error = null; runCatching { client.loadEvents(from, to) }.onFailure { error = errorText(ctx, it) } }
    val visible = data.conversations.map { it.id }.toSet()
    val events = st.events.values.filter { it.conversationId in visible && (parseInstant(it.startsAt)?.isBefore(to) == true) && (parseInstant(it.endsAt)?.isAfter(from) == true) }.sortedBy { it.startsAt }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.nav_agenda), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                actions = {
                    TextButton(onClick = { weekStr = LocalDate.now().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).toString() }) { Text(stringResource(R.string.cal_today)) }
                    IconButton(onClick = { weekStr = week.minusWeeks(1).toString() }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, stringResource(R.string.cal_prev)) }
                    IconButton(onClick = { weekStr = week.plusWeeks(1).toString() }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, stringResource(R.string.cal_next)) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        floatingActionButton = {
            androidx.compose.material3.ExtendedFloatingActionButton(onClick = { creating = true }, modifier = Modifier.testTag("newMeeting")) { Text(stringResource(R.string.cal_new)) }
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize().padding(horizontal = 16.dp).testTag("agenda")) {
            item {
                Text(stringResource(R.string.cal_week, week.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG))), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
                ErrorText(error)
                if (events.isEmpty()) EmptyNote(stringResource(R.string.cal_empty))
            }
            for (i in 0 until 7) {
                val day = week.plusDays(i.toLong())
                val list = events.filter { parseInstant(it.startsAt)?.atZone(zone)?.toLocalDate() == day }
                if (list.isEmpty()) continue
                item(key = "d$day") {
                    SectionHeader(day.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault())) + if (day == LocalDate.now()) " · " + stringResource(R.string.cal_today) else "",
                        Modifier.padding(top = 14.dp, bottom = 4.dp).semantics { heading() })
                }
                items(list, key = { it.id }) { EventRow(it, data, onOpen = onOpenEvent) }
            }
            item { Spacer(Modifier.heightIn(min = 88.dp)) }
        }
    }
    if (creating) EventDialog(null, onClose = { creating = false })
}

