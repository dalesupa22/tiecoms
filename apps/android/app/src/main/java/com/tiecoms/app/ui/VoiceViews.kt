package com.tiecoms.app.ui

import androidx.compose.foundation.gestures.detectHorizontalDragGestures

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.Waveform
import com.tiecoms.app.platform.VoicePlayer
import kotlinx.coroutines.launch

/** Notas de voz de la conversación en orden (para seguir con la siguiente al terminar una). */
val LocalVoiceQueue = staticCompositionLocalOf<(String) -> List<AttachmentDTO>> { { emptyList() } }

private fun AttachmentDTO.asItem(url: String) = VoicePlayer.Item(id, url, durationMs ?: 0)

/** Burbuja de voz: play/pausa, onda con progreso (tocar para saltar), duración, velocidad y la transcripción plegable. */
@Composable
fun VoiceBubble(a: AttachmentDTO, fg: Color, mine: Boolean, onCreateIssue: ((String) -> Unit)? = {}) {
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val st by container.voice.state.collectAsStateWithLifecycle()
    val listened by container.voice.listened.collectAsStateWithLifecycle()
    val queueOf = LocalVoiceQueue.current
    val current = st.currentId == a.id
    val dur = if (current && st.durationMs > 0) st.durationMs else a.durationMs ?: 0
    val progress = if (current && dur > 0) (st.positionMs.toFloat() / dur).coerceIn(0f, 1f) else 0f
    var open by rememberSaveable(a.id) { mutableStateOf(false) }
    var askAiConsent by remember(a.id) { mutableStateOf(false) }
    if (askAiConsent) AiConsentDialog(voice = true,
        onAllow = {
            askAiConsent = false
            scope.launch { runCatching { client.retranscribe(a.id, aiConsent = true) }.onFailure { container.toast(errorText(ctx, it)) } }
        }, onWithoutAi = { askAiConsent = false }, onDismiss = { askAiConsent = false })
    val playLabel = stringResource(if (current && st.playing) R.string.voice_pause else R.string.voice_play)
    fun play(at: Float? = null) = scope.launch {
        val url = client.mediaUrl(a.url) ?: return@launch
        val token = client.bearer() ?: return@launch
        val next = queueOf(a.id).mapNotNull { n -> client.mediaUrl(n.url)?.let { n.asItem(it) } }
        container.voice.play(a.asItem(url), next, token, at)
    }
    // Arrastrar la onda: la posición se muestra mientras se arrastra y se salta al soltar.
    var dragFraction by remember(a.id) { mutableStateOf<Float?>(null) }
    Column(Modifier.widthIn(min = 220.dp, max = 280.dp).padding(bottom = 4.dp).testTag("voice-${a.id}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FilledIconButton(onClick = { play() }, modifier = Modifier.size(40.dp).semantics { contentDescription = playLabel }.testTag("voicePlay-${a.id}"),
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = fg.copy(alpha = 0.18f), contentColor = fg)) {
                Icon(if (current && st.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, null)
            }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                WaveBars(a.waveform.orEmpty(), dragFraction ?: progress, fg, Modifier.fillMaxWidth().height(28.dp)
                    .pointerInput(a.id, current) { detectTapGestures { o -> val f = (o.x / size.width).coerceIn(0f, 1f); if (current) container.voice.seek(f) else play(f) } }
                    .pointerInput(a.id, current) {
                        detectHorizontalDragGestures(
                            onDragStart = { o -> dragFraction = (o.x / size.width).coerceIn(0f, 1f) },
                            onDragEnd = { dragFraction?.let { f -> if (current) container.voice.seek(f) else play(f) }; dragFraction = null },
                            onDragCancel = { dragFraction = null },
                        ) { c, _ -> dragFraction = (c.position.x / size.width).coerceIn(0f, 1f) }
                    }.testTag("voiceWave-${a.id}"))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(Waveform.clock(dragFraction?.let { (dur * it).toLong() } ?: if (current) st.positionMs else dur), color = fg.copy(alpha = 0.8f), style = MaterialTheme.typography.labelSmall, modifier = Modifier.testTag("voiceTime-${a.id}"))
                    val unheard = stringResource(R.string.voice_unheard)
                    if (!mine && a.id !in listened) Box(Modifier.padding(start = 6.dp).size(6.dp).background(MaterialTheme.colorScheme.primary, CircleShape).semantics { contentDescription = unheard })
                }
            }
            val speedLabel = stringResource(R.string.voice_speed)
            TextButton(onClick = { container.voice.cycleSpeed() }, modifier = Modifier.semantics { contentDescription = "$speedLabel ${st.speed}×" }.testTag("voiceSpeed-${a.id}")) {
                Text((if (st.speed == 1.5f) "1,5" else st.speed.toInt().toString()) + "×", color = fg, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
            }
        }
        val t = a.transcript
        when (t?.status) {
            "pending" -> Text(stringResource(R.string.voice_transcribing), color = fg.copy(alpha = 0.7f), style = MaterialTheme.typography.labelSmall, modifier = Modifier.testTag("voicePending"))
            "failed" -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.voice_failed), color = fg.copy(alpha = 0.7f), style = MaterialTheme.typography.labelSmall)
                TextButton(onClick = { askAiConsent = true }) {
                    Text(stringResource(R.string.voice_retry), color = fg, style = MaterialTheme.typography.labelSmall)
                }
            }
            "done" -> {
                t.summary?.takeIf { it.isNotBlank() }?.let { Text("✦ $it", color = fg, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 2.dp).testTag("voiceSummary")) }
                if (!t.text.isNullOrBlank()) {
                    TextButton(onClick = { open = !open }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp), modifier = Modifier.heightIn(min = 32.dp).testTag("voiceTranscriptToggle")) {
                        Text(stringResource(if (open) R.string.voice_hide_transcript else R.string.voice_show_transcript), color = fg, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    }
                    if (open) {
                        SelectionContainer { Text(t.text, color = fg, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("voiceTranscript")) }
                        val clip = androidx.compose.ui.platform.LocalClipboardManager.current
                        TextButton(onClick = { clip.setText(androidx.compose.ui.text.AnnotatedString(t.text)); container.toast(ctx.getString(R.string.voice_copied)) },
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(stringResource(R.string.voice_copy), color = fg, style = MaterialTheme.typography.labelSmall) }
                    }
                }
                if (onCreateIssue != null) t.suggestedIssue?.takeIf { it.isNotBlank() }?.let { s ->
                    Surface(onClick = { onCreateIssue(s) }, shape = RoundedCornerShape(12.dp), color = fg.copy(alpha = 0.14f), modifier = Modifier.padding(top = 4.dp).testTag("voiceIssue")) {
                        Text("◆ " + stringResource(R.string.voice_create_issue, s), color = fg, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
                    }
                }
            }
            else -> Unit
        }
    }
}

