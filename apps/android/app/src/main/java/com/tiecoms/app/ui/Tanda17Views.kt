package com.tiecoms.app.ui

import android.content.Context
import android.view.WindowManager
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ChatSearchNav
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.System17
import com.tiecoms.app.core.ViewOnce
import com.tiecoms.app.core.ViewOnceOpenDTO
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.random.Random

/*
 * Tanda 1.7 (docs/TANDA-1.7.md) en Android: una sola vista, confeti y carita triste, acciones de la tarea vencida,
 * comentarios de eventos y la barra de búsqueda del chat.
 */

// ---------- Animaciones: una vez por mensaje y por dispositivo, y respetando «reducir movimiento» ----------
object Fx {
    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("fx17", Context.MODE_PRIVATE)
    /** true la primera vez para este mensaje en este dispositivo (y lo marca). */
    fun firstTime(ctx: Context, messageId: String): Boolean {
        val p = prefs(ctx)
        if (p.getBoolean(messageId, false)) return false
        p.edit().putBoolean(messageId, true).apply()
        return true
    }
    fun reduceMotion(ctx: Context): Boolean =
        runCatching { android.provider.Settings.Global.getFloat(ctx.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)
}

/** Confeti de ~1,2 s sobre el chat (tarea completada, llegada en vivo). */
@Composable
fun ConfettiOverlay(key: Int, modifier: Modifier = Modifier) {
    if (key == 0) return
    val progress = remember(key) { Animatable(0f) }
    val pieces = remember(key) {
        val colors = listOf(Color(0xFFFF5A36), Color(0xFF22C55E), Color(0xFF3B82F6), Color(0xFFFACC15), Color(0xFFA855F7), Color(0xFFEC4899))
        List(90) { Triple(Random.nextFloat(), Random.nextFloat() * 0.35f, colors[it % colors.size]) to Pair(Random.nextFloat() * 360f, 0.6f + Random.nextFloat() * 0.8f) }
    }
    LaunchedEffect(key) { progress.snapTo(0f); progress.animateTo(1f, tween(1200, easing = LinearEasing)) }
    if (progress.value >= 1f) return
    Canvas(modifier.fillMaxSize().testTag("confetti")) {
        val t = progress.value
        pieces.forEach { (p, spin) ->
            val (x0, delayY, color) = p
            val (angle, speed) = spin
            val y = (-0.1f - delayY + t * 1.4f * speed) * size.height
            val x = (x0 + kotlin.math.sin((t * 6f + x0 * 10f).toDouble()).toFloat() * 0.03f) * size.width
            if (y < -20f || y > size.height) return@forEach
            rotate(angle + t * 540f, Offset(x, y)) { drawRect(color.copy(alpha = 1f - t * 0.6f), Offset(x - 6f, y - 3f), Size(12f, 6f)) }
        }
    }
}

/** Carita triste de la tarea vencida: aparece, late una vez y se queda (sin animación con «reducir movimiento»). */
@Composable
fun SadFace(animate: Boolean) {
    val s = remember { Animatable(if (animate) 0.2f else 1f) }
    LaunchedEffect(animate) { if (animate) { s.animateTo(1.35f, tween(380)); s.animateTo(1f, tween(320)) } }
    Text("😢", fontSize = 22.sp, modifier = Modifier.scale(s.value).testTag("sadFace"))
}

// ---------- Una sola vista ----------
/** ① del compositor: prende o apaga «una vista» para el próximo mensaje. */
@Composable
fun ViewOnceToggle(on: Boolean, onToggle: () -> Unit) {
    val cd = stringResource(if (on) R.string.vo_toggle_off else R.string.vo_toggle_on)
    val cs = MaterialTheme.colorScheme
    Box(Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onToggle).semantics { contentDescription = cd }.testTag("viewOnce"), contentAlignment = Alignment.Center) {
        Box(Modifier.size(24.dp).clip(CircleShape).background(if (on) cs.primary else Color.Transparent)
            .border(1.6.dp, if (on) cs.primary else cs.onSurfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
            Text("1", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = if (on) cs.onPrimary else cs.onSurfaceVariant)
        }
    }
}

/** Burbuja cerrada: «① Foto · Toca para ver», «① Mensaje · Abierto» o, para el autor, «① Foto · una vista · Visto por Ana». */
@Composable
fun ViewOnceBubble(m: MessageDTO, data: BootstrapDTO, fg: Color, mine: Boolean) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val state = ViewOnce.state(m, data.me.id)
    val what = when (ViewOnce.kind(m)) {
        ViewOnce.Kind.PHOTO -> stringResource(R.string.vo_photo); ViewOnce.Kind.VOICE -> stringResource(R.string.vo_voice); ViewOnce.Kind.TEXT -> stringResource(R.string.vo_message)
    }
    var opened by remember(m.id) { mutableStateOf<ViewOnceOpenDTO?>(null) }
    var busy by remember { mutableStateOf(false) }
    val sub = when (state) {
        "sent" -> {
            val names = ViewOnce.openedNames(m) { id -> Names.person(data, id)?.name?.substringBefore(' ') }
            stringResource(R.string.vo_once) + if (names.isNotEmpty()) " · " + stringResource(R.string.vo_seen_by, names.joinToString(", ")) else ""
        }
        "opened" -> stringResource(R.string.vo_opened)
        else -> stringResource(R.string.vo_tap)
    }
    val canOpen = state == "unopened"
    Row(Modifier.clip(RoundedCornerShape(10.dp)).then(if (canOpen) Modifier.clickable(enabled = !busy) {
        busy = true
        container.scope.launch {
            try { opened = client.openViewOnce(m) }
            catch (e: Exception) {
                val gone = (e as? com.tiecoms.app.core.ApiException)?.status == 410
                container.toast(if (gone) ctx.getString(R.string.vo_already) else errorText(ctx, e))
            } finally { busy = false }
        }
    } else Modifier).padding(vertical = 4.dp).testTag("viewOnceBubble-${m.seq}"), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(28.dp).clip(CircleShape).border(1.6.dp, fg.copy(alpha = if (canOpen) 1f else 0.5f), CircleShape), contentAlignment = Alignment.Center) {
            Text("1", color = fg, fontWeight = FontWeight.Bold, fontSize = 13.sp)
        }
        Spacer(Modifier.width(10.dp))
        Column {
            Text(what, color = fg, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyLarge)
            Text(sub, color = fg.copy(alpha = 0.75f), style = MaterialTheme.typography.labelMedium, modifier = Modifier.testTag("viewOnceState-${m.seq}"))
        }
        if (busy) { Spacer(Modifier.width(8.dp)); CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = fg) }
    }
    opened?.let { o -> ViewOnceViewer(o, ViewOnce.kind(m)) { opened = null } }
}

