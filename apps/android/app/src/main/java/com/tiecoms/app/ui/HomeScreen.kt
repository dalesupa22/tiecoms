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
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConnectionStatus
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.GroupsTree
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.OrganizationDTO
import com.tiecoms.app.core.WorkspaceDTO
import kotlinx.coroutines.launch

/** Snapshot con las vistas previas ocultas en chats con alguien bloqueado (el snapshot no trae el autor). */
@Composable
private fun visibleData(): Pair<BootstrapDTO, com.tiecoms.app.core.ClientState>? {
    val state by LocalClient.current.state.collectAsStateWithLifecycle()
    val originalData = state.data ?: return null
    val data = remember(originalData, state.blockedUserIds) {
        originalData.copy(conversations = originalData.conversations.map { c ->
            if (c.memberIds.any { it in state.blockedUserIds }) c.copy(lastMessagePreview = "", lastHumanPreview = null) else c
        })
    }
    return data to state
}

/** Hojas y menús que se abren desde Grupos (el «+», invitar, compartir el enlace). */
private sealed interface GroupsDialog {
    data class NewGroup(val preset: NewGroupPreset) : GroupsDialog
    data class Invite(val target: InviteTarget) : GroupsDialog
    data class Share(val groupName: String, val url: String, val code: String?, val expiresAt: String?, val conversationId: String) : GroupsDialog
    data class Header(val row: GroupsTree.Row) : GroupsDialog
    data class NewIssue(val conversationId: String) : GroupsDialog
    data object JoinCode : GroupsDialog
}

