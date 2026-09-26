package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.Links
import com.tiecoms.app.core.MentionDTO
import com.tiecoms.app.core.MentionItemDTO
import com.tiecoms.app.core.Mentions
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PersonDTO
import kotlinx.coroutines.launch

/** Resalta los tokens de mención en el compositor (mismo texto: el mapeo de offsets es la identidad). */
class MentionHighlight(private val mentions: List<MentionDTO>, private val color: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        if (mentions.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        val b = AnnotatedString.Builder(text)
        mentions.forEach { m ->
            if (m.start >= 0 && m.start + m.length <= text.length) b.addStyle(SpanStyle(color = color, fontWeight = FontWeight.SemiBold, background = color.copy(alpha = 0.10f)), m.start, m.start + m.length)
        }
        return TransformedText(b.toAnnotatedString(), OffsetMapping.Identity)
    }
    override fun equals(other: Any?) = other is MentionHighlight && other.mentions == mentions && other.color == color
    override fun hashCode() = mentions.hashCode() * 31 + color.hashCode()
}

/** Lista sobre el compositor al escribir «@»: participantes (primero los que más escriben), «@todos», y quien no está. */
@Composable
fun MentionPicker(query: String, conv: ConversationDTO, data: BootstrapDTO, onPick: (String, String) -> Unit, onAddToChat: (PersonDTO) -> Unit, onAskSide: (PersonDTO) -> Unit) {
    val ctx = LocalContext.current
    val st = LocalClient.current.state.collectAsStateWithLifecycle().value
    val recent = st.conversations[conv.id]?.messages.orEmpty().takeLast(200)
    val allLabel = stringResource(R.string.mention_all)
    val list = remember(query, conv, data, recent.size) { Mentions.candidates(data, conv, query, recent, allLabel) }
    val outsider = remember(query, conv, data) { if (list.none { it.userId != Mentions.ALL }) Mentions.outsider(data, conv, query) else null }
    Surface(tonalElevation = 3.dp, shadowElevation = 4.dp, shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp), modifier = Modifier.fillMaxWidth().testTag("mentionPicker")) {
        Column(Modifier.padding(vertical = 4.dp)) {
            Text(stringResource(R.string.mention_picker), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            list.take(6).forEach { c ->
                Row(Modifier.fillMaxWidth().clickable { onPick(c.userId, c.name) }.heightIn(min = 48.dp).padding(horizontal = 12.dp).testTag("mention-${c.userId}"), verticalAlignment = Alignment.CenterVertically) {
                    if (c.userId == Mentions.ALL) Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.size(32.dp)) {
                        Text("@", modifier = Modifier.padding(top = 4.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimaryContainer)
                    } else AuthorAvatar(Names.person(data, c.userId), c.userId, 32.dp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(if (c.userId == Mentions.ALL) "@" + c.name else c.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val line = if (c.userId == Mentions.ALL) stringResource(R.string.mention_all_hint) else c.line
                        if (line.isNotBlank()) Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (outsider != null) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).testTag("mentionOutsider"), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.mention_not_in_chat, outsider.name), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                if (conv.canManage || conv.kind == "multi") TextButton(onClick = { onAddToChat(outsider) }, modifier = Modifier.testTag("mentionAdd")) { Text(stringResource(R.string.mention_add_to_chat)) }
                TextButton(onClick = { onAskSide(outsider) }, modifier = Modifier.testTag("mentionSide")) { Text(stringResource(R.string.mention_ask_side)) }
            } else if (list.isEmpty()) Text(stringResource(R.string.mention_no_match), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            @Suppress("UNUSED_EXPRESSION") ctx
        }
    }
}

/**
 * Texto de la burbuja con enlaces y menciones: en negrita con el color de la persona; si me mencionan (a mí o @todos),
 * con fondo naranja suave. Tocar una mención abre la tarjeta de la persona.
 */
@Composable
fun MessageText(text: String, mentions: List<MentionDTO>, color: Color, data: BootstrapDTO, onPerson: (String) -> Unit, modifier: Modifier = Modifier,
                /** En listas (bandeja) el toque es de la fila: sin enlaces propios. */
                interactive: Boolean = true) {
    if (mentions.isEmpty()) { LinkifiedText(text, color, modifier); return }
    val ctx = LocalContext.current
    val me = data.me.id
    val colors = mentions.associate { it.userId to (if (it.userId == Mentions.ALL) color else personColor(it.userId)) }
    val annotated = remember(text, mentions, color, interactive) {
        buildAnnotatedString {
            val valid = mentions.filter { it.start >= 0 && it.start + it.length <= text.length }.sortedBy { it.start }
            var i = 0
            fun plain(to: Int) {
                if (to <= i) return
                Links.split(text.substring(i, to)).forEach { p ->
                    val u = p.url
                    if (u == null || !interactive) append(p.text)
                    else withLink(LinkAnnotation.Url(u, TextLinkStyles(SpanStyle(color = color, textDecoration = TextDecoration.Underline))) { openUrl(ctx, u) }) { append(p.text) }
                }
                i = to
            }
            valid.forEach { m ->
                if (m.start < i) return@forEach
                plain(m.start)
                val mine = m.userId == me || m.userId == Mentions.ALL
                val style = SpanStyle(fontWeight = FontWeight.Bold, color = if (mine) Color(0xFF9A3412) else colors[m.userId] ?: color,
                    background = if (mine) Color(0x33FDBA74) else Color.Transparent)
                if (interactive && m.userId != Mentions.ALL) withLink(LinkAnnotation.Clickable("mention:${m.userId}", TextLinkStyles(style = style)) { onPerson(m.userId) }) { append(text.substring(m.start, m.start + m.length)) }
                else withStyle(style) { append(text.substring(m.start, m.start + m.length)) }
                i = m.start + m.length
            }
            plain(text.length)
        }
    }
    Text(annotated, color = color, style = MaterialTheme.typography.bodyLarge, modifier = modifier)
}

/** Tarjeta de la persona al tocar una mención: Enviar mensaje. */
@Composable
fun PersonCardSheet(personId: String, onClose: () -> Unit, onDirect: (String) -> Unit) {
    val data = LocalClient.current.state.collectAsStateWithLifecycle().value.data ?: return
    val p = Names.person(data, personId) ?: return
    FormSheet(p.name, onClose, tag = "personCard") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            PersonAvatar(p, data, size = 56.dp, orgBadge = true); Spacer(Modifier.width(12.dp))
            Column {
                Text(p.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(listOfNotNull(Names.roleLine(p).ifBlank { null }, Names.org(data, p.orgId)?.name).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (p.id != data.me.id) DialogButtons(onClose, stringResource(R.string.person_send_message), confirmTag = "personDirect") { onClose(); onDirect(p.id) }
    }
}

/** Bandeja «Menciones»: mis menciones recientes con autor, conversación y hora; tocar abre el mensaje. */
@Composable
fun MentionsInboxScreen(onBack: () -> Unit, onOpen: (String, Long) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var items by remember { mutableStateOf(listOf<MentionItemDTO>()) }
    var more by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load(before: String?) {
        loading = true
        runCatching { client.loadMentions(before) }.onSuccess { p -> items = items + p.mentions; more = p.hasMore }.onFailure { error = errorText(ctx, it) }
        loading = false
    }
    LaunchedEffect(Unit) { load(null) }
    SimpleScaffold(title = stringResource(R.string.mention_inbox), onBack = onBack) {
        ErrorText(error)
        LazyColumn(Modifier.fillMaxSize().testTag("mentionsInbox")) {
            if (!loading && items.isEmpty()) item { EmptyNote(stringResource(R.string.mention_empty)) }
            items(items, key = { it.message.id }) { it ->
                val m = it.message
                val conv = data.conversations.firstOrNull { c -> c.id == it.conversationId }
                Row(Modifier.fillMaxWidth().clickable { onOpen(it.conversationId, m.seq) }.background(if (!it.read) Color(0x14E8710A) else Color.Transparent)
                    .padding(horizontal = 16.dp, vertical = 10.dp).testTag("mentionItem-${m.id}"), verticalAlignment = Alignment.Top) {
                    AuthorAvatar(Names.person(data, m.authorId), m.authorId, 36.dp); Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(Names.person(data, m.authorId)?.name ?: "", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            conv?.let { c -> Text(" " + stringResource(R.string.mention_in_conv, titleOf(ctx, c, data)), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false)) }
                            Text(" · " + timeText(it.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        MessageText(m.body, m.mentions, MaterialTheme.colorScheme.onSurface, data, onPerson = {}, interactive = false)
                    }
                }
            }
            if (more) item {
                TextButton(onClick = { scope.launch { load(items.lastOrNull()?.createdAt) } }, enabled = !loading, modifier = Modifier.fillMaxWidth().testTag("mentionsMore")) {
                    Text(stringResource(R.string.mention_load_more))
                }
            }
        }
    }
}
