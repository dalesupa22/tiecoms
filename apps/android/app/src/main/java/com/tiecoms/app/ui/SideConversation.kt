package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PersonDTO
import com.tiecoms.app.core.SideOutsiders
import com.tiecoms.app.core.TcJson
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Candidatos para un sidechat (SPEC-v3 §4): participantes del chat de origen y colegas de mis empresas; nadie de otra
 * empresa que no esté ya en el origen (el servidor lo rechaza con side_outsider).
 */
fun sideCandidates(d: BootstrapDTO, origin: ConversationDTO): List<PersonDTO> {
    val myOrgs = d.organizations.filter { it.myRole != null }.map { it.id }.toSet()
    val inOrigin = origin.memberIds.toSet()
    return d.people.filter { it.kind == "human" && it.id != d.me.id && (it.id in inOrigin || (it.orgId != null && it.orgId in myOrgs)) }
        .sortedWith(compareBy({ it.id !in inOrigin }, { it.name.lowercase() }))
}

/**
 * Sugerencias arriba del selector (SPEC-v4 §G.1): el autor del mensaje, la gente mencionada y quienes más escriben en el
 * chat de origen (entre los candidatos).
 */
fun sideSuggestions(d: BootstrapDTO, origin: ConversationDTO, anchor: MessageDTO, recent: List<MessageDTO>, max: Int = 6): List<PersonDTO> {
    val ok = sideCandidates(d, origin).associateBy { it.id }
    val order = LinkedHashSet<String>()
    if (anchor.authorId != d.me.id) order += anchor.authorId
    order += anchor.mentions.mapNotNull { it.userId.takeIf { u -> u != "all" } }
    recent.filter { it.kind == "text" && it.authorId != d.me.id }.groupingBy { it.authorId }.eachCount()
        .entries.sortedByDescending { it.value }.forEach { order += it.key }
    return order.mapNotNull { ok[it] }.take(max)
}

/** Sidechats de un mensaje ancla visibles para mí (calculado desde /bootstrap). */
fun sidesOf(d: BootstrapDTO, conversationId: String, messageId: String): List<ConversationDTO> =
    d.conversations.filter { it.isSide && it.parentId == conversationId && it.parentMessageId == messageId }

/** Datos de la tarjeta del ancla: del mensaje si lo tengo; si no, del mensaje de sistema side.started del sidechat. */
data class SideAnchor(val authorId: String?, val authorName: String, val text: String, val createdAt: String?, val seq: Long?)

fun sideAnchor(d: BootstrapDTO, side: ConversationDTO, anchor: MessageDTO?, sideMessages: List<MessageDTO>): SideAnchor? {
    if (anchor != null) return SideAnchor(anchor.authorId, Names.person(d, anchor.authorId)?.name ?: "", anchor.body, anchor.createdAt, anchor.seq)
    val sys = sideMessages.firstOrNull { it.kind == "system" && it.body.contains("side.started") } ?: return null
    val o = runCatching { TcJson.parseToJsonElement(sys.body) as? JsonObject }.getOrNull() ?: return null
    fun str(k: String) = runCatching { o[k]?.jsonPrimitive?.content }.getOrNull()
    return SideAnchor(null, str("authorName") ?: "", str("excerpt") ?: "", null, side.parentMessageSeq)
}

/** Avatares apilados (hasta [max], con «+N»). */
@Composable
fun StackedAvatars(ids: List<String>, data: BootstrapDTO, size: Dp = 26.dp, max: Int = 3, modifier: Modifier = Modifier) {
    val shown = ids.take(max)
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        shown.forEachIndexed { i, id ->
            Box(Modifier.offset(x = (-8 * i).dp).border(2.dp, MaterialTheme.colorScheme.surface, CircleShape)) { AuthorAvatar(Names.person(data, id), id, size) }
        }
        if (ids.size > max) Text("+${ids.size - max}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.offset(x = (-8 * shown.size + 12).dp))
    }
}

