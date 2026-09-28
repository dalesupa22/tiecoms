package com.tiecoms.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Animatable
import androidx.compose.ui.graphics.graphicsLayer
import kotlinx.coroutines.delay
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.res.painterResource
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.Assistant
import com.tiecoms.app.core.AssistantActionDTO
import com.tiecoms.app.core.AssistantTurn
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.platform.AppLocale
import com.tiecoms.app.platform.AssistantListener
import com.tiecoms.app.platform.AssistantSpeaker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch

/**
 * gg, el asistente (docs/ASISTENTE.md): burbuja ✦ abajo a la derecha en las listas (nunca dentro de un chat),
 * hoja inferior al 86 %, tarjetas de acción y voz. Mismo comportamiento y textos que la web (Assistant.tsx).
 */

/** Margen al final de las listas de las pestañas para que la burbuja no tape la última fila. */
val AssistantListInset = 84.dp

/** Estado y lógica de gg; vive mientras hay sesión (MainNav), así lo que está en curso termina aunque se cierre el panel. */
@Stable
class AssistantModel(private val client: TieComsClient, private val ctx: Context, private val scope: CoroutineScope) {
    var open by mutableStateOf(false); private set
    /** Se mantiene presionada la burbuja: la burbuja sigue compuesta (invisible) hasta soltar. */
    var holding by mutableStateOf(false)
    var turns by mutableStateOf<List<AssistantTurn>>(emptyList()); private set
    var text by mutableStateOf("")
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var listening by mutableStateOf(false); private set
    var interim by mutableStateOf(""); private set
    var speakOn by mutableStateOf(client.assistantSpeak()); private set
    /** Falta el permiso del micrófono: se explica antes de pedirlo. */
    var micWhy by mutableStateOf(false)
    private data class ConsentRequest(val content: String, val voice: Boolean, val retry: Boolean, val redoId: String?)
    private var consentGranted = false
    private var consentSession = 0L
    private var consentRequest: ConsentRequest? = null
    var asksConsent by mutableStateOf(false); private set
    private var loaded = false
    private val listener = AssistantListener(ctx)
    private var speaker: AssistantSpeaker? = null
    val canListen: Boolean = AssistantListener.available(ctx)

    private fun lang() = AppLocale.effective(ctx)
    private fun tz() = runCatching { java.time.ZoneId.systemDefault().id }.getOrDefault("America/Bogota")
    private fun commit(v: List<AssistantTurn>) { turns = v.takeLast(Assistant.MAX_KEEP); client.saveAssistantHistory(turns) }
    val pendingAll: List<AssistantActionDTO> get() = Assistant.pending(turns)

    fun openPanel(listen: Boolean) {
        if (!loaded) { turns = client.assistantHistory(); loaded = true }
        open = true
        if (listen) startListening(hold = true)
    }

    fun close() {
        open = false
        consentSession++; busy = false
        consentGranted = false; consentRequest = null; asksConsent = false; micWhy = false
        listener.cancel(); listening = false; interim = ""
        speaker?.stop()
    }

    fun hasMic() = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun startListening(hold: Boolean = false) {
        if (!canListen || listening) return
        if (!hasMic()) { micWhy = true; return }
        speaker?.stop()
        interim = ""
        listening = listener.start(lang(), hold, onPartial = { interim = it }) { said ->
            listening = false
            if (said.isNotBlank()) ask(said, voice = true) else interim = ""
        }
    }

    fun stopListening() = listener.stop()

    /** Se soltó la burbuja tras mantenerla: se envía lo dicho. */
    fun release() { holding = false; if (listening) stopListening() }

    fun toggleSpeak() {
        speakOn = !speakOn; client.setAssistantSpeak(speakOn)
        if (!speakOn) speaker?.stop()
    }

    fun clear() { commit(emptyList()); error = null }

    private fun say(reply: String, voice: Boolean) {
        if (!(voice || speakOn)) return
        val s = speaker ?: AssistantSpeaker(ctx).also { speaker = it }
        s.speak(reply, lang())
    }

    private fun patch(id: String, f: AssistantActionDTO.() -> AssistantActionDTO) = commit(Assistant.patch(turns, id, f))

