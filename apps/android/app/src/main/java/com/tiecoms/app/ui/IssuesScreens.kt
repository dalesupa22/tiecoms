package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDatePickerState
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.IssueDTO
import com.tiecoms.app.core.IssueEventDTO
import com.tiecoms.app.core.IssueTasks
import com.tiecoms.app.core.Names
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

val ISSUE_STATUSES = listOf("open", "in_progress", "waiting", "done", "cancelled")

/** Verde de «hecho» (círculo marcado, botón grande y banner). */
private val DoneGreen = Color(0xFF15803D)

fun statusText(ctx: Context, s: String) = ctx.getString(
    when (s) { "in_progress" -> R.string.issue_st_in_progress; "waiting" -> R.string.issue_st_waiting; "done" -> R.string.issue_st_done; "cancelled" -> R.string.issue_st_cancelled; else -> R.string.issue_st_open },
)

/** Señal de cuello de botella: lleva días sin moverse, o se venció (issueFlags de la web), en hora local. */
typealias IssueFlags = IssueTasks.Flags

fun issueFlags(i: IssueDTO, today: LocalDate = IssueTasks.localToday(), now: Instant = Instant.now()): IssueFlags = IssueTasks.flags(i, today, now)

private fun fmtDate(iso: String, pattern: String) =
    runCatching { LocalDate.parse(iso).format(DateTimeFormatter.ofPattern(pattern, Locale.getDefault())) }.getOrDefault(iso)

fun dueLabel(ctx: Context, i: IssueDTO) = i.dueDate?.let { fmtDate(it, "d MMM") } ?: ctx.getString(R.string.issue_no_due)

/** «vie 3 oct»: la fecha de las preguntas y de «Se venció el …». */
private fun shortDay(iso: String) = fmtDate(iso, "EEE d MMM")

private fun whenText(iso: String?) =
    parseInstant(iso)?.atZone(ZoneId.systemDefault())?.format(DateTimeFormatter.ofPattern("d MMM, HH:mm", Locale.getDefault())) ?: ""

