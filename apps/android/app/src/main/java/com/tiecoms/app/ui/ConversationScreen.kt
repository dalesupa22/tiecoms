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
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material.icons.filled.AttachFile
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
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.isSecondaryPressed
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

internal sealed interface ChatItem {
    val key: String
    data class Day(val date: LocalDate) : ChatItem { override val key = "d:$date" }
    data class Msg(val m: MessageDTO, val mine: Boolean, val showAuthor: Boolean) : ChatItem { override val key = "m:" + m.id }
    data class Pending(val p: PendingMessage) : ChatItem { override val key = "p:" + p.clientMessageId }
    data object LateJoin : ChatItem { override val key = "late" }
    data object Older : ChatItem { override val key = "older" }
}

/** Cronológico → invertido (índice 0 = lo más nuevo, para reverseLayout). */
internal fun buildItems(messages: List<MessageDTO>, pending: List<PendingMessage>, me: String?, hasMore: Boolean, loading: Boolean, lateJoin: Boolean): List<ChatItem> {
    val confirmed = messages.mapNotNull { it.clientMessageId }.toSet()
    val out = mutableListOf<ChatItem>()
    if (hasMore && loading) out += ChatItem.Older
    if (!hasMore && lateJoin) out += ChatItem.LateJoin
    var lastDay: LocalDate? = null
    var prev: MessageDTO? = null
    for (m in messages) {
        val day = localDate(m.createdAt)
        if (day != null && day != lastDay) { out += ChatItem.Day(day); lastDay = day; prev = null }
        val starts = com.tiecoms.app.core.Runs.startsRun(
            prev?.authorId, prev?.kind, prev?.let { parseInstant(it.createdAt)?.toEpochMilli() }, m.authorId, m.kind,
            parseInstant(m.createdAt)?.toEpochMilli() ?: 0L, m.replyTo != null, m.forwarded != null,
        )
        out += ChatItem.Msg(m, m.authorId == me, starts)
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
    onOpenWorkspace: (String) -> Unit = {},
    onPrivateReply: (MessageDTO) -> Unit = {},
    /** Dentro del panel de una lateral: sin barra superior propia. */
    embedded: Boolean = false,
    /** Sidechat a desplegar al abrir (notificación TC_SIDE: …/c/<origen>?side=<sidechat>). */
    openSide: String? = null,
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
    var sideStart by remember { mutableStateOf<MessageDTO?>(null) }
    var sidePreselect by remember { mutableStateOf(listOf<String>()) }
    /** Tarjeta de la persona al tocar una mención. */
    var personCard by remember { mutableStateOf<String?>(null) }
    var sideOpen by rememberSaveable(openSide) { mutableStateOf(openSide) }
    var convMenu by rememberSaveable { mutableStateOf(false) }
    var replyTo by remember { mutableStateOf<MessageDTO?>(null) }
    var editing by remember { mutableStateOf<MessageDTO?>(null) }
    var deriving by remember { mutableStateOf<MessageDTO?>(null) }
    var newIssue by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var meeting by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var forwarding by remember { mutableStateOf<MessageDTO?>(null) }
    var reminderCustom by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var bringing by rememberSaveable { mutableStateOf(false) }
    /** «Crear asunto: …» sugerido por la transcripción de una nota de voz. */
    var voiceIssue by remember { mutableStateOf<Pair<String, MessageDTO>?>(null) }
    /** Visor de fotos y videos abierto: lista del mensaje e índice. */
    var viewer by remember { mutableStateOf<Pair<List<com.tiecoms.app.core.AttachmentDTO>, Int>?>(null) }
    var showPins by rememberSaveable { mutableStateOf(false) }
    var returning by rememberSaveable { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<MessageDTO?>(null) }
    var confirmLeave by rememberSaveable { mutableStateOf(false) }
    var reportMessage by remember { mutableStateOf<MessageDTO?>(null) }

    val listState = rememberLazyListState()
    val me = data.me.id
    val blockedDirect = meta.kind == "direct" && meta.memberIds.any { it in state.blockedUserIds }
    val pending = state.pending.filter { it.conversationId == id }
    val items = remember(conv?.messages, pending, conv?.hasMore, conv?.loading, state.blockedUserIds) {
        buildItems((conv?.messages ?: emptyList()).filter { it.authorId !in state.blockedUserIds }, pending, me, conv?.hasMore ?: false, conv?.loading ?: false, meta.historyFromSeq > 0)
    }
    val byId = remember(conv?.messages, state.blockedUserIds) { (conv?.messages ?: emptyList()).filter { it.authorId !in state.blockedUserIds }.associateBy { it.id } }

    fun jumpTo(seq: Long) {
        scope.launch {
            if (!client.ensureMessage(id, seq)) return@launch
            delay(80)
            val idx = buildItems((client.state.value.conversations[id]?.messages ?: emptyList()).filter { it.authorId !in client.state.value.blockedUserIds }, client.state.value.pending.filter { it.conversationId == id }, me, false, false, false)
                .indexOfFirst { (it as? ChatItem.Msg)?.m?.seq == seq }
            if (idx >= 0) listState.animateScrollToItem(idx)
            highlight = seq
            delay(2800); highlight = null
        }
    }

    LaunchedEffect(id, reloadKey) {
        runCatching { client.loadBlocks() }
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
    // Notas de voz en orden cronológico: al terminar una, sigue la siguiente (SPEC-v4 §F).
    val voiceOrder = remember(conv?.messages) { conv?.messages.orEmpty().sortedBy { it.seq }.filter { it.deletedAt == null }.flatMap { it.attachments.filter { a -> a.isVoice } } }
    val voiceQueue: (String) -> List<com.tiecoms.app.core.AttachmentDTO> = remember(voiceOrder) { { aid -> voiceOrder.dropWhile { it.id != aid }.drop(1) } }
    val newest = items.firstOrNull()
    // «Seguir el final»: solo cambia con la lista quieta. Si llega un mensaje durante la animación de otro
    // (mi envío y la respuesta inmediata), atBottom daría falso a mitad de camino y dejaría de seguir.
    var follow by remember(id) { mutableStateOf(true) }
    LaunchedEffect(listState, id) {
        // Solo al terminar un desplazamiento (del usuario o animado): si llegan mensajes nuevos arriba del
        // índice 0, la lista conserva la posición y atBottom cambiaría sin que nadie se haya movido.
        snapshotFlow { listState.isScrollInProgress }.distinctUntilChanged().collect { moving -> if (!moving) follow = atBottom }
    }
    LaunchedEffect(newest?.key) {
        val mine = newest is ChatItem.Pending || (newest as? ChatItem.Msg)?.mine == true
        if (newest != null && highlight == null && (follow || mine)) { follow = true; listState.animateScrollToItem(0) }
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
    // Asuntos y reuniones también en directos y chats grupales (SPEC-v4 §E).
    val canWork = meta.canPost
    val myWsRole = data.workspaces.firstOrNull { it.id == meta.workspaceId }?.myRole

    fun act(block: suspend () -> Unit) = scope.launch { runCatching { block() }.onFailure { container.toast(errorText(ctx, it)) } }

    fun messageMenu(m: MessageDTO): List<SheetItem?> {
        val mine = m.authorId == me
        val isPinned = m.id in pinned
        return buildList {
            if (meta.canPost) add(SheetItem(ctx.getString(R.string.menu_reply), "↩", tag = "menuReply") { replyTo = m; editing = null })
            // Responder en privado (SPEC-v3 §7): en grupos y chats grupales, a mensajes ajenos.
            if (!mine && meta.kind != "direct" && m.kind == "text" && Names.person(data, m.authorId)?.kind == "human")
                add(SheetItem(ctx.getString(R.string.menu_reply_private), "🔒", tag = "menuReplyPrivate") { onPrivateReply(m) })
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
                // Los terceros participan en los asuntos pero no los crean (docs/GRUPOS.md).
                if (myWsRole != "guest") add(SheetItem(ctx.getString(R.string.menu_issue), "◆", tag = "menuIssue") { newIssue = true to m })
                add(SheetItem(ctx.getString(R.string.menu_meeting), "📅", tag = "menuMeeting") { meeting = true to m })
            }
            // Conversación lateral (SPEC-v3 §4): preguntar en privado sobre este mensaje.
            if (m.kind == "text" && m.deletedAt == null) add(SheetItem(ctx.getString(R.string.menu_ask_side), "💬", tag = "menuSide") { sideStart = m })
            if (m.kind == "text") add(SheetItem(ctx.getString(R.string.menu_forward_chat), "↪", tag = "menuForwardChat") { forwarding = m })
            add(forwardMenu(ctx, data, meta, m))
            if (!mine) {
                add(null)
                add(SheetItem(ctx.getString(R.string.safety_report_message), "⚑", danger = true, tag = "menuReport") { reportMessage = m })
            }
            if (mine && m.kind == "text") {
                add(null)
                add(SheetItem(ctx.getString(R.string.menu_edit), "✎", tag = "menuEdit") { editing = m; replyTo = null })
                add(SheetItem(ctx.getString(R.string.menu_delete), "🗑", danger = true, tag = "menuDelete") { confirmDelete = m })
            }
        }
    }

    val wide = LocalConfiguration.current.screenWidthDp >= 840
    val sideMeta = sideOpen?.let { sid -> data.conversations.firstOrNull { it.id == sid } }
    // Sidechat (SPEC-v4 §G): minimizado a burbuja flotante, posición del ancla, de la lista y del panel (conector).
    var sideMin by rememberSaveable(sideOpen) { mutableStateOf(false) }
    var anchorRect by remember { mutableStateOf<androidx.compose.ui.geometry.Rect?>(null) }
    var listRect by remember { mutableStateOf<androidx.compose.ui.geometry.Rect?>(null) }
    var panelRect by remember { mutableStateOf<androidx.compose.ui.geometry.Rect?>(null) }
    var cardRect by remember { mutableStateOf<androidx.compose.ui.geometry.Rect?>(null) }
    var overlayOrigin by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    var sideAdd by remember { mutableStateOf(false) }
    var sideReturn by remember { mutableStateOf(false) }
    val showPanel = sideMeta != null && !embedded && !sideMin
    // Teléfono: con la hoja a medias, el ancla queda visible en la mitad de arriba (se desplaza el chat de fondo).
    LaunchedEffect(showPanel, wide, sideMeta?.parentMessageId, items.size) {
        if (!showPanel || wide) return@LaunchedEffect
        val idx = items.indexOfFirst { (it as? ChatItem.Msg)?.m?.id == sideMeta?.parentMessageId }
        if (idx < 0) return@LaunchedEffect
        kotlinx.coroutines.delay(50) // a que se aplique el relleno inferior de la hoja
        listState.animateScrollToItem(idx)
    }
    // Dentro de un sidechat: «Responde a <quien preguntó> en privado…» y «No sé, pregúntale a…» suma personas.
    var sideAddHere by remember { mutableStateOf(false) }
    val sidePlaceholder = if (meta.isSide) {
        // Con una sola persona más: «Responde a Beto en privado…»; con varias: «Responde en privado…».
        val others = meta.memberIds.filter { it != me }
        if (others.size == 1) stringResource(R.string.side_placeholder, Names.person(data, others[0])?.name?.substringBefore(' ') ?: "")
        else stringResource(R.string.side_placeholder_many)
    } else null
    val sideAnchorMsg = sideMeta?.let { sm -> conv?.messages?.firstOrNull { it.id == sm.parentMessageId } }
    Box(Modifier.fillMaxSize().onGloballyPositioned { overlayOrigin = it.positionInRoot() }) {
    Row(Modifier.fillMaxSize()) {
    Box(Modifier.weight(if (showPanel && wide) 0.6f else 1f)) {
    Scaffold(
        topBar = { if (!embedded)
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                title = {
                    Column {
                        Column(Modifier.clickable(onClick = onDetails).semantics(mergeDescendants = true) { heading() }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (meta.kind == "internal") { Icon(Icons.Filled.Lock, stringResource(R.string.internal_cd), Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)) }
                            if (meta.level == "directivo") Text("◆ ", color = Brand.Orange)
                            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f, fill = false).testTag("chatTitle"))
                            if (muted) Text(" 🔕", modifier = Modifier.semantics { contentDescription = ctx.getString(R.string.side_muted) })
                        }
                        }
                        // Ruta «Empresa · Espacio» (SPEC-v3 §9); en chats y laterales, su subtítulo propio.
                        val ws = data.workspaces.firstOrNull { it.id == meta.workspaceId }
                        if (ws != null) {
                            val org = com.tiecoms.app.core.HomeTree.counterpartOrg(data, ws)
                            Text(listOfNotNull(org?.name, ws.name).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { onOpenWorkspace(ws.id) }.testTag("chatPath"))
                        } else {
                            val parent = meta.parentId?.let { pid -> data.conversations.firstOrNull { it.id == pid } }
                            val head = when {
                                meta.isSide -> listOfNotNull(ctx.getString(R.string.side_title), parent?.let { titleOf(ctx, it, data) }).joinToString(" · ")
                                meta.kind == "multi" -> Names.multiSubtitle(meta, data)
                                else -> orgs.ifEmpty { null }
                            }
                            if (!head.isNullOrEmpty()) Text(head, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.testTag("chatPath"))
                        }
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
            // Dentro del panel del sidechat, «Llevar al hilo» ya está en ⋯ y la tarjeta del ancla hace de linaje.
            if (!(embedded && meta.isSide)) LineageBar(meta, data, onOpenConversation, onReturn = { returning = true }, onTrazo = onTrazo)
            OpenIssuesBar(openHere, data, onOpenIssue)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    conv?.loaded != true && loadError != null -> Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(loadError!!, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { reloadKey++ }) { Text(stringResource(R.string.retry)) }
                    }
                    conv?.loaded != true -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                    items.isEmpty() -> Text(stringResource(if (meta.isSide) R.string.side_empty_chat else R.string.no_messages), Modifier.align(Alignment.Center).testTag("sideEmpty"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> androidx.compose.runtime.CompositionLocalProvider(LocalVoiceQueue provides voiceQueue) { LazyColumn(
                        state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize().onGloballyPositioned { listRect = it.boundsInRoot() }.testTag("messages"),
                        // Con la hoja del sidechat a medias (teléfono), el relleno deja el ancla por encima de la hoja.
                        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp,
                            bottom = if (showPanel && !wide) (LocalConfiguration.current.screenHeightDp * 0.45f).dp else 8.dp),
                    ) {
                        items(items, key = { it.key }) { item ->
                            when (item) {
                                is ChatItem.Day -> DaySeparator(dayText(ctx, item.date))
                                is ChatItem.Msg -> if (item.m.kind == "system") SystemRow(item.m, data, state.events, onOpenConversation, onOpenIssue, onOpenEvent)
                                else MessageBubble(
                                    item, data, quoted = item.m.replyTo?.let { byId[it] }, pinnedHere = item.m.id in pinned, highlighted = highlight == item.m.seq,
                                    issue = openHere.firstOrNull { it.originMessageId == item.m.id },
                                    showAvatars = meta.kind != "direct",
                                    sides = sidesOf(data, id, item.m.id), onOpenSide = { sid -> sideOpen = sid },
                                    menuOpen = menuFor?.id == item.m.id,
                                    menuItems = { messageMenu(item.m) },
                                    onDismissMenu = { menuFor = null },
                                    onLongPress = { if (item.m.deletedAt == null) menuFor = item.m },
                                    onQuote = { q -> jumpTo(q.seq) }, onIssue = onOpenIssue, onOpenConversation = { c, seq -> onOpenConversation(c, seq) },
                                    onOpenMedia = { list, i -> viewer = list to i },
                                    onVoiceIssue = if (myWsRole != "guest") ({ t -> voiceIssue = t to item.m }) else null,
                                    isAnchor = sideMeta?.parentMessageId == item.m.id && !embedded,
                                    onAnchorBounds = { r -> anchorRect = r },
                                    onPerson = { pid -> personCard = pid },
                                    onSwipeSide = if (!embedded && item.m.kind == "text" && item.m.deletedAt == null && meta.canPost) ({ sideStart = item.m }) else null,
                                    onOpenFile = { a -> scope.launch { openAttachment(ctx, client, a) } },
                                )
                                is ChatItem.Pending -> PendingBubble(item.p, onRetry = { client.retry(item.p.clientMessageId) }, onDiscard = { client.discard(item.p.clientMessageId) })
                                ChatItem.LateJoin -> Notice(stringResource(R.string.late_join))
                                ChatItem.Older -> Notice(stringResource(R.string.loading_older))
                            }
                        }
                    } }
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
            if (blockedDirect) Text(stringResource(R.string.safety_blocked_chat), Modifier.fillMaxWidth().padding(16.dp).testTag("blockedChat"))
            else if (meta.canPost) {
                val pr by container.privateReply.collectAsStateWithLifecycle()
                val privateHere = pr?.takeIf { it.targetConversationId == id }
                if (privateHere != null) Banner(
                    stringResource(R.string.reply_private_to, privateHere.authorName ?: "") + " · «" + excerpt(privateHere.source.body, 100) + "»",
                    stringResource(R.string.reply_cancel), { container.privateReply.value = null }, "privateReplyBar",
                )
                // Sidechat: respuestas rápidas del lado de quien recibe (la última palabra no es mía).
                if (meta.isSide) {
                    val lastHuman = conv?.messages?.lastOrNull { it.kind == "text" && it.deletedAt == null }
                    if (lastHuman != null && lastHuman.authorId != me) SideQuickReplies(onSend = { t -> client.send(id, t) }, onAsk = { sideAddHere = true })
                }
                Composer(
                id, title, data, replyTo, editing,
                onCancelReply = { replyTo = null }, onCancelEdit = { editing = null },
                onSend = { text, att, mentions ->
                    view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    if (privateHere != null) {
                        val src = privateHere.source
                        client.send(id, text, null, com.tiecoms.app.core.ForwardedInfo("tiecoms", privateHere.authorName, src.createdAt, src.conversationId, src.id), attachments = att, mentions = mentions)
                        container.privateReply.value = null
                    } else client.send(id, text, replyTo?.id, attachments = att, mentions = mentions)
                    replyTo = null
                },
                onSaveEdit = { m, text, mentions ->
                    editing = null
                    if (text.isNotBlank() && (text.trim() != m.body || mentions != m.mentions)) act { client.editMessage(m.id, text, mentions) }
                },
                onAskSide = { pid -> conv?.messages?.lastOrNull { it.kind == "text" && it.deletedAt == null }?.let { last -> sidePreselect = listOf(pid); sideStart = last } },
                onBring = { bringing = true },
                placeholderOverride = if (meta.isSide) sidePlaceholder else null,
            ) } else ReadOnlyNotice()
        }
    }
    }
    // Sidechat: split a la derecha (~40 %) en pantalla ancha con conector curvo; hoja con detents en teléfono.
    if (showPanel && wide) {
        androidx.compose.material3.VerticalDivider()
        Column(Modifier.weight(0.4f).fillMaxHeight().onGloballyPositioned { panelRect = it.boundsInRoot() }.testTag("sidePanel")) {
            SidechatContent(sideMeta!!, sideAnchorMsg, data, onClose = { sideOpen = null }, onMinimize = null,
                onFull = { sideOpen = null; onOpenConversation(sideMeta.id, null) },
                onSeeInChat = { sideMeta.parentMessageSeq?.let { jumpTo(it) } },
                onAddPerson = { sideAdd = true }, onReturn = { sideReturn = true },
                onLeave = { act { client.removeMember(sideMeta.id, me); sideOpen = null } },
                onDetails = onDetails, onOpenConversation = onOpenConversation, onOpenIssue = onOpenIssue, onOpenEvent = onOpenEvent,
                onTrazo = onTrazo, onOpenWorkspace = onOpenWorkspace, onPrivateReply = onPrivateReply, onCardBounds = { cardRect = it })
        }
    }
    }
    if (showPanel && wide) SideConnector(anchorRect, listRect, cardRect, overlayOrigin, sideAnchorMsg?.authorId)
    // Teléfono: línea fina que une el ancla con el borde de la hoja (chat de fondo visible con la hoja a medias).
    if (showPanel && !wide) SideTether(anchorRect, listRect, overlayOrigin)
    if (sideMeta != null && sideMin && !embedded) FloatingSideBubble(sideMeta, data, onOpen = { sideMin = false }, onDrop = { sideOpen = null },
        modifier = Modifier.align(Alignment.BottomEnd).padding(end = 12.dp, bottom = 96.dp))
    }
    if (showPanel && !wide) SideSheetHost(onMinimize = { sideMin = true }) {
        SidechatContent(sideMeta!!, sideAnchorMsg, data, onClose = { sideOpen = null }, onMinimize = { sideMin = true },
            onFull = { sideOpen = null; onOpenConversation(sideMeta.id, null) },
            onSeeInChat = { sideMin = true; sideMeta.parentMessageSeq?.let { jumpTo(it) } },
            onAddPerson = { sideAdd = true }, onReturn = { sideReturn = true },
            onLeave = { act { client.removeMember(sideMeta.id, me); sideOpen = null } },
            onDetails = onDetails, onOpenConversation = onOpenConversation, onOpenIssue = onOpenIssue, onOpenEvent = onOpenEvent,
            onTrazo = onTrazo, onOpenWorkspace = onOpenWorkspace, onPrivateReply = onPrivateReply)
    }
    if (sideAdd && sideMeta != null) SideAddPeopleSheet(sideMeta, meta) { sideAdd = false }
    if (sideAddHere && meta.isSide) SideAddPeopleSheet(meta, meta.parentId?.let { p -> data.conversations.firstOrNull { it.id == p } }) { sideAddHere = false }
    if (sideReturn && sideMeta != null) SideReturnSheet(sideMeta, title, onClose = { sideReturn = false }, onReturned = { _, seq -> sideOpen = null; seq?.let { jumpTo(it) } })
    personCard?.let { pid -> PersonCardSheet(pid, onClose = { personCard = null }, onDirect = { uid -> act { val cid = client.createChat(listOf(uid), null).id; kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { onOpenConversation(cid, null) } } }) }
    sideStart?.let { m -> SideStartSheet(meta, m, onClose = { sideStart = null; sidePreselect = emptyList() }, onStarted = { sid -> sideOpen = sid }, preselect = sidePreselect) }

    reportMessage?.let { ReportDialog(it.authorId, it.id, onClose = { reportMessage = null }) }
    if (convMenu) ActionSheet(title, conversationMenu(ctx, meta, data, onMeeting = { meeting = true to null }, onRemindCustom = { reminderCustom = true to null }, onLeave = { confirmLeave = true })) { convMenu = false }
    viewer?.let { (list, i) -> MediaViewer(list, i) { viewer = null } }
    voiceIssue?.let { (t, m) -> NewIssueDialog(id, m.id, t, onClose = { voiceIssue = null }, onCreated = onOpenIssue) }
    deriving?.let { m -> DeriveDialog(meta, m, onClose = { deriving = null }, onCreated = { cid -> onOpenConversation(cid, null) }) }
    newIssue?.let { (_, m) -> NewIssueDialog(id, m?.id, m?.let { excerpt(it.body) } ?: "", onClose = { newIssue = null }, onCreated = onOpenIssue) }
    meeting?.let { (_, m) -> EventDialog(id, originMessageId = m?.id, defaultTitle = m?.let { excerpt(it.body, 80) } ?: "", onClose = { meeting = null }) }
    forwarding?.let { m -> ForwardDialog(m, onClose = { forwarding = null }, onSent = {}) }
    reminderCustom?.let { (_, m) -> ReminderDialog(meta, m, onClose = { reminderCustom = null }) }
    if (bringing) BringDialog(id, onClose = { bringing = false })
    if (showPins) PinsSheet(meta, onJump = { seq -> showPins = false; jumpTo(seq) }, onClose = { showPins = false })
    if (returning) {
        val parent = meta.parentId?.let { pid -> data.conversations.firstOrNull { it.id == pid } }
        if (parent != null && meta.isSide) SideReturnSheet(meta, titleOf(ctx, parent, data), onClose = { returning = false }, onReturned = { pid, seq -> onOpenConversation(pid, seq) })
        else if (parent != null) ReturnDialog(meta, titleOf(ctx, parent, data), onClose = { returning = false }, onReturned = { pid, seq -> onOpenConversation(pid, seq) })
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
        if (onMeeting != null && conv.canPost) add(SheetItem(ctx.getString(R.string.menu_meeting), "📅", onClick = onMeeting))
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
    // Las laterales no van en el linaje: cuelgan de su mensaje ancla (chip «Consulta lateral»).
    val kids = data.conversations.filter { it.parentId == conv.id && !it.isSide }
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
            if (parent != null && conv.returnedAt == null && conv.canPost) TextButton(onClick = onReturn, modifier = Modifier.testTag("returnButton")) { Text(stringResource(if (conv.isSide) R.string.side_return else R.string.lin_return)) }
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
    onCancelReply: () -> Unit, onCancelEdit: () -> Unit, onSend: (String, List<com.tiecoms.app.core.AttachmentDTO>, List<com.tiecoms.app.core.MentionDTO>) -> Unit,
    onSaveEdit: (MessageDTO, String, List<com.tiecoms.app.core.MentionDTO>) -> Unit, onBring: () -> Unit,
    placeholderOverride: String? = null,
    /** «Preguntarle en un sidechat» a alguien que no está en el chat (desde el buscador de menciones). */
    onAskSide: (String) -> Unit = {},
) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(id) { mutableStateOf("") }
    // Menciones con @ (SPEC-v4 §H): tokens sobre el texto (UTF-16) y el cursor para el buscador.
    var ments by remember(id) { mutableStateOf(listOf<com.tiecoms.app.core.MentionDTO>()) }
    var sel by remember(id) { mutableStateOf(androidx.compose.ui.text.TextRange(0)) }
    var editMents by remember(editing?.id) { mutableStateOf(editing?.mentions.orEmpty()) }
    var editSel by remember(editing?.id) { mutableStateOf(androidx.compose.ui.text.TextRange(editing?.body?.length ?: 0)) }
    // Adjuntos elegidos (copiados a caché) antes de enviar; se suben al pulsar Enviar (SPEC-v4).
    var files by remember(id) { mutableStateOf(listOf<com.tiecoms.app.core.Attachments.Shared>()) }
    var uploading by remember(id) { mutableStateOf<Pair<Int, Float>?>(null) }
    var attError by remember(id) { mutableStateOf<String?>(null) }
    var picker by remember { mutableStateOf(false) }
    // Notas de voz (SPEC-v4 §F): mantener pulsado el micrófono cuando el compositor está vacío.
    val recorder = remember(id) { com.tiecoms.app.platform.VoiceRecorder(ctx.applicationContext) }
    val rec by recorder.state.collectAsStateWithLifecycle()
    var locked by remember(id) { mutableStateOf(false) }
    var gesture by remember(id) { mutableStateOf(com.tiecoms.app.core.Waveform.Gesture.RECORDING) }
    var micWhy by remember { mutableStateOf(false) }
    var pendingVoice by remember(id) { mutableStateOf<com.tiecoms.app.platform.VoiceRecorder.Result?>(null) }
    val micPermission = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { }
    androidx.compose.runtime.DisposableEffect(recorder) { onDispose { recorder.cancel(); pendingVoice?.file?.delete() } }
    fun hasMic() = androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED
    fun uploadVoice(r: com.tiecoms.app.platform.VoiceRecorder.Result, aiConsent: Boolean) {
        pendingVoice = null
        attError = null
        scope.launch {
            uploading = 0 to 0f
            try {
                val a = client.uploadAttachment(id, r.file, ctx.getString(R.string.voice_note) + ".m4a", "audio/mp4",
                    voice = com.tiecoms.app.core.TieComsClient.Voice(r.durationMs, r.waveform, aiConsent)) { sent, total -> uploading = 0 to (if (total > 0) sent.toFloat() / total else 0f) }
                onSend("", listOf(a), emptyList())
                r.file.delete()
            } catch (e: Exception) { attError = errorText(ctx, e) } finally { uploading = null }
        }
    }
    fun sendVoice() {
        val r = recorder.stop()
        locked = false
        if (r == null) { attError = ctx.getString(R.string.voice_too_short); return }
        pendingVoice = r
    }
    pendingVoice?.let { r ->
        AiConsentDialog(voice = true, onAllow = { uploadVoice(r, true) }, onWithoutAi = { uploadVoice(r, false) },
            onDismiss = { r.file.delete(); pendingVoice = null })
    }
    recorder.onLimit = { container.toast(ctx.getString(R.string.voice_too_long)); sendVoice() }
    if (micWhy) androidx.compose.material3.AlertDialog(
        onDismissRequest = { micWhy = false },
        title = { Text(stringResource(R.string.voice_mic_title)) }, text = { Text(stringResource(R.string.voice_mic_body)) },
        confirmButton = { TextButton(onClick = { micWhy = false; micPermission.launch(android.Manifest.permission.RECORD_AUDIO) }, modifier = Modifier.testTag("micAllow")) { Text(stringResource(R.string.voice_mic_allow)) } },
        dismissButton = { TextButton(onClick = { micWhy = false }) { Text(stringResource(R.string.cancel)) } },
    )
    fun add(uris: List<android.net.Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            val copied = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.tiecoms.app.platform.ShareIntake.copyToCache(ctx.applicationContext, uris, null) }
            val plan = com.tiecoms.app.core.Attachments.plan(files + copied, null)
            attError = plan.tooLarge.firstOrNull()?.let { ctx.getString(R.string.att_too_large, it.name) }
                ?: if (plan.dropped > 0) ctx.getString(R.string.att_too_many) else null
            files = plan.files
        }
    }
    AttachPicker(picker, onDismiss = { picker = false }, onPicked = { add(it) })
    fun sendNow() {
        val body = text
        val bodyMents = ments
        if (files.isEmpty()) { if (body.isNotBlank()) { onSend(body, emptyList(), bodyMents); text = ""; ments = emptyList(); sel = androidx.compose.ui.text.TextRange(0) }; return }
        attError = null
        scope.launch {
            val done = mutableListOf<com.tiecoms.app.core.AttachmentDTO>()
            for ((i, f) in files.withIndex()) {
                uploading = i to 0f
                try {
                    done += com.tiecoms.app.platform.AttachmentUpload.upload(ctx.applicationContext, client, id, java.io.File(f.path), f.name, f.contentType) { sent, total ->
                        uploading = i to (if (total > 0) sent.toFloat() / total else 0f)
                    }
                } catch (e: Exception) {
                    attError = ctx.getString(R.string.att_upload_failed, f.name) + " · " + errorText(ctx, e)
                    // Los ya subidos quedan pendientes en el servidor (el worker los borra a las 24 h); se reintenta todo.
                    uploading = null
                    return@launch
                }
            }
            uploading = null
            onSend(body, done, bodyMents)
            files.forEach { java.io.File(it.path).delete() }
            files = emptyList(); text = ""; ments = emptyList(); sel = androidx.compose.ui.text.TextRange(0)
        }
    }
    var editText by rememberSaveable(editing?.id) { mutableStateOf(editing?.body ?: "") }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column {
            if (replyTo != null) Banner(stringResource(R.string.reply_to, Names.person(data, replyTo.authorId)?.name ?: "") + " · " + excerpt(replyTo.body, 100), stringResource(R.string.reply_cancel), onCancelReply, "replyBar")
            if (editing != null) Banner(stringResource(R.string.edit_title), stringResource(R.string.cancel), onCancelEdit, "editBar")
            // Buscador de menciones sobre el compositor.
            run {
                val cur = if (editing != null) editText else text
                val cursor = (if (editing != null) editSel else sel).start
                val q = com.tiecoms.app.core.Mentions.query(cur, cursor, if (editing != null) editMents else ments)
                val convMeta = client.meta(id)
                if (q != null && convMeta != null) MentionPicker(q.second, convMeta, data, onPick = { uid, name ->
                    if (editing != null) { val (t, m, c) = com.tiecoms.app.core.Mentions.insert(editText, editMents, q.first, cursor, name, uid); editText = t; editMents = m; editSel = androidx.compose.ui.text.TextRange(c) }
                    else { val (t, m, c) = com.tiecoms.app.core.Mentions.insert(text, ments, q.first, cursor, name, uid); text = t; ments = m; sel = androidx.compose.ui.text.TextRange(c) }
                }, onAddToChat = { p -> scope.launch {
                    runCatching { client.addMembers(id, listOf(p.id)) }.onSuccess {
                        val (t, m, c) = com.tiecoms.app.core.Mentions.insert(text, ments, q.first, cursor, p.name, p.id); text = t; ments = m; sel = androidx.compose.ui.text.TextRange(c)
                    }.onFailure { attError = errorText(ctx, it) }
                } }, onAskSide = { p -> onAskSide(p.id) })
            }
            if (editing == null && files.isNotEmpty()) PendingFiles(files, uploading, onRemove = { f -> if (uploading == null) { files = files - f; java.io.File(f.path).delete() } })
            attError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp).testTag("attError")) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
                val bringLabel = stringResource(R.string.imp_action)
                val attachLabel = stringResource(R.string.att_attach)
                if (editing == null) IconButton(onClick = { picker = true }, enabled = uploading == null, modifier = Modifier.size(48.dp).semantics { contentDescription = attachLabel }.testTag("attach")) {
                    Icon(Icons.Filled.AttachFile, null)
                }
                if (editing == null) IconButton(onClick = onBring, modifier = Modifier.size(48.dp).semantics { contentDescription = bringLabel }.testTag("bring")) {
                    Text("⤓", style = MaterialTheme.typography.titleLarge)
                }
                if (rec.recording) RecordingBar(rec, locked, gesture, onDelete = { recorder.cancel(); locked = false; container.toast(ctx.getString(R.string.voice_cancelled)) }, onSend = { sendVoice() }, modifier = Modifier.weight(1f))
                else OutlinedTextField(
                    value = if (editing != null) androidx.compose.ui.text.input.TextFieldValue(editText, editSel) else androidx.compose.ui.text.input.TextFieldValue(text, sel),
                    onValueChange = { v ->
                        if (editing != null) {
                            val (t, m, c) = com.tiecoms.app.core.Mentions.edit(editText, v.text, editMents, v.selection.start)
                            editText = t; editMents = m; editSel = if (t != v.text) androidx.compose.ui.text.TextRange(c) else v.selection
                        } else {
                            val (t, m, c) = com.tiecoms.app.core.Mentions.edit(text, v.text, ments, v.selection.start)
                            text = t; ments = m; sel = if (t != v.text) androidx.compose.ui.text.TextRange(c) else v.selection
                            if (t.isNotBlank()) client.typing(id)
                        }
                    },
                    visualTransformation = MentionHighlight(if (editing != null) editMents else ments, MaterialTheme.colorScheme.primary),
                    placeholder = { Text(placeholderOverride ?: stringResource(R.string.placeholder, title), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    maxLines = 6, shape = RoundedCornerShape(24.dp),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surface, focusedContainerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.weight(1f).testTag("composer"),
                )
                Spacer(Modifier.width(8.dp))
                if (editing != null) {
                    FilledIconButton(onClick = { onSaveEdit(editing, editText, editMents) }, enabled = editText.isNotBlank(), modifier = Modifier.size(52.dp).testTag("saveEdit"),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary)) { Icon(Icons.Filled.Check, stringResource(R.string.edit_save)) }
                } else {
                    if (text.isBlank() && files.isEmpty() && uploading == null && !locked) MicButton(
                        onStart = { if (!hasMic()) { micWhy = true; false } else { gesture = com.tiecoms.app.core.Waveform.Gesture.RECORDING; recorder.start() } },
                        onRelease = { sendVoice() }, onCancel = { recorder.cancel(); container.toast(ctx.getString(R.string.voice_cancelled)) }, onLock = { locked = true }, onDrag = { gesture = it },
                    ) else if (!rec.recording) FilledIconButton(onClick = { sendNow() }, enabled = uploading == null && (text.isNotBlank() || files.isNotEmpty()), modifier = Modifier.size(52.dp).testTag("send"),
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
internal fun DaySeparator(text: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(
            text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 4.dp).semantics { heading() },
        )
    }
}

@Composable
internal fun Notice(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = LocalChatColors.current.system, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(12.dp))
}

