package com.tiecoms.app.ui

import android.graphics.BitmapFactory
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import android.util.Base64
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.WaAccountDTO
import com.tiecoms.app.core.WaChatDTO
import com.tiecoms.app.core.WaCount
import com.tiecoms.app.core.WaMessageDTO
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/** «💼 Solo trabajo» (preferencia local; se lee al abrir la app en AppRoot). */
val WaWorkOnly = mutableStateOf(false)
fun setWaWorkOnly(settings: com.tiecoms.app.platform.AppSettings, on: Boolean) { WaWorkOnly.value = on; settings.waWorkOnly = on }

val WA_CATEGORIES = listOf("trabajo", "clientes", "familia", "amigos", "comunidad", "otros")
internal val CAT_ICON = mapOf("trabajo" to "💼", "clientes" to "🤝", "familia" to "🏠", "amigos" to "🍻", "comunidad" to "🏘", "otros" to "◌")

@Composable
internal fun catName(c: String) = stringResource(
    when (c) { "trabajo" -> R.string.wa_cat_trabajo; "clientes" -> R.string.wa_cat_clientes; "familia" -> R.string.wa_cat_familia; "amigos" -> R.string.wa_cat_amigos; "comunidad" -> R.string.wa_cat_comunidad; else -> R.string.wa_cat_otros },
)

@Composable
private fun waStatus(s: String) = stringResource(
    when (s) {
        "qr" -> R.string.wa_status_qr; "connected" -> R.string.wa_status_connected; "reconnecting" -> R.string.wa_status_reconnecting
        "expired" -> R.string.wa_status_expired; "logged_out" -> R.string.wa_status_logged_out; "error" -> R.string.wa_status_error; else -> R.string.wa_status_pending
    },
)

private fun whenShort(iso: String?): String {
    val i = parseInstant(iso) ?: return ""
    val z = i.atZone(java.time.ZoneId.systemDefault())
    return if (z.toLocalDate() == java.time.LocalDate.now()) timeText(iso) else z.format(java.time.format.DateTimeFormatter.ofPattern("d MMM"))
}

