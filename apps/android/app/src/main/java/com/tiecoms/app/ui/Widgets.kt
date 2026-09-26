package com.tiecoms.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.MarkChatUnread
import androidx.compose.material.icons.outlined.CallSplit
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Chat
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material.icons.outlined.UnfoldLess
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material.icons.outlined.ExpandCircleDown
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.automirrored.outlined.Forward
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.Names
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Elemento de menú (equivalente al MenuItem de la web): con [children] abre un submenú. */
data class SheetItem(
    val label: String,
    val glyph: String = "",
    val danger: Boolean = false,
    val enabled: Boolean = true,
    val hint: String? = null,
    val tag: String? = null,
    val children: List<SheetItem>? = null,
    /** Pista bajo el texto («Por DM a Laura», «Con los del chat»). */
    val subtitle: String? = null,
    val onClick: (() -> Unit)? = null,
)

/** Menú de acciones en hoja inferior; los submenús se abren dentro de la misma hoja. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActionSheet(title: String?, items: List<SheetItem?>, onDismiss: () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var stack by remember { mutableStateOf(listOf<SheetItem>()) }
    val current = stack.lastOrNull()
    val list = current?.children ?: items
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, modifier = Modifier.testTag("actionSheet")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp).verticalScroll(rememberScrollState())) {
            if (current != null) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 4.dp)) {
                    IconButton(onClick = { stack = stack.dropLast(1) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
                    Text(current.label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                }
            } else if (title != null) {
                Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
            }
            list.forEach { it ->
                if (it == null) { HorizontalDivider(Modifier.padding(vertical = 4.dp)); return@forEach }
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 52.dp)
                        .clickable(enabled = it.enabled) {
                            if (it.children != null) stack = stack + it else { onDismiss(); it.onClick?.invoke() }
                        }
                        .padding(horizontal = 20.dp, vertical = 10.dp)
                        .then(if (it.tag != null) Modifier.testTag(it.tag) else Modifier),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(32.dp).clearAndSetSemantics {}) { Text(it.glyph, style = MaterialTheme.typography.titleMedium) }
                    Column(Modifier.weight(1f)) {
                        Text(
                            it.label, style = MaterialTheme.typography.bodyLarge,
                            color = when { !it.enabled -> MaterialTheme.colorScheme.outline; it.danger -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.onSurface },
                        )
                        it.subtitle?.let { sub -> Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    it.hint?.let { h -> Text(h, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    if (it.children != null) Text("›", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

/** Selector segmentado (equivalente al .seg de la web). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> Segmented(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        options.forEachIndexed { i, (v, label) ->
            SegmentedButton(
                selected = v == selected, onClick = { onSelect(v) },
                shape = SegmentedButtonDefaults.itemShape(i, options.size),
                label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium) },
            )
        }
    }
}

fun copyToClipboard(ctx: Context, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("Chaggu", text))
}

fun convLink(id: String) = "${com.tiecoms.app.core.DeepLinks.APP_URL}/c/$id"
fun messageLink(conversationId: String, seq: Long) = "${convLink(conversationId)}?m=$seq"

fun whenText(i: Instant): String =
    i.atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", java.util.Locale.getDefault()))

fun shortDateTime(iso: String?): String =
    parseInstant(iso)?.atZone(ZoneId.systemDefault())?.format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)) ?: ""

/** Tiempos rápidos de la web (actions.tsx quickTimes). */
fun quickTimes(ctx: Context, now: Instant = Instant.now()): List<Pair<String, Instant>> {
    val zone = ZoneId.systemDefault()
    val today = now.atZone(zone).toLocalDate()
    fun at9(d: LocalDate) = d.atTime(9, 0).atZone(zone).toInstant()
    val dow = today.dayOfWeek.value // 1 = lunes
    val daysToMonday = ((8 - dow) % 7).let { if (it == 0) 7 else it }
    return listOf(
        ctx.getString(R.string.when_20m) to now.plusSeconds(20 * 60),
        ctx.getString(R.string.when_1h) to now.plusSeconds(3600),
        ctx.getString(R.string.when_3h) to now.plusSeconds(3 * 3600),
        ctx.getString(R.string.when_tomorrow) to at9(today.plusDays(1)),
        ctx.getString(R.string.when_monday) to at9(today.plusDays(daysToMonday.toLong())),
    )
}

