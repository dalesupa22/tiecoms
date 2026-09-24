package com.tiecoms.app.ui

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConnectionStatus
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.WorkspaceDTO
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.launch

private sealed interface HomeRow {
    val key: String
    data class Header(val title: String, override val key: String) : HomeRow
    data class Conv(val c: ConversationDTO, override val key: String = "c:" + c.id) : HomeRow
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(workspaceFilter: String?, onClearFilter: () -> Unit, onOpen: (String) -> Unit, onSettings: () -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val state by client.state.collectAsStateWithLifecycle()
    val data = state.data ?: return
    var query by rememberSaveable { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    val internalFallback = stringResource(R.string.internal_default)
    val convFallback = stringResource(R.string.conversation)
    val directs = stringResource(R.string.direct_messages)

    val rows = remember(data, query, workspaceFilter) { buildRows(data, query, workspaceFilter, internalFallback, convFallback, directs) }
    val filterWs = workspaceFilter?.let { id -> data.workspaces.firstOrNull { it.id == id } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.conversations), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                actions = {
                    IconButton(onClick = onSettings, modifier = Modifier.testTag("settings")) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(state.connection)
            OutlinedTextField(
                value = query, onValueChange = { query = it },
                placeholder = { Text(stringResource(R.string.search)) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = if (query.isNotEmpty()) { { IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, stringResource(R.string.clear_search)) } } } else null,
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                shape = MaterialTheme.shapes.extraLarge,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("search"),
            )
            if (filterWs != null) {
                InputChip(
                    selected = true, onClick = onClearFilter,
                    label = { Text(stringResource(R.string.filter_space, filterWs.name), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    trailingIcon = { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.show_all), Modifier.size(18.dp)) },
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        refreshing = true
                        try { client.loadBootstrap() } catch (e: Exception) { snackbar.showSnackbar(errorText(ctx, e)) } finally { refreshing = false }
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                if (rows.isEmpty()) {
                    // LazyColumn vacía para que el gesto de refrescar siga funcionando.
                    LazyColumn(Modifier.fillMaxSize()) {
                        item {
                            Text(
                                stringResource(if (query.isNotBlank() || filterWs != null) R.string.home_empty_filter else R.string.home_empty),
                                textAlign = TextAlign.Center,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().padding(32.dp),
                            )
                        }
                    }
                } else {
                    LazyColumn(Modifier.fillMaxSize().testTag("conversationList")) {
                        items(rows, key = { it.key }) { row ->
                            when (row) {
                                is HomeRow.Header -> SectionHeader(row.title, Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() })
                                is HomeRow.Conv -> ConversationRow(row.c, data, internalFallback, convFallback) { onOpen(row.c.id) }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun buildRows(data: BootstrapDTO, query: String, wsFilter: String?, internalFallback: String, convFallback: String, directsTitle: String): List<HomeRow> {
    val q = query.trim().lowercase()
    fun matches(c: ConversationDTO): Boolean {
        if (q.isEmpty()) return true
        val title = Names.conversationTitle(c, data, internalFallback, convFallback).lowercase()
        if (q in title) return true
        if (c.lastMessagePreview?.lowercase()?.contains(q) == true) return true
        return c.memberIds.any { id -> Names.person(data, id)?.name?.lowercase()?.contains(q) == true }
    }
    val convs = data.conversations.filter { (wsFilter == null || it.workspaceId == wsFilter) && matches(it) }
        .sortedByDescending { it.lastMessageAt ?: "" }
    val rows = mutableListOf<HomeRow>()
    val byWs = convs.filter { it.kind != "direct" }.groupBy { it.workspaceId }
    val wsOrder: List<WorkspaceDTO?> = data.workspaces
        .sortedByDescending { ws -> byWs[ws.id]?.maxOfOrNull { it.lastMessageAt ?: "" } ?: ws.createdAt }
        .let { list -> list + if (byWs.keys.any { k -> list.none { it.id == k } }) listOf(null) else emptyList() }
    for (ws in wsOrder) {
        val list = if (ws == null) byWs.filterKeys { k -> data.workspaces.none { it.id == k } }.values.flatten() else byWs[ws.id].orEmpty()
        if (list.isEmpty()) continue
        rows += HomeRow.Header(ws?.name ?: convFallback, "h:" + (ws?.id ?: "other"))
        // Grupos compartidos primero, internos (con candado) después.
        list.sortedWith(compareBy<ConversationDTO> { if (it.kind == "internal") 1 else 0 }.thenByDescending { it.lastMessageAt ?: "" })
            .forEach { rows += HomeRow.Conv(it) }
    }
    val directs = convs.filter { it.kind == "direct" }
    if (directs.isNotEmpty()) {
        rows += HomeRow.Header(directsTitle, "h:directs")
        directs.forEach { rows += HomeRow.Conv(it) }
    }
    return rows
}

@Composable
private fun ConversationRow(c: ConversationDTO, data: BootstrapDTO, internalFallback: String, convFallback: String, onClick: () -> Unit) {
    val ctx = LocalContext.current
    val title = Names.conversationTitle(c, data, internalFallback, convFallback)
    val preview = c.lastMessagePreview?.let { if (it.startsWith("{")) systemText(ctx, it) else it } ?: stringResource(R.string.no_messages)
    val time = relativeTime(ctx, c.lastMessageAt)
    val (bg, fg, label) = when (c.kind) {
        "direct" -> {
            val other = Names.otherInDirect(c, data)
            val org = Names.org(data, other?.orgId)
            Triple(parseColor(org?.colorBg, Brand.Black), parseColor(org?.colorFg, Color.White), title)
        }
        else -> {
            val ws = data.workspaces.firstOrNull { it.id == c.workspaceId }
            val org = Names.org(data, c.internalOrgId ?: ws?.owningOrgId)
            Triple(parseColor(org?.colorBg, Brand.Orange), parseColor(org?.colorFg, Color.White), ws?.glyph?.takeIf { it.isNotBlank() } ?: title)
        }
    }
    val unreadText = if (c.unread > 0) pluralStringResource(R.plurals.unread_count, c.unread, c.unread) else null
    val internalCd = stringResource(R.string.internal_cd)
    val a11y = listOfNotNull(title, if (c.kind == "internal") internalCd else null, preview, time, unreadText).joinToString(". ")
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 10.dp)
            .semantics(mergeDescendants = true) { contentDescription = a11y }.testTag("conv-${c.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(label, bg, fg, square = c.kind != "direct")
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (c.kind == "internal") {
                    Icon(Icons.Filled.Lock, contentDescription = null, Modifier.size(15.dp).padding(end = 2.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(2.dp))
                }
                Text(
                    title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    fontWeight = if (c.unread > 0) FontWeight.Bold else FontWeight.SemiBold, modifier = Modifier.weight(1f, fill = false),
                )
            }
            Text(
                preview, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (c.unread > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(time, style = MaterialTheme.typography.labelSmall, color = if (c.unread > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            if (c.unread > 0) {
                Box(
                    Modifier.widthIn(min = 22.dp).background(MaterialTheme.colorScheme.primary, CircleShape).padding(horizontal = 6.dp, vertical = 2.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (c.unread > 99) "99+" else c.unread.toString(), color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
    HorizontalDivider(Modifier.padding(start = 72.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
}

@Composable
fun ConnectionBanner(status: ConnectionStatus) {
    if (status == ConnectionStatus.ONLINE) return
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Text(
            stringResource(if (status == ConnectionStatus.CONNECTING) R.string.conn_connecting else R.string.conn_offline),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp).testTag("connBanner"),
        )
    }
}
