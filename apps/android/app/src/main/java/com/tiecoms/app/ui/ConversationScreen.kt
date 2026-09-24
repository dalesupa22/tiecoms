package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lock
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
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
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PendingMessage
import com.tiecoms.app.ui.theme.LocalChatColors
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
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
        val showAuthor = m.kind != "system" && (prev == null || prev.authorId != m.authorId || prev.kind == "system" || gap)
        out += ChatItem.Msg(m, m.authorId == me, showAuthor)
        prev = m
    }
    val today = LocalDate.now()
    val pend = pending.filter { it.clientMessageId !in confirmed }
    if (pend.isNotEmpty() && lastDay != today) out += ChatItem.Day(today)
    pend.forEach { out += ChatItem.Pending(it) }
    return out.asReversed().toList()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(id: String, onBack: () -> Unit, onDetails: () -> Unit) {
    val client = LocalClient.current
    val container = LocalContainer.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by client.state.collectAsStateWithLifecycle()
    val data = state.data
    val meta = data?.conversations?.firstOrNull { it.id == id }
    val internalFallback = stringResource(R.string.internal_default)
    val convFallback = stringResource(R.string.conversation)

    if (data == null || meta == null) {
        SimpleScaffold(title = convFallback, onBack = onBack) {
            Text(stringResource(R.string.chat_not_found), Modifier.padding(24.dp).testTag("notFound"), textAlign = TextAlign.Center)
        }
        return
    }

    val conv = state.conversations[id]
    val title = Names.conversationTitle(meta, data, internalFallback, convFallback)
    val orgs = Names.participantOrgs(meta, data).joinToString(" · ") { it.name }
    var loadError by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }

    LaunchedEffect(id, reloadKey) {
        loadError = null
        try { client.openConversation(id) } catch (e: Exception) { loadError = errorText(ctx, e) }
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

    val me = data.me.id
    val pending = state.pending.filter { it.conversationId == id }
    val items = remember(conv?.messages, pending, conv?.hasMore, conv?.loading) {
        buildItems(conv?.messages ?: emptyList(), pending, me, conv?.hasMore ?: false, conv?.loading ?: false, meta.historyFromSeq > 0)
    }
    val listState = rememberLazyListState()
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }

    // Mensaje nuevo: baja si ya estaba abajo o si lo mandé yo.
    val newest = items.firstOrNull()
    LaunchedEffect(newest?.key) {
        val mine = newest is ChatItem.Pending || (newest as? ChatItem.Msg)?.mine == true
        if (newest != null && (atBottom || mine)) listState.animateScrollToItem(0)
    }
    // Cargar anteriores al acercarse al principio.
    LaunchedEffect(listState, id) {
        snapshotFlow { (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) to listState.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) -> if (total > 0 && last >= total - 3) client.loadOlder(id) }
    }
    // Marcar leído al ver el último mensaje.
    LaunchedEffect(meta.lastMessageSeq, atBottom, lifecycleState, conv?.loaded) {
        if (atBottom && conv?.loaded == true && lifecycleState.isAtLeast(Lifecycle.State.RESUMED)) client.markRead(id)
    }

    val typers = (state.typing[id] ?: emptyList()).filter { it.until > System.currentTimeMillis() && it.userId != me }
        .mapNotNull { Names.person(data, it.userId)?.name?.substringBefore(' ') }
    val chat = LocalChatColors.current

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                title = {
                    Column(Modifier.clickable(onClick = onDetails).semantics(mergeDescendants = true) { heading() }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (meta.kind == "internal") {
                                Icon(Icons.Filled.Lock, stringResource(R.string.internal_cd), Modifier.size(16.dp))
                                Spacer(Modifier.width(4.dp))
                            }
                            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("chatTitle"))
                        }
                        if (orgs.isNotEmpty()) Text(orgs, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                actions = { IconButton(onClick = onDetails, modifier = Modifier.testTag("details")) { Icon(Icons.Filled.Info, stringResource(R.string.details)) } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
            )
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().navigationBarsPadding().imePadding()) {
            ConnectionBanner(state.connection)
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
                                is ChatItem.Msg -> MessageBubble(item, data)
                                is ChatItem.Pending -> PendingBubble(item.p, onRetry = { client.retry(item.p.clientMessageId) }, onDiscard = { client.discard(item.p.clientMessageId) })
                                ChatItem.LateJoin -> Notice(stringResource(R.string.late_join))
                                ChatItem.Older -> Notice(stringResource(R.string.loading_older))
                            }
                        }
                    }
                }
                if (!atBottom && conv?.loaded == true) {
                    SmallFloatingActionButton(
                        onClick = { scope.launch { listState.animateScrollToItem(0) } },
                        modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                    ) { Icon(Icons.Filled.KeyboardArrowDown, stringResource(R.string.jump_latest)) }
                }
            }
            Text(
                when (typers.size) {
                    0 -> ""
                    1 -> stringResource(R.string.typing_one, typers[0])
                    else -> stringResource(R.string.typing_many, typers.joinToString(", "))
                },
                style = MaterialTheme.typography.labelMedium, fontStyle = FontStyle.Italic, color = chat.system,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 18.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("typing"),
            )
            if (meta.canPost) Composer(id, title) else ReadOnlyNotice()
        }
    }
}

