package com.tiecoms.app.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.CallDTO
import com.tiecoms.app.core.GuestCalls
import com.tiecoms.app.core.InstantCalls

/*
 * 1.7.6: «Nueva llamada» rápida (pestaña Llamadas). Un toque abre la hoja; «Empezar» crea la llamada con enlace
 * (POST /calls/instant), entra y muestra «Comparte el enlace». Dentro de la llamada, 🔗 lo vuelve a abrir.
 */

/** Texto sugerido para compartir el enlace (es/en). */
fun instantShareText(ctx: Context, url: String): String = InstantCalls.shareText(ctx.getString(R.string.call_instant_share_text), url)

/** Abre el selector del sistema (WhatsApp, Gmail…) con el texto sugerido. */
fun shareCallLink(ctx: Context, url: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain")
        .putExtra(Intent.EXTRA_SUBJECT, ctx.getString(R.string.call_instant_share_subject))
        .putExtra(Intent.EXTRA_TEXT, instantShareText(ctx, url))
    val chooser = Intent.createChooser(send, ctx.getString(R.string.call_share_chooser))
    if (ctx !is android.app.Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { ctx.startActivity(chooser) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InstantCallSheet(onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val launcher = rememberCallLauncher()
    var title by rememberSaveable { mutableStateOf("") }
    var video by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun start() {
        if (busy) return
        error = null
        // Pide el micrófono (y la cámara en video); sin micrófono no llama a la acción y se puede volver a tocar.
        launcher.launch(video) { cam ->
            if (busy) return@launch
            busy = true
            try {
                container.calls.startInstant(title, cam)
                onDismiss()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = if (InstantCalls.unsupported(e)) ctx.getString(R.string.calls_instant_unsupported) else errorText(ctx, e)
            } finally { busy = false }
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), modifier = Modifier.testTag("instantSheet")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 20.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.calls_instant), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.calls_instant_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(title, { title = it.take(InstantCalls.TITLE_MAX) }, singleLine = true,
                label = { Text(stringResource(R.string.calls_instant_title_label)) },
                placeholder = { Text(stringResource(R.string.calls_instant_title_ph)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { start() }),
                modifier = Modifier.fillMaxWidth().testTag("instantTitle"))
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                SegmentedButton(selected = !video, onClick = { video = false }, shape = SegmentedButtonDefaults.itemShape(0, 2),
                    icon = { Icon(Icons.Filled.Call, null, Modifier.size(18.dp)) }, modifier = Modifier.testTag("instantVoice")) { Text(stringResource(R.string.calls_instant_voice)) }
                SegmentedButton(selected = video, onClick = { video = true }, shape = SegmentedButtonDefaults.itemShape(1, 2),
                    icon = { Icon(Icons.Filled.Videocam, null, Modifier.size(18.dp)) }, modifier = Modifier.testTag("instantVideo")) { Text(stringResource(R.string.calls_instant_video)) }
            }
            error?.let { e ->
                Text(e, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("instantError"))
            }
            Button(onClick = { start() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("instantStart")) {
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text(stringResource(R.string.calls_instant_start), fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** «Comparte el enlace»: el enlace, Copiar, Compartir… y los invitados que ya entraron (nombre y correo). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareCallLinkSheet(url: String, call: CallDTO, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val guests = call.guests.orEmpty()
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), modifier = Modifier.testTag("shareLinkSheet")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.call_share_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.call_share_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SelectionContainer {
                Text(url, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(12.dp).testTag("shareLinkUrl"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { copyToClipboard(ctx, url); container.toast(ctx.getString(R.string.call_share_copied)) },
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("shareLinkCopy")) {
                    Icon(Icons.Filled.ContentCopy, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.call_share_copy))
                }
                Button(onClick = { shareCallLink(ctx, url) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("shareLinkSend")) {
                    Icon(Icons.Filled.Share, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.call_share_send))
                }
            }
            HorizontalDivider()
            Text(stringResource(R.string.call_share_guests), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            if (guests.isEmpty()) Text(stringResource(R.string.call_share_no_guests), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("shareLinkNoGuests"))
            guests.forEach { g ->
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("shareLinkGuest-${g.id}"), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(g.name.ifBlank { stringResource(R.string.call_guest_badge) }, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        GuestCalls.guestEmail(call, GuestCalls.externalId(g.id))?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    Text(stringResource(R.string.call_guest_badge), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End).testTag("shareLinkDone")) { Text(stringResource(R.string.call_share_done)) }
        }
    }
}
