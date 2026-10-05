package com.tiecoms.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.IssueDTO
import com.tiecoms.app.core.IssueTasks
import com.tiecoms.app.core.Names
import java.time.LocalDate
import kotlinx.coroutines.launch
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * Pantalla de Tareas rediseñada (1.7.13, Danny: «confusa y horrible»). Solo UI: mismo API y modelo.
 *  - Un solo filtro compacto arriba: Mías · Abiertas · Hechas, con conteos chicos.
 *  - Por defecto agrupadas por fecha (Vencidas en rojo, Hoy, Esta semana, Más adelante, Sin fecha); «Por grupo» y
 *    «Por responsable» van en el menú del ícono de orden.
 *  - Fila limpia: círculo, título (2 líneas) y UNA línea de metadatos (fecha · grupo) con la carita a la derecha.
 *  - «Añadir tarea» es un botón flotante abajo a la izquierda (a la derecha vive la burbuja de gg).
 */

/** Filtro compacto tipo segmentado: «Mías 17 · Abiertas 39 · Hechas 58» (el número chico y gris). */
@Composable
fun TaskFilterBar(options: List<Triple<String, String, Int>>, selected: String, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = modifier.testTag("taskFilter")) {
        Row(Modifier.padding(3.dp)) {
            options.forEach { (key, label, n) ->
                val on = key == selected
                Row(
                    Modifier.clip(RoundedCornerShape(50))
                        .background(if (on) MaterialTheme.colorScheme.surface else Color.Transparent)
                        .clickable { onSelect(key) }
                        .semantics { role = Role.Tab; this.selected = on }
                        .heightIn(min = 36.dp).padding(horizontal = 12.dp).testTag("taskFilter-$key"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(5.dp))
                    Text(n.toString(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/** Ícono de orden con el menú: Por fecha · Por grupo · Por responsable. */
@Composable
fun TaskGroupingMenu(grouping: String, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val label = stringResource(R.string.tasks_sort)
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("taskGrouping")) { Icon(Icons.AutoMirrored.Filled.Sort, label) }
        DropdownMenu(open, { open = false }) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
            listOf("date" to R.string.tasks_by_date, "group" to R.string.issue_by_group, "person" to R.string.issue_by_person).forEach { (k, res) ->
                DropdownMenuItem(
                    text = { Text(stringResource(res), fontWeight = if (k == grouping) FontWeight.SemiBold else null) },
                    trailingIcon = { if (k == grouping) Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.primary) },
                    onClick = { open = false; onPick(k) },
                    modifier = Modifier.testTag("taskGrouping-$k"),
                )
            }
        }
    }
}

/** Encabezado de una franja: «Vencidas · 3» (en rojo), «Hoy · 2»… */
@Composable
fun TaskBucketHeader(b: IssueTasks.DueBucket?, count: Int, titleOverride: String? = null) {
    val text = titleOverride ?: stringResource(when (b) {
        IssueTasks.DueBucket.OVERDUE -> R.string.tasks_b_overdue
        IssueTasks.DueBucket.TODAY -> R.string.tasks_b_today
        IssueTasks.DueBucket.WEEK -> R.string.tasks_b_week
        IssueTasks.DueBucket.LATER -> R.string.tasks_b_later
        IssueTasks.DueBucket.NONE -> R.string.tasks_b_none
        null -> R.string.tasks_b_done
    })
    val red = b == IssueTasks.DueBucket.OVERDUE
    Row(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 2.dp).semantics(mergeDescendants = true) { heading() }.testTag("taskBucket-${b?.name ?: "DONE"}"),
        verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold,
            color = if (red) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        Spacer(Modifier.width(6.dp))
        Text(count.toString(), style = MaterialTheme.typography.labelMedium, color = if (red) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Texto y color del chip de fecha: «Venció hace 3 días» (rojo), «Vence hoy», «Mañana», «vie 10 oct». */
@Composable
private fun dueChip(i: IssueDTO, today: LocalDate): Pair<String, Color>? {
    val d = i.dueDate?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() } ?: return null
    val late = IssueTasks.overdueDays(i, today)
    val day = d.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault()))
    return when {
        i.closed -> day to MaterialTheme.colorScheme.onSurfaceVariant
        late == 1 -> stringResource(R.string.tasks_was_due_one) to MaterialTheme.colorScheme.error
        late > 1 -> stringResource(R.string.tasks_was_due, late) to MaterialTheme.colorScheme.error
        d == today -> stringResource(R.string.tasks_due_today) to MaterialTheme.colorScheme.primary
        d == today.plusDays(1) -> stringResource(R.string.tasks_due_tomorrow) to MaterialTheme.colorScheme.onSurfaceVariant
        else -> day to MaterialTheme.colorScheme.onSurfaceVariant
    }
}

/**
 * Fila limpia de la pantalla de Tareas: círculo para completar, título (máx. 2 líneas) y una línea de metadatos
 * (chip de fecha · grupo en gris · «Sin movimiento N d» sutil solo si no está vencida), con la carita del
 * responsable a la derecha (o «Sin responsable», discreto). Tocar abre el detalle; mantener, el menú rápido.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun TaskRow(i: IssueDTO, data: BootstrapDTO, showGroup: Boolean = true, showOwner: Boolean = true, child: Boolean = false, trailing: (@Composable () -> Unit)? = null, onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val all = LocalClient.current.state.collectAsStateWithLifecycle().value.issues
    val dialogs = LocalTaskDialogs.current
    val setStatus = rememberIssueStatusSetter()
    val toggle = rememberIssueToggle()
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    var menu by remember { mutableStateOf(false) }
    var ownerSheet by remember { mutableStateOf(false) }
    var dueSheet by remember { mutableStateOf(false) }
    val today = IssueTasks.localToday()
    val done = i.closed
    val owner = Names.person(data, i.ownerId ?: "")
    val conv = data.conversations.firstOrNull { it.id == i.conversationId }
    val parent = i.parentIssueId?.let { all[it] }
    val kids = if (i.parentIssueId == null) IssueTasks.childrenOf(all.values, i.id) else emptyList()
    val group = when {
        i.personal -> stringResource(R.string.issue_personal_short)
        conv != null -> titleOf(ctx, conv, data)
        i.restricted -> stringResource(R.string.task_shared_with_me)
        else -> null
    }
    val chip = dueChip(i, today)
    val idle = if (done) 0 else IssueTasks.idleDays(i, today)
    Box {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                .background(if (menu) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                .combinedClickable(onClick = { onOpen(i.id) }, onLongClick = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); menu = true },
                    onLongClickLabel = stringResource(R.string.menu_more))
                .heightIn(min = 56.dp).padding(vertical = 2.dp).testTag("issue-${i.id}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IssueCheck(i, { toggle(i) }, size = if (child) 18.dp else 22.dp, box = 44.dp)
            Column(Modifier.weight(1f).padding(start = 2.dp, end = 8.dp)) {
                Text((if (i.restricted) "🔒 " else "") + i.title, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    style = if (child) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium,
                    textDecoration = if (done) TextDecoration.LineThrough else null,
                    color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (chip != null) {
                        val red = chip.second == MaterialTheme.colorScheme.error
                        Surface(shape = RoundedCornerShape(6.dp), color = if (red) MaterialTheme.colorScheme.error.copy(alpha = 0.12f) else Color.Transparent,
                            border = if (red) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), modifier = Modifier.testTag("taskDue-${i.id}")) {
                            Text(chip.first, style = MaterialTheme.typography.labelSmall, fontWeight = if (red) FontWeight.SemiBold else null, color = chip.second, maxLines = 1,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
                        }
                        Spacer(Modifier.width(6.dp))
                    }
                    val meta = listOfNotNull(
                        if (showGroup && !child) (if (parent != null) "↳ " + parent.title else group) else null,
                        if (idle > 0) stringResource(R.string.tasks_idle, idle) else null,
                        if (i.commentCount > 0) "💬 ${i.commentCount}" else null,
                    ).joinToString(" · ")
                    if (meta.isNotEmpty()) Text(meta, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                }
            }
            if (kids.isNotEmpty()) IssueTasks.progress(kids).let { KidsBadge(it.done, it.total, Modifier.padding(end = 6.dp).testTag("kids-${i.id}")) }
            if (showOwner && !i.personal) {
                if (owner != null) PersonAvatar(owner, data, size = if (child) 22.dp else 28.dp, modifier = Modifier.semantics { contentDescription = owner.name })
                else Text(stringResource(R.string.issue_no_owner), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, maxLines = 1)
            }
            trailing?.invoke()
        }
        // Mantener presionado: Completar y estados de siempre, y (1.7.13) «Cambiar responsable» y «Cambiar fecha».
        AnchoredMenu(menu, if (menu) listOfNotNull<SheetItem>(
            if (!i.personal && !done) SheetItem(stringResource(R.string.tasks_change_owner), "👤", tag = "menuTaskOwner") { ownerSheet = true } else null,
            if (!done) SheetItem(stringResource(R.string.tasks_change_due), "📅", tag = "menuTaskDue") { dueSheet = true } else null,
        ).let { extra -> extra + (if (extra.isNotEmpty()) listOf<SheetItem?>(null) else emptyList()) } + issueQuickMenu(ctx, i, onOpen = { onOpen(i.id) }, onStatus = { st -> setStatus(i, st) },
            onAddTask = { dialogs.openTasks(i.id) }, onSide = { dialogs.openSide(i) }) else emptyList(), { menu = false })
    }
    if (ownerSheet) OwnerPickerSheet(i, data) { ownerSheet = false }
    if (dueSheet) DuePickerSheet(i) { dueSheet = false }
}

/** Un asunto con sus tareas debajo, plegables con la flecha (las tareas no se repiten como filas sueltas). */
@Composable
fun TaskWithKids(i: IssueDTO, data: BootstrapDTO, showGroup: Boolean = true, matchingIds: Set<String>? = null, onOpen: (String) -> Unit) {
    val all = LocalClient.current.state.collectAsStateWithLifecycle().value.issues
    val kids = IssueTasks.childrenOf(all.values, i.id).filter { matchingIds == null || it.id in matchingIds }
    val contextOnly = matchingIds != null && i.id !in matchingIds
    var open by rememberSaveable(i.id, matchingIds) { mutableStateOf(contextOnly) }
    Column(Modifier.fillMaxWidth()) {
        if (contextOnly) {
            Column(Modifier.fillMaxWidth().clickable { onOpen(i.id) }.padding(vertical = 8.dp).testTag("taskContext-${i.id}")) {
                Text(i.title, style = MaterialTheme.typography.titleSmall)
                Text(stringResource(R.string.task_filter_parent_context), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else TaskRow(i, data, showGroup = showGroup, onOpen = onOpen, trailing = if (kids.isEmpty()) null else ({
            IconButton(onClick = { open = !open }, modifier = Modifier.size(36.dp).testTag("kidsToggle-${i.id}")) {
                Icon(if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, stringResource(if (open) R.string.task_hide else R.string.task_show))
            }
        }))
        AnimatedVisibility(open && kids.isNotEmpty()) {
            Column(Modifier.padding(start = 24.dp)) { kids.forEach { androidx.compose.runtime.key(it.id) { TaskRow(it, data, showGroup = false, child = true, onOpen = onOpen) } } }
        }
    }
}

/** Estado vacío amable, distinto para cada filtro. */
@Composable
fun TasksEmpty(filter: String, modifier: Modifier = Modifier) {
    val (title, body) = when (filter) {
        "open" -> R.string.tasks_empty_open_title to R.string.tasks_empty_open
        "closed" -> R.string.tasks_empty_done_title to R.string.tasks_empty_done
        else -> R.string.tasks_empty_mine_title to R.string.tasks_empty_mine
    }
    Column(modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp).testTag("tasksEmpty"), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(64.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(32.dp))
        }
        Spacer(Modifier.size(14.dp))
        Text(stringResource(title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Spacer(Modifier.size(6.dp))
        Text(stringResource(body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

/** «＋ Añadir tarea» flotante: abajo a la izquierda, sin ocupar la primera pantalla. */
@Composable
fun AddTaskFab(onClick: () -> Unit, modifier: Modifier = Modifier) {
    ExtendedFloatingActionButton(
        onClick = onClick, icon = { Icon(Icons.Filled.Add, null) }, text = { Text(stringResource(R.string.tasks_add), fontWeight = FontWeight.SemiBold) },
        containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary,
        modifier = modifier.testTag("taskAddFab"),
    )
}

/** Hoja con el alta rápida de siempre (QuickAddIssue), con el teclado listo. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddTaskSheet(onClose: () -> Unit) {
    val st = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onClose, sheetState = st, modifier = Modifier.testTag("taskAddSheet")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.tasks_add), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            QuickAddIssue(null, autoFocus = true)
        }
    }
}

// ---------- Edición rápida (1.7.13): responsable, fecha y campos, optimista con vuelta atrás ----------

/** Cambios de una tarea con el PATCH de la web: se ven al instante y, si el servidor dice que no, vuelven y se avisa. */
class TaskEditor(private val run: (suspend () -> Unit) -> Unit, private val client: com.tiecoms.app.core.TieComsClient) {
    fun setOwner(i: IssueDTO, owner: String?) {
        val (o, assignees) = IssueTasks.ownerChange(i, owner)
        run {
            client.patchIssueOptimistic(i.id, kotlinx.serialization.json.buildJsonObject {
                put("ownerId", o?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
                put("assigneeIds", kotlinx.serialization.json.JsonArray(assignees.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            }) { it.copy(ownerId = o, assigneeIds = assignees) }
        }
    }
    fun setDue(i: IssueDTO, iso: String?) {
        if (i.dueDate == iso) return
        run {
            client.patchIssueOptimistic(i.id, kotlinx.serialization.json.buildJsonObject {
                put("dueDate", iso?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
            }) { it.copy(dueDate = iso) }
        }
    }
    fun setField(i: IssueDTO, key: String, value: kotlinx.serialization.json.JsonElement?) {
        run {
            client.patchIssueOptimistic(i.id, kotlinx.serialization.json.buildJsonObject {
                put("fields", kotlinx.serialization.json.buildJsonObject { put(key, value ?: kotlinx.serialization.json.JsonNull) })
            }) { IssueTasks.withField(it, key, value) }
        }
    }
}

@Composable
fun rememberTaskEditor(): TaskEditor {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    return remember(client) {
        TaskEditor({ block ->
            container.scope.launch {
                try { block() } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    container.toast(errorText(ctx, e))
                }
            }
        }, client)
    }
}

/** Personas que pueden ser responsables: las del chat (o quienes ven una tarea restringida), yo primero. */
@Composable
fun ownerCandidates(i: IssueDTO, data: BootstrapDTO): List<com.tiecoms.app.core.PersonDTO> =
    remember(i.id, i.visibility, i.viewerIds, data) {
        IssueTasks.audience(i, humansOf(data, i.conversationId), data.people).sortedByDescending { it.id == data.me.id }
    }

/** Hoja «Cambiar responsable»: una persona (o «Sin responsable») y listo. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OwnerPickerSheet(i: IssueDTO, data: BootstrapDTO, onClose: () -> Unit) {
    val editor = rememberTaskEditor()
    val people = ownerCandidates(i, data)
    val st = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onClose, sheetState = st, modifier = Modifier.testTag("ownerSheet")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(stringResource(R.string.tasks_change_owner), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).semantics { heading() })
            Text(i.title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 16.dp))
            androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp).padding(top = 6.dp)) {
                items(people.size) { n ->
                    val p = people[n]
                    OwnerRow(p.name + if (p.id == data.me.id) " · " + stringResource(R.string.you) else "", i.ownerId == p.id, "owner-${p.id}", { PersonAvatar(p, data, size = 32.dp) }) {
                        onClose(); if (i.ownerId != p.id) editor.setOwner(i, p.id)
                    }
                }
                item {
                    OwnerRow(stringResource(R.string.issue_no_owner), i.ownerId == null, "owner-none", {
                        Box(Modifier.size(32.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape))
                    }) { onClose(); if (i.ownerId != null) editor.setOwner(i, null) }
                }
            }
        }
    }
}

@Composable
private fun OwnerRow(label: String, on: Boolean, tag: String, leading: @Composable () -> Unit, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).semantics { selected = on }.heightIn(min = 52.dp).padding(horizontal = 16.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically) {
        leading(); Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (on) Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.primary)
    }
}

/** Hoja «Cambiar fecha»: hoy, mañana, el viernes, la otra semana, el calendario o «Sin fecha». */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun DuePickerSheet(i: IssueDTO, onClose: () -> Unit) {
    val editor = rememberTaskEditor()
    var calendar by remember { mutableStateOf(false) }
    val st = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onClose, sheetState = st, modifier = Modifier.testTag("dueSheet")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.tasks_change_due), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                IssueTasks.dateShortcuts().forEach { (k, d) ->
                    val label = stringResource(when (k) {
                        IssueTasks.Shortcut.TODAY -> R.string.issue_d_today; IssueTasks.Shortcut.TOMORROW -> R.string.issue_d_tomorrow
                        IssueTasks.Shortcut.FRIDAY -> R.string.issue_d_friday; IssueTasks.Shortcut.NEXT_WEEK -> R.string.issue_d_next_week
                    })
                    androidx.compose.material3.FilterChip(i.dueDate == d.toString(), { onClose(); editor.setDue(i, d.toString()) }, { Text(label) },
                        modifier = Modifier.heightIn(min = 40.dp).testTag("dueQuick-${k.name}"))
                }
                androidx.compose.material3.AssistChip({ calendar = true }, { Text("📅 " + stringResource(R.string.issue_d_pick)) }, modifier = Modifier.heightIn(min = 40.dp).testTag("dueQuick-pick"))
                if (i.dueDate != null) androidx.compose.material3.AssistChip({ onClose(); editor.setDue(i, null) }, { Text(stringResource(R.string.issue_no_due)) },
                    modifier = Modifier.heightIn(min = 40.dp).testTag("dueQuick-none"))
            }
        }
    }
    if (calendar) IssueDatePicker(i.dueDate?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() }, { d -> onClose(); editor.setDue(i, d?.toString()) },
        { calendar = false }, allowClear = true)
}

/**
 * Campos de la tarea en el detalle: las columnas del grupo (texto, lista, número, casilla) y los campos libres que
 * traiga la tarea; abajo, solo para leer, los datos del sistema externo (cliente, prioridad…).
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun TaskFieldsSection(i: IssueDTO, canEdit: Boolean) {
    val client = LocalClient.current
    val editor = rememberTaskEditor()
    val conv = i.conversationId
    val columns by androidx.compose.runtime.produceState<List<com.tiecoms.app.core.TaskColumnDTO>>(emptyList(), conv) {
        if (!conv.isNullOrEmpty()) value = runCatching { client.taskColumns(conv).columns }.getOrDefault(emptyList())
    }
    val fields = i.fields ?: kotlinx.serialization.json.JsonObject(emptyMap())
    val free = fields.keys.filter { k -> columns.none { it.name.equals(k, ignoreCase = true) } }
    val meta = i.externalMeta.orEmpty()
    if (columns.isEmpty() && free.isEmpty() && meta.isEmpty()) return
    Column(Modifier.fillMaxWidth().testTag("taskFields"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (columns.isNotEmpty() || free.isNotEmpty()) Text(stringResource(R.string.tasks_fields), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 8.dp).semantics { heading() })
        columns.forEach { col ->
            val key = fields.keys.firstOrNull { it.equals(col.name, ignoreCase = true) } ?: col.name
            FieldEditor(col.name, col.type, col.options.orEmpty(), fields[key], canEdit) { v -> editor.setField(i, key, v) }
        }
        free.forEach { k -> FieldEditor(k, fieldType(fields[k]), emptyList(), fields[k], canEdit) { v -> editor.setField(i, k, v) } }
        if (meta.isNotEmpty()) {
            Text(stringResource(R.string.tasks_external), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
            meta.forEach { (k, v) ->
                Row(Modifier.fillMaxWidth()) {
                    Text(k, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(0.4f))
                    Text(v, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(0.6f))
                }
            }
        }
    }
}

private fun fieldType(v: kotlinx.serialization.json.JsonElement?): String {
    val p = v as? kotlinx.serialization.json.JsonPrimitive ?: return "text"
    return when { p.isString -> "text"; p.content == "true" || p.content == "false" -> "checkbox"; else -> "number" }
}

@Composable
private fun FieldEditor(name: String, type: String, options: List<String>, value: kotlinx.serialization.json.JsonElement?, enabled: Boolean,
                        onSave: (kotlinx.serialization.json.JsonElement?) -> Unit) {
    val prim = value as? kotlinx.serialization.json.JsonPrimitive
    val text = prim?.content.orEmpty()
    val tag = "field-" + name.replace(Regex("\\s+"), "_")
    when (type) {
        "checkbox" -> Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(tag), verticalAlignment = Alignment.CenterVertically) {
            Text(name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            androidx.compose.material3.Switch(checked = text == "true", enabled = enabled, onCheckedChange = { onSave(kotlinx.serialization.json.JsonPrimitive(it)) })
        }
        "select" -> {
            var open by remember { mutableStateOf(false) }
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = enabled) { open = true }.testTag(tag), verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                Box {
                    Text(text.ifEmpty { stringResource(R.string.tasks_field_unset) } + "  ▾", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                        color = if (text.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                    DropdownMenu(open, { open = false }) {
                        options.forEach { o -> DropdownMenuItem(text = { Text(o) }, trailingIcon = { if (o == text) Icon(Icons.Filled.Check, null) }, onClick = { open = false; if (o != text) onSave(kotlinx.serialization.json.JsonPrimitive(o)) }) }
                        if (text.isNotEmpty()) DropdownMenuItem(text = { Text(stringResource(R.string.tasks_field_unset)) }, onClick = { open = false; onSave(null) })
                    }
                }
            }
        }
        else -> {
            var draft by remember(text) { mutableStateOf(text) }
            val number = type == "number"
            androidx.compose.material3.OutlinedTextField(draft, { draft = it.take(2000) }, label = { Text(name) }, enabled = enabled, singleLine = number, maxLines = 4,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = if (number) androidx.compose.ui.text.input.KeyboardType.Decimal else androidx.compose.ui.text.input.KeyboardType.Text),
                trailingIcon = if (draft != text) ({
                    IconButton(onClick = {
                        val t = draft.trim()
                        onSave(when {
                            t.isEmpty() -> null
                            number -> t.replace(',', '.').toDoubleOrNull()?.let { d -> if (d % 1.0 == 0.0 && kotlin.math.abs(d) < 1e15) kotlinx.serialization.json.JsonPrimitive(d.toLong()) else kotlinx.serialization.json.JsonPrimitive(d) } ?: return@IconButton
                            else -> kotlinx.serialization.json.JsonPrimitive(t)
                        })
                    }, modifier = Modifier.testTag("$tag-save")) { Icon(Icons.Filled.Check, stringResource(R.string.tasks_field_save)) }
                }) else null,
                modifier = Modifier.fillMaxWidth().testTag(tag))
        }
    }
}