@Composable
fun StatusPill(status: String) {
    val ctx = LocalContext.current
    val (bg, fg) = when (status) {
        "in_progress" -> Color(0xFFDDE8FF) to Color(0xFF1E3A8A)
        "waiting" -> Color(0xFFFFEBCC) to Color(0xFF7A4100)
        "done" -> Color(0xFFD7F2E3) to Color(0xFF14532D)
        "cancelled" -> Color(0xFFE7E3DF) to Color(0xFF57534E)
        else -> Color(0xFFFFE3CC) to Color(0xFF7A3300)
    }
    Box(Modifier.background(bg, RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 3.dp)) {
        Text(statusText(ctx, status), color = fg, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/**
 * Menú de pulsación larga de un asunto (Grupos, lista del chat y pestaña Asuntos), issueQuickMenu de la web:
 * activo → Completar, Marcar en curso, Marcar en espera, Marcar abierto (sin el estado que ya tiene) y Abrir;
 * cerrado → Reabrir y Abrir.
 */
fun issueQuickMenu(ctx: Context, i: IssueDTO, onOpen: () -> Unit, onStatus: (String) -> Unit,
                   onAddTask: (() -> Unit)? = null, onSide: (() -> Unit)? = null): List<SheetItem?> = buildList {
    IssueTasks.quickActions(i).forEach { a ->
        val st = IssueTasks.statusOf(a)
        add(when (a) {
            IssueTasks.QuickAction.COMPLETE -> SheetItem(ctx.getString(R.string.issue_act_done), "✔", tag = "issueActDone") { onStatus(st) }
            IssueTasks.QuickAction.IN_PROGRESS -> SheetItem(ctx.getString(R.string.issue_act_in_progress), "▶", tag = "issueActInProgress") { onStatus(st) }
            IssueTasks.QuickAction.WAITING -> SheetItem(ctx.getString(R.string.issue_act_waiting), "⏳", tag = "issueActWaiting") { onStatus(st) }
            IssueTasks.QuickAction.OPEN -> SheetItem(ctx.getString(R.string.issue_mark_open), "○", tag = "issueActMarkOpen") { onStatus(st) }
            IssueTasks.QuickAction.REOPEN -> SheetItem(ctx.getString(R.string.issue_reopen), "↺", tag = "issueActReopen") { onStatus(st) }
        })
        // Asunto principal abierto (docs/TAREAS.md): «＋ Tarea derivada» y «💬 Hablar aparte (sidechat)», tras Completar.
        if (a == IssueTasks.QuickAction.COMPLETE && i.parentIssueId == null) {
            onAddTask?.let { add(SheetItem(ctx.getString(R.string.task_add), "＋", tag = "issueActAddTask") { it() }) }
            if (!i.restricted) onSide?.let { add(SheetItem(ctx.getString(R.string.task_sidechat), "💬", tag = "issueActSide") { it() }) }
            if (onAddTask != null || onSide != null) add(null)
        }
    }
    add(null)
    add(SheetItem(ctx.getString(R.string.menu_open), "↗", tag = "issueActOpen") { onOpen() })
}

/**
 * Cambiar el estado: optimista (el asunto se mueve y el conteo baja al instante), con «Deshacer» en el aviso;
 * si el API falla, vuelve como estaba y se muestra el error. Completar, reabrir y descartar dicen lo que pasó.
 */
@Composable
fun rememberIssueStatusSetter(): (IssueDTO, String) -> Unit {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    return remember(client, snackbar) {
        { i: IssueDTO, status: String ->
            val before = i.status
            if (status != before) container.scope.launch {
                try {
                    client.setIssueStatus(i.id, status)
                    val text = when {
                        status == "done" -> ctx.getString(R.string.issue_completed)
                        status == "cancelled" -> ctx.getString(R.string.issue_dropped_toast)
                        i.closed && status == "open" -> ctx.getString(R.string.issue_reopened_toast)
                        else -> ctx.getString(R.string.issue_status_toast, i.title, statusText(ctx, status))
                    }
                    snackbar.currentSnackbarData?.dismiss()
                    val r = snackbar.showSnackbar(text, actionLabel = ctx.getString(R.string.undo), withDismissAction = false, duration = SnackbarDuration.Short)
                    if (r == SnackbarResult.ActionPerformed) client.setIssueStatus(i.id, before)
                } catch (e: Exception) {
                    snackbar.showSnackbar(errorText(ctx, e))
                }
            }
            Unit
        }
    }
}

/** El círculo: completa un asunto activo o reabre uno cerrado, con «Deshacer». */
@Composable
fun rememberIssueToggle(): (IssueDTO) -> Unit {
    val set = rememberIssueStatusSetter()
    return remember(set) { { i: IssueDTO -> set(i, IssueTasks.toggleTarget(i)) } }
}

/**
 * Casilla redonda (IssueCheck de la web): verde con ✓ si está hecho (gris si se descartó), borde de color si está en curso.
 * Área táctil de [box] (≥ 48 dp con la ampliación automática de Compose) y, para TalkBack, rol casilla con
 * «Completar» o «Reabrir».
 */
@Composable
fun IssueCheck(i: IssueDTO, onToggle: () -> Unit, size: Dp = 22.dp, box: Dp = 48.dp) {
    val done = i.closed
    val label = stringResource(if (done) R.string.issue_reopen else R.string.issue_act_done)
    val fill = when { i.status == "cancelled" -> MaterialTheme.colorScheme.outline; done -> DoneGreen; else -> Color.Transparent }
    val ring = when { done -> fill; i.status == "in_progress" -> MaterialTheme.colorScheme.primary; else -> MaterialTheme.colorScheme.outline }
    Box(
        Modifier.size(box).clip(CircleShape)
            .toggleable(value = done, role = Role.Checkbox, onValueChange = { onToggle() })
            .semantics { contentDescription = label }
            .testTag("issueCheck-${i.id}"),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(size).clip(CircleShape).background(fill).border(2.dp, ring, CircleShape), contentAlignment = Alignment.Center) {
            if (done) Icon(Icons.Filled.Check, null, tint = Color.White, modifier = Modifier.size(size * 0.72f))
        }
    }
}

/**
 * Fila de asunto como tarea: círculo, título (tachado si está hecho), responsable y dónde, y a la derecha
 * detenido, fecha (solo si hay), el estado solo si está en curso, esperando o descartado, y la carita del responsable.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun IssueRow(i: IssueDTO, data: BootstrapDTO, showWhere: Boolean = true, showOwner: Boolean = true, child: Boolean = false, onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val all = LocalClient.current.state.collectAsStateWithLifecycle().value.issues
    val dialogs = LocalTaskDialogs.current
    val kids = if (i.parentIssueId == null) IssueTasks.childrenOf(all.values, i.id) else emptyList()
    val parent = i.parentIssueId?.let { all[it] }
    // Una tarea en un sidechat se marca para que se sepa dónde se habla de ella.
    val inSide = parent != null && parent.conversationId != i.conversationId
    val owner = Names.person(data, i.ownerId ?: "")
    val conv = data.conversations.firstOrNull { it.id == i.conversationId }
    val f = issueFlags(i)
    val done = i.closed
    val setStatus = rememberIssueStatusSetter()
    val toggle = rememberIssueToggle()
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth()
                .background(if (menu) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                .combinedClickable(onClick = { onOpen(i.id) }, onLongClick = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); menu = true },
                    onLongClickLabel = stringResource(R.string.menu_more))
                .heightIn(min = 56.dp).padding(vertical = 4.dp).testTag("issue-${i.id}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (child) Text("↳", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
            IssueCheck(i, { toggle(i) }, size = if (child) 18.dp else 22.dp)
            Spacer(Modifier.width(4.dp))
            Column(Modifier.weight(1f)) {
                val lock = if (i.restricted) "🔒 " else ""
                Text(lock + i.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    textDecoration = if (done) TextDecoration.LineThrough else null,
                    style = if (child) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge,
                    color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    modifier = if (i.restricted) Modifier.semantics { contentDescription = visibilityLabel(ctx, data, i) + ": " + i.title } else Modifier)
                val sub = listOfNotNull(
                    if (showOwner) owner?.name ?: stringResource(R.string.issue_no_owner) else null,
                    if (!child && parent != null) "↳ " + parent.title else null,
                    if (!child && parent == null && i.parentIssueId != null) stringResource(R.string.task_of_hidden) else null,
                    if (showWhere && conv != null && !child) stringResource(R.string.issue_in, titleOf(ctx, conv, data)) else null,
                    if (inSide) "💬 " + stringResource(R.string.task_in_side) else null,
                    if (i.commentCount > 0) "💬 ${i.commentCount}" else null,
                ).joinToString(" · ")
                if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (f.stalledDays > 0) Text("⏱ " + if (f.stalledDays == 1) stringResource(R.string.issue_stalled_one) else stringResource(R.string.issue_stalled, f.stalledDays),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(start = 8.dp)) {
                if (kids.isNotEmpty()) IssueTasks.progress(kids).let { KidsBadge(it.done, it.total, Modifier.testTag("kids-${i.id}")) }
                if (i.status == "in_progress" || i.status == "waiting" || i.status == "cancelled") StatusPill(i.status)
                if (i.dueDate != null && !done) Text(if (f.overdue) stringResource(R.string.issue_overdue) else if (f.dueToday) stringResource(R.string.issue_today) else dueLabel(ctx, i),
                    style = MaterialTheme.typography.labelSmall, fontWeight = if (f.overdue) FontWeight.SemiBold else null,
                    color = if (f.overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                else if (i.dueDate != null) Text(dueLabel(ctx, i), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
            if (showOwner && owner != null) { Spacer(Modifier.width(8.dp)); PersonAvatar(owner, data, size = if (child) 20.dp else 24.dp) }
        }
        AnchoredMenu(menu, if (menu) issueQuickMenu(ctx, i, onOpen = { onOpen(i.id) }, onStatus = { st -> setStatus(i, st) },
            onAddTask = { dialogs.openTasks(i.id) }, onSide = { dialogs.openSide(i) }) else emptyList(), { menu = false })
    }
}

/** Un asunto con sus tareas debajo, sangradas; en móvil se pliegan con la flecha del asunto. */
@Composable
fun IssueWithTasks(i: IssueDTO, data: BootstrapDTO, showWhere: Boolean = false, showOwner: Boolean = true, onOpen: (String) -> Unit) {
    val all = LocalClient.current.state.collectAsStateWithLifecycle().value.issues
    val kids = IssueTasks.childrenOf(all.values, i.id)
    var open by rememberSaveable(i.id) { mutableStateOf(true) }
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { IssueRow(i, data, showWhere = showWhere, showOwner = showOwner, onOpen = onOpen) }
            if (kids.isNotEmpty()) IconButton(onClick = { open = !open }, modifier = Modifier.testTag("kidsToggle-${i.id}")) {
                Icon(if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, stringResource(if (open) R.string.task_hide else R.string.task_show))
            }
        }
        AnimatedVisibility(open && kids.isNotEmpty()) {
            Column(Modifier.padding(start = 20.dp)) { kids.forEach { androidx.compose.runtime.key(it.id) { IssueRow(it, data, showWhere = false, child = true, onOpen = onOpen) } } }
        }
    }
}