/**
 * Pantalla WhatsApp (2-oct-2026): arriba solo el buscador, la línea «● N cuentas conectadas ›» (abre la hoja de
 * cuentas), las categorías y Grupos/Todos. Tocar un chat lo ABRE ([onOpenChat]); pulsación larga o ⋮ = su menú;
 * deslizar a la derecha = fijar en WhatsApp, a la izquierda = ocultar (con «Deshacer»). «Mostrar ocultos» y
 * «Reorganizar» van en el ⋯ de la barra.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun WhatsAppScreen(onBack: () -> Unit, onOpenChat: (WaChatDTO) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val state = client.state.collectAsStateWithLifecycle().value
    val revision = state.waRevision
    val privacy = state.waPrivacy
    var accounts by remember { mutableStateOf<List<WaAccountDTO>?>(null) }
    var max by remember { mutableStateOf(5) }
    var connectOpen by rememberSaveable { mutableStateOf(false) }
    var accountsOpen by rememberSaveable { mutableStateOf(false) }
    var chats by remember { mutableStateOf<List<WaChatDTO>>(emptyList()) }
    var chatTokens by remember { mutableStateOf<Map<String, Long>>(emptyMap()) }
    var counts by remember { mutableStateOf<Map<String, WaCount>>(emptyMap()) }
    var countsLoaded by remember { mutableStateOf(false) }
    var next by remember { mutableStateOf<String?>(null) }
    var hasMore by remember { mutableStateOf(false) }
    var syncPartial by remember { mutableStateOf(false) }
    var chatsLoading by remember { mutableStateOf(false) }
    var loadedOnce by remember { mutableStateOf(false) }
    var accountId by rememberSaveable { mutableStateOf<String?>(null) }
    var category by rememberSaveable { mutableStateOf<String?>(null) }
    var onlyGroups by rememberSaveable { mutableStateOf(false) }
    var showHidden by rememberSaveable { mutableStateOf(false) }
    var q by rememberSaveable { mutableStateOf("") }
    var barMenu by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun loadAccounts() { runCatching { client.waAccounts() }.onSuccess { accounts = it.accounts; max = it.max }.onFailure { error = errorText(ctx, it); if (accounts == null) accounts = emptyList() } }
    suspend fun loadChats(reset: Boolean = true) {
        if (!reset && (chatsLoading || !hasMore || next == null)) return
        val scopeKey = listOf(client.myId, accountId, category, onlyGroups.toString(), showHidden.toString(), q, revision.toString())
        val generation = client.sessionGeneration
        val cursor = if (reset) null else next
        chatsLoading = true
        try {
            val p = client.waChats(accountId, category, if (onlyGroups) true else null, showHidden, q, limit = 50, cursor = cursor)
            if (generation != client.sessionGeneration || scopeKey != listOf(client.myId, accountId, category, onlyGroups.toString(), showHidden.toString(), q, revision.toString())) return
            chats = com.tiecoms.app.core.WaView.sort(if (reset) p.chats else chats + p.chats)
            chatTokens = chatTokens + p.chats.associate { com.tiecoms.app.core.WaInbox.key(it) to client.state.value.waPrivacy.token(com.tiecoms.app.core.WaInbox.key(it)) }
            counts = p.categories; countsLoaded = true; next = p.next; hasMore = p.hasMore && p.next != null && p.next != cursor; syncPartial = p.syncPartial; error = null
            loadedOnce = true
        } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = errorText(ctx, e); loadedOnce = true }
        finally { if (generation == client.sessionGeneration && scopeKey == listOf(client.myId, accountId, category, onlyGroups.toString(), showHidden.toString(), q, revision.toString())) chatsLoading = false }
    }
    val workOnly = WaWorkOnly.value
    LaunchedEffect(workOnly) { if (workOnly && category != null && category !in com.tiecoms.app.core.WaView.WORK) category = null }
    val visibleChats = com.tiecoms.app.core.WaView.workFilter(chats.filter { val key = com.tiecoms.app.core.WaInbox.key(it); privacy.allows(key) && chatTokens[key] == privacy.token(key) }, workOnly)
    LaunchedEffect(privacy.revision) { chats = visibleChats; counts = emptyMap(); countsLoaded = false; next = null; hasMore = false }
    LaunchedEffect(revision) { loadAccounts() }
    LaunchedEffect(revision, accountId, category, onlyGroups, showHidden, q) { if (q.isNotEmpty()) delay(250); loadChats() }
    // Mientras hay un código en pantalla se pregunta seguido: el QR cambia cada ~20 s.
    val waiting = accounts?.any { it.status == "pending" || it.status == "qr" || it.status == "reconnecting" } == true
    LaunchedEffect(waiting) { while (waiting) { delay(3000); loadAccounts() } }
    val accs = accounts.orEmpty()
    fun local(up: WaChatDTO) { chats = com.tiecoms.app.core.WaView.applyLocal(chats, up, showHidden) }
    fun patch(c: WaChatDTO, p: Map<String, JsonElement>, optimistic: WaChatDTO? = null, then: (() -> Unit)? = null) {
        optimistic?.let { local(it) }
        scope.launch {
            runCatching { client.waPatchChat(c, kotlinx.serialization.json.JsonObject(p)) }
                .onSuccess { up -> local(up); then?.invoke(); loadChats() }
                .onFailure { optimistic?.let { local(c) }; container.toast(errorText(ctx, it)) }
        }
    }
    fun togglePinWa(c: WaChatDTO) = patch(c, mapOf("pinned" to JsonPrimitive(!c.pinned)), c.copy(pinned = !c.pinned))
    fun hide(c: WaChatDTO) {
        patch(c, mapOf("hidden" to JsonPrimitive(true)), c.copy(hidden = true)) {
            scope.launch {
                val r = snackbar.showSnackbar(ctx.getString(R.string.wa_hidden_done), actionLabel = ctx.getString(R.string.undo), duration = androidx.compose.material3.SnackbarDuration.Short)
                if (r == androidx.compose.material3.SnackbarResult.ActionPerformed) patch(c.copy(hidden = true), mapOf("hidden" to JsonPrimitive(false)))
            }
        }
    }

    SimpleScaffold(stringResource(R.string.wa_title), onBack, actions = {
        Box {
            IconButton(onClick = { barMenu = true }, modifier = Modifier.testTag("waMore")) { Icon(Icons.Filled.MoreVert, stringResource(R.string.menu_more)) }
            AnchoredMenu(barMenu, if (!barMenu) emptyList() else listOfNotNull(
                SheetItem(ctx.getString(R.string.wa_show_hidden), if (showHidden) "✓" else "👁", tag = "waShowHidden") { showHidden = !showHidden },
                SheetItem(ctx.getString(R.string.wa_reorganize), "✦", tag = "waReorganize") {
                    scope.launch { runCatching { client.waOrganize() }.onSuccess { container.toast(ctx.getString(R.string.wa_organized, it.changed)); loadChats() }.onFailure { container.toast(errorText(ctx, it)) } }
                },
                if (accs.size > 1) SheetItem(ctx.getString(R.string.wa_account_filter), "◉", tag = "waAccountFilter", hint = accs.firstOrNull { it.id == accountId }?.label ?: ctx.getString(R.string.wa_all_accounts),
                    children = listOf(SheetItem(ctx.getString(R.string.wa_all_accounts), if (accountId == null) "✓" else "", tag = "waAcc-all") { accountId = null }) +
                        accs.map { a -> SheetItem(a.label, if (accountId == a.id) "✓" else "●", tag = "waAcc-${a.id}") { accountId = a.id } }) else null,
                null,
                SheetItem(ctx.getString(R.string.wa_accounts_title), "⚙", tag = "waManageAccounts") { accountsOpen = true },
                if (accs.size < max) SheetItem(ctx.getString(R.string.wa_connect), "＋", tag = "waConnectMenu") { connectOpen = true } else null,
            ), { barMenu = false })
        }
    }) {
        when {
            accounts == null -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            accs.isEmpty() -> Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Sin cuentas: aquí sí va la explicación.
                Text(stringResource(R.string.wa_intro), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("waIntro"))
                Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("👤  🏪", style = MaterialTheme.typography.headlineSmall)
                        Text(stringResource(R.string.wa_empty_title), fontWeight = FontWeight.Bold)
                        Text(stringResource(R.string.wa_empty_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Button(onClick = { connectOpen = true }, modifier = Modifier.testTag("waConnect")) { Text(stringResource(R.string.wa_connect)) }
                ErrorText(error)
            }
            else -> {
                // Arriba: buscador, la línea de cuentas, categorías y Grupos/Todos. Nada más.
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.wa_search), maxLines = 1, overflow = TextOverflow.Ellipsis) }, singleLine = true,
                        leadingIcon = { Icon(Icons.Filled.Search, null) },
                        trailingIcon = if (q.isNotEmpty()) ({ IconButton(onClick = { q = "" }) { Icon(Icons.Filled.Close, stringResource(R.string.clear_search)) } }) else null,
                        modifier = Modifier.fillMaxWidth().testTag("waSearch"))
                    AccountsLine(accs) { accountsOpen = true }
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("waCats")) {
                        item {
                            // «💼 Solo trabajo»: quita el ruido (familia, amigos, comunidad, otros); queda guardado.
                            val n = com.tiecoms.app.core.WaView.workCount(counts, countsLoaded)
                            FilterChip(workOnly, { setWaWorkOnly(container.settings, !workOnly) }, label = { Text(stringResource(R.string.wa_work_only) + (n?.let { " $it" } ?: "")) },
                                modifier = Modifier.testTag("waWorkOnly"))
                        }
                        item {
                            val n = com.tiecoms.app.core.WaView.chipCount(counts, countsLoaded, null)
                            FilterChip(category == null, { category = null }, label = { Text(stringResource(R.string.wa_cat_all) + (n?.let { " $it" } ?: "")) }, modifier = Modifier.testTag("waCat-all"))
                        }
                        items(if (workOnly) WA_CATEGORIES.filter { it in com.tiecoms.app.core.WaView.WORK } else WA_CATEGORIES) { c ->
                            val n = com.tiecoms.app.core.WaView.chipCount(counts, countsLoaded, c)
                            val unread = counts[c]?.unread ?: 0
                            FilterChip(category == c, { category = c }, label = { Text("${CAT_ICON[c]} ${catName(c)}" + (n?.let { " $it" } ?: "") + if (countsLoaded && unread > 0) " · $unread" else "") },
                                modifier = Modifier.testTag("waCat-$c"))
                        }
                    }
                    Segmented(listOf(true to stringResource(R.string.wa_groups), false to stringResource(R.string.wa_all_chats)), onlyGroups, { onlyGroups = it }, Modifier.fillMaxWidth())
                    ErrorText(error)
                }
                LazyColumn(Modifier.fillMaxSize().testTag("whatsapp")) {
                    if (syncPartial && visibleChats.isEmpty()) item { Text(stringResource(R.string.wa_syncing), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 16.dp)) }
                    if (!loadedOnce) item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                    else if (visibleChats.isEmpty() && error == null && !chatsLoading) item { EmptyNote(stringResource(if (accs.any { it.status == "connected" }) R.string.wa_no_chats else R.string.wa_syncing)) }
                    items(visibleChats, key = { "${it.accountId}|${it.jid}" }) { c ->
                        val inbox = inboxOf(c)
                        Box(Modifier.animateItem()) {
                            WaSwipeRow(c.pinned, onPin = { togglePinWa(c) }, onHide = { hide(c) }, tag = "waSwipe-${c.jid}") {
                                ChatRow(c, accountColor = com.tiecoms.app.core.WaView.accountColor(accs, c.accountId)?.let { Color(it) },
                                    menuItems = { waChatMenu(ctx, inbox, onOpen = { onOpenChat(inbox) }, onPinWa = { togglePinWa(c) }, onHide = { if (c.hidden) patch(c, mapOf("hidden" to JsonPrimitive(false)), c.copy(hidden = false)) else hide(c) },
                                        onCategory = { cat -> patch(c, mapOf("category" to JsonPrimitive(cat)), c.copy(category = cat, categoryManual = true)) }) },
                                    onOpen = { onOpenChat(inbox) })
                            }
                        }
                    }
                    if (hasMore) item { TextButton(onClick = { scope.launch { loadChats(reset = false) } }, enabled = !chatsLoading, modifier = Modifier.padding(horizontal = 8.dp).testTag("waLoadMore")) { Text(stringResource(R.string.wa_load_more)) } }
                    item { Spacer(Modifier.heightIn(min = 24.dp)) }
                }
            }
        }
    }
    if (accountsOpen) FormSheet(stringResource(R.string.wa_accounts_title), { accountsOpen = false }, tag = "waAccountsSheet") {
        Text(stringResource(R.string.wa_intro), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        accs.forEach { a -> AccountCard(a) { scope.launch { loadAccounts() } } }
        if (accs.size < max) Button(onClick = { connectOpen = true }, modifier = Modifier.testTag("waConnect")) { Text(stringResource(R.string.wa_connect)) }
    }
    if (connectOpen) ConnectDialog(accs, onClose = { connectOpen = false }, onDone = { connectOpen = false; accountsOpen = true; scope.launch { loadAccounts() } })
}

/** «● 2 cuentas conectadas ›»: verde si todas, naranja si alguna espera el código, roja si alguna se cayó. */
@Composable
private fun AccountsLine(accounts: List<WaAccountDTO>, onClick: () -> Unit) {
    val s = com.tiecoms.app.core.WaView.summary(accounts)
    val dot = when { s.allConnected -> Color(0xFF1E8E5A); s.waiting -> Color(0xFFFF8A1F); else -> Color(0xFFC62828) }
    val text = when {
        s.allConnected -> pluralStringResource(R.plurals.wa_accounts_line, s.connected, s.connected)
        s.connected == 0 -> stringResource(R.string.wa_accounts_none)
        else -> stringResource(R.string.wa_accounts_partial, s.connected, s.total)
    }
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).heightIn(min = 36.dp).padding(horizontal = 4.dp, vertical = 6.dp).testTag("waAccountsLine"),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(dot, CircleShape))
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text("›", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Menú de un chat de WhatsApp (fila de la pantalla WhatsApp y ⋯ de la conversación): abrir, los dos pines con su
 * estado, llevar a / sacar de mi lista principal, categoría y ocultar.
 */
fun waChatMenu(ctx: android.content.Context, c: WaChatDTO, onOpen: (() -> Unit)?, onPinWa: () -> Unit, onHide: () -> Unit, onCategory: (String) -> Unit, extra: List<SheetItem?> = emptyList()): List<SheetItem?> {
    val suggested = com.tiecoms.app.core.WaInbox.suggested(c)
    val mark = " · " + ctx.getString(R.string.wa_suggested_mark)
    val mainPinned = c.inboxPinnedAt != null
    return listOfNotNull(
        onOpen?.let { SheetItem(ctx.getString(R.string.wa_open_chat), "↗", tag = "waMenuOpenChat", onClick = it) },
        SheetItem(ctx.getString(if (mainPinned) R.string.unpin_main else R.string.pin_main), "", tag = "waPinMain") { waInboxAct(ctx, c, pinned = !mainPinned) },
        SheetItem(ctx.getString(if (c.pinned) R.string.unpin_wa else R.string.pin_wa), "", tag = "waPinWa", onClick = onPinWa),
        null,
        if (c.inboxPlace == null) SheetItem(ctx.getString(R.string.wa_move_to_inbox), "⤴", tag = "waMoveInbox", children = listOf(
            SheetItem(ctx.getString(R.string.wa_to_groups) + if (suggested == com.tiecoms.app.core.WaInbox.GROUPS) mark else "", if (suggested == com.tiecoms.app.core.WaInbox.GROUPS) "✓" else "#", tag = "waToGroups") { waInboxAct(ctx, c, com.tiecoms.app.core.WaInbox.GROUPS, placeSet = true) },
            SheetItem(ctx.getString(R.string.wa_to_dms) + if (suggested == com.tiecoms.app.core.WaInbox.DMS) mark else "", if (suggested == com.tiecoms.app.core.WaInbox.DMS) "✓" else "✉", tag = "waToDms") { waInboxAct(ctx, c, com.tiecoms.app.core.WaInbox.DMS, placeSet = true) },
        )) else SheetItem(ctx.getString(R.string.wa_remove_from_inbox), "⎋", tag = "waRemoveInbox") { waInboxAct(ctx, c, null, placeSet = true) },
        SheetItem(ctx.getString(R.string.wa_category), CAT_ICON[c.category] ?: "◌", tag = "waMenuCategory", hint = catLabel(ctx, c.category),
            children = WA_CATEGORIES.map { k -> SheetItem(catLabel(ctx, k), if (k == c.category) "✓" else CAT_ICON[k] ?: "", tag = "waCatSet-$k") { onCategory(k) } }),
    ) + extra + listOf(null, SheetItem(ctx.getString(if (c.hidden) R.string.wa_unhide else R.string.wa_hide), "🙈", danger = !c.hidden, tag = "waMenuHide", onClick = onHide))
}

internal fun catLabel(ctx: android.content.Context, c: String) = ctx.getString(
    when (c) { "trabajo" -> R.string.wa_cat_trabajo; "clientes" -> R.string.wa_cat_clientes; "familia" -> R.string.wa_cat_familia; "amigos" -> R.string.wa_cat_amigos; "comunidad" -> R.string.wa_cat_comunidad; else -> R.string.wa_cat_otros },
)

/** Deslizar una fila de WhatsApp: a la derecha fija/quita en WhatsApp, a la izquierda la oculta. La fila vuelve a su sitio. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WaSwipeRow(pinned: Boolean, onPin: () -> Unit, onHide: () -> Unit, tag: String, content: @Composable () -> Unit) {
    val pin by rememberUpdatedState(onPin)
    val hide by rememberUpdatedState(onHide)
    val st = rememberSwipeToDismissBoxState()
    LaunchedEffect(st.currentValue) {
        when (st.currentValue) {
            SwipeToDismissBoxValue.StartToEnd -> { pin(); st.snapTo(SwipeToDismissBoxValue.Settled) }
            SwipeToDismissBoxValue.EndToStart -> { hide(); st.snapTo(SwipeToDismissBoxValue.Settled) }
            else -> Unit
        }
    }
    SwipeToDismissBox(state = st, modifier = Modifier.testTag(tag), backgroundContent = {
        val toEnd = st.dismissDirection == SwipeToDismissBoxValue.StartToEnd
        Box(Modifier.fillMaxSize().background(if (toEnd) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.errorContainer).padding(horizontal = 20.dp),
            contentAlignment = if (toEnd) Alignment.CenterStart else Alignment.CenterEnd) {
            Text(if (toEnd) stringResource(if (pinned) R.string.unpin_wa else R.string.pin_wa) else "🙈 " + stringResource(R.string.wa_hide),
                style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                color = if (toEnd) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onErrorContainer)
        }
    }) { Box(Modifier.background(MaterialTheme.colorScheme.background)) { content() } }
}

/** Estado de bandeja vigente de un chat: manda `waInbox` del bootstrap (lo que se mueve o fija se ve en el acto). */
@Composable
private fun inboxOf(c: WaChatDTO): WaChatDTO {
    val data = LocalClient.current.state.collectAsStateWithLifecycle().value.data ?: return c
    val live = data.waInbox.firstOrNull { it.accountId == c.accountId && it.jid == c.jid }
    return c.copy(inboxPlace = live?.inboxPlace, inboxPinnedAt = live?.inboxPinnedAt)
}

private fun decodeQr(dataUrl: String?): androidx.compose.ui.graphics.ImageBitmap? {
    if (dataUrl == null) return null
    val b64 = dataUrl.substringAfter("base64,", "")
    if (b64.isEmpty()) return null
    return runCatching { Base64.decode(b64, Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }.getOrNull()
}

@Composable
private fun AccountCard(a: WaAccountDTO, onChanged: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var phone by rememberSaveable { mutableStateOf("") }
    var usePhone by rememberSaveable { mutableStateOf(false) }
    var confirm by rememberSaveable { mutableStateOf(false) }
    val business = a.kind == "business" || a.platform?.startsWith("smb") == true
    fun run(block: suspend () -> Unit) { busy = true; scope.launch { runCatching { block() }.onFailure { container.toast(errorText(ctx, it)) }; busy = false; onChanged() } }
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().testTag("waAccount-${a.id}")) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (business) "🏪" else "👤", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("${a.label} · ${stringResource(if (business) R.string.wa_business else R.string.wa_title)}", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(a.phone?.let { "+$it" }, a.pushName).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val dot = when (a.status) { "connected" -> Color(0xFF1E8E5A); "qr", "pending", "reconnecting" -> Color(0xFFFF8A1F); else -> Color(0xFFC62828) }
                Box(Modifier.size(10.dp).background(dot, CircleShape))
            }
            Text(buildString {
                append(waStatus(a.status))
                if (a.status == "connected") append(" · " + ctx.getString(R.string.wa_counts, a.chats, a.groups))
                if (a.lastError != null && a.status != "connected" && a.status != "qr") append(" · " + a.lastError)
            }, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("waStatus-${a.id}"))
            if (a.status == "pending") Text(stringResource(R.string.wa_preparing), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (a.status == "qr") {
                val qr = remember(a.qr) { decodeQr(a.qr) }
                when {
                    a.pairingCode != null -> Text(a.pairingCode.replaceFirst(Regex("(.{4})"), "$1-"), fontFamily = FontFamily.Monospace, fontSize = 28.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.semantics { heading() }.testTag("waPairing"))
                    qr != null -> Image(qr, stringResource(R.string.wa_qr_alt), Modifier.size(220.dp).background(Color.White))
                }
                Text("1. " + stringResource(if (business) R.string.wa_step1b else R.string.wa_step1), style = MaterialTheme.typography.bodySmall)
                Text("2. " + stringResource(R.string.wa_step2), style = MaterialTheme.typography.bodySmall)
                Text("3. " + stringResource(if (a.pairingCode != null) R.string.wa_step3code else R.string.wa_step3), style = MaterialTheme.typography.bodySmall)
            }
            if (a.status in setOf("expired", "logged_out", "error")) {
                if (usePhone) OutlinedTextField(phone, { phone = it }, placeholder = { Text(stringResource(R.string.wa_phone_ph)) }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !busy, onClick = { run { client.waRelink(a.id, if (usePhone) phone else null) } }) { Text(stringResource(R.string.wa_new_code)) }
                    TextButton(onClick = { usePhone = !usePhone }) { Text(stringResource(if (usePhone) R.string.wa_use_qr else R.string.wa_use_phone)) }
                }
            }
            // «Responder desde chaggu»: apagado = solo lectura (por defecto).
            Row(Modifier.fillMaxWidth().clickable(enabled = !busy) { run { client.waSetSendEnabled(a.id, !a.sendEnabled) } }.testTag("waReply-${a.id}"), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.wa_reply_from_chaggu), style = MaterialTheme.typography.bodyMedium)
                    Text(stringResource(R.string.wa_reply_from_chaggu_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                androidx.compose.material3.Switch(a.sendEnabled, null, enabled = !busy)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(enabled = !busy, onClick = { confirm = true }, modifier = Modifier.testTag("waDisconnect-${a.id}")) { Text(stringResource(R.string.wa_disconnect)) }
            }
        }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false }, text = { Text(stringResource(R.string.wa_disconnect_confirm, a.label)) },
        confirmButton = { TextButton(onClick = { confirm = false; run { client.waRemove(a.id) } }) { Text(stringResource(R.string.wa_disconnect)) } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun ConnectDialog(existing: List<WaAccountDTO>, onClose: () -> Unit, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var kind by rememberSaveable { mutableStateOf(if (existing.any { it.kind == "personal" }) "business" else "personal") }
    var label by rememberSaveable { mutableStateOf("") }
    var usePhone by rememberSaveable { mutableStateOf(true) } // en el teléfono casi siempre es más práctico el código
    var phone by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val fallback = stringResource(if (kind == "business") R.string.wa_business_short else R.string.wa_personal)
    FormSheet(stringResource(R.string.wa_connect_title), onClose, tag = "waConnectDialog") {
        Text(stringResource(R.string.wa_connect_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
        listOf("personal", "business").forEach { k ->
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = if (kind == k) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                modifier = Modifier.fillMaxWidth().clickable { kind = k }.testTag("waKind-$k"),
            ) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (k == "business") "🏪" else "👤", style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text(stringResource(if (k == "business") R.string.wa_business else R.string.wa_title), fontWeight = FontWeight.SemiBold)
                        Text(stringResource(if (k == "business") R.string.wa_kind_business else R.string.wa_kind_personal), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
        OutlinedTextField(label, { label = it.take(60) }, label = { Text(stringResource(R.string.wa_label)) }, placeholder = { Text(fallback) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Segmented(listOf(false to stringResource(R.string.wa_with_qr), true to stringResource(R.string.wa_with_phone)), usePhone, { usePhone = it })
        if (usePhone) {
            OutlinedTextField(phone, { phone = it }, label = { Text(stringResource(R.string.wa_phone)) }, placeholder = { Text(stringResource(R.string.wa_phone_ph)) }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), supportingText = { Text(stringResource(R.string.wa_phone_hint)) }, modifier = Modifier.fillMaxWidth().testTag("waPhone"))
        }
        Text("🔒 " + stringResource(R.string.wa_privacy), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.wa_start), enabled = !busy && (!usePhone || phone.filter { it.isDigit() }.length >= 8), confirmTag = "waStart") {
            busy = true; error = null
            scope.launch {
                try { client.waCreate(label.trim().ifEmpty { fallback }, kind, if (usePhone && phone.isNotBlank()) phone else null); container.toast(ctx.getString(R.string.wa_linking)); onDone() }
                catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }
    }
}

/**
 * Fila de la pantalla WhatsApp: avatar, nombre (📌 si está fijado en WhatsApp), hora, vista previa y no leídos. Sin la
 * línea «cuenta · categoría»; con más de una cuenta, un punto pequeño del color de la cuenta. Toque = abrir;
 * pulsación larga o ⋮ = menú.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(c: WaChatDTO, accountColor: Color?, menuItems: () -> List<SheetItem?>, onOpen: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    Box {
        Row(Modifier.fillMaxWidth().combinedClickable(onClick = onOpen, onLongClick = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); menu = true },
            onLongClickLabel = stringResource(R.string.menu_more))
            .heightIn(min = 60.dp).padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp).testTag("waChat-${c.jid}"), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp)) {
                Avatar(c.name.ifBlank { "WA" }, MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant, size = 40.dp, square = c.isGroup)
                if (accountColor != null) Box(Modifier.align(Alignment.BottomEnd).size(12.dp).background(MaterialTheme.colorScheme.background, CircleShape).padding(2.dp)
                    .background(accountColor, CircleShape).testTag("waAccDot-${c.jid}"))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (c.pinned) Text("📌 ", style = MaterialTheme.typography.labelSmall, modifier = Modifier.testTag("waPinned-${c.jid}"))
                    Text(c.name, fontWeight = if (c.unread > 0) FontWeight.Bold else FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(whenShort(c.lastMessageAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(c.lastPreview ?: (if (c.isGroup && c.participants != null) stringResource(R.string.wa_members, c.participants) else ""), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (c.unread > 0) Box(Modifier.padding(start = 6.dp).background(Color(0xFF1FA855), CircleShape).padding(horizontal = 6.dp, vertical = 1.dp)) {
                        Text(if (c.unread > 99) "99+" else c.unread.toString(), color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                    }
                }
            }
            IconButton(onClick = { menu = true }, modifier = Modifier.size(40.dp).testTag("waRowMore-${c.jid}")) {
                Icon(Icons.Filled.MoreVert, stringResource(R.string.menu_more), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        AnchoredMenu(menu, if (menu) menuItems() else emptyList(), { menu = false })
    }
}

