package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
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
import androidx.compose.ui.semantics.selected
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


@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(workspaceFilter: String?, onClearFilter: () -> Unit, onOpen: (String) -> Unit, onShortcut: (String) -> Unit, onNewChat: () -> Unit = {}, onIssuesOf: (String) -> Unit = {}, onDetails: (String) -> Unit = {}) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val state by client.state.collectAsStateWithLifecycle()
    val originalData = state.data ?: return
    // Bootstrap previews do not expose their author. Hide them in shared chats
    // containing a blocked participant; full conversations filter by author.
    val data = remember(originalData, state.blockedUserIds) {
        originalData.copy(conversations = originalData.conversations.map { c ->
            if (c.memberIds.any { it in state.blockedUserIds }) c.copy(lastMessagePreview = "", lastHumanPreview = null) else c
        })
    }
    var query by rememberSaveable { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    val internalFallback = stringResource(R.string.internal_default)
    val convFallback = stringResource(R.string.conversation)
    val directs = stringResource(R.string.direct_messages)

    val container = LocalContainer.current
    var collapsed by remember { mutableStateOf(container.settings.collapsed) }
    fun toggle(key: String) { collapsed = if (key in collapsed) collapsed - key else collapsed + key; container.settings.collapsed = collapsed }
    var tab by remember { mutableStateOf(runCatching { com.tiecoms.app.core.HomeTree.Tab.valueOf(container.settings.homeTab) }.getOrDefault(com.tiecoms.app.core.HomeTree.Tab.ALL)) }
    val counts = remember(data) { com.tiecoms.app.core.HomeTree.counts(data) }
    val rows = remember(data, query, workspaceFilter, collapsed, tab) {
        com.tiecoms.app.core.HomeTree.build(data, query, workspaceFilter, collapsed, { Names.conversationTitle(it, data, internalFallback, convFallback) }, tab = tab)
    }
    var newSpace by rememberSaveable { mutableStateOf(false) }
    var menuFor by remember { mutableStateOf<ConversationDTO?>(null) }
    var menuKey by remember { mutableStateOf<String?>(null) }
    var wsMenu by remember { mutableStateOf<WorkspaceDTO?>(null) }
    var meetingFor by remember { mutableStateOf<String?>(null) }
    var remindFor by remember { mutableStateOf<ConversationDTO?>(null) }
    var leaveFor by remember { mutableStateOf<ConversationDTO?>(null) }
    val dueReminders = state.reminders.count { r -> parseInstant(r.remindAt)?.isAfter(java.time.Instant.now()) == false }
    val filterWs = workspaceFilter?.let { id -> data.workspaces.firstOrNull { it.id == id } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.conversations), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                actions = {
                    IconButton(onClick = onNewChat, modifier = Modifier.testTag("newChat")) { Icon(Icons.Filled.Edit, stringResource(R.string.chat_new)) }
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
            HomeTabs(tab, counts) { tab = it; container.settings.homeTab = it.name }
            // Accesos: recordatorios, trazo y WhatsApp (desde Inicio, como pide la SPEC-v2).
            androidx.compose.foundation.lazy.LazyRow(
                horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
                modifier = Modifier.padding(vertical = 4.dp).testTag("shortcuts"),
            ) {
                item { androidx.compose.material3.AssistChip(onClick = { onShortcut("reminders") }, label = { Text("⏰ " + stringResource(R.string.rem_title) + if (dueReminders > 0) " · $dueReminders" else "") }, modifier = Modifier.testTag("shortcutReminders")) }
                item { androidx.compose.material3.AssistChip(onClick = { onShortcut("trazo") }, label = { Text("⑂ " + stringResource(R.string.nav_trazo)) }) }
                item { androidx.compose.material3.AssistChip(onClick = { onShortcut("files") }, label = { Text("📁 " + stringResource(R.string.nav_files)) }, modifier = Modifier.testTag("shortcutFiles")) }
                item { androidx.compose.material3.AssistChip(onClick = { onShortcut("whatsapp") }, label = { Text("🟢 " + stringResource(R.string.nav_whatsapp)) }, modifier = Modifier.testTag("shortcutWhatsApp")) }
            }
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
                            // Al cambiar el orden (llega un no leído), la fila se desliza a su lugar en vez de saltar.
                            Box(Modifier.animateItem()) { when (row) {
                                is com.tiecoms.app.core.HomeTree.Section -> SectionRow(row.kind, onAdd = when (row.kind) {
                                    com.tiecoms.app.core.HomeTree.Kind.COMPANIES -> ({ newSpace = true })
                                    com.tiecoms.app.core.HomeTree.Kind.CHATS -> onNewChat
                                    else -> null
                                })
                                is com.tiecoms.app.core.HomeTree.Org -> OrgRow(row) { toggle(com.tiecoms.app.core.HomeTree.orgKey(row.org)) }
                                is com.tiecoms.app.core.HomeTree.Ws -> WsRow(row, inPinned = row.key.startsWith("pw:"), onToggle = { toggle(com.tiecoms.app.core.HomeTree.wsKey(row.ws)) }, onLongPress = { wsMenu = row.ws }, onOpen = { onShortcut("home?ws=" + row.ws.id) })
                                is com.tiecoms.app.core.HomeTree.Conv -> ConversationRow(row.c, data, internalFallback, convFallback, depth = row.depth, inChats = row.c.isChat || row.pinnedSection,
                                    menuOpen = menuFor?.id == row.c.id && menuKey == row.key,
                                    menuItems = { conversationMenu(ctx, row.c, data, onMeeting = { meetingFor = row.c.id }, onRemindCustom = { remindFor = row.c }, onLeave = { leaveFor = row.c }, onOpen = { onOpen(row.c.id) }) + listOf(null, SheetItem(ctx.getString(R.string.details_short), "ⓘ", tag = "menuDetails") { onDetails(row.c.id) }) },
                                    onDismissMenu = { menuFor = null },
                                    onLongPress = { menuFor = row.c; menuKey = row.key }, onIssues = { onIssuesOf(row.c.id) }) { onOpen(row.c.id) }
                                is com.tiecoms.app.core.HomeTree.Empty -> if (row.kind == com.tiecoms.app.core.HomeTree.Kind.FILTER) Text(
                                    stringResource(when (tab) {
                                        com.tiecoms.app.core.HomeTree.Tab.UNREAD -> R.string.home_tab_caught_up
                                        com.tiecoms.app.core.HomeTree.Tab.ISSUES -> R.string.home_empty_issues
                                        com.tiecoms.app.core.HomeTree.Tab.CHATS -> R.string.home_empty_chats
                                        com.tiecoms.app.core.HomeTree.Tab.SIDES -> R.string.home_empty_sides
                                        com.tiecoms.app.core.HomeTree.Tab.ALL -> R.string.home_empty_all
                                    }),
                                    textAlign = TextAlign.Center, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp).testTag("tabEmpty"),
                                ) else Text(
                                    stringResource(if (row.kind == com.tiecoms.app.core.HomeTree.Kind.CHATS) R.string.chat_new else R.string.side_empty),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.fillMaxWidth().clickable { if (row.kind == com.tiecoms.app.core.HomeTree.Kind.CHATS) onNewChat() else newSpace = true }.padding(horizontal = 20.dp, vertical = 10.dp),
                                )
                            } }
                        }
                        item { Spacer(Modifier.heightIn(min = 24.dp)) }
                    }
                }
            }
        }
    }
    if (newSpace) NewSpaceDialog(onClose = { newSpace = false }, onCreated = { onShortcut("home?ws=$it") })
    HomeMenus(data, menuFor, wsMenu, meetingFor, remindFor, leaveFor, { menuFor = it }, { wsMenu = it }, { meetingFor = it }, { remindFor = it }, { leaveFor = it }, onOpen)
}