/** Nombre visible: «Sidechat · <extracto>» (los viejos «Consulta · …» ya se renombran en Names.conversationTitle). */
fun sideTitle(ctx: android.content.Context, c: ConversationDTO, d: BootstrapDTO?): String = titleOf(ctx, c, d)

// ---------- Iniciar ----------
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SideStartSheet(origin: ConversationDTO, anchor: MessageDTO, onClose: () -> Unit, onStarted: (String) -> Unit, preselect: List<String> = emptyList()) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val st = client.state.collectAsStateWithLifecycle().value
    val data = st.data ?: return
    val candidates = remember(data, origin) { sideCandidates(data, origin) }
    val suggestions = remember(data, origin, anchor) { sideSuggestions(data, origin, anchor, st.conversations[origin.id]?.messages.orEmpty().takeLast(200)) }
    var picked by rememberSaveable { mutableStateOf(preselect.ifEmpty { listOfNotNull(suggestions.firstOrNull()?.id?.takeIf { it == anchor.authorId }) }) }
    var question by rememberSaveable { mutableStateOf("") }
    var q by rememberSaveable { mutableStateOf("") }
    var outsiders by remember { mutableStateOf(setOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    fun toggle(id: String) { if (id !in outsiders) picked = if (id in picked) picked - id else picked + id }
    fun start() {
        if (busy || picked.isEmpty()) return
        busy = true; error = null
        scope.launch {
            try {
                val id = client.startSide(origin.id, anchor.id, picked, question)
                onClose(); onStarted(id)
            } catch (e: Exception) {
                val out = SideOutsiders.from(e)
                if (out.isNotEmpty()) { outsiders = outsiders + out; picked = picked - out }
                error = errorText(ctx, e)
            } finally { busy = false }
        }
    }
    FormSheet(stringResource(R.string.menu_ask_side), onClose, tag = "sideSheet") {
        // El mensaje ancla con el estilo de la burbuja original.
        AnchorBubble(Names.person(data, anchor.authorId), anchor.authorId, Names.person(data, anchor.authorId)?.name ?: "", anchor.body, anchor.createdAt, data)
        Text(stringResource(R.string.side_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        // Personas elegidas y sugeridas como chips con avatar.
        if (picked.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("sidePicked")) {
            picked.forEach { id ->
                val p = Names.person(data, id)
                FilterChip(selected = true, onClick = { toggle(id) }, label = { Text(p?.name?.substringBefore(' ') ?: "?") },
                    leadingIcon = { AuthorAvatar(p, id, 22.dp) }, trailingIcon = { Icon(Icons.Filled.Close, null, Modifier.size(16.dp)) })
            }
        }
        val rest = suggestions.filter { it.id !in picked }
        if (rest.isNotEmpty()) {
            Text(stringResource(R.string.side_suggestions), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("sideSuggestions")) {
                items(rest, key = { it.id }) { p ->
                    AssistChip(onClick = { toggle(p.id) }, label = { Text(p.name.substringBefore(' ')) }, leadingIcon = { AuthorAvatar(p, p.id, 22.dp) },
                        modifier = Modifier.testTag("sideSuggest-${p.id}"))
                }
            }
        }
        OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.side_search)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("sideSearch"))
        val inOrigin = origin.memberIds.toSet()
        if (q.isNotBlank()) candidates.filter { it.name.contains(q, ignoreCase = true) }.take(20).forEach { p ->
            val blocked = p.id in outsiders
            Row(Modifier.fillMaxWidth().clickable(enabled = !blocked) { toggle(p.id); q = "" }.heightIn(min = 52.dp).testTag("sidePerson-${p.id}"),
                verticalAlignment = Alignment.CenterVertically) {
                AuthorAvatar(p, p.id, 32.dp); Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (blocked) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.onSurface)
                    Text(if (blocked) stringResource(R.string.side_outsider) else stringResource(if (p.id in inOrigin) R.string.side_in_chat else R.string.side_colleagues),
                        style = MaterialTheme.typography.bodySmall, color = if (blocked) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (p.id in picked) Text("✓", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
            }
        }
        // Un toque menos: con una sola persona, Enter envía.
        OutlinedTextField(question, { question = it.take(4000) }, label = { Text(stringResource(R.string.side_question)) }, placeholder = { Text(stringResource(R.string.side_question_ph)) },
            minLines = 2, maxLines = 5,
            keyboardOptions = KeyboardOptions(imeAction = if (picked.size == 1) ImeAction.Send else ImeAction.Default),
            keyboardActions = KeyboardActions(onSend = { start() }),
            supportingText = if (picked.size == 1) ({ Text(stringResource(R.string.side_enter_sends)) }) else null,
            modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("sideQuestion"))
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.side_start), enabled = !busy && picked.isNotEmpty(), confirmTag = "sideStart") { start() }
    }
}

