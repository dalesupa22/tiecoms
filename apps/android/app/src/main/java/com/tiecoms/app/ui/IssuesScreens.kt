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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
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
        Avatar(owner?.name ?: "–", parseColor(o?.colorBg, Color(0xFFBDB5AE)), parseColor(o?.colorFg, Color.White), size = 32.dp, photo = owner?.avatarUrl)
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
fun IssuesScreen(onOpen: (String) -> Unit, conversationFilter: String? = null, onBack: (() -> Unit)? = null) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    // Míos / Abiertos / Todos (SPEC-v3 §9). Con conversación, empieza en Abiertos.
    var filter by rememberSaveable { mutableStateOf(if (conversationFilter != null) "open" else "mine") }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(conversationFilter) { runCatching { client.loadIssues(conversationId = conversationFilter) }.onFailure { error = errorText(ctx, it) } }
    val visible = data.conversations.associateBy { it.id }
    val list = st.issues.values.filter { it.conversationId in visible && (conversationFilter == null || it.conversationId == conversationFilter) }
        .filter { when (filter) { "all" -> true; "open" -> !it.closed; else -> !it.closed && it.ownerId == data.me.id } }
        .sortedWith(compareBy<IssueDTO> { it.closed }.thenByDescending { issueFlags(it).stalledDays }.thenBy { it.dueDate ?: "9" })
    // Empresa → Espacio → Conversación → asuntos, con la misma agrupación que Inicio.
    val wsById = data.workspaces.associateBy { it.id }
    // Asuntos de directos y chats grupales (sin espacio, SPEC-v4 §E): sección «Chats» después de las empresas.
    val byOrg = list.groupBy { i -> if (i.workspaceId == null) CHATS_GROUP else wsById[i.workspaceId]?.let { com.tiecoms.app.core.HomeTree.counterpartOrg(data, it)?.id } ?: "none" }
    val orgOrder = com.tiecoms.app.core.HomeTree.groupWorkspaces(data).map { it.first?.id ?: "none" }.distinct()
    val title = conversationFilter?.let { id -> visible[id]?.let { stringResource(R.string.issue_in_conversation, titleOf(ctx, it, data)) } } ?: stringResource(R.string.nav_issues)
    Scaffold(
        topBar = { TopAppBar(
            navigationIcon = { if (onBack != null) androidx.compose.material3.IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
            title = { Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() }) },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)) },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize().padding(horizontal = 16.dp).testTag("issues")) {
            item {
                if (conversationFilter == null) Text(stringResource(R.string.issue_page_sub), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.heightIn(min = 12.dp))
                Segmented(listOf("mine" to stringResource(R.string.issue_mine), "open" to stringResource(R.string.issue_all_open), "all" to stringResource(R.string.issue_all)), filter, { filter = it }, Modifier.testTag("issueFilter"))
                ErrorText(error)
                if (list.isEmpty()) EmptyNote(stringResource(R.string.issue_empty))
            }
            (orgOrder + byOrg.keys.filter { it !in orgOrder && it != CHATS_GROUP } + CHATS_GROUP).forEach { orgId ->
                val inOrg = byOrg[orgId] ?: return@forEach
                if (orgId == CHATS_GROUP) {
                    item(key = "o$orgId") { SectionHeader(stringResource(R.string.issue_chats_section), Modifier.padding(top = 18.dp, bottom = 2.dp).testTag("issuesChats")) }
                    inOrg.groupBy { it.conversationId }.forEach { (cid, inConv) ->
                        item(key = "c$cid") {
                            Row(Modifier.padding(start = 4.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                visible[cid]?.let { ConversationIcon(it, data, 24.dp) }; Spacer(Modifier.width(8.dp))
                                Text(visible[cid]?.let { titleOf(ctx, it, data) } ?: "", style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        items(inConv, key = { it.id }) { Box(Modifier.padding(start = 12.dp)) { IssueRow(it, data, showWhere = false, onOpen = onOpen) } }
                    }
                    return@forEach
                }
                val org = Names.org(data, orgId.takeIf { it != "none" })
                item(key = "o$orgId") {
                    Row(Modifier.padding(top = 18.dp, bottom = 2.dp).semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.CenterVertically) {
                        OrgMark(org, size = 20.dp); Spacer(Modifier.width(8.dp))
                        Text(org?.name ?: stringResource(R.string.common_no_company), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
                    }
                }
                inOrg.groupBy { it.workspaceId }.forEach { (wsId, inWs) ->
                    item(key = "w$wsId") {
                        Text(wsById[wsId]?.name ?: "", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(start = 12.dp, top = 6.dp).semantics { heading() })
                    }
                    inWs.groupBy { it.conversationId }.forEach { (cid, inConv) ->
                        item(key = "c$cid") {
                            Row(Modifier.padding(start = 24.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                visible[cid]?.let { ConversationIcon(it, data, 20.dp) }; Spacer(Modifier.width(6.dp))
                                Text(visible[cid]?.let { titleOf(ctx, it, data) } ?: "", style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        items(inConv, key = { it.id }) { Box(Modifier.padding(start = 24.dp)) { IssueRow(it, data, showWhere = false, onOpen = onOpen) } }
                    }
                }
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
    // En vivo: issue.updated trae updatedAt/commentCount nuevos y se recarga el historial.
    LaunchedEffect(id, live?.updatedAt, live?.commentCount) { load() }
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
                Row(Modifier.fillMaxWidth().testTag("issueEvent-${e.kind}"), verticalAlignment = Alignment.Top) {
                    AuthorAvatar(who, e.actorId, 28.dp)
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(buildString {
                            append(who?.name ?: ctx.getString(R.string.common_participant)); append(' ')
                            if (e.kind != "comment") append(eventText(ctx, data, e))
                        }, style = MaterialTheme.typography.bodySmall, fontWeight = if (e.kind == "comment") FontWeight.SemiBold else null,
                            color = if (e.kind == "comment") personColor(e.actorId) else MaterialTheme.colorScheme.onSurface)
                        if (e.kind == "comment") Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small, modifier = Modifier.padding(top = 2.dp)) {
                            Text(e.payload["body"]?.let { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: "", Modifier.padding(8.dp).testTag("commentBody"))
                        }
                        Text(shortDateTime(e.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            item {
                // Un solo compositor: el campo y «Comentar» a la derecha, habilitado con texto (SPEC-v3 §3).
                var sending by remember { mutableStateOf(false) }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                    OutlinedTextField(comment, { comment = it.take(4000) }, placeholder = { Text(stringResource(R.string.issue_comment_ph3)) }, maxLines = 5,
                        modifier = Modifier.weight(1f).testTag("issueComment"))
                    Spacer(Modifier.width(8.dp))
                    Button(enabled = comment.isNotBlank() && !sending, onClick = {
                        val body = comment.trim()
                        sending = true; error = null
                        scope.launch { runCatching { client.commentIssue(i.id, body); comment = ""; load() }.onFailure { error = errorText(ctx, it) }; sending = false }
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


private const val CHATS_GROUP = "chats"