    private fun errorOf(e: Throwable): String = when {
        e is ApiException && e.status == 410 -> ctx.getString(R.string.ai_expired)
        e is ApiException && e.status == 503 -> ctx.getString(R.string.ai_unavailable)
        else -> errorText(ctx, e)
    }

    suspend fun runAction(a: AssistantActionDTO, edited: String? = null) {
        val token = a.token ?: return
        patch(a.id) { copy(status = "done", error = null, text = edited ?: text) }
        try {
            val out = client.assistantRun(token, edited)
            patch(a.id) { copy(status = "done", token = null, undoToken = out.undoToken, link = out.link ?: link) }
        } catch (e: Exception) {
            patch(a.id) { copy(status = "failed", error = errorOf(e)) }
        }
    }

    fun run(a: AssistantActionDTO, edited: String? = null) { scope.launch { runAction(a, edited) } }

    fun sendAll() { pendingAll.forEach { run(it) } }

    fun undo(a: AssistantActionDTO) {
        val token = a.undoToken ?: return
        scope.launch {
            try { client.assistantRun(token); patch(a.id) { copy(status = "undone", undoToken = null) } }
            catch (e: Exception) { patch(a.id) { copy(error = errorOf(e)) } }
        }
    }

    /** Descartar es local: el borrador no se manda. */
    fun discard(a: AssistantActionDTO) = patch(a.id) { copy(status = "undone", token = null) }

    /** «Otra versión»: descarta el borrador y le pide a gg que lo redacte de nuevo. */
    fun redo(a: AssistantActionDTO) {
        if (busy) return
        ask(ctx.getString(R.string.ai_redo_ask, a.target), redoId = a.id)
    }

    fun retry() { turns.lastOrNull()?.takeIf { it.role == "user" }?.let { ask(it.content, retry = true) } }

    fun allowConsent() {
        val request = consentRequest ?: return
        consentGranted = true; consentRequest = null; asksConsent = false
        ask(request.content, request.voice, request.retry, request.redoId)
    }

    /** El borrador (incluido el dictado) queda en el campo; no se envía ni se agrega al historial. */
    fun cancelConsent() { consentRequest = null; asksConsent = false }

    /** [retry]: vuelve a mandar la última pregunta sin repetirla en el historial. */
    fun ask(content: String, voice: Boolean = false, retry: Boolean = false, redoId: String? = null) {
        val q = content.trim()
        if (q.isEmpty() || busy) return
        if (!consentGranted) {
            if (text.isEmpty()) text = content
            interim = ""
            consentRequest = ConsentRequest(q, voice, retry, redoId); asksConsent = true
            return
        }
        if (redoId != null) patch(redoId) { copy(status = "undone", token = null) }
        error = null; text = ""; interim = ""
        val requestSession = consentSession
        val pending = pendingAll
        // «Envíalos» con borradores pendientes: se confirman aquí mismo, sin volver a llamar al modelo.
        if (Assistant.isSendAll(q) && pending.isNotEmpty()) {
            commit(turns + AssistantTurn("user", q, at = System.currentTimeMillis()))
            scope.launch {
                if (requestSession != consentSession) return@launch
                pending.map { a -> async { runAction(a) } }.awaitAll()
                if (requestSession != consentSession) return@launch
                val done = if (pending.size == 1) ctx.getString(R.string.ai_sent_one) else ctx.getString(R.string.ai_sent_all, pending.size)
                commit(turns + AssistantTurn("assistant", done, at = System.currentTimeMillis()))
                say(done, voice)
            }
            return
        }
        val next = if (retry && turns.lastOrNull()?.role == "user") turns else turns + AssistantTurn("user", q, at = System.currentTimeMillis())
        if (next !== turns) commit(next)
        busy = true
        scope.launch {
            try {
                if (requestSession != consentSession) return@launch
                val out = client.assistantTurn(Assistant.history(next), tz(), lang(), aiConsent = true)
                if (requestSession != consentSession) return@launch
                commit(turns + AssistantTurn("assistant", out.reply, out.actions, System.currentTimeMillis(), out.suggestions.filter { it.isNotBlank() }.take(3)))
                say(out.reply, voice)
            } catch (e: Exception) {
                if (requestSession != consentSession) return@launch
                error = if (e is ApiException && e.status == 503) ctx.getString(R.string.ai_unavailable) else errorText(ctx, e)
            } finally { if (requestSession == consentSession) busy = false }
        }
    }

