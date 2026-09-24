package com.tiecoms.app.ui

import android.view.HapticFeedbackConstants
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.IssueDTO
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PendingMessage
import com.tiecoms.app.core.TcJson
import com.tiecoms.app.ui.theme.Brand
import com.tiecoms.app.ui.theme.LocalChatColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.time.LocalDate

private sealed interface ChatItem {
    val key: String
    data class Day(val date: LocalDate) : ChatItem { override val key = "d:$date" }
    data class Msg(val m: MessageDTO, val mine: Boolean, val showAuthor: Boolean) : ChatItem { override val key = "m:" + m.id }
    data class Pending(val p: PendingMessage) : ChatItem { override val key = "p:" + p.clientMessageId }
    data object LateJoin : ChatItem { override val key = "late" }
    data object Older : ChatItem { override val key = "older" }
}

/** Cronológico → invertido (índice 0 = lo más nuevo, para reverseLayout). */
private fun buildItems(messages: List<MessageDTO>, pending: List<PendingMessage>, me: String?, hasMore: Boolean, loading: Boolean, lateJoin: Boolean): List<ChatItem> {
    val confirmed = messages.mapNotNull { it.clientMessageId }.toSet()
    val out = mutableListOf<ChatItem>()
    if (hasMore && loading) out += ChatItem.Older
    if (!hasMore && lateJoin) out += ChatItem.LateJoin
    var lastDay: LocalDate? = null
    var prev: MessageDTO? = null
    for (m in messages) {
        val day = localDate(m.createdAt)
        if (day != null && day != lastDay) { out += ChatItem.Day(day); lastDay = day; prev = null }
        val gap = prev?.let { p -> (parseInstant(m.createdAt)?.toEpochMilli() ?: 0) - (parseInstant(p.createdAt)?.toEpochMilli() ?: 0) > 5 * 60_000 } ?: true
        val cont = prev != null && prev.kind == "text" && m.kind == "text" && prev.authorId == m.authorId && m.replyTo == null && m.forwarded == null && !gap
        out += ChatItem.Msg(m, m.authorId == me, m.kind != "system" && !cont)
        prev = m
    }
    val today = LocalDate.now()
    val pend = pending.filter { it.clientMessageId !in confirmed }
    if (pend.isNotEmpty() && lastDay != today) out += ChatItem.Day(today)
    pend.forEach { out += ChatItem.Pending(it) }
    return out.asReversed().toList()
}

