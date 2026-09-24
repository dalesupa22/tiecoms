package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.IssueDTO
import com.tiecoms.app.core.IssueEventDTO
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
import java.time.format.DateTimeFormatter
import java.util.Locale

val ISSUE_STATUSES = listOf("open", "in_progress", "waiting", "done", "cancelled")
private const val STALL_DAYS = 2

fun statusText(ctx: Context, s: String) = ctx.getString(
    when (s) { "in_progress" -> R.string.issue_st_in_progress; "waiting" -> R.string.issue_st_waiting; "done" -> R.string.issue_st_done; "cancelled" -> R.string.issue_st_cancelled; else -> R.string.issue_st_open },
)

/** Señal de cuello de botella: lleva días sin moverse, o se venció (issueFlags de la web). */
data class IssueFlags(val stalledDays: Int, val overdue: Boolean, val dueToday: Boolean)

fun issueFlags(i: IssueDTO, today: LocalDate = LocalDate.now(), now: Instant = Instant.now()): IssueFlags {
    if (i.closed) return IssueFlags(0, false, false)
    val since = parseInstant(i.statusSince)
    val days = if (since == null) 0 else ((now.toEpochMilli() - since.toEpochMilli()) / 86_400_000L).toInt()
    val todayIso = today.toString()
    return IssueFlags(if (days >= STALL_DAYS) days else 0, i.dueDate != null && i.dueDate < todayIso, i.dueDate == todayIso)
}

fun dueLabel(ctx: Context, i: IssueDTO) =
    i.dueDate?.let { runCatching { LocalDate.parse(it).format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())) }.getOrDefault(it) } ?: ctx.getString(R.string.issue_no_due)

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
        Text(statusText(ctx, status), color = fg, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun IssueRow(i: IssueDTO, data: BootstrapDTO, showWhere: Boolean = true, onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val owner = Names.person(data, i.ownerId ?: "")
    val conv = data.conversations.firstOrNull { it.id == i.conversationId }
    val f = issueFlags(i)
    Row(Modifier.fillMaxWidth().clickable { onOpen(i.id) }.heightIn(min = 60.dp).padding(vertical = 8.dp).testTag("issue-${i.id}"), verticalAlignment = Alignment.CenterVertically) {
        val o = Names.org(data, owner?.orgId)
        Avatar(owner?.name ?: "–", parseColor(o?.colorBg, Color(0xFFBDB5AE)), parseColor(o?.colorFg, Color.White), size = 32.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(i.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(owner?.name ?: stringResource(R.string.common_none), if (showWhere && conv != null) stringResource(R.string.issue_in, titleOf(ctx, conv, data)) else null).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (f.stalledDays > 0) Text("⏱ " + if (f.stalledDays == 1) stringResource(R.string.issue_stalled_one) else stringResource(R.string.issue_stalled, f.stalledDays),
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            StatusPill(i.status)
            Text(if (f.overdue) stringResource(R.string.issue_overdue) else if (f.dueToday) stringResource(R.string.issue_today) else dueLabel(ctx, i),
                style = MaterialTheme.typography.labelSmall, color = if (f.overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IssuesScreen(onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    var filter by rememberSaveable { mutableStateOf("mine") }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { client.loadIssues() }.onFailure { error = errorText(ctx, it) } }
    val visible = data.conversations.map { it.id }.toSet()
    val list = st.issues.values.filter { it.conversationId in visible }
        .filter { if (filter == "closed") it.closed else !it.closed && (filter == "open" || it.ownerId == data.me.id) }
        .sortedWith(compareByDescending<IssueDTO> { issueFlags(it).stalledDays }.thenBy { it.dueDate ?: "9" })
    val byWs = list.groupBy { it.workspaceId }
    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.nav_issues), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)) },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize().padding(horizontal = 16.dp).testTag("issues")) {
            item {
                Text(stringResource(R.string.issue_page_sub), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.heightIn(min = 12.dp))
                Segmented(listOf("mine" to stringResource(R.string.issue_mine), "open" to stringResource(R.string.issue_all_open), "closed" to stringResource(R.string.issue_closed)), filter, { filter = it }, Modifier.testTag("issueFilter"))
                ErrorText(error)
                if (list.isEmpty()) EmptyNote(stringResource(R.string.issue_empty))
            }
            byWs.forEach { (wsId, items) ->
                item(key = "ws$wsId") { SectionHeader(data.workspaces.firstOrNull { it.id == wsId }?.name ?: "", Modifier.padding(top = 16.dp, bottom = 4.dp).semantics { heading() }) }
                items(items, key = { it.id }) { IssueRow(it, data, onOpen = onOpen) }
            }
        }
    }
}

private fun eventText(ctx: Context, d: BootstrapDTO, e: IssueEventDTO): String {
    val to = e.payload["to"]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
    return when (e.kind) {
        "created" -> ctx.getString(R.string.issue_ev_created)
        "status" -> ctx.getString(R.string.issue_ev_status, statusText(ctx, to ?: "open"))
        "owner" -> ctx.getString(R.string.issue_ev_owner) + " → " + (Names.person(d, to ?: "")?.name ?: ctx.getString(R.string.common_none))
        "due" -> ctx.getString(R.string.issue_ev_due, to?.let { runCatching { LocalDate.parse(it).format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())) }.getOrDefault(it) } ?: ctx.getString(R.string.issue_no_due))
        "title" -> ctx.getString(R.string.issue_ev_title) + " → «$to»"
        "waiting" -> ctx.getString(R.string.issue_ev_waiting) + (to?.let { ": " + (Names.org(d, it)?.name ?: "") } ?: "")
        else -> ""
    }
}

