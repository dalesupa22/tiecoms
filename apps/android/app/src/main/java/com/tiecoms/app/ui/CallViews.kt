package com.tiecoms.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.ClosedCaption
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.DefaultVideoRenderView
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.VideoScalingType
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.CallHistoryItemDTO
import com.tiecoms.app.core.CallTranscriptDTO
import com.tiecoms.app.core.Calls
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.GuestCalls
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import com.tiecoms.app.core.Names
import com.tiecoms.app.platform.CallManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/*
 * Llamadas en Android (docs/LLAMADAS.md; referencia: apps/web/src/screens/Call.tsx):
 * 📞/🎥 del encabezado, franja «Llamada en curso · Unirse», aviso de llamada entrante, pantalla de la llamada
 * (con subtítulos y la transcripción), pestaña «Llamadas» y el detalle con Resumen, Transcripción y Compartir.
 * Todo sale solo con features.calls del bootstrap.
 */

internal val CallInk = Color(0xFFF7F3EE)
internal val CallBg = Color(0xFF161412)
internal val HangRed = Color(0xFFD93B2B)
/** Rojo de las llamadas perdidas (igual que la web): pastilla de «Llamadas» y etiqueta «Perdida». */
internal val MissedRed = Color(0xFFD93025)

/** Nombre corto; si la persona no está en mi lista (me agregaron a la llamada), sale de call.names. */
private fun firstName(data: BootstrapDTO?, id: String?, call: com.tiecoms.app.core.CallDTO? = null): String =
    Calls.firstName(id?.let { Names.person(data, it)?.name }, call, id)
private fun dateTime(iso: String): String = parseInstant(iso)?.atZone(java.time.ZoneId.systemDefault())
    ?.format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)) ?: iso

/** Abre el detalle de una llamada desde cualquier pantalla (lo navega MainNav). */
fun openCallDetail(container: com.tiecoms.app.AppContainer, callId: String) { container.pendingLink.value = DeepLink.CallDetail(callId) }

// ---------- Permisos ----------
/**
 * Pide micrófono (y cámara en video) en tiempo de ejecución antes de llamar o contestar.
 * [action] recibe si hay cámara; sin micrófono no se llama.
 */
class CallLauncher internal constructor(val launch: (video: Boolean, action: suspend (camera: Boolean) -> Unit) -> Unit)

@Composable
fun rememberCallLauncher(): CallLauncher {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    var pending by remember { mutableStateOf<Pair<Boolean, suspend (Boolean) -> Unit>?>(null) }
    fun run(camera: Boolean, action: suspend (Boolean) -> Unit) {
        container.scope.launch { try { action(camera) } catch (e: Exception) { if (e !is kotlinx.coroutines.CancellationException) container.toast(errorText(ctx, e)) } }
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        val p = pending ?: return@rememberLauncherForActivityResult
        pending = null
        fun ok(perm: String) = res[perm] == true || ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED
        if (!ok(Manifest.permission.RECORD_AUDIO)) { container.toast(ctx.getString(R.string.call_perm_denied)); return@rememberLauncherForActivityResult }
        val cam = p.first && ok(Manifest.permission.CAMERA)
        if (p.first && !cam) container.toast(ctx.getString(R.string.call_perm_camera_denied))
        run(cam, p.second)
    }
    return remember(launcher) {
        CallLauncher { video, action ->
            val need = listOfNotNull(Manifest.permission.RECORD_AUDIO, if (video) Manifest.permission.CAMERA else null)
            val missing = need.filter { ContextCompat.checkSelfPermission(ctx, it) != PackageManager.PERMISSION_GRANTED }
            if (missing.isEmpty()) run(video, action)
            else { pending = video to action; launcher.launch(missing.toTypedArray()) }
        }
    }
}

// ---------- Encabezado del chat y franja ----------
/** 📞 y 🎥 del encabezado (solo con las llamadas prendidas en el servidor y si puedo escribir). */
@Composable
fun CallHeaderButtons(conv: ConversationDTO, data: BootstrapDTO) {
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val known = st.calls.containsKey(conv.id)
    LaunchedEffect(data.callsEnabled, conv.id, known) { if (data.callsEnabled && !known) runCatching { client.loadCall(conv.id) } }
    if (!data.callsEnabled || !conv.canPost) return
    val launcher = rememberCallLauncher()
    IconButton(onClick = { launcher.launch(false) { container.calls.start(conv.id, "audio") } }, modifier = Modifier.testTag("callAudio")) {
        Icon(Icons.Filled.Call, stringResource(R.string.call_audio))
    }
    IconButton(onClick = { launcher.launch(true) { cam -> container.calls.start(conv.id, if (cam) "video" else "audio") } }, modifier = Modifier.testTag("callVideo")) {
        Icon(Icons.Filled.Videocam, stringResource(R.string.call_video))
    }
}

/** Franja arriba del chat cuando hay una llamada en curso a la que no he entrado. */
@Composable
fun CallBanner(conversationId: String, data: BootstrapDTO) {
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val mine by container.calls.view.collectAsStateWithLifecycle()
    val call = st.calls[conversationId]
    if (!data.callsEnabled || call == null || mine?.call?.id == call.id) return
    // Acabo de colgar y el servidor todavía no confirmó: solo quedaba yo dentro, no hay a qué unirse.
    if (call.activeUserIds.all { it == data.me.id }) return
    val launcher = rememberCallLauncher()
    val names = call.activeUserIds.map { firstName(data, it) }.filter { it.isNotEmpty() }.joinToString(", ")
    Surface(color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.fillMaxWidth().testTag("callBanner")) {
        Row(Modifier.padding(start = 14.dp, end = 8.dp, top = 4.dp, bottom = 4.dp).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.CenterVertically) {
            Text((if (call.isVideo) "🎥 " else "📞 ") + stringResource(R.string.call_in_progress) + (if (names.isNotEmpty()) " · $names" else "") +
                (if (call.transcribing) " · " + stringResource(R.string.call_transcribing_short) else ""),
                Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Button(onClick = { launcher.launch(false) { container.calls.join(call.id, false) } }, contentPadding = PaddingValues(horizontal = 14.dp),
                modifier = Modifier.heightIn(min = 40.dp).testTag("callJoin")) { Text(stringResource(R.string.call_join)) }
        }
    }
}

// ---------- Capa de la llamada (sobre toda la app) ----------
/** Aviso de llamada entrante, pantalla de la llamada y su pastilla minimizada. Va en MainNav, encima de todo. */
@Composable
fun CallOverlayHost(onOpenConversation: (String) -> Unit) {
    val container = LocalContainer.current
    val view by container.calls.view.collectAsStateWithLifecycle()
    val ring by container.calls.ringing.collectAsStateWithLifecycle()
    Box(Modifier.fillMaxSize()) {
        // La llamada como invitado por enlace la dibuja GuestCallHost (AppRoot), también sin sesión.
        view?.takeIf { it.guest == null }?.let { v ->
            if (v.expanded) CallScreen(v, onOpenConversation)
            else CallPill(v, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 6.dp))
        }
        ring?.let { r -> IncomingCallCard(r, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(12.dp)) }
    }
}