/** Burbuja del mensaje ancla (inicio del sidechat y tarjeta del panel). */
@Composable
fun AnchorBubble(p: PersonDTO?, authorId: String?, name: String, text: String, createdAt: String?, data: BootstrapDTO, maxLines: Int = 4, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().testTag("sideAnchorBubble"), verticalAlignment = Alignment.Top) {
        AuthorAvatar(p, authorId ?: name, 28.dp)
        Spacer(Modifier.width(8.dp))
        Surface(shape = RoundedCornerShape(4.dp, 18.dp, 18.dp, 18.dp), color = com.tiecoms.app.ui.theme.LocalChatColors.current.otherBubble) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelMedium, color = authorId?.let { personColor(it) } ?: MaterialTheme.colorScheme.onSurface)
                    createdAt?.let { parseInstant(it) }?.let { t ->
                        Text(" · " + java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT).format(t.atZone(java.time.ZoneId.systemDefault())),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Text(text, maxLines = maxLines, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
    @Suppress("UNUSED_EXPRESSION") data
}

// ---------- Chip-hilo bajo el ancla ----------
/**
 * Bajo el mensaje ancla (solo lo ven los miembros): avatares apilados, «Sidechat · N mensajes» (N = lastMessageSeq − 1,
 * como la web), el extracto de la última respuesta y un punto naranja si hay no leídos. Llevado al hilo → chip verde.
 * Varios sidechats en el mismo mensaje → «N sidechats» que abre la lista.
 */
@Composable
fun SideChip(sides: List<ConversationDTO>, onOpen: (String) -> Unit) {
    if (sides.isEmpty()) return
    val ctx = LocalContext.current
    val data = LocalClient.current.state.collectAsStateWithLifecycle().value.data ?: return
    var list by remember { mutableStateOf(false) }
    if (sides.size > 1) {
        Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.secondaryContainer,
            modifier = Modifier.padding(top = 4.dp).clickable { list = true }.testTag("sideChip")) {
            Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                StackedAvatars(sides.flatMap { it.memberIds }.distinct().filter { it != data.me.id }, data, 20.dp)
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.side_chip, sides.size), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
                if (sides.any { it.unread > 0 }) Box(Modifier.padding(start = 6.dp).size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
            }
        }
        if (list) ActionSheet(stringResource(R.string.side_list), sides.map { s -> SheetItem(sideTitle(ctx, s, data), "💬", tag = "sideListItem-${s.id}") { onOpen(s.id) } }) { list = false }
        return
    }
    val s = sides[0]
    if (s.returnedAt != null) {
        Surface(shape = RoundedCornerShape(14.dp), color = Color(0xFFDCFCE7), modifier = Modifier.padding(top = 4.dp).clickable { onOpen(s.id) }.testTag("sideChip")) {
            Text(stringResource(R.string.side_returned_chip), color = Color(0xFF166534), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp).testTag("sideChipReturned"))
        }
        return
    }
    val n = (s.lastMessageSeq - 1).coerceAtLeast(0).toInt()
    val last = s.lastHumanPreview?.let { h -> com.tiecoms.app.core.Attachments.preview(h.attachments, h.body, attLabels(ctx)) }
        ?: s.lastMessagePreview?.takeIf { !it.startsWith("{") }
    Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.padding(top = 4.dp).widthIn(max = 300.dp).clickable { onOpen(s.id) }.testTag("sideChip")) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            StackedAvatars(s.memberIds.filter { it != data.me.id }, data, 22.dp)
            Spacer(Modifier.width(6.dp))
            Column(Modifier.weight(1f, fill = false)) {
                Text("💬 " + stringResource(R.string.side_title) + " · " + (if (n == 1) stringResource(R.string.side_reply_one) else stringResource(R.string.side_replies, n)),
                    style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSecondaryContainer)
                if (!last.isNullOrBlank()) Text(last, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.8f), modifier = Modifier.testTag("sideChipLast"))
            }
            if (s.unread > 0 && !s.mutedAt(System.currentTimeMillis())) Box(Modifier.padding(start = 6.dp).size(8.dp).background(Color(0xFFE8710A), CircleShape).testTag("sideChipUnread"))
        }
    }
}

