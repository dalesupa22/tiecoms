package com.tiecoms.app.ui

import android.view.HapticFeedbackConstants
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.draw.clip
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.ui.focus.focusRequester
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
import androidx.compose.material.icons.filled.Search
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.ui.unit.sp
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.coroutineScope
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.material.icons.automirrored.filled.Reply
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
    /** Línea «N mensajes nuevos» antes del primer no leído (queda hasta salir del chat). */
    data class NewDivider(val count: Int) : ChatItem { override val key = "new" }
}

/** Cronológico → invertido (índice 0 = lo más nuevo, para reverseLayout). */
internal fun buildItems(messages: List<MessageDTO>, pending: List<PendingMessage>, me: String?, hasMore: Boolean, loading: Boolean, lateJoin: Boolean,
                        dividerSeq: Long? = null, dividerCount: Int = 0): List<ChatItem> {
    val confirmed = messages.mapNotNull { it.clientMessageId }.toSet()
    val out = mutableListOf<ChatItem>()
    if (hasMore && loading) out += ChatItem.Older
    if (!hasMore && lateJoin) out += ChatItem.LateJoin
    var lastDay: LocalDate? = null
    var prev: MessageDTO? = null
    for (m in messages) {
        val day = localDate(m.createdAt)
        if (day != null && day != lastDay) { out += ChatItem.Day(day); lastDay = day; prev = null }
        if (m.seq == dividerSeq) { out += ChatItem.NewDivider(dividerCount); prev = null }
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
private fun systemPayload(body: String): JsonObject? = if (body.length <= 32_768 && body.startsWith("{")) runCatching { TcJson.parseToJsonElement(body) as JsonObject }.getOrNull() else null
private fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    id: String,
    jumpSeq: Long? = null,
    /** Push de reacción: saltar al mensaje por id (el aviso no trae el seq). */
    jumpMessageId: String? = null,
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
    /** Tema que trae el aviso o el enlace (?t=): pista para el filtro si el mensaje no se puede cargar. */
    jumpTopicId: String? = null,
    /** Burbuja flotante de Android (1.7.5): embebida, pero con la fila de temas y las etiquetas, para quedar en el tema. */
    bubble: Boolean = false,
    /** Burbuja ya abierta: salto pedido por un aviso nuevo (seq o messageId) y un contador para repetirlo. */
    bubbleJump: Pair<Long?, String?>? = null,
    bubbleJumpKey: Int = 0,
) {
    // Fila de temas: a pantalla completa y en la burbuja; no en el panel de un sidechat.
    val showTopics = !embedded || bubble
    val client = LocalClient.current
    val container = LocalContainer.current
    val ctx = LocalContext.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val leaveFocus = androidx.compose.ui.platform.LocalFocusManager.current
    val leaveKeyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val leaveChat = { leaveFocus.clearFocus(force = true); leaveKeyboard?.hide(); onBack() }
    val state by client.state.collectAsStateWithLifecycle()
    val data = state.data
    val meta = data?.conversations?.firstOrNull { it.id == id }
    val convFallback = stringResource(R.string.conversation)

    if (data == null || meta == null) {
        SimpleScaffold(title = convFallback, onBack = leaveChat) {
            Text(stringResource(R.string.chat_not_found), Modifier.padding(24.dp).testTag("notFound"), textAlign = TextAlign.Center)
        }
        return
    }

    val conv = state.conversations[id]
    // Velocidad (1.7.0): tocar el chat → primer fotograma con mensajes (TcPerf).
    val perfEnteredAt = remember(id) { android.os.SystemClock.uptimeMillis() }
    val perfFromMemory = remember(id) { client.state.value.conversations[id]?.loaded == true }
    var perfDone by remember(id) { mutableStateOf(false) }
    if (!perfDone && conv?.messages?.isNotEmpty() == true) LaunchedEffect(id) {
        androidx.compose.runtime.withFrameNanos { }; perfDone = true
        com.tiecoms.app.platform.Perf.chatDrawn(id, perfEnteredAt, perfFromMemory)
    }
    val title = titleOf(ctx, meta, data)
    val orgs = Names.participantOrgs(meta, data).joinToString(" · ") { it.name }
    val muted = meta.mutedAt(System.currentTimeMillis())
    var loadError by remember { mutableStateOf<String?>(null) }
    /** Reintentando la carga tras un fallo transitorio (502 durante un despliegue, red): «Reconectando…». */
    var loadRetrying by remember { mutableStateOf<com.tiecoms.app.core.ChatRecovery.Kind?>(null) }
    /** El último fallo de carga fue transitorio: al volver el socket se reintenta solo. */
    var loadTransient by remember { mutableStateOf(false) }
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
    /** Sube al elegir responder (menú o deslizar): el compositor toma el foco y abre el teclado. */
    var replyFocus by remember { mutableIntStateOf(0) }
    var editing by remember { mutableStateOf<MessageDTO?>(null) }
    var deriving by remember { mutableStateOf<MessageDTO?>(null) }
    var newIssue by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var meeting by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var forwarding by remember { mutableStateOf<MessageDTO?>(null) }
    var fileTask by remember { mutableStateOf<com.tiecoms.app.core.AttachmentDTO?>(null) }
    /** Reenviar la tarjeta de un correo o WhatsApp a otros chats (su emailId). */
    var forwardCard by remember { mutableStateOf<String?>(null) }
    var reminderCustom by remember { mutableStateOf<Pair<Boolean, MessageDTO?>?>(null) }
    var bringing by rememberSaveable { mutableStateOf(false) }
    /** «Crear asunto: …» sugerido por la transcripción de una nota de voz. */
    var voiceIssue by remember { mutableStateOf<Pair<String, MessageDTO>?>(null) }
    /** Visor de fotos y videos abierto: lista del mensaje e índice. */
    var viewer by remember { mutableStateOf<Pair<List<com.tiecoms.app.core.AttachmentDTO>, Int>?>(null) }
    /** Visor de PDF abierto (adjunto y si entra directo a firmar). */
    var pdfViewer by remember { mutableStateOf<Pair<com.tiecoms.app.core.AttachmentDTO, Boolean>?>(null) }
    // Al girar el teléfono el visor sigue abierto (se guarda «id|firmar» y se busca el adjunto otra vez).
    var pdfSaved by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(state.conversations[id]?.messages) {
        val saved = pdfSaved
        if (pdfViewer == null && saved != null) {
            val attId = saved.substringBefore('|')
            state.conversations[id]?.messages?.flatMap { it.attachments }?.firstOrNull { it.id == attId }?.let { pdfViewer = it to saved.endsWith("|1") }
        }
    }
    var showPins by rememberSaveable { mutableStateOf(false) }
    var returning by rememberSaveable { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<MessageDTO?>(null) }
    var confirmLeave by rememberSaveable { mutableStateOf(false) }
    var reportMessage by remember { mutableStateOf<MessageDTO?>(null) }
    /** Selector completo de emojis abierto desde «＋» de la barra rápida. */
    var pickerFor by remember { mutableStateOf<MessageDTO?>(null) }
    /** Reunión con enlace real (1.6.6): true = ahora, false = agendada; null = cerrado. */
    var meetingLink by rememberSaveable { mutableStateOf<Boolean?>(null) }
    // Temas (docs/TEMAS.md): null = «General» (así abre el chat), Topics.ALL = «Todo», o el id de un tema, que además es
    // el tema de lo que escribo.
    val topics = state.topics[id].orEmpty()
    // Sin fila de temas (panel embebido) se abre en «Todo», para no esconder mensajes de un tema sin forma de cambiarlo.
    var topicFilter by rememberSaveable(id) { mutableStateOf<String?>(if (showTopics) null else com.tiecoms.app.core.Topics.ALL) }
    val shownFilter = com.tiecoms.app.core.Topics.validFilter(topics, topicFilter)
    val activeTopic = com.tiecoms.app.core.Topics.composeTopic(topics, topicFilter)?.let { f -> topics.firstOrNull { it.id == f } }
    val topicById = remember(topics) { topics.associateBy { it.id } }
    /** «＋ Nuevo tema» desde el menú de un mensaje: al crearlo, el mensaje queda con ese tema. */
    var topicNewFor by remember { mutableStateOf<MessageDTO?>(null) }
    val snackbar = LocalSnackbar.current
    val mailNav = LocalMailNav.current
    // gg de este chat (contrato 1-oct-2026, parte B): no en el chat con gg ni en un panel embebido.
    val ggWithAssistant = data.assistantId != null && meta.kind == "direct" && data.assistantId in meta.memberIds
    val gg = rememberGgSide(com.tiecoms.app.core.GgSide.conversation(id), enabled = !embedded && !ggWithAssistant && !client.ggSideMissing)
    /** «Seleccionar» (pulsación larga): varios mensajes para «✨ Pedir a gg (N)». */
    var selecting by remember(id) { mutableStateOf(false) }
    val selectedIds = remember(id) { androidx.compose.runtime.mutableStateListOf<String>() }
    LaunchedEffect(gg?.open) { if (gg?.open == false) { selecting = false; selectedIds.clear(); gg.quoted.clear() } }
    var suggestFor by remember { mutableStateOf<List<String>?>(null) }
    /** Sugerencias marcadas que se van abriendo una a una (cada una en su diálogo, nada se ejecuta solo). */
    var ggQueue by remember { mutableStateOf(listOf<com.tiecoms.app.core.GgSuggestion>()) }

    val conversationFocus = androidx.compose.ui.platform.LocalFocusManager.current
    val conversationKeyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val conversationLifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    androidx.compose.runtime.DisposableEffect(id, client.sessionGeneration) {
        val lifecycle = conversationLifecycle
        val observer = androidx.lifecycle.LifecycleEventObserver { _, e -> if (e == androidx.lifecycle.Lifecycle.Event.ON_STOP) { conversationFocus.clearFocus(force = true); conversationKeyboard?.hide() } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); conversationFocus.clearFocus(force = true); conversationKeyboard?.hide() }
    }
    val listState = rememberLazyListState()
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }
    val me = data.me.id
    val readProgress = remember(id, me) { com.tiecoms.app.core.ReadProgress() }
    var readLoadFailed by remember(id) { mutableStateOf(false) }
    var readSaveFailed by remember(id) { mutableStateOf(false) }
    var readRetry by remember(id) { mutableIntStateOf(0) }
    var retryJumpSeq by remember(id) { mutableStateOf<Long?>(null) }
    var retryUnread by remember(id) { mutableStateOf(false) }
    val blockedDirect = meta.kind == "direct" && meta.memberIds.any { it in state.blockedUserIds }
    val pending = state.pending.filter { it.conversationId == id }
    // Foto al entrar, antes de marcar leído: hasta dónde leí y cuántos no leídos había (1.6.4 §D).
    val entry = remember(id) { Triple(meta.lastReadSeq, meta.unread, meta.unreadMentions) }
    /** Primer no leído: ahí va la línea «N mensajes nuevos». */
    var dividerSeq by remember(id) { mutableStateOf<Long?>(null) }
    /** Ya se colocó la vista al abrir (en el primer no leído o al final); hasta entonces no se marca leído. */
    var positioned by remember(id) { mutableStateOf(entry.second <= 0 || (jumpSeq ?: 0) > 0 || jumpMessageId != null) }
    /** Mensajes a los que se saltó (mención, enlace, ?m=): quedan a la vista. */
    val revealed = remember(id) { androidx.compose.runtime.mutableStateListOf<Long>() }
    val activeTopicIds = remember(topics) { com.tiecoms.app.core.Topics.activeIds(topics) }
    val items = remember(conv?.messages, pending, conv?.hasMore, conv?.loading, state.blockedUserIds, dividerSeq, shownFilter, if (activeTopicIds.isNotEmpty()) state.issues else null,
        activeTopicIds, revealed.toList()) {
        val tid = activeTopic?.id
        // Un tema: sus mensajes y las tarjetas de sus tareas. «General»: lo sin tema. «Todo»: todo, con su etiqueta.
        buildItems(com.tiecoms.app.core.Topics.view((conv?.messages ?: emptyList()).filter { it.authorId !in state.blockedUserIds }, topics, shownFilter, revealed.toSet()) { iid -> state.issues[iid]?.topicId },
            when { shownFilter == com.tiecoms.app.core.Topics.ALL -> pending; tid != null -> pending.filter { it.topicId == tid }
                else -> pending.filter { it.topicId == null || it.topicId !in activeTopicIds } }, me, conv?.hasMore ?: false, conv?.loading ?: false, meta.historyFromSeq > 0,
            dividerSeq, entry.second)
    }
    val topicCounts = remember(conv?.messages) { com.tiecoms.app.core.Topics.counts(conv?.messages.orEmpty()) }
    // Sin leer por banderita (clave "" = sin tema, el número de «General»), con lo leído en vivo.
    val readNow = maxOf(meta.lastReadSeq, meta.historyFromSeq)
    val topicUnread = remember(conv?.messages, readNow, activeTopicIds, me) { com.tiecoms.app.core.Topics.unread(conv?.messages.orEmpty(), activeTopicIds, readNow, me) }
    val itemsNow by androidx.compose.runtime.rememberUpdatedState(items)
    // «Seguir el final»: solo cambia con la lista quieta. Si llega un mensaje durante la animación de otro
    // (mi envío y la respuesta inmediata), atBottom daría falso a mitad de camino y dejaría de seguir.
    var follow by remember(id) { mutableStateOf(true) }
    /** Menciones a mí sin leer al entrar (botón «@»): se quitan al verlas o al saltar a ellas. */
    val mentionQueue = remember(id) { androidx.compose.runtime.mutableStateListOf<Long>() }
    /** Último seq cuando la persona dejó el final; lo que llegue de otros después va en el globo del ⌄. */
    var awaySeq by remember(id) { mutableStateOf<Long?>(null) }
    val newWhileAway = awaySeq?.let { from -> conv?.messages.orEmpty().count { it.seq > from && it.authorId != me && it.authorId !in state.blockedUserIds } } ?: 0
    val byId = remember(conv?.messages, state.blockedUserIds) { (conv?.messages ?: emptyList()).filter { it.authorId !in state.blockedUserIds }.associateBy { it.id } }

    var jumpJob by remember(id) { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    var jumping by remember(id) { mutableStateOf(false) }
    fun jumpTo(seq: Long) {
        jumpJob?.cancel()
        retryJumpSeq = seq; retryUnread = false
        val generation = client.sessionGeneration
        follow = false
        jumpJob = scope.launch {
            jumping = true; readLoadFailed = false
            try {
                if (!client.ensureMessage(id, seq)) { readLoadFailed = true; return@launch }
                if (generation != client.sessionGeneration) return@launch
                val target = client.state.value.conversations[id]?.messages?.firstOrNull { it.seq == seq }
                val topicsNow = client.state.value.topics[id] ?: client.loadTopics(id)
                if (generation != client.sessionGeneration) return@launch
                topicFilter = com.tiecoms.app.core.Topics.jumpFilter(topicsNow, topicFilter, target, jumpTopicId) { iid -> client.state.value.issues[iid]?.topicId }
                if (seq !in revealed) revealed.add(seq)
                var idx = -1
                for (frame in 0 until 30) {
                    withFrameNanos { }
                    idx = itemsNow.indexOfFirst { (it as? ChatItem.Msg)?.m?.seq == seq }
                    if (idx >= 0) break
                }
                if (idx < 0) { readLoadFailed = true; return@launch }
                listState.scrollToItem(idx)
                withFrameNanos { }; withFrameNanos { }
                if (generation != client.sessionGeneration || listState.layoutInfo.visibleItemsInfo.none { it.key == "m-${target?.id}" || (itemsNow.getOrNull(it.index) as? ChatItem.Msg)?.m?.seq == seq }) {
                    readLoadFailed = true; return@launch
                }
                retryJumpSeq = null; retryUnread = false
                mentionQueue.remove(seq); highlight = seq
                delay(2800); highlight = null
            } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; readLoadFailed = true }
            finally { jumping = false }
        }
    }
    fun jumpUnread() {
        if (jumping) return
        retryUnread = true; retryJumpSeq = null
        jumpJob?.cancel()
        val generation = client.sessionGeneration; val requestedFilter = shownFilter
        follow = false
        jumpJob = scope.launch {
            jumping = true; readLoadFailed = false
            try {
                val floor = maxOf(client.meta(id)?.lastReadSeq ?: 0, meta.historyFromSeq)
                while (true) {
                    val c = client.state.value.conversations[id] ?: throw IllegalStateException("History unavailable")
                    if (!com.tiecoms.app.core.ChatNav.needsOlder(c.messages, floor, meta.unread, me, c.hasMore)) break
                    if (!client.loadOlder(id)) throw IllegalStateException("Unread page unavailable")
                    if (generation != client.sessionGeneration || requestedFilter != shownFilter) return@launch
                }
                val c = client.state.value.conversations[id] ?: throw IllegalStateException("History unavailable")
                val messages = com.tiecoms.app.core.Topics.view(c.messages, topics, requestedFilter) { iid -> client.state.value.issues[iid]?.topicId }
                val target = messages.firstOrNull { it.seq > floor && it.authorId != me && it.authorId !in client.state.value.blockedUserIds && it.deletedAt == null && it.kind == "text" }
                if (target == null) { readLoadFailed = true; return@launch }
                jumping = false
                jumpTo(target.seq)
            } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; readLoadFailed = true }
            finally { jumping = false }
        }
    }

    androidx.compose.runtime.DisposableEffect(id) { onDispose { jumpJob?.cancel() } }

    // ---------- Buscar dentro del chat (tanda 1.7) ----------
    var searchOpen by rememberSaveable(id) { mutableStateOf(false) }
    var searchQ by rememberSaveable(id) { mutableStateOf("") }
    var searchNav by remember(id) { mutableStateOf(com.tiecoms.app.core.ChatSearchNav()) }
    var searchLoading by remember(id) { mutableStateOf(false) }
    LaunchedEffect(searchOpen, searchQ) {
        if (!searchOpen || !com.tiecoms.app.core.ChatSearchNav.ready(searchQ)) { searchNav = com.tiecoms.app.core.ChatSearchNav(); return@LaunchedEffect }
        delay(com.tiecoms.app.core.ChatSearchNav.DEBOUNCE_MS)
        searchLoading = true
        try { searchNav = com.tiecoms.app.core.ChatSearchNav().append(client.searchConversation(id, searchQ)) }
        catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; container.toast(errorText(ctx, e)) }
        finally { searchLoading = false }
    }
    fun searchOlder() {
        val nav = searchNav
        if (nav.needsMore) scope.launch {
            searchLoading = true
            runCatching { client.searchConversation(id, searchQ, before = nav.before) }.onSuccess { searchNav = nav.append(it).older() }
            searchLoading = false
        } else searchNav = nav.older()
    }
    val searchHighlight = if (searchOpen && com.tiecoms.app.core.ChatSearchNav.ready(searchQ)) searchQ else null
    // ---------- Confeti y carita triste (tanda 1.7): solo lo que llega en vivo con el chat a la vista ----------
    var confetti by remember(id) { mutableIntStateOf(0) }
    val liveFx = remember(id) { androidx.compose.runtime.mutableStateListOf<String>() }
    var openMax by remember(id) { mutableStateOf<Long?>(null) }

    LaunchedEffect(id, reloadKey) {
        // Velocidad (1.7.0): los bloqueos ya se conocen desde el arranque; se revalidan en paralelo, sin demorar los mensajes.
        launch { runCatching { client.loadBlocks() } }
        loadError = null
        loadRetrying = null
        try {
            com.tiecoms.app.core.ChatRecovery.withRetry(
                attempt = { client.openConversation(id, force = reloadKey > 0) },
                onRetrying = { kind, _ -> loadRetrying = kind },
                wait = { ms -> com.tiecoms.app.core.ChatRecovery.waitOrOnline(ms, client.state) },
            )
            loadRetrying = null; loadTransient = false
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            loadRetrying = null
            loadTransient = com.tiecoms.app.core.ChatRecovery.transient(e)
            // Transitorio agotado: texto claro en vez de «HTTP 502»; permanente (403, 404): el mensaje del servidor.
            loadError = if (loadTransient) ctx.getString(R.string.chat_load_paused) else errorText(ctx, e)
            // Sin mensajes no hay nada que posicionar ni marcar como leído.
            if (client.state.value.conversations[id]?.loaded != true) return@LaunchedEffect
        }
        launch { runCatching { client.loadIssues(conversationId = id) } }
        launch { runCatching { client.loadPins(id) } }
        launch { runCatching { client.loadTopics(id) } }
        launch { runCatching { client.loadEvents(Instant.now().minusSeconds(30L * 86400), Instant.now().plusSeconds(60L * 86400), id) } }
        if (jumpSeq != null && jumpSeq > 0) jumpTo(jumpSeq)
        else if (jumpMessageId != null) {
            val seq = client.ensureMessageId(id, jumpMessageId)
            if (seq != null) jumpTo(seq) else {
                // El mensaje no apareció: al menos el tema que traía el aviso.
                val topicsNow = client.state.value.topics[id] ?: runCatching { client.loadTopics(id) }.getOrDefault(emptyList())
                topicFilter = com.tiecoms.app.core.Topics.jumpFilter(topicsNow, topicFilter, null, jumpTopicId)
                readLoadFailed = true
            }
        }
        else if (!positioned) try {
            // Load back to the unread frontier. A failed page must not position at the end or clear unread.
            fun loaded() = client.state.value.conversations[id]
            readLoadFailed = false
            val floor = maxOf(entry.first, meta.historyFromSeq)
            // Otra carga del mismo chat puede estar en curso (openConversation vuelve sin esperar si ya está cargando):
            // se espera a que termine antes de pedir páginas viejas; si no, loadOlder daba falso y salía «no se pudieron cargar».
            suspend fun settled() = kotlinx.coroutines.withTimeoutOrNull(20_000) {
                client.state.first { st -> st.conversations[id]?.let { it.loaded && !it.loading } ?: true }
            }
            settled()
            while (true) {
                val c = loaded() ?: break
                if (!com.tiecoms.app.core.ChatNav.needsOlder(c.messages, floor, entry.second, me, c.hasMore)) break
                if (!client.loadOlder(id)) {
                    // Falso porque otra carga seguía en curso: esperar y volver a mirar; si no, falló de verdad.
                    if (loaded()?.loading == true) { settled(); continue }
                    throw IllegalStateException("Unread page unavailable")
                }
            }
            val c = loaded()
            val position = com.tiecoms.app.core.ChatNav.position(c?.messages.orEmpty(), floor, entry.second, me, meta.lastMessageSeq, client.state.value.blockedUserIds)
            if (position !is com.tiecoms.app.core.ChatNav.Position.Ready) throw IllegalStateException("Unread history has a gap")
            var seq = position.seq
            if (seq != null) {
                // Todo lo no leído está en un solo tema: el chat abre filtrado en esa banderita, en su primer no leído.
                val topicsNow = client.state.value.topics[id] ?: runCatching { client.loadTopics(id) }.getOrDefault(emptyList())
                val auto = com.tiecoms.app.core.Topics.autoTopic(c?.messages.orEmpty().filter { it.authorId !in client.state.value.blockedUserIds },
                    com.tiecoms.app.core.Topics.activeIds(topicsNow), floor, me)
                if (auto != null) {
                    topicFilter = auto
                    seq = com.tiecoms.app.core.Topics.firstUnreadIn(c?.messages.orEmpty(), auto, floor, me) ?: seq
                }
                dividerSeq = seq
                withFrameNanos { }; delay(30)
                val idx = itemsNow.indexOfFirst { it is ChatItem.NewDivider }
                if (idx >= 0) scrollDividerToTop(listState, idx)
                withFrameNanos { }
            }
            // Menciones sin leer que no quedaron a la vista: el botón «@» salta a ellas.
            if (c != null && entry.third > 0) {
                val visible = listState.layoutInfo.visibleItemsInfo.map { it.key }.toSet()
                val seen = itemsNow.filterIsInstance<ChatItem.Msg>().filter { it.key in visible }.map { it.m.seq }.toSet()
                mentionQueue.addAll(com.tiecoms.app.core.ChatNav.unreadMentionSeqs(c.messages, entry.first, me).filter { it !in mentionQueue && it !in seen })
            }
            positioned = true; follow = atBottom
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            readLoadFailed = true
        }
    }

    // Burbuja ya abierta que recibe otro aviso: salta al mensaje nuevo (y a su tema) sin recrear la pantalla.
    LaunchedEffect(bubbleJumpKey, conv?.loaded == true) {
        val (seq, mid) = bubbleJump ?: return@LaunchedEffect
        if (bubbleJumpKey == 0 || conv?.loaded != true) return@LaunchedEffect
        val s = seq?.takeIf { it > 0 } ?: mid?.let { client.ensureMessageId(id, it) }
        if (s != null) jumpTo(s)
    }

    // Salto pedido para este chat ya abierto (enlace o notificación): sin reabrirlo, así «Todo» no se pierde.
    val chatJump by container.chatJump.collectAsStateWithLifecycle()
    LaunchedEffect(chatJump, conv?.loaded == true) {
        val (cid, seq) = chatJump ?: return@LaunchedEffect
        if (cid != id || embedded || conv?.loaded != true) return@LaunchedEffect
        container.chatJump.value = null
        jumpTo(seq)
    }

    // Tras agotar los reintentos, el socket de vuelta en línea reintenta la carga (el borrador sigue en el compositor).
    LaunchedEffect(state.connection) {
        if (state.connection == com.tiecoms.app.core.ConnectionStatus.ONLINE && loadTransient && loadError != null &&
            client.state.value.conversations[id]?.loaded != true) reloadKey++
    }
    // Un aviso publicado mientras el chat abierto aún no cargaba se retira al verse el contenido.
    LaunchedEffect(conv?.loaded == true) {
        if (conv?.loaded == true && !embedded && container.openConversationId == id) container.notifier.cancel(id)
    }

    // A full-screen conversation clears its notification. Embedded bubble content must
    // retain it: Android destroys the bubble when its backing notification is cancelled.
    val lifecycleOwner = LocalLifecycleOwner.current
    val lifecycleState by lifecycleOwner.lifecycle.currentStateFlow.collectAsStateWithLifecycle()
    DisposableEffect(id, lifecycleOwner, embedded) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_RESUME -> {
                    container.openConversationId = id
                    if (!embedded) container.notifier.cancel(id)
                }
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

    // ⌄ «Ir al final»: a más de ~1 pantalla del final (estimada con el alto medio de las filas visibles).
    val farFromBottom by remember { derivedStateOf {
        val info = listState.layoutInfo; val vis = info.visibleItemsInfo
        vis.isNotEmpty() && listState.firstVisibleItemIndex * (vis.sumOf { it.size } / vis.size) + listState.firstVisibleItemScrollOffset > info.viewportSize.height
    } }
    /** La línea de no leídos quedó por encima de la vista (píldora «↑ N nuevos»). */
    val dividerAbove by remember { derivedStateOf {
        val idx = itemsNow.indexOfFirst { it is ChatItem.NewDivider }
        idx >= 0 && (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: Int.MAX_VALUE) < idx
    } }
    // Notas de voz en orden cronológico: al terminar una, sigue la siguiente (SPEC-v4 §F).
    val voiceOrder = remember(conv?.messages) { conv?.messages.orEmpty().sortedBy { it.seq }.filter { it.deletedAt == null }.flatMap { it.attachments.filter { a -> a.isVoice } } }
    val voiceQueue: (String) -> List<com.tiecoms.app.core.AttachmentDTO> = remember(voiceOrder) { { aid -> voiceOrder.dropWhile { it.id != aid }.drop(1) } }
    val newest = items.firstOrNull()
    // «Seguir el final»: solo cambia con la lista quieta. Si llega un mensaje durante la animación de otro
    // (mi envío y la respuesta inmediata), atBottom daría falso a mitad de camino y dejaría de seguir.
    LaunchedEffect(listState, id) {
        // Solo al terminar un desplazamiento (del usuario o animado): si llegan mensajes nuevos arriba del
        // índice 0, la lista conserva la posición y atBottom cambiaría sin que nadie se haya movido.
        snapshotFlow { listState.isScrollInProgress }.distinctUntilChanged().collect { moving -> if (!moving && positioned) follow = atBottom }
    }
    LaunchedEffect(newest?.key) {
        if (!positioned) return@LaunchedEffect
        val mine = newest is ChatItem.Pending || (newest as? ChatItem.Msg)?.mine == true
        // Arriba, lo nuevo no arrastra al final: se cuenta en el globo del ⌄.
        if (newest != null && highlight == null && !jumping && (follow || mine)) { follow = true; listState.animateScrollToItem(0) }
    }
    LaunchedEffect(atBottom, positioned) {
        if (atBottom) awaySeq = null
        else if (positioned && awaySeq == null) awaySeq = client.state.value.conversations[id]?.messages?.lastOrNull()?.seq ?: 0
    }
    // Una mención que ya se ve en pantalla deja de contar para el botón «@».
    LaunchedEffect(listState, id) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.map { it.key } }.collect { keys ->
            if (mentionQueue.isEmpty() || !positioned) return@collect
            val seen = itemsNow.filterIsInstance<ChatItem.Msg>().filter { it.key in keys }.map { it.m.seq }.toSet()
            mentionQueue.removeAll { it in seen }
        }
    }
    LaunchedEffect(listState, id, positioned) {
        if (!positioned) return@LaunchedEffect
        snapshotFlow { (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) to listState.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) ->
                val c = client.state.value.conversations[id]
                if (total > 0 && last >= total - 3 && c?.hasMore == true && !c.loading && !client.loadOlder(id)) readLoadFailed = true
            }
    }
    LaunchedEffect(id, positioned, lifecycleState, conv?.loaded, conv?.messages, meta.lastReadSeq, readRetry) {
        if (!positioned || conv?.loaded != true || !lifecycleState.isAtLeast(Lifecycle.State.RESUMED)) return@LaunchedEffect
        snapshotFlow {
            val layout = listState.layoutInfo
            layout.visibleItemsInfo.filter { it.offset + it.size > layout.viewportStartOffset + 8 && it.offset < layout.viewportEndOffset - 8 }.map { it.key }.toSet()
        }.collectLatest { keys ->
            // Scrolling/jumping past a row is not reading it. Wait until the viewport settles.
            delay(350)
            val st = client.state.value
            val current = client.meta(id) ?: return@collectLatest
            val loaded = st.conversations[id]?.messages.orEmpty()
            val visible = itemsNow.filterIsInstance<ChatItem.Msg>().filter { it.key in keys }.map { it.m.seq }.toSet()
            val seq = readProgress.observe(current.lastReadSeq, current.historyFromSeq, loaded, visible, me, st.blockedUserIds)
            if (seq > current.lastReadSeq) {
                try { client.markRead(id, seq); readSaveFailed = false }
                catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    readSaveFailed = true
                }
            }
        }
    }


    LaunchedEffect(searchNav.current?.message?.id) { searchNav.current?.let { jumpTo(it.message.seq) } }
    LaunchedEffect(conv?.loaded) { if (conv?.loaded == true && openMax == null) openMax = conv.messages.maxOfOrNull { it.seq } ?: 0L }
    LaunchedEffect(conv?.messages, openMax) {
        val base = openMax ?: return@LaunchedEffect
        if (!lifecycleState.isAtLeast(Lifecycle.State.RESUMED)) return@LaunchedEffect
        conv?.messages.orEmpty().filter { it.seq > base && it.kind == "system" }.forEach { m ->
            val b = com.tiecoms.app.core.System17.parse(m) ?: return@forEach
            if ((b.key == "issue.done" || b.key == "issue.overdue") && Fx.firstTime(ctx, m.id) && !Fx.reduceMotion(ctx)) {
                liveFx.add(m.id)
                if (b.key == "issue.done") confetti++
            }
        }
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
    // Reacciones: solo quien puede publicar, y nunca en mensajes de sistema o eliminados.
    val reactionActions = reactionActionsFor(data)
    val react = rememberReactor(reactionActions)
    // 1.7.13 (54): también las tarjetas de evento, tarea, correo y WhatsApp (el API las acepta desde a673e7e).
    fun canReact(m: MessageDTO) = meta.canPost && com.tiecoms.app.core.Reactions.reactable(m) && !blockedDirect

    fun messageMenu(m: MessageDTO): List<SheetItem?> {
        val mine = m.authorId == me
        val isPinned = m.id in pinned
        // Una sola vista (tanda 1.7): sin editar, reenviar, copiar, fijar ni convertir en tarea (el servidor responde 409).
        if (com.tiecoms.app.core.ViewOnce.blocksActions(m)) return buildList {
            if (meta.canPost) add(SheetItem(ctx.getString(R.string.menu_reply), "↩", tag = "menuReply") { replyTo = m; editing = null; replyFocus++ })
            add(SheetItem(ctx.getString(R.string.menu_mark_unread), "●", tag = "menuUnread") { act { client.markUnread(id, m.seq); container.toast(ctx.getString(R.string.toast_marked_unread)) } })
            if (!mine) add(SheetItem(ctx.getString(R.string.safety_report_message), "⚑", danger = true, tag = "menuReport") { reportMessage = m })
            if (mine) add(SheetItem(ctx.getString(R.string.menu_delete), "🗑", danger = true, tag = "menuDelete") { confirmDelete = m })
        }
        return buildList {
            if (meta.canPost) add(SheetItem(ctx.getString(R.string.menu_reply), "↩", tag = "menuReply") { replyTo = m; editing = null; replyFocus++ })
            // Bloque 1 (docs/GRUPOS.md): responder aquí o en privado por DM al autor (SPEC-v3 §7, en grupos y chats grupales).
            val author = Names.person(data, m.authorId)
            if (!mine && meta.kind != "direct" && m.kind == "text" && author?.kind == "human")
                add(SheetItem(ctx.getString(R.string.menu_reply_private), "✉", tag = "menuReplyPrivate",
                    subtitle = ctx.getString(R.string.menu_reply_private_sub, author.name.substringBefore(' '))) { onPrivateReply(m) })
            // gg (contrato 1-oct-2026): se AGREGA «✨ Preguntar a gg» y «Seleccionar»; no se quita nada del menú.
            if (gg != null && gg.available != false && m.kind == "text" && m.deletedAt == null) {
                add(SheetItem(ctx.getString(R.string.ggs_ask_about).removePrefix("✨").trim(), "✨", tag = "menuAskGg") {
                    gg.quote(com.tiecoms.app.core.GgQuotedDTO(m.id, author?.name ?: "", excerpt(quoteText(ctx, m), 200))); gg.show()
                })
                add(SheetItem(ctx.getString(R.string.ggs_select), "☑", tag = "menuSelect") { selecting = true; if (m.id !in selectedIds) selectedIds.add(m.id) })
            }
            // Bloque 2: responder aparte sin llenar el chat. Hilo con los del chat o sidechat privado; no se juntan con el DM.
            add(null)
            // También en directos y chats grupales (solo «Todos los del chat»); un hilo fuera de un espacio no se deriva otra vez.
            if (!embedded && canWork && myWsRole != "guest" && m.kind == "text" && m.deletedAt == null && !(meta.workspaceId == null && meta.parentId != null))
                add(SheetItem(ctx.getString(R.string.menu_derive), "💬", tag = "menuDerive", subtitle = ctx.getString(R.string.menu_derive_sub)) { deriving = m })
            if (!embedded && m.kind == "text" && m.deletedAt == null)
                add(SheetItem(ctx.getString(R.string.menu_ask_side), "🔒", tag = "menuSide", subtitle = ctx.getString(R.string.menu_ask_side_sub)) { sideStart = m })
            add(null)
            val wholeCopy = if (m.kind == "text") (m.displayBody ?: com.tiecoms.app.core.LongContent.visibleBody(m.body, m.attachments)) else systemText(ctx, m.body, Names.person(data, m.authorId)?.name)
            if (wholeCopy.isNotEmpty()) add(SheetItem(ctx.getString(R.string.menu_copy_text), "⧉") { copyToClipboard(ctx, wholeCopy); container.toast(ctx.getString(R.string.toast_copied)) })
            m.attachments.filter { it.isImage }.forEach { a -> add(SheetItem(ctx.getString(R.string.copy_image) + if (m.attachments.size > 1) " · ${a.name}" else "", "🖼", tag = "copyImage-${a.id}") { scope.launch {
                try { com.tiecoms.app.platform.AttachmentActions.copyImage(ctx, client, a); container.toast(ctx.getString(R.string.toast_copied)) }
                catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; container.toast(errorText(ctx, e)) }
            } }) }
            m.attachments.filter { com.tiecoms.app.core.LongContent.textFile(it) }.forEach { a -> add(SheetItem(ctx.getString(R.string.copy_content) + " · ${a.name}", "⧉", tag = "copyFile-${a.id}") { scope.launch {
                try { com.tiecoms.app.platform.AttachmentActions.copyText(ctx, client, a); container.toast(ctx.getString(R.string.toast_copied)) }
                catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; container.toast(errorText(ctx, e)) }
            } }) }
            add(SheetItem(ctx.getString(R.string.menu_copy_link), "⛓") { copyToClipboard(ctx, messageLink(id, m.seq)); container.toast(ctx.getString(R.string.toast_link_copied)) })
            add(null)
            if (meta.canPost) add(SheetItem(ctx.getString(if (isPinned) R.string.menu_unpin else R.string.menu_pin), "📌", tag = "menuPin") {
                act { client.setMessagePinned(m, !isPinned); container.toast(ctx.getString(if (isPinned) R.string.toast_unpinned else R.string.toast_pinned)) }
            })
            // 🏷 Tema: cualquiera del chat etiqueta cualquier mensaje de texto (docs/TEMAS.md).
            if (meta.canPost && !embedded && m.kind == "text" && m.deletedAt == null)
                add(topicMenuItem(ctx, container, snackbar, m, topics) { topicNewFor = m })
            add(remindMenu(ctx, meta, m) { reminderCustom = true to m })
            add(SheetItem(ctx.getString(R.string.menu_mark_unread), "●", tag = "menuUnread") { act { client.markUnread(id, m.seq); container.toast(ctx.getString(R.string.toast_marked_unread)) } })
            if (canWork) {
                add(null)
                // Los terceros participan en los asuntos pero no los crean (docs/GRUPOS.md).
                if (myWsRole != "guest") add(SheetItem(ctx.getString(R.string.menu_issue), "◆", tag = "menuIssue") { newIssue = true to m })
                add(SheetItem(ctx.getString(R.string.menu_meeting), "📅", tag = "menuMeeting") { meeting = true to m })
            }
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
                navigationIcon = { IconButton(onClick = leaveChat, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                title = {
                    Column {
                        Column(Modifier.clickable(onClick = onDetails).semantics(mergeDescendants = true) { heading() }.testTag("details")) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (meta.kind == "internal") { Icon(Icons.Filled.Lock, stringResource(R.string.internal_cd), Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)) }
                            if (meta.level == "directivo") Text("◆ ", color = Brand.Orange)
                            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f, fill = false).testTag("chatTitle"))
                            if (meta.kind == "direct" && !meta.isSide) Names.otherInDirect(meta, data)?.let { AvailabilityBadge(it.availability) }
                            if (muted) MutedMark(16.dp, tag = "chatMuted")
                        }
                        }
                        // 1.7.1: arriba solo el grupo; debajo, pequeña y gris, la empresa (sin repetirla si el nombre ya la lleva).
                        val ws = data.workspaces.firstOrNull { it.id == meta.workspaceId }
                        if (ws != null && !meta.isSide) {
                            val org = com.tiecoms.app.core.HomeTree.counterpartOrg(data, ws)
                            // Relación pendiente: el nombre que se escribió.
                            val place = com.tiecoms.app.core.GroupsTree.place(data, ws)
                            val orgName = com.tiecoms.app.core.GroupsTree.companyLine(place.pendingName ?: org?.name, title)
                            if (orgName != null) Text(orgName, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.Normal,
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { onOpenWorkspace(ws.id) }.testTag("chatPath"))
                        } else {
                            val parent = meta.parentId?.let { pid -> data.conversations.firstOrNull { it.id == pid } }
                            val head = when {
                                meta.isSide -> listOfNotNull(ctx.getString(R.string.side_title), parent?.let { titleOf(ctx, it, data) }).joinToString(" · ")
                                meta.kind == "multi" -> Names.multiSubtitle(meta, data)
                                meta.kind == "direct" -> Names.directCompany(meta, data) ?: orgs.ifEmpty { null }
                                else -> orgs.ifEmpty { null }
                            }
                            if (!head.isNullOrEmpty()) Text(head, style = MaterialTheme.typography.labelSmall,
                                color = if (meta.isSide) com.tiecoms.app.ui.theme.LocalSideColors.current.fg else MaterialTheme.colorScheme.onSurfaceVariant,
                                fontWeight = if (meta.isSide) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.testTag("chatPath"))
                        }
                    }
                },
                actions = {
                    // 📞 · 🔎 · ⋯ (1.7.13): gg salió de la cabecera y vive abajo, en la píldora sobre la caja; ⓘ salió en 1.7.10
                    // (tocar el nombre abre los detalles, y también está en ⋯), así el nombre gana sitio y termina en «…».
                    // 📞 (docs/LLAMADAS.md): solo con features.calls y si puedo escribir.
                    if (!meta.isSide && !blockedDirect) CallHeaderButtons(meta, data, compact = true)
                    // 🔎 Buscar en el chat (tanda 1.7).
                    IconButton(onClick = { searchOpen = !searchOpen; if (!searchOpen) searchQ = "" }, modifier = Modifier.testTag("chatSearch")) {
                        Icon(Icons.Filled.Search, stringResource(R.string.cs_open))
                    }
                    IconButton(onClick = { convMenu = true }, modifier = Modifier.testTag("convMenu")) { Icon(Icons.Filled.MoreVert, stringResource(R.string.menu_more)) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
            )
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().navigationBarsPadding().imePadding()) {
            ConnectionBanner(state.connection)
            if (searchOpen && !embedded) ChatSearchBar(searchQ, { searchQ = it.take(120) }, searchNav, searchLoading,
                onOlder = { searchOlder() }, onNewer = { searchNav = searchNav.newer() }, onClose = { searchOpen = false; searchQ = "" })
            // «Llamada en curso · Unirse» (GET /conversations/:id/call y el evento call.updated).
            if (!embedded) CallBanner(id, data)
            // Dentro del panel del sidechat, «Llevar al hilo» ya está en ⋯ y la tarjeta del ancla hace de linaje.
            if (!(embedded && meta.isSide)) LineageBar(meta, data, onOpenConversation, onReturn = { returning = true }, onTrazo = onTrazo)
            // Barra de accesos (docs/GRUPOS.md): Fijados · Asuntos · Hilos · Agenda. Dentro de un hilo al lado no se muestra.
            if (!embedded) ChatBar(meta, data, pinned.size, canOpenIssues = canWork && myWsRole != "guest",
                onPins = { showPins = true }, onOpenIssue = onOpenIssue, onNewIssue = { newIssue = true to null }, onNewEvent = { meeting = true to null },
                onOpenEvent = onOpenEvent, onOpenThread = { t -> sideOpen = t })
            // Temas (docs/TEMAS.md): banderitas bajo la barra de accesos, con scroll horizontal.
            if (showTopics) TopicDock(meta, topics, shownFilter, topicCounts, topicUnread, onFilter = { f ->
                topicFilter = f
                scope.launch { runCatching { listState.scrollToItem(0) }; follow = true }
            })
            // Pendientes del árbol (1.6.6): «⑂ N sin leer en X conversaciones de este grupo · Ver».
            if (!embedded) TreeUnreadStrip(meta, data, onOpen = { t -> sideOpen = t })
            if (readLoadFailed || readSaveFailed) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).testTag("readRetry"), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(if (readLoadFailed) R.string.read_load_failed else R.string.read_save_failed), Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
                TextButton(onClick = {
                    if (readLoadFailed) {
                        readLoadFailed = false
                        when { retryUnread -> jumpUnread(); retryJumpSeq != null -> jumpTo(retryJumpSeq!!); else -> { positioned = false; reloadKey++ } }
                    }
                    readSaveFailed = false; readRetry++
                }) { Text(stringResource(R.string.retry)) }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    conv?.loaded != true && loadRetrying != null -> Column(Modifier.align(Alignment.Center).padding(24.dp).testTag("chatRecovering"), horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(12.dp))
                        Text(stringResource(if (loadRetrying == com.tiecoms.app.core.ChatRecovery.Kind.UPDATING) R.string.chat_updating_retrying else R.string.chat_reconnecting),
                            textAlign = TextAlign.Center, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                        Spacer(Modifier.height(12.dp))
                        TextButton(onClick = { reloadKey++ }, modifier = Modifier.testTag("chatRetryNow")) { Text(stringResource(R.string.retry)) }
                    }
                    conv?.loaded != true && loadError != null -> Column(Modifier.align(Alignment.Center).padding(24.dp).testTag("chatLoadError"), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(loadError!!, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { reloadKey++ }, modifier = Modifier.testTag("chatRetry")) { Text(stringResource(R.string.retry)) }
                    }
                    conv?.loaded != true -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                    activeTopic != null && items.none { it is ChatItem.Msg || it is ChatItem.Pending } ->
                        Text(stringResource(R.string.topic_empty, activeTopic.name), Modifier.align(Alignment.Center).padding(32.dp).testTag("topicEmpty"),
                            textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    items.isEmpty() -> Text(stringResource(if (meta.isSide) R.string.side_empty_chat else R.string.no_messages), Modifier.align(Alignment.Center).testTag("sideEmpty"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> androidx.compose.runtime.CompositionLocalProvider(LocalVoiceQueue provides voiceQueue) { LazyColumn(
                        state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize().onGloballyPositioned { listRect = it.boundsInRoot() }.dismissKeyboardOnTouch().testTag("messages"),
                        // Con la hoja del sidechat a medias (teléfono), el relleno deja el ancla por encima de la hoja.
                        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp,
                            bottom = if (showPanel && !wide) (LocalConfiguration.current.screenHeightDp * 0.45f).dp else 8.dp),
                    ) {
                        items(items, key = { it.key }) { item ->
                            when (item) {
                                is ChatItem.Day -> DaySeparator(dayText(ctx, item.date))
                                is ChatItem.Msg -> if (item.m.kind == "system") SystemRow(item.m, data, state.events, onOpenConversation, onOpenIssue, onOpenEvent, canPost = meta.canPost && !blockedDirect,
                                    animate = item.m.id in liveFx,
                                    // Reacciones en las tarjetas (1.7.13): mantener presionado abre la barra y los chips van debajo.
                                    react = if (embedded) null else CardReact(item.m.reactions.filter { me in it.userIds }.map { it.emoji }.toSet(), reactionActions,
                                        enabled = canReact(item.m), onReact = { e, on -> react(item.m, e, on) }, onMore = { pickerFor = item.m }),
                                    // Tarjetas de correo o WhatsApp: responder aquí, en privado y reenviar, como un mensaje normal.
                                    cardActions = if (embedded) null else { cm, emailId ->
                                        val author = Names.person(data, cm.authorId)
                                        CardActions(
                                            reply = if (meta.canPost && !blockedDirect) ({ replyTo = cm; editing = null; replyFocus++ }) else null,
                                            replyPrivately = if (cm.authorId != me && meta.kind != "direct" && author?.kind == "human") ({ onPrivateReply(cm) }) else null,
                                            forward = emailId?.let { e -> { forwardCard = e } },
                                            copyLink = { copyToClipboard(ctx, messageLink(id, cm.seq)); container.toast(ctx.getString(R.string.toast_link_copied)) },
                                        )
                                    })
                                else GgSelectable(selecting, item.m.id in selectedIds, onToggle = { if (item.m.id in selectedIds) selectedIds.remove(item.m.id) else selectedIds.add(item.m.id) }) { MessageBubble(
                                    item, data, quoted = item.m.replyTo?.let { byId[it] }, pinnedHere = item.m.id in pinned, highlighted = highlight == item.m.seq,
                                    issue = openHere.firstOrNull { it.originMessageId == item.m.id },
                                    showAvatars = meta.kind != "direct",
                                    sides = if (embedded) emptyList() else sidesOf(data, id, item.m.id), onOpenSide = { sid -> sideOpen = sid },
                                    threads = if (embedded) emptyList() else threadsOf(data, id, item.m.id).filter { !it.isSide },
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
                                    // 1.7.1: deslizar a la derecha = responder citando (como WhatsApp); el sidechat queda en el menú.
                                    onSwipeReply = if (item.m.deletedAt == null && meta.canPost && !blockedDirect) ({ replyTo = item.m; editing = null; replyFocus++ }) else null,
                                    onOpenFile = { a -> scope.launch { openAttachment(ctx, client, a) } },
                                    onOpenPdf = { a, sign -> pdfViewer = a to sign; pdfSaved = a.id + "|" + (if (sign) "1" else "0") },
                                    canReact = canReact(item.m), reactionActions = reactionActions,
                                    onReact = { e, on -> react(item.m, e, on) }, onMoreReactions = { pickerFor = item.m },
                                    topic = if (!showTopics || item.m.deletedAt != null) null else item.m.topicId?.let { topicById[it] },
                                    highlightQuery = searchHighlight,
                                    topicBy = com.tiecoms.app.core.Topics.setBy(item.m)?.let { by -> if (by == me) stringResource(R.string.common_you_short) else Names.person(data, by)?.name?.substringBefore(' ') ?: "" },
                                ) }
                                is ChatItem.Pending -> PendingBubble(item.p, onRetry = { client.retry(item.p.clientMessageId) }, onDiscard = { client.discard(item.p.clientMessageId) })
                                ChatItem.LateJoin -> Notice(stringResource(R.string.late_join))
                                ChatItem.Older -> Notice(stringResource(R.string.loading_older))
                                is ChatItem.NewDivider -> NewMessagesDivider(item.count)
                            }
                        }
                    } }
                }
                ConfettiOverlay(confetti)
                if (selecting) GgSelectionBar(selectedIds.size, onAsk = { suggestFor = selectedIds.toList() }, onCancel = { selecting = false; selectedIds.clear() },
                    Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp))
                if (conv?.loaded == true && items.isNotEmpty()) {
                    // Píldora «↑ N nuevos»: la línea de no leídos quedó arriba; tocar salta a ella.
                    val pertinentUnread = if (shownFilter == com.tiecoms.app.core.Topics.ALL || topics.isEmpty()) meta.unread else topicUnread[shownFilter ?: ""] ?: 0
                    if (dividerAbove && pertinentUnread > 0) {
                        val pillCd = stringResource(R.string.jump_new)
                        Surface(
                            onClick = { jumpUnread() },
                            shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary, shadowElevation = 3.dp,
                            modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp).semantics { contentDescription = pillCd }.testTag("jumpNew"),
                        ) { Text(stringResource(R.string.chat_new_pill, pertinentUnread), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) }
                    }
                    Column(Modifier.align(Alignment.BottomEnd).padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        // «@»: siguiente mención a mí sin leer; desaparece cuando no quedan.
                        if (mentionQueue.isNotEmpty()) SmallFloatingActionButton(onClick = { mentionQueue.firstOrNull()?.let { jumpTo(it) } },
                            containerColor = Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), contentColor = Color.White, modifier = Modifier.testTag("jumpMention")) {
                            Text("@", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.semantics { contentDescription = ctx.getString(R.string.jump_mention) })
                        }
                        // ⌄ «Ir al final», con globo de los que llegaron mientras estaba arriba.
                        if (farFromBottom || (!atBottom && newWhileAway > 0)) Box {
                            SmallFloatingActionButton(onClick = { scope.launch { listState.animateScrollToItem(0); follow = true; awaySeq = null } },
                                modifier = Modifier.testTag("jumpLatest")) {
                                Icon(Icons.Filled.KeyboardArrowDown, stringResource(R.string.jump_latest))
                            }
                            if (newWhileAway > 0) Box(Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-4).dp).widthIn(min = 20.dp)
                                .background(Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), CircleShape).padding(horizontal = 5.dp, vertical = 1.dp).testTag("jumpLatestCount"),
                                contentAlignment = Alignment.Center) {
                                Text(if (newWhileAway > 99) "99+" else newWhileAway.toString(), color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                            }
                        }
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
                    stringResource(R.string.reply_private_to, privateHere.authorName ?: "") + " · «" + excerpt(quoteText(ctx, privateHere.source), 100) + "»",
                    stringResource(R.string.reply_cancel), { container.privateReply.value = null }, "privateReplyBar",
                )
                // Sidechat: respuestas rápidas del lado de quien recibe (la última palabra no es mía).
                if (meta.isSide) {
                    val lastHuman = conv?.messages?.lastOrNull { it.kind == "text" && it.deletedAt == null }
                    if (lastHuman != null && lastHuman.authorId != me) SideQuickReplies(onSend = { t -> client.send(id, t) }, onAsk = { sideAddHere = true })
                }
                // Sidechat abierto desde un asunto: «◆ asunto · ☑ 1/3 · ＋ Tarea».
                meta.sideIssueId?.let { SideIssueStrip(id, it, onOpen = onOpenIssue) }
                // Mensajes programados de este chat (solo los veo yo): «🕒 N programados · el próximo sale … · Ver».
                ScheduledStrip(id)
                // gg abajo (1.7.13): «✨ Preguntar a gg» / «✨ Continuar con gg» con su ✕ (se esconde en este chat).
                GgAskPill(gg)
                GgQuickReplies(gg) { t -> GgDrafts.put(id, t) }
                val composerReplyId = replyTo?.id
                Composer(
                id, title, data, replyTo, editing,
                onCancelReply = { replyTo = null }, onCancelEdit = { editing = null },
                onSend = { text, att, mentions, once ->
                    view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    if (privateHere != null) {
                        val src = privateHere.source
                        client.send(id, text, null, com.tiecoms.app.core.ForwardedInfo("tiecoms", privateHere.authorName, src.createdAt, src.conversationId, src.id), attachments = att, mentions = mentions)
                        container.privateReply.value = null
                    } else client.send(id, text, composerReplyId, attachments = att, mentions = mentions, topicId = activeTopic?.id, viewOnce = once)
                    replyTo = null
                },
                onSaveEdit = { m, text, mentions ->
                    editing = null
                    if (text.isNotBlank() && (text.trim() != m.body || mentions != m.mentions + com.tiecoms.app.core.Refs.tokens(m))) act { client.editMessage(m.id, text, mentions) }
                },
                onAskSide = { pid -> conv?.messages?.lastOrNull { it.kind == "text" && it.deletedAt == null }?.let { last -> sidePreselect = listOf(pid); sideStart = last } },
                onBring = { bringing = true },
                placeholderOverride = if (meta.isSide) sidePlaceholder else activeTopic?.let { stringResource(R.string.topic_placeholder, it.name) },
                onNewEvent = { meeting = true to null }, onNewIssue = if (myWsRole != "guest") ({ newIssue = true to null }) else null,
                onMeeting = if (canWork) ({ now -> meetingLink = now }) else null,
                onMail = if (data.mailEnabled && canWork) ({ mailNav.openList(id) }) else null,
                onWhatsApp = if (data.mailEnabled && canWork) mailNav.openWhatsApp else null,
                autoFocus = embedded, focusSignal = replyFocus,
                canSchedule = privateHere == null, onScheduled = { replyTo = null },
                // «✨ Responder por mí» en el «＋»: las 3 burbujitas, solo si lo último es de otra persona y al tocar (no gasta IA solo).
                onGgSpark = if (gg != null && gg.available != false && com.tiecoms.app.core.GgSide.lastIsFromOther(conv?.messages.orEmpty().filter { it.authorId !in state.blockedUserIds }, me)) ({ gg.loadQuick() }) else null,
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
    if (sideReturn && sideMeta != null) {
        if (sideMeta.isSide) SideReturnSheet(sideMeta, title, onClose = { sideReturn = false }, onReturned = { _, seq -> sideOpen = null; seq?.let { jumpTo(it) } })
        // Hilo: «✓ Resolver y dejar el resultado» deja el resumen en este chat.
        else ReturnDialog(sideMeta, title, onClose = { sideReturn = false }, onReturned = { _, seq -> sideOpen = null; seq?.let { jumpTo(it) } })
    }
    personCard?.let { pid -> PersonCardSheet(pid, onClose = { personCard = null }, onDirect = { uid -> act { val cid = client.createChat(listOf(uid), null).id; kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { onOpenConversation(cid, null) } } }) }
    sideStart?.let { m -> SideStartSheet(meta, m, onClose = { sideStart = null; sidePreselect = emptyList() }, onStarted = { sid -> sideOpen = sid }, preselect = sidePreselect) }

    // ---------- gg de este chat: hoja, sugerencias de varios mensajes y su cola de diálogos ----------
    gg?.let { g ->
        GgSideSheet(g, onUseDraft = { t -> GgDrafts.put(id, t) },
            onAction = { a -> ggQueue = listOf(com.tiecoms.app.core.GgSuggestion(id = "draft-action", kind = a.kind, title = a.title,
                params = kotlinx.serialization.json.JsonObject(listOfNotNull(a.assigneeName?.let { "assigneeName" to kotlinx.serialization.json.JsonPrimitive(it) },
                    a.due?.let { "due" to kotlinx.serialization.json.JsonPrimitive(it) }).toMap()))) },
            onJump = { mid -> scope.launch { client.ensureMessageId(id, mid)?.let { jumpTo(it) } } })
        if (!g.open && suggestFor == null) GgConsentDialog(g)
        suggestFor?.let { ids ->
            GgSuggestSheet(g, ids, onRun = { l -> ggQueue = ggRunOrder(l); selecting = false; selectedIds.clear() },
                onFreeAsk = { t ->
                    ids.forEach { mid -> byId[mid]?.let { m -> g.quote(com.tiecoms.app.core.GgQuotedDTO(m.id, Names.person(data, m.authorId)?.name ?: "", excerpt(quoteText(ctx, m), 200))) } }
                    g.ask(t, ids); g.show(); selecting = false; selectedIds.clear()
                },
                onClose = { suggestFor = null })
        }
    }
    val ggHead = ggQueue.firstOrNull()
    fun ggNext() { ggQueue = ggQueue.drop(1) }
    LaunchedEffect(ggHead) {
        val s = ggHead ?: return@LaunchedEffect
        when (s.kind) {
            "task", "reminder" -> Unit
            "summary" -> { gg?.let { g -> g.ask(ctx.getString(R.string.ggs_summarize), s.forMessageIds); g.show() }; ggNext() }
            "message_person" -> {
                ggNext()
                val p = com.tiecoms.app.core.GgSide.matchPerson(s.param("personName") ?: s.param("name") ?: s.param("assigneeName"), data.people)
                    ?: s.param("personId")?.let { pid -> Names.person(data, pid) }
                if (p != null) runCatching { openDirect(client, data, p.id) }.onSuccess { cid -> GgDrafts.put(cid, s.draft ?: s.title); onOpenConversation(cid, null) }
                    .onFailure { container.toast(errorText(ctx, it)) }
            }
            else -> { GgDrafts.put(id, s.draft ?: s.title); ggNext() }
        }
    }
    if (ggHead != null) androidx.compose.runtime.key(ggHead.id + "|" + ggQueue.size) {
        when (ggHead.kind) {
            "task" -> NewIssueDialog(id, ggHead.forMessageIds.firstOrNull(), ggHead.param("title") ?: ggHead.title, onClose = { ggNext() }, onCreated = {},
                defaultOwnerId = com.tiecoms.app.core.GgSide.matchPerson(ggHead.param("assigneeName"), data.people.filter { it.id in meta.memberIds })?.id,
                defaultDue = com.tiecoms.app.core.GgSide.dueDate(ggHead.param("due")))
            "reminder" -> ReminderDialog(meta, ggHead.forMessageIds.firstOrNull()?.let { byId[it] }, onClose = { ggNext() }, defaultNote = ggHead.param("title") ?: ggHead.title)
        }
    }

    topicNewFor?.let { m -> TopicSheet(id, topics, edit = null, onClose = { topicNewFor = null }, onSaved = { t -> tagWithNewTopic(ctx, container, snackbar, m, t) }) }
    forwardCard?.let { e -> ForwardCardSheet(e, onClose = { forwardCard = null }, onDone = { cid -> forwardCard = null; onOpenConversation(cid, null) }) }
    reportMessage?.let { ReportDialog(it.authorId, it.id, onClose = { reportMessage = null }) }
    pickerFor?.let { pm ->
        val live = byId[pm.id] ?: pm
        val mineSet = live.reactions.filter { data.me.id in it.userIds }.map { it.emoji }.toSet()
        EmojiPickerSheet(mineSet, reactionActions, onPick = { e -> react(live, e, e !in mineSet) }, onClose = { pickerFor = null })
    }
    if (convMenu) ActionSheet(title, listOfNotNull(
        // 1.7.13: gg también desde ⋯ (y vuelve a mostrar la píldora si la escondí en este chat).
        gg?.takeIf { it.available != false }?.let { g -> SheetItem(ctx.getString(R.string.ggs_ask_about).removePrefix("✨").trim(), "✨", tag = "menuGgOpen") { g.reopenFromMenu(ctx) } },
        SheetItem(ctx.getString(R.string.cs_open), "🔎", tag = "menuSearch") { searchOpen = true },
        SheetItem(ctx.getString(R.string.details), "ⓘ", tag = "menuDetails") { onDetails() }) +
        conversationMenu(ctx, meta, data, onMeeting = { meeting = true to null }, onRemindCustom = { reminderCustom = true to null }, onLeave = { confirmLeave = true })) { convMenu = false }
    // 1.7.14: desde un archivo abierto, «Preguntar a gg» (citando su mensaje), «Crear tarea» con el archivo y reenviar.
    fun messageOf(a: com.tiecoms.app.core.AttachmentDTO) = conv?.messages?.firstOrNull { m -> m.attachments.any { it.id == a.id } }
    val fileOrigin = FileOrigin(
        askGg = gg?.takeIf { it.available != false }?.let { g -> { a ->
            messageOf(a)?.let { m -> g.quote(com.tiecoms.app.core.GgQuotedDTO(m.id, Names.person(data, m.authorId)?.name ?: "", excerpt(m.body.ifBlank { "📎 " + a.name }, 200))) }
            g.reopenFromMenu(ctx)
        } },
        createTask = if (canWork && myWsRole != "guest" && meta.canPost) ({ a -> fileTask = a }) else null,
        forward = { a -> messageOf(a)?.takeIf { it.kind == "text" }?.let { forwarding = it } },
    )
    androidx.compose.runtime.CompositionLocalProvider(LocalFileOrigin provides fileOrigin) {
        viewer?.let { (list, i) -> MediaViewer(list, i) { viewer = null } }
        pdfViewer?.let { (a, sign) -> PdfSheet(a, startSigning = sign && meta.canPost, onClose = { pdfViewer = null; pdfSaved = null }) }
    }
    fileTask?.let { a ->
        NewIssueDialog(id, messageOf(a)?.id, a.name.substringBeforeLast('.').ifBlank { a.name }.take(200), onClose = { fileTask = null }, onCreated = { iid ->
            fileTask = null
            container.scope.launch {
                try {
                    val local = TaskUploads.localCopy(ctx, client, a)
                    if (TaskUploads.attach(ctx, client, iid, listOf(local)) { msg -> container.toast(msg) } > 0) container.toast(ctx.getString(R.string.fa_task_created))
                } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; container.toast(errorText(ctx, e)) }
            }
            // Sin saltar de pantalla: la tarjeta de la tarea aparece en el chat y el aviso confirma el adjunto.
        })
    }
    voiceIssue?.let { (t, m) -> NewIssueDialog(id, m.id, t, onClose = { voiceIssue = null }, onCreated = onOpenIssue) }
    // El hilo nuevo se abre al lado, sin salir del chat (como un hilo de Slack).
    deriving?.let { m -> DeriveDialog(meta, m, onClose = { deriving = null }, onCreated = { cid -> sideOpen = cid }) }
    newIssue?.let { (_, m) -> NewIssueDialog(id, m?.id, m?.let { excerpt(quoteText(ctx, it)) } ?: "", onClose = { newIssue = null }, onCreated = onOpenIssue) }
    meeting?.let { (_, m) -> EventDialog(id, originMessageId = m?.id, defaultTitle = m?.let { excerpt(quoteText(ctx, it), 80) } ?: "", onClose = { meeting = null }) }
    forwarding?.let { m -> ForwardDialog(m, onClose = { forwarding = null }, onSent = {}) }
    meetingLink?.let { now -> MeetingDialog(id, now, onClose = { meetingLink = null }) }
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
    return buildList {
        onOpen?.let { add(SheetItem(ctx.getString(R.string.menu_open), "↗", onClick = it)) }
        add(SheetItem(ctx.getString(if (pinned) R.string.menu_unpin_top else R.string.menu_pin_top), "📌", tag = "menuPinTop") { act { client.setConversationPrefs(conv.id, pinned = !pinned) } })
        // Pendientes del árbol (1.6.6): con no leídos o menciones aquí o en sus hilos y ramas, «Marcar como leído»
        // marca el grupo y cada derivada hasta lo que la lista conoce (read-tree); si no, «Marcar como no leído».
        if (com.tiecoms.app.core.ReadTree.of(data, conv).markable) add(SheetItem(ctx.getString(R.string.menu_mark_read), "✓", tag = "menuMarkRead") {
            act { client.markTreeRead(conv.id); container.toast(ctx.getString(R.string.toast_marked_read)) }
        })
        else add(SheetItem(ctx.getString(R.string.menu_mark_unread_conv), "●", tag = "menuMarkUnread", enabled = conv.lastMessageSeq > conv.historyFromSeq) {
            act { client.markUnread(conv.id, conv.lastMessageSeq); container.toast(ctx.getString(R.string.toast_marked_unread)) }
        })
        // SPEC-silencio §2: 1 hora · 8 horas · 1 semana · Hasta que lo reactive, o «Reactivar notificaciones».
        add(muteMenuItem(ctx, conv))
        // Sonido de este chat (docs/SONIDOS.md): Predeterminado · Sin sonido · los 10.
        add(soundMenuItem(ctx, conv))
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
    // Los hilos que salen de aquí se ven en la barra del chat y como chip bajo su mensaje.
    if (conv.parentId == null) return
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().testTag("lineage")) {
        FlowRow(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.lin_label).uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.CenterVertically))
            if (conv.parentId != null) {
                if (parent != null) LinChip("↖ " + stringResource(R.string.lin_from, titleOf(ctx, parent, data))) { onOpen(parent.id, conv.parentMessageSeq) }
                else Text("↖ " + stringResource(R.string.lin_from_hidden), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            KindBadge(conv.deriveKind)
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
    onCancelReply: () -> Unit, onCancelEdit: () -> Unit, onSend: (String, List<com.tiecoms.app.core.AttachmentDTO>, List<com.tiecoms.app.core.MentionDTO>, Boolean) -> Unit,
    onSaveEdit: (MessageDTO, String, List<com.tiecoms.app.core.MentionDTO>) -> Unit, onBring: () -> Unit,
    placeholderOverride: String? = null,
    /** «Preguntarle en un sidechat» a alguien que no está en el chat (desde el buscador de menciones). */
    onAskSide: (String) -> Unit = {},
    /** El «＋»: además de fotos y archivos, Evento y Asunto (null lo oculta, p. ej. Asunto para terceros). */
    onNewEvent: (() -> Unit)? = null, onNewIssue: (() -> Unit)? = null,
    /** «📹 Reunión ahora» (true) y «📅 Agendar reunión con enlace» (false). */
    onMeeting: ((Boolean) -> Unit)? = null,
    /** Correo en el chat (docs/CORREO.md): «Correo» abre la lista con este chat como destino; «Mensaje de WhatsApp», la pantalla de WhatsApp. */
    onMail: (() -> Unit)? = null, onWhatsApp: (() -> Unit)? = null,
    autoFocus: Boolean = false,
    /** Cambia al responder (deslizar o menú): foco y teclado arriba. */
    focusSignal: Int = 0,
    /** Mensajes programados (1.6.4 / 23): 🕒 junto a enviar y pulsación larga en ➤. false en respuestas privadas. */
    canSchedule: Boolean = false, onScheduled: () -> Unit = {},
    /** gg «Responder por mí»: pide las 3 burbujitas de respuesta (solo al tocar), desde el «＋». null = no se ofrece. */
    onGgSpark: (() -> Unit)? = null,
) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val draftOwner = client.baseUrl + ":" + client.myId.orEmpty()
    val restored = remember(id, draftOwner) { com.tiecoms.app.platform.ComposerDrafts.load(ctx, draftOwner, id) }
    var text by remember(id, draftOwner) { mutableStateOf(restored.body) }
    // Menciones con @ (SPEC-v4 §H): tokens sobre el texto (UTF-16) y el cursor para el buscador.
    var ments by remember(id, draftOwner) { mutableStateOf(restored.mentions) }
    var sel by remember(id) { mutableStateOf(androidx.compose.ui.text.TextRange(0)) }
    var editMents by remember(editing?.id) { mutableStateOf(editing?.let { it.mentions + com.tiecoms.app.core.Refs.tokens(it) }.orEmpty()) }
    // ① Una sola vista (tanda 1.7) para el próximo mensaje: texto, fotos o nota de voz.
    var viewOnce by remember(id, draftOwner) { mutableStateOf(restored.viewOnce) }
    var editSel by remember(editing?.id) { mutableStateOf(androidx.compose.ui.text.TextRange(editing?.body?.length ?: 0)) }
    // Adjuntos elegidos (copiados a caché) antes de enviar; se suben al pulsar Enviar (SPEC-v4).
    var files by remember(id, draftOwner) { mutableStateOf(restored.files) }
    var creativePicker by remember(id) { mutableStateOf(false) }
    var gif by remember(id, draftOwner) { mutableStateOf(restored.gif) }
    var memeSources by remember(id, draftOwner) { mutableStateOf(restored.sources) }
    var uploading by remember(id) { mutableStateOf<Pair<Int, Float>?>(null) }
    var attError by remember(id) { mutableStateOf<String?>(null) }
    var converting by remember(id) { mutableStateOf(false) }
    LaunchedEffect(id, draftOwner, files, gif, text, memeSources, viewOnce, ments) {
        val draftRevision = com.tiecoms.app.platform.ComposerDrafts.nextRevision()
        val snapshot = com.tiecoms.app.platform.ComposerDrafts.Draft(text, files, gif, memeSources, viewOnce, ments)
        if (draftOwner.isNotEmpty()) try { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            com.tiecoms.app.platform.ComposerDrafts.save(ctx, draftOwner, id, snapshot, draftRevision)
        } } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            attError = ctx.getString(R.string.draft_save_failed)
        }
    }
    LaunchedEffect(id, text, viewOnce, files.size) {
        if (text.length > com.tiecoms.app.core.LongContent.MAX_BODY && editing == null) {
            if (viewOnce) { attError = ctx.getString(R.string.long_once); return@LaunchedEffect }
            if (files.size >= com.tiecoms.app.core.Attachments.MAX_PER_MESSAGE) { attError = ctx.getString(R.string.att_too_many); return@LaunchedEffect }
            val original = text
            converting = true
            try {
                val file = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.tiecoms.app.platform.ComposerDrafts.text(ctx, original) }
                if (text == original) { files = files + file; text = ""; ments = emptyList(); sel = androidx.compose.ui.text.TextRange(0); attError = null }
                else java.io.File(file.path).delete()
            } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; attError = ctx.getString(R.string.long_limit) }
            finally { converting = false }
        }
    }
    var picker by remember { mutableStateOf(false) }
    // Notas de voz (SPEC-v4 §F): mantener pulsado el micrófono cuando el compositor está vacío.
    val voiceOwner = remember(client, id) { client.myId }
    val voiceKey = remember(client, id) { client.baseUrl + ":" + voiceOwner + ":" + id }
    val recorder = remember(id) { com.tiecoms.app.platform.VoiceRecorder(ctx.applicationContext) }
    val rec by recorder.state.collectAsStateWithLifecycle()
    var locked by remember(id) { mutableStateOf(false) }
    var gesture by remember(id) { mutableStateOf(com.tiecoms.app.core.Waveform.Gesture.RECORDING) }
    var micWhy by remember { mutableStateOf(false) }
    var pendingVoice by remember(id) { mutableStateOf<com.tiecoms.app.platform.VoiceRecorder.Result?>(null) }
    val micPermission = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { granted -> attError = ctx.getString(if (granted) R.string.voice_permission_ready else R.string.voice_permission_denied) }
    // Nota grabada sin enviar (envío fallido o grabación cortada): se ofrece Reintentar / Borrar sobre el compositor.
    val drafts by com.tiecoms.app.platform.VoiceDrafts.drafts.collectAsStateWithLifecycle()
    val draft = drafts[voiceKey]
    LaunchedEffect(Unit) { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.tiecoms.app.platform.VoiceRecorder.sweep(ctx.applicationContext) } }
    /** Salir del chat, apagar la pantalla o pasar a segundo plano: lo grabado no se pierde, queda como nota por enviar. */
    fun keepRecording() {
        if (recorder.isRecording) recorder.stop()?.let { com.tiecoms.app.platform.VoiceDrafts.put(voiceKey, com.tiecoms.app.platform.VoiceDrafts.Draft(it)) }
        locked = false
        pendingVoice?.let { com.tiecoms.app.platform.VoiceDrafts.put(voiceKey, com.tiecoms.app.platform.VoiceDrafts.Draft(it)); pendingVoice = null }
    }
    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(recorder, owner) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, e -> if (e == androidx.lifecycle.Lifecycle.Event.ON_STOP && recorder.isRecording) keepRecording() }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs); keepRecording() }
    }
    fun hasMic() = androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED
    fun uploadVoice(r: com.tiecoms.app.platform.VoiceRecorder.Result, aiConsent: Boolean) {
        if (uploading != null) return
        val viewOnceVoice = viewOnce
        pendingVoice = null
        attError = null
        com.tiecoms.app.platform.VoiceDrafts.take(voiceKey)
        // En el scope de la app: salir del chat no corta la subida; si falla, la nota queda para reintentar.
        val voiceGeneration = client.sessionGeneration
        container.scope.launch {
            uploading = 0 to 0f
            try {
                check(client.myId == voiceOwner && client.sessionGeneration == voiceGeneration) { "Session changed; voice draft kept" }
                val a = client.uploadAttachment(id, r.file, ctx.getString(R.string.voice_note) + ".m4a", "audio/mp4",
                    voice = com.tiecoms.app.core.TieComsClient.Voice(r.durationMs, r.waveform, aiConsent)) { sent, total -> uploading = 0 to (if (total > 0) sent.toFloat() / total else 0f) }
                check(client.myId == voiceOwner && client.sessionGeneration == voiceGeneration) { "Session changed; voice draft kept" }
                onSend("", listOf(a), emptyList(), viewOnceVoice)
                viewOnce = false
                r.file.delete()
            } catch (e: Exception) {
                val msg = when (com.tiecoms.app.core.VoiceRules.uploadError(e)) {
                    com.tiecoms.app.core.VoiceRules.UploadError.TOO_LARGE -> ctx.getString(R.string.voice_err_too_large)
                    com.tiecoms.app.core.VoiceRules.UploadError.NETWORK -> ctx.getString(R.string.voice_err_network)
                    com.tiecoms.app.core.VoiceRules.UploadError.OTHER -> errorText(ctx, e)
                }
                com.tiecoms.app.platform.VoiceDrafts.put(voiceKey, com.tiecoms.app.platform.VoiceDrafts.Draft(r, aiConsent, msg))
            } finally { uploading = null }
        }
    }
    fun sendVoice() {
        val r = recorder.stop()
        locked = false
        if (r == null) { attError = ctx.getString(R.string.voice_too_short); return }
        attError = null
        com.tiecoms.app.platform.VoiceDrafts.put(voiceKey, com.tiecoms.app.platform.VoiceDrafts.Draft(r))
    }
    pendingVoice?.let { r ->
        // Cerrar el diálogo no borra la nota: queda por enviar.
        AiConsentDialog(voice = true, onAllow = { uploadVoice(r, true) }, onWithoutAi = { uploadVoice(r, false) },
            onDismiss = { com.tiecoms.app.platform.VoiceDrafts.put(voiceKey, com.tiecoms.app.platform.VoiceDrafts.Draft(r)); pendingVoice = null })
    }
    recorder.onLimit = { container.toast(ctx.getString(R.string.voice_too_long)); sendVoice() }
    if (micWhy) androidx.compose.material3.AlertDialog(
        onDismissRequest = { micWhy = false },
        title = { Text(stringResource(R.string.voice_mic_title)) }, text = { Text(stringResource(R.string.voice_mic_body)) },
        confirmButton = { TextButton(onClick = { micWhy = false; micPermission.launch(android.Manifest.permission.RECORD_AUDIO) }, modifier = Modifier.testTag("micAllow")) { Text(stringResource(R.string.voice_mic_allow)) } },
        dismissButton = { TextButton(onClick = { micWhy = false }) { Text(stringResource(R.string.cancel)) } },
    )
    fun add(uris: List<android.net.Uri>, done: () -> Unit = {}) {
        if (uploading != null) { done(); return }
        if (uris.isEmpty()) { done(); return }
        scope.launch {
            val copied = try {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.tiecoms.app.platform.ShareIntake.copyToCache(ctx.applicationContext, uris, null) }
                    .map { com.tiecoms.app.platform.ImageTools.prepareForUpload(ctx.applicationContext, it) }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                attError = ctx.getString(R.string.paste_image_failed); emptyList()
            } finally { done() }
            if (copied.isEmpty()) return@launch
            if (uploading != null) { copied.forEach { java.io.File(it.path).delete() }; return@launch }
            val plan = com.tiecoms.app.core.Attachments.plan(files + copied, null)
            attError = plan.tooLarge.firstOrNull()?.let { ctx.getString(R.string.att_too_large, it.name) }
                ?: if (plan.dropped > 0) ctx.getString(R.string.att_too_many) else null
            files = plan.files
        }
    }
    val taskDialogs = LocalTaskDialogs.current
    val sideIssue = client.meta(id)?.sideIssueId
    if (creativePicker && com.tiecoms.app.core.CreativeMedia.available(client.meta(id)?.kind)) CreativeMediaPicker(
        onDismiss = { creativePicker = false }, onGif = { gif = it }, onMeme = { file, source ->
            val plan = com.tiecoms.app.core.Attachments.plan(files + file, null)
            files = plan.files
            if (file in files) memeSources = memeSources + (file.path to source)
            else { java.io.File(file.path).delete(); attError = ctx.getString(R.string.att_too_many) }
        })
    AttachPicker(picker && uploading == null, onDismiss = { picker = false }, onPicked = { add(it) }, onEvent = onNewEvent, onIssue = onNewIssue,
        onTask = sideIssue?.let { sid -> { picker = false; taskDialogs.openTasks(sid, id) } },
        onMeetNow = onMeeting?.let { f -> { picker = false; f(true) } }, onMeetSchedule = onMeeting?.let { f -> { picker = false; f(false) } },
        onMail = onMail?.let { f -> { picker = false; f() } }, onWhatsApp = onWhatsApp?.let { f -> { picker = false; f() } },
        // 1.7.13: la ✨ ya no va suelta en la barra (la entrada a gg abajo es la píldora); «Responder por mí» vive en el «＋».
        onGgReply = onGgSpark?.let { f -> { picker = false; f() } })
    // Un hilo o sidechat abierto al lado recibe el cursor.
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(id, autoFocus) { if (autoFocus) { delay(300); runCatching { focus.requestFocus() } } }
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    LaunchedEffect(focusSignal) { if (focusSignal > 0) { withFrameNanos { }; runCatching { focus.requestFocus() }; keyboard?.show() } }
    // Borrador de gg (contrato 1-oct-2026): cae en la caja para editarlo; NUNCA se envía solo.
    val ggPending by GgDrafts.pending.collectAsStateWithLifecycle()
    var ggLabel by remember(id) { mutableStateOf(false) }
    LaunchedEffect(ggPending[id]) {
        val d = GgDrafts.take(id) ?: return@LaunchedEffect
        text = d; ments = emptyList(); sel = androidx.compose.ui.text.TextRange(d.length); ggLabel = true
        withFrameNanos { }; runCatching { focus.requestFocus() }
    }
    LaunchedEffect(text.isBlank()) { if (text.isBlank()) ggLabel = false }
    fun sendNow() {
        if (uploading != null || converting) return
        if (text.length > com.tiecoms.app.core.LongContent.MAX_BODY) { attError = ctx.getString(R.string.long_limit); return }
        val body = text
        val bodyMents = ments.filter { !com.tiecoms.app.core.Fmt.inCode(text, it.start) }
        // ① solo con texto, fotos o nota de voz: con otros archivos no se manda (el servidor respondería 400).
        if (viewOnce && !files.all { it.contentType?.startsWith("image/") == true }) { attError = ctx.getString(R.string.vo_only_photos); return }
        val once = viewOnce
        val selectedGif = gif
        if (files.isEmpty() && selectedGif == null) {
            if (body.isNotBlank()) try { onSend(body, emptyList(), bodyMents, once); viewOnce = false; text = ""; ments = emptyList(); sel = androidx.compose.ui.text.TextRange(0) }
            catch (e: Exception) { attError = errorText(ctx, e) }
            return
        }
        if (files.size + (if (selectedGif != null) 1 else 0) > com.tiecoms.app.core.Attachments.MAX_PER_MESSAGE) { attError = ctx.getString(R.string.att_too_many); return }
        attError = null
        val selectedFiles = files.toList()
        val selectedSources = memeSources.toMap()
        val session = client.sessionGeneration
        val author = client.myId
        fun requireOwner() {
            if (client.sessionGeneration != session || client.myId != author || author == null) throw kotlinx.coroutines.CancellationException("Session changed")
        }
        val send = onSend
        // Set synchronously: a second tap cannot start another import before the coroutine runs.
        uploading = 0 to 0f
        scope.launch {
            try {
                requireOwner()
                val done = mutableListOf<com.tiecoms.app.core.AttachmentDTO>()
                val sources = selectedFiles.mapNotNull { selectedSources[it.path] }.toMutableList()
                if (selectedGif != null) {
                    try {
                        requireOwner()
                        val imported = client.importGif(id, selectedGif)
                        requireOwner()
                        done += imported.attachment
                        sources += imported.attribution ?: com.tiecoms.app.core.CreativeMedia.attribution(selectedGif)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        attError = errorText(ctx, e); uploading = null; return@launch
                    }
                }
                for ((i, f) in selectedFiles.withIndex()) {
                    uploading = i to 0f
                    try {
                        requireOwner()
                        done += com.tiecoms.app.platform.AttachmentUpload.upload(ctx.applicationContext, client, id, java.io.File(f.path), f.name, f.contentType) { sent, total ->
                            uploading = i to (if (total > 0) sent.toFloat() / total else 0f)
                        }
                        requireOwner()
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        attError = ctx.getString(R.string.att_upload_failed, f.name) + " · " + errorText(ctx, e)
                        // Los ya subidos quedan pendientes en el servidor (el worker los borra a las 24 h); se reintenta todo.
                        uploading = null
                        return@launch
                    }
                }
                requireOwner()
                val fullBody = com.tiecoms.app.core.CreativeMedia.body(body, sources)
                require(fullBody.length <= com.tiecoms.app.core.LongContent.MAX_BODY) { ctx.getString(R.string.long_limit) }
                send(fullBody, done, bodyMents, once)
                selectedFiles.forEach { java.io.File(it.path).delete() }
                files = emptyList(); gif = null; memeSources = emptyMap(); viewOnce = false; text = ""; ments = emptyList(); sel = androidx.compose.ui.text.TextRange(0)
            } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; attError = errorText(ctx, e) } finally { uploading = null }
        }
    }
    var editText by rememberSaveable(editing?.id) { mutableStateOf(editing?.let { it.displayBody ?: it.body } ?: "") }
    // Programar: solo texto (con menciones y respuesta); los adjuntos y las notas de voz salen al momento.
    var scheduling by remember { mutableStateOf(false) }
    val snackbar = LocalSnackbar.current
    val view = LocalView.current
    val schedulable = canSchedule && editing == null && files.isEmpty() && gif == null && text.isNotBlank() && uploading == null
    if (scheduling) ScheduleSheet(onDismiss = { scheduling = false }, onPick = { at ->
        val body = text; val bodyMents = ments
        text = ""; ments = emptyList(); sel = androidx.compose.ui.text.TextRange(0)
        scheduleWithUndo(ctx, container, snackbar, id, body, bodyMents, replyTo?.id, at, onUndo = { b -> if (text.isBlank()) { text = b; ments = bodyMents; sel = androidx.compose.ui.text.TextRange(b.length) } })
        onScheduled()
    })
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column {
            // Modo sueño: «Ana está descansando: le llega sin sonar…» y «🕒 Enviar a las 7:00».
            if (editing == null) client.meta(id)?.let { m ->
                SleepNotice(data, m.memberIds, typing = text.isNotBlank(), onSchedule = if (schedulable) ({ at ->
                    val body = text; val bodyMents = ments
                    text = ""; ments = emptyList(); sel = androidx.compose.ui.text.TextRange(0)
                    scheduleWithUndo(ctx, container, snackbar, id, body, bodyMents, replyTo?.id, at, onUndo = { b -> if (text.isBlank()) { text = b; ments = bodyMents; sel = androidx.compose.ui.text.TextRange(b.length) } })
                    onScheduled()
                }) else null)
            }
            if (replyTo != null) Banner(stringResource(R.string.reply_to, Names.person(data, replyTo.authorId)?.name ?: "") + " · " + excerpt(quoteText(LocalContext.current, replyTo), 100), stringResource(R.string.reply_cancel), onCancelReply, "replyBar")
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
                        // Tras la red el texto pudo cambiar: la búsqueda se recalcula sobre el texto y el cursor de ahora.
                        val now = com.tiecoms.app.core.Mentions.query(text, sel.start, ments)
                        if (now != null) {
                            val (t, m, c) = com.tiecoms.app.core.Mentions.insert(text, ments, now.first, sel.start, p.name, p.id); text = t; ments = m; sel = androidx.compose.ui.text.TextRange(c)
                        }
                    }.onFailure { attError = errorText(ctx, it) }
                } }, onAskSide = { p -> onAskSide(p.id) })
                // #grupos (tanda 1.7): al escribir «#» se sugieren las conversaciones que puedo ver.
                val rq = if (q == null) com.tiecoms.app.core.Refs.query(cur, cursor, if (editing != null) editMents else ments) else null
                if (rq != null) RefPicker(rq.second, data, id) { cid, name ->
                    if (editing != null) { val (t, m, c) = com.tiecoms.app.core.Refs.insert(editText, editMents, rq.first, cursor, name, cid); editText = t; editMents = m; editSel = androidx.compose.ui.text.TextRange(c) }
                    else { val (t, m, c) = com.tiecoms.app.core.Refs.insert(text, ments, rq.first, cursor, name, cid); text = t; ments = m; sel = androidx.compose.ui.text.TextRange(c) }
                }
            }
            if (ggLabel && editing == null && text.isNotBlank()) Text("✨ " + stringResource(R.string.ggs_draft_label), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp).testTag("ggDraftLabel"))
            if (!rec.recording) FormatActions(if (editing != null) editText else text, if (editing != null) editSel else sel) { next, selection ->
                fun adjust(old: String, oldSelection: androidx.compose.ui.text.TextRange, tokens: List<com.tiecoms.app.core.MentionDTO>): List<com.tiecoms.app.core.MentionDTO> {
                    val prefix = selection.min - oldSelection.min; val delta = next.length - old.length
                    return tokens.map { m -> m.copy(start = m.start + if (m.start >= oldSelection.max) delta else if (m.start >= oldSelection.min) prefix else 0) }
                        .filter { it.start >= 0 && it.start + it.length <= next.length && !com.tiecoms.app.core.Fmt.inCode(next, it.start) }
                }
                if (editing != null) { editMents = adjust(editText, editSel, editMents); editText = next; editSel = selection }
                else { ments = adjust(text, sel, ments); text = next; sel = selection }
            }
            if (viewOnce && editing == null) Text("① " + stringResource(R.string.vo_next), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp).testTag("viewOnceOn"))
            if (editing == null && files.isNotEmpty()) PendingFiles(files, uploading, onRemove = { f -> if (uploading == null) { files = files - f; memeSources = memeSources - f.path; java.io.File(f.path).delete() } })
            if (editing == null) gif?.let { item ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).testTag("pendingGif"), verticalAlignment = Alignment.CenterVertically) {
                    AnimatedMediaImage(item.previewUrl, item.title, Modifier.size(56.dp))
                    Column(Modifier.weight(1f).padding(8.dp)) {
                        Text(item.title, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(com.tiecoms.app.core.CreativeMedia.attribution(item), style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton(onClick = { gif = null }, enabled = uploading == null, modifier = Modifier.testTag("gifRemove")) { Icon(Icons.Filled.Close, stringResource(R.string.cancel)) }
                }
            }
            if (editing == null && draft != null && !rec.recording) VoiceDraftBar(draft, busy = uploading != null,
                onRetry = { if (draft.aiConsent != null) uploadVoice(draft.result, draft.aiConsent) else { com.tiecoms.app.platform.VoiceDrafts.take(voiceKey); pendingVoice = draft.result } },
                onDelete = { com.tiecoms.app.platform.VoiceDrafts.discard(voiceKey); container.toast(ctx.getString(R.string.voice_cancelled)) })
            attError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp).testTag("attError")) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
                val bringLabel = stringResource(R.string.imp_action)
                val attachLabel = stringResource(R.string.bar_plus)
                if (editing == null) IconButton(onClick = { picker = true }, enabled = uploading == null, modifier = Modifier.size(48.dp).semantics { contentDescription = attachLabel }.testTag("attach")) {
                    Icon(Icons.Filled.Add, null)
                }
                if (editing == null) IconButton(onClick = onBring, modifier = Modifier.size(48.dp).semantics { contentDescription = bringLabel }.testTag("bring")) {
                    Text("⤓", style = MaterialTheme.typography.titleLarge)
                }
                if (editing == null && com.tiecoms.app.core.CreativeMedia.available(client.meta(id)?.kind)) IconButton(onClick = { focusManager.clearFocus(); keyboard?.hide(); creativePicker = true }, enabled = uploading == null && !rec.recording,
                    modifier = Modifier.size(40.dp).testTag("creativeButton").semantics { contentDescription = ctx.getString(R.string.creative_title) }) {
                    Text("GIF", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                }
                if (rec.recording) RecordingBar(rec, locked, gesture, onDelete = { recorder.cancel(); locked = false; container.toast(ctx.getString(R.string.voice_cancelled)) }, onSend = { sendVoice() }, modifier = Modifier.weight(1f))
                else RichPasteScope(enabled = editing == null && uploading == null, onImages = { uris, done -> add(uris, done) }) { OutlinedTextField(
                    value = if (editing != null) androidx.compose.ui.text.input.TextFieldValue(editText, editSel) else androidx.compose.ui.text.input.TextFieldValue(text, sel),
                    onValueChange = { raw ->
                        // 1.7.1: «Pegar» con una imagen en el portapapeles llega como un marcador: se quita y se adjunta.
                        val (clean, cur, pasted) = PasteImages.strip(raw.text, raw.selection.start)
                        val v = if (pasted) androidx.compose.ui.text.input.TextFieldValue(clean, androidx.compose.ui.text.TextRange(cur)) else raw
                        if (pasted && editing == null) {
                            val cm = ctx.getSystemService(android.content.ClipboardManager::class.java)
                            add(PasteImages.imageUris(runCatching { cm?.primaryClip }.getOrNull(), ctx.contentResolver))
                        }
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
                    trailingIcon = if (editing == null) ({ ViewOnceToggle(viewOnce) { viewOnce = !viewOnce } }) else null,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surface, focusedContainerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.weight(1f).focusRequester(focus).testTag("composer"),
                ) }
                Spacer(Modifier.width(8.dp))
                if (editing != null) {
                    FilledIconButton(onClick = { onSaveEdit(editing, editText, editMents) }, enabled = editText.isNotBlank(), modifier = Modifier.size(52.dp).testTag("saveEdit"),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary)) { Icon(Icons.Filled.Check, stringResource(R.string.edit_save)) }
                } else {
                    if (text.isBlank() && files.isEmpty() && gif == null && uploading == null && !locked) {
                        MicButton(
                            onStart = {
                                if (!hasMic()) {
                                    micWhy = true
                                    false
                                } else {
                                    gesture = com.tiecoms.app.core.Waveform.Gesture.RECORDING
                                    recorder.start().also { if (!it) attError = ctx.getString(R.string.voice_start_failed) }
                                }
                            },
                            // Un toque rápido no descarta: deja la grabación bloqueada (manos libres) con Borrar y Enviar.
                            onRelease = { held -> if (com.tiecoms.app.core.VoiceRules.onRelease(held) == com.tiecoms.app.core.VoiceRules.Release.LOCK) locked = true else sendVoice() },
                            onCancel = { recorder.cancel(); container.toast(ctx.getString(R.string.voice_cancelled)) }, onLock = { locked = true }, onDrag = { gesture = it },
                        )
                    } else if (!rec.recording) {
                        if (schedulable) {
                            IconButton(onClick = { scheduling = true }, modifier = Modifier.size(48.dp).testTag("schedButton")) {
                                Text("🕒", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { contentDescription = ctx.getString(R.string.sched_button) })
                            }
                            Spacer(Modifier.width(4.dp))
                        }
                        val enabled = uploading == null && (text.isNotBlank() || files.isNotEmpty() || gif != null)
                        val sendLabel = stringResource(R.string.send)
                        val schedLabel = stringResource(R.string.sched_button)
                        // ➤ con pulsación larga = el mismo menú de «Programar envío».
                        androidx.compose.foundation.layout.Box(
                            Modifier.size(52.dp).clip(CircleShape)
                                .background(if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f))
                                .combinedClickable(enabled = enabled, role = androidx.compose.ui.semantics.Role.Button, onClickLabel = sendLabel,
                                    onLongClickLabel = if (schedulable) schedLabel else null,
                                    onLongClick = if (schedulable) ({ view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS); scheduling = true }) else null,
                                    onClick = { sendNow() })
                                .testTag("send"),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.AutoMirrored.Filled.Send, sendLabel, tint = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)) }
                    }
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
    /** Quien puede escribir comenta y marca la tarjeta de tarea. */
    canPost: Boolean = false,
    /** Llegó en vivo con el chat a la vista (tanda 1.7): la carita triste de la tarea vencida se anima una vez. */
    animate: Boolean = false,
    /** Acciones de las tarjetas de correo y WhatsApp (menú y deslizar); null las oculta. */
    cardActions: ((MessageDTO, String?) -> CardActions)? = null,
    /** Reacciones de las tarjetas de evento, tarea, correo y WhatsApp (1.7.13); null = sin reacciones. */
    react: CardReact? = null,
) {
    val key = if (react != null) com.tiecoms.app.core.Reactions.cardKey(m) else null
    if (react == null || key == null) { SystemRowContent(m, data, events, onOpenConversation, onOpenIssue, onOpenEvent, canPost, animate, cardActions); return }
    // Correo y WhatsApp ya tienen su pulsación larga (responder, reenviar…): la barra va encima de ese menú.
    val mailCard = key == "mail.shared" || key == "wa.shared"
    var menu by remember(m.id) { mutableStateOf(false) }
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val menuLabel = stringResource(R.string.react_more)
    Column(Modifier.fillMaxWidth()) {
        Box(if (mailCard || !react.enabled) Modifier else Modifier
            .pointerInput(m.id) { detectTapGestures(onLongPress = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); menu = true }) }
            .semantics { customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction(menuLabel) { menu = true; true }) }
            .testTag("cardReactable-${m.seq}")) {
            androidx.compose.runtime.CompositionLocalProvider(LocalCardReact provides if (mailCard && react.enabled) react else null) {
                SystemRowContent(m, data, events, onOpenConversation, onOpenIssue, onOpenEvent, canPost, animate, cardActions)
            }
            if (!mailCard) AnchoredMenu(menu, emptyList(), { menu = false }, header = {
                QuickReactionBar(react.mine, react.actions, onPick = { e -> menu = false; react.onReact(e, e !in react.mine) }, onMore = { menu = false; react.onMore() })
            })
        }
        ReactionChips(m, data, react.enabled, onToggle = react.onReact, modifier = Modifier.padding(start = if (mailCard) 54.dp else 12.dp, bottom = 4.dp))
    }
}

