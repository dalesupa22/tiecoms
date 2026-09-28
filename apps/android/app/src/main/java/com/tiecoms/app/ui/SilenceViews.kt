package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.Silence
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * SPEC-silencio en Android: opciones de silencio de un chat, interruptor de Detalles, «No molestar» en «Tú»,
 * la franja fina de Grupos y DMs, la lunita y el 🔕 gris de las filas.
 */

/** «Silenciado hasta las 18:00», «Silenciado hasta el mar 30 sep, 18:00» o «Silenciado»; null si no lo está. */
fun muteStatusText(ctx: Context, mutedUntil: String?, nowMs: Long = System.currentTimeMillis()): String? =
    when (val st = Silence.status(mutedUntil, nowMs)) {
        Silence.Status.Off -> null
        Silence.Status.Forever -> ctx.getString(R.string.side_muted)
        is Silence.Status.Until -> Silence.whenText(st.atMs, nowMs).let { w -> ctx.getString(if (w.sameDay) R.string.mute_until_time else R.string.mute_until_date, w.text) }
    }

/** Franja: «No molestar hasta las 18:00» (o solo «No molestar» si es hasta que lo reactive). */
fun dndBannerText(ctx: Context, dndUntil: String?, nowMs: Long = System.currentTimeMillis()): String? =
    when (val st = Silence.status(dndUntil, nowMs)) {
        Silence.Status.Off -> null
        Silence.Status.Forever -> ctx.getString(R.string.dnd_title)
        is Silence.Status.Until -> Silence.whenText(st.atMs, nowMs).let { w -> ctx.getString(if (w.sameDay) R.string.dnd_until_time else R.string.dnd_until_date, w.text) }
    }

/** Estado de la fila de «Tú»: «Activo hasta las 18:00», «Activo» o «Desactivado». */
fun dndRowText(ctx: Context, dndUntil: String?, nowMs: Long = System.currentTimeMillis()): String =
    when (val st = Silence.status(dndUntil, nowMs)) {
        Silence.Status.Off -> ctx.getString(R.string.dnd_off)
        Silence.Status.Forever -> ctx.getString(R.string.dnd_on)
        is Silence.Status.Until -> Silence.whenText(st.atMs, nowMs).let { w -> ctx.getString(if (w.sameDay) R.string.dnd_on_until_time else R.string.dnd_on_until_date, w.text) }
    }

/** Hora actual que se renueva sola cuando vence alguno de estos silencios (la franja o el 🔕 se van a tiempo). */
@Composable
fun rememberSilenceNow(vararg isos: String?): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val key = isos.toList()
    LaunchedEffect(key, now) {
        val wait = key.mapNotNull { Silence.msUntilChange(it, now) }.minOrNull() ?: return@LaunchedEffect
        delay(wait.coerceAtMost(60 * 60_000L))
        now = System.currentTimeMillis()
    }
    return now
}

/** Opciones de silencio de un chat: 1 hora · 8 horas · 1 semana · Hasta que lo reactive. */
fun muteChoices(ctx: Context, onPick: (Silence.MuteOption) -> Unit): List<SheetItem> = listOf(
    SheetItem(ctx.getString(R.string.mute_1h), tag = "mute1h") { onPick(Silence.MuteOption.HOUR_1) },
    SheetItem(ctx.getString(R.string.mute_8h), tag = "mute8h") { onPick(Silence.MuteOption.HOURS_8) },
    SheetItem(ctx.getString(R.string.mute_week), tag = "muteWeek") { onPick(Silence.MuteOption.WEEK) },
    SheetItem(ctx.getString(R.string.mute_forever), tag = "muteForever") { onPick(Silence.MuteOption.FOREVER) },
)

/** Silencia o reactiva un chat (optimista, con aviso breve y error si falla). */
fun setMute(ctx: Context, conversationId: String, option: Silence.MuteOption?) {
    val container = (ctx.applicationContext as com.tiecoms.app.TieComsApp).container
    val client = container.client.value
    container.scope.launch {
        runCatching { client.setConversationPrefs(conversationId, mutedUntil = option?.let { Silence.muteUntil(it, System.currentTimeMillis()) }) }
            .onSuccess { container.toast(ctx.getString(if (option == null) R.string.toast_unmuted else R.string.toast_muted)) }
            .onFailure { container.toast(errorText(ctx, it)) }
    }
}

/** Menú de silencio (encabezado, pulsación larga): «Silenciar ›» con las opciones, o «Reactivar notificaciones». */
fun muteMenuItem(ctx: Context, conv: ConversationDTO): SheetItem =
    if (conv.mutedAt(System.currentTimeMillis()))
        SheetItem(ctx.getString(R.string.menu_unmute), "🔔", tag = "menuUnmute", subtitle = muteStatusText(ctx, conv.mutedUntil)) { setMute(ctx, conv.id, null) }
    else SheetItem(ctx.getString(R.string.menu_mute), "🔕", tag = "menuMute", children = muteChoices(ctx) { setMute(ctx, conv.id, it) })

/** 🔕 gris y pequeño junto al título de un chat silenciado. */
@Composable
fun MutedMark(size: Dp = 14.dp, tag: String? = null) {
    val cd = stringResource(R.string.side_muted)
    Box(Modifier.padding(start = 4.dp).semantics { contentDescription = cd }.let { if (tag != null) it.testTag(tag) else it }) {
        Icon(Icons.Filled.NotificationsOff, null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f), modifier = Modifier.size(size))
    }
}