@Composable
private fun Composer(id: String, title: String) {
    val client = LocalClient.current
    var text by rememberSaveable(id) { mutableStateOf("") }
    val send = {
        if (text.isNotBlank()) { client.send(id, text); text = "" }
    }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it; if (it.isNotBlank()) client.typing(id) },
                placeholder = { Text(stringResource(R.string.placeholder, title), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                maxLines = 6,
                shape = RoundedCornerShape(24.dp),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surface, focusedContainerColor = MaterialTheme.colorScheme.surface),
                modifier = Modifier.weight(1f).testTag("composer"),
            )
            Spacer(Modifier.width(8.dp))
            FilledIconButton(
                onClick = send, enabled = text.isNotBlank(),
                modifier = Modifier.size(52.dp).testTag("send"),
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary),
            ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.send)) }
        }
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
private fun MessageBubble(item: ChatItem.Msg, data: BootstrapDTO) {
    val ctx = LocalContext.current
    val m = item.m
    val chat = LocalChatColors.current
    if (m.kind == "system") {
        Text(
            systemText(ctx, m.body), style = MaterialTheme.typography.bodySmall, color = chat.system, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 6.dp).testTag("system"),
        )
        return
    }
    val author = Names.person(data, m.authorId)
    val authorName = author?.name ?: stringResource(R.string.former_participant)
    val orgName = Names.org(data, author?.orgId)?.name
    val deleted = m.deletedAt != null
    val body = if (deleted) stringResource(R.string.deleted) else m.body
    val time = timeText(m.createdAt)
    val a11y = (if (item.mine) "" else "$authorName${orgName?.let { " ($it)" } ?: ""}: ") + body + ". " + time
    Column(
        Modifier.fillMaxWidth().padding(top = if (item.showAuthor) 8.dp else 2.dp),
        horizontalAlignment = if (item.mine) Alignment.End else Alignment.Start,
    ) {
        if (!item.mine && item.showAuthor) {
            Text(
                buildString { append(authorName); orgName?.let { append(" · "); append(it) } },
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 12.dp, bottom = 2.dp), maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Bubble(mine = item.mine, modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = a11y }.testTag("msg-${m.seq}")) {
            Text(body, color = if (item.mine) chat.onMine else chat.onOther, style = MaterialTheme.typography.bodyLarge, fontStyle = if (deleted) FontStyle.Italic else null)
            Text(
                listOfNotNull(time, if (m.editedAt != null && !deleted) stringResource(R.string.edited) else null).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
                color = (if (item.mine) chat.onMine else chat.onOther).copy(alpha = 0.75f),
                modifier = Modifier.align(Alignment.End),
            )
        }
    }
}

@Composable
private fun Bubble(mine: Boolean, modifier: Modifier = Modifier, alpha: Float = 1f, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    val chat = LocalChatColors.current
    val shape = if (mine) RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp) else RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp)
    // Ancho máximo: 80 % de la pantalla (hasta 480 dp en tabletas); si no, se ajusta al texto.
    val maxW = (androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp * 0.8f).coerceAtMost(480f).dp
    Column(
        modifier.widthIn(max = maxW)
            .background((if (mine) chat.mineBubble else chat.otherBubble).copy(alpha = alpha), shape)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        content = content,
    )
}

@Composable
private fun PendingBubble(p: PendingMessage, onRetry: () -> Unit, onDiscard: () -> Unit) {
    val chat = LocalChatColors.current
    val failed = p.status == "failed"
    val retryLabel = stringResource(R.string.retry)
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalAlignment = Alignment.End) {
        Bubble(
            mine = true, alpha = if (failed) 0.55f else 0.8f,
            modifier = Modifier.testTag("pending").then(if (failed) Modifier.clickable(onClick = onRetry).semantics { onClick(retryLabel) { onRetry(); true } } else Modifier),
        ) {
            Text(p.body, color = chat.onMine, style = MaterialTheme.typography.bodyLarge)
        }
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
fun SimpleScaffold(title: String, onBack: () -> Unit, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() }) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { pad -> Column(Modifier.padding(pad).fillMaxSize(), verticalArrangement = Arrangement.Top, content = content) }
}