/** Reacciones de una tarjeta: las mías, si mi empresa tiene reacciones con acción, y qué hacer al tocar. */
class CardReact(val mine: Set<String>, val actions: Boolean, val enabled: Boolean, val onReact: (String, Boolean) -> Unit, val onMore: () -> Unit)

/** La barra de reacciones para el menú de las tarjetas de correo y WhatsApp (lo lee BroughtBy). */
val LocalCardReact = androidx.compose.runtime.staticCompositionLocalOf<CardReact?> { null }

@Composable
private fun SystemRowContent(
    m: MessageDTO, data: BootstrapDTO, events: Map<String, com.tiecoms.app.core.CalendarEventDTO>,
    onOpenConversation: (String, Long?) -> Unit, onOpenIssue: (String) -> Unit, onOpenEvent: (String) -> Unit,
    canPost: Boolean, animate: Boolean, cardActions: ((MessageDTO, String?) -> CardActions)?,
) {
    val ctx = LocalContext.current
    val chat = LocalChatColors.current
    // gg: lo que dejó listo (tarjetas para confirmar) y respuestas rápidas (docs/GG-CHAT.md).
    com.tiecoms.app.core.Gg.parseActions(m)?.let { g -> GgActionsRow(m, g, data); return }
    // Correo y WhatsApp traídos al chat (docs/CORREO.md): nunca como JSON crudo.
    com.tiecoms.app.core.MailSystem.parse(m)?.let { b -> MailSystemRow(m, b, data, canPost, onOpenIssue, cardActions); return }
    // Tanda 1.7: es hoy, tarea hecha/vencida y comentarios agrupados se ven como la tarjeta del evento o de la tarea.
    com.tiecoms.app.core.System17.parse(m)?.let { b ->
        // Comentarios agrupados: una línea corta que abre la tarea o el evento, sin repetir la tarjeta (como la web).
        if (b.key == "issue.comments" && b.issueId != null) { CommentsNoticeLine(b.count, b.title, b.lastByName, b.lastExcerpt, icon = { Text("☑", style = MaterialTheme.typography.bodySmall) },
            tag = "issueCommentsLine") { onOpenIssue(b.issueId) }; return }
        if (b.key == "event.comments" && b.eventId != null) { CommentsNoticeLine(b.count, b.title, b.lastByName, b.lastExcerpt, icon = { Text("📅", style = MaterialTheme.typography.bodySmall) },
            tag = "eventCommentsLine") { onOpenEvent(b.eventId) }; return }
        val fb = systemText(ctx, m.body, Names.person(data, m.authorId)?.name)
        if (b.eventId != null) { EventChatCard(b.eventId, m.authorId, data, onOpenEvent, sys = b, canPost = canPost, fallback = fb); return }
        if (b.issueId != null) { IssueChatCard(b.issueId, m.authorId, data, canPost, onOpenIssue, sys = b, animate = animate, fallback = fb); return }
    }
    // Una tarea nueva se ve como tarjeta completa, con sus comentarios y para comentar ahí mismo (docs/TEMAS.md).
    com.tiecoms.app.core.Topics.cardIssueId(m)?.let { iid -> IssueChatCard(iid, m.authorId, data, canPost, onOpenIssue); return }
    // Un evento nuevo: tarjeta con fecha, «Unirse», quiénes van y responder ahí mismo.
    com.tiecoms.app.core.EventCards.cardEventId(m)?.let { eid -> EventChatCard(eid, m.authorId, data, onOpenEvent); return }
    val p = systemPayload(m.body)
    // Los hilos no ensucian el chat: el aviso «se abrió un hilo» lo reemplaza el chip bajo su mensaje.
    if (p?.s("k") == "derived.from") return
    val child = if (p?.s("k") == "derived.from") p.s("childId")?.let { cid -> data.conversations.firstOrNull { it.id == cid } } else null
    val eventId = p?.s("eventId")
    val issueId = p?.s("issueId")
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(systemText(ctx, m.body, Names.person(data, m.authorId)?.name), style = MaterialTheme.typography.bodySmall, color = chat.system, textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 24.dp).testTag("system"))
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (child != null) TextButton(onClick = { onOpenConversation(child.id, null) }) { Text("⑂ " + titleOf(ctx, child, data)) }
            if (issueId != null) TextButton(onClick = { onOpenIssue(issueId) }) { Text(stringResource(R.string.lin_open)) }
            // «Quedó guardada la transcripción de la llamada» · Ver transcripción (abre el detalle con resumen y transcripción).
            com.tiecoms.app.core.Calls.transcriptCallId(m)?.let { callId ->
                val container = LocalContainer.current
                TextButton(onClick = { openCallDetail(container, callId) }, modifier = Modifier.testTag("callTranscriptOpen")) { Text("📝 " + stringResource(R.string.call_transcript_open)) }
            }
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
    /** Hilos (derivadas) que cuelgan de este mensaje: chip como en Slack. */
    threads: List<ConversationDTO> = emptyList(),
    onLongPress: () -> Unit, onQuote: (MessageDTO) -> Unit, onIssue: (String) -> Unit, onOpenConversation: (String, Long?) -> Unit,
    onOpenMedia: (List<com.tiecoms.app.core.AttachmentDTO>, Int) -> Unit = { _, _ -> }, onOpenFile: (com.tiecoms.app.core.AttachmentDTO) -> Unit = {}, onOpenPdf: ((com.tiecoms.app.core.AttachmentDTO, Boolean) -> Unit)? = null,
    /** Sugerencia de asunto de una nota de voz; null la oculta (terceros). */
    onVoiceIssue: ((String) -> Unit)? = {},
    /** Ancla del sidechat abierto: halo y su posición para el conector (SPEC-v4 §G.2). */
    isAnchor: Boolean = false,
    onAnchorBounds: (androidx.compose.ui.geometry.Rect?) -> Unit = {},
    /** Deslizar la burbuja a la derecha (1.7.1): responder citando el mensaje. */
    onSwipeReply: (() -> Unit)? = null,
    onPerson: (String) -> Unit = {},
    /** Reacciones: chips bajo la burbuja y barra rápida encima del menú. */
    canReact: Boolean = false,
    reactionActions: Boolean = true,
    onReact: (String, Boolean) -> Unit = { _, _ -> },
    onMoreReactions: () -> Unit = {},
    /** Tema del mensaje (docs/TEMAS.md) y, si no lo puso el autor, quién («Tú» si fui yo). */
    topic: com.tiecoms.app.core.TopicDTO? = null,
    topicBy: String? = null,
    /** Búsqueda en el chat abierta (tanda 1.7): resalta lo que coincide. */
    highlightQuery: String? = null,
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
    val body = if (deleted) stringResource(R.string.deleted) else m.displayBody ?: com.tiecoms.app.core.LongContent.visibleBody(m.body, m.attachments)
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
        val swipeLatest by androidx.compose.runtime.rememberUpdatedState(onSwipeReply)
        if (isAnchor) androidx.compose.runtime.DisposableEffect(m.id) { onDispose { onAnchorBounds(null) } }
        Box {
        // Ícono ↩ detrás de la burbuja: aparece al deslizar y se llena al pasar el umbral.
        if (onSwipeReply != null) {
            val thresholdPx = with(androidx.compose.ui.platform.LocalDensity.current) { com.tiecoms.app.core.SwipeReply.THRESHOLD_DP.dp.toPx() }
            Box(Modifier.align(Alignment.CenterStart).size(32.dp).graphicsLayer {
                    val p = (swipe / thresholdPx).coerceIn(0f, 1f)
                    alpha = p; scaleX = 0.6f + 0.4f * p; scaleY = 0.6f + 0.4f * p
                    translationX = (swipe - 40.dp.toPx()).coerceAtLeast(0f) * 0.5f
                }.background(MaterialTheme.colorScheme.surfaceVariant, CircleShape).testTag("swipeReplyIcon-${m.seq}"),
                contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Filled.Reply, stringResource(R.string.swipe_reply_cd), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Column(
            Modifier.widthIn(max = maxW)
                .then(if (isAnchor) Modifier.onGloballyPositioned { onAnchorBounds(it.boundsInRoot()) } else Modifier)
                .then(if (onSwipeReply != null) Modifier.swipeToReply(m.id, haptic, { swipe }, { swipe = it }) { swipeLatest?.invoke() } else Modifier)
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
                        if (quoted != null) "${Names.person(data, quoted.authorId)?.name ?: ""}: " + (if (quoted.deletedAt != null) stringResource(R.string.deleted) else excerpt(quoteText(ctx, quoted), 120))
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
            // Una sola vista (tanda 1.7): burbuja cerrada «① Foto / Mensaje / Nota de voz»; el contenido solo en el visor.
            if (!deleted && m.viewOnce) ViewOnceBubble(m, data, fg, item.mine)
            else if (!deleted && m.attachments.isNotEmpty()) {
                val media = m.attachments.filter { it.isImage || it.isVideo }
                AttachmentsBlock(m.attachments, fg, onOpenMedia = { i -> onOpenMedia(media, i) }, onOpenFile = onOpenFile, mine = item.mine, onCreateIssue = onVoiceIssue,
                    onLongPress = openMenu, onOpenPdf = onOpenPdf)
            }
            if (deleted) Text(body, color = fg, style = MaterialTheme.typography.bodyLarge, fontStyle = FontStyle.Italic)
            else if (m.viewOnce) Unit
            // Solo emojis (1 a 3): grandes, como en la web (isJumbo).
            else if (m.attachments.isEmpty() && m.mentions.isEmpty() && m.refs.isEmpty() && highlightQuery == null && com.tiecoms.app.core.Reactions.isJumbo(body))
                Text(body.trim(), color = fg, fontSize = if ((com.tiecoms.app.core.Reactions.clusters(body.filterNot { it.isWhitespace() })?.size ?: 3) == 1) 44.sp else 34.sp,
                    lineHeight = 52.sp, modifier = Modifier.testTag("body-${m.seq}"))
            else if (body.isNotBlank() || m.attachments.isEmpty()) {
                // 1.7.1: un mensaje enorme se pliega a 30 líneas con «Ver más» (la búsqueda lo muestra entero).
                val candidate = remember(body) { com.tiecoms.app.core.LongText.collapsible(body) }
                var expanded by androidx.compose.runtime.saveable.rememberSaveable(m.id) { mutableStateOf(false) }
                val readerKeyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
                if (expanded) LongMessageReader(body, m.mentions + com.tiecoms.app.core.Refs.tokens(m), data, onPerson) { expanded = false }
                var overflows by remember(m.id) { mutableStateOf(false) }
                val folded = candidate && highlightQuery == null
                MessageText(body, m.mentions + com.tiecoms.app.core.Refs.tokens(m), fg, data, onPerson = onPerson, onColored = item.mine,
                    modifier = Modifier.testTag("body-${m.seq}"), highlight = highlightQuery,
                    maxLines = if (folded) com.tiecoms.app.core.LongText.COLLAPSED_LINES else Int.MAX_VALUE,
                    onOverflow = if (folded) ({ o -> overflows = o }) else null)
                if (candidate && highlightQuery == null) Text(
                    stringResource(if (expanded) R.string.msg_see_less else R.string.msg_see_more),
                    color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 4.dp).clip(RoundedCornerShape(6.dp)).clickable { readerKeyboard?.hide(); expanded = true }
                        .padding(horizontal = 2.dp, vertical = 4.dp).testTag("expand-${m.seq}"),
                )
            }
            m.linkPreview?.takeIf { !deleted && it.usable }?.let { LinkPreviewCard(it, fg, Modifier.padding(top = 6.dp)) }
            FlowRow(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End), verticalArrangement = Arrangement.Center) {
                if (topic != null) TopicTag(topic, topicBy, Modifier.align(Alignment.CenterVertically))
                Text(
                    listOfNotNull(if (pinnedHere && item.mine) "📌" else null, time, if (m.editedAt != null && !deleted) stringResource(R.string.msg_edited) else null).joinToString(" "),
                    style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = 0.75f), modifier = Modifier.align(Alignment.CenterVertically),
                )
            }
        }
        val myReactions = m.reactions.filter { data.me.id in it.userIds }.map { it.emoji }.toSet()
        AnchoredMenu(menuOpen, if (menuOpen) menuItems() else emptyList(), onDismissMenu,
            header = if (canReact) ({ QuickReactionBar(myReactions, reactionActions, onPick = { e -> onDismissMenu(); onReact(e, e !in myReactions) }, onMore = { onDismissMenu(); onMoreReactions() }) }) else null)
        }
        }
        ReactionChips(m, data, canReact, onToggle = onReact, modifier = Modifier.padding(start = if (showAvatars && !item.mine) 34.dp else 0.dp))
        ThreadChip(threads, onOpenSide)
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

