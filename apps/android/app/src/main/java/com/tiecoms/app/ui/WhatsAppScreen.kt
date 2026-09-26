package com.tiecoms.app.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
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

val WA_CATEGORIES = listOf("trabajo", "clientes", "familia", "amigos", "comunidad", "otros")
private val CAT_ICON = mapOf("trabajo" to "💼", "clientes" to "🤝", "familia" to "🏠", "amigos" to "🍻", "comunidad" to "🏘", "otros" to "◌")

@Composable
private fun catName(c: String) = stringResource(
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

@Composable
fun WhatsAppScreen(onBack: () -> Unit, onOpenConversation: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val revision = client.state.collectAsStateWithLifecycle().value.waRevision
    var accounts by remember { mutableStateOf<List<WaAccountDTO>?>(null) }
    var max by remember { mutableStateOf(5) }
    var connectOpen by rememberSaveable { mutableStateOf(false) }
    var chats by remember { mutableStateOf<List<WaChatDTO>>(emptyList()) }
    var counts by remember { mutableStateOf<Map<String, WaCount>>(emptyMap()) }
    var accountId by rememberSaveable { mutableStateOf<String?>(null) }
    var category by rememberSaveable { mutableStateOf<String?>(null) }
    var onlyGroups by rememberSaveable { mutableStateOf(true) }
    var showHidden by rememberSaveable { mutableStateOf(false) }
    var q by rememberSaveable { mutableStateOf("") }
    var open by remember { mutableStateOf<WaChatDTO?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun loadAccounts() { runCatching { client.waAccounts() }.onSuccess { accounts = it.accounts; max = it.max }.onFailure { error = errorText(ctx, it); if (accounts == null) accounts = emptyList() } }
    suspend fun loadChats() { runCatching { client.waChats(accountId, category, if (onlyGroups) true else null, showHidden, q) }.onSuccess { chats = it.chats; counts = it.categories } }
    LaunchedEffect(revision) { loadAccounts() }
    LaunchedEffect(revision, accountId, category, onlyGroups, showHidden, q) { if (q.isNotEmpty()) delay(250); loadChats() }
    // Mientras hay un código en pantalla se pregunta seguido: el QR cambia cada ~20 s.
    val waiting = accounts?.any { it.status == "pending" || it.status == "qr" || it.status == "reconnecting" } == true
    LaunchedEffect(waiting) { while (waiting) { delay(3000); loadAccounts() } }
    val connected = accounts?.filter { it.status == "connected" } ?: emptyList()
    val total = counts.values.sumOf { it.total }
    fun patch(c: WaChatDTO, p: Map<String, JsonElement>) = scope.launch {
        runCatching { client.waPatchChat(c, kotlinx.serialization.json.JsonObject(p)) }
            .onSuccess { up -> chats = chats.map { if (it.accountId == up.accountId && it.jid == up.jid) up else it }; if (open?.jid == up.jid && open?.accountId == up.accountId) open = up; loadChats() }
            .onFailure { container.toast(errorText(ctx, it)) }
    }

    SimpleScaffold(stringResource(R.string.wa_title), onBack) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("whatsapp"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text(stringResource(R.string.wa_intro), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                if ((accounts?.size ?: 0) < max) Button(onClick = { connectOpen = true }, modifier = Modifier.padding(top = 8.dp).testTag("waConnect")) { Text(stringResource(R.string.wa_connect)) }
                ErrorText(error)
            }
            if (accounts == null) item { CircularProgressIndicator() }
            if (accounts?.isEmpty() == true) item {
                Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("👤  🏪", style = MaterialTheme.typography.headlineSmall)
                        Text(stringResource(R.string.wa_empty_title), fontWeight = FontWeight.Bold)
                        Text(stringResource(R.string.wa_empty_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            items(accounts ?: emptyList(), key = { it.id }) { a -> AccountCard(a) { scope.launch { loadAccounts() } } }
            if (connected.isNotEmpty() || total > 0) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 16.dp)) {
                        SectionHeader(stringResource(R.string.wa_organizer), Modifier.weight(1f).semantics { heading() })
                        TextButton(onClick = { scope.launch { runCatching { client.waOrganize() }.onSuccess { container.toast(ctx.getString(R.string.wa_organized, it.changed)); loadChats() }.onFailure { container.toast(errorText(ctx, it)) } } }) {
                            Text("✦ " + stringResource(R.string.wa_reorganize))
                        }
                    }
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        item { FilterChip(category == null, { category = null }, label = { Text("${stringResource(R.string.wa_cat_all)} $total") }) }
                        items(WA_CATEGORIES) { c ->
                            val n = counts[c]
                            FilterChip(category == c, { category = c }, label = { Text("${CAT_ICON[c]} ${catName(c)} ${n?.total ?: 0}" + if ((n?.unread ?: 0) > 0) " · ${n!!.unread}" else "") })
                        }
                    }
                    OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.wa_search)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    if ((accounts?.size ?: 0) > 1) {
                        Dropdown("", listOf<Pair<String?, String>>(null to stringResource(R.string.wa_all_accounts)) + accounts!!.map { it.id to it.label }, accountId, { accountId = it }, Modifier.fillMaxWidth().padding(top = 8.dp))
                    }
                    Segmented(listOf(true to stringResource(R.string.wa_groups), false to stringResource(R.string.wa_all_chats)), onlyGroups, { onlyGroups = it }, Modifier.padding(top = 8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { showHidden = !showHidden }) {
                        Checkbox(showHidden, null); Text(stringResource(R.string.wa_show_hidden), style = MaterialTheme.typography.bodySmall)
                    }
                }
                if (chats.isEmpty()) item { EmptyNote(stringResource(if (connected.isNotEmpty()) R.string.wa_no_chats else R.string.wa_syncing)) }
                items(chats, key = { "${it.accountId}|${it.jid}" }) { c -> ChatRow(c, multi = (accounts?.size ?: 0) > 1) { open = c } }
            }
            item { Spacer(Modifier.heightIn(min = 24.dp)) }
        }
    }
    if (connectOpen) ConnectDialog(accounts ?: emptyList(), onClose = { connectOpen = false }, onDone = { connectOpen = false; scope.launch { loadAccounts() } })
    open?.let { c -> ChatSheet(c, revision, onClose = { open = null }, onPatch = { patch(c, it) }, onOpenConversation = onOpenConversation) }
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
                    Text("${a.label} · ${if (business) "WhatsApp Business" else "WhatsApp"}", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(enabled = !busy, onClick = { confirm = true }) { Text(stringResource(R.string.wa_disconnect)) }
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
    val fallback = if (kind == "business") "Business" else stringResource(R.string.wa_personal)
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
                        Text(if (k == "business") "WhatsApp Business" else "WhatsApp", fontWeight = FontWeight.SemiBold)
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

@Composable
private fun ChatRow(c: WaChatDTO, multi: Boolean, onOpen: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).heightIn(min = 60.dp).padding(vertical = 6.dp).testTag("waChat-${c.jid}"), verticalAlignment = Alignment.CenterVertically) {
        Text(if (c.isGroup) "👥" else CAT_ICON[c.category] ?: "◌", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text((if (c.pinned) "📌 " else "") + c.name, fontWeight = if (c.unread > 0) FontWeight.Bold else FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(whenShort(c.lastMessageAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(c.lastPreview ?: (if (c.isGroup && c.participants != null) stringResource(R.string.wa_members, c.participants) else ""), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(if (multi) c.accountLabel else null, "${CAT_ICON[c.category]} ${catName(c.category)}", if (c.linkedConversationId != null) "⇄ Chaggu" else null).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (c.unread > 0) Box(Modifier.background(MaterialTheme.colorScheme.primary, CircleShape).padding(horizontal = 6.dp, vertical = 2.dp)) {
            Text(c.unread.toString(), color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun ChatSheet(c: WaChatDTO, revision: Int, onClose: () -> Unit, onPatch: (Map<String, JsonElement>) -> Unit, onOpenConversation: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var messages by remember { mutableStateOf<List<WaMessageDTO>?>(null) }
    LaunchedEffect(c.accountId, c.jid, revision) { messages = runCatching { client.waMessages(c) }.getOrDefault(emptyList()) }
    val targets = data.conversations.filter { it.kind != "direct" && it.canPost }
    val linked = c.linkedConversationId?.let { id -> data.conversations.firstOrNull { it.id == id } }
    FormSheet(c.name, onClose, tag = "waChatSheet") {
        Text(listOfNotNull(c.accountLabel, if (c.isGroup && c.participants != null) stringResource(R.string.wa_members, c.participants) else null).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Dropdown(stringResource(R.string.wa_category), WA_CATEGORIES.map { it to "${CAT_ICON[it]} ${catName(it)}" }, c.category, { onPatch(mapOf("category" to JsonPrimitive(it))) })
        Text(stringResource(if (c.categoryManual) R.string.wa_manual else R.string.wa_suggested), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        c.description?.let { Text(it.take(300), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        when {
            messages == null -> CircularProgressIndicator()
            messages!!.isEmpty() -> Text(stringResource(R.string.wa_no_messages), style = MaterialTheme.typography.bodySmall)
            else -> messages!!.takeLast(40).forEach { m ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = if (m.fromMe) Arrangement.End else Arrangement.Start) {
                    Surface(shape = RoundedCornerShape(12.dp), color = if (m.fromMe) Color(0xFFDCF8C6) else MaterialTheme.colorScheme.surfaceContainerHigh) {
                        Column(Modifier.padding(8.dp)) {
                            if (!m.fromMe && c.isGroup && m.author != null) Text(m.author, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = if (m.fromMe) Color(0xFF1F1F1F) else MaterialTheme.colorScheme.onSurface)
                            Text(m.body, color = if (m.fromMe) Color(0xFF1F1F1F) else MaterialTheme.colorScheme.onSurface)
                            Text(shortDateTime(m.sentAt), style = MaterialTheme.typography.labelSmall, color = if (m.fromMe) Color(0xFF55605A) else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { onPatch(mapOf("pinned" to JsonPrimitive(!c.pinned))) }) { Text(stringResource(if (c.pinned) R.string.wa_unpin else R.string.wa_pin)) }
            OutlinedButton(onClick = { onPatch(mapOf("hidden" to JsonPrimitive(!c.hidden))) }) { Text(stringResource(if (c.hidden) R.string.wa_unhide else R.string.wa_hide)) }
            if (c.categoryManual) TextButton(onClick = { onPatch(mapOf("category" to JsonNull)) }) { Text(stringResource(R.string.wa_reset_category)) }
        }
        Dropdown(stringResource(R.string.wa_link_to), listOf<Pair<String?, String>>(null to stringResource(R.string.wa_not_linked)) + targets.map { x -> x.id to (titleOf(ctx, x, data) + (data.workspaces.firstOrNull { it.id == x.workspaceId }?.let { " · ${it.name}" } ?: "")) },
            c.linkedConversationId, { onPatch(mapOf("linkedConversationId" to (it?.let { v -> JsonPrimitive(v) } ?: JsonNull))) })
        if (linked != null) TextButton(onClick = { onClose(); onOpenConversation(linked.id) }) { Text(stringResource(R.string.wa_linked_hint, titleOf(ctx, linked, data))) }
        else Text(stringResource(R.string.wa_link_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

