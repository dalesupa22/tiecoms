package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.IssueDTO
import com.tiecoms.app.core.Names
import java.time.Instant
import java.time.LocalDate

/** Hilos de una conversación (o de uno de sus mensajes): los abiertos primero, luego por actividad. */
fun threadsOf(d: BootstrapDTO, conversationId: String, messageId: String? = null): List<ConversationDTO> =
    d.conversations.filter { it.parentId == conversationId && (messageId == null || it.parentMessageId == messageId) }
        .sortedWith(compareBy<ConversationDTO> { it.returnedAt != null }.thenByDescending { it.lastMessageAt ?: "" })

private val THREAD_PREFIX = Regex("^(Sidechat|Consulta|Consulta lateral|Hilo|Thread|Interno|Internal|Derivada|Branch|Diagnóstico|Diagnosis|Decisión|Decision)\\s*·\\s*", RegexOption.IGNORE_CASE)

/** El título del hilo sin el prefijo que ya dice el ícono (threadTitle de la web). */
fun threadTitle(ctx: Context, c: ConversationDTO, d: BootstrapDTO?): String = titleOf(ctx, c, d).replace(THREAD_PREFIX, "")

private sealed interface Pane { data object Issues : Pane; data object Threads : Pane; data object Agenda : Pane }

/**
 * Barra de accesos del chat (docs/GRUPOS.md, ChatBar de la web): 📌 Fijados · ◆ Asuntos · 💬 Hilos · 📅 Agenda,
 * siempre visibles con su cuenta (en gris si es 0). Cada botón abre su lista en una hoja, sin mover el chat.
 */