/** Detalle de un asunto: estado, responsable, fecha, a quién se espera, origen, historial y comentarios. */
@Composable
fun IssueDetailScreen(id: String, onBack: () -> Unit, onOpenOrigin: (String, Long) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val live = st.issues[id]
    var events by remember { mutableStateOf<List<IssueEventDTO>>(emptyList()) }
    var comment by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() { runCatching { events = client.issueDetail(id).events }.onFailure { error = errorText(ctx, it) } }
    LaunchedEffect(id, live?.updatedAt) { load() }
    SimpleScaffold(live?.title ?: stringResource(R.string.nav_issues), onBack) {
        val i = live ?: run { if (error != null) ErrorText(error) else CircularProgressIndicator(Modifier.padding(24.dp)); return@SimpleScaffold }
        val conv = data.conversations.firstOrNull { it.id == i.conversationId }
        val members = humansOf(data, i.conversationId)
        val orgIds = members.mapNotNull { it.orgId }.distinct()
        val f = issueFlags(i)
        val canSeeOrigin = conv != null && i.originMessageSeq != null && i.originMessageSeq > conv.historyFromSeq
        val requester = Names.person(data, i.requestedBy ?: "")
        fun update(key: String, value: String?) = scope.launch {
            runCatching { client.updateIssue(i.id, buildJsonObject { put(key, value?.let { JsonPrimitive(it) } ?: JsonNull) }) }.onFailure { error = errorText(ctx, it) }
        }
        LazyColumn(Modifier.fillMaxSize().imePadding().padding(horizontal = 16.dp).testTag("issueDetail"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Text("${conv?.let { titleOf(ctx, it, data) } ?: ""} · ${requester?.let { stringResource(R.string.issue_requested_by, it.name) } ?: stringResource(R.string.issue_manual)}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (f.stalledDays > 0 || f.overdue) item {
                Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth()) {
                    Text("⏱ " + stringResource(R.string.issue_bottleneck) + " · " + listOfNotNull(
                        if (f.overdue) stringResource(R.string.issue_overdue) else null,
                        if (f.stalledDays > 0) (if (f.stalledDays == 1) stringResource(R.string.issue_stalled_one) else stringResource(R.string.issue_stalled, f.stalledDays)) else null,
                    ).joinToString(" · "), Modifier.padding(10.dp), color = MaterialTheme.colorScheme.onErrorContainer)
                }
            }
            item {
                SectionHeader(stringResource(R.string.issue_status))
                // Cinco estados: en dos filas de chips seleccionables (como el .seg de la web).
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("issueStatus")) {
                    ISSUE_STATUSES.forEach { s ->
                        FilterChip(selected = i.status == s, onClick = { update("status", s) }, label = { Text(statusText(ctx, s)) }, modifier = Modifier.testTag("status-$s"))
                    }
                }
            }
            item {
                Dropdown(stringResource(R.string.issue_owner), listOf<Pair<String?, String>>(null to stringResource(R.string.common_none)) + members.map { p -> p.id to "${p.name} · ${Names.org(data, p.orgId)?.name ?: stringResource(R.string.common_guest)}" },
                    i.ownerId, { update("ownerId", it) }, Modifier.fillMaxWidth())
            }
            item { DateField(stringResource(R.string.issue_due), i.dueDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() }, { update("dueDate", it?.toString()) }, allowClear = true, modifier = Modifier.fillMaxWidth()) }
            if (i.status == "waiting") item {
                Dropdown(stringResource(R.string.issue_waiting_on), listOf<Pair<String?, String>>(null to stringResource(R.string.issue_waiting_on_ph)) + orgIds.map { it to (Names.org(data, it)?.name ?: "") },
                    i.waitingOnOrgId, { update("waitingOnOrgId", it) }, Modifier.fillMaxWidth())
            }
            if (i.originMessageId != null) item {
                if (canSeeOrigin) TextButton(onClick = { onOpenOrigin(i.conversationId, i.originMessageSeq) }) { Text("↗ " + stringResource(R.string.issue_origin)) }
                else Text(stringResource(R.string.issue_origin_out), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item { SectionHeader(stringResource(R.string.issue_history), Modifier.semantics { heading() }) }
            items(events, key = { it.id }) { e ->
                val who = Names.person(data, e.actorId)
                Column(Modifier.fillMaxWidth()) {
                    Text(buildString {
                        append(who?.name ?: ctx.getString(R.string.common_participant)); append(' ')
                        if (e.kind != "comment") append(eventText(ctx, data, e))
                        append(" · "); append(shortDateTime(e.createdAt))
                    }, style = MaterialTheme.typography.bodySmall)
                    if (e.kind == "comment") Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
                        Text(e.payload["body"]?.let { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: "", Modifier.padding(8.dp))
                    }
                }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(comment, { comment = it.take(4000) }, placeholder = { Text(stringResource(R.string.issue_comment_ph)) }, modifier = Modifier.weight(1f).testTag("issueComment"))
                    Spacer(Modifier.width(8.dp))
                    Button(enabled = comment.isNotBlank(), onClick = {
                        val body = comment.trim()
                        scope.launch { runCatching { client.commentIssue(i.id, body); comment = ""; load() }.onFailure { error = errorText(ctx, it) } }
                    }, modifier = Modifier.testTag("issueCommentSend")) { Text(stringResource(R.string.issue_comment)) }
                }
                ErrorText(error)
                Spacer(Modifier.heightIn(min = 24.dp))
            }
        }
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

