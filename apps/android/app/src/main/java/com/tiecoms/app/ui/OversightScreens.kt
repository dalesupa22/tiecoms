package com.tiecoms.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.OversightDTO
import com.tiecoms.app.core.OversightGroupDTO
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Supervisión de una empresa (solo owner/admin, docs/GRUPOS.md): los grupos donde está su gente, por espacio.
 * Cada fila: nombre, avatares de mi gente, última actividad y «Solo lectura» si no soy miembro.
 */
@Composable
fun OversightScreen(orgId: String, onBack: () -> Unit, onOpen: (String) -> Unit, onReadOnly: (conversationId: String, name: String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val data = client.state.collectAsStateWithLifecycle().value.data
    val org = Names.org(data, orgId)
    var result by remember { mutableStateOf<OversightDTO?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(orgId, reload) {
        error = null
        try { result = client.oversight(orgId) } catch (e: Exception) { error = errorText(ctx, e) }
    }
    val fallback = stringResource(R.string.conversation)
    SimpleScaffold(title = stringResource(R.string.ov_title, org?.name ?: ""), onBack = onBack) {
        val r = result
        when {
            r == null && error == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            r == null -> Column(Modifier.padding(24.dp)) { ErrorText(error); Button(onClick = { reload++ }) { Text(stringResource(R.string.retry)) } }
            r.groups.isEmpty() -> EmptyNote(stringResource(R.string.ov_empty), Modifier.testTag("oversightEmpty"))
            else -> LazyColumn(Modifier.fillMaxSize().testTag("oversightList")) {
                // Agrupada por espacio, en el orden del API (actividad más reciente primero).
                r.groups.groupBy { it.workspaceId }.forEach { (wsId, list) ->
                    item(key = "w:$wsId") {
                        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            val other = list.first().organizationIds.firstOrNull { it != orgId }
                            OrgMark(Names.org(data, other ?: list.first().owningOrgId), size = 20.dp)
                            Spacer(Modifier.width(8.dp))
                            SectionHeader(list.first().workspaceName, Modifier.semantics { heading() })
                        }
                    }
                    items(list, key = { it.conversationId }) { g ->
                        OversightRow(g, fallback) {
                            val mine = data?.conversations?.any { it.id == g.conversationId } == true
                            if (g.iAmMember && mine) onOpen(g.conversationId) else onReadOnly(g.conversationId, g.name ?: fallback)
                        }
                    }
                }
                item { Spacer(Modifier.heightIn(min = 24.dp)) }
            }
        }
    }
}

@Composable
private fun OversightRow(g: OversightGroupDTO, fallback: String, onClick: () -> Unit) {
    val ctx = LocalContext.current
    val data = LocalClient.current.state.collectAsStateWithLifecycle().value.data
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 60.dp).padding(horizontal = 16.dp, vertical = 8.dp).testTag("oversight-${g.conversationId}"),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text((if (g.kind == "internal") "🔒 " else "# ") + (g.name ?: fallback), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (!g.iAmMember) {
                    Spacer(Modifier.width(6.dp))
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(8.dp)) {
                        Text(stringResource(R.string.ov_read_only), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).testTag("readOnlyTag-${g.conversationId}"))
                    }
                }
            }
            Text(listOf(stringResource(R.string.ov_members, g.memberCount), relativeTime(ctx, g.lastMessageAt)).filter { it.isNotBlank() }.joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // Avatares de mi gente en el grupo (hasta 4, solapados).
        Box {
            g.myOrgMemberIds.take(4).forEachIndexed { i, id ->
                PersonAvatar(Names.person(data, id), data, size = 26.dp, modifier = Modifier.offset(x = (i * 16).dp))
            }
            Spacer(Modifier.width((26 + (g.myOrgMemberIds.take(4).size - 1).coerceAtLeast(0) * 16).dp))
        }
    }
}

/**
 * Visor de solo lectura para un grupo donde no soy miembro (supervisión de administrador): GET
 * /conversations/:id/messages paginado como siempre, sin compositor y con la franja «Solo lectura».
 */
@Composable
fun ReadOnlyGroupScreen(conversationId: String, name: String, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val state by client.state.collectAsStateWithLifecycle()
    val data = state.data ?: return
    var messages by remember { mutableStateOf(listOf<MessageDTO>()) }
    var hasMore by remember { mutableStateOf(true) }
    var loading by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val listState = rememberLazyListState()
    fun loadOlder() {
        if (loading || !hasMore || !loaded) return
        val before = messages.firstOrNull()?.seq ?: return
        loading = true
        scope.launch {
            try {
                val page = client.readOnlyMessages(conversationId, before)
                val known = messages.map { it.id }.toSet()
                messages = (page.messages.filter { it.id !in known } + messages).sortedBy { it.seq }; hasMore = page.hasMore
            } catch (_: Exception) {} finally { loading = false }
        }
    }
    LaunchedEffect(conversationId, reload) {
        error = null; loading = true
        try {
            val page = client.readOnlyMessages(conversationId)
            messages = page.messages.sortedBy { it.seq }; hasMore = page.hasMore; loaded = true
        } catch (e: Exception) { error = errorText(ctx, e) } finally { loading = false }
    }
    LaunchedEffect(listState) {
        snapshotFlow { (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) to listState.layoutInfo.totalItemsCount }
            .distinctUntilChanged().collect { (last, total) -> if (total > 0 && last >= total - 3) loadOlder() }
    }
    val items = remember(messages, hasMore, loading) { buildItems(messages.filter { it.authorId !in state.blockedUserIds }, emptyList(), data.me.id, hasMore, loading, false) }
    SimpleScaffold(title = name, onBack = onBack) {
        Surface(color = Color(0xFFFFEBCC), modifier = Modifier.fillMaxWidth()) {
            Text("👁 " + stringResource(R.string.ov_banner), color = Color(0xFF7A4100), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).testTag("readOnlyBanner"))
        }
        Box(Modifier.weight(1f).fillMaxWidth().navigationBarsPadding()) {
            when {
                !loaded && error != null -> Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    ErrorText(error); Button(onClick = { reload++ }) { Text(stringResource(R.string.retry)) }
                }
                !loaded -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                items.isEmpty() -> Text(stringResource(R.string.no_messages), Modifier.align(Alignment.Center), color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize().testTag("readOnlyMessages"),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
                    items(items, key = { it.key }) { item ->
                        when (item) {
                            is ChatItem.Day -> DaySeparator(dayText(ctx, item.date))
                            is ChatItem.Msg -> if (item.m.kind == "system") SystemRow(item.m, data, emptyMap(), { _, _ -> }, {}, {})
                            else MessageBubble(item, data, quoted = item.m.replyTo?.let { r -> messages.firstOrNull { it.id == r } }, pinnedHere = false, highlighted = false, issue = null,
                                showAvatars = true, menuOpen = false, menuItems = { emptyList() }, onDismissMenu = {}, onLongPress = {},
                                onQuote = {}, onIssue = {}, onOpenConversation = { _, _ -> }, onVoiceIssue = null)
                            is ChatItem.Pending -> Unit
                            ChatItem.LateJoin -> Unit
                            ChatItem.Older -> Notice(stringResource(R.string.loading_older))
                        }
                    }
                }
            }
        }
    }
}
