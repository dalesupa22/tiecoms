package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.ui.unit.em
import androidx.compose.foundation.text.appendInlineContent
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
import androidx.compose.animation.core.animateFloat

/** Colores de @gg (Gg.GRADIENT) y el fondo tenue del compositor. */
private val GgColors = com.tiecoms.app.core.Gg.GRADIENT.map { Color(it) }
private val GgFaint = Color(0x24FF4FA3)
private const val GG_PILL = "gg-pill"

/**
 * Estilo de @gg: texto en degradado, en negrita; [phase] 0..1 desplaza el degradado (el brillo). Con [pill], fondo de
 * pastilla (blanca en la burbuja propia de color).
 */
internal fun ggStyle(phase: Float, pill: Color? = null): SpanStyle {
    val w = 140f
    val x = -w * 2 * phase
    return SpanStyle(
        brush = androidx.compose.ui.graphics.Brush.linearGradient(GgColors + GgColors.first(), start = androidx.compose.ui.geometry.Offset(x, 0f),
            end = androidx.compose.ui.geometry.Offset(x + w, 0f), tileMode = androidx.compose.ui.graphics.TileMode.Mirror),
        fontWeight = FontWeight.ExtraBold, background = pill ?: Color.Unspecified,
    )
}

/** Brillo suave de @gg (6 s por vuelta, como la web); quieto si el sistema quitó las animaciones. */
@Composable
internal fun rememberGgShimmer(active: Boolean): Float {
    val ctx = LocalContext.current
    val still = remember { runCatching { android.provider.Settings.Global.getFloat(ctx.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false) }
    if (!active || still) return 0f
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "gg")
    val v by t.animateFloat(0f, 1f, androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(6000, easing = androidx.compose.animation.core.LinearEasing)), label = "ggShimmer")
    return v
}