/** Visor de pantalla completa con FLAG_SECURE: no se puede capturar ni grabar; al cerrarlo queda «Abierto». */
@Composable
fun ViewOnceViewer(content: ViewOnceOpenDTO, kind: ViewOnce.Kind, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        DisposableEffect(window) {
            window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
            onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
        }
        val container = LocalContainer.current
        Surface(color = Color.Black, contentColor = Color.White, modifier = Modifier.fillMaxSize().testTag("viewOnceViewer")) {
            Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                when (kind) {
                    ViewOnce.Kind.PHOTO -> {
                        val a = content.attachments.firstOrNull { it.isImage }
                        val px = with(LocalDensity.current) { 1600.dp.roundToPx() }.coerceAtMost(2048)
                        val url = a?.url?.let { container.client.value.mediaUrl(it) }
                        val bmp by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, url) {
                            value = url?.let { runCatching { container.images.load(it, px, container.client.value.bearer()) }.getOrNull() }
                        }
                        bmp?.let { Image(it, null, Modifier.fillMaxSize().align(Alignment.Center), contentScale = ContentScale.Fit) }
                            ?: CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
                    }
                    ViewOnce.Kind.VOICE -> OnceVoice(content, Modifier.align(Alignment.Center))
                    ViewOnce.Kind.TEXT -> Text(content.body, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(28.dp).verticalScroll(rememberScrollState()).testTag("viewOnceText"))
                }
                IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(8.dp).testTag("viewOnceClose")) {
                    Icon(Icons.Filled.Close, stringResource(R.string.close), tint = Color.White)
                }
                Text("① " + stringResource(R.string.vo_once), style = MaterialTheme.typography.labelLarge, color = Color.White.copy(alpha = 0.7f),
                    modifier = Modifier.align(Alignment.TopStart).padding(16.dp))
            }
        }
    }
}

