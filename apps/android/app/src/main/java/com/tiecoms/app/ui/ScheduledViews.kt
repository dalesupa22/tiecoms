package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.ScheduledMessageDTO
import com.tiecoms.app.core.Scheduling
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** «mañana a las 8:00 a. m.», «hoy a las 6:00 p. m.», «el lun 5 oct a las 8:00 a. m.» (whenLabel de la web). */
fun schedWhen(ctx: Context, at: Instant, now: Instant = Instant.now()): String {
    val z = at.atZone(ZoneId.systemDefault())
    val time = z.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.getDefault()))
    return when (Scheduling.dayOf(at, now)) {
        Scheduling.Day.TODAY -> ctx.getString(R.string.sched_today_at, time)
        Scheduling.Day.TOMORROW -> ctx.getString(R.string.sched_tomorrow_at, time)
        Scheduling.Day.OTHER -> ctx.getString(R.string.sched_day_at, z.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault())), time)
    }
}

fun schedOptionLabel(ctx: Context, o: Scheduling.Option) = ctx.getString(when (o) {
    Scheduling.Option.IN_HOUR -> R.string.sched_in_hour
    Scheduling.Option.THIS_AFTERNOON -> R.string.sched_this_afternoon
    Scheduling.Option.TOMORROW_MORNING -> R.string.sched_tomorrow_morning
    Scheduling.Option.MONDAY -> R.string.sched_monday
})

/**
 * Menú «Programar envío»: las opciones de un toque con su hora («Mañana temprano · mañana a las 8:00») y
 * «Elegir fecha y hora…», que abre el selector.
 */
@Composable
fun ScheduleSheet(onPick: (Instant) -> Unit, onDismiss: () -> Unit, initial: Instant? = null) {
    val ctx = LocalContext.current
    var picking by remember { mutableStateOf(false) }
    if (picking) { PickWhenDialog(initial, onPick = { onPick(it) }, onDismiss = { picking = false; onDismiss() }); return }
    val items = buildList<SheetItem?> {
        Scheduling.options().forEach { (o, at) ->
            add(SheetItem(schedOptionLabel(ctx, o) + " · " + schedWhen(ctx, at), "🕒", tag = "sched-${o.name}") { onDismiss(); onPick(at) })
        }
        add(null)
        add(SheetItem(ctx.getString(R.string.sched_pick), "📅", tag = "schedPick") { picking = true })
    }
    ActionSheet(ctx.getString(R.string.sched_menu_title), items, onDismiss)
}