@Composable
fun WaveBars(levels: List<Float>, progress: Float, color: Color, modifier: Modifier) {
    val bars = levels.ifEmpty { List(32) { 0.25f } }
    Canvas(modifier) {
        val n = bars.size
        val gap = 2.dp.toPx()
        val w = ((size.width - gap * (n - 1)) / n).coerceAtLeast(1.5f)
        bars.forEachIndexed { i, v ->
            val h = (size.height * (0.15f + 0.85f * v.coerceIn(0f, 1f)))
            val x = i * (w + gap)
            drawRoundRect(if ((i + 0.5f) / n <= progress) color else color.copy(alpha = 0.35f), Offset(x, (size.height - h) / 2), Size(w, h), CornerRadius(w / 2))
        }
    }
}

/**
 * Micrófono del compositor (vacío): mantener pulsado graba, soltar envía, deslizar a la izquierda cancela, arriba bloquea.
 * Un toque rápido (soltar antes de [com.tiecoms.app.core.VoiceRules.TAP_MS]) también bloquea: sigue grabando manos libres.
 * [onStart] devuelve false si no hay permiso (entonces se pide y no graba).
 */
@Composable
fun MicButton(onStart: () -> Boolean, onRelease: (heldMs: Long) -> Unit, onCancel: () -> Unit, onLock: () -> Unit, onDrag: (Waveform.Gesture) -> Unit, modifier: Modifier = Modifier) {
    val haptic = LocalHapticFeedback.current
    val density = LocalDensity.current
    val label = stringResource(R.string.voice_record)
    Box(modifier.size(52.dp).background(MaterialTheme.colorScheme.primary, CircleShape)
        .semantics { contentDescription = label; onLongClick(label) { onStart().also { if (it) onLock() } } }
        .pointerInput(Unit) {
            awaitEachGesture {
                val down = awaitFirstDown()
                if (!onStart()) return@awaitEachGesture
                val downAt = down.uptimeMillis
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                while (true) {
                    val ev = awaitPointerEvent()
                    val c = ev.changes.firstOrNull { it.id == down.id } ?: break
                    val d = c.position - down.position
                    val g = with(density) { Waveform.gesture(d.x.toDp().value, d.y.toDp().value) }
                    onDrag(g)
                    when {
                        g == Waveform.Gesture.CANCEL -> { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onCancel(); break }
                        g == Waveform.Gesture.LOCK -> { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onLock(); break }
                        !c.pressed -> { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onRelease(c.uptimeMillis - downAt); break }
                    }
                    c.consume()
                }
            }
        }.testTag("mic"), contentAlignment = Alignment.Center) {
        Icon(Icons.Filled.Mic, null, tint = MaterialTheme.colorScheme.onPrimary)
    }
}