@Composable
fun ChatBar(
    conv: ConversationDTO, data: BootstrapDTO, pinnedCount: Int, canOpenIssues: Boolean,
    onPins: () -> Unit, onOpenIssue: (String) -> Unit, onNewIssue: () -> Unit, onNewEvent: () -> Unit, onOpenEvent: (String) -> Unit, onOpenThread: (String) -> Unit,
) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    var pane by remember { mutableStateOf<Pane?>(null) }
    LaunchedEffect(conv.id) { runCatching { client.loadEvents(Instant.now().minusSeconds(3600), Instant.now().plusSeconds(90L * 86400), conv.id) } }
    val today = LocalDate.now().toString()
    val issues = st.issues.values.filter { it.conversationId == conv.id && !it.closed }.sortedBy { it.dueDate ?: "9999" }
    val threads = threadsOf(data, conv.id)
    val openThreads = threads.count { it.returnedAt == null }
    val events = st.events.values.filter { it.conversationId == conv.id && it.cancelledAt == null && (parseInstant(it.endsAt)?.isAfter(Instant.now()) == true) }
    val reminders = st.reminders.filter { it.conversationId == conv.id && it.doneAt == null }
    val agendaCount = events.size + issues.count { it.dueDate != null } + reminders.size
    val overdue = issues.any { it.dueDate != null && it.dueDate < today }
    val meetingToday = events.any { localDate(it.startsAt)?.toString() == today }

    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().testTag("chatBar")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            BarButton("📌", stringResource(R.string.bar_pins), pinnedCount, false, "pinsButton", onPins)
            BarButton("◆", stringResource(R.string.bar_issues), issues.size, overdue, "barIssues") { pane = Pane.Issues }
            BarButton("💬", stringResource(R.string.bar_threads), openThreads, threads.any { it.unread > 0 }, "barThreads") { pane = Pane.Threads }
            BarButton("📅", stringResource(R.string.bar_agenda), agendaCount, meetingToday, "barAgenda") { pane = Pane.Agenda }
        }
    }
    when (pane) {
        null -> Unit
        Pane.Issues -> FormSheet(stringResource(R.string.bar_issues_title), { pane = null }, tag = "barIssuesSheet") {
            if (issues.isEmpty()) Text(stringResource(R.string.issue_no_issues), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            issues.forEach { IssueRow(it, data, showWhere = false) { id -> pane = null; onOpenIssue(id) } }
            if (canOpenIssues) Button(onClick = { pane = null; onNewIssue() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("barNewIssue")) { Text("＋ " + stringResource(R.string.bar_new_issue)) }
        }
        Pane.Threads -> FormSheet(stringResource(R.string.bar_threads_title), { pane = null }, tag = "barThreadsSheet") {
            if (threads.isEmpty()) Text(stringResource(R.string.bar_no_threads), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            threads.forEach { c -> ThreadRow(ctx, data, c) { pane = null; onOpenThread(c.id) } }
        }
        Pane.Agenda -> FormSheet(stringResource(R.string.bar_agenda_title), { pane = null }, tag = "barAgendaSheet") {
            // Por fecha: reuniones, fechas límite de los asuntos abiertos y mis recordatorios (solo yo los veo).
            data class Item(val at: String, val content: @Composable () -> Unit)
            val items = buildList {
                events.forEach { e -> add(Item(e.startsAt) { EventRow(e, data, showConv = false) { id -> pane = null; onOpenEvent(id) } }) }
                issues.filter { it.dueDate != null }.forEach { i -> add(Item(i.dueDate + "T23:59:00") { DueRow(ctx, i, i.dueDate!! < today) { pane = null; onOpenIssue(i.id) } }) }
                reminders.forEach { r -> add(Item(r.remindAt) {
                    AgendaLine("⏰", r.note?.takeIf { it.isNotBlank() } ?: stringResource(R.string.bar_reminder), stringResource(R.string.bar_only_you) + " · " + shortDateTime(r.remindAt), null) {}
                }) }
            }.sortedBy { it.at }
            if (items.isEmpty()) Text(stringResource(R.string.bar_no_agenda), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            items.forEach { it.content() }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                if (canOpenIssues) OutlinedButton(onClick = { pane = null; onNewIssue() }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("＋ " + stringResource(R.string.bar_new_issue)) }
                if (conv.canPost) Button(onClick = { pane = null; onNewEvent() }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("barNewEvent")) { Text("＋ " + stringResource(R.string.bar_new_event)) }
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.BarButton(icon: String, label: String, n: Int, alert: Boolean, tag: String, onClick: () -> Unit) {
    val fg = if (n == 0) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.onSurface
    Surface(onClick = onClick, shape = RoundedCornerShape(12.dp), color = Color.Transparent,
        modifier = Modifier.weight(1f).heightIn(min = 44.dp).semantics { contentDescription = "$label: $n" }.testTag(tag)) {
        Row(Modifier.padding(horizontal = 4.dp, vertical = 8.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Text(icon, style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.width(4.dp))
            Text(n.toString(), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = if (alert) Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE) else fg)
            Spacer(Modifier.width(4.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (alert) Box(Modifier.padding(start = 3.dp).size(6.dp).background(Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), CircleShape))
        }
    }
}

@Composable
private fun AgendaLine(icon: String, title: String, sub: String, tag: String?, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 52.dp).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(icon, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (tag != null) Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(8.dp)) {
            Text(tag, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
        }
    }
}

@Composable
private fun DueRow(ctx: Context, i: IssueDTO, overdue: Boolean, onClick: () -> Unit) =
    AgendaLine("◆", i.title, ctx.getString(R.string.bar_due_on, dueLabel(ctx, i)), if (overdue) ctx.getString(R.string.bar_overdue) else null, onClick)

/** Fila de la lista de hilos: 💬 o 🔒, título sin prefijo, con quién, personas, respuestas, actividad y estado. */
@Composable
private fun ThreadRow(ctx: Context, d: BootstrapDTO, c: ConversationDTO, onClick: () -> Unit) {
    val n = (c.lastMessageSeq - 1).coerceAtLeast(0).toInt()
    val sub = listOfNotNull(
        stringResource(if (c.isSide) R.string.bar_private else R.string.bar_public),
        stringResource(R.string.bar_people_n, c.memberIds.size),
        if (n == 0) null else if (n == 1) stringResource(R.string.bar_reply_one) else stringResource(R.string.bar_replies_n, n),
        relativeTime(ctx, c.lastMessageAt).takeIf { it.isNotBlank() },
    ).joinToString(" · ")
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(vertical = 6.dp).testTag("thread-${c.id}"), verticalAlignment = Alignment.CenterVertically) {
        Text(if (c.isSide) "🔒" else "💬", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(threadTitle(ctx, c, d), fontWeight = if (c.unread > 0) FontWeight.Bold else FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (c.unread > 0) Box(Modifier.padding(horizontal = 6.dp).background(Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), CircleShape).padding(horizontal = 6.dp, vertical = 1.dp)) {
            Text(c.unread.toString(), color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
        }
        val solved = c.returnedAt != null
        Surface(color = if (solved) Color(0xFFDCFCE7) else MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(8.dp)) {
            Text(if (solved) "✓ " + stringResource(R.string.bar_solved) else stringResource(R.string.bar_open), style = MaterialTheme.typography.labelSmall,
                color = if (solved) Color(0xFF166534) else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
        }
    }
}

/**
 * Bajo el mensaje, como en Slack: «💬 3 respuestas · Laura: ya va» (o «💬 ✓ título» si está resuelto). Abre el hilo al lado.
 * Los sidechats privados siguen con su SideChip.
 */
@Composable
fun ThreadChip(threads: List<ConversationDTO>, onOpen: (String) -> Unit) {
    if (threads.isEmpty()) return
    val ctx = LocalContext.current
    val data = LocalClient.current.state.collectAsStateWithLifecycle().value.data ?: return
    threads.forEach { c ->
        val n = (c.lastMessageSeq - 1).coerceAtLeast(0).toInt()
        val last = c.lastHumanPreview?.let { h ->
            val who = if (h.authorId == data.me.id) stringResource(R.string.common_you_short) else Names.person(data, h.authorId)?.name?.substringBefore(' ')
            val text = com.tiecoms.app.core.Attachments.preview(h.attachments, h.body, attLabels(ctx))
            if (text.isBlank()) null else listOfNotNull(who?.let { "$it:" }, text).joinToString(" ")
        }
        val head = when {
            c.returnedAt != null -> "✓ " + threadTitle(ctx, c, data)
            n == 0 -> threadTitle(ctx, c, data)
            n == 1 -> stringResource(R.string.bar_reply_one)
            else -> stringResource(R.string.bar_replies_n, n)
        }
        Surface(shape = RoundedCornerShape(14.dp), color = if (c.returnedAt != null) Color(0xFFDCFCE7) else MaterialTheme.colorScheme.secondaryContainer,
            modifier = Modifier.padding(top = 4.dp).widthIn(max = 300.dp).clickable { onOpen(c.id) }.testTag("threadChip-${c.id}")) {
            Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                StackedAvatars(c.memberIds.filter { it != data.me.id }, data, 20.dp)
                Spacer(Modifier.width(6.dp))
                Column(Modifier.weight(1f, fill = false)) {
                    Text("💬 $head", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (c.returnedAt != null) Color(0xFF166534) else MaterialTheme.colorScheme.onSecondaryContainer)
                    if (!last.isNullOrBlank() && c.returnedAt == null) Text(last, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.8f))
                }
                if (c.unread > 0 && !c.mutedAt(System.currentTimeMillis())) Box(Modifier.padding(start = 6.dp).size(8.dp).background(Color(0xFFE8710A), CircleShape))
            }
        }
    }
}