/** 1.7.1: la llamada en la que estoy desde OTRO dispositivo (y no desde este), para la franja de arriba. */
@Composable
fun rememberElsewhereCall(): com.tiecoms.app.core.CallDTO? {
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val view by container.calls.view.collectAsStateWithLifecycle()
    val ring by container.calls.ringing.collectAsStateWithLifecycle()
    val data = st.data ?: return null
    if (!data.callsEnabled) return null
    val keys = remember(client, data.me.id) { client.myDeviceKeys() }
    return com.tiecoms.app.core.Calls171.elsewhere(data.myActiveCall, st.calls, view?.call?.id, keys)?.takeIf { it.id != ring?.call?.id }
}

/**
 * Franja fija arriba (empuja la app, como la de actualización): «📞 En llamada en tu {dispositivo} · {chat}»
 * con Pasar aquí, Unirme también y Agregar.
 */
@Composable
fun ElsewhereBanner(call: com.tiecoms.app.core.CallDTO, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val keys = remember(client, data.me.id) { client.myDeviceKeys() }
    val launcher = rememberCallLauncher()
    var adding by remember { mutableStateOf(false) }
    val dev = com.tiecoms.app.core.Calls171.otherDevice(call, keys)
    val devName = com.tiecoms.app.core.Calls171.deviceName(dev, stringResource(R.string.dev_iphone), stringResource(R.string.dev_android),
        stringResource(R.string.dev_web), stringResource(R.string.dev_desktop), stringResource(R.string.dev_other))
    val chat = data.conversations.firstOrNull { it.id == call.conversationId }?.let { titleOf(ctx, it, data) } ?: call.title
    Surface(color = Color(0xFF1F7A4D), contentColor = Color.White, modifier = Modifier.fillMaxWidth().testTag("callElsewhere")) {
        Column(modifier.padding(horizontal = 12.dp, vertical = 8.dp).semantics(mergeDescendants = false) { liveRegion = LiveRegionMode.Polite }) {
            Text("📞 " + stringResource(R.string.elsewhere_text, devName) + (chat?.let { " · $it" } ?: ""), style = MaterialTheme.typography.labelLarge,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("callElsewhereText"))
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(onClick = { launcher.launch(false) { container.calls.takeOver(call, keys) } }, colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color(0xFF1F7A4D)),
                    contentPadding = PaddingValues(horizontal = 12.dp), modifier = Modifier.heightIn(min = 40.dp).testTag("callMoveHere")) { Text(stringResource(R.string.elsewhere_move), maxLines = 1) }
                OutlinedButton(onClick = { launcher.launch(false) { container.calls.join(call.id, false) } }, colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                    contentPadding = PaddingValues(horizontal = 12.dp), modifier = Modifier.heightIn(min = 40.dp).testTag("callJoinToo")) { Text(stringResource(R.string.elsewhere_join), maxLines = 1) }
                OutlinedButton(onClick = { adding = true }, colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                    contentPadding = PaddingValues(horizontal = 10.dp), modifier = Modifier.heightIn(min = 40.dp).testTag("callElsewhereAdd")) {
                    Icon(Icons.Filled.PersonAdd, null, Modifier.size(18.dp)); Spacer(Modifier.width(4.dp)); Text(stringResource(R.string.cc_add), maxLines = 1)
                }
            }
        }
    }
    if (adding) AddToCallSheet(call, data, onDismiss = { adding = false })
}

@Composable
internal fun rememberClock(startedAt: String): String {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(startedAt) { while (true) { now = System.currentTimeMillis(); delay(1000) } }
    val start = parseInstant(startedAt)?.toEpochMilli() ?: now
    return Calls.clock((now - start) / 1000)
}

@Composable
private fun IncomingCallCard(r: CallManager.Ring, modifier: Modifier) {
    val container = LocalContainer.current
    val launcher = rememberCallLauncher()
    val pulse = rememberInfiniteTransition(label = "ring").animateFloat(0.9f, 1.15f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "pulse")
    val cd = stringResource(R.string.call_incoming)
    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, shadowElevation = 8.dp,
        modifier = modifier.widthIn(max = 520.dp).fillMaxWidth().semantics { contentDescription = cd; liveRegion = LiveRegionMode.Assertive }.testTag("callRing")) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (r.call.isVideo) "🎥" else "📞", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.scale(pulse.value))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(r.callerName.ifBlank { stringResource(R.string.call_title) }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(r.title?.let { stringResource(R.string.call_incoming_in, it) } ?: stringResource(R.string.call_incoming),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(onClick = { container.calls.decline(r.call.id) }, modifier = Modifier.weight(1f).heightIn(min = 44.dp).testTag("callDecline")) {
                    Text(stringResource(R.string.call_decline), maxLines = 1)
                }
                Button(onClick = { launcher.launch(false) { container.calls.join(r.call.id, false) } }, modifier = Modifier.weight(1f).heightIn(min = 44.dp).testTag("callAnswer")) {
                    Text("📞 " + stringResource(if (r.call.isVideo) R.string.call_answer_audio else R.string.call_answer), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (r.call.isVideo) Button(onClick = { launcher.launch(true) { cam -> container.calls.join(r.call.id, cam) } },
                modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).testTag("callAnswerVideo")) { Text("🎥 " + stringResource(R.string.call_answer_video)) }
        }
    }
}