@Composable
private fun HomeMenus(
    data: BootstrapDTO, menuFor: ConversationDTO?, wsMenu: WorkspaceDTO?, meetingFor: String?, remindFor: ConversationDTO?, leaveFor: ConversationDTO?,
    setMenu: (ConversationDTO?) -> Unit, setWs: (WorkspaceDTO?) -> Unit, setMeeting: (String?) -> Unit, setRemind: (ConversationDTO?) -> Unit, setLeave: (ConversationDTO?) -> Unit,
    onOpen: (String) -> Unit,
) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    wsMenu?.let { ws ->
        val pinned = ws.pinnedAt != null
        ActionSheet(ws.name, listOf(
            SheetItem(ctx.getString(if (pinned) R.string.menu_unpin_top else R.string.menu_pin_top), "📌") {
                container.scope.launch { runCatching { client.setWorkspacePinned(ws.id, !pinned) }.onFailure { container.toast(errorText(ctx, it)) } }
            },
            SheetItem(ctx.getString(R.string.menu_copy_link), "⛓") { copyToClipboard(ctx, "https://app.tiecoms.com/w/${ws.id}"); container.toast(ctx.getString(R.string.toast_link_copied)) },
        )) { setWs(null) }
    }
    meetingFor?.let { EventDialog(it, onClose = { setMeeting(null) }) }
    remindFor?.let { ReminderDialog(it, null, onClose = { setRemind(null) }) }
    leaveFor?.let { c ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { setLeave(null) }, text = { Text(stringResource(R.string.chat_leave_confirm)) },
            confirmButton = { androidx.compose.material3.TextButton(onClick = {
                setLeave(null)
                container.scope.launch { runCatching { client.removeMember(c.id, data.me.id) }.onFailure { container.toast(errorText(ctx, it)) } }
            }) { Text(stringResource(R.string.menu_leave)) } },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { setLeave(null) }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun SectionRow(kind: com.tiecoms.app.core.HomeTree.Kind, onAdd: (() -> Unit)?) {
    val title = stringResource(when (kind) {
        com.tiecoms.app.core.HomeTree.Kind.PINNED -> R.string.side_pinned
        com.tiecoms.app.core.HomeTree.Kind.COMPANIES -> R.string.side_companies
        com.tiecoms.app.core.HomeTree.Kind.CHATS, com.tiecoms.app.core.HomeTree.Kind.FILTER -> R.string.side_chats
    })
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 16.dp).testTag("section-" + kind.name), verticalAlignment = Alignment.CenterVertically) {
        SectionHeader((if (kind == com.tiecoms.app.core.HomeTree.Kind.PINNED) "📌 " else "") + title, Modifier.weight(1f).semantics { heading() })
        if (onAdd != null) IconButton(onClick = onAdd, modifier = Modifier.testTag("add-" + kind.name)) {
            Icon(Icons.Filled.Add, stringResource(if (kind == com.tiecoms.app.core.HomeTree.Kind.CHATS) R.string.chat_new else R.string.side_new_space))
        }
    }
}