/** Interruptor «Silenciar» de Detalles con el tiempo restante; al encenderlo pide cuánto tiempo. */
@Composable
fun MuteSwitchRow(conv: ConversationDTO) {
    val ctx = LocalContext.current
    val now = rememberSilenceNow(conv.mutedUntil)
    val muted = Silence.active(conv.mutedUntil, now)
    var ask by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Switch) { if (muted) setMute(ctx, conv.id, null) else ask = true }
            .heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 10.dp).semantics(mergeDescendants = true) {}.testTag("muteSwitchRow"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.menu_mute), style = MaterialTheme.typography.titleMedium)
            Text(muteStatusText(ctx, conv.mutedUntil, now) ?: stringResource(R.string.mute_switch_off), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("muteStatus"))
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = muted, onCheckedChange = null, modifier = Modifier.testTag("muteSwitch"))
    }
    if (ask) ActionSheet(stringResource(R.string.menu_mute), muteChoices(ctx) { o -> ask = false; setMute(ctx, conv.id, o) }) { ask = false }
}

/** Opciones de «No molestar»: 1 hora · 8 horas · Hasta mañana · Hasta que lo reactive (y Reactivar si está activo). */
@Composable
fun DndSheet(onDismiss: () -> Unit, onNightly: () -> Unit = {}) {
    val ctx = LocalContext.current
    val container = com.tiecoms.app.ui.LocalContainer.current
    val client = LocalClient.current
    val state by client.state.collectAsStateWithLifecycle()
    fun set(o: Silence.DndOption?) {
        onDismiss()
        container.scope.launch {
            runCatching { client.setDnd(o?.let { Silence.dndUntil(it, System.currentTimeMillis()) }) }
                .onFailure { container.toast(errorText(ctx, it)) }
        }
    }
    val active = Silence.active(state.dndUntil, System.currentTimeMillis())
    val items = buildList<SheetItem?> {
        add(SheetItem(ctx.getString(R.string.mute_1h), tag = "dnd1h") { set(Silence.DndOption.HOUR_1) })
        add(SheetItem(ctx.getString(R.string.mute_8h), tag = "dnd8h") { set(Silence.DndOption.HOURS_8) })
        add(SheetItem(ctx.getString(R.string.dnd_tomorrow), tag = "dndTomorrow") { set(Silence.DndOption.TOMORROW) })
        add(SheetItem(ctx.getString(R.string.mute_forever), tag = "dndForever") { set(Silence.DndOption.FOREVER) })
        if (active) { add(null); add(SheetItem(ctx.getString(R.string.dnd_turn_off), "🔔", tag = "dndOff") { set(null) }) }
        // «Todas las noches» (modo sueño) va dentro de No molestar, con desde y hasta.
        add(null)
        add(SheetItem(ctx.getString(R.string.sleep_title), "🌙", subtitle = sleepSummary(ctx, state.data?.me?.sleep), tag = "dndNightly") { onDismiss(); onNightly() })
    }
    ActionSheet(ctx.getString(R.string.dnd_title), items, onDismiss)
}

/** Fila «No molestar» de la pestaña «Tú», con el estado y el aviso discreto si solo vive en el dispositivo. */
@Composable
fun DndRow() {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val state by client.state.collectAsStateWithLifecycle()
    val now = rememberSilenceNow(state.dndUntil)
    val active = Silence.active(state.dndUntil, now)
    var open by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable { open = true }.heightIn(min = 56.dp).padding(16.dp).semantics(mergeDescendants = true) {}.testTag("rowDnd"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.DarkMode, null, tint = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.dnd_title), style = MaterialTheme.typography.titleMedium)
            Text(dndRowText(ctx, state.dndUntil, now), style = MaterialTheme.typography.bodySmall,
                color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("dndStatus"))
            if (active && state.dndLocalOnly) Text(stringResource(R.string.dnd_local_only), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline, modifier = Modifier.testTag("dndLocalOnly"))
            else if (!active) Text(stringResource(R.string.dnd_hint), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
            sleepSummary(ctx, state.data?.me?.sleep)?.let { Text("🌙 " + stringResource(R.string.sleep_title) + " · " + it, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("dndNightlySummary")) }
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = active, onCheckedChange = null)
    }
    // El diálogo vive aquí y no dentro de la hoja: al tocar «Todas las noches» la hoja se cierra.
    var nightly by remember { mutableStateOf(false) }
    if (open) DndSheet(onDismiss = { open = false }, onNightly = { nightly = true })
    if (nightly) SleepDialog(onClose = { nightly = false })
}

/** Franja fina arriba de Grupos y DMs: «🌙 No molestar hasta las 18:00 · Reactivar». */
@Composable
fun DndBanner() {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = com.tiecoms.app.ui.LocalContainer.current
    val state by client.state.collectAsStateWithLifecycle()
    val now = rememberSilenceNow(state.dndUntil)
    val text = dndBannerText(ctx, state.dndUntil, now) ?: return
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth().testTag("dndBanner")) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("🌙", style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.width(6.dp))
            Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text(" · ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
            Text(stringResource(R.string.dnd_turn_off), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.clip(CircleShape).clickable(role = Role.Button) {
                    container.scope.launch { runCatching { client.setDnd(null) }.onFailure { container.toast(errorText(ctx, it)) } }
                }.heightIn(min = 32.dp).padding(horizontal = 6.dp, vertical = 6.dp).testTag("dndBannerOff"))
        }
    }
}

/** Lunita sobre el ícono de «Tú» mientras «No molestar» está activo. */
@Composable
fun DndMoonBadge(active: Boolean, content: @Composable () -> Unit) {
    val cd = stringResource(R.string.dnd_on_cd)
    Box {
        content()
        if (active) Box(
            Modifier.align(Alignment.BottomEnd).size(14.dp).background(MaterialTheme.colorScheme.surface, CircleShape)
                .semantics { contentDescription = cd }.testTag("dndMoon"),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.DarkMode, null, tint = Color(0xFF5B5FC7), modifier = Modifier.size(11.dp)) }
    }
}