@Composable
internal fun CallPill(v: CallManager.View, modifier: Modifier) {
    val container = LocalContainer.current
    val clock = rememberClock(v.call.startedAt)
    val cd = stringResource(R.string.call_expand)
    Surface(onClick = { container.calls.setExpanded(true) }, shape = RoundedCornerShape(50), color = Color(0xFF1F7A4D), contentColor = Color.White, shadowElevation = 6.dp,
        modifier = modifier.semantics { contentDescription = cd }.testTag("callPill")) {
        Row(Modifier.padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text((if (v.call.isVideo) "🎥 " else "📞 ") + stringResource(R.string.call_title) + " · " + (if (v.phase == CallManager.Phase.CONNECTING) stringResource(R.string.call_connecting) else clock) +
                (if (v.call.transcribing) " · ⏺" else ""), style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.width(6.dp))
            IconButton(onClick = { container.scope.launch { container.calls.hangUp() } }, modifier = Modifier.size(36.dp).background(HangRed, CircleShape)) {
                Icon(Icons.Filled.CallEnd, stringResource(R.string.call_hang_up), tint = Color.White, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun CallScreen(v: CallManager.View, onOpenConversation: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val conv = data.conversations.firstOrNull { it.id == v.call.conversationId }
    val me = data.me.id
    // 1.7.4: personas de chaggu y, al final, los invitados por enlace (`guest:<id>`).
    val people = (listOf(me) + GuestCalls.people(v.call).filter { it != me }).distinct()
    val others = people.filter { it != me }
    val you = stringResource(R.string.call_you)
    val nameOf: (String?) -> String = { id -> if (id == me) you else GuestCalls.guestName(v.call, id) ?: firstName(data, id, v.call) }
    val clock = rememberClock(v.call.startedAt)
    var consent by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var routes by remember { mutableStateOf(false) }
    var screenFull by remember { mutableStateOf<Int?>(null) }
    val full = screenFull?.takeIf { id -> v.screens.any { it.tileId == id } }
    val cameraPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) container.calls.toggleCamera() else container.toast(ctx.getString(R.string.call_perm_camera_denied))
    }
    androidx.activity.compose.BackHandler { if (full != null) screenFull = null else container.calls.setExpanded(false) }
    Surface(color = CallBg, contentColor = CallInk, modifier = Modifier.fillMaxSize().testTag("callScreen")) {
        Column(Modifier.fillMaxSize().then(if (full != null) Modifier else Modifier.safeDrawingPadding())) {
            if (full == null) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { container.calls.setExpanded(false) }, modifier = Modifier.testTag("callMinimize")) {
                        Icon(Icons.Filled.KeyboardArrowDown, stringResource(R.string.call_minimize), tint = CallInk)
                    }
                    Column(Modifier.weight(1f).clickable(enabled = conv != null) { container.calls.setExpanded(false); onOpenConversation(v.call.conversationId) }) {
                        // Si me agregaron a una llamada de un chat en el que no estoy: los nombres de quienes están (call.names).
                        Text(conv?.let { titleOf(ctx, it, data) } ?: v.call.title?.takeIf { it.isNotBlank() } ?: others.map { nameOf(it) }.filter { it.isNotEmpty() }.joinToString(", ").ifEmpty { stringResource(R.string.call_title) }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.semantics { heading() })
                        Text(if (v.phase == CallManager.Phase.CONNECTING) stringResource(R.string.call_connecting) else clock, style = MaterialTheme.typography.bodySmall,
                            color = CallInk.copy(alpha = 0.7f), modifier = Modifier.testTag("callClock"))
                    }
                    Box(Modifier.padding(end = 12.dp).size(10.dp).background(if (v.phase == CallManager.Phase.LIVE) Color(0xFF3CCB7F) else Color(0xFFBDB5AE), CircleShape))
                }
                CallNotices(v)
            }
            Box(Modifier.weight(1f).fillMaxWidth().padding(if (full != null) 0.dp else 8.dp)) {
                val now by rememberNow()
                CallStage(v, people, me, data, nameOf, full, onFull = { screenFull = it }, waiting = others.isEmpty() && v.invitedAt.isEmpty()) {
                    // Invitados que aún no entran: «Llamando…» y, a los 45 s, «No contestó» con «Volver a llamar».
                    v.invitedAt.forEach { (id, at) ->
                        val st2 = com.tiecoms.app.core.Calls171Invites.state(at, now)
                        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(104.dp).testTag("callInvited-$id")) {
                            Box(Modifier.size(84.dp).padding(4.dp).then(Modifier.graphicsLayer(alpha = 0.55f))) { PersonAvatar(Names.person(data, id), data, size = 76.dp) }
                            Text(firstName(data, id, v.call), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (st2 == com.tiecoms.app.core.Calls171Invites.State.CALLING)
                                Text(stringResource(R.string.inv_calling), style = MaterialTheme.typography.labelSmall, color = CallInk.copy(alpha = 0.7f), modifier = Modifier.testTag("invCalling-$id"))
                            else {
                                Text(stringResource(R.string.inv_no_answer), style = MaterialTheme.typography.labelSmall, color = Color(0xFFFFB4A8), modifier = Modifier.testTag("invNoAnswer-$id"))
                                TextButton(onClick = { container.scope.launch { runCatching { container.calls.reinvite(id) }.onFailure { container.toast(errorText(ctx, it)) } } },
                                    contentPadding = PaddingValues(horizontal = 6.dp), modifier = Modifier.heightIn(min = 36.dp).testTag("invRingAgain-$id")) {
                                    Text(stringResource(R.string.inv_ring_again), color = CallInk, style = MaterialTheme.typography.labelMedium)
                                }
                            }
                        }
                    }
                }
            }
            if (full == null) {
                CallCaptions(v, me, nameOf)
                // 1.7.1: controles con texto (se nota «Agregar»), en dos filas si no caben; Colgar abajo al centro.
                androidx.compose.foundation.layout.FlowRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp).testTag("callControls"),
                    horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MediaControls(v, onRoutes = { routes = true }, onCameraPermission = { cameraPerm.launch(Manifest.permission.CAMERA) })
                    CallControl(Icons.Filled.PersonAdd, stringResource(R.string.cc_add), stringResource(R.string.call_add), off = false, tag = "callAdd") { adding = true }
                    // 1.7.6: 🔗 vuelve a abrir «Comparte el enlace» (solo en las llamadas rápidas, que traen enlace).
                    if (v.shareLink != null) CallControl(Icons.Filled.Link, stringResource(R.string.cc_link), stringResource(R.string.call_share_again), off = false, tag = "callShareLink") { container.calls.setSharing(true) }
                    CallControl(Icons.Filled.ClosedCaption, stringResource(R.string.cc_transcribe), stringResource(if (v.call.transcribing) R.string.call_transcript_off else R.string.call_transcript_on), off = false, rec = v.call.transcribing, tag = "callTranscript") {
                        if (v.call.transcribing) container.scope.launch { runCatching { container.calls.setTranscription(false) }.onFailure { container.toast(errorText(ctx, it)) } }
                        else consent = true
                    }
                }
                HangUpButton { container.scope.launch { container.calls.hangUp() } }
            }
        }
    }
    if (routes) AudioRouteSheet(v, onDismiss = { routes = false })
    if (v.sharing) v.shareLink?.let { url -> ShareCallLinkSheet(url, v.call, onDismiss = { container.calls.setSharing(false) }) }
    if (adding) AddToCallSheet(v.call, data, onDismiss = { adding = false })
    if (consent) TranscriptConsentDialog(onDismiss = { consent = false }) { ai ->
        consent = false
        container.scope.launch { runCatching { container.calls.setTranscription(true, ai) }.onFailure { container.toast(errorText(ctx, it)) } }
    }
}

/** Franjas de la llamada: «Se está transcribiendo», proveedor falso y el error del momento. */
@Composable
internal fun CallNotices(v: CallManager.View) {
    val container = LocalContainer.current
    if (v.call.transcribing) Text("⏺ " + stringResource(R.string.call_transcribing_all), Modifier.fillMaxWidth().background(HangRed.copy(alpha = 0.85f))
        .padding(horizontal = 14.dp, vertical = 6.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("callTranscribing"),
        color = Color.White, style = MaterialTheme.typography.labelLarge)
    if (v.fake) Text(stringResource(R.string.call_fake), Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp).testTag("callFake"),
        style = MaterialTheme.typography.labelMedium, color = CallInk.copy(alpha = 0.7f))
    v.error?.let { e ->
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(e), Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = Color(0xFFFFB4A8))
            TextButton(onClick = { container.calls.clearError() }) { Text("✕", color = CallInk) }
        }
    }
}

@Composable
internal fun CallCaptions(v: CallManager.View, me: String, nameOf: (String?) -> String) {
    if (v.call.transcribing && v.captions.isNotEmpty()) Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).background(Color.Black.copy(alpha = 0.45f), RoundedCornerShape(10.dp))
        .padding(10.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("callCaptions")) {
        v.captions.takeLast(4).forEach { c ->
            val who = if (c.userId == me) stringResource(R.string.call_you) else nameOf(c.userId).ifEmpty { "·" }
            Text("$who: " + (if (c.processing) "⏳ " + stringResource(R.string.call_processing) else c.text), style = MaterialTheme.typography.bodyMedium,
                color = if (c.partial) CallInk.copy(alpha = 0.65f) else CallInk, modifier = if (c.processing) Modifier.testTag("callProcessing") else Modifier)
        }
    }
}

