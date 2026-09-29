package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.zIndex
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.EventCards
import com.tiecoms.app.core.Names
import kotlinx.coroutines.launch
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Tarjeta del evento dentro del chat (EventChatCard de la web): reemplaza el aviso «Agendó…». Bloque de fecha con el
 * color del grupo, título que abre el detalle, día y hora (o «Todo el día»), «📹 Unirse» o «📍 lugar», quiénes van y,
 * si soy invitado y no está cancelado ni pasó, Asistiré · Tal vez · No asistiré con la respuesta actual resaltada.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EventChatCard(eventId: String, creatorId: String, data: BootstrapDTO, onOpen: (String) -> Unit,
                  /** Tanda 1.7: event.today («📅 ES HOY · 3:00 p. m.») o event.comments (franja de comentarios). */
                  sys: com.tiecoms.app.core.System17.Body? = null, canPost: Boolean = true, fallback: String? = null) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val ev = st.events[eventId]
    var missing by remember(eventId) { mutableStateOf(false) }
    // No está en memoria: GET /events/:id (sin acceso o borrado, no se muestra).
    LaunchedEffect(eventId, ev == null) {
        if (ev != null) return@LaunchedEffect
        runCatching { client.getEvent(eventId) }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; missing = true }
    }
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.9f).coerceAtMost(520f).dp
    if (ev == null) {
        if (!missing) Box(Modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.widthIn(max = maxW).fillMaxWidth().height(64.dp)) {}
        } else if (fallback != null) Text(fallback, style = MaterialTheme.typography.bodySmall, color = com.tiecoms.app.ui.theme.LocalChatColors.current.system, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp).testTag("system"))
        return
    }
    val (bg, fg) = eventColors(data, ev)
    val cancelled = ev.cancelledAt != null
    val past = EventCards.past(ev)
    val zone = ZoneId.systemDefault()
    val start = parseInstant(ev.startsAt)?.atZone(zone)
    val loc = Locale.getDefault()
    val es = loc.language == "es"
    val dayText = start?.format(DateTimeFormatter.ofPattern(if (es) "EEEE, d 'de' MMMM" else "EEEE, MMMM d", loc)) ?: ""
    fun hm(iso: String) = parseInstant(iso)?.atZone(zone)?.format(DateTimeFormatter.ofPattern("hh:mm a", loc)) ?: ""
    val timeText = if (EventCards.isAllDay(ev.startsAt, ev.endsAt, zone)) stringResource(R.string.cal_all_day) else "${hm(ev.startsAt)} – ${hm(ev.endsAt)}"
    val creator = Names.person(data, creatorId)?.name?.substringBefore(' ') ?: ""
    val mine = ev.invitees.firstOrNull { it.userId == data.me.id }
    fun answer(r: String) {
        container.scope.launch { runCatching { client.rsvp(ev.id, r) }.onFailure { container.toast(errorText(ctx, it)) } }
    }
    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, shadowElevation = 1.dp,
            modifier = Modifier.widthIn(max = maxW).fillMaxWidth().alpha(if (cancelled) 0.6f else if (past) 0.8f else 1f).testTag("eventChatCard-${ev.id}")) {
            // Borde izquierdo dibujado detrás (sin medidas intrínsecas: los FlowRow que saltan de línea se miden bien).
            Row(Modifier.drawBehind { drawRect(fg, size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height)) }) {
                Column(Modifier.padding(start = 14.dp, end = 12.dp, top = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (sys?.key == "event.today") Text("📅 " + stringResource(R.string.card_today, hm(ev.startsAt)), style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("eventCardToday"))
                    else Text("📅 " + (stringResource(R.string.ev_card, creator) + if (cancelled) " · " + stringResource(R.string.cal_cancelled) else "").uppercase(),
                        style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.size(width = 46.dp, height = 50.dp).background(bg, RoundedCornerShape(10.dp)), horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center) {
                            Text(start?.format(DateTimeFormatter.ofPattern("MMM", loc))?.replace(".", "")?.uppercase() ?: "", color = fg, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            Text(start?.dayOfMonth?.toString() ?: "", color = fg, fontSize = 20.sp, fontWeight = FontWeight.Bold, lineHeight = 22.sp)
                        }
                        Column(Modifier.padding(start = 12.dp).weight(1f)) {
                            Text(ev.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, maxLines = 3, overflow = TextOverflow.Ellipsis,
                                textDecoration = if (cancelled) TextDecoration.LineThrough else null,
                                modifier = Modifier.clickable { onOpen(ev.id) }.padding(vertical = 2.dp).testTag("eventCardTitle"))
                            Text("$dayText · $timeText", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("eventCardWhen"))
                        }
                    }
                    ev.location?.trim()?.takeIf { it.isNotEmpty() }?.let { l ->
                        if (com.tiecoms.app.core.Meetings.isVideoLink(l)) Button(onClick = { openExternal(ctx, l) }, contentPadding = ButtonDefaults.ButtonWithIconContentPadding,
                            modifier = Modifier.heightIn(min = 40.dp).testTag("eventCardJoin")) { Text("📹 " + stringResource(R.string.cal_join)) }
                        else Text("📍 $l", style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (ev.invitees.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                        val shown = ev.invitees.take(5)
                        Box(Modifier.width((22 + (shown.size - 1) * 12).dp).height(22.dp)) {
                            shown.forEachIndexed { k, i ->
                                Box(Modifier.offset(x = (k * 12).dp).zIndex((5 - k).toFloat()).border(1.5.dp, MaterialTheme.colorScheme.surfaceContainerLow, CircleShape)) {
                                    AuthorAvatar(Names.person(data, i.userId), i.userId, 22.dp)
                                }
                            }
                        }
                        Text(stringResource(R.string.ev_card_going, EventCards.going(ev), ev.invitees.size), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp).testTag("eventCardGoing"))
                    }
                    if (sys?.key == "event.comments") CommentsStrip(sys, data)
                    EventCommentsBlock(ev, data, canPost, startOpen = sys?.key == "event.comments")
                    if (mine != null && EventCards.canRsvp(ev, data.me.id)) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("yes", "maybe", "no").forEach { r ->
                            val label = rsvpIcon(r) + " " + rsvpLabel(ctx, r)
                            if (mine.rsvp == r) Button(onClick = { answer(r) }, modifier = Modifier.heightIn(min = 40.dp).testTag("eventRsvp-$r"),
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.onSurface, contentColor = MaterialTheme.colorScheme.surface)) { Text(label) }
                            else OutlinedButton(onClick = { answer(r) }, modifier = Modifier.heightIn(min = 40.dp).testTag("eventRsvp-$r")) { Text(label) }
                        }
                    }
                }
            }
        }
    }
}

/** Abre un enlace de reunión (Meet, Teams o Zoom) en su app o el navegador. */
private fun openExternal(ctx: android.content.Context, url: String) {
    runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
}
