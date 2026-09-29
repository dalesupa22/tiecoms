package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.IssueEventDTO
import com.tiecoms.app.core.Names
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Tarjeta de la tarea dentro del chat (IssueChatCard de la web, docs/TEMAS.md «Tarjeta de tarea en el chat»).
 * Reemplaza el aviso «Creó la tarea…»: se completa o reabre con la casilla, el título abre el detalle, muestra
 * responsable, fecha, estado, los 2 últimos comentarios y un campo para comentar ahí mismo (si no está cerrada).
 * Borde izquierdo naranja; rojo si está vencida y verde (título tachado) si está hecha.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun IssueChatCard(issueId: String, creatorId: String, data: BootstrapDTO, canPost: Boolean, onOpen: (String) -> Unit,
                  /** Tanda 1.7: issue.done (verde), issue.overdue (rojo, carita triste y acciones) o issue.comments (franja). */
                  sys: com.tiecoms.app.core.System17.Body? = null,
                  /** Llegó en vivo con el chat a la vista: la carita triste se anima una vez. */
                  animate: Boolean = false,
                  /** Sin acceso a la tarea: el texto del aviso. */
                  fallback: String? = null) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    val st by client.state.collectAsStateWithLifecycle()
    val i = st.issues[issueId]
    var comments by remember(issueId) { mutableStateOf(listOf<IssueEventDTO>()) }
    var missing by remember(issueId) { mutableStateOf(false) }
    var text by remember(issueId) { mutableStateOf("") }
    var busy by remember(issueId) { mutableStateOf(false) }
    // El detalle solo si hace falta: la tarea no está en memoria o tiene comentarios que mostrar.
    LaunchedEffect(issueId, i?.commentCount ?: -1) {
        if (i != null && i.commentCount == 0) { comments = emptyList(); return@LaunchedEffect }
        runCatching { client.issueDetail(issueId) }
            .onSuccess { r -> comments = r.events.filter { it.kind == "comment" }.takeLast(2) }
            .onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; missing = true }
    }
    val toggle = rememberIssueToggle()
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.9f).coerceAtMost(520f).dp
    if (i == null) {
        // Sin acceso (restringida) o borrada: no se muestra nada; mientras carga, un marcador.
        if (!missing) Box(Modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.widthIn(max = maxW).fillMaxWidth().height(56.dp)) {}
        } else if (fallback != null) Text(fallback, style = MaterialTheme.typography.bodySmall, color = com.tiecoms.app.ui.theme.LocalChatColors.current.system, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp).testTag("system"))
        return
    }
    val f = issueFlags(i)
    val done = i.status == "done"
    val edge = when {
        sys?.key == "issue.done" || done -> Color(0xFF15803D)
        sys?.key == "issue.overdue" || f.overdue -> MaterialTheme.colorScheme.error
        else -> Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE)
    }
    val tint = when (sys?.key) { "issue.done" -> Color(0xFF15803D).copy(alpha = 0.08f); "issue.overdue" -> MaterialTheme.colorScheme.error.copy(alpha = 0.07f); else -> Color.Transparent }
    val owner = i.ownerId?.let { Names.person(data, it) }
    val creator = Names.person(data, creatorId)?.name?.substringBefore(' ') ?: ""
    val topic = i.topicId?.let { tid -> st.topics[i.conversationId ?: ""]?.firstOrNull { it.id == tid } }
    fun send() {
        val body = text.trim()
        if (body.isEmpty() || busy) return
        busy = true
        container.scope.launch {
            try { client.commentIssue(i.id, body); text = "" } catch (e: Exception) { snackbar.showSnackbar(errorText(ctx, e)) } finally { busy = false }
        }
    }
    fun removeTopic() {
        val prev = i.topicId ?: return
        container.scope.launch {
            try {
                client.setIssueTopic(i.id, null)
                val r = snackbar.showSnackbar(ctx.getString(R.string.topic_untagged_task), actionLabel = ctx.getString(R.string.undo), duration = SnackbarDuration.Short)
                if (r == SnackbarResult.ActionPerformed) runCatching { client.setIssueTopic(i.id, prev) }
            } catch (e: Exception) { snackbar.showSnackbar(topicError(ctx, e)) }
        }
    }
    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, shadowElevation = 1.dp,
            modifier = Modifier.widthIn(max = maxW).fillMaxWidth().testTag("taskCard-${i.id}")) {
            // Borde izquierdo dibujado detrás (sin medidas intrínsecas: los FlowRow que saltan de línea se miden bien).
            Row(Modifier.background(tint).drawBehind { drawRect(edge, size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height)) }) {
                Column(Modifier.padding(start = 14.dp, end = 12.dp, top = 8.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    when (sys?.key) {
                        "issue.done" -> Text("✅ " + stringResource(R.string.card_done, sys.byName ?: ""), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold,
                            color = Color(0xFF15803D), modifier = Modifier.testTag("taskCardDone"))
                        "issue.overdue" -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("taskCardOverdue")) {
                            SadFace(animate)
                            Spacer(Modifier.width(6.dp))
                            Text(stringResource(R.string.card_overdue, sys.title.ifBlank { i.title }, dueDateText(sys.dueDate)), style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.error)
                        }
                        else -> Unit
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("☑ " + stringResource(R.string.task_card, creator).uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        if (topic != null) {
                            TopicTag(topic, null)
                            if (canPost) {
                                val cd = stringResource(R.string.topic_remove_from_task)
                                Text("✕", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { removeTopic() }.padding(horizontal = 8.dp, vertical = 4.dp)
                                        .semantics { contentDescription = cd }.testTag("taskCardTopicRemove"))
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IssueCheck(i, onToggle = { toggle(i) }, size = 22.dp, box = 40.dp)
                        Text(i.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                            textDecoration = if (done) TextDecoration.LineThrough else null, maxLines = 3, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).clickable { onOpen(i.id) }.padding(vertical = 6.dp).testTag("taskCardTitle"))
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.align(Alignment.CenterVertically)) {
                            if (owner != null) { AuthorAvatar(owner, owner.id, 20.dp); Spacer(Modifier.width(4.dp)) }
                            Text(owner?.name ?: stringResource(R.string.issue_no_owner), style = MaterialTheme.typography.labelMedium, maxLines = 1)
                        }
                        Text("📅 " + when { f.overdue -> stringResource(R.string.issue_overdue); f.dueToday -> stringResource(R.string.issue_today); else -> dueLabel(ctx, i) },
                            style = MaterialTheme.typography.labelMedium, color = if (f.overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.align(Alignment.CenterVertically).testTag("taskCardDue"))
                        Box(Modifier.align(Alignment.CenterVertically)) { StatusPill(i.status) }
                        if (i.commentCount > 0) Text("💬 ${i.commentCount}", style = MaterialTheme.typography.labelMedium, modifier = Modifier.align(Alignment.CenterVertically))
                    }
                    if (sys?.key == "issue.comments") CommentsStrip(sys, data)
                    // Los botones desaparecen cuando la tarea ya no está vencida (nueva fecha, hecha).
                    if (sys?.key == "issue.overdue" && !i.closed && f.overdue && canPost) OverdueActions(i, data)
                    if (comments.isNotEmpty() && sys?.key != "issue.comments") Column(Modifier.fillMaxWidth().padding(top = 2.dp).background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp)).padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        comments.forEach { c ->
                            val who = if (c.actorId == data.me.id) stringResource(R.string.common_you_short) else Names.person(data, c.actorId)?.name?.substringBefore(' ') ?: ""
                            val body = (c.payload["body"] as? JsonPrimitive)?.contentOrNull ?: ""
                            Text(androidx.compose.ui.text.buildAnnotatedString {
                                pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)); append(who); pop(); append(" "); append(body)
                            }, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("taskCardComment"))
                        }
                        if (i.commentCount > comments.size) TextButton(onClick = { onOpen(i.id) }, modifier = Modifier.heightIn(min = 32.dp)) {
                            Text(stringResource(R.string.task_card_all, i.commentCount), style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    if (canPost && !i.closed) Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(text, { text = it.take(4000) }, singleLine = true, placeholder = { Text(stringResource(R.string.task_card_comment), style = MaterialTheme.typography.bodySmall) },
                            textStyle = MaterialTheme.typography.bodySmall, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }),
                            shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("taskCardInput"))
                        TextButton(onClick = { send() }, enabled = text.isNotBlank() && !busy, modifier = Modifier.testTag("taskCardSend")) { Text(stringResource(R.string.send)) }
                    }
                }
            }
        }
    }
}
