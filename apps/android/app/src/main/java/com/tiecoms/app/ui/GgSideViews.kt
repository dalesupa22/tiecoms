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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.GgDraft
import com.tiecoms.app.core.GgQuotedDTO
import com.tiecoms.app.core.GgSide
import com.tiecoms.app.core.GgSideMessageDTO
import com.tiecoms.app.core.GgSuggestion
import com.tiecoms.app.core.TieComsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/*
 * gg dentro del chat (docs/CONTRATO-GG-CHAT-WA-INBOX.md, parte B). Botón gg en el encabezado, hoja «gg de este chat»,
 * «Responder por mí» (3 borradores + tonos), citar, «Seguir con gg» y sugerencias de varios mensajes.
 * Nada se envía ni se ejecuta solo: los borradores caen al compositor y las acciones abren los diálogos de siempre.
 */

private val GgInk = Color(0xFF17161F)
private val GgSpark = Color(0xFFFF5A36)

/** «Abrir en gg»: el asistente general (lo pone AppRoot). */
val LocalOpenGeneralGg = staticCompositionLocalOf<() -> Unit> { {} }

/** Borradores de gg que esperan a su compositor (por conversación). El compositor los toma al verlos; nunca se envían solos. */
object GgDrafts {
    val pending = MutableStateFlow<Map<String, String>>(emptyMap())
    fun put(conversationId: String, text: String) { if (text.isNotBlank()) pending.value = pending.value + (conversationId to text) }
    fun take(conversationId: String): String? = pending.value[conversationId]?.also { pending.value = pending.value - conversationId }
}

