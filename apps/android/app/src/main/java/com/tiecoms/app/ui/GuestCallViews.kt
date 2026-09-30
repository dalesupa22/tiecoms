package com.tiecoms.app.ui

import android.Manifest
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.GuestCallPreviewDTO
import com.tiecoms.app.core.GuestCalls
import com.tiecoms.app.platform.CallManager
import kotlinx.coroutines.launch

/*
 * 1.7.4 — Entrar a una llamada con un enlace de invitado (docs/LLAMADAS.md › «Invitados por enlace»;
 * referencia: apps/web/src/screens/GuestCall.tsx). Funciona con o sin sesión: va encima de toda la app (AppRoot).
 */

/** Pantalla «Entrar a la llamada» (enlace abierto) y la llamada como invitado (grande o en su pastilla). */
@Composable
fun GuestCallHost() {
    val container = LocalContainer.current
    val ctx = LocalContext.current
    val token by container.guestLink.collectAsStateWithLifecycle()
    val view by container.calls.view.collectAsStateWithLifecycle()
    val outcome by container.calls.guestOutcome.collectAsStateWithLifecycle()
    val v = view?.takeIf { it.guest != null }
    // Terminó mientras estaba minimizada (sin la pantalla del enlace abierta): se avisa y se olvida.
    LaunchedEffect(outcome, token) {
        val o = outcome ?: return@LaunchedEffect
        if (token == null) {
            if (o.end == CallManager.GuestEnd.ENDED) container.toast(ctx.getString(R.string.guest_ended))
            container.calls.clearGuestOutcome()
        }
    }
    when {
        v != null && v.expanded -> GuestInCall(v, onMinimize = { container.calls.setExpanded(false); container.guestLink.value = null })
        token != null -> GuestLobby(token!!, onClose = { container.guestLink.value = null; container.calls.clearGuestOutcome() })
        v != null -> Box(Modifier.fillMaxSize()) { CallPill(v, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 6.dp)) }
    }
}