/** Mensajes de sistema: {"k": clave, ...}; algunos enlazan a un asunto, una reunión o una derivada. */
private fun systemPayload(body: String): JsonObject? = if (body.startsWith("{")) runCatching { TcJson.parseToJsonElement(body) as JsonObject }.getOrNull() else null
private fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    id: String,
    jumpSeq: Long? = null,
    onBack: () -> Unit,
    onDetails: () -> Unit,
    onOpenConversation: (String, Long?) -> Unit,
    onOpenIssue: (String) -> Unit,
    onOpenEvent: (String) -> Unit,
    onTrazo: () -> Unit,
) {
    val client = LocalClient.current
    val container = LocalContainer.current
    val ctx = LocalContext.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val state by client.state.collectAsStateWithLifecycle()
    val data = state.data
    val meta = data?.conversations?.firstOrNull { it.id == id }
    val convFallback = stringResource(R.string.conversation)

    if (data == null || meta == null) {
        SimpleScaffold(title = convFallback, onBack = onBack) {
            Text(stringResource(R.string.chat_not_found), Modifier.padding(24.dp).testTag("notFound"), textAlign = TextAlign.Center)
        }
        return
    }

    val conv = state.conversations[id]
    val title = titleOf(ctx, meta, data)
    val orgs = Names.participantOrgs(meta, data).joinToString(" · ") { it.name }
    val muted = meta.mutedAt(System.currentTimeMillis())
    var loadError by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }
    var highlight by remember { mutableStateOf<Long?>(null) }
    var menuFor by remember { mutableStateOf<MessageDTO?>(null) }
    var convMenu by rememberSaveable { mutableStateOf(false) }
    var replyTo by remember { mutableStateOf<MessageDTO?>(null) }
    var editing by remember { mutableStateOf<MessageDTO?>(null) }
    var deriving by remember { mutableStateOf<MessageDTO?>(null) }
    var newIssue by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var meeting by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var forwarding by remember { mutableStateOf<MessageDTO?>(null) }
    var reminderCustom by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var bringing by rememberSaveable { mutableStateOf(false) }
    var showPins by rememberSaveable { mutableStateOf(false) }
    var returning by rememberSaveable { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<MessageDTO?>(null) }
    var confirmLeave by rememberSaveable { mutableStateOf(false) }

    val listState = rememberLazyListState()
    val me = data.me.id
    val pending = state.pending.filter { it.conversationId == id }
    val items = remember(conv?.messages, pending, conv?.hasMore, conv?.loading) {
        buildItems(conv?.messages ?: emptyList(), pending, me, conv?.hasMore ?: false, conv?.loading ?: false, meta.historyFromSeq > 0)
    }
    val byId = remember(conv?.messages) { (conv?.messages ?: emptyList()).associateBy { it.id } }

    fun jumpTo(seq: Long) {
        scope.launch {
            if (!client.ensureMessage(id, seq)) return@launch
            delay(80)
            val idx = buildItems(client.state.value.conversations[id]?.messages ?: emptyList(), client.state.value.pending.filter { it.conversationId == id }, me, false, false, false)
                .indexOfFirst { (it as? ChatItem.Msg)?.m?.seq == seq }
            if (idx >= 0) listState.animateScrollToItem(idx)
            highlight = seq
            delay(2800); highlight = null
        }
    }

    LaunchedEffect(id, reloadKey) {
        loadError = null
        try { client.openConversation(id) } catch (e: Exception) { loadError = errorText(ctx, e) }
        launch { runCatching { client.loadIssues(conversationId = id) } }
        launch { runCatching { client.loadPins(id) } }
        launch { runCatching { client.loadEvents(Instant.now().minusSeconds(30L * 86400), Instant.now().plusSeconds(60L * 86400), id) } }
        if (jumpSeq != null && jumpSeq > 0) jumpTo(jumpSeq)
    }

    // Conversación visible: decide el sonido de recepción y limpia su notificación.
    val lifecycleOwner = LocalLifecycleOwner.current
    val lifecycleState by lifecycleOwner.lifecycle.currentStateFlow.collectAsStateWithLifecycle()
    DisposableEffect(id, lifecycleOwner) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_RESUME -> { container.openConversationId = id; container.notifier.cancel(id) }
                Lifecycle.Event.ON_PAUSE -> if (container.openConversationId == id) container.openConversationId = null
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(obs)
            if (container.openConversationId == id) container.openConversationId = null
        }
    }

    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }
    val newest = items.firstOrNull()
    LaunchedEffect(newest?.key) {
        val mine = newest is ChatItem.Pending || (newest as? ChatItem.Msg)?.mine == true
        if (newest != null && highlight == null && (atBottom || mine)) listState.animateScrollToItem(0)
    }
    LaunchedEffect(listState, id) {
        snapshotFlow { (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) to listState.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) -> if (total > 0 && last >= total - 3) client.loadOlder(id) }
    }
    LaunchedEffect(meta.lastMessageSeq, atBottom, lifecycleState, conv?.loaded) {
        if (atBottom && conv?.loaded == true && lifecycleState.isAtLeast(Lifecycle.State.RESUMED)) client.markRead(id)
    }

    val typers = (state.typing[id] ?: emptyList()).filter { it.until > System.currentTimeMillis() && it.userId != me }
        .mapNotNull { Names.person(data, it.userId)?.name?.substringBefore(' ') }
    val chat = LocalChatColors.current
    val pinned = (state.pins[id] ?: emptyList()).toSet()
    val openHere = state.issues.values.filter { it.conversationId == id && !it.closed }
    val canWork = meta.canPost && meta.kind != "direct" && meta.workspaceId != null
    val myWsRole = data.workspaces.firstOrNull { it.id == meta.workspaceId }?.myRole

    fun act(block: suspend () -> Unit) = scope.launch { runCatching { block() }.onFailure { container.toast(errorText(ctx, it)) } }

    fun messageMenu(m: MessageDTO): List<SheetItem?> {
        val mine = m.authorId == me
        val isPinned = m.id in pinned
        return buildList {
            if (meta.canPost) add(SheetItem(ctx.getString(R.string.menu_reply), "↩", tag = "menuReply") { replyTo = m; editing = null })
            add(SheetItem(ctx.getString(R.string.menu_copy_text), "⧉") { copyToClipboard(ctx, m.body); container.toast(ctx.getString(R.string.toast_copied)) })
            add(SheetItem(ctx.getString(R.string.menu_copy_link), "⛓") { copyToClipboard(ctx, messageLink(id, m.seq)); container.toast(ctx.getString(R.string.toast_link_copied)) })
            add(null)
            if (meta.canPost) add(SheetItem(ctx.getString(if (isPinned) R.string.menu_unpin else R.string.menu_pin), "📌", tag = "menuPin") {
                act { client.setMessagePinned(m, !isPinned); container.toast(ctx.getString(if (isPinned) R.string.toast_unpinned else R.string.toast_pinned)) }
            })
            add(remindMenu(ctx, meta, m) { reminderCustom = true to m })
            add(SheetItem(ctx.getString(R.string.menu_mark_unread), "●", tag = "menuUnread") { act { client.markUnread(id, m.seq); container.toast(ctx.getString(R.string.toast_marked_unread)) } })
            if (canWork) {
                add(null)
                if (myWsRole != "guest") add(SheetItem(ctx.getString(R.string.menu_derive), "⑂", tag = "menuDerive") { deriving = m })
                add(SheetItem(ctx.getString(R.string.menu_issue), "◆", tag = "menuIssue") { newIssue = true to m })
                add(SheetItem(ctx.getString(R.string.menu_meeting), "📅", tag = "menuMeeting") { meeting = true to m })
            }
            if (m.kind == "text") add(SheetItem(ctx.getString(R.string.menu_forward_chat), "↪", tag = "menuForwardChat") { forwarding = m })
            add(forwardMenu(ctx, data, meta, m))
            if (mine && m.kind == "text") {
                add(null)
                add(SheetItem(ctx.getString(R.string.menu_edit), "✎", tag = "menuEdit") { editing = m; replyTo = null })
                add(SheetItem(ctx.getString(R.string.menu_delete), "🗑", danger = true, tag = "menuDelete") { confirmDelete = m })
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                title = {
                    Column(Modifier.clickable(onClick = onDetails).semantics(mergeDescendants = true) { heading() }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (meta.kind == "internal") { Icon(Icons.Filled.Lock, stringResource(R.string.internal_cd), Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)) }
                            if (meta.level == "directivo") Text("◆ ", color = Brand.Orange)
                            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f, fill = false).testTag("chatTitle"))
                            if (muted) Text(" 🔕", modifier = Modifier.semantics { contentDescription = ctx.getString(R.string.side_muted) })
                        }
                        val head = if (meta.kind == "multi") Names.multiSubtitle(meta, data) else orgs.ifEmpty { null }
                        val sub = listOfNotNull(head, if (meta.kind != "direct") ctx.getString(R.string.participants_n, meta.memberIds.size) else null).joinToString(" · ")
                        if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                actions = {
                    if (pinned.isNotEmpty()) TextButton(onClick = { showPins = true }, modifier = Modifier.testTag("pinsButton")) {
                        Text("📌 ${pinned.size}", modifier = Modifier.semantics { contentDescription = ctx.getString(R.string.pins_count, pinned.size) })
                    }
                    IconButton(onClick = { convMenu = true }, modifier = Modifier.testTag("convMenu")) { Icon(Icons.Filled.MoreVert, stringResource(R.string.menu_more)) }
                    IconButton(onClick = onDetails, modifier = Modifier.testTag("details")) { Icon(Icons.Filled.Info, stringResource(R.string.details)) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
            )
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().navigationBarsPadding().imePadding()) {
            ConnectionBanner(state.connection)
            LineageBar(meta, data, onOpenConversation, onReturn = { returning = true }, onTrazo = onTrazo)
            IssueChips(openHere, data, onOpenIssue)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    conv?.loaded != true && loadError != null -> Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(loadError!!, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { reloadKey++ }) { Text(stringResource(R.string.retry)) }
                    }
                    conv?.loaded != true -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                    items.isEmpty() -> Text(stringResource(R.string.no_messages), Modifier.align(Alignment.Center), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> LazyColumn(
                        state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize().testTag("messages"),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    ) {
                        items(items, key = { it.key }) { item ->
                            when (item) {
                                is ChatItem.Day -> DaySeparator(dayText(ctx, item.date))
                                is ChatItem.Msg -> if (item.m.kind == "system") SystemRow(item.m, data, state.events, onOpenConversation, onOpenIssue, onOpenEvent)
                                else MessageBubble(
                                    item, data, quoted = item.m.replyTo?.let { byId[it] }, pinnedHere = item.m.id in pinned, highlighted = highlight == item.m.seq,
                                    issue = openHere.firstOrNull { it.originMessageId == item.m.id },
                                    onLongPress = { if (item.m.deletedAt == null) menuFor = item.m },
                                    onQuote = { q -> jumpTo(q.seq) }, onIssue = onOpenIssue, onOpenConversation = { c -> onOpenConversation(c, null) },
                                )
                                is ChatItem.Pending -> PendingBubble(item.p, onRetry = { client.retry(item.p.clientMessageId) }, onDiscard = { client.discard(item.p.clientMessageId) })
                                ChatItem.LateJoin -> Notice(stringResource(R.string.late_join))
                                ChatItem.Older -> Notice(stringResource(R.string.loading_older))
                            }
                        }
                    }
                }
                if (!atBottom && conv?.loaded == true) {
                    SmallFloatingActionButton(onClick = { scope.launch { listState.animateScrollToItem(0) } }, modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp)) {
                        Icon(Icons.Filled.KeyboardArrowDown, stringResource(R.string.jump_latest))
                    }
                }
            }
            Text(
                when (typers.size) { 0 -> ""; 1 -> stringResource(R.string.typing_one, typers[0]); else -> stringResource(R.string.typing_many, typers.joinToString(", ")) },
                style = MaterialTheme.typography.labelMedium, fontStyle = FontStyle.Italic, color = chat.system,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 18.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("typing"),
            )
            if (meta.canPost) Composer(
                id, title, data, replyTo, editing,
                onCancelReply = { replyTo = null }, onCancelEdit = { editing = null },
                onSend = { text ->
                    view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    client.send(id, text, replyTo?.id); replyTo = null
                },
                onSaveEdit = { m, text ->
                    editing = null
                    if (text.isNotBlank() && text != m.body) act { client.editMessage(m.id, text) }
                },
                onBring = { bringing = true },
            ) else ReadOnlyNotice()
        }
    }

    menuFor?.let { m -> ActionSheet(excerpt(m.body, 80), messageMenu(m)) { menuFor = null } }
    if (convMenu) ActionSheet(title, conversationMenu(ctx, meta, data, onMeeting = { meeting = true to null }, onRemindCustom = { reminderCustom = true to null }, onLeave = { confirmLeave = true })) { convMenu = false }
    deriving?.let { m -> DeriveDialog(meta, m, onClose = { deriving = null }, onCreated = { cid -> onOpenConversation(cid, null) }) }
    newIssue?.let { (_, m) -> NewIssueDialog(id, m?.id, m?.let { excerpt(it.body) } ?: "", onClose = { newIssue = null }, onCreated = onOpenIssue) }
    meeting?.let { (_, m) -> EventDialog(id, originMessageId = m?.id, defaultTitle = m?.let { excerpt(it.body, 80) } ?: "", onClose = { meeting = null }) }
    forwarding?.let { m -> ForwardDialog(m, onClose = { forwarding = null }, onSent = {}) }
    reminderCustom?.let { (_, m) -> ReminderDialog(meta, m, onClose = { reminderCustom = null }) }
    if (bringing) BringDialog(id, onClose = { bringing = false })
    if (showPins) PinsSheet(meta, onJump = { seq -> showPins = false; jumpTo(seq) }, onClose = { showPins = false })
    if (returning) {
        val parent = meta.parentId?.let { pid -> data.conversations.firstOrNull { it.id == pid } }
        if (parent != null) ReturnDialog(meta, titleOf(ctx, parent, data), onClose = { returning = false }, onReturned = { pid, seq -> onOpenConversation(pid, seq) })
    }
    confirmDelete?.let { m ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null }, text = { Text(stringResource(R.string.menu_delete_confirm)) },
            confirmButton = { TextButton(onClick = { confirmDelete = null; act { client.deleteMessage(m.id) } }, modifier = Modifier.testTag("confirmDelete")) { Text(stringResource(R.string.menu_delete)) } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
    if (confirmLeave) AlertDialog(
        onDismissRequest = { confirmLeave = false }, text = { Text(stringResource(R.string.chat_leave_confirm)) },
        confirmButton = { TextButton(onClick = { confirmLeave = false; act { client.removeMember(id, me); onBack() } }) { Text(stringResource(R.string.menu_leave)) } },
        dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text(stringResource(R.string.cancel)) } },
    )
}

