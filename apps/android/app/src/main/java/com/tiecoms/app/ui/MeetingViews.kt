package com.tiecoms.app.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.MeetingAttempt
import com.tiecoms.app.core.MeetingConnectionDTO
import com.tiecoms.app.core.MeetingDTO
import com.tiecoms.app.core.Meetings
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** Vuelve a pedir las conexiones al abrir y al volver del navegador (Custom Tabs). */
@Composable
private fun rememberMeetingConnections(): List<MeetingConnectionDTO>? {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    var tick by remember { mutableStateOf(0) }
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) tick++ }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    LaunchedEffect(tick) { runCatching { client.loadMeetingConnections() } }
    return st.meetingConnections
}

/** Abre el enlace https del proveedor: el App Link abre Meet, Teams o Zoom si está instalada; si no, el navegador. */
fun openJoinUrl(ctx: Context, url: String) {
    val i = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
    if (ctx !is android.app.Activity) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { ctx.startActivity(i) }.onFailure { (ctx.applicationContext as com.tiecoms.app.TieComsApp).container.toast(ctx.getString(R.string.sso_no_browser)) }
}

private fun problemText(ctx: Context, p: Meetings.Problem, label: String): String = when (p) {
    Meetings.Problem.NotConnected -> ctx.getString(R.string.meet_err_not_connected, label)
    Meetings.Problem.Reconnect -> ctx.getString(R.string.meet_err_reconnect, label)
    Meetings.Problem.NoTeams -> ctx.getString(R.string.meet_err_no_teams)
    is Meetings.Problem.Unavailable -> ctx.getString(R.string.meet_err_unavailable, label, p.reason)
    is Meetings.Problem.Provider -> ctx.getString(R.string.meet_err_provider, p.message)
    Meetings.Problem.Network -> ctx.getString(R.string.meet_err_network)
    Meetings.Problem.InProgress -> ctx.getString(R.string.meet_err_in_progress)
    is Meetings.Problem.Pending -> ctx.getString(R.string.meet_err_pending)
    is Meetings.Problem.Uncertain -> ctx.getString(R.string.meet_err_uncertain)
    Meetings.Problem.IdempotencyMismatch -> ctx.getString(R.string.meet_err_mismatch)
    is Meetings.Problem.Other -> p.message.ifBlank { ctx.getString(R.string.err_generic) }
}

/** Estado de una conexión en palabras (statusText de la web): el motivo si no está disponible, «Conectada · correo», reconectar o «Sin conectar». */
@Composable
private fun statusLine(c: MeetingConnectionDTO): String = when {
    !c.available -> c.unavailableReason?.takeIf { it.isNotBlank() } ?: stringResource(R.string.meet_unavailable)
    c.status == "active" -> c.accountEmail?.let { stringResource(R.string.meet_connected_as, it) } ?: stringResource(R.string.meet_connected)
    c.status == "reconnect" -> stringResource(R.string.meet_reconnect_hint)
    else -> stringResource(R.string.meet_not_connected)
}

/**
 * «📹 Reunión ahora» / «📅 Agendar reunión con enlace» (menú ＋ del chat): proveedor con su estado, Ahora u hora,
 * duración, título y «Crear y compartir». Una llave por toque, reusada en el reintento, y el botón desactivado
 * mientras crea. Al terminar: el enlace real, «Abrir en Meet / Teams / Zoom» y «Copiar». Sin confirmación del
 * proveedor no se muestra enlace (docs/TANDA-LECTURA-REUNIONES.md §4).
 */