// ---------- Pestaña Grupos ----------
/**
 * Grupos (docs/GRUPOS.md): Tu organización · X, Relaciones e Invitado en, con los asuntos abiertos bajo cada
 * grupo. Los filtros de Inicio siguen (Todo · No leídos · Asuntos · @ Menciones); Chats y Laterales viven en DMs.
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun GroupsScreen(
    workspaceFilter: String?, onClearFilter: () -> Unit, onOpen: (String) -> Unit,
    onIssuesOf: (String) -> Unit, onOpenIssue: (String) -> Unit, onDetails: (String) -> Unit, onMentions: () -> Unit, onJoinCode: (String) -> Unit,
) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val (data, state) = visibleData() ?: return
    var query by rememberSaveable { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    val internalFallback = stringResource(R.string.internal_default)
    val convFallback = stringResource(R.string.conversation)
    val container = LocalContainer.current
    var collapsed by remember { mutableStateOf(container.settings.collapsed) }
    fun setCollapsed(v: Set<String>) { collapsed = v; container.settings.collapsed = v }
    fun toggle(key: String) = setCollapsed(if (key in collapsed) collapsed - key else collapsed + key)
    var tab by remember { mutableStateOf(runCatching { GroupsTree.Tab.valueOf(container.settings.homeTab) }.getOrDefault(GroupsTree.Tab.ALL)) }
    val issues = state.issues.values
    val counts = remember(data, state.issues) { GroupsTree.counts(data, issues) }
    val rows = remember(data, state.issues, query, workspaceFilter, collapsed, tab) {
        GroupsTree.build(data, issues, query, workspaceFilter, collapsed, { Names.conversationTitle(it, data, internalFallback, convFallback) }, tab = tab)
    }
    var dialog by remember { mutableStateOf<GroupsDialog?>(null) }
    var menuKey by remember { mutableStateOf<String?>(null) }
    var meetingFor by remember { mutableStateOf<String?>(null) }
    var remindFor by remember { mutableStateOf<ConversationDTO?>(null) }
    var leaveFor by remember { mutableStateOf<ConversationDTO?>(null) }
    var archiveFor by remember { mutableStateOf<ConversationDTO?>(null) }
    val filterWs = workspaceFilter?.let { id -> data.workspaces.firstOrNull { it.id == id } }
    val myOrg = Names.org(data, data.me.primaryOrgId)
    /** Grupo cuyos asuntos se acaban de desplegar: solo esos entran animados (no al volver a verlos con scroll). */
    var justExpanded by remember { mutableStateOf<String?>(null) }
    fun toggleIssues(conversationId: String) {
        val k = GroupsTree.issuesKey(conversationId)
        justExpanded = if (k in collapsed) null else conversationId
        toggle(k)
    }
    var overflow by remember { mutableStateOf(false) }
    /** Plegar todo · Expandir todo · Mostrar / Contraer todos los asuntos (menú ⋮ y pulsación larga de las cabeceras). */
    fun foldItems(): List<SheetItem?> {
        val issueKeys = GroupsTree.allIssueKeys(data, issues)
        val shown = issueKeys.count { it in collapsed }
        return listOfNotNull(
            SheetItem(ctx.getString(R.string.menu_fold_all), "▸", tag = "menuFoldAll") { justExpanded = null; setCollapsed(GroupsTree.foldAll(collapsed, data)) },
            SheetItem(ctx.getString(R.string.menu_expand_all), "▾", tag = "menuExpandAll") { justExpanded = null; setCollapsed(GroupsTree.expandAll(collapsed, data, issues)) },
            if (issueKeys.isNotEmpty() && shown < issueKeys.size) SheetItem(ctx.getString(R.string.menu_show_all_issues), "◆", tag = "menuShowAllIssues") { justExpanded = null; setCollapsed(GroupsTree.showAllIssues(collapsed, data, issues)) } else null,
            if (shown > 0) SheetItem(ctx.getString(R.string.menu_hide_all_issues), "◇", tag = "menuHideAllIssues") { setCollapsed(GroupsTree.hideAllIssues(collapsed)) } else null,
        )
    }
    val setIssueStatus = rememberIssueStatusSetter()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.nav_groups), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                actions = {
                    IconButton(onClick = { dialog = GroupsDialog.NewGroup(NewGroupPreset(company = false)) }, modifier = Modifier.testTag("newGroup")) {
                        Icon(Icons.Filled.Add, stringResource(R.string.grp_new))
                    }
                    Box {
                        IconButton(onClick = { overflow = true }, modifier = Modifier.testTag("groupsMenu")) { Icon(Icons.Filled.MoreVert, stringResource(R.string.menu_more)) }
                        AnchoredMenu(overflow, if (overflow) foldItems() else emptyList(), { overflow = false })
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(state.connection)
            SearchField(query) { query = it }
            FilterPills(
                GroupsTree.Tab.entries.map { t -> t.name to when (t) { GroupsTree.Tab.ALL -> R.string.home_tab_all; GroupsTree.Tab.UNREAD -> R.string.home_tab_unread; GroupsTree.Tab.ISSUES -> R.string.home_tab_issues } },
                tab.name, counts.mapKeys { it.key.name }, mentions = data.conversations.sumOf { it.unreadMentions }, onMentions = onMentions,
            ) { tab = GroupsTree.Tab.valueOf(it); container.settings.homeTab = it }
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
                        try { client.loadBootstrap(); runCatching { client.loadOpenIssues() } } catch (e: Exception) { snackbar.showSnackbar(errorText(ctx, e)) } finally { refreshing = false }
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(Modifier.fillMaxSize().testTag("conversationList")) {
                    items(rows, key = { it.key }) { row ->
                        // Al cambiar el orden (llega un no leído), la fila se desliza a su lugar en vez de saltar.
                        Box(Modifier.animateItem()) { when (row) {
                            is GroupsTree.Section -> SectionRow(row, myOrg,
                                onToggle = if (row.kind == GroupsTree.Kind.PINNED) null else ({ toggle(sectionKeyOf(row)) }),
                                onAdd = when (row.kind) {
                                    GroupsTree.Kind.ORG -> ({ dialog = GroupsDialog.NewGroup(NewGroupPreset(company = false)) })
                                    GroupsTree.Kind.RELATIONS -> ({ dialog = GroupsDialog.NewGroup(NewGroupPreset(company = true)) })
                                    else -> null
                                },
                                onLongPress = if (row.kind == GroupsTree.Kind.ORG || row.kind == GroupsTree.Kind.RELATIONS) ({ dialog = GroupsDialog.Header(row) }) else null)
                            is GroupsTree.Company -> CompanyRow(row, onToggle = { toggle(GroupsTree.companyKey(row.kind, row.id)) }, onLongPress = { dialog = GroupsDialog.Header(row) })
                            is GroupsTree.Group -> {
                                val ws = data.workspaces.firstOrNull { it.id == row.c.workspaceId }
                                val guest = ws?.myRole == "guest"
                                ConversationRow(row.c, data, internalFallback, convFallback,
                                    indent = if (row.pinnedSection) 16.dp else (16 + row.level * 20).dp, iconSize = 32.dp, showIssuesChip = row.pinnedSection,
                                    issuesFold = if (row.pinnedSection || row.issueCount <= 0) null
                                        else IssuesFold(row.issueCount, row.overdueCount, row.issuesExpanded) { toggleIssues(row.c.id) },
                                    titleOverride = row.label, threadUnread = row.threadUnread,
                                    tagLine = if (row.c.kind == "internal") stringResource(R.string.grp_internal_only, Names.org(data, row.c.internalOrgId ?: ws?.owningOrgId)?.name ?: "") else null,
                                    menuOpen = menuKey == row.key,
                                    menuItems = {
                                        conversationMenu(ctx, row.c, data, onMeeting = { meetingFor = row.c.id }, onRemindCustom = { remindFor = row.c }, onLeave = { leaveFor = row.c }, onOpen = { onOpen(row.c.id) }) +
                                            listOfNotNull(null,
                                                if (!guest && row.c.canPost) SheetItem(ctx.getString(R.string.menu_new_issue), "◆", tag = "menuNewIssue") { dialog = GroupsDialog.NewIssue(row.c.id) } else null,
                                                if (!guest && ws != null) SheetItem(ctx.getString(R.string.menu_invite_group), "✉", tag = "menuInviteGroup") { dialog = GroupsDialog.Invite(InviteTarget.Group(ws, row.c)) } else null,
                                                SheetItem(ctx.getString(R.string.details_short), "ⓘ", tag = "menuDetails") { onDetails(row.c.id) },
                                                // Archivar (solo si puedo administrarlo), con confirmación.
                                                if (row.c.canManage) SheetItem(ctx.getString(R.string.grp_archive), "🗄", danger = true, tag = "menuArchive") { archiveFor = row.c } else null)
                                    },
                                    onDismissMenu = { menuKey = null },
                                    onLongPress = { menuKey = row.key }, onIssues = { onIssuesOf(row.c.id) }) { onOpen(row.c.id) }
                            }
                            is GroupsTree.Issue -> Unfold(row.issue.conversationId == justExpanded) {
                                IssueLine(row, menuOpen = menuKey == row.key, onLongPress = { menuKey = row.key }, onDismissMenu = { menuKey = null },
                                    menuItems = { issueQuickMenu(ctx, row.issue, onOpen = { onOpenIssue(row.issue.id) }, onStatus = { st -> setIssueStatus(row.issue, st) }) }) { onOpenIssue(row.issue.id) }
                            }
                            is GroupsTree.MoreIssues -> Unfold(row.conversationId == justExpanded) { Text(
                                pluralStringResource(R.plurals.grp_more_issues, row.count, row.count),
                                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.fillMaxWidth().clickable { onIssuesOf(row.conversationId) }.heightIn(min = 36.dp)
                                    .padding(start = (28 + row.level * 20).dp, end = 16.dp, top = 8.dp, bottom = 8.dp).testTag("moreIssues-${row.conversationId}"),
                            ) }
                            is GroupsTree.Empty -> if (row.filtered) Text(
                                stringResource(if (tab == GroupsTree.Tab.UNREAD && query.isBlank()) R.string.home_tab_caught_up else if (tab == GroupsTree.Tab.ISSUES && query.isBlank()) R.string.home_empty_issues else R.string.grp_empty_filter),
                                textAlign = TextAlign.Center, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp).testTag("tabEmpty"),
                            ) else GroupsEmpty(onNew = { dialog = GroupsDialog.NewGroup(NewGroupPreset(company = false)) }, onJoin = { dialog = GroupsDialog.JoinCode })
                        } }
                    }
                    item { Spacer(Modifier.heightIn(min = 24.dp)) }
                }
            }
        }
    }

    when (val d = dialog) {
        null -> Unit
        is GroupsDialog.NewGroup -> NewGroupSheet(d.preset, onClose = { dialog = null }, onCreated = { r, name ->
            val url = r.inviteUrl
            dialog = if (url != null) GroupsDialog.Share(name, url, r.inviteCode, null, r.conversationId) else null
            if (url == null) onOpen(r.conversationId)
        })
        is GroupsDialog.Share -> ShareInviteSheet(d.groupName, d.url, d.code, d.expiresAt, onDone = { dialog = null; onOpen(d.conversationId) })
        is GroupsDialog.Invite -> InviteSheet(d.target, onClose = { dialog = null })
        is GroupsDialog.NewIssue -> NewIssueDialog(d.conversationId, null, "", onClose = { dialog = null }, onCreated = onOpenIssue)
        GroupsDialog.JoinCode -> JoinCodeDialog(onClose = { dialog = null }, onGo = { code -> dialog = null; onJoinCode(code) })
        is GroupsDialog.Header -> HeaderMenu(data, d.row, foldItems = ::foldItems, onDismiss = { if (dialog === d) dialog = null },
            onNewGroup = { dialog = GroupsDialog.NewGroup(it) }, onInvite = { dialog = GroupsDialog.Invite(it) })
    }
    archiveFor?.let { c ->
        val name = Names.conversationTitle(c, data, internalFallback, convFallback)
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { archiveFor = null }, text = { Text(stringResource(R.string.grp_archive_confirm, name)) },
            confirmButton = { TextButton(onClick = {
                archiveFor = null
                // POST /conversations/:id/archive y refrescar el snapshot; si era el último grupo, el espacio también se archiva.
                container.scope.launch {
                    runCatching { client.archiveConversation(c.id) }
                        .onSuccess { container.toast(ctx.getString(R.string.grp_archived)) }
                        .onFailure { container.toast(errorText(ctx, it)) }
                }
            }, modifier = Modifier.testTag("confirmArchive")) { Text(stringResource(R.string.grp_archive), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { archiveFor = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
    HomeMenus(data, meetingFor, remindFor, leaveFor, { meetingFor = it }, { remindFor = it }, { leaveFor = it })
}

private fun sectionKeyOf(row: GroupsTree.Section) = GroupsTree.sectionKey(row.kind, if (row.kind == GroupsTree.Kind.ORG) row.key.removePrefix("s:ORG:") else null)

/** Menú de pulsación larga de las cabeceras: empresa o relación, y espacio (carpeta). */
@Composable
private fun HeaderMenu(
    data: BootstrapDTO, row: GroupsTree.Row, foldItems: () -> List<SheetItem?>, onDismiss: () -> Unit,
    onNewGroup: (NewGroupPreset) -> Unit, onInvite: (InviteTarget) -> Unit,
) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    when (row) {
        is GroupsTree.Section -> {
            val org = row.org
            val items = buildList<SheetItem?> {
                if (row.kind == GroupsTree.Kind.ORG) {
                    add(SheetItem(ctx.getString(R.string.menu_new_group), "#", tag = "menuNewGroup") { onNewGroup(NewGroupPreset(company = false)) })
                    if (org != null) add(SheetItem(ctx.getString(R.string.ginv_company), "✉", tag = "menuInviteCompany") { onInvite(InviteTarget.Org(org)) })
                } else add(SheetItem(ctx.getString(R.string.menu_new_group), "#", tag = "menuNewGroup") { onNewGroup(NewGroupPreset(company = true)) })
                add(null); addAll(foldItems())
            }
            ActionSheet(if (row.kind == GroupsTree.Kind.ORG) ctx.getString(R.string.grp_your_org, org?.name ?: "") else ctx.getString(R.string.grp_relations), items, onDismiss)
        }
        is GroupsTree.Company -> {
            val name = row.org?.name ?: row.pendingName ?: ctx.getString(R.string.common_no_company)
            val own = row.workspaces.filter { it.myRole != "guest" }
            val items = buildList<SheetItem?> {
                if (row.kind == GroupsTree.Kind.RELATIONS && own.isNotEmpty()) {
                    add(SheetItem(ctx.getString(R.string.menu_new_group), "#", tag = "menuNewGroup") { onNewGroup(NewGroupPreset(company = true, relationId = row.id)) })
                    add(SheetItem(ctx.getString(R.string.ginv_company), "✉", tag = "menuInviteCompany") { onInvite(InviteTarget.Space(own.first(), name)) })
                    add(null)
                }
                addAll(foldItems())
            }
            ActionSheet(name, items, onDismiss)
        }
        else -> onDismiss()
    }
}

@Composable
private fun GroupsEmpty(onNew: () -> Unit, onJoin: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp).testTag("groupsEmpty"), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.grp_empty_title), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(stringResource(R.string.grp_empty_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Button(onClick = onNew, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("emptyNewGroup")) { Text(stringResource(R.string.grp_new)) }
        OutlinedButton(onClick = onJoin, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("emptyJoinCode")) { Text(stringResource(R.string.join_title)) }
    }
}

// ---------- Pestaña DMs ----------
/** DMs: directos y chats `multi`, incluidos los sidechats (con su burbuja «Sidechat» y «desde #Grupo»). */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun DmsScreen(onOpen: (String) -> Unit, onNewMessage: () -> Unit, onDetails: (String) -> Unit, onMentions: () -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val (data, state) = visibleData() ?: return
    var query by rememberSaveable { mutableStateOf("") }
    var unreadOnly by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val internalFallback = stringResource(R.string.internal_default)
    val convFallback = stringResource(R.string.conversation)
    val list = remember(data, query, unreadOnly) { GroupsTree.dms(data, query, { Names.conversationTitle(it, data, internalFallback, convFallback) }, unreadOnly = unreadOnly) }
    val threadUnread = remember(data) { GroupsTree.threadUnread(data) }
    var menuFor by remember { mutableStateOf<String?>(null) }
    var meetingFor by remember { mutableStateOf<String?>(null) }
    var remindFor by remember { mutableStateOf<ConversationDTO?>(null) }
    var leaveFor by remember { mutableStateOf<ConversationDTO?>(null) }
    val sidechat = stringResource(R.string.dm_sidechat)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.nav_dms), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                actions = {
                    TextButton(onClick = onNewMessage, modifier = Modifier.testTag("newChat")) {
                        Icon(Icons.Filled.Edit, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.dm_new))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(state.connection)
            SearchField(query) { query = it }
            val all = data.conversations.count { GroupsTree.isDm(data, it) }
            val unread = data.conversations.count { GroupsTree.isDm(data, it) && com.tiecoms.app.core.HomeTree.pending(it, System.currentTimeMillis()) > 0 }
            FilterPills(listOf("ALL" to R.string.home_tab_all, "UNREAD" to R.string.home_tab_unread), if (unreadOnly) "UNREAD" else "ALL",
                mapOf("ALL" to all, "UNREAD" to unread), mentions = data.conversations.sumOf { it.unreadMentions }, onMentions = onMentions) { unreadOnly = it == "UNREAD" }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; try { client.loadBootstrap() } catch (e: Exception) { snackbar.showSnackbar(errorText(ctx, e)) } finally { refreshing = false } } },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(Modifier.fillMaxSize().testTag("dmList")) {
                    if (list.isEmpty()) item {
                        Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(stringResource(if (query.isNotBlank() || unreadOnly) R.string.home_empty_filter else R.string.dm_empty), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (query.isBlank() && !unreadOnly) Button(onClick = onNewMessage) { Text(stringResource(R.string.dm_new)) }
                        }
                    }
                    items(list, key = { it.id }) { c ->
                        val origin = GroupsTree.sideOrigin(data, c)
                        Box(Modifier.animateItem()) {
                            ConversationRow(c, data, internalFallback, convFallback, indent = 16.dp, iconSize = 44.dp, showIssuesChip = true,
                                badge = if (c.isSide) sidechat else null, threadUnread = threadUnread[c.id] ?: 0,
                                tagLine = origin?.let { stringResource(R.string.dm_from, Names.conversationTitle(it, data, internalFallback, convFallback)) },
                                menuOpen = menuFor == c.id,
                                menuItems = { conversationMenu(ctx, c, data, onMeeting = { meetingFor = c.id }, onRemindCustom = { remindFor = c }, onLeave = { leaveFor = c }, onOpen = { onOpen(c.id) }) + listOf(null, SheetItem(ctx.getString(R.string.details_short), "ⓘ", tag = "menuDetails") { onDetails(c.id) }) },
                                onDismissMenu = { menuFor = null }, onLongPress = { menuFor = c.id }, onIssues = {}) { onOpen(c.id) }
                        }
                    }
                    item { Spacer(Modifier.heightIn(min = 24.dp)) }
                }
            }
        }
    }
    HomeMenus(data, meetingFor, remindFor, leaveFor, { meetingFor = it }, { remindFor = it }, { leaveFor = it })
}

