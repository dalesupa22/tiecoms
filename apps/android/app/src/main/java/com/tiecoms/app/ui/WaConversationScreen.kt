package com.tiecoms.app.ui

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.mutableStateListOf
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
import com.tiecoms.app.core.WaAccountDTO
import com.tiecoms.app.core.WaChatDTO
import com.tiecoms.app.core.WaInbox
import com.tiecoms.app.core.WaMessageDTO
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/**
 * Último estado conocido de cada chat de WhatsApp abierto (la lista lo deja antes de navegar), para que la
 * conversación abra al instante con nombre y ajustes. Solo en memoria.
 */
object WaOpenCache {
    private val chats = java.util.concurrent.ConcurrentHashMap<String, WaChatDTO>()
    fun put(c: WaChatDTO) { chats[WaInbox.key(c)] = c }
    fun get(key: String): WaChatDTO? = chats[key]
    fun clear() = chats.clear()
}

/**
 * Conversación de WhatsApp a pantalla completa (2-oct-2026): tocar un chat (pantalla WhatsApp, Grupos/DMs o un aviso)
 * abre directo los mensajes con su compositor. Los ajustes del chat (pines, lista principal, categoría, vincular,
 * ocultar) van en el ⋯ de la barra. gg de este chat en la barra (fuente `wa:<cuenta>:<jid>`).
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun WaConversationScreen(key: String, onBack: () -> Unit, onOpenConversation: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val state = client.state.collectAsStateWithLifecycle().value
    val data = state.data ?: return
    val parsed = remember(key) { WaInbox.parse(key) }
    if (parsed == null) { LaunchedEffect(Unit) { onBack() }; return }
    var chat by remember(key) {
        mutableStateOf(WaOpenCache.get(key) ?: data.waInbox.firstOrNull { WaInbox.key(it) == key } ?: WaChatDTO(accountId = parsed.first, jid = parsed.second, name = parsed.second.substringBefore('@')))
    }
    // La fila de la bandeja manda en lo de la bandeja (lo que se mueve o fija se ve en el acto).
    val live = data.waInbox.firstOrNull { WaInbox.key(it) == key }
    val c = chat.copy(inboxPlace = live?.inboxPlace ?: if (data.waInbox.isEmpty()) chat.inboxPlace else null, inboxPinnedAt = live?.inboxPinnedAt)
    val source = key
    val openedToken = remember(source) { state.waPrivacy.token(source) }
    val permitted = state.waPrivacy.allows(source) && openedToken == state.waPrivacy.token(source)
    LaunchedEffect(permitted) { if (!permitted) { container.toast(ctx.getString(R.string.no_access)); onBack() } }
    if (!permitted) return
    val revision = state.waRevision
    var accounts by remember { mutableStateOf<List<WaAccountDTO>?>(null) }
    val account = accounts?.firstOrNull { it.id == c.accountId }
    var messages by remember(key) { mutableStateOf<List<WaMessageDTO>?>(null) }
    var loadError by remember(key) { mutableStateOf<String?>(null) }
    var tick by remember { mutableStateOf(0) }
    suspend fun loadMessages() {
        try { messages = client.waMessages(c); loadError = null }
        catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; loadError = errorText(ctx, e); if (messages == null) messages = emptyList() }
    }
    LaunchedEffect(key, revision, tick) { loadMessages() }
    // Mientras está abierta, lo nuevo llega solo (el puente guarda en segundos).
    LaunchedEffect(key) { while (true) { delay(15_000); loadMessages() } }
    LaunchedEffect(revision) { runCatching { client.waAccounts() }.onSuccess { accounts = it.accounts } }
    // Abierto por un aviso o enlace sin la fila a mano: se busca el chat en su cuenta (nombre, categoría, pines).
    LaunchedEffect(key) {
        if (WaOpenCache.get(key) != null || data.waInbox.any { WaInbox.key(it) == key }) return@LaunchedEffect
        var cursor: String? = null
        repeat(6) {
            val p = runCatching { client.waChats(c.accountId, null, null, false, null, limit = 100, cursor = cursor) }.getOrNull() ?: return@LaunchedEffect
            p.chats.firstOrNull { it.jid == c.jid }?.let { found -> chat = found; WaOpenCache.put(found); return@LaunchedEffect }
            cursor = p.next?.takeIf { p.hasMore } ?: return@LaunchedEffect
        }
    }
    fun patch(p: Map<String, JsonElement>) = scope.launch {
        runCatching { client.waPatchChat(c, kotlinx.serialization.json.JsonObject(p)) }
            .onSuccess { up -> chat = up; WaOpenCache.put(up) }
            .onFailure { container.toast(errorText(ctx, it)) }
    }
    var menu by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }
    var waMenu by remember { mutableStateOf<WaMessageDTO?>(null) }
    var waShare by remember { mutableStateOf<WaMessageDTO?>(null) }
    val gg = rememberGgSide(com.tiecoms.app.core.GgSide.whatsapp(c.accountId, c.jid), enabled = !client.ggSideMissing)
    var selecting by remember(key) { mutableStateOf(false) }
    val selected = remember(key) { mutableStateListOf<String>() }
    LaunchedEffect(gg?.open) { if (gg?.open == false) { selecting = false; selected.clear(); gg.quoted.clear() } }
    var suggestFor by remember { mutableStateOf<List<String>?>(null) }
    var queue by remember { mutableStateOf(listOf<com.tiecoms.app.core.GgSuggestion>()) }
    var draft by rememberSaveable(key) { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    fun copyDraft(t: String) { if (runCatching { client.requireWaSource(source) }.getOrNull() != openedToken) return; copyToClipboard(ctx, t); container.toast(ctx.getString(R.string.ggs_draft_copied)) }
    fun useDraft(t: String) { if (account?.sendEnabled == true) draft = t else copyDraft(t) }
    val linked = c.linkedConversationId?.let { id -> data.conversations.firstOrNull { it.id == id } }
    val multi = (accounts?.size ?: 0) > 1
    val subtitle = listOfNotNull(if (multi) c.accountLabel.ifBlank { null } else null, if (c.isGroup && c.participants != null) stringResource(R.string.wa_members, c.participants) else null).joinToString(" · ")

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack, modifier = Modifier.testTag("back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        WaAvatar(c, 32.dp)
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(c.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() }.testTag("waConvTitle"))
                            if (subtitle.isNotEmpty()) Text(subtitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                actions = {
                    Box {
                        IconButton(onClick = { menu = true }, modifier = Modifier.testTag("waConvMenu")) { Icon(Icons.Filled.MoreVert, stringResource(R.string.menu_more)) }
                        AnchoredMenu(menu, if (!menu) emptyList() else waChatMenu(ctx, c, onOpen = null,
                            onPinWa = { patch(mapOf("pinned" to JsonPrimitive(!c.pinned))) },
                            onHide = { patch(mapOf("hidden" to JsonPrimitive(!c.hidden))) },
                            onCategory = { k -> patch(mapOf("category" to JsonPrimitive(k))) },
                            extra = listOfNotNull(
                                // 1.7.13: gg desde ⋯ (vuelve a mostrar la píldora de abajo si la escondí en este chat).
                                gg?.takeIf { it.available != false }?.let { g -> SheetItem(ctx.getString(R.string.ggs_ask_about).removePrefix("✨").trim(), "✨", tag = "waMenuGgOpen") { g.reopenFromMenu(ctx) } },
                                SheetItem(ctx.getString(R.string.wa_chat_settings), "⚙", tag = "waChatSettings") { settingsOpen = true })), { menu = false })
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().imePadding()) {
            ErrorText(loadError)
            val list = messages
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    list == null -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                    list.isEmpty() -> Text(stringResource(R.string.wa_no_messages), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.align(Alignment.Center).padding(24.dp))
                    else -> LazyColumn(Modifier.fillMaxSize().testTag("waMessages"), reverseLayout = true, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(list.asReversed(), key = { it.id }) { m ->
                            GgSelectable(selecting, m.id in selected, onToggle = { if (m.id in selected) selected.remove(m.id) else selected.add(m.id) }) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = if (m.fromMe) Arrangement.End else Arrangement.Start) {
                                    // Pulsación larga: «Comentar en chaggu…» (con el correo prendido), «✨ Preguntar a gg» y «Seleccionar».
                                    Surface(shape = RoundedCornerShape(12.dp), color = if (m.fromMe) Color(0xFFDCF8C6) else MaterialTheme.colorScheme.surfaceContainerHigh,
                                        modifier = Modifier.widthIn(max = 320.dp).then(if (data.mailEnabled || gg != null) Modifier.combinedClickable(onClick = {}, onLongClick = { waMenu = m }) else Modifier).testTag("waMsg-${m.id}")) {
                                        Column(Modifier.padding(8.dp)) {
                                            if (!m.fromMe && c.isGroup && m.author != null) Text(m.author, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
                                            CanonicalAttachments(listOfNotNull(m.media?.attachment), m.media?.status)
                                            if (m.body.isNotEmpty()) Text(m.body, color = if (m.fromMe) Color(0xFF1F1F1F) else MaterialTheme.colorScheme.onSurface)
                                            Text(shortDateTime(m.sentAt), style = MaterialTheme.typography.labelSmall, color = if (m.fromMe) Color(0xFF55605A) else MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (gg != null && gg.available != false) Column(Modifier.padding(horizontal = 8.dp)) {
                // gg abajo (1.7.13): la píldora con su ✕ y, a la derecha, «Responder por mí» si lo último es del otro.
                if (selecting) GgSelectionBar(selected.size, onAsk = { suggestFor = selected.toList() }, onCancel = { selecting = false; selected.clear() })
                else GgAskPill(gg) {
                    if (messages?.lastOrNull()?.fromMe == false) TextButton(onClick = { gg.loadQuick() }, modifier = Modifier.testTag("waGgSpark")) { Text(stringResource(R.string.ggs_reply_for_me), maxLines = 1) }
                }
                GgQuickReplies(gg) { t -> useDraft(t) }
            }
            HorizontalDivider()
            // Compositor: con «Responder desde chaggu» se escribe aquí; si no, el aviso de solo lectura con «Activar».
            if (account != null && !account.sendEnabled) Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp).testTag("waReadOnly"), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.wa_read_only), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                Button(onClick = {
                    scope.launch { runCatching { client.waSetSendEnabled(account.id, true) }.onSuccess { up -> accounts = accounts?.map { if (it.id == up.id) up else it } }.onFailure { container.toast(errorText(ctx, it)) } }
                }, modifier = Modifier.testTag("waEnableReply")) { Text(stringResource(R.string.wa_enable_reply)) }
            } else Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(draft, { draft = it.take(4000) }, placeholder = { Text(stringResource(R.string.wa_composer_ph)) }, maxLines = 5,
                    enabled = account != null, modifier = Modifier.weight(1f).testTag("waComposer"))
                IconButton(enabled = !sending && draft.isNotBlank() && account != null, modifier = Modifier.testTag("waSend"), onClick = {
                    val text = draft.trim()
                    sending = true
                    scope.launch {
                        try {
                            val r = client.waSend(c, text)
                            when (r.status) {
                                "failed" -> container.toast(ctx.getString(R.string.wa_send_failed, r.error ?: ""))
                                else -> { draft = ""; if (r.status == "queued") container.toast(ctx.getString(R.string.wa_send_queued)); tick++ }
                            }
                        } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; container.toast(errorText(ctx, e)) }
                        finally { sending = false }
                    }
                }) { if (sending) CircularProgressIndicator(Modifier.width(20.dp)) else Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.send)) }
            }
        }
    }

    if (settingsOpen) FormSheet(stringResource(R.string.wa_chat_settings), { settingsOpen = false }, tag = "waChatSettingsSheet") {
        val targets = data.conversations.filter { it.kind != "direct" && it.canPost }
        Dropdown(stringResource(R.string.wa_category), WA_CATEGORIES.map { it to "${CAT_ICON[it]} ${catName(it)}" }, c.category, { patch(mapOf("category" to JsonPrimitive(it))) })
        Text(stringResource(if (c.categoryManual) R.string.wa_manual else R.string.wa_suggested), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (c.categoryManual) TextButton(onClick = { patch(mapOf("category" to JsonNull)) }) { Text(stringResource(R.string.wa_reset_category)) }
        c.description?.let { Text(it.take(300), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Dropdown(stringResource(R.string.wa_link_to), listOf<Pair<String?, String>>(null to stringResource(R.string.wa_not_linked)) + targets.map { x -> x.id to (titleOf(ctx, x, data) + (data.workspaces.firstOrNull { it.id == x.workspaceId }?.let { " · ${it.name}" } ?: "")) },
            c.linkedConversationId, { patch(mapOf("linkedConversationId" to (it?.let { v -> JsonPrimitive(v) } ?: JsonNull))) })
        if (linked != null) TextButton(onClick = { settingsOpen = false; onOpenConversation(linked.id) }) { Text(stringResource(R.string.wa_linked_hint, titleOf(ctx, linked, data))) }
        else Text(stringResource(R.string.wa_link_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    waMenu?.let { m -> ActionSheet(null, listOfNotNull(
        if (data.mailEnabled) SheetItem(ctx.getString(R.string.web_wa_bring), "⤴", tag = "waCommentIn") { waMenu = null; waShare = m } else null,
        if (gg != null && gg.available != false) SheetItem(ctx.getString(R.string.ggs_ask_about).removePrefix("✨").trim(), "✨", tag = "waAskGg") {
            waMenu = null; gg.quote(com.tiecoms.app.core.GgQuotedDTO(m.id, if (m.fromMe) ctx.getString(R.string.ggs_you) else m.author ?: c.name, excerpt(m.body, 200))); gg.show()
        } else null,
        if (gg != null && gg.available != false) SheetItem(ctx.getString(R.string.ggs_select), "☑", tag = "waSelect") { waMenu = null; selecting = true; if (m.id !in selected) selected.add(m.id) } else null,
    ), onDismiss = { waMenu = null }) }
    gg?.let { g ->
        GgSideSheet(g, onUseDraft = { t -> useDraft(t) },
            onAction = { a -> queue = listOf(com.tiecoms.app.core.GgSuggestion(id = "draft-action", kind = a.kind, title = a.title)) }, onJump = {})
        if (!g.open && suggestFor == null) GgConsentDialog(g)
        suggestFor?.let { ids ->
            GgSuggestSheet(g, ids, onRun = { l -> queue = ggRunOrder(l); selecting = false; selected.clear() },
                onFreeAsk = { t ->
                    ids.forEach { mid -> messages?.firstOrNull { it.id == mid }?.let { m -> g.quote(com.tiecoms.app.core.GgQuotedDTO(m.id, if (m.fromMe) ctx.getString(R.string.ggs_you) else m.author ?: c.name, excerpt(m.body, 200))) } }
                    g.ask(t, ids); g.show(); selecting = false; selected.clear()
                }, onClose = { suggestFor = null })
        }
    }
    // Cola de sugerencias: respuesta al compositor (o al portapapeles en solo lectura); tarea y recordatorio en sus diálogos.
    val head = queue.firstOrNull()
    LaunchedEffect(head) {
        val s = head ?: return@LaunchedEffect
        when (s.kind) {
            "task", "reminder" -> Unit
            "summary" -> { gg?.let { g -> g.ask(ctx.getString(R.string.ggs_summarize), s.forMessageIds); g.show() }; queue = queue.drop(1) }
            else -> { useDraft(s.draft ?: s.title); queue = queue.drop(1) }
        }
    }
    if (head != null) androidx.compose.runtime.key(head.id + "|" + queue.size) {
        if (head.kind == "reminder" && linked != null) ReminderDialog(linked, null, onClose = { queue = queue.drop(1) }, defaultNote = head.param("title") ?: head.title)
        else if (head.kind == "task" || head.kind == "reminder") NewIssueDialog(linked?.id, null, head.param("title") ?: head.title, onClose = { queue = queue.drop(1) }, onCreated = {},
            defaultDue = com.tiecoms.app.core.GgSide.dueDate(head.param("due")))
    }
    waShare?.let { m -> WaShareSheet(c, m, onClose = { waShare = null }, onDone = { cid -> waShare = null; onOpenConversation(cid) }) }
}