/** Silenciar, cámara, girar cámara y salida de audio (igual para la llamada normal y la de invitado). */
@Composable
internal fun MediaControls(v: CallManager.View, onRoutes: () -> Unit, onCameraPermission: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    CallControl(if (v.muted) Icons.Filled.MicOff else Icons.Filled.Mic, stringResource(if (v.muted) R.string.cc_unmute else R.string.cc_mute),
        stringResource(if (v.muted) R.string.call_unmute else R.string.call_mute), off = v.muted, tag = "callMute") { container.calls.toggleMute() }
    CallControl(if (v.camera) Icons.Filled.Videocam else Icons.Filled.VideocamOff, stringResource(R.string.cc_camera),
        stringResource(if (v.camera) R.string.call_camera_off else R.string.call_camera_on), off = !v.camera, tag = "callCamera") {
        // En una llamada de voz: la primera vez pide el permiso de cámara; luego el video sale sin reconectar.
        if (!v.camera && ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) onCameraPermission()
        else container.calls.toggleCamera()
    }
    if (v.camera) CallControl(Icons.Filled.Cameraswitch, stringResource(R.string.cc_flip), stringResource(R.string.call_switch_camera), off = false, tag = "callSwitch") { container.calls.switchCamera() }
    CallControl(routeIcon(v.route), routeLabel(v.route), stringResource(R.string.route_title) + ": " + routeLabel(v.route), off = v.route == com.tiecoms.app.core.Calls171.Route.EARPIECE, tag = "callSpeaker") {
        if (com.tiecoms.app.core.Calls171.needsPicker(v.routes)) onRoutes() else container.calls.toggleSpeaker()
    }
}

@Composable
internal fun HangUpButton(onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(bottom = 14.dp, top = 4.dp), contentAlignment = Alignment.Center) {
        IconButton(onClick = onClick, modifier = Modifier.size(62.dp).background(HangRed, CircleShape).testTag("callHangUp")) {
            Icon(Icons.Filled.CallEnd, stringResource(R.string.call_hang_up), tint = Color.White)
        }
    }
}

/**
 * Lo del medio de la llamada (normal o como invitado):
 * - Con una pantalla compartida: la pantalla grande, entera (sin recortar), y abajo una tira con las personas. [full]: solo la pantalla.
 * - Con alguien en video: cuadrícula; quien no tiene cámara sale como avatar en su celda.
 * - Si no: avatares (con [extra] al final: los invitados que aún no entran) y «Esperando…».
 */
@Composable
internal fun CallStage(
    v: CallManager.View, people: List<String>, me: String, data: BootstrapDTO?, nameOf: (String?) -> String,
    full: Int?, onFull: (Int?) -> Unit, waiting: Boolean, extra: @Composable () -> Unit = {},
) {
    val live = v.tiles.filter { !it.paused || it.local }
    val tileOf: (String) -> CallManager.Tile? = { id -> if (id == me) live.firstOrNull { it.local } else live.firstOrNull { !it.local && it.userId == id } }
    val muted: (String) -> Boolean = { id -> if (id == me) v.muted else id in v.mutedIds }
    val isG: (String) -> Boolean = { id -> id != me && GuestCalls.isGuest(id) }
    if (v.screens.isNotEmpty()) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val shown = if (full != null) v.screens.filter { it.tileId == full } else v.screens
            shown.forEach { t ->
                androidx.compose.runtime.key(t.tileId) {
                    ScreenTile(t, stringResource(R.string.call_screen_of, nameOf(t.userId)), full = full != null,
                        onToggle = { onFull(if (full == null) t.tileId else null) }, modifier = Modifier.fillMaxWidth().weight(1f))
                }
            }
            if (full == null) androidx.compose.foundation.lazy.LazyRow(Modifier.fillMaxWidth().height(104.dp).testTag("callStrip"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(people, key = { it }) { id ->
                    val t = tileOf(id)
                    Box(Modifier.width(120.dp).fillMaxHeight()) {
                        if (t != null) VideoTile(t, nameOf(id), rows = 1, muted = muted(id), height = 104, guest = isG(id))
                        else AvatarCell(id, data, nameOf(id), rows = 1, muted = muted(id), speaking = id in v.speaking, height = 104, avatar = 48.dp, guest = isG(id))
                    }
                }
            }
        }
        return
    }
    if (live.isNotEmpty()) {
        val cols = if (people.size <= 1) 1 else 2
        val rows = (people.size + cols - 1) / cols
        LazyVerticalGrid(GridCells.Fixed(cols), Modifier.fillMaxSize().testTag("callGrid"), verticalArrangement = Arrangement.spacedBy(6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(people, key = { it }) { id ->
                val t = tileOf(id)
                if (t != null) VideoTile(t, nameOf(id), rows = rows, muted = muted(id), guest = isG(id))
                else AvatarCell(id, data, nameOf(id), rows = rows, muted = muted(id), speaking = id in v.speaking, guest = isG(id))
            }
        }
        return
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.align(Alignment.Center).verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                people.forEach { id ->
                    val speaking = id in v.speaking
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(92.dp).testTag("callPerson-$id")) {
                        Box(Modifier.size(84.dp).border(if (speaking) 3.dp else 0.dp, if (speaking) Color(0xFF3CCB7F) else Color.Transparent, CircleShape).padding(4.dp)) {
                            CallAvatar(id, data, nameOf(id), size = 76.dp)
                            if (muted(id)) MutedBadge(Modifier.align(Alignment.BottomEnd))
                        }
                        Text(nameOf(id), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        // 1.7.6: el correo que dejó el invitado (llamadas rápidas).
                        if (isG(id)) GuestCalls.guestEmail(v.call, id)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = CallInk.copy(alpha = 0.7f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("callGuestEmail-$id")) }
                        if (isG(id)) GuestTag()
                    }
                }
                extra()
            }
            if (waiting) Text(stringResource(R.string.call_waiting), color = CallInk.copy(alpha = 0.7f), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("callWaiting"))
        }
    }
}