/** Selector de fecha del sistema (el DatePicker trabaja en UTC; la fecha elegida es un día, sin hora). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IssueDatePicker(value: LocalDate?, onPick: (LocalDate?) -> Unit, onDismiss: () -> Unit, allowClear: Boolean = false) {
    val st = rememberDatePickerState(initialSelectedDateMillis = (value ?: IssueTasks.localToday()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                st.selectedDateMillis?.let { onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
            }, modifier = Modifier.testTag("datePickOk")) { Text(stringResource(R.string.common_save)) }
        },
        dismissButton = {
            Row {
                if (allowClear) TextButton(onClick = { onDismiss(); onPick(null) }) { Text(stringResource(R.string.issue_no_due)) }
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
            }
        },
    ) { DatePicker(st) }
}

/**
 * Alta rápida (QuickAddIssue de la web): se escribe y se crea con la acción del teclado. Responsable (Yo por
 * defecto) y fecha aparecen solo al escribir; el campo queda listo para el siguiente, como una lista de tareas.
 * Sin [conversationId] (pestaña Asuntos) también se elige el grupo o chat.
 */
@Composable
fun QuickAddIssue(conversationId: String?, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val internalFallback = stringResource(R.string.internal_default)
    val convFallback = stringResource(R.string.conversation)
    val destinations = remember(data, conversationId) { if (conversationId == null) com.tiecoms.app.core.QuickSearch.issueDestinations(data) else emptyList() }
    var picked by rememberSaveable(conversationId) { mutableStateOf<String?>(null) }
    val conv = conversationId ?: picked?.takeIf { p -> destinations.any { it.id == p } } ?: destinations.firstOrNull()?.id ?: return
    val members = humansOf(data, conv).sortedByDescending { it.id == data.me.id }
    var title by rememberSaveable { mutableStateOf("") }
    var owner by rememberSaveable(conv) { mutableStateOf(data.me.id) }
    var due by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var ownerMenu by remember { mutableStateOf(false) }
    var pickDate by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val typing = title.isNotEmpty()
    fun submit() {
        val text = title.trim()
        if (text.length < 2 || busy) return
        busy = true; error = null
        scope.launch {
            try {
                client.createIssue(conv, text, if (members.any { it.id == owner }) owner else data.me.id, due, null)
                title = ""; due = null
                runCatching { focus.requestFocus() }
            } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
        }
    }
    Column(modifier.fillMaxWidth().testTag("issueQuick"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            title, { title = it.take(200).replace("\n", " ") },
            placeholder = { Text(stringResource(R.string.issue_quick_ph)) },
            leadingIcon = { Text("＋", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) },
            singleLine = true, enabled = !busy || typing,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
            // Con onDone propio el teclado no se cierra: el campo queda listo para el siguiente.
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = ctx.getString(R.string.issue_title) }.testTag("issueQuickAdd"),
        )
        AnimatedVisibility(typing) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (conversationId == null) Dropdown(stringResource(R.string.issue_where),
                    destinations.map { c -> c.id to com.tiecoms.app.core.QuickSearch.issueLabel(data, c) { Names.conversationTitle(it, data, internalFallback, convFallback) } },
                    conv, { picked = it; owner = data.me.id }, modifier = Modifier.fillMaxWidth(), tag = "issueQuickWhere")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.Center) {
                    val who = members.firstOrNull { it.id == owner }
                    Box {
                        AssistChip(onClick = { ownerMenu = true },
                            label = { Text(if (owner == data.me.id) stringResource(R.string.issue_me) else IssueTasks.firstName(who?.name), maxLines = 1) },
                            leadingIcon = { PersonAvatar(who, data, size = 20.dp) },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = ctx.getString(R.string.issue_owner) + ": " + (who?.name ?: "") }.testTag("issueQuickOwner"))
                        DropdownMenu(ownerMenu, { ownerMenu = false }) {
                            members.forEach { p ->
                                DropdownMenuItem(text = { Text(if (p.id == data.me.id) stringResource(R.string.issue_me) else p.name) },
                                    leadingIcon = { PersonAvatar(p, data, size = 24.dp) }, onClick = { owner = p.id; ownerMenu = false },
                                    modifier = Modifier.testTag("issueQuickOwner-${p.id}"))
                            }
                        }
                    }
                    AssistChip(onClick = { pickDate = true },
                        label = { Text("📅 " + (due?.let { shortDay(it) } ?: stringResource(R.string.issue_due)), maxLines = 1) },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("issueQuickDue"))
                    Button(onClick = { submit() }, enabled = !busy && title.trim().length >= 2, modifier = Modifier.heightIn(min = 48.dp).testTag("issueQuickSubmit")) {
                        Text(stringResource(R.string.issue_add))
                    }
                }
            }
        }
        ErrorText(error)
    }
    if (pickDate) IssueDatePicker(due?.let { runCatching { LocalDate.parse(it) }.getOrNull() }, { due = it?.toString() }, { pickDate = false }, allowClear = true)
}

