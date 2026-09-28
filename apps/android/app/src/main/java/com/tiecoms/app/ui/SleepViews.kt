package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.SleepDTO
import com.tiecoms.app.core.SleepMode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** «10:00 p. m.» de un HH:MM. */
fun hourLabel(hhmm: String): String = runCatching {
    LocalTime.parse(hhmm).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.getDefault()))
}.getOrDefault(hhmm)

fun sleepSummary(ctx: Context, s: SleepDTO?): String? = s?.let { if (it.on) ctx.getString(R.string.sleep_summary, hourLabel(it.start), hourLabel(it.end)) else ctx.getString(R.string.sleep_off) }

/** Minuto actual, para que los avisos entren y salgan solos. */
@Composable
fun rememberMinute(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(60_000 - System.currentTimeMillis() % 60_000); now = System.currentTimeMillis() } }
    return now
}

/** ¿Estoy ahora en mi horario de descanso? (la lunita del avatar se enciende también ahí). */
@Composable
fun mySleepingNow(): Boolean {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val now = rememberMinute()
    return SleepMode.sleepingNow(SleepMode.of(st.data?.me?.sleep), Instant.ofEpochMilli(now))
}

/** «🌙 Todas las noches»: interruptor, desde / hasta (22:00–07:00 por defecto) y la zona del teléfono. */
@Composable
fun SleepDialog(onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val cur = client.state.collectAsStateWithLifecycle().value.data?.me?.sleep
    var on by rememberSaveable { mutableStateOf(cur?.on ?: true) }
    var start by rememberSaveable { mutableStateOf(cur?.start ?: SleepMode.DEFAULT_START) }
    var end by rememberSaveable { mutableStateOf(cur?.end ?: SleepMode.DEFAULT_END) }
    var busy by remember { mutableStateOf(false) }
    val tz = ZoneId.systemDefault().id
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("🌙 " + stringResource(R.string.sleep_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.testTag("sleepDialog")) {
                Text(stringResource(R.string.sleep_explain), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.fillMaxWidth().clickable(role = Role.Switch) { on = !on }.heightIn(min = 56.dp).semantics(mergeDescendants = true) {}.testTag("sleepSwitch"),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.sleep_switch), fontWeight = FontWeight.SemiBold)
                        Text(if (on) ctx.getString(R.string.sleep_summary, hourLabel(start), hourLabel(end)) else stringResource(R.string.sleep_off),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = on, onCheckedChange = null)
                }
                if (on) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TimeField(stringResource(R.string.sleep_from), LocalTime.parse(start), { start = it.toString() }, modifier = Modifier.weight(1f))
                    TimeField(stringResource(R.string.sleep_to), LocalTime.parse(end), { end = it.toString() }, modifier = Modifier.weight(1f))
                }
                Text(stringResource(R.string.sleep_tz, tz), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
            }
        },
        confirmButton = {
            Button(enabled = !busy && !(on && start == end), onClick = {
                busy = true
                container.scope.launch {
                    try {
                        if (cur?.tz != tz) client.setSleep(on = on, start = start, end = end, tz = tz, tzAuto = true) else client.setSleep(on = on, start = start, end = end)
                        container.toast(if (on) ctx.getString(R.string.sleep_saved, hourLabel(start), hourLabel(end)) else ctx.getString(R.string.sleep_saved_off))
                        onClose()
                    } catch (e: Exception) { container.toast(errorText(ctx, e)) } finally { busy = false }
                }
            }, modifier = Modifier.testTag("sleepSave")) { Text(stringResource(R.string.sched_save)) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.cancel)) } },
    )
}

/**
 * Aviso sobre el compositor si a quien escribo le toca descansar (SleepNotice de la web): en un directo siempre,
 * en grupos solo mientras escribo; con «🕒 Enviar a las 7:00», que programa el mensaje para cuando despierte.
 */
@Composable
fun SleepNotice(data: BootstrapDTO, memberIds: List<String>, typing: Boolean, onSchedule: ((Instant) -> Unit)?) {
    val ctx = LocalContext.current
    val now = rememberMinute()
    val n = SleepMode.notice(data, memberIds, typing, Instant.ofEpochMilli(now)) ?: return
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }.testTag("sleepNotice")) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("🌙", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.width(8.dp))
            Text(when (n) {
                is SleepMode.Notice.One -> ctx.getString(R.string.sleep_notice_one, com.tiecoms.app.core.IssueTasks.firstName(n.person.name), schedWhen(ctx, n.wake))
                is SleepMode.Notice.Many -> ctx.getString(R.string.sleep_notice_many, n.count)
            }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.weight(1f))
            if (n is SleepMode.Notice.One && n.canSchedule && onSchedule != null) {
                Spacer(Modifier.width(8.dp))
                val time = n.wake.atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.getDefault()))
                OutlinedButton(onClick = { onSchedule(n.wake) }, modifier = Modifier.heightIn(min = 48.dp).testTag("sleepScheduleWake")) {
                    Text("🕒 " + ctx.getString(R.string.sleep_schedule_wake, time), style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}