@Composable
private fun UnreadPill(n: Int, color: Color, fg: Color) {
    if (n <= 0) return
    Box(Modifier.widthIn(min = 22.dp).background(color, CircleShape).padding(horizontal = 6.dp, vertical = 2.dp), contentAlignment = Alignment.Center) {
        Text(if (n > 99) "99+" else n.toString(), color = fg, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}

/** Empresa: su marca y nombre en negrita; se colapsa (con el total de no leídos cuando está colapsada). */
@Composable
private fun OrgRow(row: com.tiecoms.app.core.HomeTree.Org, onToggle: () -> Unit) {
    val name = row.org?.name ?: stringResource(R.string.common_no_company)
    val state = stringResource(if (row.collapsed) R.string.expand else R.string.collapse)
    Row(
        Modifier.fillMaxWidth().clickable(onClickLabel = state, onClick = onToggle).heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 6.dp)
            .semantics(mergeDescendants = true) { heading() }.testTag("org-" + (row.org?.id ?: "none")),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrgMark(row.org, size = 22.dp)
        Spacer(Modifier.width(10.dp))
        Text(name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (row.collapsed) UnreadPill(row.unread, Color(com.tiecoms.app.core.Contrast.badgeBackground(row.org?.colorBg)), Color.White)
        Icon(if (row.collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Espacio (tema): gris semibold con la línea de sangría; tocar abre el espacio, la flecha lo colapsa. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun WsRow(row: com.tiecoms.app.core.HomeTree.Ws, inPinned: Boolean, onToggle: () -> Unit, onLongPress: () -> Unit, onOpen: () -> Unit) {
    val state = stringResource(if (row.collapsed) R.string.expand else R.string.collapse)
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = if (inPinned) onOpen else onToggle, onLongClick = onLongPress, onClickLabel = if (inPinned) null else state)
            .heightIn(min = 40.dp).padding(start = if (inPinned) 16.dp else 27.dp, end = 16.dp).testTag("ws-" + row.ws.id),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!inPinned) Box(Modifier.width(2.dp).heightIn(min = 40.dp).background(MaterialTheme.colorScheme.outlineVariant))
        Spacer(Modifier.width(10.dp))
        Text((if (row.ws.pinnedAt != null) "📌 " else "") + row.ws.name, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (!inPinned) {
            if (row.collapsed) UnreadPill(row.unread, Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), Color.White)
            Icon(if (row.collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ConversationRow(
    c: ConversationDTO, data: BootstrapDTO, internalFallback: String, convFallback: String, depth: Int, inChats: Boolean,
    menuOpen: Boolean, menuItems: () -> List<SheetItem?>, onDismissMenu: () -> Unit, onLongPress: () -> Unit, onIssues: () -> Unit, onClick: () -> Unit,
) {
    val ctx = LocalContext.current
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val title = Names.conversationTitle(c, data, internalFallback, convFallback)
    // SPEC-v4 §C: se prefiere el último mensaje de una persona (lastHumanPreview) sobre los de sistema.
    val human = c.lastHumanPreview?.let { h ->
        val text = com.tiecoms.app.core.Attachments.preview(h.attachments, h.body, attLabels(ctx))
        if (text.isBlank()) null
        else if (c.kind == "direct" || h.authorId.isBlank()) text
        else (if (h.authorId == data.me.id) stringResource(R.string.common_you_short) else Names.person(data, h.authorId)?.name?.substringBefore(' ') ?: "") .let { a -> if (a.isBlank()) text else "$a: $text" }
    }
    val preview = (human ?: c.lastMessagePreview)?.takeIf { it.isNotEmpty() }?.let { if (it.startsWith("{")) systemText(ctx, it) else it } ?: stringResource(R.string.no_messages)
    val time = relativeTime(ctx, c.lastMessageAt)
    val ws = data.workspaces.firstOrNull { it.id == c.workspaceId }
    val org = if (ws != null) com.tiecoms.app.core.HomeTree.counterpartOrg(data, ws) else null
    val unreadText = if (c.unread > 0) pluralStringResource(R.plurals.unread_count, c.unread, c.unread) else null
    val internalCd = stringResource(R.string.internal_cd)
    val muted = c.mutedAt(System.currentTimeMillis())
    val mutedCd = stringResource(R.string.side_muted)
    val a11y = listOfNotNull(title, if (c.kind == "internal") internalCd else null, if (muted) mutedCd else null, preview, time, unreadText).joinToString(". ")
    val indent = when { inChats && depth == 0 -> 16.dp; else -> (40 + depth * 20).dp }
    Box {
        Row(
            Modifier.fillMaxWidth()
                .background(if (menuOpen) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                .combinedClickable(onClick = onClick, onLongClick = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); onLongPress() },
                    onLongClickLabel = stringResource(R.string.menu_more))
                .heightIn(min = 56.dp).padding(start = indent, end = 16.dp, top = 6.dp, bottom = 6.dp)
                .semantics(mergeDescendants = true) { contentDescription = a11y }.testTag("conv-${c.id}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ConversationIcon(c, data, if (inChats && depth == 0) 40.dp else 28.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        title, style = if (inChats && depth == 0) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        fontWeight = if (c.unread > 0 && !muted) FontWeight.Bold else FontWeight.Medium, modifier = Modifier.weight(1f, fill = false),
                    )
                    if (muted) Text(" 🔕", style = MaterialTheme.typography.labelMedium)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(preview, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false))
                    if (time.isNotEmpty()) Text(" · $time", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                if (c.openIssues > 0) {
                    val label = if (c.openIssues == 1) stringResource(R.string.issues_count_one) else stringResource(R.string.issues_count, c.openIssues)
                    Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(top = 2.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(10.dp)).clickable(onClick = onIssues)
                            .padding(horizontal = 8.dp, vertical = 2.dp).testTag("issuesChip-${c.id}"))
                }
            }
            Spacer(Modifier.width(8.dp))
            // Color de la empresa solo si el número blanco pasa AA (4,5:1); si no, naranja sobrio (SPEC-v4 §C).
            UnreadPill(c.unread, Color(if (muted) com.tiecoms.app.core.Contrast.MUTED else com.tiecoms.app.core.Contrast.badgeBackground(org?.colorBg)), Color.White)
        }
        AnchoredMenu(menuOpen, if (menuOpen) menuItems() else emptyList(), onDismissMenu)
    }
}

/** Ícono de la conversación: foto del grupo, # grupo, candado interno, ◆ directivo, ⑂ derivada, 💬 lateral o las caras del chat. */
@Composable
fun ConversationIcon(c: ConversationDTO, data: BootstrapDTO, size: androidx.compose.ui.unit.Dp) {
    when {
        c.avatarUrl != null -> Avatar(Names.conversationTitle(c, data, "", ""), MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant, size = size, square = c.kind != "multi", photo = c.avatarUrl)
        c.kind == "direct" -> PersonAvatar(Names.otherInDirect(c, data), data, size)
        c.isSide -> GlyphBox("💬", size)
        c.kind == "multi" -> StackedAvatars(c, data, size)
        c.parentId != null -> GlyphBox("⑂", size)
        c.kind == "internal" -> Box(Modifier.size(size).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Lock, null, Modifier.size(size * 0.5f), tint = MaterialTheme.colorScheme.primary)
        }
        c.level == "directivo" -> GlyphBox("◆", size)
        else -> GlyphBox("#", size)
    }
}

@Composable
private fun GlyphBox(g: String, size: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(size).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(8.dp)).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        Text(g, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, fontSize = with(androidx.compose.ui.platform.LocalDensity.current) { (size * 0.5f).toSp() })
    }
}

@Composable
internal fun NewSpaceDialog(onClose: () -> Unit, onCreated: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var dept by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    FormSheet(stringResource(R.string.dlg_new_space), onClose, tag = "newSpaceDialog") {
        Text(stringResource(R.string.dlg_new_space_body), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(name, { name = it.take(120) }, label = { Text(stringResource(R.string.dlg_space_name)) }, placeholder = { Text(stringResource(R.string.dlg_space_name_ph)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("spaceName"))
        OutlinedTextField(dept, { dept = it.take(160) }, label = { Text(stringResource(R.string.dlg_department)) }, placeholder = { Text(stringResource(R.string.dlg_department_ph)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.dlg_create_space), enabled = !busy && name.trim().length >= 2, confirmTag = "createSpace") {
            busy = true; error = null
            scope.launch {
                try { val r = client.createWorkspace(name, dept); onClose(); onCreated(r.id) } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }
    }
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

/** Pestañas grandes tipo «pill» bajo el buscador: Todo · No leídos · Asuntos · Chats · Laterales, con contador. */
@Composable
private fun HomeTabs(tab: com.tiecoms.app.core.HomeTree.Tab, counts: Map<com.tiecoms.app.core.HomeTree.Tab, Int>, onPick: (com.tiecoms.app.core.HomeTree.Tab) -> Unit) {
    val labels = mapOf(
        com.tiecoms.app.core.HomeTree.Tab.ALL to R.string.home_tab_all, com.tiecoms.app.core.HomeTree.Tab.UNREAD to R.string.home_tab_unread,
        com.tiecoms.app.core.HomeTree.Tab.ISSUES to R.string.home_tab_issues, com.tiecoms.app.core.HomeTree.Tab.CHATS to R.string.home_tab_chats,
        com.tiecoms.app.core.HomeTree.Tab.SIDES to R.string.home_tab_sides,
    )
    androidx.compose.foundation.lazy.LazyRow(
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
        modifier = Modifier.padding(vertical = 6.dp).testTag("homeTabs"),
    ) {
        items(com.tiecoms.app.core.HomeTree.Tab.entries.toList()) { t ->
            val on = t == tab
            val n = counts[t] ?: 0
            val label = stringResource(labels.getValue(t))
            androidx.compose.material3.Surface(
                onClick = { onPick(t) },
                shape = CircleShape,
                color = if (on) MaterialTheme.colorScheme.inverseSurface else MaterialTheme.colorScheme.surfaceContainerHigh,
                contentColor = if (on) MaterialTheme.colorScheme.inverseOnSurface else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.heightIn(min = 44.dp).semantics { selected = on; contentDescription = "$label, $n" }.testTag("tab-" + t.name),
            ) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    if (t != com.tiecoms.app.core.HomeTree.Tab.ALL && n > 0) {
                        Spacer(Modifier.width(8.dp))
                        Text(n.toString(), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold,
                            color = if (on) MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.8f) else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