/** Ícono gg del encabezado: las letras «gg» en un círculo oscuro con una chispa; con número si hay pendientes. */
@Composable
fun GgButton(count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val cd = if (count > 0) stringResource(R.string.ggs_button_pending_cd, count) else stringResource(R.string.ggs_button_cd)
    IconButton(onClick = onClick, modifier = modifier.semantics { contentDescription = cd }.testTag("ggSideButton")) {
        Box(Modifier.size(34.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
            Box(Modifier.size(28.dp).background(GgInk, CircleShape), contentAlignment = Alignment.Center) {
                Text("gg", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.offset(y = (-1).dp))
            }
            Text("✦", color = GgSpark, fontSize = 10.sp, modifier = Modifier.align(Alignment.TopEnd).offset(x = 1.dp, y = (-1).dp))
            if (count > 0) Box(
                Modifier.align(Alignment.BottomEnd).offset(x = 3.dp, y = 2.dp).widthIn(min = 16.dp).background(GgSpark, CircleShape).padding(horizontal = 4.dp),
                contentAlignment = Alignment.Center,
            ) { Text(if (count > 9) "9+" else count.toString(), color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.testTag("ggSideCount")) }
        }
    }
}

/** Estado de «gg de este chat» para una fuente (`c:<id>` o `wa:<cuenta>:<jid>`). */
@Stable
class GgSideModel(private val client: TieComsClient, val source: String, private val scope: CoroutineScope) {
    val messages = mutableStateListOf<GgSideMessageDTO>()
    var pending by mutableStateOf(0)
    /** null = no se sabe; false = el servidor no lo tiene (404) o no hay acceso: se oculta el botón. */
    var available by mutableStateOf<Boolean?>(null)
    var open by mutableStateOf(false)
    /** Se cerró la hoja con historial: «Seguir con gg» sobre el compositor. */
    var closedWithHistory by mutableStateOf(false)
    var busy by mutableStateOf(false)
    var error by mutableStateOf(false)
    val quoted = mutableStateListOf<GgQuotedDTO>()
    /** Las 3 burbujitas sobre la caja (se piden al tocar ✨, nunca solas). */
    var quick by mutableStateOf<List<GgDraft>?>(null)
    var quickBusy by mutableStateOf(false)
    /** Pedido que espera el permiso de IA (403 ai_consent_required). */
    var consentFor by mutableStateOf<(suspend () -> Unit)?>(null)
    private var opened = false

    suspend fun load() {
        if (client.ggSideMissing) { available = false; return }
        try {
            val t = client.ggSide(source)
            messages.clear(); messages.addAll(t.messages); pending = t.pending; available = true
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            // 404/403 de acceso: sin botón para esta fuente. Red caída: se deja visible (null) y se reintenta al abrir.
            if (e is ApiException && (e.status == 404 || (e.status == 403 && e.code != "ai_consent_required"))) available = false
        }
    }

    private fun run(block: suspend () -> Unit) {
        scope.launch {
            busy = true; error = false
            try { block() } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                if (e is ApiException && e.status == 403 && e.code == "ai_consent_required") consentFor = block else error = true
            } finally { busy = false }
        }
    }

    fun allowConsent() {
        val again = consentFor ?: return
        consentFor = null
        scope.launch {
            busy = true
            try { client.setAiConsent(true); again() } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = true
            } finally { busy = false }
        }
    }

    /** Abre la hoja; sin mensajes, gg saluda con lo que vio (POST /open). */
    fun show() {
        open = true; closedWithHistory = false
        if (opened) return
        opened = true
        if (messages.isNotEmpty() && available == true) return
        run {
            if (messages.isEmpty() && available != true) load()
            if (messages.isEmpty()) { val m = client.ggSideOpen(source); messages.add(m); pending = m.extra?.pending?.size ?: pending }
        }
    }

    fun hide() { open = false; closedWithHistory = messages.isNotEmpty() }

    fun quote(q: GgQuotedDTO) { if (quoted.none { it.id == q.id }) quoted.add(q) }

    fun ask(text: String, quotedIds: List<String> = quoted.map { it.id }) {
        val t = text.trim()
        if (t.isEmpty()) return
        val q = quoted.toList().filter { it.id in quotedIds }
        messages.add(GgSideMessageDTO(id = "local-" + System.nanoTime(), role = "user", body = t, quoted = q.ifEmpty { null }))
        quoted.clear()
        run { messages.add(client.ggSideAsk(source, t, quotedIds)) }
    }

    /** «Responder por mí»: 3 borradores; quedan guardados también en el hilo de gg. */
    fun replyForMe(tone: String? = null, quotedIds: List<String> = quoted.map { it.id }) {
        run {
            val drafts = client.ggReplyForMe(source, tone, quotedIds)
            // El servidor lo guarda como mensaje de gg: se vuelve a pedir el hilo; si falla, se muestra igual.
            val t = runCatching { client.ggSide(source) }.getOrNull()
            if (t != null && t.messages.lastOrNull()?.extra?.drafts?.isNotEmpty() == true) { messages.clear(); messages.addAll(t.messages) }
            else messages.add(GgSideMessageDTO(id = "local-" + System.nanoTime(), role = "gg", body = "", extra = com.tiecoms.app.core.GgExtraDTO(drafts = drafts)))
        }
    }

    /** Las burbujitas sobre la caja (atajo de «Responder por mí»). */
    fun loadQuick() {
        if (quickBusy) return
        scope.launch {
            quickBusy = true
            try { quick = client.ggReplyForMe(source, null, emptyList()).take(3) } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                if (e is ApiException && e.status == 403 && e.code == "ai_consent_required") consentFor = { quick = client.ggReplyForMe(source, null, emptyList()).take(3) }
                else error = true
            } finally { quickBusy = false }
        }
    }

    fun newSession() { run { client.ggSideNew(source); messages.clear(); quoted.clear(); messages.add(client.ggSideOpen(source)) } }

    suspend fun suggest(ids: List<String>): List<GgSuggestion> = GgSide.dedupe(client.ggSuggest(source, ids))
}

@Composable
fun rememberGgSide(source: String, enabled: Boolean): GgSideModel? {
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    if (!enabled) return null
    val model = remember(source, client) { GgSideModel(client, source, scope) }
    LaunchedEffect(model) { model.load() }
    return model
}

/** Diálogo de permiso de IA (el mismo banner de siempre, con el alcance de esta hoja). */
@Composable
fun GgConsentDialog(model: GgSideModel) {
    if (model.consentFor == null) return
    AlertDialog(
        onDismissRequest = { model.consentFor = null },
        title = { Text(stringResource(R.string.ggs_consent_title)) },
        text = { Text(stringResource(R.string.ggs_consent_body)) },
        confirmButton = { TextButton(onClick = { model.allowConsent() }, modifier = Modifier.testTag("ggsConsentAllow")) { Text(stringResource(R.string.ggs_consent_allow)) } },
        dismissButton = { TextButton(onClick = { model.consentFor = null }) { Text(stringResource(R.string.cancel)) } },
        modifier = Modifier.testTag("ggsConsentDialog"),
    )
}

@Composable
private fun styleName(s: String) = stringResource(when (s) { "warm" -> R.string.ggs_style_warm; "action" -> R.string.ggs_style_action; else -> R.string.ggs_style_short })

@Composable
private fun toneName(t: String) = stringResource(when (t) { "me" -> R.string.ggs_tone_me; "shorter" -> R.string.ggs_tone_shorter; "formal" -> R.string.ggs_tone_formal; else -> R.string.ggs_tone_more })