/** Campo de fecha que abre el selector del sistema. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateField(label: String, value: LocalDate?, onChange: (LocalDate?) -> Unit, allowClear: Boolean = false, modifier: Modifier = Modifier, tag: String? = null) {
    var open by rememberSaveable { mutableStateOf(false) }
    val text = value?.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) ?: stringResource(R.string.issue_no_due)
    OutlinedButton(onClick = { open = true }, modifier = modifier.heightIn(min = 52.dp).then(if (tag != null) Modifier.testTag(tag) else Modifier)) {
        Column(Modifier.fillMaxWidth()) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
        }
    }
    if (open) {
        val st = rememberDatePickerState(initialSelectedDateMillis = (value ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    open = false
                    st.selectedDateMillis?.let { onChange(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                }) { Text(stringResource(R.string.common_save)) }
            },
            dismissButton = {
                Row {
                    if (allowClear) TextButton(onClick = { open = false; onChange(null) }) { Text(stringResource(R.string.issue_no_due)) }
                    TextButton(onClick = { open = false }) { Text(stringResource(R.string.cancel)) }
                }
            },
        ) { DatePicker(st) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeField(label: String, value: LocalTime, onChange: (LocalTime) -> Unit, modifier: Modifier = Modifier) {
    var open by rememberSaveable { mutableStateOf(false) }
    OutlinedButton(onClick = { open = true }, modifier = modifier.heightIn(min = 52.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
        }
    }
    if (open) {
        val st = rememberTimePickerState(value.hour, value.minute, is24Hour = android.text.format.DateFormat.is24HourFormat(androidx.compose.ui.platform.LocalContext.current))
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = { TextButton(onClick = { open = false; onChange(LocalTime.of(st.hour, st.minute)) }) { Text(stringResource(R.string.common_save)) } },
            dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(R.string.cancel)) } },
            text = { TimePicker(st) },
        )
    }
}

/** Lista de conversaciones con búsqueda para elegir un destino (reenviar, compartir). */
@Composable
fun ConversationPicker(data: BootstrapDTO, selected: String?, onSelect: (String) -> Unit, exclude: String? = null, modifier: Modifier = Modifier) {
    var q by rememberSaveable { mutableStateOf("") }
    val internal = stringResource(R.string.internal_default)
    val conv = stringResource(R.string.conversation)
    val direct = stringResource(R.string.kind_direct)
    val list = data.conversations.filter { it.canPost && it.id != exclude && (q.isBlank() || Names.conversationTitle(it, data, internal, conv).contains(q, ignoreCase = true)) }
    Column(modifier) {
        OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.fwd_search)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("pickerSearch"))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 320.dp)) {
            items(list, key = { it.id }) { c ->
                Row(
                    Modifier.fillMaxWidth().selectable(selected = selected == c.id, role = Role.RadioButton) { onSelect(c.id) }
                        .heightIn(min = 52.dp).padding(vertical = 4.dp).testTag("pick-${c.id}"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = selected == c.id, onClick = null)
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(Names.conversationTitle(c, data, internal, conv), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(data.workspaces.firstOrNull { it.id == c.workspaceId }?.name ?: direct, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

fun titleOf(ctx: Context, c: ConversationDTO, data: BootstrapDTO?) =
    Names.conversationTitle(c, data, ctx.getString(R.string.internal_default), ctx.getString(R.string.conversation))

@Composable
fun EmptyNote(text: String, modifier: Modifier = Modifier) {
    Text(text, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier.fillMaxWidth().padding(24.dp))
}

@Composable
fun Quote(text: String) {
    androidx.compose.material3.Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth()) {
        Text("“$text”", Modifier.padding(10.dp), style = MaterialTheme.typography.bodyMedium, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic)
    }
}

@Composable
fun DialogButtons(onCancel: () -> Unit, confirm: String, enabled: Boolean = true, confirmTag: String? = null, onConfirm: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) }
        Spacer(Modifier.width(8.dp))
        androidx.compose.material3.Button(onClick = onConfirm, enabled = enabled, modifier = if (confirmTag != null) Modifier.testTag(confirmTag) else Modifier) { Text(confirm) }
    }
}

/** Hoja modal a pantalla casi completa para formularios (equivalente al Modal de la web). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FormSheet(title: String, onDismiss: () -> Unit, tag: String? = null, content: @Composable () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, modifier = if (tag != null) Modifier.testTag(tag) else Modifier) {
        Column(
            Modifier.fillMaxWidth().widthIn(max = 640.dp).dismissKeyboardOnOutsideInteraction().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            content()
            Spacer(Modifier.heightIn(min = 12.dp))
        }
    }
}


/** Ícono Material para cada glifo de los menús (mismos significados que los SF Symbols de iOS). */
fun iconForGlyph(glyph: String): androidx.compose.ui.graphics.vector.ImageVector? {
    val I = Icons.Outlined
    val A = Icons.AutoMirrored.Outlined
    return when (glyph) {
        "↩" -> A.Reply
        "⧉" -> I.ContentCopy
        "⛓" -> I.Link
        "📌" -> I.PushPin
        "⏰" -> I.Alarm
        "●" -> I.MarkChatUnread
        "⑂" -> I.CallSplit
        "◆" -> I.TaskAlt
        "📅" -> I.Event
        "↪" -> A.Forward
        "✎" -> I.Edit
        "🗑" -> I.Delete
        "⚑" -> I.Flag
        "↗" -> A.OpenInNew
        "✓" -> I.DoneAll
        "🔔" -> I.NotificationsActive
        "🔕" -> I.NotificationsOff
        "⎋" -> A.Logout
        "ⓘ" -> I.Info
        "🔒" -> I.Lock
        "💬" -> I.Forum
        "✉" -> I.Email
        "🟢" -> I.Chat
        "◍" -> I.Forum
        "#" -> I.Tag
        "T" -> I.Groups
        "⊘" -> I.Block
        "🗄" -> I.Archive
        "✔" -> I.CheckCircle
        "▶" -> I.PlayCircle
        "⏳" -> I.HourglassTop
        "↺" -> I.Replay
        "▸" -> I.UnfoldLess
        "▾" -> I.UnfoldMore
        "◇" -> I.ExpandCircleDown
        else -> null
    }
}

/**
 * Menú contextual anclado (como el de iPhone): se abre junto al elemento que lo invoca, con íconos,
 * separadores y submenús que se abren dentro del mismo menú; se cierra al tocar fuera.
 */
@Composable
fun AnchoredMenu(expanded: Boolean, items: List<SheetItem?>, onDismiss: () -> Unit, modifier: Modifier = Modifier,
                 /** Encima de las opciones (la barra rápida de reacciones de un mensaje, como en WhatsApp). */
                 header: (@Composable () -> Unit)? = null) {
    var stack by remember(expanded) { mutableStateOf(listOf<SheetItem>()) }
    val current = stack.lastOrNull()
    val list = current?.children ?: items
    androidx.compose.material3.DropdownMenu(
        expanded = expanded, onDismissRequest = onDismiss,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(14.dp),
        modifier = modifier.widthIn(min = 240.dp).testTag("contextMenu"),
    ) {
        if (current == null && header != null) { header(); if (list.isNotEmpty()) HorizontalDivider() }
        if (current != null) {
            androidx.compose.material3.DropdownMenuItem(
                text = { Text(current.label, fontWeight = FontWeight.SemiBold) },
                leadingIcon = { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) },
                onClick = { stack = stack.dropLast(1) },
            )
            HorizontalDivider()
        }
        list.forEachIndexed { i, it ->
            if (it == null) { if (i > 0 && i < list.lastIndex && list[i - 1] != null) HorizontalDivider(Modifier.padding(vertical = 2.dp)); return@forEachIndexed }
            val color = when { !it.enabled -> MaterialTheme.colorScheme.outline; it.danger -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.onSurface }
            androidx.compose.material3.DropdownMenuItem(
                text = {
                    Column {
                        Text(it.label, color = color)
                        it.subtitle?.let { sub -> Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                },
                leadingIcon = {
                    val icon = iconForGlyph(it.glyph)
                    if (icon != null) Icon(icon, null, tint = if (it.danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                    else if (it.glyph.isNotEmpty()) Text(it.glyph, style = MaterialTheme.typography.titleSmall)
                },
                trailingIcon = when {
                    it.children != null -> ({ Text("›", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) })
                    it.hint != null -> ({ Text(it.hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) })
                    else -> null
                },
                enabled = it.enabled,
                onClick = { if (it.children != null) stack = stack + it else { onDismiss(); it.onClick?.invoke() } },
                modifier = if (it.tag != null) Modifier.testTag(it.tag) else Modifier,
            )
        }
    }
}