/**
 * Asuntos de una conversación (ConversationIssues de la web): alta rápida, activos por urgencia y
 * «Completados · N» plegable. Trae también los cerrados (GET /issues?conversationId=…). Sin lista perezosa:
 * vive dentro de hojas y columnas con scroll.
 */
@Composable
fun ConversationIssues(conversationId: String, canCreate: Boolean, onOpen: (String) -> Unit) {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    var showDone by rememberSaveable(conversationId) { mutableStateOf(false) }
    LaunchedEffect(conversationId) { runCatching { client.loadIssues(conversationId = conversationId) } }
    // Las tareas de un asunto de este chat van debajo de él (aunque vivan en un sidechat).
    val (open, done) = IssueTasks.split(IssueTasks.conversationTops(st.issues, conversationId))
    Column(Modifier.fillMaxWidth().testTag("conversationIssues"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (canCreate) QuickAddIssue(conversationId, Modifier.padding(bottom = 6.dp))
        if (open.isEmpty()) Text(stringResource(R.string.issue_no_issues), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = 8.dp))
        open.forEach { androidx.compose.runtime.key(it.id) { IssueWithTasks(it, data, onOpen = onOpen) } }
        if (done.isNotEmpty()) {
            val label = stringResource(R.string.issue_done_count, done.size)
            TextButton(onClick = { showDone = !showDone }, modifier = Modifier.heightIn(min = 48.dp).testTag("issuesDoneToggle")) {
                Text((if (showDone) "⌄ " else "› ") + label, fontWeight = FontWeight.SemiBold)
            }
            if (showDone) done.forEach { androidx.compose.runtime.key(it.id) { IssueRow(it, data, showWhere = false, onOpen = onOpen) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IssuesScreen(onOpen: (String) -> Unit, conversationFilter: String? = null, onBack: (() -> Unit)? = null, quick: QuickNav? = null) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val visible = data.conversations.associateBy { it.id }
    val title = conversationFilter?.let { id -> visible[id]?.let { stringResource(R.string.issue_in_conversation, titleOf(ctx, it, data)) } } ?: stringResource(R.string.nav_issues)
    Scaffold(
        topBar = { TopAppBar(
            navigationIcon = { if (onBack != null) IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
            title = { Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() }) },
            // Pestaña Asuntos: ✏️ y «＋ Crear» como en Grupos, DMs y Calendario (no en «Asuntos de un grupo»).
            actions = { if (quick != null) QuickActions(quick) },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)) },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        // Asuntos de un grupo: la misma lista que la barra del chat.
        if (conversationFilter != null) {
            val meta = visible[conversationFilter]
            val guest = data.workspaces.firstOrNull { it.id == meta?.workspaceId }?.myRole == "guest"
            Column(Modifier.padding(pad).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).testTag("issues")) {
                ConversationIssues(conversationFilter, canCreate = meta?.canPost == true && !guest, onOpen = onOpen)
                Spacer(Modifier.heightIn(min = 24.dp))
            }
            return@Scaffold
        }
        var filter by rememberSaveable { mutableStateOf(container.settings.issueFilter) }
        var groupBy by rememberSaveable { mutableStateOf(container.settings.issueGroupBy) }
        var error by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(Unit) { runCatching { client.loadIssues() }.onFailure { error = errorText(ctx, it) } }
        val mine = data.me.id
        // Los restringidos pueden ser de un chat que no leo (me asignaron una tarea): el servidor ya filtró.
        val inView = st.issues.values.filter { it.conversationId in visible || it.restricted }
        val list = inView.filter { IssueTasks.matches(filter, it, mine) }
            .sortedWith(if (filter == "closed") IssueTasks.byClosedDesc else IssueTasks.byUrgency())
        val byPerson = groupBy == "person"
        val noOwner = stringResource(R.string.issue_no_owner)
        val you = stringResource(R.string.you)
        val participant = stringResource(R.string.common_participant)
        val shared = stringResource(R.string.task_shared_with_me)
        val sectionTitle: (String) -> String = { k ->
            if (byPerson) { if (k == IssueTasks.NO_OWNER) noOwner else (Names.person(data, k)?.name ?: participant) + if (k == mine) " $you" else "" }
            else visible[k]?.let { c -> listOfNotNull(data.workspaces.firstOrNull { it.id == c.workspaceId }?.name, titleOf(ctx, c, data)).distinct().joinToString(" · ") } ?: shared
        }
        // Por grupo, las tareas van debajo de su asunto (en la sección del asunto); por responsable, sueltas con «↳ asunto».
        val shown = if (byPerson) list else IssueTasks.tops(list, st.issues)
        val sections = IssueTasks.sections(shown.map { if (byPerson) it else it.copy(conversationId = IssueTasks.groupConversation(it, st.issues)) }, byPerson, mine, sectionTitle)
            .map { (k, items) -> k to items.map { x -> st.issues[x.id] ?: x } }
        fun count(f: String) = inView.count { IssueTasks.matches(f, it, mine) }
        LazyColumn(Modifier.padding(pad).fillMaxSize().imePadding().padding(horizontal = 16.dp).testTag("issues"), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = AssistantListInset)) {
            item(key = "head") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(stringResource(R.string.issue_page_sub), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    Segmented(listOf(
                        "mine" to "${stringResource(R.string.issue_mine)} ${count("mine")}",
                        "open" to "${stringResource(R.string.issue_all_open)} ${count("open")}",
                        "closed" to "${stringResource(R.string.issue_closed)} ${count("closed")}",
                    ), filter, { filter = it; container.settings.issueFilter = it }, Modifier.testTag("issueFilter"))
                    Segmented(listOf("group" to stringResource(R.string.issue_by_group), "person" to stringResource(R.string.issue_by_person)), groupBy,
                        { groupBy = it; container.settings.issueGroupBy = it }, Modifier.semantics { contentDescription = ctx.getString(R.string.issue_group_by) }.testTag("issueGroupBy"))
                    if (filter != "closed") QuickAddIssue(null)
                    ErrorText(error)
                    if (list.isEmpty()) EmptyNote(stringResource(R.string.issue_empty))
                }
            }
            sections.forEach { (k, items) ->
                item(key = "s$k") {
                    Row(Modifier.padding(top = 18.dp, bottom = 2.dp).semantics(mergeDescendants = true) { heading() }.testTag("issueSection-$k"), verticalAlignment = Alignment.CenterVertically) {
                        if (byPerson) { if (k != IssueTasks.NO_OWNER) { PersonAvatar(Names.person(data, k), data, size = 22.dp); Spacer(Modifier.width(8.dp)) } }
                        else visible[k]?.let { ConversationIcon(it, data, 22.dp); Spacer(Modifier.width(8.dp)) }
                        Text("${sectionTitle(k)} · ${items.size}", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                items(items, key = { "$k/${it.id}" }) { Box(Modifier.animateItem()) {
                    if (byPerson) IssueRow(it, data, showWhere = true, showOwner = false, onOpen = onOpen) else IssueWithTasks(it, data, onOpen = onOpen)
                } }
            }
            item(key = "foot") { Spacer(Modifier.heightIn(min = 24.dp)) }
        }
    }
}

private fun eventText(ctx: Context, d: BootstrapDTO, e: IssueEventDTO): String {
    val to = e.payload["to"]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
    return when (e.kind) {
        "created" -> ctx.getString(R.string.issue_ev_created)
        "status" -> ctx.getString(R.string.issue_ev_status, statusText(ctx, to ?: "open"))
        "owner" -> ctx.getString(R.string.issue_ev_owner) + " → " + (Names.person(d, to ?: "")?.name ?: ctx.getString(R.string.common_none))
        "due" -> ctx.getString(R.string.issue_ev_due, to?.let { fmtDate(it, "d MMM") } ?: ctx.getString(R.string.issue_no_due))
        "title" -> ctx.getString(R.string.issue_ev_title) + " → «$to»"
        "waiting" -> ctx.getString(R.string.issue_ev_waiting) + (to?.let { ": " + (Names.org(d, it)?.name ?: "") } ?: "")
        "visibility" -> ctx.getString(R.string.task_ev_vis) + " → " + ctx.getString(when (to) { "all" -> R.string.task_vis_all; "org" -> R.string.task_vis_org_short; else -> R.string.task_vis_private })
        else -> ""
    }
}

/** Una pregunta del detalle: la etiqueta y sus botones de un toque. */
@Composable
private fun Question(label: String, strong: String? = null, tag: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 6.dp).testTag(tag), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(buildString { append(label); if (strong != null) append(" · $strong") }, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold,
            modifier = Modifier.semantics { heading() })
        content()
    }
}