@Composable
private fun Chip(text: String, tag: String? = null, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.heightIn(min = 36.dp).then(if (tag != null) Modifier.testTag(tag) else Modifier)) {
        Text(text, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
    }
}

/**
 * Hoja «gg de este chat». [onUseDraft]: el texto va al compositor como «Borrador de gg» (o al portapapeles en
 * WhatsApp sin envío). [onAction]: «Crear tarea» / «Recordatorio» de un borrador «Con acción», con su diálogo prellenado.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun GgSideSheet(
    model: GgSideModel, onUseDraft: (String) -> Unit, onAction: (com.tiecoms.app.core.GgActionDTO) -> Unit, onJump: (String) -> Unit,
) {
    if (!model.open) return
    val openGeneral = LocalOpenGeneralGg.current
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var input by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    LaunchedEffect(model.messages.size, model.busy) { if (model.messages.isNotEmpty()) list.animateScrollToItem(model.messages.size) }
    val summarize = stringResource(R.string.ggs_summarize)
    val missing = stringResource(R.string.ggs_what_missing)
    val agreed = stringResource(R.string.ggs_what_agreed)
    ModalBottomSheet(onDismissRequest = { model.hide() }, sheetState = sheet, modifier = Modifier.testTag("ggSideSheet")) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.88f).navigationBarsPadding().imePadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(30.dp).background(GgInk, CircleShape), contentAlignment = Alignment.Center) { Text("gg", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp) }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f).semantics(mergeDescendants = true) { heading() }) {
                    Text(stringResource(R.string.ggs_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(stringResource(R.string.ggs_privacy), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("ggSidePrivacy"))
                }
                Box {
                    IconButton(onClick = { menu = true }, modifier = Modifier.testTag("ggSideMenu")) { Icon(Icons.Filled.MoreVert, stringResource(R.string.menu_more)) }
                    AnchoredMenu(menu, listOf(
                        SheetItem(stringResource(R.string.ggs_new), "↺", tag = "ggSideNew") { model.newSession() },
                        SheetItem(stringResource(R.string.ggs_open_general), "↗", tag = "ggSideGeneral") { model.hide(); openGeneral() },
                    ), { menu = false })
                }
                IconButton(onClick = { model.hide() }) { Icon(Icons.Filled.Close, stringResource(R.string.close)) }
            }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(model.messages, key = { it.id.ifEmpty { it.createdAt + it.body.hashCode() } }) { m ->
                    GgSideBubble(m, last = m === model.messages.lastOrNull(), onUseDraft = { t -> model.hide(); onUseDraft(t) }, onAction = { a -> model.hide(); onAction(a) },
                        onTone = { tone -> model.replyForMe(tone) }, onJump = { mid -> model.hide(); onJump(mid) })
                }
                if (model.busy) item(key = "busy") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.ggs_thinking), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (model.error && !model.busy) item(key = "error") { Text(stringResource(R.string.ggs_error), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            // Chips de arranque y «siguientes preguntas» (2 a 4) del último mensaje de gg.
            val follow = GgSide.followUps(model.messages)
            LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(vertical = 4.dp).testTag("ggSideChips")) {
                item { Chip("✨ " + stringResource(R.string.ggs_reply_for_me), "ggChipReply") { model.replyForMe() } }
                items(follow) { f -> Chip(f) { model.ask(f) } }
                if (follow.isEmpty()) {
                    item { Chip(summarize) { model.ask(summarize) } }
                    item { Chip(missing) { model.ask(missing) } }
                    item { Chip(agreed) { model.ask(agreed) } }
                }
            }
            if (model.quoted.isNotEmpty()) Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).testTag("ggSideQuoted")) {
                model.quoted.toList().forEach { q ->
                    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("❝ " + (if (q.author.isNotBlank()) q.author + ": " else "") + q.text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        IconButton(onClick = { model.quoted.remove(q) }) { Icon(Icons.Filled.Close, stringResource(R.string.cancel), Modifier.size(16.dp)) }
                    }
                    Spacer(Modifier.size(4.dp))
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(input, { input = it.take(2000) }, placeholder = { Text(stringResource(R.string.ggs_ask_placeholder), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    maxLines = 4, shape = RoundedCornerShape(24.dp), modifier = Modifier.weight(1f).testTag("ggSideInput"))
                IconButton(onClick = { model.ask(input); input = "" }, enabled = input.isNotBlank() && !model.busy, modifier = Modifier.testTag("ggSideSend")) {
                    Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.send))
                }
            }
        }
    }
    GgConsentDialog(model)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GgSideBubble(m: GgSideMessageDTO, last: Boolean, onUseDraft: (String) -> Unit, onAction: (com.tiecoms.app.core.GgActionDTO) -> Unit, onTone: (String) -> Unit, onJump: (String) -> Unit) {
    val mine = m.role == "user"
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        m.quoted.orEmpty().forEach { q ->
            Text("❝ " + (if (q.author.isNotBlank()) q.author + ": " else "") + q.text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 300.dp))
        }
        if (m.body.isNotBlank()) Surface(
            shape = RoundedCornerShape(14.dp),
            color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier.widthIn(max = 320.dp),
        ) { Text(m.body, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) }
        val ex = m.extra
        if (!mine && ex != null) {
            if (ex.pending.isNotEmpty()) Column(Modifier.padding(top = 6.dp).fillMaxWidth().testTag("ggSidePending")) {
                Text(stringResource(R.string.ggs_pending_title).uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                ex.pending.forEach { p ->
                    Text("• " + p.text, style = MaterialTheme.typography.bodySmall, color = if (p.messageId != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.fillMaxWidth().then(if (p.messageId != null) Modifier.clickable { onJump(p.messageId) } else Modifier).padding(vertical = 4.dp))
                }
            }
            if (ex.drafts.isNotEmpty()) {
                Column(Modifier.padding(top = 6.dp).fillMaxWidth().testTag("ggSideDrafts"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ex.drafts.forEach { d -> DraftCard(d, onUseDraft, onAction) }
                }
                if (last) FlowRow(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    GgSide.TONES.forEach { t -> Chip(toneName(t), "ggTone-$t") { onTone(t) } }
                }
            }
        }
    }
}

@Composable
private fun DraftCard(d: GgDraft, onUseDraft: (String) -> Unit, onAction: (com.tiecoms.app.core.GgActionDTO) -> Unit) {
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp)).testTag("ggDraft-${d.style}")) {
        Column(Modifier.padding(10.dp)) {
            Text(styleName(d.style).uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = GgSpark)
            Text(d.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { onUseDraft(d.text) }, modifier = Modifier.testTag("ggUseDraft-${d.style}")) { Text(stringResource(R.string.ggs_use_draft)) }
                d.action?.let { a ->
                    TextButton(onClick = { onAction(a) }) {
                        Text((if (a.kind == "reminder") "⏰ " + stringResource(R.string.ggs_create_reminder) else "◆ " + stringResource(R.string.ggs_create_task)) + " · " + a.title,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/** «Seguir con gg» sobre el compositor, tras cerrar la hoja con historial. */