/** «¿Cuándo lo envío?»: día y hora (hora local), con «Se enviará mañana a las 8:00». */
@Composable
fun PickWhenDialog(initial: Instant?, onPick: (Instant) -> Unit, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    val start = initial?.atZone(ZoneId.systemDefault()) ?: Scheduling.defaultPick()
    var date by rememberSaveable { mutableStateOf(start.toLocalDate().toString()) }
    var time by rememberSaveable { mutableStateOf(start.toLocalTime().withSecond(0).withNano(0).toString()) }
    val d = LocalDate.parse(date); val t = LocalTime.parse(time)
    val at = Scheduling.picked(d, t.hour, t.minute)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sched_pick_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                DateField(stringResource(R.string.sched_date), d, { it?.let { v -> date = v.toString() } }, modifier = Modifier.fillMaxWidth(), tag = "schedDate")
                TimeField(stringResource(R.string.sched_time), t, { time = it.toString() }, modifier = Modifier.fillMaxWidth())
                Text(if (at != null) ctx.getString(R.string.sched_will_send, schedWhen(ctx, at)) else stringResource(R.string.sched_future),
                    color = if (at != null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { Button(onClick = { at?.let { onDismiss(); onPick(it) } }, enabled = at != null, modifier = Modifier.testTag("schedConfirm")) { Text("🕒 " + stringResource(R.string.sched_confirm)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

/** Programa [body] y avisa «🕒 Programado para mañana a las 8:00» con «Deshacer». */
fun scheduleWithUndo(ctx: Context, container: com.tiecoms.app.AppContainer, snackbar: androidx.compose.material3.SnackbarHostState, conversationId: String,
                     body: String, mentions: List<com.tiecoms.app.core.MentionDTO>, replyTo: String?, at: Instant, onUndo: (String) -> Unit = {}) {
    val client = container.client.value
    container.scope.launch {
        try {
            val s = client.scheduleMessage(conversationId, body, at, mentions, replyTo)
            val r = snackbar.showSnackbar("🕒 " + ctx.getString(R.string.sched_done, schedWhen(ctx, at)), actionLabel = ctx.getString(R.string.undo), duration = SnackbarDuration.Short)
            if (r == SnackbarResult.ActionPerformed) { runCatching { client.cancelScheduled(s.id) }; onUndo(body) }
        } catch (e: Exception) { snackbar.showSnackbar(errorText(ctx, e)) }
    }
}

@Composable
private fun ScheduledRow(s: ScheduledMessageDTO, showWhere: Boolean, onOpenConversation: ((String) -> Unit)?) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    val data = client.state.collectAsStateWithLifecycle().value.data
    val conv = data?.conversations?.firstOrNull { it.id == s.conversationId }
    val failed = s.status == "failed"
    var editing by remember(s.id) { mutableStateOf(false) }
    var body by remember(s.id, s.body) { mutableStateOf(s.body) }
    var changing by remember { mutableStateOf(false) }
    fun run(ok: String? = null, block: suspend () -> Unit) = container.scope.launch {
        try { block(); ok?.let { snackbar.showSnackbar(it) } } catch (e: Exception) { snackbar.showSnackbar(errorText(ctx, e)) }
    }
    val sendAt = parseInstant(s.sendAt)
    Surface(shape = RoundedCornerShape(12.dp), color = if (failed) Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE).copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth().testTag("sched-${s.id}")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (failed) "⚠ " + stringResource(R.string.sched_failed) else "🕒 " + (sendAt?.let { schedWhen(ctx, it) } ?: ""),
                    fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge,
                    color = if (failed) Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE) else MaterialTheme.colorScheme.onSurface)
                if (showWhere && conv != null) Text(" · " + titleOf(ctx, conv, data), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).clickable(enabled = onOpenConversation != null) { onOpenConversation?.invoke(conv.id) })
            }
            if (editing) {
                OutlinedTextField(body, { body = it.take(8000) }, maxLines = 6, modifier = Modifier.fillMaxWidth().testTag("schedEditField"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.align(Alignment.End)) {
                    TextButton(onClick = { editing = false; body = s.body }) { Text(stringResource(R.string.cancel)) }
                    Button(onClick = { val v = body.trim(); run { client.updateScheduled(s.id, body = v); editing = false } }, enabled = body.isNotBlank(),
                        modifier = Modifier.testTag("schedEditSave")) { Text(stringResource(R.string.sched_save)) }
                }
            } else Text(com.tiecoms.app.ui.excerpt(s.body, 400), style = MaterialTheme.typography.bodyMedium)
            if (failed && !s.error.isNullOrBlank()) Text(s.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            if (!editing) androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(onClick = { run(ctx.getString(R.string.sched_sent_now)) { client.sendScheduledNow(s.id) } }, modifier = Modifier.heightIn(min = 48.dp).testTag("schedSendNow")) {
                    Text("➤ " + stringResource(R.string.sched_send_now))
                }
                OutlinedButton(onClick = { changing = true }, modifier = Modifier.heightIn(min = 48.dp).testTag("schedChange")) {
                    Text("🕒 " + stringResource(if (failed) R.string.sched_retry_later else R.string.sched_change))
                }
                OutlinedButton(onClick = { editing = true }, modifier = Modifier.heightIn(min = 48.dp).testTag("schedEdit")) { Text("✎ " + stringResource(R.string.sched_edit)) }
                TextButton(onClick = {
                    container.scope.launch {
                        try {
                            client.cancelScheduled(s.id)
                            val r = snackbar.showSnackbar(ctx.getString(R.string.sched_cancelled), actionLabel = ctx.getString(R.string.undo), duration = SnackbarDuration.Short)
                            if (r == SnackbarResult.ActionPerformed) client.scheduleMessage(s.conversationId, s.body, Scheduling.undoAt(sendAt ?: Instant.now()), s.mentions, s.replyTo)
                        } catch (e: Exception) { snackbar.showSnackbar(errorText(ctx, e)) }
                    }
                }, modifier = Modifier.heightIn(min = 48.dp).testTag("schedCancel")) { Text(stringResource(R.string.sched_cancel), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
    if (changing) ScheduleSheet(initial = sendAt, onDismiss = { changing = false }, onPick = { at ->
        run(ctx.getString(R.string.sched_moved, schedWhen(ctx, at))) { client.updateScheduled(s.id, sendAt = at) }
    })
}

/** Lista de programados (de un chat o de todos). */
@Composable
fun ScheduledList(conversationId: String?, onOpenConversation: ((String) -> Unit)? = null) {
    val client = LocalClient.current
    val all by client.state.collectAsStateWithLifecycle()
    val list = all.scheduled.filter { conversationId == null || it.conversationId == conversationId }.sortedBy { it.sendAt }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth().testTag("schedList")) {
        if (list.isEmpty()) EmptyNote(stringResource(R.string.sched_empty))
        list.forEach { androidx.compose.runtime.key(it.id) { ScheduledRow(it, showWhere = conversationId == null, onOpenConversation) } }
    }
}

/**
 * Franja sobre el compositor: «🕒 2 mensajes programados · el próximo sale mañana a las 8:00 · Ver»,
 * naranja si alguno falló. «Ver» abre la lista del chat en una hoja.
 */
@Composable
fun ScheduledStrip(conversationId: String) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val list = Scheduling.forConversation(st.scheduled, conversationId)
    var open by remember { mutableStateOf(false) }
    // La hoja sigue abierta aunque se cancele el último: así se ve el aviso con «Deshacer».
    if (open) {
        val local = remember { androidx.compose.material3.SnackbarHostState() }
        FormSheet(stringResource(R.string.sched_title_here), { open = false }, tag = "schedSheet", snackbar = local) { ScheduledList(conversationId) }
    }
    if (list.isEmpty()) return
    val failed = list.count { it.status == "failed" }
    val next = list.firstOrNull { it.status != "failed" }
    val orange = Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE)
    Surface(onClick = { open = true }, color = if (failed > 0) orange.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).testTag("schedStrip")) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text((if (failed > 0) "⚠ " + ctx.getString(R.string.sched_failed_count, failed)
                else "🕒 " + if (list.size == 1) ctx.getString(R.string.sched_one_here) else ctx.getString(R.string.sched_many_here, list.size)) +
                (if (next != null && failed == 0) " · " + ctx.getString(R.string.sched_next, parseInstant(next.sendAt)?.let { schedWhen(ctx, it) } ?: "") else ""),
                style = MaterialTheme.typography.labelLarge, color = if (failed > 0) orange else MaterialTheme.colorScheme.onSurface,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.sched_see), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** Pantalla «Programados» (en Tú y en /programados). */
@Composable
fun ScheduledScreen(onBack: () -> Unit, onOpenConversation: (String) -> Unit) {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    androidx.compose.runtime.LaunchedEffect(Unit) { runCatching { client.loadScheduled() } }
    val n = st.scheduled.size
    SimpleScaffold(stringResource(R.string.nav_scheduled) + if (n > 0) " · $n" else "", onBack) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("scheduledScreen"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text(stringResource(R.string.sched_page_sub), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium) }
            item { ScheduledList(null, onOpenConversation) }
            item { Spacer(Modifier.heightIn(min = 24.dp)) }
        }
    }
}