    fun dispose() { close(); speaker?.shutdown(); speaker = null }
}

@Composable
fun rememberAssistant(client: TieComsClient): AssistantModel {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val model = remember(client) { AssistantModel(client, ctx.applicationContext, scope) }
    DisposableEffect(model) { onDispose { model.dispose() } }
    return model
}

/** Colores de la marca gg. */
private val GgOrange = Color(0xFFFF5A36)
private val GgInk = Color(0xFF17161F)

private val STAR_PATHS = listOf(
    "M680 -122 C689.0 -55.8 705.8 -39.0 772 -30 C705.8 -21.0 689.0 -4.2 680 62 C671.0 -4.2 654.2 -21.0 588 -30 C654.2 -39.0 671.0 -55.8 680 -122 Z",
    "M560 -194 C564.3 -162.3 572.3 -154.3 604 -150 C572.3 -145.7 564.3 -137.7 560 -106 C555.7 -137.7 547.7 -145.7 516 -150 C547.7 -154.3 555.7 -162.3 560 -194 Z",
    "M770 65 C772.9 86.6 778.4 92.1 800 95 C778.4 97.9 772.9 103.4 770 125 C767.1 103.4 761.6 97.9 740 95 C761.6 92.1 767.1 86.6 770 65 Z",
)

/** Estrellitas de IA de la marca (mismo lienzo que gg-marca.svg: viewBox -20 -200 820 810); la pequeña va en tinta. */
private fun ggStars(ink: Color): ImageVector = ImageVector.Builder("ggStars", 40.dp, 39.5.dp, 820f, 810f)
    .addGroup(translationX = 20f, translationY = 200f)
    .apply { STAR_PATHS.forEachIndexed { i, d -> addPath(addPathNodes(d), fill = SolidColor(if (i == 2) ink else GgOrange)) } }
    .clearGroup()
    .build()