@Composable
private fun GuestLobby(token: String, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val view by container.calls.view.collectAsStateWithLifecycle()
    val outcome by container.calls.guestOutcome.collectAsStateWithLifecycle()
    val after = outcome?.takeIf { it.token == token }?.end
    val scope = rememberCoroutineScope()
    val launcher = rememberCallLauncher()
    var info by remember(token) { mutableStateOf<GuestCallPreviewDTO?>(null) }
    var problem by remember(token) { mutableStateOf<GuestCalls.Problem?>(null) }
    var otherError by remember(token) { mutableStateOf<String?>(null) }
    var loading by remember(token) { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var confirmSwitch by remember { mutableStateOf<Boolean?>(null) }
    // Nombre: el que usé la última vez o, con sesión, el de mi perfil.
    var name by rememberSaveable(token) { mutableStateOf(container.settings.guestName ?: st.data?.me?.name ?: "") }
    // 1.7.6: el correo (la web pide nombre y correo); se recuerda como el nombre.
    var email by rememberSaveable(token) { mutableStateOf(container.settings.guestEmail ?: st.data?.me?.email ?: "") }
    val profileName = st.data?.me?.name
    LaunchedEffect(profileName) { if (name.isBlank() && !profileName.isNullOrBlank()) name = profileName }

    fun load() {
        loading = true; otherError = null
        scope.launch {
            try { info = client.guestCallPreview(token); problem = null }
            catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                val p = GuestCalls.problemOf(e)
                problem = p
                if (p == GuestCalls.Problem.OTHER || p == GuestCalls.Problem.FULL) otherError = errorText(ctx, e)
            } finally { loading = false }
        }
    }
    LaunchedEffect(token) { load() }
    // Salí o terminó: se vuelve a preguntar al servidor (el enlace muere cuando la llamada termina).
    LaunchedEffect(after) { if (after != null) load() }

    fun doJoin(video: Boolean) {
        val n = GuestCalls.cleanName(name) ?: return
        val mail = GuestCalls.cleanEmail(email) ?: return
        container.settings.guestName = n
        container.settings.guestEmail = mail
        launcher.launch(video) { cam ->
            busy = true
            try { container.calls.joinAsGuest(token, n, cam, mail) }
            catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                when (GuestCalls.problemOf(e)) {
                    GuestCalls.Problem.INVALID -> problem = GuestCalls.Problem.INVALID
                    GuestCalls.Problem.ENDED -> problem = GuestCalls.Problem.ENDED
                    GuestCalls.Problem.NOT_LIVE -> info = info?.copy(active = false)
                    GuestCalls.Problem.FULL -> container.toast(ctx.getString(R.string.guest_full))
                    GuestCalls.Problem.OTHER -> throw e
                }
            } finally { busy = false }
        }
    }
    fun join(video: Boolean) {
        if (GuestCalls.cleanName(name) == null || GuestCalls.cleanEmail(email) == null || busy) return
        // Ya estoy en otra llamada: se pregunta antes de salir de ella.
        val cur = view
        if (cur != null && cur.guest?.token != token) confirmSwitch = video else doJoin(video)
    }

    BackHandler { onClose() }
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize().testTag("guestLobby")) {
        Box(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopStart).padding(4.dp).testTag("guestClose")) {
                Icon(Icons.Filled.Close, stringResource(R.string.guest_close))
            }
            Column(Modifier.align(Alignment.Center).widthIn(max = 480.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 48.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Logo(Modifier.widthIn(max = 180.dp).fillMaxWidth(0.5f))
                if (after != null) Text(stringResource(if (after == CallManager.GuestEnd.LEFT) R.string.guest_left else R.string.guest_ended),
                    fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("guestAfter"))
                val i = info
                when {
                    problem == GuestCalls.Problem.INVALID -> GuestMessage(stringResource(R.string.guest_invalid), "guestInvalid")
                    problem == GuestCalls.Problem.ENDED -> if (after == null) GuestMessage(stringResource(R.string.guest_ended), "guestEnded")
                    problem != null && i == null -> {
                        GuestMessage(otherError ?: stringResource(R.string.err_generic), "guestError")
                        OutlinedButton(onClick = { load() }, enabled = !loading, modifier = Modifier.testTag("guestRetry")) { Text(stringResource(R.string.retry)) }
                    }
                    i == null -> CircularProgressIndicator(Modifier.testTag("guestLoading"))
                    else -> {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(i.title ?: stringResource(R.string.guest_title), style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center,
                                modifier = Modifier.semantics { heading() }.testTag("guestTitle"))
                            val by = if (!i.orgName.isNullOrBlank()) stringResource(R.string.guest_by_org, i.hostName, i.orgName) else stringResource(R.string.guest_by, i.hostName)
                            Text(by, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                        }
                        if (!i.active) {
                            GuestMessage(stringResource(R.string.guest_not_live), "guestNotLive")
                            OutlinedButton(onClick = { load() }, enabled = !loading, modifier = Modifier.testTag("guestRetry")) { Text(stringResource(R.string.guest_retry)) }
                        } else {
                            OutlinedTextField(name, { name = it.take(GuestCalls.NAME_MAX) }, singleLine = true, label = { Text(stringResource(R.string.guest_name)) },
                                placeholder = { Text(stringResource(R.string.guest_name_ph)) },
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
                                modifier = Modifier.fillMaxWidth().testTag("guestName"))
                            val badEmail = email.isNotBlank() && GuestCalls.cleanEmail(email) == null
                            OutlinedTextField(email, { email = it.take(GuestCalls.EMAIL_MAX) }, singleLine = true, label = { Text(stringResource(R.string.guest_email)) },
                                placeholder = { Text(stringResource(R.string.guest_email_ph)) }, isError = badEmail,
                                supportingText = if (badEmail) { { Text(stringResource(R.string.guest_email_bad)) } } else null,
                                keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Email, imeAction = ImeAction.Done),
                                keyboardActions = KeyboardActions(onDone = { join(i.kind == "video") }),
                                modifier = Modifier.fillMaxWidth().testTag("guestEmail"))
                            val ok = GuestCalls.cleanName(name) != null && GuestCalls.cleanEmail(email) != null && !busy
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = { join(false) }, enabled = ok, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("guestJoinAudio")) {
                                    Text("📞 " + stringResource(R.string.guest_join_audio), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                Button(onClick = { join(true) }, enabled = ok, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("guestJoinVideo")) {
                                    Text("🎥 " + stringResource(R.string.guest_join_video), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                            Text(stringResource(R.string.guest_privacy), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                        }
                    }
                }
                Text(stringResource(R.string.guest_powered), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
        }
    }
    confirmSwitch?.let { video ->
        AlertDialog(
            onDismissRequest = { confirmSwitch = null },
            title = { Text(stringResource(R.string.guest_switch_title)) },
            text = { Text(stringResource(R.string.guest_switch_body)) },
            confirmButton = { TextButton(onClick = { confirmSwitch = null; doJoin(video) }, modifier = Modifier.testTag("guestSwitchYes")) { Text(stringResource(R.string.guest_switch_yes)) } },
            dismissButton = { TextButton(onClick = { confirmSwitch = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun GuestMessage(text: String, tag: String) {
    Text(text, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag(tag))
}

/** La llamada como invitado: recuadros, pantallas compartidas, silenciar, cámara, salida de audio y colgar. */
@Composable
private fun GuestInCall(v: CallManager.View, onMinimize: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val g = v.guest ?: return
    val me = g.externalId
    val people = (listOf(me) + GuestCalls.people(v.call).filter { it != me }).distinct()
    val you = stringResource(R.string.call_you)
    val nameOf: (String?) -> String = { id ->
        when {
            id == null -> ""
            id == me -> you
            else -> (GuestCalls.guestName(v.call, id) ?: v.call.names[id] ?: com.tiecoms.app.core.Names.person(st.data, id)?.name ?: "").substringBefore(' ')
        }
    }
    val clock = rememberClock(v.call.startedAt)
    var routes by remember { mutableStateOf(false) }
    var screenFull by remember { mutableStateOf<Int?>(null) }
    val full = screenFull?.takeIf { id -> v.screens.any { it.tileId == id } }
    val cameraPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) container.calls.toggleCamera() else container.toast(ctx.getString(R.string.call_perm_camera_denied))
    }
    BackHandler { if (full != null) screenFull = null else onMinimize() }
    Surface(color = CallBg, contentColor = CallInk, modifier = Modifier.fillMaxSize().testTag("guestCallScreen")) {
        Column(Modifier.fillMaxSize().then(if (full != null) Modifier else Modifier.safeDrawingPadding())) {
            if (full == null) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onMinimize, modifier = Modifier.testTag("callMinimize")) {
                        Icon(Icons.Filled.KeyboardArrowDown, stringResource(R.string.call_minimize), tint = CallInk)
                    }
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.guest_in_call, people.size), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.semantics { heading() }.testTag("guestCount"))
                        Text(if (v.phase == CallManager.Phase.CONNECTING) stringResource(R.string.call_connecting) else clock, style = MaterialTheme.typography.bodySmall,
                            color = CallInk.copy(alpha = 0.7f), modifier = Modifier.testTag("callClock"))
                    }
                    Box(Modifier.padding(end = 12.dp).size(10.dp).background(if (v.phase == CallManager.Phase.LIVE) Color(0xFF3CCB7F) else Color(0xFFBDB5AE), CircleShape))
                }
                CallNotices(v)
            }
            Box(Modifier.weight(1f).fillMaxWidth().padding(if (full != null) 0.dp else 8.dp)) {
                CallStage(v, people, me, st.data, nameOf, full, onFull = { screenFull = it }, waiting = people.size <= 1)
            }
            if (full == null) {
                CallCaptions(v, me, nameOf)
                androidx.compose.foundation.layout.FlowRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp).testTag("callControls"),
                    horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MediaControls(v, onRoutes = { routes = true }, onCameraPermission = { cameraPerm.launch(Manifest.permission.CAMERA) })
                }
                HangUpButton { container.scope.launch { container.calls.hangUp() } }
            }
        }
    }
    if (routes) AudioRouteSheet(v, onDismiss = { routes = false })
}