@Composable
internal fun SystemRow(
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
        Text(systemText(ctx, m.body, Names.person(data, m.authorId)?.name), style = MaterialTheme.typography.bodySmall, color = chat.system, textAlign = TextAlign.Center,
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
internal fun MessageBubble(
    item: ChatItem.Msg, data: BootstrapDTO, quoted: MessageDTO?, pinnedHere: Boolean, highlighted: Boolean, issue: IssueDTO?,
    showAvatars: Boolean, menuOpen: Boolean, menuItems: () -> List<SheetItem?>, onDismissMenu: () -> Unit,
    sides: List<ConversationDTO> = emptyList(), onOpenSide: (String) -> Unit = {},
    onLongPress: () -> Unit, onQuote: (MessageDTO) -> Unit, onIssue: (String) -> Unit, onOpenConversation: (String, Long?) -> Unit,
    onOpenMedia: (List<com.tiecoms.app.core.AttachmentDTO>, Int) -> Unit = { _, _ -> }, onOpenFile: (com.tiecoms.app.core.AttachmentDTO) -> Unit = {},
    /** Sugerencia de asunto de una nota de voz; null la oculta (terceros). */
    onVoiceIssue: ((String) -> Unit)? = {},
    /** Ancla del sidechat abierto: halo y su posición para el conector (SPEC-v4 §G.2). */
    isAnchor: Boolean = false,
    onAnchorBounds: (androidx.compose.ui.geometry.Rect?) -> Unit = {},
    /** Deslizar la burbuja a la derecha: «Preguntar en un sidechat». */
    onSwipeSide: (() -> Unit)? = null,
    onPerson: (String) -> Unit = {},
) {
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val openMenu = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); onLongPress() }
    // La burbuja se eleva mientras su menú está abierto (como el menú contextual de iPhone).
    val lift by androidx.compose.animation.core.animateFloatAsState(if (menuOpen) 1f else 0f, label = "lift")
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
        val avatarGap = if (showAvatars && !item.mine) 34.dp else 0.dp
        if (!item.mine && item.showAuthor) {
            Row(Modifier.padding(start = 12.dp + avatarGap, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(authorName, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                    color = if (showAvatars) personColor(m.authorId) else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false).testTag("author-${m.seq}"))
                Text(buildString { orgName?.let { append(" · "); append(it) }; if (pinnedHere) append("  📌") },
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        val maxW = ((LocalConfiguration.current.screenWidthDp * 0.8f).coerceAtMost(480f)).dp - avatarGap
        val shape = if (item.mine) RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp) else RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp)
        val fg = if (item.mine) chat.onMine else chat.onOther
        Row(verticalAlignment = Alignment.Bottom) {
        if (showAvatars && !item.mine) {
            if (item.showAuthor) AuthorAvatar(author, m.authorId, 28.dp, Modifier.testTag("avatar-${m.seq}")) else Spacer(Modifier.width(28.dp))
            Spacer(Modifier.width(6.dp))
        }
        var swipe by remember(m.id) { androidx.compose.runtime.mutableFloatStateOf(0f) }
        val swipeMax = with(androidx.compose.ui.platform.LocalDensity.current) { 96.dp.toPx() }
        if (isAnchor) androidx.compose.runtime.DisposableEffect(m.id) { onDispose { onAnchorBounds(null) } }
        Box {
        Column(
            Modifier.widthIn(max = maxW)
                .then(if (isAnchor) Modifier.onGloballyPositioned { onAnchorBounds(it.boundsInRoot()) } else Modifier)
                .then(if (onSwipeSide != null) Modifier.pointerInput(m.id) {
                    detectHorizontalDragGestures(
                        onDragEnd = { if (swipe >= swipeMax * 0.8f) { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); onSwipeSide() }; swipe = 0f },
                        onDragCancel = { swipe = 0f },
                    ) { _, dx -> swipe = (swipe + dx).coerceIn(0f, swipeMax) }
                } else Modifier)
                .graphicsLayer { val s = 1f + 0.03f * lift; scaleX = s; scaleY = s; translationX = swipe; shadowElevation = 12f * lift * density; this.shape = shape; clip = false }
                .then(if (isAnchor) Modifier.border(2.dp, Brand.Orange.copy(alpha = 0.55f), shape) else Modifier)
                // Me mencionan: barra lateral de acento naranja.
                .then(if (com.tiecoms.app.core.Mentions.mentionsMe(m, data.me.id)) Modifier.drawBehind {
                    drawRoundRect(Brand.Orange, size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height), cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()))
                }.testTag("mentionedMe-${m.seq}") else Modifier)
                .background(if (item.mine) chat.mineBubble else chat.otherBubble, shape)
                .combinedClickable(onClick = {}, onLongClick = openMenu, onLongClickLabel = menuLabel)
                // Clic derecho con ratón o panel táctil: el mismo menú.
                .pointerInput(m.id) {
                    awaitPointerEventScope {
                        while (true) {
                            val e = awaitPointerEvent()
                            if (e.type == androidx.compose.ui.input.pointer.PointerEventType.Press && e.buttons.isSecondaryPressed) { onLongPress(); e.changes.forEach { it.consume() } }
                        }
                    }
                }
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
            m.forwarded?.takeIf { it.messageId != null }?.let { f ->
                // Respuesta en privado: el servidor agrega forwarded.excerpt y messageSeq (el cliente no manda el extracto).
                val from = f.fromConversationId?.let { cid -> data.conversations.firstOrNull { it.id == cid } }
                val quote = f.excerpt?.takeIf { it.isNotBlank() }
                    ?: f.fromConversationId?.let { cid -> LocalClient.current.state.collectAsStateWithLifecycle().value.conversations[cid]?.messages?.firstOrNull { it.id == f.messageId }?.body }?.let { excerpt(it, 200) }
                    ?: ""
                val base = if (item.mine) stringResource(R.string.reply_private_label, quote)
                    else stringResource(R.string.reply_private_label_them, Names.person(data, m.authorId)?.name ?: "", quote)
                val label = if (from != null) base + " " + stringResource(R.string.reply_private_in, titleOf(ctx, from, data)) + " · " + stringResource(R.string.reply_private_open) else base
                Surface(color = fg.copy(alpha = 0.12f), shape = RoundedCornerShape(8.dp), modifier = Modifier.padding(bottom = 4.dp)
                    .clickable(enabled = from != null) { from?.let { onOpenConversation(it.id, f.messageSeq) } }.testTag("privateReplyTag")) {
                    Text("✉ $label", Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = fg, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
            m.forwarded?.takeIf { it.messageId == null }?.let { f ->
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
                    // Lo que vuelve de un sidechat se muestra como «Desde un sidechat», sin revelar más que el resumen.
                    Text("↩ " + (if (m.mergedKind == "side") stringResource(R.string.side_from_sidechat)
                        else child?.let { stringResource(R.string.lin_result_of, titleOf(ctx, it, data)) } ?: stringResource(R.string.lin_result_hidden)),
                        style = MaterialTheme.typography.labelSmall, color = fg, fontWeight = FontWeight.SemiBold)
                    if (child != null) TextButton(onClick = { onOpenConversation(child.id, null) }) { Text(stringResource(R.string.lin_open), color = fg) }
                }
            }
            if (!deleted && m.attachments.isNotEmpty()) {
                val media = m.attachments.filter { it.isImage || it.isVideo }
                AttachmentsBlock(m.attachments, fg, onOpenMedia = { i -> onOpenMedia(media, i) }, onOpenFile = onOpenFile, mine = item.mine, onCreateIssue = onVoiceIssue)
            }
            if (deleted) Text(body, color = fg, style = MaterialTheme.typography.bodyLarge, fontStyle = FontStyle.Italic)
            else if (body.isNotBlank() || m.attachments.isEmpty()) MessageText(body, m.mentions, fg, data, onPerson = onPerson, modifier = Modifier.testTag("body-${m.seq}"))
            m.linkPreview?.takeIf { !deleted && it.usable }?.let { LinkPreviewCard(it, fg, Modifier.padding(top = 6.dp)) }
            Text(
                listOfNotNull(if (pinnedHere && item.mine) "📌" else null, time, if (m.editedAt != null && !deleted) stringResource(R.string.msg_edited) else null).joinToString(" "),
                style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = 0.75f), modifier = Modifier.align(Alignment.End),
            )
        }
        AnchoredMenu(menuOpen, if (menuOpen) menuItems() else emptyList(), onDismissMenu)
        }
        }
        SideChip(sides, onOpenSide)
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
        ) {
            val all = p.attachments + p.forwardAttachments
            if (all.isNotEmpty()) Text(com.tiecoms.app.core.Attachments.preview(all, "", attLabels(LocalContext.current)), color = chat.onMine, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            if (p.body.isNotBlank()) Text(p.body, color = chat.onMine, style = MaterialTheme.typography.bodyLarge)
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