/** Etiqueta «invitado» de quien entró con el enlace (sin cuenta en chaggu). */
@Composable
internal fun GuestTag(modifier: Modifier = Modifier) {
    Text(stringResource(R.string.call_guest_badge), modifier.background(Color.White.copy(alpha = 0.16f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 1.dp).testTag("callGuestTag"),
        style = MaterialTheme.typography.labelSmall, color = CallInk, maxLines = 1)
}

/** Avatar dentro de la llamada: el de la persona si la conozco; si no (invitado, o me agregaron), iniciales sobre su color. */
@Composable
internal fun CallAvatar(id: String, data: BootstrapDTO?, name: String, size: androidx.compose.ui.unit.Dp) {
    val p = Names.person(data, id)
    if (p != null) PersonAvatar(p, data, size = size)
    else Avatar(name.ifBlank { "?" }, personColor(id), Color.White, size = size)
}

/** Pantalla compartida por otra persona: entera (AspectFit, sin recortar), con «Ampliar» (o doble toque) y su nombre. */
@Composable
internal fun ScreenTile(t: CallManager.Tile, label: String, full: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val container = LocalContainer.current
    Box(modifier.clip(RoundedCornerShape(if (full) 0.dp else 12.dp)).background(Color.Black).testTag("callScreenTile-${t.tileId}")) {
        AndroidView(
            factory = { c -> DefaultVideoRenderView(c).apply { init(container.calls.egl); scalingType = VideoScalingType.AspectFit; mirror = false; container.calls.bind(t.tileId, this) } },
            onRelease = { view -> container.calls.unbind(t.tileId); view.release() },
            modifier = Modifier.fillMaxSize(),
        )
        Box(Modifier.matchParentSize().pointerInput(full) { detectTapGestures(onDoubleTap = { onToggle() }) })
        if (t.paused) Text("⏸", Modifier.align(Alignment.Center), color = Color.White, style = MaterialTheme.typography.headlineMedium)
        Text("🖥️ $label", Modifier.align(Alignment.BottomStart).then(if (full) Modifier.navigationBarsPadding() else Modifier).padding(8.dp)
            .background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
            color = Color.White, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        IconButton(onClick = onToggle, modifier = Modifier.align(Alignment.TopEnd).then(if (full) Modifier.statusBarsPadding() else Modifier).padding(6.dp)
            .background(Color.Black.copy(alpha = 0.55f), CircleShape).testTag(if (full) "callScreenExit" else "callScreenFull")) {
            Icon(if (full) Icons.Filled.FullscreenExit else Icons.Filled.Fullscreen, stringResource(if (full) R.string.call_screen_exit else R.string.call_screen_full), tint = Color.White)
        }
    }
}

@Composable
internal fun CallControl(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, description: String, off: Boolean, tag: String, rec: Boolean = false, onClick: () -> Unit) {
    val bg = when { rec -> HangRed.copy(alpha = 0.9f); off -> Color.White.copy(alpha = 0.12f); else -> Color.White.copy(alpha = 0.26f) }
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(64.dp).clickable(onClick = onClick, role = androidx.compose.ui.semantics.Role.Button)
        .semantics(mergeDescendants = true) { contentDescription = description }.testTag(tag)) {
        Box(Modifier.size(50.dp).background(bg, CircleShape), contentAlignment = Alignment.Center) { Icon(icon, null, tint = CallInk) }
        Text(label, style = MaterialTheme.typography.labelSmall, color = CallInk, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
    }
}

@Composable
internal fun routeLabel(r: com.tiecoms.app.core.Calls171.Route): String = stringResource(when (r) {
    com.tiecoms.app.core.Calls171.Route.EARPIECE -> R.string.route_earpiece
    com.tiecoms.app.core.Calls171.Route.SPEAKER -> R.string.route_speaker
    com.tiecoms.app.core.Calls171.Route.BLUETOOTH -> R.string.route_bluetooth
    com.tiecoms.app.core.Calls171.Route.WIRED -> R.string.route_wired
})

internal fun routeIcon(r: com.tiecoms.app.core.Calls171.Route) = when (r) {
    com.tiecoms.app.core.Calls171.Route.EARPIECE -> Icons.Filled.PhoneInTalk
    com.tiecoms.app.core.Calls171.Route.SPEAKER -> Icons.AutoMirrored.Filled.VolumeUp
    com.tiecoms.app.core.Calls171.Route.BLUETOOTH -> Icons.Filled.Bluetooth
    com.tiecoms.app.core.Calls171.Route.WIRED -> Icons.Filled.Headphones
}

/** Salida de audio con Bluetooth o cable conectados: auricular, altavoz, Bluetooth, audífonos. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AudioRouteSheet(v: CallManager.View, onDismiss: () -> Unit) {
    val container = LocalContainer.current
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("callRoutes")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(stringResource(R.string.route_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() })
            v.routes.forEach { r ->
                Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable { container.calls.setRoute(r); onDismiss() }.padding(horizontal = 16.dp).testTag("callRoute-${r.name}"),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(routeIcon(r), null); Spacer(Modifier.width(14.dp))
                    Text(routeLabel(r), Modifier.weight(1f), fontWeight = if (r == v.route) FontWeight.SemiBold else FontWeight.Normal)
                    if (r == v.route) Text("✓", color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

@Composable
internal fun rememberNow(): androidx.compose.runtime.State<Long> {
    val now = remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now.longValue = System.currentTimeMillis() } }
    return now
}

@Composable
internal fun MutedBadge(modifier: Modifier) {
    val cd = stringResource(R.string.p_muted)
    Box(modifier.size(24.dp).background(Color.Black.copy(alpha = 0.6f), CircleShape).semantics { contentDescription = cd }, contentAlignment = Alignment.Center) {
        Icon(Icons.Filled.MicOff, null, tint = Color.White, modifier = Modifier.size(14.dp))
    }
}

/** Celda de la cuadrícula para quien no tiene la cámara prendida: su avatar, con «Cámara apagada» y el micrófono. */
@Composable
internal fun AvatarCell(id: String, data: BootstrapDTO?, label: String, rows: Int, muted: Boolean, speaking: Boolean, height: Int? = null, avatar: androidx.compose.ui.unit.Dp = 72.dp, guest: Boolean = false) {
    val h = height ?: (LocalConfigurationHeight() / maxOf(1, rows)).coerceIn(140, 520)
    val cd = stringResource(R.string.p_cam_off)
    Box(Modifier.fillMaxWidth().height(h.dp).clip(RoundedCornerShape(12.dp)).background(Color.White.copy(alpha = 0.08f))
        .border(if (speaking) 3.dp else 0.dp, if (speaking) Color(0xFF3CCB7F) else Color.Transparent, RoundedCornerShape(12.dp)).testTag("callAvatarCell-$id")) {
        Box(Modifier.align(Alignment.Center)) { CallAvatar(id, data, label, size = avatar) }
        Row(Modifier.align(Alignment.BottomStart).padding(6.dp).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.VideocamOff, cd, tint = Color.White, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(4.dp))
            if (muted) { Icon(Icons.Filled.MicOff, stringResource(R.string.p_muted), tint = Color.White, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(4.dp)) }
            Text(label, color = Color.White, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (guest) GuestTag(Modifier.align(Alignment.TopStart).padding(6.dp))
    }
}

@Composable
internal fun VideoTile(t: CallManager.Tile, label: String, rows: Int, muted: Boolean = false, height: Int? = null, guest: Boolean = false) {
    val container = LocalContainer.current
    val h = height ?: (LocalConfigurationHeight() / maxOf(1, rows)).coerceIn(140, 520)
    Box(Modifier.fillMaxWidth().height(h.dp).clip(RoundedCornerShape(12.dp)).background(Color.Black).testTag("callTile-${t.tileId}")) {
        AndroidView(
            factory = { c -> DefaultVideoRenderView(c).apply { init(container.calls.egl); scalingType = VideoScalingType.AspectFill; mirror = t.local; container.calls.bind(t.tileId, this) } },
            onRelease = { view -> container.calls.unbind(t.tileId); view.release() },
            modifier = Modifier.fillMaxSize(),
        )
        Row(Modifier.align(Alignment.BottomStart).padding(6.dp).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (muted) { Icon(Icons.Filled.MicOff, stringResource(R.string.p_muted), tint = Color.White, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(4.dp)) }
            Text(label, color = Color.White, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (guest) GuestTag(Modifier.align(Alignment.TopStart).padding(6.dp))
    }
}

@Composable
private fun LocalConfigurationHeight(): Int = (androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp * 0.62f).toInt()

/** Antes de prender la transcripción: todos en la llamada lo verán, y opcionalmente el resumen con IA (mismo texto que la web). */
@Composable
fun TranscriptConsentDialog(onDismiss: () -> Unit, onConfirm: (aiSummary: Boolean) -> Unit) {
    var ai by rememberSaveable { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.call_transcript_on)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.call_consent_body))
                Row(Modifier.fillMaxWidth().clickable { ai = !ai }.testTag("callConsentAi"), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = ai, onCheckedChange = { ai = it })
                    Text(stringResource(R.string.call_consent_ai), style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(ai) }, modifier = Modifier.testTag("callConsentStart")) { Text(stringResource(R.string.call_transcript_start)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
        modifier = Modifier.testTag("callConsent"),
    )
}

/** Sumar personas a la llamada en curso: selector múltiple de mi lista, sin los que ya están o fueron agregados. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddToCallSheet(call: com.tiecoms.app.core.CallDTO, data: BootstrapDTO, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    var q by rememberSaveable { mutableStateOf("") }
    val picked = remember { mutableStateListOf<String>() }
    var busy by remember { mutableStateOf(false) }
    val list = Calls.addable(data.people, call, data.me.id, q)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), modifier = Modifier.testTag("callAddSheet")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 16.dp)) {
            Text(stringResource(R.string.call_add), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.call_add_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 6.dp))
            OutlinedTextField(q, { q = it }, Modifier.fillMaxWidth(), singleLine = true, leadingIcon = { Icon(Icons.Filled.Search, null) }, placeholder = { Text(stringResource(R.string.calls_search)) })
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp).padding(top = 6.dp)) {
                if (list.isEmpty()) item { EmptyNote(stringResource(R.string.call_add_none)) }
                items(list, key = { it.id }) { p ->
                    val on = p.id in picked
                    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable { if (on) picked.remove(p.id) else picked.add(p.id) }.testTag("callAdd-${p.id}"),
                        verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = on, onCheckedChange = null)
                        Spacer(Modifier.width(8.dp)); PersonAvatar(p, data, size = 32.dp); Spacer(Modifier.width(10.dp))
                        Text(p.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
                Button(enabled = picked.isNotEmpty() && !busy, onClick = {
                    busy = true
                    val ids = picked.toList()
                    container.scope.launch {
                        // Desde la pantalla de la llamada, la franja «En llamada en tu …» o «En curso ahora».
                        runCatching { if (container.calls.view.value?.call?.id == call.id) container.calls.invite(ids) else container.client.value.inviteToCall(call.id, ids) }
                            .onSuccess { container.toast(ctx.getString(R.string.call_added, ids.size)); onDismiss() }
                            .onFailure { busy = false; container.toast(errorText(ctx, it)) }
                    }
                }, modifier = Modifier.testTag("callAddSend")) { Text("📞 " + stringResource(R.string.call_add_send, picked.size)) }
            }
        }
    }
}

// ---------- Elegir conversación (para llamar o para compartir) ----------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickConversationSheet(title: String, onDismiss: () -> Unit, onPick: (ConversationDTO) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    var q by rememberSaveable { mutableStateOf("") }
    val needle = q.trim().lowercase()
    val list = data.conversations.filter { it.canPost && !it.isSide }.map { it to titleOf(ctx, it, data) }
        .filter { needle.isEmpty() || it.second.lowercase().contains(needle) }.take(60)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), modifier = Modifier.testTag("callPick")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() }.padding(bottom = 8.dp))
            OutlinedTextField(q, { q = it }, Modifier.fillMaxWidth().testTag("callPickSearch"), singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, null) }, placeholder = { Text(stringResource(R.string.calls_search)) })
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 460.dp).padding(top = 6.dp)) {
                items(list, key = { it.first.id }) { (c, name) ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable { onPick(c) }.padding(vertical = 6.dp).testTag("callPick-${c.id}"), verticalAlignment = Alignment.CenterVertically) {
                        ConvLeadAvatar(c, data, 36)
                        Spacer(Modifier.width(12.dp))
                        Text(name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (c.kind == "direct") stringResource(R.string.calls_direct) else stringResource(R.string.calls_group) + " · " + c.memberIds.size,
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun ConvLeadAvatar(c: ConversationDTO?, data: BootstrapDTO, size: Int, fallbackIds: List<String> = emptyList()) {
    val other = when {
        c?.kind == "direct" -> c.memberIds.firstOrNull { it != data.me.id }
        c == null && fallbackIds.size == 1 -> fallbackIds.first()
        else -> null
    }
    when {
        other != null -> PersonAvatar(Names.person(data, other), data, size = size.dp)
        c != null && c.avatarUrl != null -> Avatar(c.name ?: "#", MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant, size = size.dp, photo = c.avatarUrl)
        c != null -> StackedAvatars(c, data, size = size.dp)
        else -> Avatar("☏", MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant, size = size.dp)
    }
}

// ---------- Pestaña «Llamadas» ----------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallsScreen(onOpenDetail: (String) -> Unit, onOpenConversation: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    var items by remember { mutableStateOf<List<CallHistoryItemDTO>?>(null) }
    var more by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var picking by rememberSaveable { mutableStateOf<String?>(null) }
    var instant by rememberSaveable { mutableStateOf(false) }
    val launcher = rememberCallLauncher()
    // Recarga al cambiar alguna llamada en vivo (empezó, terminó, hay transcripción).
    LaunchedEffect(data.callsEnabled, st.callsRevision) {
        if (!data.callsEnabled) return@LaunchedEffect
        // Una recarga que se cancela porque llegó otra (callsRevision) no es un error.
        try { val it = client.callHistory(); items = it.calls; more = it.hasMore; error = null }
        catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = errorText(ctx, e) }
    }
    fun call(convId: String, kind: String) = launcher.launch(kind == "video") { cam -> container.calls.start(convId, if (cam) "video" else "audio") }
    // Llamadas perdidas: abrir la pestaña las marca vistas (0 aquí y POST /calls/seen); si llega `calls.missed` > 0
    // con la pestaña abierta, se vuelven a marcar. [opened] evita el doble POST al entrar con perdidas.
    var opened by remember { mutableStateOf(false) }
    LaunchedEffect(data.missedCalls) {
        if (!opened || data.missedCalls > 0) { opened = true; client.markCallsSeen() }
    }
    // 1.7.1: «En curso ahora» (GET /calls/active) arriba del historial.
    var active by remember { mutableStateOf<List<com.tiecoms.app.core.CallDTO>>(emptyList()) }
    var addingTo by remember { mutableStateOf<com.tiecoms.app.core.CallDTO?>(null) }
    val mine by container.calls.view.collectAsStateWithLifecycle()
    LaunchedEffect(data.callsEnabled, st.callsRevision) {
        if (data.callsEnabled) runCatching { client.activeCalls() }.onSuccess { active = it }
    }
    // Lo que llega en vivo manda: una que terminó sale; los datos nuevos (quién está) reemplazan.
    val liveNow = active.mapNotNull { c -> if (st.calls.containsKey(c.conversationId)) st.calls[c.conversationId]?.takeIf { it.id == c.id }?.let { it.copy(title = it.title ?: c.title) } else c }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.calls_title), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                actions = {
                    if (data.callsEnabled) {
                        IconButton(onClick = { picking = "video" }, modifier = Modifier.testTag("callsNewVideo")) { Icon(Icons.Filled.Videocam, stringResource(R.string.call_video)) }
                        Button(onClick = { picking = "audio" }, modifier = Modifier.padding(end = 8.dp).testTag("callsNew")) {
                            Icon(Icons.Filled.Call, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.calls_new))
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        // 1.7.6: «Nueva llamada» con enlace para invitados, a un toque.
        floatingActionButton = {
            if (data.callsEnabled) ExtendedFloatingActionButton(onClick = { instant = true }, icon = { Icon(Icons.Filled.Link, null) },
                text = { Text(stringResource(R.string.calls_instant), fontWeight = FontWeight.SemiBold) }, modifier = Modifier.testTag("callsInstant"))
        },
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize().testTag("callsList"), contentPadding = PaddingValues(bottom = 88.dp)) {
            if (!data.callsEnabled) item { EmptyNote(stringResource(R.string.err_calls_disabled)) }
            if (liveNow.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.calls_active), Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp).testTag("callsActiveHeader")) }
                items(liveNow, key = { "a:" + it.id }) { c ->
                    ActiveCallRow(c, data, inside = mine?.call?.id == c.id,
                        onJoin = { launcher.launch(false) { container.calls.join(c.id, false) } },
                        onAdd = { addingTo = c })
                }
                item { HorizontalDivider(Modifier.padding(top = 6.dp)) }
            }
            error?.let { e -> item { ErrorText(e) } }
            val list = items
            if (data.callsEnabled && list == null && error == null) item { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            if (data.callsEnabled && list != null && list.isEmpty()) item { EmptyNote(stringResource(R.string.calls_empty), Modifier.testTag("callsEmpty")) }
            items(list.orEmpty(), key = { it.call.id }) { x ->
                CallRow(x, data,
                    onOpen = { if (Calls.hasDetail(x)) onOpenDetail(x.call.id) else onOpenConversation(x.call.conversationId) },
                    onJoin = { launcher.launch(false) { container.calls.join(x.call.id, false) } },
                    onCallBack = { call(x.call.conversationId, x.call.kind) })
                HorizontalDivider(Modifier.padding(start = 70.dp))
            }
            if (more) item {
                TextButton(onClick = {
                    val last = items?.lastOrNull() ?: return@TextButton
                    container.scope.launch { runCatching { client.callHistory(last.call.startedAt) }.onSuccess { items = items.orEmpty() + it.calls; more = it.hasMore }.onFailure { container.toast(errorText(ctx, it)) } }
                }, modifier = Modifier.fillMaxWidth().testTag("callsMore")) { Text(stringResource(R.string.calls_more)) }
            }
        }
    }
    addingTo?.let { c -> AddToCallSheet(c, data, onDismiss = { addingTo = null }) }
    if (instant) InstantCallSheet(onDismiss = { instant = false })
    picking?.let { kind -> PickConversationSheet(stringResource(R.string.calls_pick), onDismiss = { picking = null }) { c -> picking = null; call(c.id, kind) } }
}

@Composable
private fun CallRow(item: CallHistoryItemDTO, data: BootstrapDTO, onOpen: () -> Unit, onJoin: () -> Unit, onCallBack: () -> Unit) {
    val ctx = LocalContext.current
    val c = item.call
    val me = data.me.id
    val conv = data.conversations.firstOrNull { it.id == c.conversationId }
    val others = item.participantIds.filter { it != me }
    val group = Calls.isGroup(item, conv, me)
    val name = conv?.let { titleOf(ctx, it, data) } ?: others.mapNotNull { Names.person(data, it)?.name ?: c.names[it] }.joinToString(", ")
    // «Perdida» (me sonó y no entré) va en rojo como etiqueta; «Sin respuesta» solo si no es mía y nadie más entró.
    val mine = Calls.isMissedByMe(item)
    val missed = mine || Calls.isMissed(item)
    val live = Calls.isLive(item)
    val who = if (group) others.take(3).map { firstName(data, it) }.filter { it.isNotEmpty() }.joinToString(", ") else ""
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 10.dp).testTag("callRow-${c.id}"), verticalAlignment = Alignment.CenterVertically) {
        ConvLeadAvatar(conv, data, 42, others)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(name.ifEmpty { stringResource(R.string.call_title) }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                CallTag(stringResource(if (group) R.string.calls_group else R.string.calls_direct))
                if (live) CallTag(stringResource(R.string.calls_live), live = true)
                if (mine) CallTag(stringResource(R.string.calls_missed_mine), missed = true)
            }
            val dur = item.durationSec?.takeIf { !missed }?.let { " · " + Calls.clock(it) } ?: ""
            Text((if (c.isVideo) "🎥 " else "📞 ") + dateTime(c.startedAt) + dur + (if (missed && !mine) " · " + stringResource(R.string.calls_missed) else "") + (if (who.isNotEmpty()) " · $who" else ""),
                style = MaterialTheme.typography.bodySmall, color = if (missed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (item.hasSummary || c.hasTranscript) Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (item.hasSummary) CallChip("✦ " + stringResource(R.string.call_summary))
                if (c.hasTranscript) CallChip("📝 " + stringResource(R.string.calls_share_transcript))
            }
        }
        if (live) Button(onClick = onJoin, contentPadding = PaddingValues(horizontal = 12.dp), modifier = Modifier.testTag("callRowJoin")) { Text(stringResource(R.string.call_join)) }
        else IconButton(onClick = onCallBack, modifier = Modifier.testTag("callRowBack")) {
            Icon(if (c.isVideo) Icons.Filled.Videocam else Icons.Filled.Call, stringResource(R.string.calls_call_back), tint = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun ActiveCallRow(c: com.tiecoms.app.core.CallDTO, data: BootstrapDTO, inside: Boolean, onJoin: () -> Unit, onAdd: () -> Unit) {
    val ctx = LocalContext.current
    val conv = data.conversations.firstOrNull { it.id == c.conversationId }
    val name = conv?.let { titleOf(ctx, it, data) } ?: c.title ?: c.activeUserIds.map { firstName(data, it, c) }.filter { it.isNotEmpty() }.joinToString(", ")
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("callActive-${c.id}"), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(8.dp).background(Color(0xFF3CCB7F), CircleShape))
                Text((if (c.isVideo) "🎥 " else "📞 ") + name.ifEmpty { stringResource(R.string.call_title) }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                c.activeUserIds.take(5).forEach { id -> Box(Modifier.padding(end = 2.dp)) { PersonAvatar(Names.person(data, id), data, size = 24.dp) } }
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.calls_active_in, c.activeUserIds.size), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // Agregar exige estar dentro (desde cualquiera de mis dispositivos); si no, primero Unirse.
        if (data.me.id in c.activeUserIds) OutlinedButton(onClick = onAdd, contentPadding = PaddingValues(horizontal = 10.dp), modifier = Modifier.padding(end = 6.dp).testTag("callActiveAdd")) {
            Icon(Icons.Filled.PersonAdd, null, Modifier.size(18.dp)); Spacer(Modifier.width(4.dp)); Text(stringResource(R.string.cc_add))
        }
        if (!inside) Button(onClick = onJoin, contentPadding = PaddingValues(horizontal = 12.dp), modifier = Modifier.testTag("callActiveJoin")) { Text(stringResource(R.string.call_join)) }
    }
}

@Composable
private fun CallTag(text: String, live: Boolean = false, missed: Boolean = false) {
    Text(text, Modifier.background(if (live) Color(0xFF1F7A4D) else if (missed) MissedRed else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 1.dp)
            .then(if (missed) Modifier.testTag("callMissedTag") else Modifier),
        style = MaterialTheme.typography.labelSmall, color = if (live || missed) Color.White else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
}

@Composable
private fun CallChip(text: String) {
    Text(text, Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

// ---------- Detalle: resumen, transcripción y compartir ----------
@Composable
fun CallDetailScreen(callId: String, onBack: () -> Unit, onOpenConversation: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data
    var detail by remember(callId) { mutableStateOf<CallTranscriptDTO?>(null) }
    var error by remember(callId) { mutableStateOf<String?>(null) }
    var tab by rememberSaveable(callId) { mutableStateOf<String?>(null) }
    var share by remember { mutableStateOf(false) }
    var sendWhat by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(callId) {
        runCatching { client.callTranscript(callId) }.onSuccess { detail = it; if (tab == null) tab = if (!it.summary.isNullOrBlank()) "summary" else "transcript" }
            .onFailure { error = errorText(ctx, it) }
    }
    fun speaker(s: com.tiecoms.app.core.CallTranscriptSegmentDTO) = s.speakerUserId?.let { Names.person(data, it)?.name } ?: s.speakerName ?: "?"
    fun text(d: CallTranscriptDTO, what: String) = Calls.asText(d, what, ctx.getString(R.string.call_summary), ctx.getString(R.string.call_transcript_title), ::speaker)
    SimpleScaffold(stringResource(R.string.call_transcript_title), onBack, actions = {
        if (detail != null) IconButton(onClick = { if (Calls.shareOptions(detail!!).isEmpty()) container.toast(ctx.getString(R.string.calls_no_content)) else share = true },
            modifier = Modifier.testTag("callShare")) { Icon(Icons.Filled.Share, stringResource(R.string.calls_share)) }
    }) {
        ErrorText(error)
        val d = detail
        if (d == null && error == null) Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        if (d != null) {
            val conv = data?.conversations?.firstOrNull { it.id == d.call.conversationId }
            Text((if (d.call.isVideo) "🎥 " else "📞 ") + listOfNotNull(conv?.let { titleOf(ctx, it, data) }, dateTime(d.call.startedAt)).joinToString(" · ") +
                (if (d.call.transcribing) " · " + stringResource(R.string.call_transcribing_short) else ""),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 16.dp).clickable(enabled = conv != null) { conv?.let { onOpenConversation(it.id) } }.testTag("callDetailHead"))
            PrimaryTabRow(selectedTabIndex = if (tab == "summary") 0 else 1, modifier = Modifier.padding(top = 8.dp)) {
                Tab(tab == "summary", onClick = { tab = "summary" }, text = { Text("✦ " + stringResource(R.string.call_summary)) }, modifier = Modifier.testTag("callTabSummary"))
                Tab(tab != "summary", onClick = { tab = "transcript" }, text = { Text("📝 " + stringResource(R.string.calls_share_transcript)) }, modifier = Modifier.testTag("callTabTranscript"))
            }
            Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (tab == "summary") {
                    if (d.summary.isNullOrBlank()) EmptyNote(stringResource(R.string.calls_no_summary), Modifier.testTag("callNoSummary"))
                    else Text(d.summary, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("callSummary"))
                } else {
                    if (d.segments.isEmpty()) EmptyNote(stringResource(R.string.call_transcript_empty))
                    d.segments.forEach { s ->
                        Text(androidx.compose.ui.text.buildAnnotatedString {
                            pushStyle(androidx.compose.ui.text.SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)); append(Calls.stamp(s.startMs) + "  "); pop()
                            pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.SemiBold)); append(speaker(s) + ": "); pop()
                            append(s.text)
                        }, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("callSegment"))
                    }
                }
            }
        }
    }
    val d = detail
    if (share && d != null) {
        val opts = Calls.shareOptions(d)
        fun byWhat(w: String): List<SheetItem> = listOf(
            SheetItem(ctx.getString(R.string.calls_share_chat), "💬", tag = "callShareChat-$w") { sendWhat = w },
            SheetItem(ctx.getString(R.string.calls_share_system), "↗", tag = "callShareSystem-$w") {
                val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, ctx.getString(R.string.call_transcript_title)).putExtra(Intent.EXTRA_TEXT, text(d, w))
                runCatching { ctx.startActivity(Intent.createChooser(i, ctx.getString(R.string.calls_share)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            },
            SheetItem(ctx.getString(R.string.call_copy), "⧉", tag = "callCopy-$w") { copyToClipboard(ctx, text(d, w)); container.toast(ctx.getString(R.string.call_copied)) },
        )
        fun whatLabel(w: String) = ctx.getString(when (w) { "summary" -> R.string.calls_share_summary; "transcript" -> R.string.calls_share_transcript; else -> R.string.calls_share_both })
        val items: List<SheetItem?> = if (opts.size == 1) byWhat(opts[0])
            else opts.map { w -> SheetItem(whatLabel(w), when (w) { "summary" -> "✦"; "transcript" -> "📝"; else -> "📋" }, tag = "callShareWhat-$w", children = byWhat(w)) }
        ActionSheet(if (opts.size == 1) stringResource(R.string.calls_share) else stringResource(R.string.calls_share_what), items) { share = false }
    }
    sendWhat?.let { w ->
        PickConversationSheet(stringResource(R.string.calls_pick_chat), onDismiss = { sendWhat = null }) { c ->
            sendWhat = null
            val name = data?.let { titleOf(ctx, c, it) } ?: ""
            container.scope.launch {
                runCatching { client.shareCall(callId, c.id, w) }.onSuccess { container.toast(ctx.getString(R.string.calls_shared, name)) }.onFailure { container.toast(errorText(ctx, it)) }
            }
        }
    }
}

/**
 * Con CAMERA declarado en el manifiesto (llamadas), Android exige ese permiso también para abrir la cámara del sistema
 * (ACTION_IMAGE_CAPTURE): sin él lanza SecurityException. Esto lo pide antes de tomar una foto.
 */
@Composable
fun rememberCameraGate(): (() -> Unit) -> Unit {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val p = pending
        pending = null
        if (ok) p?.invoke() else container.toast(ctx.getString(R.string.camera_perm_denied))
    }
    return remember(launcher) {
        { action ->
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) action()
            else { pending = action; launcher.launch(Manifest.permission.CAMERA) }
        }
    }
}