/** Las animaciones del sistema están apagadas (Opciones de desarrollador o accesibilidad «Quitar animaciones»). */
private fun animationsOff(ctx: Context): Boolean =
    runCatching { android.provider.Settings.Global.getFloat(ctx.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)

/**
 * Marca de gg: las dos «g» de chaggu como burbujas (negra y naranja, con puntitos) y las estrellitas de IA,
 * que titilan suave cada ~3 s si el sistema permite animaciones. [onDark]: la «g» negra pasa a papel.
 */
@Composable
fun GgMark(size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier, onDark: Boolean = false) {
    val ctx = LocalContext.current
    val stars = remember(onDark) { ggStars(if (onDark) Color(0xFFEDE7E1) else GgInk) }
    val still = remember { animationsOff(ctx) }
    // Titileo breve cada ~3 s; entre titileos no se dibuja nada (la app queda en reposo y no gasta batería).
    val alpha = remember { Animatable(1f) }
    LaunchedEffect(still) {
        if (still) return@LaunchedEffect
        while (true) {
            delay(2300)
            alpha.animateTo(0.3f, tween(350)); alpha.animateTo(1f, tween(350))
        }
    }
    Box(modifier.size(size, size * (810f / 820f))) {
        Image(painterResource(if (onDark) R.drawable.gg_mark_light else R.drawable.gg_mark), null, Modifier.fillMaxSize())
        Image(rememberVectorPainter(stars), null, Modifier.fillMaxSize().graphicsLayer { this.alpha = alpha.value })
    }
}

/**
 * Burbuja de gg: círculo blanco de 56 dp con borde naranja al 28 %, anillo exterior naranja al 7 % de 4 dp, sombra
 * suave y la marca de 40 dp. Tocar abre el panel; mantener presionado 0,45 s abre y escucha, y al soltar se envía.
 * [visible] = falso dentro de un chat o con el panel abierto (durante un «mantener» sigue compuesta, invisible).
 */
@Composable
fun AssistantBubble(model: AssistantModel, visible: Boolean, modifier: Modifier = Modifier) {
    if (!visible && !model.holding) return
    val openLabel = stringResource(R.string.ai_open)
    val hint = stringResource(R.string.ai_bubble_hint)
    Box(
        modifier
            .padding(end = 10.dp, bottom = 8.dp)
            .alpha(if (visible) 1f else 0f)
            .size(64.dp)
            .clip(CircleShape)
            .background(GgOrange.copy(alpha = 0.07f))
            .testTag("ggBubble")
            .semantics {
                role = Role.Button
                contentDescription = openLabel
                onClick { model.openPanel(false); true }
                onLongClick(label = hint) { model.openPanel(true); true }
            }
            .pointerInput(model) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    val up = withTimeoutOrNull(450) { waitForUpOrCancellation() }
                    if (up != null) { up.consume(); model.openPanel(false); return@awaitEachGesture }
                    // Sigue presionada: abre y escucha; al soltar (o cancelar) se envía lo dicho.
                    model.holding = true
                    model.openPanel(true)
                    try { waitForUpOrCancellation() } finally { model.release() }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(56.dp)
                .shadow(6.dp, CircleShape, ambientColor = GgInk.copy(alpha = 0.25f), spotColor = GgInk.copy(alpha = 0.25f))
                .background(Color.White, CircleShape)
                .border(1.dp, GgOrange.copy(alpha = 0.28f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            // La marca va un poco abajo y a la derecha (las estrellitas pesan arriba a la derecha), como en gg-boton.
            GgMark(40.dp, Modifier.offset(x = 1.5.dp, y = 2.5.dp))
        }
    }
}

/** Hoja inferior de gg (86 % del alto), encima de todo, incluida la barra de pestañas. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AssistantPanel(model: AssistantModel, myName: String, onOpenLink: (Assistant.Target) -> Unit) {
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) model.startListening() else model.holding = false
    }
    if (model.micWhy) AlertDialog(
        onDismissRequest = { model.micWhy = false },
        title = { Text(stringResource(R.string.voice_mic_title)) },
        text = { Text(stringResource(R.string.ai_mic_body)) },
        confirmButton = { TextButton(onClick = { model.micWhy = false; micPermission.launch(Manifest.permission.RECORD_AUDIO) }, modifier = Modifier.testTag("ggMicAllow")) { Text(stringResource(R.string.voice_mic_allow)) } },
        dismissButton = { TextButton(onClick = { model.micWhy = false }) { Text(stringResource(R.string.cancel)) } },
    )
    if (!model.open) return
    if (model.asksConsent) AlertDialog(
        onDismissRequest = model::cancelConsent,
        title = { Text(stringResource(R.string.gg_consent_title)) },
        text = { Text(stringResource(R.string.gg_consent_body), modifier = Modifier.verticalScroll(rememberScrollState())) },
        confirmButton = { TextButton(onClick = model::allowConsent, modifier = Modifier.testTag("ggConsentAllow")) { Text(stringResource(R.string.gg_consent_allow)) } },
        dismissButton = { TextButton(onClick = model::cancelConsent, modifier = Modifier.testTag("ggConsentCancel")) { Text(stringResource(R.string.cancel)) } },
        modifier = Modifier.testTag("ggConsentDialog"),
    )
    BackHandler { model.close() }
    Box(Modifier.fillMaxSize().testTag("ggPanel")) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.28f))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { model.close() })
        Surface(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.86f),
            shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
            color = MaterialTheme.colorScheme.surface, shadowElevation = 8.dp,
        ) {
            Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
                Header(model)
                Body(model, myName, onOpenLink, Modifier.weight(1f))
                if (model.listening) ListeningStrip(model)
                Composer(model)
            }
        }
    }
}

@Composable
private fun Header(model: AssistantModel) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        GgMark(30.dp, onDark = MaterialTheme.colorScheme.surface.luminance() < 0.5f)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) { heading() }) {
            Text(stringResource(R.string.ai_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(stringResource(R.string.ai_subtitle), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val speakLabel = stringResource(if (model.speakOn) R.string.ai_speak_off else R.string.ai_speak_on)
        IconButton(onClick = { model.toggleSpeak() }, modifier = Modifier.testTag("ggSpeak").semantics { contentDescription = speakLabel }) {
            Text(if (model.speakOn) "🔊" else "🔇", fontSize = 18.sp)
        }
        if (model.turns.isNotEmpty()) {
            val clearLabel = stringResource(R.string.ai_clear)
            IconButton(onClick = { model.clear() }, modifier = Modifier.testTag("ggClear").semantics { contentDescription = clearLabel }) { Text("⟲", fontSize = 20.sp) }
        }
        val closeLabel = stringResource(R.string.close)
        IconButton(onClick = { model.close() }, modifier = Modifier.testTag("ggClose").semantics { contentDescription = closeLabel }) { Text("✕", fontSize = 18.sp) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Body(model: AssistantModel, myName: String, onOpenLink: (Assistant.Target) -> Unit, modifier: Modifier) {
    val list = rememberLazyListState()
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    val pending = model.pendingAll
    val count = model.turns.size + (if (pending.size > 1) 1 else 0) + (if (model.busy) 1 else 0) + (if (model.error != null) 1 else 0)
    LaunchedEffect(count, model.turns.lastOrNull()?.actions) { if (count > 0) list.animateScrollToItem(count) }
    LazyColumn(modifier.fillMaxWidth().testTag("ggBody"), state = list, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (model.turns.isEmpty()) item {
            Column(Modifier.padding(top = 12.dp, start = 2.dp, end = 2.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.ai_hello, myName.split(' ').firstOrNull()?.ifBlank { null } ?: myName),
                    style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("ggHello"))
                Text(stringResource(R.string.ai_intro), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                data class Chip(val label: Int, val fill: Boolean, val tag: String)
                val chips = listOf(
                    Chip(R.string.ai_s_report, false, "report"), Chip(R.string.ai_s_pending, false, "pending"), Chip(R.string.ai_s_due, false, "due"),
                    Chip(R.string.ai_s_write, true, "write"), Chip(R.string.ai_s_group, true, "group"), Chip(R.string.ai_s_meeting, true, "meeting"),
                    Chip(R.string.ai_s_issue, true, "issue"), Chip(R.string.ai_s_cancel, true, "cancel"),
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    chips.forEach { c ->
                        val label = stringResource(c.label)
                        Surface(
                            onClick = { if (c.fill) model.text = label.removeSuffix("…") + " " else { focusManager.clearFocus(); model.ask(label) } },
                            shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer,
                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                            modifier = Modifier.testTag("ggChip-${c.tag}"),
                        ) { Text(label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp)) }
                    }
                }
                if (model.canListen) Text(stringResource(R.string.ai_voice_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        itemsIndexed(model.turns) { i, t -> TurnView(model, t, onOpenLink, Modifier.testTag("ggTurn-$i")) }
        if (pending.size > 1) item {
            Button(onClick = { model.sendAll() }, modifier = Modifier.fillMaxWidth().testTag("ggSendAll")) { Text(stringResource(R.string.ai_send_all, pending.size)) }
        }
        if (model.busy) item { Dots() }
        val last = model.turns.lastOrNull()
        if (!model.busy && !model.listening && last?.role == "assistant" && last.suggestions.isNotEmpty()) item {
            // Siguiente paso: tocar un chip lo envía como si se hubiera escrito.
            FlowRow(Modifier.testTag("ggNext"), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                last.suggestions.forEachIndexed { i, q ->
                    Surface(
                        onClick = { focusManager.clearFocus(); model.ask(q) },
                        shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary), contentColor = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.testTag("ggNext-$i"),
                    ) { Text(q, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp)) }
                }
            }
        }
        model.error?.let { e -> item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(e, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f).testTag("ggError").semantics { liveRegion = LiveRegionMode.Polite })
                if (last?.role == "user") TextButton(onClick = { model.retry() }, modifier = Modifier.testTag("ggRetry")) { Text(stringResource(R.string.ai_retry)) }
            }
        } }
    }
}

@Composable
private fun TurnView(model: AssistantModel, t: AssistantTurn, onOpenLink: (Assistant.Target) -> Unit, modifier: Modifier) {
    val mine = t.role == "user"
    Column(modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Surface(
            shape = RoundedCornerShape(16.dp, 16.dp, if (mine) 4.dp else 16.dp, if (mine) 16.dp else 4.dp),
            color = if (mine) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.surfaceVariant,
            contentColor = if (mine) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.widthIn(max = 320.dp),
        ) { Text(t.content, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) }
        t.actions.forEach { a -> ActionCard(model, a, onOpenLink) }
    }
}

@Composable
private fun ActionCard(model: AssistantModel, a: AssistantActionDTO, onOpenLink: (Assistant.Target) -> Unit) {
    var editing by remember(a.id) { mutableStateOf(false) }
    var draft by remember(a.id) { mutableStateOf(a.text) }
    val danger = a.kind == "cancel_event"
    val scheme = MaterialTheme.colorScheme
    val borderColor = when {
        a.status == "pending" && danger -> scheme.error
        a.status == "pending" -> scheme.primary
        else -> scheme.outlineVariant
    }
    Surface(
        shape = RoundedCornerShape(12.dp), color = scheme.surface,
        border = BorderStroke(if (a.status == "pending") 1.5.dp else 1.dp, borderColor),
        modifier = Modifier.fillMaxWidth().alpha(if (a.status == "undone") 0.55f else 1f).testTag("ggCard-${a.kind}-${a.status}"),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(Assistant.icon(a.kind), color = scheme.primary, fontSize = 16.sp)
                Spacer(Modifier.width(8.dp))
                Text(a.target, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                when (a.status) {
                    "done" -> Text(stringResource(R.string.ai_done), color = Color(0xFF2E7D32), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                    "undone" -> Text(stringResource(R.string.ai_undone), color = scheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
                    "failed" -> Text(stringResource(R.string.ai_failed), color = scheme.error, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                }
            }
            if (editing) OutlinedTextField(draft, { draft = it }, modifier = Modifier.fillMaxWidth().testTag("ggEditField"), minLines = 2, maxLines = 6)
            else Text(a.text, style = MaterialTheme.typography.bodyMedium, textDecoration = if (danger) TextDecoration.LineThrough else null)
            a.detail?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant) }
            a.error?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheme.error) }
            if (a.status == "pending") Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                val verb = when (a.kind) {
                    "send_message" -> R.string.ai_send
                    "create_group" -> R.string.ai_create
                    "cancel_event" -> R.string.ai_cancel_event
                    else -> R.string.ai_confirm
                }
                // Compactos: Enviar · Editar · Otra versión · Descartar caben en una línea.
                val pad = PaddingValues(horizontal = 10.dp, vertical = 0.dp)
                val small = MaterialTheme.typography.labelMedium
                Button(
                    onClick = { model.run(a, if (editing && draft.trim() != a.text && draft.isNotBlank()) draft.trim() else null) },
                    colors = if (danger) ButtonDefaults.buttonColors(containerColor = scheme.error, contentColor = scheme.onError) else ButtonDefaults.buttonColors(),
                    contentPadding = pad, modifier = Modifier.height(32.dp).testTag("ggRun"),
                ) { Text(stringResource(verb), style = small, maxLines = 1) }
                if (a.kind == "send_message" && !editing) {
                    OutlinedButton(onClick = { editing = true }, contentPadding = pad, modifier = Modifier.height(32.dp).testTag("ggEdit")) { Text(stringResource(R.string.ai_edit), style = small, maxLines = 1) }
                    OutlinedButton(onClick = { model.redo(a) }, contentPadding = pad, modifier = Modifier.height(32.dp).testTag("ggRedo")) { Text(stringResource(R.string.ai_redo), style = small, maxLines = 1) }
                }
                OutlinedButton(onClick = { model.discard(a) }, contentPadding = pad, modifier = Modifier.height(32.dp).testTag("ggDiscard")) { Text(stringResource(R.string.ai_discard), style = small, maxLines = 1) }
            }
            val target = Assistant.linkTarget(a.link)
            if (a.status == "done" && (a.undoToken != null || target != null)) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (target != null) OutlinedButton(onClick = { onOpenLink(target) }, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                    modifier = Modifier.height(36.dp).testTag("ggOpen")) { Text(stringResource(R.string.ai_open_it)) }
                if (a.undoToken != null) OutlinedButton(onClick = { model.undo(a) }, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                    modifier = Modifier.height(36.dp).testTag("ggUndo")) { Text(stringResource(R.string.ai_undo)) }
            }
        }
    }
}

@Composable
private fun Dots() {
    val wait = stringResource(R.string.ai_wait)
    val tr = rememberInfiniteTransition(label = "ggDots")
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.testTag("ggThinking").semantics { contentDescription = wait }) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            repeat(3) { i ->
                val a by tr.animateFloat(0.25f, 1f, infiniteRepeatable(tween(600, delayMillis = i * 150), RepeatMode.Reverse), label = "d$i")
                Box(Modifier.size(7.dp).alpha(a).clip(CircleShape).background(MaterialTheme.colorScheme.onSurfaceVariant))
            }
        }
    }
}

@Composable
private fun ListeningStrip(model: AssistantModel) {
    val tr = rememberInfiniteTransition(label = "ggWave")
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer).padding(horizontal = 14.dp, vertical = 8.dp).testTag("ggListening")
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
            repeat(5) { i ->
                val h by tr.animateFloat(5f, 18f, infiniteRepeatable(tween(420, delayMillis = i * 90), RepeatMode.Reverse), label = "w$i")
                Box(Modifier.width(3.dp).height(h.dp).clip(RoundedCornerShape(2.dp)).background(MaterialTheme.colorScheme.primary))
            }
        }
        Spacer(Modifier.width(10.dp))
        Text(model.interim.ifBlank { stringResource(R.string.ai_listening) }, modifier = Modifier.weight(1f), maxLines = 3, overflow = TextOverflow.Ellipsis,
            color = MaterialTheme.colorScheme.onPrimaryContainer)
        TextButton(onClick = { model.stopListening() }, modifier = Modifier.testTag("ggStop")) { Text(stringResource(R.string.ai_stop)) }
    }
}

@Composable
private fun Composer(model: AssistantModel) {
    val focus = remember { FocusRequester() }
    // TextFieldValue: cuando un chip rellena el campo, el cursor queda al final para seguir escribiendo.
    var field by remember { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(model.text)) }
    LaunchedEffect(model.text) {
        if (model.text != field.text) {
            field = androidx.compose.ui.text.input.TextFieldValue(model.text, androidx.compose.ui.text.TextRange(model.text.length))
            if (model.text.isNotBlank()) runCatching { focus.requestFocus() }
        }
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        val placeholder = stringResource(R.string.ai_placeholder)
        TextField(
            field, { field = it; model.text = it.text },
            placeholder = { Text(placeholder) }, maxLines = 5,
            shape = RoundedCornerShape(22.dp),
            colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent),
            modifier = Modifier.weight(1f).focusRequester(focus).testTag("ggInput").semantics { contentDescription = placeholder },
        )
        Spacer(Modifier.width(8.dp))
        val scheme = MaterialTheme.colorScheme
        if (model.text.isNotBlank()) {
            val label = stringResource(R.string.ai_send)
            Surface(onClick = { model.ask(model.text) }, enabled = !model.busy, shape = CircleShape, color = scheme.primary, contentColor = scheme.onPrimary,
                modifier = Modifier.size(44.dp).testTag("ggSend").semantics { contentDescription = label }) {
                Box(contentAlignment = Alignment.Center) { Text("↑", fontSize = 20.sp, fontWeight = FontWeight.Bold) }
            }
        } else if (model.canListen) {
            val label = stringResource(if (model.listening) R.string.ai_stop else R.string.ai_talk)
            Surface(onClick = { if (model.listening) model.stopListening() else model.startListening() }, shape = CircleShape,
                color = if (model.listening) scheme.primary else scheme.surfaceContainerHigh,
                modifier = Modifier.size(44.dp).testTag("ggMic").semantics { contentDescription = label }) {
                Box(contentAlignment = Alignment.Center) { Text("🎤", fontSize = 18.sp) }
            }
        }
    }
}