/** Menú de conversación (conversationMenu de la web): en el inicio (pulsación larga) y en la cabecera. */
fun conversationMenu(ctx: android.content.Context, conv: ConversationDTO, data: BootstrapDTO, onMeeting: (() -> Unit)?, onRemindCustom: () -> Unit, onLeave: (() -> Unit)?, onOpen: (() -> Unit)? = null): List<SheetItem?> {
    val container = (ctx.applicationContext as com.tiecoms.app.TieComsApp).container
    val client = container.client.value
    fun act(block: suspend () -> Unit) = container.scope.launch { runCatching { block() }.onFailure { container.toast(errorText(ctx, it)) } }
    val pinned = conv.pinnedAt != null
    val muted = conv.mutedAt(System.currentTimeMillis())
    fun mute(untilMs: Long?) = act {
        client.setConversationPrefs(conv.id, mutedUntil = untilMs?.let { Instant.ofEpochMilli(it).toString() } ?: "2099-12-31T00:00:00Z")
        container.toast(ctx.getString(R.string.toast_muted))
    }
    val now = System.currentTimeMillis()
    return buildList {
        onOpen?.let { add(SheetItem(ctx.getString(R.string.menu_open), "↗", onClick = it)) }
        add(SheetItem(ctx.getString(if (pinned) R.string.menu_unpin_top else R.string.menu_pin_top), "📌", tag = "menuPinTop") { act { client.setConversationPrefs(conv.id, pinned = !pinned) } })
        if (conv.unread > 0) add(SheetItem(ctx.getString(R.string.menu_mark_read), "✓") { act { client.markConversationRead(conv.id) } })
        else add(SheetItem(ctx.getString(R.string.menu_mark_unread_conv), "●", enabled = conv.lastMessageSeq > conv.historyFromSeq) {
            act { client.markUnread(conv.id, conv.lastMessageSeq); container.toast(ctx.getString(R.string.toast_marked_unread)) }
        })
        if (muted) add(SheetItem(ctx.getString(R.string.menu_unmute), "🔔", tag = "menuUnmute") { act { client.setConversationPrefs(conv.id, mutedUntil = null); container.toast(ctx.getString(R.string.toast_unmuted)) } })
        else add(SheetItem(ctx.getString(R.string.menu_mute), "🔕", tag = "menuMute", children = listOf(
            SheetItem(ctx.getString(R.string.mute_1h), tag = "mute1h") { mute(now + 3_600_000) },
            SheetItem(ctx.getString(R.string.mute_8h)) { mute(now + 8 * 3_600_000) },
            SheetItem(ctx.getString(R.string.mute_week)) { mute(now + 7 * 86_400_000L) },
            SheetItem(ctx.getString(R.string.mute_forever), tag = "muteForever") { mute(null) },
        )))
        add(remindMenu(ctx, conv, null, onRemindCustom))
        if (onMeeting != null && conv.workspaceId != null && conv.canPost) add(SheetItem(ctx.getString(R.string.menu_meeting), "📅", onClick = onMeeting))
        add(null)
        add(SheetItem(ctx.getString(R.string.menu_copy_link), "⛓") { copyToClipboard(ctx, convLink(conv.id)); container.toast(ctx.getString(R.string.toast_link_copied)) })
        if (conv.kind != "direct" && onLeave != null) { add(null); add(SheetItem(ctx.getString(R.string.menu_leave), "⎋", danger = true, onClick = onLeave)) }
    }
}