/**
 * Coloca la línea «N mensajes nuevos» arriba de la vista. Con reverseLayout, scrollToItem deja la fila abajo;
 * luego se sube casi una pantalla hacia lo nuevo (si no hay tanto, queda al final y todo está a la vista).
 */
internal suspend fun scrollDividerToTop(listState: androidx.compose.foundation.lazy.LazyListState, idx: Int, animated: Boolean = false) {
    listState.scrollToItem(idx)
    val info = listState.layoutInfo
    // At the oldest boundary scrollToItem is already clamped near the top. Moving a whole
    // viewport again skips the first unread messages; correct only the measured displacement.
    val divider = info.visibleItemsInfo.firstOrNull { it.index == idx } ?: return
    // In a reverse list item offsets start at the bottom; convert to its visual top.
    val top = info.viewportSize.height - divider.offset - divider.size - info.afterContentPadding
    val by = -(top - info.beforeContentPadding).coerceAtLeast(0).toFloat()
    if (animated) listState.animateScrollBy(by) else listState.scrollBy(by)
}

/** Línea divisoria «N mensajes nuevos» antes del primer no leído. */
@Composable
private fun NewMessagesDivider(count: Int) {
    val label = pluralStringResource(R.plurals.chat_new_divider, count, count)
    val color = Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE)
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp).semantics(mergeDescendants = true) { heading() }.testTag("newDivider"), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).height(1.dp).background(color))
        Text(label, color = color, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 10.dp))
        Box(Modifier.weight(1f).height(1.dp).background(color))
    }
}