// ---------- Panel ----------
/**
 * Cabecera del panel: avatares apilados, «Privado · solo ustedes N» con candado, ⋯ (añadir persona, silenciar,
 * llevar al hilo, salir), minimizar / pantalla completa y cerrar; debajo, la tarjeta del ancla fija.
 */
@Composable
fun SidePanelHeader(
    side: ConversationDTO, anchor: SideAnchor?, data: BootstrapDTO,
    onFull: () -> Unit, onClose: () -> Unit, onMinimize: (() -> Unit)? = null,
    onSeeInChat: (() -> Unit)? = null, onAddPerson: () -> Unit = {}, onReturn: (() -> Unit)? = null, onLeave: () -> Unit = {},
    onCardBounds: (androidx.compose.ui.geometry.Rect) -> Unit = {},
) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("sideHeader")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StackedAvatars(side.memberIds, data, 28.dp)
            Spacer(Modifier.width(4.dp))
            Column(Modifier.weight(1f)) {
                // Un hilo (derivada) usa el mismo panel: «💬 título» y «Con los del chat · N personas» (docs/GRUPOS.md).
                if (side.isSide) {
                    Text(stringResource(R.string.side_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Lock, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(" " + stringResource(R.string.side_private_n, side.memberIds.size), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.testTag("sidePrivate"))
                    }
                } else {
                    Text("💬 " + threadTitle(ctx, side, data), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() }.testTag("threadTitle"))
                    Text(stringResource(R.string.bar_public) + " · " + stringResource(R.string.bar_people_n, side.memberIds.size), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            // «＋ Personas» dentro de un hilo, si puedo administrarlo.
            if (!side.isSide && side.canManage) IconButton(onClick = onAddPerson, modifier = Modifier.testTag("threadAddPeople")) {
                Icon(Icons.Filled.PersonAdd, stringResource(R.string.bar_add_people))
            }
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.testTag("sideMore")) { Icon(Icons.Filled.MoreVert, stringResource(R.string.menu_more)) }
                AnchoredMenu(menu, listOfNotNull(
                    if (side.isSide) SheetItem(ctx.getString(R.string.side_add_person), "＋", tag = "sideAddPerson") { onAddPerson() } else null,
                    SheetItem(ctx.getString(if (side.mutedAt(System.currentTimeMillis())) R.string.menu_unmute else R.string.menu_mute), "🔕", tag = "sideMute") {
                        scope.launch { runCatching { client.setConversationPrefs(side.id, mutedUntil = if (side.mutedAt(System.currentTimeMillis())) null else "2099-12-31T00:00:00Z") } }
                    },
                    onReturn?.let { r -> SheetItem(ctx.getString(if (side.isSide) R.string.side_return else R.string.lin_return), "↩", tag = "sideReturn") { r() } },
                    null,
                    SheetItem(ctx.getString(R.string.side_leave), "⎋", danger = true, tag = "sideLeave") { onLeave() },
                ), onDismiss = { menu = false })
            }
            if (onMinimize != null) IconButton(onClick = onMinimize, modifier = Modifier.testTag("sideMinimize")) { Icon(Icons.Filled.Remove, stringResource(R.string.side_minimize)) }
            else IconButton(onClick = onFull, modifier = Modifier.testTag("sideFull")) { Icon(Icons.Filled.OpenInFull, stringResource(R.string.side_open_full)) }
            IconButton(onClick = onClose, modifier = Modifier.testTag("sideClose")) { Icon(Icons.Filled.Close, stringResource(R.string.side_close)) }
        }
        if (anchor != null) Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 6.dp)
            .onGloballyPositioned { onCardBounds(it.boundsInRoot()) }.testTag("sideAnchor")) {
            Column(Modifier.padding(10.dp)) {
                AnchorBubble(anchor.authorId?.let { Names.person(data, it) }, anchor.authorId, anchor.authorName, anchor.text, anchor.createdAt, data, maxLines = 3)
                if (onSeeInChat != null) TextButton(onClick = onSeeInChat, contentPadding = PaddingValues(horizontal = 0.dp), modifier = Modifier.padding(start = 36.dp).testTag("sideSeeInChat")) {
                    Text(stringResource(R.string.side_see_in_chat), style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

/** En teléfono: hoja con detents medio y grande; arrastrar abajo la minimiza a una burbuja flotante. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SideSheetHost(onMinimize: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    LaunchedEffect(Unit) { runCatching { state.partialExpand() } }
    ModalBottomSheet(onDismissRequest = onMinimize, sheetState = state, scrimColor = Color.Black.copy(alpha = 0.18f), modifier = Modifier.testTag("sidePanel")) {
        // Con el teclado abierto (el compositor recibe el cursor, o se escribe «@»), la hoja a medias dejaría el compositor
        // y el buscador de menciones detrás del teclado: se abre entera.
        @OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
        val ime = androidx.compose.foundation.layout.WindowInsets.isImeVisible
        LaunchedEffect(ime) { if (ime && state.currentValue != SheetValue.Expanded) runCatching { state.expand() } }
        Column(Modifier.fillMaxWidth().fillMaxHeight(if (state.currentValue == SheetValue.Expanded) 0.94f else 0.9f)) { content() }
    }
}

/** Burbuja flotante del sidechat minimizado: avatares apilados y no leídos; tocar la abre, la ✕ la suelta. */
@Composable
fun FloatingSideBubble(side: ConversationDTO, data: BootstrapDTO, onOpen: () -> Unit, onDrop: () -> Unit, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.side_title)
    Surface(onClick = onOpen, shape = RoundedCornerShape(28.dp), shadowElevation = 6.dp, color = MaterialTheme.colorScheme.surface,
        modifier = modifier.semantics { contentDescription = label }.testTag("sideBubble")) {
        Row(Modifier.padding(start = 10.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("💬", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.width(4.dp))
            StackedAvatars(side.memberIds.filter { it != data.me.id }, data, 26.dp)
            if (side.unread > 0) Surface(shape = CircleShape, color = Color(0xFFB45309), modifier = Modifier.padding(start = 2.dp)) {
                Text(side.unread.toString(), color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
            }
            IconButton(onClick = onDrop, modifier = Modifier.size(32.dp).testTag("sideBubbleDrop")) { Icon(Icons.Filled.Close, stringResource(R.string.side_close), Modifier.size(16.dp)) }
        }
    }
}

/** Respuestas rápidas del lado de quien recibe: «Déjame reviso», «No sé, pregúntale a…», «Te respondo en un rato». */
@Composable
fun SideQuickReplies(onSend: (String) -> Unit, onAsk: () -> Unit) {
    val ctx = LocalContext.current
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), modifier = Modifier.testTag("sideQuick")) {
        item { AssistChip(onClick = { onSend(ctx.getString(R.string.side_quick_check)) }, label = { Text(stringResource(R.string.side_quick_check)) }, modifier = Modifier.testTag("quickCheck")) }
        item { AssistChip(onClick = onAsk, label = { Text(stringResource(R.string.side_quick_ask)) }, modifier = Modifier.testTag("quickAsk")) }
        item { AssistChip(onClick = { onSend(ctx.getString(R.string.side_quick_later)) }, label = { Text(stringResource(R.string.side_quick_later)) }, modifier = Modifier.testTag("quickLater")) }
    }
}

/** Sumar personas al sidechat (desde ⋯ o «No sé, pregúntale a…»): participantes del origen y colegas. */
@Composable
fun SideAddPeopleSheet(side: ConversationDTO, origin: ConversationDTO?, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val base = origin ?: side
    val candidates = remember(data, base, side) { sideCandidates(data, base).filter { it.id !in side.memberIds } }
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    FormSheet(stringResource(R.string.side_add_person), onClose, tag = "sideAddSheet") {
        candidates.take(40).forEach { p ->
            val on = p.id in picked
            Row(Modifier.fillMaxWidth().clickable { picked = if (on) picked - p.id else picked + p.id }.heightIn(min = 52.dp).testTag("sideAdd-${p.id}"),
                verticalAlignment = Alignment.CenterVertically) {
                androidx.compose.material3.Checkbox(on, null); Spacer(Modifier.width(6.dp))
                AuthorAvatar(p, p.id, 32.dp); Spacer(Modifier.width(10.dp))
                Text(p.name, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (candidates.isEmpty()) EmptyNote(stringResource(R.string.chat_nobody))
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.side_add_person), enabled = picked.isNotEmpty() && !busy, confirmTag = "sideAddConfirm") {
            busy = true
            scope.launch {
                try { client.addMembers(side.id, picked); onClose() } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }
    }
}

/**
 * «Llevar al hilo» (SPEC-v4 §G.6): resumen sugerido (POST /return/suggest: IA si hay, si no las últimas respuestas),
 * editable, con la vista previa de cómo se verá en el grupo y «Publicar en el hilo».
 */
@Composable
fun SideReturnSheet(side: ConversationDTO, parentName: String, onClose: () -> Unit, onReturned: (String, Long?) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    var summary by rememberSaveable { mutableStateOf("") }
    var source by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var askAiConsent by remember(side.id) { mutableStateOf(false) }
    if (askAiConsent) AiConsentDialog(voice = false, onAllow = {
        askAiConsent = false
        loading = true
        scope.launch {
            runCatching { client.suggestReturn(side.id, aiConsent = true) }
                .onSuccess { summary = it.summary; source = it.source }
                .onFailure { error = errorText(ctx, it) }
            loading = false
        }
    }, onWithoutAi = { askAiConsent = false }, onDismiss = { askAiConsent = false })
    LaunchedEffect(side.id) {
        runCatching { client.suggestReturn(side.id) }
            .onSuccess { if (summary.isBlank()) summary = it.summary; source = it.source }
            .onFailure {
                // Sin sugerencia: la última respuesta como punto de partida.
                if (summary.isBlank()) summary = client.state.value.conversations[side.id]?.messages?.lastOrNull { m -> m.kind == "text" && m.deletedAt == null }?.body ?: ""
            }
        loading = false
    }
    FormSheet(stringResource(R.string.side_return), onClose, tag = "returnDialog") {
        Text(stringResource(R.string.side_return_body, parentName), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        TextButton(onClick = { askAiConsent = true }, enabled = !loading && !busy, modifier = Modifier.testTag("returnAskAi")) {
            Text(stringResource(R.string.ai_consent_summary))
        }
        if (loading) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("returnSuggesting")) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.side_suggesting), style = MaterialTheme.typography.bodySmall)
        } else source?.let { Text("✦ " + stringResource(if (it == "ai") R.string.side_suggested else R.string.side_suggested_fallback),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("returnSource")) }
        OutlinedTextField(summary, { summary = it.take(4000) }, minLines = 4, supportingText = { Text(stringResource(R.string.side_return_edit)) },
            modifier = Modifier.fillMaxWidth().testTag("returnSummary"))
        if (summary.isNotBlank()) {
            Text(stringResource(R.string.side_preview_in_group), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Surface(shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp), color = com.tiecoms.app.ui.theme.LocalChatColors.current.mineBubble, modifier = Modifier.fillMaxWidth().testTag("returnPreview")) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text("↩ " + stringResource(R.string.side_from_sidechat), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                        color = com.tiecoms.app.ui.theme.LocalChatColors.current.onMine)
                    Text(summary.trim(), color = com.tiecoms.app.ui.theme.LocalChatColors.current.onMine, maxLines = 6, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.side_publish), enabled = !busy && summary.trim().length >= 2, confirmTag = "returnSend") {
            busy = true; error = null
            scope.launch {
                try {
                    val r = client.returnResult(side.id, summary.trim())
                    onClose(); onReturned(r.parentId, client.meta(r.parentId)?.lastMessageSeq)
                } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }
    }
}

/** Contenido del panel del sidechat: cabecera, tarjeta del ancla y la conversación (compacta, embebida). */
@Composable
fun SidechatContent(
    side: ConversationDTO, anchorMsg: MessageDTO?, data: BootstrapDTO,
    onClose: () -> Unit, onMinimize: (() -> Unit)?, onFull: () -> Unit, onSeeInChat: () -> Unit,
    onAddPerson: () -> Unit, onReturn: () -> Unit, onLeave: () -> Unit,
    onDetails: () -> Unit, onOpenConversation: (String, Long?) -> Unit, onOpenIssue: (String) -> Unit, onOpenEvent: (String) -> Unit,
    onTrazo: () -> Unit, onOpenWorkspace: (String) -> Unit, onPrivateReply: (MessageDTO) -> Unit,
    onCardBounds: (androidx.compose.ui.geometry.Rect) -> Unit = {},
) {
    val st = LocalClient.current.state.collectAsStateWithLifecycle().value
    val anchor = sideAnchor(data, side, anchorMsg, st.conversations[side.id]?.messages.orEmpty())
    SidePanelHeader(side, anchor, data, onFull = onFull, onClose = onClose, onMinimize = onMinimize, onSeeInChat = onSeeInChat,
        onAddPerson = onAddPerson, onReturn = if (side.parentId != null && data.conversations.any { it.id == side.parentId }) onReturn else null, onLeave = onLeave,
        onCardBounds = onCardBounds)
    ConversationScreen(side.id, null, onBack = onClose, onDetails = onDetails, onOpenConversation = onOpenConversation, onOpenIssue = onOpenIssue,
        onOpenEvent = onOpenEvent, onTrazo = onTrazo, onOpenWorkspace = onOpenWorkspace, onPrivateReply = onPrivateReply, embedded = true)
}

/**
 * Recorrido del conector por el margen (como iOS): sale del borde derecho de la burbuja ancla, va al margen derecho de la
 * columna del chat, sube o baja por él con esquinas redondeadas y entra en horizontal hasta [ex]. Nunca cruza burbujas.
 */
fun gutterPath(sx: Float, sy: Float, gx: Float, ey: Float, ex: Float, r: Float): androidx.compose.ui.graphics.Path =
    androidx.compose.ui.graphics.Path().apply {
        moveTo(sx, sy)
        val dy = ey - sy
        val rr = minOf(r, kotlin.math.abs(dy) / 2f, kotlin.math.abs(gx - sx).coerceAtLeast(0.1f))
        if (kotlin.math.abs(dy) < 1f) { lineTo(ex, ey); return@apply }
        val dir = if (dy > 0) 1f else -1f
        lineTo(gx - rr, sy)
        quadraticTo(gx, sy, gx, sy + dir * rr)
        lineTo(gx, ey - dir * rr)
        quadraticTo(gx, ey, gx + rr, ey)
        lineTo(ex, ey)
    }

/**
 * Conector (pantalla ancha): del borde exacto de la burbuja ancla, por el margen derecho de la columna del chat, a la
 * tarjeta del ancla del panel. Un punto en cada extremo; punteado si el ancla salió de la vista (apunta al borde).
 */
@Composable
fun SideConnector(anchor: androidx.compose.ui.geometry.Rect?, list: androidx.compose.ui.geometry.Rect?, card: androidx.compose.ui.geometry.Rect?,
                  origin: androidx.compose.ui.geometry.Offset, authorId: String?) {
    val c = card ?: return
    val l = list ?: return
    val color = authorId?.let { personColor(it) } ?: com.tiecoms.app.ui.theme.Brand.Orange
    androidx.compose.foundation.Canvas(Modifier.fillMaxSize().testTag("sideConnector")) {
        val stroke = 2.dp.toPx()
        val visible = anchor != null && anchor.bottom > l.top && anchor.top < l.bottom
        val gx = l.right - 6.dp.toPx() - origin.x
        val sx = (if (visible) anchor!!.right else l.right - 6.dp.toPx()) - origin.x
        val sy = (if (visible) anchor!!.center.y.coerceIn(l.top + 8.dp.toPx(), l.bottom - 8.dp.toPx())
                  else if (anchor != null && anchor.center.y >= l.bottom) l.bottom - 4.dp.toPx() else l.top + 4.dp.toPx()) - origin.y
        val ex = c.left - origin.x
        val ey = c.center.y - origin.y
        drawPath(gutterPath(sx, sy, gx, ey, ex, 12.dp.toPx()), color, style = androidx.compose.ui.graphics.drawscope.Stroke(
            width = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round,
            pathEffect = if (visible) null else androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx()))))
        drawCircle(color, radius = stroke * 2f, center = androidx.compose.ui.geometry.Offset(sx, sy))
        drawCircle(color, radius = stroke * 2f, center = androidx.compose.ui.geometry.Offset(ex, ey))
    }
}

/** Teléfono: del borde de la burbuja ancla, por el margen derecho, hasta el borde de la hoja (sin cruzar burbujas). */
@Composable
fun SideTether(anchor: androidx.compose.ui.geometry.Rect?, list: androidx.compose.ui.geometry.Rect?, origin: androidx.compose.ui.geometry.Offset) {
    val a = anchor ?: return
    val l = list ?: return
    androidx.compose.foundation.Canvas(Modifier.fillMaxSize().testTag("sideTether")) {
        val color = com.tiecoms.app.ui.theme.Brand.Orange.copy(alpha = 0.85f)
        val stroke = 1.5.dp.toPx()
        val gx = l.right - 6.dp.toPx() - origin.x
        val sx = a.right - origin.x
        val sy = a.center.y - origin.y
        val path = androidx.compose.ui.graphics.Path().apply {
            val r = minOf(10.dp.toPx(), kotlin.math.abs(gx - sx).coerceAtLeast(0.1f))
            moveTo(sx, sy); lineTo(gx - r, sy); quadraticTo(gx, sy, gx, sy + r); lineTo(gx, size.height)
        }
        drawPath(path, color, style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
        drawCircle(color, radius = stroke * 2.2f, center = androidx.compose.ui.geometry.Offset(sx, sy))
    }
}
