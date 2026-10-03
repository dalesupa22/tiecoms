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
fun TaskBucketHeader(b: IssueTasks.DueBucket?, count: Int) {
    val text = stringResource(when (b) {
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
        AnchoredMenu(menu, if (menu) issueQuickMenu(ctx, i, onOpen = { onOpen(i.id) }, onStatus = { st -> setStatus(i, st) },
            onAddTask = { dialogs.openTasks(i.id) }, onSide = { dialogs.openSide(i) }) else emptyList(), { menu = false })
    }
}

/** Un asunto con sus tareas debajo, plegables con la flecha (las tareas no se repiten como filas sueltas). */
@Composable
fun TaskWithKids(i: IssueDTO, data: BootstrapDTO, showGroup: Boolean = true, onOpen: (String) -> Unit) {
    val all = LocalClient.current.state.collectAsStateWithLifecycle().value.issues
    val kids = IssueTasks.childrenOf(all.values, i.id)
    var open by rememberSaveable(i.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        TaskRow(i, data, showGroup = showGroup, onOpen = onOpen, trailing = if (kids.isEmpty()) null else ({
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