/**
 * Deslizar a la derecha = responder (1.7.1). La burbuja sigue al dedo con resistencia, vibra suave al pasar
 * ~60 dp y al soltar pasado el umbral responde. Solo se queda con el gesto si es claramente horizontal: lo
 * vertical nunca se consume y es de la lista (un mensaje más alto que la pantalla se desplaza igual).
 */
private fun Modifier.swipeToReply(
    key: Any, haptic: androidx.compose.ui.hapticfeedback.HapticFeedback,
    current: () -> Float, set: (Float) -> Unit, onReply: () -> Unit,
): Modifier = pointerInput(key) {
    val slop = viewConfiguration.touchSlop
    val threshold = com.tiecoms.app.core.SwipeReply.THRESHOLD_DP.dp.toPx()
    val max = com.tiecoms.app.core.SwipeReply.MAX_DP.dp.toPx()
    coroutineScope {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            var dx = 0f; var dy = 0f
            var claimed = false; var armed = false
            while (true) {
                val ev = awaitPointerEvent()
                val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                if (!ch.pressed) {
                    break
                }
                val d = ch.position - ch.previousPosition
                if (!claimed) {
                    if (ch.isConsumed) {
                        break
                    }
                    dx += d.x
                    dy += d.y
                    when (com.tiecoms.app.core.SwipeReply.decide(dx, dy, slop)) {
                        com.tiecoms.app.core.SwipeReply.Decision.REJECT -> break
                        com.tiecoms.app.core.SwipeReply.Decision.CLAIM -> {
                            claimed = true
                            ch.consume()
                            dx -= slop
                        }
                        com.tiecoms.app.core.SwipeReply.Decision.UNDECIDED -> Unit
                    }
                } else {
                    dx += d.x; ch.consume()
                    set(com.tiecoms.app.core.SwipeReply.resist(dx, threshold, max))
                    if (!armed && dx >= threshold) { armed = true; haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove) }
                    else if (armed && dx < threshold) armed = false
                }
            }
            if (claimed) {
                if (armed) onReply()
                val from = current()
                launch { androidx.compose.animation.core.animate(from, 0f, animationSpec = androidx.compose.animation.core.spring(dampingRatio = 0.8f, stiffness = 600f)) { v, _ -> set(v) } }
            }
        }
    }
}