@Composable
fun MeetingDialog(conversationId: String, now: Boolean, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val conv = data.conversations.firstOrNull { it.id == conversationId } ?: return
    val connections = rememberMeetingConnections()
    val list = connections ?: emptyList()
    val attempt = remember(client, conversationId) { client.meetingAttempt(conversationId) }
    var picked by rememberSaveable { mutableStateOf(attempt.payload?.provider) }
    // Como la web: el primero conectado (o el primero disponible, con «Conectar»); se puede elegir cualquiera disponible.
    val provider = picked?.takeIf { p -> list.any { it.provider == p && it.available } } ?: Meetings.defaultProvider(list, null) ?: list.firstOrNull { it.available }?.provider
    val sel = list.firstOrNull { it.provider == provider }
    var instant by rememberSaveable { mutableStateOf(now) }
    val start0 = remember { java.time.ZonedDateTime.now().plusHours(1).withMinute(0).withSecond(0).withNano(0) }
    var date by rememberSaveable { mutableStateOf(start0.toLocalDate().toString()) }
    var time by rememberSaveable { mutableStateOf(start0.toLocalTime().toString()) }
    var duration by rememberSaveable { mutableStateOf(30) }
    val defaultTitle = stringResource(R.string.meet_default_title, titleOf(ctx, conv, data))
    var title by rememberSaveable { mutableStateOf(defaultTitle) }
    val attemptRevision by attempt.revision.collectAsStateWithLifecycle()
    val busy = remember(attemptRevision) { attempt.creating }
    var problem by remember { mutableStateOf(attempt.lastProblem?.let { it to (attempt.payload?.provider ?: "") }) }
    val result = remember(attemptRevision) { attempt.result }
    val labelOf: (String) -> String = { p -> list.firstOrNull { it.provider == p }?.label?.ifBlank { null } ?: Meetings.label(p) }
    // Cambiar algo del formulario es otra reunión: llave nueva. Un reintento sin cambios reusa la misma.
    LaunchedEffect(provider, instant, date, time, duration, title) { attempt.reset() }

    fun create() {
        val p = attempt.payload?.provider ?: provider?.takeIf { sel?.connected == true } ?: return
        val startsAt = if (instant) null else runCatching { LocalDate.parse(date).atTime(LocalTime.parse(time)).atZone(ZoneId.systemDefault()).toInstant() }.getOrNull()
        if (attempt.payload == null && !instant && (startsAt == null || startsAt.isBefore(Instant.now().minusSeconds(60)))) { problem = Meetings.Problem.Other(ctx.getString(R.string.meet_err_past)) to p; return }
        val payload = attempt.payload ?: com.tiecoms.app.core.MeetingRequest(p, conversationId, title.trim(), startsAt?.toString(), duration, ZoneId.systemDefault().id)
        val key = try { attempt.begin(payload) } catch (_: Exception) {
            problem = Meetings.Problem.Other(ctx.getString(R.string.err_generic)) to p
            return
        } ?: return
        val generation = client.sessionGeneration
        fun current() = client.sessionGeneration == generation && container.client.value === client
        problem = null
        // Keep the original operation across dismissal/restart; recovery always uses its frozen key and payload.
        container.scope.launch {
            try {
                val m = client.resolveMeetingAttempt(payload, key, attempt.meetingId)
                if (!current()) return@launch
                if (m.usableUrl != null) { attempt.succeeded(m) }
                else {
                    val pr = if (m.status == "creating") Meetings.Problem.Pending(m.id) else Meetings.Problem.Uncertain(m.id)
                    attempt.failed(problem = pr, id = m.id); problem = pr to p
                }
            } catch (e: Exception) {
                if (!current() || e is kotlinx.coroutines.CancellationException) return@launch
                val pr = Meetings.problem(e)
                attempt.failed(keepKey = Meetings.mustKeepAttempt(e, attempt.meetingId), problem = pr, id = Meetings.meetingId(e))
                problem = pr to p
                if (pr == Meetings.Problem.NotConnected || pr == Meetings.Problem.Reconnect || pr is Meetings.Problem.Unavailable) runCatching { client.loadMeetingConnections() }
            }
        }
    }

    fun closeSheet() { if (attempt.result != null) attempt.dismissResult(); onClose() }
    FormSheet(stringResource(if (now) R.string.meet_title_now else R.string.meet_title_schedule), ::closeSheet, tag = "meetingDialog") {
        val done = result
        if (done != null) {
            MeetingResult(done, labelOf(done.provider), ::closeSheet)
            return@FormSheet
        }
        SectionHeader(stringResource(R.string.meet_provider))
        Text(stringResource(R.string.meet_settings_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (connections == null) CircularProgressIndicator(Modifier.padding(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            list.forEach { c ->
                val status = statusLine(c)
                FilterChip(
                    selected = c.provider == provider, enabled = c.available && !busy && !attempt.locked,
                    onClick = { picked = c.provider },
                    label = {
                        Column(Modifier.padding(vertical = 4.dp)) {
                            Text(c.label.ifBlank { Meetings.label(c.provider) }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(status, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                color = if (c.connected) MaterialTheme.colorScheme.onSurfaceVariant else if (c.available) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline)
                        }
                    },
                    modifier = Modifier.heightIn(min = 56.dp).semantics { contentDescription = "${c.label}: $status" }.testTag("meetProvider-${c.provider}"),
                )
            }
        }
        // «No disponible» dice por qué en su chip (falta registrar la app OAuth en el servidor), sin un botón que no funciona.
        // El elegido sin conectar: «Conectar Google Meet» / «Reconectar» (Custom Tabs).
        if (!attempt.locked && sel != null && sel.available && !sel.connected) OutlinedButton(onClick = { container.startMeetingConnect(ctx, sel.provider) }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetConnectSel")) {
            Text(if (sel.status == "reconnect") stringResource(R.string.meet_reconnect) else stringResource(R.string.meet_connect_to, sel.label))
        }
        if (connections != null && list.none { it.available }) Text(stringResource(R.string.meet_none_available), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("meetNoneAvailable"))

        if (attempt.locked) {
            Text(stringResource(R.string.meet_request_held, attempt.payload?.title.orEmpty()), modifier = Modifier.testTag("meetHeld"))
        } else {
        SectionHeader(stringResource(R.string.meet_when))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(instant, { instant = true }, label = { Text(stringResource(R.string.meet_when_now)) }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetNowChip"))
            FilterChip(!instant, { instant = false }, label = { Text(stringResource(R.string.meet_when_later)) }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetLaterChip"))
        }
        if (!instant) {
            DateField(stringResource(R.string.cal_date), LocalDate.parse(date), { it?.let { d -> date = d.toString() } }, modifier = Modifier.fillMaxWidth(), tag = "meetDate")
            TimeField(stringResource(R.string.cal_start), LocalTime.parse(time), { time = it.toString() }, Modifier.fillMaxWidth())
        }
        SectionHeader(stringResource(R.string.meet_duration))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Meetings.DURATIONS.forEach { m ->
                FilterChip(duration == m, { duration = m }, label = { Text(stringResource(R.string.meet_minutes, m)) }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetDur-$m"))
            }
        }
        OutlinedTextField(title, { title = it.take(200) }, label = { Text(stringResource(R.string.meet_field_title)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("meetTitle"))
        }
        (problem ?: attempt.lastProblem?.let { it to (attempt.payload?.provider ?: "") })?.let { (pr, p) ->
            Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().testTag("meetProblem")) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(problemText(ctx, pr, labelOf(p)), color = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    if (pr == Meetings.Problem.NotConnected || pr == Meetings.Problem.Reconnect) OutlinedButton(onClick = { container.startMeetingConnect(ctx, p) }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetProblemConnect")) {
                        Text(stringResource(if (pr == Meetings.Problem.Reconnect) R.string.meet_reconnect else R.string.meet_connect))
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = ::closeSheet) { Text(stringResource(R.string.cancel)) }
            Button(onClick = { create() }, enabled = !busy && (attempt.locked || (sel?.connected == true && title.trim().length >= 2)) && (problem?.first ?: attempt.lastProblem) != Meetings.Problem.IdempotencyMismatch, modifier = Modifier.heightIn(min = 48.dp).testTag("meetCreate")) {
                if (busy) { CircularProgressIndicator(Modifier.padding(end = 8.dp).width(18.dp).heightIn(max = 18.dp), strokeWidth = 2.dp); Text(stringResource(R.string.meet_creating)) }
                else Text(stringResource(if (attempt.meetingId != null) R.string.meet_check_status else if (attempt.locked) R.string.meet_retry_same else R.string.meet_create_share))
            }
        }
    }
}

@Composable
private fun MeetingResult(m: MeetingDTO, label: String, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val url = m.usableUrl ?: return
    Text("✓ " + stringResource(R.string.meet_created) + " · " + label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("meetCreated"))
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        SelectionContainer { Text(url, Modifier.padding(12.dp).testTag("meetUrl"), style = MaterialTheme.typography.bodyMedium) }
    }
    Text(stringResource(if (m.shared) R.string.meet_shared_note else R.string.meet_not_shared_note), style = MaterialTheme.typography.bodySmall,
        color = if (m.shared) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error, modifier = Modifier.testTag("meetSharedNote"))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Button(onClick = { openJoinUrl(ctx, url) }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetOpen")) { Text("📹 " + stringResource(R.string.meet_open_in, Meetings.appName(m.provider))) }
        OutlinedButton(onClick = { copyToClipboard(ctx, url); container.toast(ctx.getString(R.string.meet_copied)) }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetCopy")) { Text(stringResource(R.string.meet_copy)) }
        TextButton(onClick = onClose, modifier = Modifier.heightIn(min = 48.dp).testTag("meetDone")) { Text(stringResource(R.string.meet_done)) }
    }
}

/** Ajustes › «Reuniones»: Conectar, Reconectar y Desconectar por proveedor, con el correo de la cuenta. */
@Composable
fun MeetingsSettingsSection() {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val connections = rememberMeetingConnections()
    Column(Modifier.fillMaxWidth().padding(16.dp).testTag("meetingsSettings"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("📹 " + stringResource(R.string.meet_settings_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
        Text(stringResource(R.string.meet_settings_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (connections == null) CircularProgressIndicator(Modifier.padding(4.dp))
        connections.orEmpty().forEach { c ->
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("meetRow-${c.provider}"), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(c.label.ifBlank { Meetings.label(c.provider) }, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                    Text(statusLine(c), style = MaterialTheme.typography.bodySmall, color = if (c.status == "reconnect" || !c.available) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("meetStatus-${c.provider}"))
                }
                Spacer(Modifier.width(8.dp))
                Column(horizontalAlignment = Alignment.End) {
                    if (c.available && c.status != "active") Button(onClick = { container.startMeetingConnect(ctx, c.provider) }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetConnect-${c.provider}")) {
                        Text(stringResource(if (c.status == "reconnect") R.string.meet_reconnect else R.string.meet_connect))
                    }
                    if (c.status != "none") TextButton(onClick = {
                        container.scope.launch {
                            runCatching { client.disconnectMeeting(c.provider) }.onSuccess { container.toast(ctx.getString(R.string.meet_disconnected_toast, c.label)) }.onFailure { container.toast(errorText(ctx, it)) }
                        }
                    }, modifier = Modifier.heightIn(min = 48.dp).testTag("meetDisconnect-${c.provider}")) { Text(stringResource(R.string.meet_disconnect), color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}