// ---------- Piezas compartidas ----------
@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    val searchFocus = androidx.compose.ui.platform.LocalFocusManager.current
    OutlinedTextField(
        value = query, onValueChange = onChange,
        placeholder = { Text(stringResource(R.string.search)) },
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
        trailingIcon = if (query.isNotEmpty()) { { IconButton(onClick = { onChange("") }) { Icon(Icons.Filled.Close, stringResource(R.string.clear_search)) } } } else null,
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        // La tecla «buscar» no tiene acción por defecto: sin esto el teclado se quedaría abierto.
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { searchFocus.clearFocus() }),
        shape = MaterialTheme.shapes.extraLarge,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("search"),
    )
}

@Composable
private fun HomeMenus(
    data: BootstrapDTO, meetingFor: String?, remindFor: ConversationDTO?, leaveFor: ConversationDTO?,
    setMeeting: (String?) -> Unit, setRemind: (ConversationDTO?) -> Unit, setLeave: (ConversationDTO?) -> Unit,
) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    meetingFor?.let { EventDialog(it, onClose = { setMeeting(null) }) }
    remindFor?.let { ReminderDialog(it, null, onClose = { setRemind(null) }) }
    leaveFor?.let { c ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { setLeave(null) }, text = { Text(stringResource(R.string.chat_leave_confirm)) },
            confirmButton = { TextButton(onClick = {
                setLeave(null)
                container.scope.launch { runCatching { client.removeMember(c.id, data.me.id) }.onFailure { container.toast(errorText(ctx, it)) } }
            }) { Text(stringResource(R.string.menu_leave)) } },
            dismissButton = { TextButton(onClick = { setLeave(null) }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/** Cabecera de sección: 📌 Fijados, Tu organización · X, Relaciones, Invitado en. Plegada, suma los no leídos. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun SectionRow(row: GroupsTree.Section, myOrg: OrganizationDTO?, onToggle: (() -> Unit)?, onAdd: (() -> Unit)?, onLongPress: (() -> Unit)?) {
    val title = when (row.kind) {
        GroupsTree.Kind.PINNED -> "📌 " + stringResource(R.string.side_pinned)
        GroupsTree.Kind.ORG -> stringResource(R.string.grp_your_org, (row.org ?: myOrg)?.name ?: "")
        GroupsTree.Kind.RELATIONS -> stringResource(R.string.grp_relations)
        GroupsTree.Kind.GUEST -> stringResource(R.string.grp_guest_in)
    }
    val state = stringResource(if (row.collapsed) R.string.expand else R.string.collapse)
    val base = Modifier.fillMaxWidth()
    val click = if (onToggle != null) base.combinedClickable(onClick = onToggle, onLongClick = onLongPress, onClickLabel = state) else base
    Row(click.padding(start = 16.dp, end = 4.dp, top = 12.dp).heightIn(min = 44.dp).testTag("section-" + row.key.removePrefix("s:")), verticalAlignment = Alignment.CenterVertically) {
        if (row.kind == GroupsTree.Kind.ORG) { OrgMark(row.org ?: myOrg, size = 20.dp); Spacer(Modifier.width(8.dp)) }
        SectionHeader(title, Modifier.weight(1f).semantics { heading() })
        if (row.collapsed) UnreadPill(row.unread, Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), Color.White)
        if (onAdd != null) IconButton(onClick = onAdd, modifier = Modifier.testTag("add-" + row.kind.name)) { Icon(Icons.Filled.Add, stringResource(R.string.grp_new)) }
        if (onToggle != null) Icon(if (row.collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown, null,
            Modifier.padding(end = 8.dp).size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun UnreadPill(n: Int, color: Color, fg: Color) {
    if (n <= 0) return
    Box(Modifier.widthIn(min = 22.dp).background(color, CircleShape).padding(horizontal = 6.dp, vertical = 2.dp), contentAlignment = Alignment.Center) {
        Text(if (n > 99) "99+" else n.toString(), color = fg, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}

/** Empresa (relación o anfitriona): su marca y nombre en negrita; una relación pendiente lleva «Invitación pendiente». */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun CompanyRow(row: GroupsTree.Company, onToggle: () -> Unit, onLongPress: () -> Unit) {
    val name = row.org?.name ?: row.pendingName ?: stringResource(R.string.common_no_company)
    val state = stringResource(if (row.collapsed) R.string.expand else R.string.collapse)
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClickLabel = state, onClick = onToggle, onLongClick = onLongPress).heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 6.dp)
            .semantics(mergeDescendants = true) { heading() }.testTag("org-" + row.key.removePrefix("o:")),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrgMark(row.org ?: OrganizationDTO(name = name, colorBg = "#BDB5AE"), size = 22.dp)
        Spacer(Modifier.width(10.dp))
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
        Text(name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (row.pendingName != null && row.org == null) {
            Spacer(Modifier.width(8.dp))
            Surface(color = Color(0xFFFFEBCC), shape = RoundedCornerShape(8.dp)) {
                Text(stringResource(R.string.grp_pending), color = Color(0xFF7A4100), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).testTag("pendingTag"))
            }
        }
        }
        if (row.collapsed) UnreadPill(row.unread, Color(com.tiecoms.app.core.Contrast.badgeBackground(row.org?.colorBg)), Color.White)
        Icon(if (row.collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Los asuntos que se acaban de desplegar entran con animación; los demás (scroll, recarga) aparecen tal cual. */
@Composable
private fun Unfold(animate: Boolean, content: @Composable () -> Unit) {
    val visible = remember { androidx.compose.animation.core.MutableTransitionState(!animate).apply { targetState = true } }
    androidx.compose.animation.AnimatedVisibility(visible, enter = androidx.compose.animation.expandVertically() + androidx.compose.animation.fadeIn()) { content() }
}

/** Datos del chip «◆ N asuntos · N vencidos» que pliega los asuntos de un grupo. */
internal data class IssuesFold(val count: Int, val overdue: Int, val expanded: Boolean, val onToggle: () -> Unit)

/**
 * Chip «◆ 18 · 2!» en la línea del título del grupo: pliega o despliega sus asuntos sin abrir el chat.
 * La flecha › gira hacia abajo al desplegar. TalkBack lee «18 asuntos, 2 vencidos».
 */
@Composable
private fun IssuesFoldChip(f: IssuesFold, conversationId: String) {
    val turn by androidx.compose.animation.core.animateFloatAsState(if (f.expanded) 90f else 0f, label = "issuesChevron")
    val count = pluralStringResource(R.plurals.grp_issues_chip, f.count, f.count)
    val overdue = if (f.overdue > 0) pluralStringResource(R.plurals.grp_overdue_chip, f.overdue, f.overdue) else null
    val action = stringResource(if (f.expanded) R.string.grp_issues_hide else R.string.grp_issues_show)
    val bg = if (f.expanded) MaterialTheme.colorScheme.primary.copy(alpha = 0.22f) else MaterialTheme.colorScheme.primaryContainer
    Row(
        Modifier.clip(RoundedCornerShape(10.dp)).background(bg)
            .clickable(onClickLabel = action, onClick = f.onToggle).heightIn(min = 32.dp).padding(start = 8.dp, end = 2.dp)
            .semantics(mergeDescendants = true) { contentDescription = listOfNotNull(count.removePrefix("◆ "), overdue).joinToString(", "); stateDescription = action }
            .testTag("issuesFold-$conversationId"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("◆ ${f.count}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold, maxLines = 1)
        if (f.overdue > 0) Text(" · ${f.overdue}!", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold, maxLines = 1,
            modifier = Modifier.testTag("issuesOverdue-$conversationId"))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp).rotate(turn), tint = MaterialTheme.colorScheme.primary)
    }
}

/**
 * Asunto activo bajo su grupo: «◆ título», la fecha límite (en rojo si venció) y el estado si está en curso o esperando.
 * Pulsación larga: Completar, En curso, En espera, Abrir.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun IssueLine(row: GroupsTree.Issue, menuOpen: Boolean, onLongPress: () -> Unit, onDismissMenu: () -> Unit, menuItems: () -> List<SheetItem?>, onOpen: () -> Unit) {
    val ctx = LocalContext.current
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val i = row.issue
    val f = issueFlags(i)
    Box {
    Row(
        Modifier.fillMaxWidth().background(if (menuOpen) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .combinedClickable(onClick = onOpen, onLongClick = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); onLongPress() },
                onLongClickLabel = stringResource(R.string.menu_more))
            .heightIn(min = 36.dp).padding(start = (28 + row.level * 20).dp, end = 16.dp, top = 4.dp, bottom = 4.dp)
            .semantics(mergeDescendants = true) {}.testTag("groupIssue-${i.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("◆", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
        Spacer(Modifier.width(8.dp))
        Text(i.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (i.dueDate != null) {
            Text(" · " + if (f.overdue) stringResource(R.string.issue_overdue) + " " + dueLabel(ctx, i) else if (f.dueToday) stringResource(R.string.issue_today) else dueLabel(ctx, i),
                style = MaterialTheme.typography.labelSmall, maxLines = 1,
                color = if (f.overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (i.status == "in_progress" || i.status == "waiting") { Spacer(Modifier.width(6.dp)); StatusPill(i.status) }
    }
    AnchoredMenu(menuOpen, if (menuOpen) menuItems() else emptyList(), onDismissMenu)
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
internal fun ConversationRow(
    c: ConversationDTO, data: BootstrapDTO, internalFallback: String, convFallback: String, indent: Dp, iconSize: Dp,
    menuOpen: Boolean, menuItems: () -> List<SheetItem?>, onDismissMenu: () -> Unit, onLongPress: () -> Unit, onIssues: () -> Unit,
    showIssuesChip: Boolean = true,
    /** Burbuja junto al título («Sidechat»). */
    badge: String? = null,
    /** Línea pequeña bajo el título («Solo Acme», «desde #Pagos»). */
    tagLine: String? = null,
    /** «{espacio} · {grupo}» cuando dos grupos de la empresa se llaman igual. */
    titleOverride: String? = null,
    /** No leídos de sus hilos: chip «💬 N» (los hilos no se listan en el árbol). */
    threadUnread: Int = 0,
    /** Grupos: chip que pliega sus asuntos (reemplaza al chip «◆ N asuntos» que abre la lista). */
    issuesFold: IssuesFold? = null,
    onClick: () -> Unit,
) {
    val ctx = LocalContext.current
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val title = titleOverride ?: Names.conversationTitle(c, data, internalFallback, convFallback)
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
    val a11y = listOfNotNull(title, badge, tagLine, if (c.kind == "internal") internalCd else null, if (muted) mutedCd else null, preview, time, unreadText).joinToString(". ")
    val big = iconSize >= 40.dp
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
            ConversationIcon(c, data, iconSize)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        title, style = if (big) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        fontWeight = if (c.unread > 0 && !muted) FontWeight.Bold else FontWeight.Medium, modifier = Modifier.weight(1f, fill = false),
                    )
                    if (badge != null) {
                        Spacer(Modifier.width(6.dp))
                        Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(8.dp)) {
                            Text(badge, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimaryContainer, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp).testTag("sideBadge-${c.id}"))
                        }
                    }
                    if (muted) Text(" 🔕", style = MaterialTheme.typography.labelMedium)
                    if (threadUnread > 0) {
                        Spacer(Modifier.width(6.dp))
                        Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(8.dp)) {
                            Text("💬 $threadUnread", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp).testTag("threadUnread-${c.id}"))
                        }
                    }
                    // En la misma línea del título (como la web): plegado, cada grupo ocupa su fila de siempre.
                    if (issuesFold != null) { Spacer(Modifier.width(6.dp)); IssuesFoldChip(issuesFold, c.id) }
                }
                if (tagLine != null) Text(tagLine, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(preview, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false))
                    if (time.isNotEmpty()) Text(" · $time", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                if (issuesFold == null && showIssuesChip && c.openIssues > 0) {
                    val label = if (c.openIssues == 1) stringResource(R.string.issues_count_one) else stringResource(R.string.issues_count, c.openIssues)
                    Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(top = 2.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(10.dp)).clickable(onClick = onIssues)
                            .padding(horizontal = 8.dp, vertical = 2.dp).testTag("issuesChip-${c.id}"))
                }
            }
            Spacer(Modifier.width(8.dp))
            // Color de la empresa solo si el número blanco pasa AA (4,5:1); si no, naranja sobrio (SPEC-v4 §C).
            // Badge «@» junto a los no leídos cuando me mencionaron (SPEC-v4 §H).
            if (c.unreadMentions > 0) Surface(shape = CircleShape, color = Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), modifier = Modifier.padding(end = 4.dp).testTag("mentionBadge-${c.id}")) {
                Text(stringResource(R.string.mention_badge), color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp))
            }
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
        OutlinedTextField(name, { name = it.take(120) }, label = { Text(stringResource(R.string.dlg_space_name)) }, placeholder = { Text(stringResource(R.string.dlg_space_name_ph)) }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Next), modifier = Modifier.fillMaxWidth().testTag("spaceName"))
        OutlinedTextField(dept, { dept = it.take(160) }, label = { Text(stringResource(R.string.dlg_department)) }, placeholder = { Text(stringResource(R.string.dlg_department_ph)) }, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done), modifier = Modifier.fillMaxWidth())
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