/** Resalta los tokens de mención en el compositor (mismo texto: el mapeo de offsets es la identidad). */
class MentionHighlight(private val mentions: List<MentionDTO>, private val color: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val gg = com.tiecoms.app.core.Gg.ggMentions(text.text, mentions)
        if (mentions.isEmpty() && gg.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        val b = AnnotatedString.Builder(text)
        mentions.forEach { m ->
            if (com.tiecoms.app.core.Gg.isGg(m.userId)) return@forEach
            if (m.start >= 0 && m.start + m.length <= text.length) b.addStyle(SpanStyle(color = color, fontWeight = FontWeight.SemiBold, background = color.copy(alpha = 0.10f)), m.start, m.start + m.length)
        }
        // @gg mientras se escribe: el degradado de gg sobre un fondo tenue (SpanStyle no admite fondo en degradado).
        gg.forEach { m -> b.addStyle(ggStyle(0f, GgFaint), m.start, m.start + m.length) }
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
internal fun InlineMessageText(text: String, mentions: List<MentionDTO>, color: Color, data: BootstrapDTO, onPerson: (String) -> Unit, modifier: Modifier = Modifier,
                /** En listas (bandeja) el toque es de la fila: sin enlaces propios. */
                interactive: Boolean = true,
                /** Búsqueda en el chat (tanda 1.7): se resalta lo que coincide, sin mayúsculas ni tildes. */
                highlight: String? = null,
                /** Mensaje muy largo plegado (1.7.1, «Ver más»). */
                maxLines: Int = Int.MAX_VALUE,
                /** Con [maxLines]: avisa si el texto quedó cortado (para mostrar «Ver más»). */
                onOverflow: ((Boolean) -> Unit)? = null,
                /** Burbuja propia de color: @gg va como pastilla blanca con el texto en degradado. */
                onColored: Boolean = false) {
    // «- » al inicio de línea se ve como «• » (misma longitud: las menciones no se corren).
    @Suppress("NAME_SHADOWING") val text = remember(text) { com.tiecoms.app.core.Fmt.bullets(text) }
    val codeRanges = remember(text) { com.tiecoms.app.core.Fmt.codeRanges(text) }
    val hits = remember(text, highlight) { if (highlight.isNullOrBlank()) emptyList() else com.tiecoms.app.core.matchRanges(text, highlight) }
    // @gg (estructurada o escrita a mano como palabra) se pinta con el degradado de gg.
    val gg = remember(text, mentions) { com.tiecoms.app.core.Gg.ggMentions(text, mentions) }
    if (mentions.isEmpty() && hits.isEmpty() && gg.isEmpty()) { LinkifiedText(text, color, modifier, maxLines, onOverflow); return }
    val phase = rememberGgShimmer(gg.isNotEmpty())
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val me = data.me.id
    val accent = MaterialTheme.colorScheme.primary
    val hitBg = Color(0x66FDE047)
    val colors = mentions.associate { it.userId to (if (it.userId == Mentions.ALL || com.tiecoms.app.core.Refs.isRef(it)) color else personColor(it.userId)) }
    /** #Nombre: la abro si la tengo en mi lista; si no, «No tienes acceso a #Nombre» y no navega. */
    fun openRef(convId: String, label: String) {
        if (com.tiecoms.app.core.Refs.canOpen(container.client.value.state.value.data, convId)) container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(convId)
        else container.toast(ctx.getString(R.string.ref_no_access, label))
    }
    val annotated = remember(text, mentions, color, interactive, hits, gg, phase, onColored) {
        val marks = mutableListOf<Int>()
        buildAnnotatedString {
            val valid = (mentions.filter { it.start >= 0 && it.start + it.length <= text.length && !com.tiecoms.app.core.Gg.isGg(it.userId) && codeRanges.none { range -> it.start in range } } + gg.filter { codeRanges.none { range -> it.start in range } }).sortedBy { it.start }
            var i = 0
            fun plain(to: Int) {
                if (to <= i) return
                com.tiecoms.app.core.Fmt.linkParts(text.substring(i, to)).forEach { p ->
                    val u = p.url
                    if (u == null) appendFormatted(p.text, color, marks)
                    else if (!interactive) append(p.text)
                    else withLink(LinkAnnotation.Url(u, TextLinkStyles(SpanStyle(color = color, textDecoration = TextDecoration.Underline))) { openUrl(ctx, u) }) { append(p.text) }
                }
                i = to
            }
            valid.forEach { m ->
                if (m.start < i) return@forEach
                plain(m.start)
                val label = text.substring(m.start, m.start + m.length)
                if (com.tiecoms.app.core.Gg.isGg(m.userId)) {
                    // En la burbuja propia, pastilla blanca con el texto en degradado. Va como contenido en línea: un fondo en
                    // el mismo span que el degradado se pinta con el degradado y el texto no se ve.
                    if (onColored) appendInlineContent(GG_PILL, label)
                    else withStyle(ggStyle(phase)) { append(label) }
                } else if (com.tiecoms.app.core.Refs.isRef(m)) {
                    // #grupo: pastilla del color del acento.
                    val style = SpanStyle(fontWeight = FontWeight.SemiBold, color = accent, background = accent.copy(alpha = 0.14f))
                    val convId = m.userId.removePrefix(com.tiecoms.app.core.Refs.TOKEN)
                    if (interactive) withLink(LinkAnnotation.Clickable("ref:$convId", TextLinkStyles(style = style)) { openRef(convId, label) }) { append(label) }
                    else withStyle(style) { append(label) }
                } else {
                    val mine = m.userId == me || m.userId == Mentions.ALL
                    val style = SpanStyle(fontWeight = FontWeight.Bold, color = if (mine) Color(0xFF9A3412) else colors[m.userId] ?: color,
                        background = if (mine) Color(0x33FDBA74) else Color.Transparent)
                    if (interactive && m.userId != Mentions.ALL) withLink(LinkAnnotation.Clickable("mention:${m.userId}", TextLinkStyles(style = style)) { onPerson(m.userId) }) { append(label) }
                    else withStyle(style) { append(label) }
                }
                i = m.start + m.length
            }
            plain(text.length)
            hits.forEach { r -> addStyle(SpanStyle(background = hitBg, fontWeight = FontWeight.SemiBold), r.first, r.last + 1) }
        }.dropMarks(marks)
    }
    val pill = if (onColored && gg.isNotEmpty()) mapOf(GG_PILL to androidx.compose.foundation.text.InlineTextContent(
        androidx.compose.ui.text.Placeholder(2.3.em, 1.35.em, androidx.compose.ui.text.PlaceholderVerticalAlign.TextCenter)) { label ->
        androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().background(Color.White, RoundedCornerShape(7.dp)), contentAlignment = Alignment.Center) {
            Text(androidx.compose.ui.text.buildAnnotatedString { withStyle(ggStyle(phase)) { append(label) } }, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
        }
    }) else emptyMap()
    Text(annotated, color = color, style = MaterialTheme.typography.bodyLarge, modifier = modifier, maxLines = maxLines, inlineContent = pill,
        overflow = if (maxLines == Int.MAX_VALUE) androidx.compose.ui.text.style.TextOverflow.Clip else androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        onTextLayout = onOverflow?.let { f -> { r: androidx.compose.ui.text.TextLayoutResult -> f(r.hasVisualOverflow) } } ?: {})
}

/** Lista sobre el compositor al escribir «#»: grupos, chats y directos que puedo ver (tanda 1.7). */
@Composable
fun RefPicker(query: String, data: BootstrapDTO, currentId: String, onPick: (String, String) -> Unit) {
    val ctx = LocalContext.current
    val internal = androidx.compose.ui.res.stringResource(R.string.internal_default)
    val conv = androidx.compose.ui.res.stringResource(R.string.conversation)
    val list = remember(query, data) { com.tiecoms.app.core.Refs.candidates(data, query, { Names.conversationTitle(it, data, internal, conv) }, exclude = null) }
    if (list.isEmpty()) return
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth().heightIn(max = 150.dp).testTag("refPicker")) {
        LazyColumn {
            items(list, key = { it.first.id }) { (c, name) ->
                Row(Modifier.fillMaxWidth().clickable { onPick(c.id, name) }.heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 6.dp).testTag("refPick-${c.id}"),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("#", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, modifier = Modifier.width(22.dp))
                    Text(name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(ctx.getString(if (c.kind == "direct") R.string.calls_direct else R.string.calls_group), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
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