/** Nota de voz de una sola vista: se reproduce desde la URL firmada (60 s); no queda guardada. */
@Composable
private fun OnceVoice(content: ViewOnceOpenDTO, modifier: Modifier) {
    val container = LocalContainer.current
    val a = content.attachments.firstOrNull { it.isVoice }
    val url = a?.url?.let { container.client.value.mediaUrl(it) }
    var playing by remember { mutableStateOf(false) }
    val player = remember { android.media.MediaPlayer() }
    DisposableEffect(Unit) { onDispose { runCatching { player.stop() }; player.release() } }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("🎙", fontSize = 48.sp)
        Button(onClick = {
            if (url == null) return@Button
            if (playing) { runCatching { player.pause() }; playing = false; return@Button }
            runCatching {
                player.reset(); player.setDataSource(url); player.setOnCompletionListener { playing = false }; player.prepare(); player.start(); playing = true
            }
        }, modifier = Modifier.testTag("viewOnceVoicePlay")) { Text(if (playing) "⏸" else "▶") }
        a?.durationMs?.let { Text(com.tiecoms.app.core.Calls.clock(it / 1000), color = Color.White.copy(alpha = 0.8f)) }
    }
}

// ---------- Tarea vencida: Nueva fecha, Marcar hecha, Reasignar ----------
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun OverdueActions(issue: com.tiecoms.app.core.IssueDTO, data: BootstrapDTO) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    var dates by remember { mutableStateOf(false) }
    var pickDate by remember { mutableStateOf(false) }
    var reassign by remember { mutableStateOf(false) }
    fun act(block: suspend () -> Unit) = container.scope.launch { runCatching { block() }.onFailure { container.toast(errorText(ctx, it)) } }
    fun setDue(d: LocalDate) = act { client.updateIssue(issue.id, kotlinx.serialization.json.buildJsonObject { put("dueDate", kotlinx.serialization.json.JsonPrimitive(d.toString())) }) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("overdueActions")) {
        OutlinedButton(onClick = { dates = true }, modifier = Modifier.heightIn(min = 40.dp).testTag("overdueNewDate")) { Text("📅 " + stringResource(R.string.od_new_date)) }
        Button(onClick = { act { client.setIssueStatus(issue.id, "done") } }, modifier = Modifier.heightIn(min = 40.dp).testTag("overdueDone")) { Text("✓ " + stringResource(R.string.od_mark_done)) }
        OutlinedButton(onClick = { reassign = true }, modifier = Modifier.heightIn(min = 40.dp).testTag("overdueReassign")) { Text("👤 " + stringResource(R.string.od_reassign)) }
    }
    if (dates) {
        val today = LocalDate.now()
        val (t, tm, mon) = System17.quickDates(today)
        ActionSheet(stringResource(R.string.od_new_date), listOf(
            SheetItem(ctx.getString(R.string.od_today), tag = "odToday") { setDue(t) },
            SheetItem(ctx.getString(R.string.od_tomorrow), tag = "odTomorrow") { setDue(tm) },
            SheetItem(ctx.getString(R.string.od_next_monday), subtitle = mon.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)), tag = "odMonday") { setDue(mon) },
            SheetItem(ctx.getString(R.string.od_pick), "📅", tag = "odPick") { pickDate = true },
        )) { dates = false }
    }
    if (pickDate) IssueDatePicker(null, onPick = { d -> pickDate = false; d?.let { setDue(it) } }, onDismiss = { pickDate = false })
    if (reassign) {
        val conv = data.conversations.firstOrNull { it.id == issue.conversationId }
        val people = (conv?.memberIds ?: emptyList()).mapNotNull { Names.person(data, it) }.filter { it.kind == "human" }
        ActionSheet(stringResource(R.string.od_reassign), people.map { p ->
            SheetItem((if (p.id == issue.ownerId) "● " else "") + p.name, tag = "odOwner-${p.id}") {
                act { client.updateIssue(issue.id, kotlinx.serialization.json.buildJsonObject { put("ownerId", kotlinx.serialization.json.JsonPrimitive(p.id)) }) }
            }
        }) { reassign = false }
    }
}