@Composable
fun GgContinueStrip(model: GgSideModel?) {
    if (model == null || !model.closedWithHistory || model.open) return
    Row(Modifier.fillMaxWidth().clickable { model.show() }.padding(horizontal = 16.dp, vertical = 6.dp).testTag("ggContinue"), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(20.dp).background(GgInk, CircleShape), contentAlignment = Alignment.Center) { Text("gg", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
        Spacer(Modifier.width(8.dp))
        Text(stringResource(R.string.ggs_continue), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        IconButton(onClick = { model.closedWithHistory = false }, modifier = Modifier.size(32.dp)) { Icon(Icons.Filled.Close, stringResource(R.string.close), Modifier.size(16.dp)) }
    }
}

/** Las 3 burbujitas de respuesta sobre la caja (cargadas al tocar ✨). Tocar una = borrador en la caja. */
@Composable
fun GgQuickReplies(model: GgSideModel?, onUse: (String) -> Unit) {
    if (model == null) return
    val q = model.quick
    if (q == null && !model.quickBusy) return
    val cd = stringResource(R.string.ggs_quick_cd)
    LazyRow(Modifier.fillMaxWidth().semantics { contentDescription = cd }.testTag("ggQuick"), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (model.quickBusy) item { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }
        items(q.orEmpty()) { d ->
            Surface(onClick = { model.quick = null; onUse(d.text) }, shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.secondaryContainer,
                modifier = Modifier.widthIn(max = 240.dp).testTag("ggQuick-${d.style}")) {
                Text(d.text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }
        if (q != null) item { IconButton(onClick = { model.quick = null }, modifier = Modifier.size(32.dp)) { Icon(Icons.Filled.Close, stringResource(R.string.close), Modifier.size(16.dp)) } }
    }
}

/** Flotante «✨ Pedir a gg (N)» con la selección, y «Cancelar selección». */
@Composable
fun GgSelectionBar(count: Int, onAsk: () -> Unit, onCancel: () -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.testTag("ggSelectionBar"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Surface(onClick = onCancel, shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceContainerHighest, shadowElevation = 3.dp) {
            Text(stringResource(R.string.ggs_cancel_select), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
        }
        Surface(onClick = onAsk, enabled = count > 0, shape = RoundedCornerShape(50), color = GgInk, contentColor = Color.White, shadowElevation = 4.dp, modifier = Modifier.testTag("ggAskSelected")) {
            Text(stringResource(R.string.ggs_ask_n, count), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
        }
    }
}

/** Marca de selección sobre un mensaje: en modo «Seleccionar», tocar alterna (no abre nada). */
@Composable
fun GgSelectable(selecting: Boolean, selected: Boolean, onToggle: () -> Unit, content: @Composable () -> Unit) {
    if (!selecting) { content(); return }
    Box(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.padding(end = 6.dp).size(22.dp).border(2.dp, if (selected) GgSpark else MaterialTheme.colorScheme.outline, CircleShape)
                .background(if (selected) GgSpark else Color.Transparent, CircleShape), contentAlignment = Alignment.Center) {
                if (selected) Text("✓", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Box(Modifier.weight(1f)) { content() }
        }
        Box(Modifier.matchParentSize().background(if (selected) GgSpark.copy(alpha = 0.08f) else Color.Transparent).clickable(onClick = onToggle))
    }
}

/**
 * Sugerencias de gg para los mensajes elegidos: cada una con casilla y «Hacer estas N».
 * Nada se ejecuta aquí: [onRun] abre los diálogos de siempre ya llenos. «O pide lo que quieras…» va a la hoja.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GgSuggestSheet(model: GgSideModel, messageIds: List<String>, onRun: (List<GgSuggestion>) -> Unit, onFreeAsk: (String) -> Unit, onClose: () -> Unit) {
    var list by remember(messageIds) { mutableStateOf<List<GgSuggestion>?>(null) }
    var failed by remember(messageIds) { mutableStateOf(false) }
    val picked = remember(messageIds) { mutableStateListOf<String>() }
    var free by remember { mutableStateOf("") }
    LaunchedEffect(messageIds) {
        try { list = model.suggest(messageIds).also { l -> picked.clear(); l.firstOrNull()?.let { picked.add(it.id) } } }
        catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (e is ApiException && e.status == 403 && e.code == "ai_consent_required") model.consentFor = { list = model.suggest(messageIds) } else failed = true
            if (list == null) list = emptyList()
        }
    }
    FormSheet(stringResource(R.string.ggs_suggest_title), onClose, tag = "ggSuggestSheet") {
        when {
            list == null -> CircularProgressIndicator()
            failed -> Text(stringResource(R.string.ggs_error), color = MaterialTheme.colorScheme.error)
            list!!.isEmpty() -> Text(stringResource(R.string.ggs_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> list!!.forEach { s ->
                val on = s.id in picked
                Row(Modifier.fillMaxWidth().clickable { if (on) picked.remove(s.id) else picked.add(s.id) }.padding(vertical = 4.dp).testTag("ggSuggest-${s.id}"), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(on, null)
                    Spacer(Modifier.width(6.dp))
                    Column(Modifier.weight(1f)) {
                        Text(glyphOf(s.kind) + " " + s.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        (s.detail ?: s.draft)?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }
        }
        val chosen = list.orEmpty().filter { it.id in picked }
        if (chosen.isNotEmpty()) androidx.compose.material3.Button(onClick = { onClose(); onRun(chosen) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("ggDoSelected")) {
            Text(if (chosen.size == 1) stringResource(R.string.ggs_do_one) else stringResource(R.string.ggs_do_n, chosen.size))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(free, { free = it.take(2000) }, placeholder = { Text(stringResource(R.string.ggs_free_ask)) }, maxLines = 3, modifier = Modifier.weight(1f).testTag("ggFreeAsk"))
            IconButton(onClick = { val t = free; free = ""; onClose(); onFreeAsk(t) }, enabled = free.isNotBlank()) { Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.send)) }
        }
    }
    GgConsentDialog(model)
}

private fun glyphOf(kind: String) = when (kind) { "task" -> "◆"; "reminder" -> "⏰"; "message_person" -> "✉"; "summary" -> "≡"; else -> "↩" }

/** Orden de ejecución: lo que abre otra pantalla (escribirle a alguien) va al final para no cortar los diálogos. */
fun ggRunOrder(list: List<GgSuggestion>): List<GgSuggestion> = list.sortedBy { if (it.kind == "message_person") 1 else 0 }