/** Pestañas grandes tipo «pill» bajo el buscador, con contador, y la pastilla «@ Menciones» que abre la bandeja. */
@Composable
private fun FilterPills(options: List<Pair<String, Int>>, selected: String, counts: Map<String, Int>, mentions: Int = 0, onMentions: () -> Unit = {}, onPick: (String) -> Unit) {
    androidx.compose.foundation.lazy.LazyRow(
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
        modifier = Modifier.padding(vertical = 6.dp).testTag("homeTabs"),
    ) {
        items(options, key = { it.first }) { (t, labelRes) ->
            val on = t == selected
            val n = counts[t] ?: 0
            val label = stringResource(labelRes)
            androidx.compose.material3.Surface(
                onClick = { onPick(t) },
                shape = CircleShape,
                color = if (on) MaterialTheme.colorScheme.inverseSurface else MaterialTheme.colorScheme.surfaceContainerHigh,
                contentColor = if (on) MaterialTheme.colorScheme.inverseOnSurface else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.heightIn(min = 44.dp).semantics { this.selected = on; contentDescription = "$label, $n" }.testTag("tab-$t"),
            ) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    if (t != "ALL" && n > 0) {
                        Spacer(Modifier.width(8.dp))
                        Text(n.toString(), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold,
                            color = if (on) MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.8f) else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        item(key = "mentions") {
            // «@ Menciones» abre la bandeja (GET /mentions).
            val label = stringResource(R.string.mention_tab)
            androidx.compose.material3.Surface(onClick = onMentions, shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier.heightIn(min = 44.dp).semantics { contentDescription = "$label, $mentions" }.testTag("tab-MENTIONS")) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("@ $label", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    if (mentions > 0) { Spacer(Modifier.width(8.dp)); Text(mentions.toString(), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE)) }
                }
            }
        }
    }
}