// ---------- Comentarios agrupados ----------
/** Franja «💬 Comentario añadido» o «💬 N comentarios nuevos» con el último extracto. */
@Composable
fun CommentsStrip(body: System17.Body, data: BootstrapDTO) {
    val who = if (body.lastById == data.me.id) stringResource(R.string.common_you_short) else body.lastByName?.substringBefore(' ') ?: ""
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).padding(8.dp).testTag("commentsStrip")) {
        Text(if (body.count <= 1) stringResource(R.string.cm_added) else stringResource(R.string.cm_new_n, body.count),
            style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        body.lastExcerpt?.takeIf { it.isNotBlank() }?.let {
            Text(androidx.compose.ui.text.buildAnnotatedString {
                pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)); append(who); pop(); append(" "); append(it)
            }, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Comentarios de un evento en su tarjeta: los 2 últimos, «Responder» y el campo para comentar. */
@Composable
fun EventCommentsBlock(ev: com.tiecoms.app.core.CalendarEventDTO, data: BootstrapDTO, canPost: Boolean, startOpen: Boolean = false) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    var open by remember(ev.id) { mutableStateOf(startOpen) }
    var text by remember(ev.id) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    if (ev.lastComments.isNotEmpty()) Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        ev.lastComments.forEach { c ->
            val who = if (c.authorId == data.me.id) stringResource(R.string.common_you_short) else Names.person(data, c.authorId)?.name?.substringBefore(' ') ?: ""
            Text(androidx.compose.ui.text.buildAnnotatedString {
                pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)); append(who); pop(); append(" "); append(c.body)
            }, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("eventCardComment"))
        }
    }
    if (!canPost || ev.cancelledAt != null) return
    fun send() {
        val b = text.trim(); if (b.isEmpty() || busy) return
        busy = true
        container.scope.launch {
            try { client.commentEvent(ev.id, b); text = "" } catch (e: Exception) { container.toast(errorText(ctx, e)) } finally { busy = false }
        }
    }
    if (!open) TextButton(onClick = { open = true }, modifier = Modifier.heightIn(min = 36.dp).testTag("eventCardReply")) {
        Text("💬 " + (if (ev.commentCount > 0) stringResource(R.string.cm_reply) + " · ${ev.commentCount}" else stringResource(R.string.cm_comment)), style = MaterialTheme.typography.labelLarge)
    } else Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(text, { text = it.take(4000) }, singleLine = true, placeholder = { Text(stringResource(R.string.cm_event_ph), style = MaterialTheme.typography.bodySmall) },
            textStyle = MaterialTheme.typography.bodySmall, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }),
            shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("eventCardInput"))
        TextButton(onClick = { send() }, enabled = text.isNotBlank() && !busy, modifier = Modifier.testTag("eventCardSend")) { Text(stringResource(R.string.send)) }
    }
}

// ---------- Buscar dentro del chat ----------
/** Barra arriba del chat: campo, «3 de 17», ↑ ↓ y cerrar. La búsqueda espera 250 ms mientras se escribe. */
@Composable
fun ChatSearchBar(query: String, onQuery: (String) -> Unit, nav: ChatSearchNav, loading: Boolean, onOlder: () -> Unit, onNewer: () -> Unit, onClose: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(100); runCatching { focus.requestFocus() } }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().testTag("chatSearchBar")) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(query, onQuery, singleLine = true, placeholder = { Text(stringResource(R.string.cs_placeholder)) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { onOlder() }),
                shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f).heightIn(min = 48.dp).focusRequester(focus).testTag("chatSearchField"))
            Spacer(Modifier.width(6.dp))
            val label = when {
                loading -> "…"
                !ChatSearchNav.ready(query) -> ""
                nav.total == 0 -> stringResource(R.string.cs_none)
                else -> stringResource(R.string.cs_of, nav.index + 1, nav.total) + if (nav.hasMore) "+" else ""
            }
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.widthIn(min = 48.dp).testTag("chatSearchCount"))
            IconButton(onClick = onOlder, enabled = nav.total > 0 && (nav.index < nav.total - 1 || nav.hasMore), modifier = Modifier.testTag("chatSearchUp")) {
                Icon(Icons.Filled.KeyboardArrowUp, stringResource(R.string.cs_older))
            }
            IconButton(onClick = onNewer, enabled = nav.index > 0, modifier = Modifier.testTag("chatSearchDown")) { Icon(Icons.Filled.KeyboardArrowDown, stringResource(R.string.cs_newer)) }
            IconButton(onClick = onClose, modifier = Modifier.testTag("chatSearchClose")) { Icon(Icons.Filled.Close, stringResource(R.string.close)) }
        }
    }
}