@Composable
private fun Chip(selected: Boolean, label: String, tag: String, leading: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    FilterChip(selected = selected, onClick = onClick, label = { Text(label, maxLines = 1) }, leadingIcon = leading,
        modifier = Modifier.heightIn(min = 48.dp).testTag(tag))
}

/**
 * Detalle de un asunto «a prueba de tontos» (IssueDrawer de la web): un paso por pregunta —¿quién?, ¿para cuándo?,
 * ¿cómo va?— con botones de un toque, y un solo botón grande para terminar. El título de la pantalla es el grupo.
 */
@Composable
fun IssueDetailScreen(id: String, onBack: () -> Unit, onOpenOrigin: (String, Long) -> Unit, onOpenIssue: (String) -> Unit = {}) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val live = st.issues[id]
    var events by remember { mutableStateOf<List<IssueEventDTO>>(emptyList()) }
    var comment by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var showHistory by rememberSaveable { mutableStateOf(false) }
    var pickDate by remember { mutableStateOf(false) }
    var editing by rememberSaveable { mutableStateOf(false) }
    val setStatus = rememberIssueStatusSetter()
    val toggle = rememberIssueToggle()
    suspend fun load() { runCatching { events = client.issueDetail(id).events }.onFailure { error = errorText(ctx, it) } }
    // En vivo: issue.updated trae updatedAt/commentCount nuevos y se recarga el historial.
    LaunchedEffect(id, live?.updatedAt, live?.commentCount) { load() }
    val conv = live?.let { i -> data.conversations.firstOrNull { it.id == i.conversationId } }
    SimpleScaffold(conv?.let { titleOf(ctx, it, data) } ?: stringResource(R.string.nav_issues), onBack) {
        val i = live ?: run { if (error != null) ErrorText(error) else CircularProgressIndicator(Modifier.padding(24.dp)); return@SimpleScaffold }
        val done = i.closed
        val chatMembers = humansOf(data, i.conversationId)
        // En una tarea restringida, «¿Quién lo hace?» son quienes la ven (y los agregados que no están en el chat).
        val members = IssueTasks.audience(i, chatMembers, data.people).sortedByDescending { it.id == data.me.id }
        val orgIds = chatMembers.mapNotNull { it.orgId }.distinct()
        val parent = i.parentIssueId?.let { st.issues[it] }
        val f = issueFlags(i)
        val canSeeOrigin = conv != null && i.originMessageSeq != null && i.originMessageSeq > conv.historyFromSeq
        val requester = Names.person(data, i.requestedBy ?: "")
        val comments = events.filter { it.kind == "comment" }
        val changes = events.filter { it.kind != "comment" }
        fun update(key: String, value: String?) = scope.launch {
            error = null
            runCatching { client.updateIssue(i.id, buildJsonObject { put(key, value?.let { JsonPrimitive(it) } ?: JsonNull) }) }.onFailure { error = errorText(ctx, it) }
        }
        LazyColumn(Modifier.fillMaxSize().imePadding().padding(horizontal = 16.dp).testTag("issueDetail"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item(key = "title") {
                var draft by remember(i.title) { mutableStateOf(i.title) }
                val focus = remember { FocusRequester() }
                fun save() {
                    val v = draft.trim(); editing = false
                    if (v.length >= 2 && v != i.title) update("title", v) else draft = i.title
                }
                if (editing) {
                    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
                    OutlinedTextField(draft, { draft = it.take(200).replace("\n", " ") }, label = { Text(stringResource(R.string.issue_title)) },
                        textStyle = MaterialTheme.typography.titleLarge, maxLines = 3,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { save() }),
                        trailingIcon = { IconButton(onClick = { save() }, modifier = Modifier.testTag("issueTitleSave")) { Icon(Icons.Filled.Check, stringResource(R.string.common_save)) } },
                        modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("issueTitleField"))
                } else Row(Modifier.fillMaxWidth().clickable(onClickLabel = stringResource(R.string.issue_edit_title)) { editing = true }.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(i.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f).testTag("issueTitleText"),
                        textDecoration = if (done) TextDecoration.LineThrough else null,
                        color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                    IconButton(onClick = { editing = true }, modifier = Modifier.testTag("issueTitleEdit")) {
                        Icon(Icons.Outlined.Edit, stringResource(R.string.issue_edit_title), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (i.parentIssueId != null) {
                    if (parent != null) TextButton(onClick = { onOpenIssue(parent.id) }, modifier = Modifier.heightIn(min = 48.dp).testTag("issueParent")) {
                        Text("↑ " + stringResource(R.string.task_part_of, parent.title), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    } else Text(stringResource(R.string.task_of_hidden), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text((requester?.let { stringResource(R.string.issue_requested_by, it.name) } ?: stringResource(R.string.issue_manual)) +
                    if (i.restricted) " · 🔒 " + visibilityLabel(ctx, data, i) else "",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("issueRequester"))
            }
            item(key = "main") {
                if (done) {
                    val dropped = i.status == "cancelled"
                    Surface(color = if (dropped) MaterialTheme.colorScheme.surfaceVariant else Color(0xFFD7F2E3), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().testTag("issueDoneBanner")) {
                        Row(Modifier.padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(if (dropped) R.string.issue_dropped_banner else R.string.issue_done_banner) + (i.closedAt?.let { " · " + whenText(it) } ?: ""),
                                color = if (dropped) MaterialTheme.colorScheme.onSurfaceVariant else Color(0xFF14532D), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            OutlinedButton(onClick = { toggle(i) }, modifier = Modifier.heightIn(min = 48.dp).testTag("issueReopen")) { Text("↺ " + stringResource(R.string.issue_reopen)) }
                        }
                    }
                } else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val alerts = listOfNotNull(
                        if (f.overdue && i.dueDate != null) stringResource(R.string.issue_overdue_since, shortDay(i.dueDate)) else null,
                        if (f.dueToday) stringResource(R.string.issue_today) else null,
                        if (f.stalledDays > 0) stringResource(R.string.issue_stalled_plain, f.stalledDays) else null,
                    )
                    if (alerts.isNotEmpty()) Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().testTag("issueAlert")) {
                        Text("⏱ " + alerts.joinToString(" · "), Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onErrorContainer, fontWeight = FontWeight.SemiBold)
                    }
                    Button(onClick = { toggle(i) }, colors = ButtonDefaults.buttonColors(containerColor = DoneGreen, contentColor = Color.White),
                        shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("issueMarkDone")) {
                        Text("✓ " + stringResource(R.string.issue_mark_done), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    }
                }
            }
            item(key = "who") {
                Question(stringResource(R.string.issue_q_who), tag = "issueQWho") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        members.forEach { p ->
                            Chip(i.ownerId == p.id, if (p.id == data.me.id) stringResource(R.string.issue_me) else IssueTasks.firstName(p.name), "owner-${p.id}",
                                leading = { PersonAvatar(p, data, size = 22.dp) }) { if (i.ownerId != p.id) update("ownerId", p.id) }
                        }
                        if (i.ownerId != null) Chip(false, stringResource(R.string.issue_no_owner), "owner-none") { update("ownerId", null) }
                    }
                }
            }
            item(key = "when") {
                Question(stringResource(R.string.issue_q_when), i.dueDate?.let { shortDay(it) }, tag = "issueQWhen") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        IssueTasks.dateShortcuts().forEach { (k, d) ->
                            val label = stringResource(when (k) {
                                IssueTasks.Shortcut.TODAY -> R.string.issue_d_today; IssueTasks.Shortcut.TOMORROW -> R.string.issue_d_tomorrow
                                IssueTasks.Shortcut.FRIDAY -> R.string.issue_d_friday; IssueTasks.Shortcut.NEXT_WEEK -> R.string.issue_d_next_week
                            })
                            val iso = d.toString()
                            Chip(i.dueDate == iso, label, "due-${k.name}") { if (i.dueDate != iso) update("dueDate", iso) }
                        }
                        Chip(pickDate, "📅 " + stringResource(R.string.issue_d_pick), "due-pick") { pickDate = true }
                        if (i.dueDate != null) Chip(false, stringResource(R.string.issue_no_due), "due-none") { update("dueDate", null) }
                    }
                }
            }
            if (!done) item(key = "how") {
                Question(stringResource(R.string.issue_q_how), tag = "issueQHow") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("open" to R.string.issue_how_open, "in_progress" to R.string.issue_how_in_progress, "waiting" to R.string.issue_how_waiting).forEach { (s, res) ->
                            Chip(i.status == s, stringResource(res), "how-$s") { if (i.status != s) scope.launch { runCatching { client.setIssueStatus(i.id, s) }.onFailure { error = errorText(ctx, it) } } }
                        }
                    }
                    if (i.status == "waiting" && orgIds.size > 1) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.Center) {
                        Text(stringResource(R.string.issue_waiting_on) + ":", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.align(Alignment.CenterVertically))
                        orgIds.forEach { o ->
                            Chip(i.waitingOnOrgId == o, Names.org(data, o)?.name ?: "", "waitOn-$o") { update("waitingOnOrgId", if (i.waitingOnOrgId == o) null else o) }
                        }
                    }
                }
            }
            if (i.parentIssueId == null) item(key = "tasks") { TasksSection(i.id, null, onOpen = onOpenIssue) }
            if (i.parentIssueId != null && i.createdBy == data.me.id) item(key = "vis") { VisibilityChoice(i) }
            item(key = "newsHead") { Question(stringResource(R.string.issue_q_news) + if (comments.isNotEmpty()) " · ${comments.size}" else "", tag = "issueQNews") {} }
            items(comments, key = { it.id }) { e ->
                val who = Names.person(data, e.actorId)
                Row(Modifier.fillMaxWidth().testTag("issueEvent-comment"), verticalAlignment = Alignment.Top) {
                    AuthorAvatar(who, e.actorId, 28.dp)
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text((who?.name ?: stringResource(R.string.common_participant)) + " · " + whenText(e.createdAt), style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small, modifier = Modifier.padding(top = 2.dp)) {
                            Text(e.payload["body"]?.let { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: "", Modifier.padding(8.dp).testTag("commentBody"))
                        }
                    }
                }
            }
            item(key = "composer") {
                var sending by remember { mutableStateOf(false) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(comment, { comment = it.take(4000) }, placeholder = { Text(stringResource(R.string.issue_comment_ph_plain)) }, maxLines = 5,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier.weight(1f).testTag("issueComment"))
                    Spacer(Modifier.width(8.dp))
                    Button(enabled = comment.isNotBlank() && !sending, onClick = {
                        val body = comment.trim()
                        sending = true; error = null
                        scope.launch { runCatching { client.commentIssue(i.id, body); comment = ""; load() }.onFailure { error = errorText(ctx, it) }; sending = false }
                    }, modifier = Modifier.heightIn(min = 48.dp).testTag("issueCommentSend")) { Text(stringResource(R.string.issue_send)) }
                }
                ErrorText(error)
            }
            item(key = "foot") {
                FlowRow(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.Center) {
                    if (i.originMessageId != null) {
                        if (canSeeOrigin) TextButton(onClick = { onOpenOrigin(i.conversationId, i.originMessageSeq!!) }, modifier = Modifier.heightIn(min = 48.dp).testTag("issueOrigin")) {
                            Text("↗ " + stringResource(R.string.issue_origin))
                        } else Text(stringResource(R.string.issue_origin_out), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.align(Alignment.CenterVertically))
                    }
                    if (changes.isNotEmpty()) TextButton(onClick = { showHistory = !showHistory }, modifier = Modifier.heightIn(min = 48.dp).testTag("issueHistoryToggle")) {
                        Text((if (showHistory) "⌄ " else "› ") + stringResource(R.string.issue_history_count, changes.size))
                    }
                    if (!done) TextButton(onClick = { setStatus(i, "cancelled") }, modifier = Modifier.heightIn(min = 48.dp).testTag("issueDrop")) {
                        Text(stringResource(R.string.issue_drop), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (showHistory) items(changes, key = { "h" + it.id }) { e ->
                val who = Names.person(data, e.actorId)
                Text((who?.name ?: ctx.getString(R.string.common_participant)) + " " + eventText(ctx, data, e) + " · " + whenText(e.createdAt),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("issueEvent-${e.kind}"))
            }
            item(key = "end") { Spacer(Modifier.heightIn(min = 32.dp)) }
        }
        if (pickDate) IssueDatePicker(i.dueDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() }, { d -> update("dueDate", d?.toString()) }, { pickDate = false })
    }
}

/** Fichas «Asuntos aquí» encima del chat. */
@Composable
fun IssueChips(list: List<IssueDTO>, data: BootstrapDTO, onOpen: (String) -> Unit) {
    if (list.isEmpty()) return
    androidx.compose.foundation.lazy.LazyRow(
        Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp),
    ) {
        item { Text(stringResource(R.string.issue_here).uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp)) }
        items(list, key = { it.id }) { i ->
            Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.clickable { onOpen(i.id) }.testTag("issueChip-${i.id}")) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("◆ ", color = Brand.Orange)
                    Text(i.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(160.dp))
                }
            }
        }
    }
}