/** Barra mientras se graba: punto rojo, contador y onda en vivo; bloqueada, con Borrar y Enviar. */
@Composable
fun RecordingBar(st: com.tiecoms.app.platform.VoiceRecorder.State, locked: Boolean, gesture: Waveform.Gesture, onDelete: () -> Unit, onSend: () -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.heightIn(min = 52.dp).testTag("recordingBar"), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).background(if (st.paused) MaterialTheme.colorScheme.outline else Color(0xFFD93025), CircleShape))
        Spacer(Modifier.width(8.dp))
        Column {
            Text(Waveform.clock(st.elapsedMs), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("recordingTime"))
            if (locked) Text(stringResource(R.string.voice_locked), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(8.dp))
        WaveBars(st.levels.map { (it * 3f).coerceAtMost(1f) }, 1f, MaterialTheme.colorScheme.primary, Modifier.weight(1f).height(26.dp))
        Spacer(Modifier.width(8.dp))
        if (locked) {
            IconButton(onClick = onDelete, modifier = Modifier.testTag("recordDelete")) { Icon(Icons.Filled.Delete, stringResource(R.string.voice_delete), tint = MaterialTheme.colorScheme.error) }
            FilledIconButton(onClick = onSend, modifier = Modifier.size(52.dp).testTag("recordSend")) { Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.voice_send)) }
        } else {
            Column(horizontalAlignment = Alignment.End) {
                Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Filled.Lock, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(" ↑", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Text(stringResource(if (gesture == Waveform.Gesture.CANCEL) R.string.voice_delete else R.string.voice_slide_cancel), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** Nota grabada sin enviar: duración, el motivo si falló, Reintentar (o Enviar) y Borrar. */
@Composable
fun VoiceDraftBar(d: com.tiecoms.app.platform.VoiceDrafts.Draft, busy: Boolean, onRetry: () -> Unit, onDelete: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(start = 16.dp, end = 4.dp).heightIn(min = 52.dp).testTag("voiceDraft"),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Mic, null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.voice_draft, Waveform.clock(d.result.durationMs)), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            d.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("voiceDraftError")) }
        }
        IconButton(onClick = onDelete, enabled = !busy, modifier = Modifier.testTag("voiceDraftDelete")) { Icon(Icons.Filled.Delete, stringResource(R.string.voice_delete), tint = MaterialTheme.colorScheme.error) }
        TextButton(onClick = onRetry, enabled = !busy, modifier = Modifier.testTag("voiceDraftRetry")) {
            Text(stringResource(if (d.error != null) R.string.voice_retry_send else R.string.voice_send), fontWeight = FontWeight.SemiBold)
        }
    }
}
