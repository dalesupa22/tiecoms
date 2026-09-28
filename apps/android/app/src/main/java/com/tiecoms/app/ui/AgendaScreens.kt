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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material.icons.filled.Add
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
import androidx.compose.material3.SegmentedButton
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
import androidx.compose.ui.semantics.contentDescription
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
fun EventDialog(conversationId: String?, originMessageId: String? = null, defaultTitle: String = "", event: CalendarEventDTO? = null,
                /** Crear desde el calendario (1.6.6): la hora del hueco tocado o del día elegido. */
                initialStart: Instant? = null, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    // Reuniones también en directos y chats grupales (SPEC-v4 §E).
    val groups = data.conversations.filter { it.canPost }
    val tz0 = event?.timezone ?: DEVICE_TZ
    val start0 = remember { event?.let { parseInstant(it.startsAt) } ?: initialStart ?: LocalDate.now().plusDays(1).atTime(10, 0).atZone(ZoneId.systemDefault()).toInstant() }
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
        OutlinedTextField(title, { title = it.take(200) }, label = { Text(stringResource(R.string.cal_title)) }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Next), modifier = Modifier.fillMaxWidth().testTag("eventTitle"))
        if (event == null) {
            Dropdown(stringResource(R.string.cal_conversation), groups.map { it.id to listOfNotNull(titleOf(ctx, it, data), data.workspaces.firstOrNull { w -> w.id == it.workspaceId }?.name).joinToString(" · ") }, conv, { conv = it })
        }
        DateField(stringResource(R.string.cal_date), LocalDate.parse(date), { it?.let { d -> date = d.toString() } }, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TimeField(stringResource(R.string.cal_start), LocalTime.parse(start), { start = it.toString() }, Modifier.weight(1f))
            TimeField(stringResource(R.string.cal_end), LocalTime.parse(end), { end = it.toString() }, Modifier.weight(1f))
        }
        Dropdown(stringResource(R.string.cal_tz), tzList().map { it to it.replace('_', ' ') }, tz, { tz = it })
        OutlinedTextField(loc, { loc = it.take(500) }, label = { Text(stringResource(R.string.cal_location)) }, placeholder = { Text(stringResource(R.string.cal_location_ph)) }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Next), modifier = Modifier.fillMaxWidth())
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
        if (ev.workspaceId == null && conv != null) { ConversationIcon(conv, data, 32.dp); Spacer(Modifier.width(8.dp)) }
        Box(Modifier.background(bg, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 6.dp).widthIn(min = 56.dp), contentAlignment = Alignment.Center) {
            Text(fmtTime(ev.startsAt), color = fg, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            // 📹: la reunión tiene un enlace de Meet, Teams o Zoom (las de las integraciones y las pegadas a mano).
            Text((if (com.tiecoms.app.core.Meetings.isVideoLink(ev.location)) "📹 " else "") + ev.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
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

// ---------- Calendario: Día · Semana · Mes (1.6.6, docs/TANDA-LECTURA-REUNIONES.md §5) ----------
private fun spanOf(ev: CalendarEventDTO): com.tiecoms.app.core.CalendarGrid.Span? {
    val s = parseInstant(ev.startsAt) ?: return null
    return com.tiecoms.app.core.CalendarGrid.Span(ev.id, s, parseInstant(ev.endsAt) ?: s)
}
private fun videoMark(ev: CalendarEventDTO) = if (com.tiecoms.app.core.Meetings.isVideoLink(ev.location)) "📹 " else ""

/**
 * Selector Día / Semana / Mes (Semana por defecto, recordado en este dispositivo), ‹ Hoy › y «＋». Se crea desde
 * cada vista: el hueco de una hora (Día), el «＋» de cada día (Semana) o el botón (Mes, que al tocar un día abre Día).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgendaScreen(onOpenEvent: (String) -> Unit, quick: QuickNav? = null) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    var viewId by rememberSaveable { mutableStateOf(container.settings.calendarView) }
    val view = com.tiecoms.app.core.CalendarGrid.View.of(viewId)
    var anchorStr by rememberSaveable { mutableStateOf(LocalDate.now().toString()) }
    val anchor = LocalDate.parse(anchorStr)
    var error by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf<Instant?>(null) }
    val zone = ZoneId.systemDefault()
    val (from, to) = com.tiecoms.app.core.CalendarGrid.range(view, anchor, zone)
    LaunchedEffect(viewId, anchorStr) { error = null; runCatching { client.loadEvents(from, to) }.onFailure { error = errorText(ctx, it) } }
    val visible = data.conversations.map { it.id }.toSet()
    val events = st.events.values.filter { it.conversationId in visible && (parseInstant(it.startsAt)?.isBefore(to) == true) && ((parseInstant(it.endsAt) ?: parseInstant(it.startsAt))?.isAfter(from) == true) }
        .sortedBy { it.startsAt }
    fun onDay(day: LocalDate) = events.filter { e -> spanOf(e)?.let { com.tiecoms.app.core.CalendarGrid.overlaps(it, day, zone) } == true }
    fun setView(v: com.tiecoms.app.core.CalendarGrid.View) { viewId = v.id; container.settings.calendarView = v.id }
    val today = LocalDate.now()
    val label = when (view) {
        com.tiecoms.app.core.CalendarGrid.View.DAY -> anchor.format(DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.getDefault())).replaceFirstChar { it.uppercase() } +
            if (anchor == today) " · " + stringResource(R.string.cal_today) else ""
        com.tiecoms.app.core.CalendarGrid.View.WEEK -> stringResource(R.string.cal_week, com.tiecoms.app.core.CalendarGrid.weekStart(anchor).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG)))
        com.tiecoms.app.core.CalendarGrid.View.MONTH -> anchor.format(DateTimeFormatter.ofPattern("LLLL yyyy", Locale.getDefault())).replaceFirstChar { it.uppercase() }
    }
    val (prevCd, nextCd) = when (view) {
        com.tiecoms.app.core.CalendarGrid.View.DAY -> stringResource(R.string.cal_prev_day) to stringResource(R.string.cal_next_day)
        com.tiecoms.app.core.CalendarGrid.View.WEEK -> stringResource(R.string.cal_prev) to stringResource(R.string.cal_next)
        com.tiecoms.app.core.CalendarGrid.View.MONTH -> stringResource(R.string.cal_prev_month) to stringResource(R.string.cal_next_month)
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.nav_agenda), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                // ✏️ y «＋ Crear» como en las demás pestañas; la fecha se mueve abajo.
                actions = { if (quick != null) QuickActions(quick) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().testTag("agenda")) {
            val views = com.tiecoms.app.core.CalendarGrid.View.entries
            androidx.compose.material3.SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
                .semantics { contentDescription = ctx.getString(R.string.cal_view_label) }.testTag("calView")) {
                views.forEachIndexed { i, v ->
                    SegmentedButton(selected = view == v, onClick = { setView(v) },
                        shape = androidx.compose.material3.SegmentedButtonDefaults.itemShape(i, views.size), icon = {},
                        modifier = Modifier.heightIn(min = 44.dp).testTag("calView-" + v.id)) {
                        Text(stringResource(when (v) { com.tiecoms.app.core.CalendarGrid.View.DAY -> R.string.cal_view_day; com.tiecoms.app.core.CalendarGrid.View.WEEK -> R.string.cal_view_week; else -> R.string.cal_view_month }),
                            maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { anchorStr = com.tiecoms.app.core.CalendarGrid.step(view, anchor, -1).toString() }, modifier = Modifier.testTag("agenda.prev")) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, prevCd) }
                Text(label, color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).semantics { heading() }.testTag("agenda.label"))
                TextButton(onClick = { anchorStr = LocalDate.now().toString() }, modifier = Modifier.testTag("agenda.today")) { Text(stringResource(R.string.cal_today), maxLines = 1) }
                IconButton(onClick = { anchorStr = com.tiecoms.app.core.CalendarGrid.step(view, anchor, 1).toString() }, modifier = Modifier.testTag("agenda.next")) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, nextCd) }
                IconButton(onClick = { creating = com.tiecoms.app.core.CalendarGrid.proposedStart(anchor, null, zone) }, modifier = Modifier.testTag("agenda.new")) {
                    Icon(androidx.compose.material.icons.Icons.Filled.Add, stringResource(R.string.cal_new_title))
                }
            }
            ErrorText(error)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (view) {
                    com.tiecoms.app.core.CalendarGrid.View.DAY -> DayView(anchor, onDay(anchor), data, zone, onOpenEvent, onCreate = { h -> creating = com.tiecoms.app.core.CalendarGrid.proposedStart(anchor, h, zone) })
                    com.tiecoms.app.core.CalendarGrid.View.WEEK -> WeekView(anchor, events, data, zone, onOpenEvent,
                        onCreate = { d -> creating = com.tiecoms.app.core.CalendarGrid.proposedStart(d, null, zone) }, onDay = { d -> anchorStr = d.toString(); setView(com.tiecoms.app.core.CalendarGrid.View.DAY) })
                    com.tiecoms.app.core.CalendarGrid.View.MONTH -> MonthView(anchor, events, data, zone, onDay = { d -> anchorStr = d.toString(); setView(com.tiecoms.app.core.CalendarGrid.View.DAY) })
                }
            }
        }
    }
    creating?.let { at -> EventDialog(null, initialStart = at, onClose = { creating = null }) }
}

/** Semana: la lista por día de siempre, con los 7 días y un «＋» en cada uno (crear ese día). */
@Composable
private fun WeekView(anchor: LocalDate, events: List<CalendarEventDTO>, data: BootstrapDTO, zone: ZoneId, onOpenEvent: (String) -> Unit, onCreate: (LocalDate) -> Unit, onDay: (LocalDate) -> Unit) {
    val week = com.tiecoms.app.core.CalendarGrid.weekStart(anchor)
    val today = LocalDate.now()
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("calWeek"), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = AssistantListInset)) {
        if (events.isEmpty()) item(key = "empty") { EmptyNote(stringResource(R.string.cal_empty)) }
        for (i in 0 until 7) {
            val day = week.plusDays(i.toLong())
            val list = events.filter { e -> spanOf(e)?.let { com.tiecoms.app.core.CalendarGrid.overlaps(it, day, zone) } == true }
            item(key = "d$day") {
                val dayText = day.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault()))
                Row(Modifier.fillMaxWidth().padding(top = 10.dp).heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(dayText.uppercase() + if (day == today) " · " + stringResource(R.string.cal_today).uppercase() else "",
                        style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                        color = if (day == today) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).clickable { onDay(day) }.semantics { heading() }.testTag("calWeekDay-$day"))
                    IconButton(onClick = { onCreate(day) }, modifier = Modifier.testTag("calWeekNew-$day")) {
                        Icon(androidx.compose.material.icons.Icons.Filled.Add, stringResource(R.string.cal_new_on, dayText), tint = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            // Primero las de empresas; luego las de directos y chats grupales (sección «Chats», SPEC-v4 §E).
            val (inSpaces, inChats) = list.partition { it.workspaceId != null }
            items(inSpaces, key = { "$day/${it.id}" }) { EventRow(it, data, onOpen = onOpenEvent) }
            if (inChats.isNotEmpty()) {
                item(key = "dc$day") { Text(stringResource(R.string.cal_chats_section), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp).testTag("agendaChats")) }
                items(inChats, key = { "$day/c/${it.id}" }) { EventRow(it, data, onOpen = onOpenEvent) }
            }
        }
        item { Spacer(Modifier.heightIn(min = 24.dp)) }
    }
}

/** Día: una columna de 24 horas; tocar un hueco crea una reunión a esa hora. */
@Composable
private fun DayView(day: LocalDate, events: List<CalendarEventDTO>, data: BootstrapDTO, zone: ZoneId, onOpenEvent: (String) -> Unit, onCreate: (Int) -> Unit) {
    val hourH = 56.dp
    val scroll = rememberScrollState()
    val density = androidx.compose.ui.platform.LocalDensity.current
    // Al abrir: la hora actual (hoy) o las 7:00, con una hora de margen arriba.
    LaunchedEffect(day) {
        val h = if (day == LocalDate.now()) maxOf(0, LocalTime.now().hour - 1) else 7
        scroll.scrollTo(with(density) { (hourH * h).roundToPx() })
    }
    val spans = events.mapNotNull { e -> spanOf(e)?.let { e to it } }
    val (allDay, timed) = spans.partition { (_, s) -> com.tiecoms.app.core.CalendarGrid.allDay(s, day, zone) }
    val slots = timed.mapNotNull { (e, s) -> com.tiecoms.app.core.CalendarGrid.slot(s, day, zone)?.let { e to it } }.sortedBy { it.second.startMin }
    // Carriles para las que se cruzan: cada una en el primero libre.
    val laneEnds = mutableListOf<Int>()
    val lanes = slots.map { (e, sl) ->
        val lane = laneEnds.indexOfFirst { it <= sl.startMin }.let { if (it < 0) { laneEnds += sl.endMin; laneEnds.lastIndex } else { laneEnds[it] = sl.endMin; it } }
        Triple(e, sl, lane)
    }
    val laneCount = maxOf(1, laneEnds.size)
    Column(Modifier.fillMaxSize().testTag("calDay")) {
        allDay.forEach { (e, _) ->
            val (bg, fg) = eventColors(data, e)
            Surface(color = bg, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp).clickable { onOpenEvent(e.id) }.testTag("calAllDay-${e.id}")) {
                Text(stringResource(R.string.cal_all_day) + " · " + videoMark(e) + e.title, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }
        if (events.isEmpty()) Text(stringResource(R.string.cal_empty_day), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("calDayEmpty"))
        Box(Modifier.fillMaxWidth().weight(1f).verticalScroll(scroll)) {
            androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().height(hourH * 24)) {
                // La hora («11:00 a. m.») cabe entera también con texto grande.
                val gutter = (72 * density.fontScale.coerceAtLeast(1f)).dp
                for (h in 0 until 24) {
                    val hourText = LocalTime.of(h, 0).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))
                    val cd = stringResource(R.string.cal_new_at, hourText)
                    Row(Modifier.offset(y = hourH * h).fillMaxWidth().height(hourH)
                        .clickable(onClickLabel = cd) { onCreate(h) }.semantics { contentDescription = cd }.testTag("calHour-$h")) {
                        Text(hourText, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false,
                            modifier = Modifier.width(gutter).padding(start = 8.dp, top = 2.dp))
                        androidx.compose.material3.HorizontalDivider(Modifier.weight(1f).padding(end = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
                val colW = (maxWidth - gutter - 12.dp) / laneCount
                lanes.forEach { (e, sl, lane) ->
                    val (bg, fg) = eventColors(data, e)
                    val top = hourH * (sl.startMin / 60f)
                    val height = (hourH * ((sl.endMin - sl.startMin) / 60f)).coerceAtLeast(28.dp)
                    Surface(color = bg, shape = RoundedCornerShape(8.dp), shadowElevation = 1.dp,
                        modifier = Modifier.offset(x = gutter + colW * lane, y = top).width(colW - 2.dp).height(height).clickable { onOpenEvent(e.id) }
                            .semantics(mergeDescendants = true) { contentDescription = listOf(e.title, fmtWhen(e)).joinToString(", ") }.testTag("calDayEvent-${e.id}")) {
                        Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
                            Text(videoMark(e) + e.title, color = fg, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                textDecoration = if (e.cancelledAt != null) androidx.compose.ui.text.style.TextDecoration.LineThrough else null)
                            if (height >= 44.dp) Text(fmtTime(e.startsAt) + "–" + fmtTime(e.endsAt), color = fg, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                // Línea de «ahora».
                if (day == LocalDate.now()) {
                    val n = LocalTime.now()
                    Box(Modifier.offset(x = gutter, y = hourH * ((n.hour * 60 + n.minute) / 60f)).fillMaxWidth().height(2.dp).background(Brand.Orange).testTag("calNow"))
                }
            }
        }
    }
}

/** Mes: cuadrícula 6×7 que empieza en lunes, con títulos (o puntos) y «+N más»; tocar un día abre la vista Día. */
@Composable
private fun MonthView(anchor: LocalDate, events: List<CalendarEventDTO>, data: BootstrapDTO, zone: ZoneId, onDay: (LocalDate) -> Unit) {
    val month = java.time.YearMonth.from(anchor)
    val grid = com.tiecoms.app.core.CalendarGrid.monthGrid(month)
    val today = LocalDate.now()
    val fontScale = androidx.compose.ui.platform.LocalDensity.current.fontScale
    // Con texto grande cabe un título por día (los demás van en «+N más»); con texto normal, dos.
    val maxLines = if (fontScale >= 1.3f) 1 else 2
    val spans = events.mapNotNull { e -> spanOf(e)?.let { e to it } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 8.dp).testTag("calMonth")) {
        Row(Modifier.fillMaxWidth()) {
            (0 until 7).forEach { i ->
                val dow = DayOfWeek.MONDAY.plus(i.toLong())
                Text(dow.getDisplayName(java.time.format.TextStyle.SHORT, Locale.getDefault()).replaceFirstChar { it.uppercase() }, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Clip,
                    modifier = Modifier.weight(1f).padding(vertical = 4.dp))
            }
        }
        if (spans.none { (_, s) -> grid.any { d -> d.month == month.month && com.tiecoms.app.core.CalendarGrid.overlaps(s, d, zone) } })
            Text(stringResource(R.string.cal_empty_month), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(4.dp).testTag("calMonthEmpty"))
        grid.chunked(7).forEachIndexed { w, week ->
            Row(Modifier.fillMaxWidth().height(androidx.compose.foundation.layout.IntrinsicSize.Min).testTag("calWeekRow-$w")) {
                week.forEach { d ->
                    val here = spans.filter { (_, s) -> com.tiecoms.app.core.CalendarGrid.overlaps(s, d, zone) }.map { it.first }
                    val cell = com.tiecoms.app.core.CalendarGrid.cell(here, maxLines + 1)
                    val inMonth = d.month == month.month
                    val longDay = d.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL))
                    val cd = androidx.compose.ui.res.pluralStringResource(R.plurals.cal_day_cd, here.size, longDay, here.size)
                    Column(Modifier.weight(1f).fillMaxHeight().heightIn(min = 72.dp).padding(1.dp)
                        .background(if (d == today) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f) else MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(6.dp))
                        .clickable { onDay(d) }.semantics(mergeDescendants = true) { contentDescription = cd }.padding(3.dp).testTag("calCell-$d")) {
                        Text(d.dayOfMonth.toString(), style = MaterialTheme.typography.labelMedium, fontWeight = if (d == today) FontWeight.Bold else FontWeight.Normal, maxLines = 1,
                            color = when { d == today -> MaterialTheme.colorScheme.primary; inMonth -> MaterialTheme.colorScheme.onSurface; else -> MaterialTheme.colorScheme.outline })
                        cell.shown.forEach { e ->
                            val (bg, fg) = eventColors(data, e)
                            Text(videoMark(e) + e.title, color = fg, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.fillMaxWidth().padding(top = 1.dp).background(bg, RoundedCornerShape(3.dp)).padding(horizontal = 2.dp).testTag("calCellEvent-${e.id}"))
                        }
                        if (cell.more > 0) Text(stringResource(R.string.cal_more, cell.more), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("calMore-$d"))
                    }
                }
            }
        }
        Spacer(Modifier.heightIn(min = AssistantListInset + 16.dp))
    }
}