/** Barra de linaje: de dónde viene, en qué derivó, y devolver el resultado. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun LineageBar(conv: ConversationDTO, data: BootstrapDTO, onOpen: (String, Long?) -> Unit, onReturn: () -> Unit, onTrazo: () -> Unit) {
    val ctx = LocalContext.current
    val parent = conv.parentId?.let { pid -> data.conversations.firstOrNull { it.id == pid } }
    val kids = data.conversations.filter { it.parentId == conv.id }
    if (conv.parentId == null && kids.isEmpty()) return
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().testTag("lineage")) {
        FlowRow(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.lin_label).uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.CenterVertically))
            if (conv.parentId != null) {
                if (parent != null) LinChip("↖ " + stringResource(R.string.lin_from, titleOf(ctx, parent, data))) { onOpen(parent.id, conv.parentMessageSeq) }
                else Text("↖ " + stringResource(R.string.lin_from_hidden), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            KindBadge(conv.deriveKind)
            if (kids.isNotEmpty()) Text(stringResource(R.string.lin_kids), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            kids.forEach { k -> LinChip("⑂ " + titleOf(ctx, k, data) + if (k.returnedAt != null) " ✓" else "") { onOpen(k.id, null) } }
            if (conv.returnedAt != null) Text("✓ " + stringResource(R.string.lin_returned), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            if (parent != null && conv.returnedAt == null && conv.canPost) TextButton(onClick = onReturn, modifier = Modifier.testTag("returnButton")) { Text(stringResource(R.string.lin_return)) }
            TextButton(onClick = onTrazo) { Text(stringResource(R.string.lin_trazo)) }
        }
    }
}

@Composable
private fun LinChip(text: String, onClick: () -> Unit) {
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.clickable(onClick = onClick)) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 6.dp), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Composer(
    id: String, title: String, data: BootstrapDTO, replyTo: MessageDTO?, editing: MessageDTO?,
    onCancelReply: () -> Unit, onCancelEdit: () -> Unit, onSend: (String) -> Unit, onSaveEdit: (MessageDTO, String) -> Unit, onBring: () -> Unit,
) {
    val client = LocalClient.current
    var text by rememberSaveable(id) { mutableStateOf("") }
    var editText by rememberSaveable(editing?.id) { mutableStateOf(editing?.body ?: "") }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column {
            if (replyTo != null) Banner(stringResource(R.string.reply_to, Names.person(data, replyTo.authorId)?.name ?: "") + " · " + excerpt(replyTo.body, 100), stringResource(R.string.reply_cancel), onCancelReply, "replyBar")
            if (editing != null) Banner(stringResource(R.string.edit_title), stringResource(R.string.cancel), onCancelEdit, "editBar")
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
                val bringLabel = stringResource(R.string.imp_action)
                if (editing == null) IconButton(onClick = onBring, modifier = Modifier.size(48.dp).semantics { contentDescription = bringLabel }.testTag("bring")) {
                    Text("⤓", style = MaterialTheme.typography.titleLarge)
                }
                OutlinedTextField(
                    value = if (editing != null) editText else text,
                    onValueChange = { if (editing != null) editText = it else { text = it; if (it.isNotBlank()) client.typing(id) } },
                    placeholder = { Text(stringResource(R.string.placeholder, title), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    maxLines = 6, shape = RoundedCornerShape(24.dp),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surface, focusedContainerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.weight(1f).testTag("composer"),
                )
                Spacer(Modifier.width(8.dp))
                if (editing != null) {
                    FilledIconButton(onClick = { onSaveEdit(editing, editText.trim()) }, enabled = editText.isNotBlank(), modifier = Modifier.size(52.dp).testTag("saveEdit"),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary)) { Icon(Icons.Filled.Check, stringResource(R.string.edit_save)) }
                } else {
                    FilledIconButton(onClick = { if (text.isNotBlank()) { onSend(text); text = "" } }, enabled = text.isNotBlank(), modifier = Modifier.size(52.dp).testTag("send"),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary)) { Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.send)) }
                }
            }
        }
    }
}

@Composable
private fun Banner(text: String, closeLabel: String, onClose: () -> Unit, tag: String) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(start = 16.dp).testTag(tag), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
        IconButton(onClick = onClose) { Icon(Icons.Filled.Close, closeLabel) }
    }
}

@Composable
private fun ReadOnlyNotice() {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.read_only), Modifier.padding(16.dp).testTag("readOnly"), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DaySeparator(text: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(
            text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 4.dp).semantics { heading() },
        )
    }
}

@Composable
private fun Notice(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = LocalChatColors.current.system, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(12.dp))
}

@Composable
private fun SystemRow(
    m: MessageDTO, data: BootstrapDTO, events: Map<String, com.tiecoms.app.core.CalendarEventDTO>,
    onOpenConversation: (String, Long?) -> Unit, onOpenIssue: (String) -> Unit, onOpenEvent: (String) -> Unit,
) {
    val ctx = LocalContext.current
    val chat = LocalChatColors.current
    val p = systemPayload(m.body)
    val child = if (p?.s("k") == "derived.from") p.s("childId")?.let { cid -> data.conversations.firstOrNull { it.id == cid } } else null
    val eventId = p?.s("eventId")
    val issueId = p?.s("issueId")
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(systemText(ctx, m.body), style = MaterialTheme.typography.bodySmall, color = chat.system, textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 24.dp).testTag("system"))
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (child != null) TextButton(onClick = { onOpenConversation(child.id, null) }) { Text("⑂ " + titleOf(ctx, child, data)) }
            if (issueId != null) TextButton(onClick = { onOpenIssue(issueId) }) { Text(stringResource(R.string.lin_open)) }
        }
        if (eventId != null) {
            val ev = events[eventId]
            if (ev != null && p.s("k") == "event.created") EventCard(ev, data, onOpenEvent)
            else TextButton(onClick = { onOpenEvent(eventId) }) { Text(stringResource(R.string.lin_open)) }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun MessageBubble(
    item: ChatItem.Msg, data: BootstrapDTO, quoted: MessageDTO?, pinnedHere: Boolean, highlighted: Boolean, issue: IssueDTO?,
    onLongPress: () -> Unit, onQuote: (MessageDTO) -> Unit, onIssue: (String) -> Unit, onOpenConversation: (String) -> Unit,
) {
    val ctx = LocalContext.current
    val m = item.m
    val chat = LocalChatColors.current
    val author = Names.person(data, m.authorId)
    val authorName = author?.name ?: stringResource(R.string.former_participant)
    val orgName = Names.org(data, author?.orgId)?.name ?: if (author?.guest == true) stringResource(R.string.common_guest) else null
    val deleted = m.deletedAt != null
    val body = if (deleted) stringResource(R.string.deleted) else m.body
    val time = timeText(m.createdAt)
    val menuLabel = stringResource(R.string.menu_more)
    val a11y = (if (item.mine) "" else "$authorName${orgName?.let { " ($it)" } ?: ""}: ") + body + ". " + time + if (m.editedAt != null && !deleted) ". " + stringResource(R.string.msg_edited) else ""
    val hl by animateColorAsState(if (highlighted) Brand.Orange.copy(alpha = 0.18f) else Color.Transparent, label = "hl")
    Column(
        Modifier.fillMaxWidth().background(hl, RoundedCornerShape(8.dp)).padding(top = if (item.showAuthor) 8.dp else 2.dp),
        horizontalAlignment = if (item.mine) Alignment.End else Alignment.Start,
    ) {
        if (!item.mine && item.showAuthor) {
            Text(buildString { append(authorName); orgName?.let { append(" · "); append(it) }; if (pinnedHere) append("  📌") },
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 12.dp, bottom = 2.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val maxW = (LocalConfiguration.current.screenWidthDp * 0.8f).coerceAtMost(480f).dp
        val shape = if (item.mine) RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp) else RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp)
        val fg = if (item.mine) chat.onMine else chat.onOther
        Column(
            Modifier.widthIn(max = maxW)
                .background(if (item.mine) chat.mineBubble else chat.otherBubble, shape)
                .combinedClickable(onClick = {}, onLongClick = onLongPress, onLongClickLabel = menuLabel)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .semantics(mergeDescendants = true) {
                    contentDescription = a11y
                    if (!deleted) customActions = listOf(CustomAccessibilityAction(menuLabel) { onLongPress(); true })
                }
                .testTag("msg-${m.seq}"),
        ) {
            if (m.replyTo != null) {
                Surface(color = fg.copy(alpha = 0.12f), shape = RoundedCornerShape(8.dp), modifier = Modifier.padding(bottom = 4.dp).clickable(enabled = quoted != null) { quoted?.let(onQuote) }) {
                    Text(
                        if (quoted != null) "${Names.person(data, quoted.authorId)?.name ?: ""}: " + (if (quoted.deletedAt != null) stringResource(R.string.deleted) else excerpt(quoted.body, 120))
                        else stringResource(R.string.reply_quote_missing),
                        Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = fg, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            m.forwarded?.let { f ->
                val from = f.fromConversationId?.let { cid -> data.conversations.firstOrNull { it.id == cid } }
                val label = when {
                    from != null -> stringResource(R.string.fwd_from_conv, titleOf(ctx, from, data))
                    f.author != null -> stringResource(R.string.fwd_from_by, sourceName(ctx, f.source), f.author)
                    else -> stringResource(R.string.fwd_from, sourceName(ctx, f.source))
                }
                val sent = f.sentAt?.let { if (it.contains('T')) shortDateTime(it) else it }
                Text("↪ $label" + (sent?.let { " · $it" } ?: ""), style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = 0.8f), fontStyle = FontStyle.Italic,
                    modifier = Modifier.padding(bottom = 2.dp).testTag("fwdTag"))
            }
            m.mergedFrom?.let { cid ->
                val child = data.conversations.firstOrNull { it.id == cid }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 2.dp)) {
                    Text("↩ " + (child?.let { stringResource(R.string.lin_result_of, titleOf(ctx, it, data)) } ?: stringResource(R.string.lin_result_hidden)),
                        style = MaterialTheme.typography.labelSmall, color = fg, fontWeight = FontWeight.SemiBold)
                    if (child != null) TextButton(onClick = { onOpenConversation(child.id) }) { Text(stringResource(R.string.lin_open), color = fg) }
                }
            }
            if (deleted) Text(body, color = fg, style = MaterialTheme.typography.bodyLarge, fontStyle = FontStyle.Italic)
            else LinkifiedText(body, fg, Modifier.testTag("body-${m.seq}"))
            m.linkPreview?.takeIf { !deleted && it.usable }?.let { LinkPreviewCard(it, fg, Modifier.padding(top = 6.dp)) }
            Text(
                listOfNotNull(if (pinnedHere && item.mine) "📌" else null, time, if (m.editedAt != null && !deleted) stringResource(R.string.msg_edited) else null).joinToString(" "),
                style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = 0.75f), modifier = Modifier.align(Alignment.End),
            )
        }
        if (issue != null) TextButton(onClick = { onIssue(issue.id) }) { Text("◆ " + issue.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium) }
    }
}

@Composable
private fun PendingBubble(p: PendingMessage, onRetry: () -> Unit, onDiscard: () -> Unit) {
    val chat = LocalChatColors.current
    val failed = p.status == "failed"
    val retryLabel = stringResource(R.string.retry)
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.8f).coerceAtMost(480f).dp
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalAlignment = Alignment.End) {
        Column(
            Modifier.widthIn(max = maxW).background(chat.mineBubble.copy(alpha = if (failed) 0.55f else 0.8f), RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp))
                .then(if (failed) Modifier.clickable(onClick = onRetry).semantics { onClick(retryLabel) { onRetry(); true } } else Modifier)
                .padding(horizontal = 12.dp, vertical = 8.dp).testTag("pending"),
        ) { Text(p.body, color = chat.onMine, style = MaterialTheme.typography.bodyLarge) }
        if (failed) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onRetry) { Text(stringResource(R.string.not_sent), color = chat.failed, style = MaterialTheme.typography.labelMedium) }
                TextButton(onClick = onDiscard) { Text(stringResource(R.string.discard), style = MaterialTheme.typography.labelMedium) }
            }
        } else {
            Text(stringResource(R.string.sending), style = MaterialTheme.typography.labelSmall, color = chat.system, modifier = Modifier.padding(end = 6.dp, top = 2.dp).testTag("sending"))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimpleScaffold(title: String, onBack: () -> Unit, actions: @Composable () -> Unit = {}, content: @Composable ColumnScope.() -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() }) },
                actions = { actions() },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { pad -> Column(Modifier.padding(pad).fillMaxSize(), verticalArrangement = Arrangement.Top, content = content) }
}
