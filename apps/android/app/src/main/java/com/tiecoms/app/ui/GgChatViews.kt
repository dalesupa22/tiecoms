package com.tiecoms.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiecoms.app.R
import com.tiecoms.app.core.Assistant
import com.tiecoms.app.core.AssistantActionDTO
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.Gg
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.ui.theme.LocalChatColors
import kotlinx.coroutines.launch

/**
 * Mensaje de sistema gg.actions (GgActionsRow de la web): para quien lo pidió, una tarjeta por acción con Confirmar y
 * Descartar, y las respuestas rápidas; para los demás, una línea discreta «Para Ana: …».
 * El estado confirmado vuelve en el mismo mensaje (message.updated); mientras, se pinta el cambio local.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GgActionsRow(m: MessageDTO, g: Gg.ActionsBody, data: BootstrapDTO) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val mine = g.forUserId == data.me.id
    var local by remember(m.id) { mutableStateOf(mapOf<String, AssistantActionDTO>()) }
    val list = g.actions.map { a -> local[a.id]?.let { l -> if (a.status != "pending") a else l } ?: a }
    if (!mine) {
        val who = Names.person(data, g.forUserId)?.name?.substringBefore(' ') ?: ""
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 2.dp).testTag("ggActionsOther")) {
            list.forEach { a ->
                Text(stringResource(R.string.gg_for_other, who) + ": " + a.target + " · " + a.text, style = MaterialTheme.typography.bodySmall,
                    color = LocalChatColors.current.system, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        return
    }
    fun patch(a: AssistantActionDTO) { local = local + (a.id to a) }
    fun run(a: AssistantActionDTO) {
        val token = a.token ?: return
        patch(a.copy(status = "done", error = null))
        container.scope.launch {
            runCatching { client.ggRunAction(token, m.id, a.id) }.onSuccess { r -> patch(a.copy(status = r.status.ifBlank { "done" }, undoToken = r.undoToken, link = r.link ?: a.link, error = r.error)) }
                .onFailure { patch(a.copy(status = "failed", error = errorText(ctx, it))) }
        }
    }
    fun discard(a: AssistantActionDTO) {
        patch(a.copy(status = "failed", error = ctx.getString(R.string.ai_discarded)))
        container.scope.launch { runCatching { client.ggDiscardAction(m.id, a.id) } }
    }
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 4.dp).testTag("ggActions"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        list.forEach { a -> GgChatActionCard(a, onRun = { run(a) }, onDiscard = { discard(a) }) }
        if (g.suggestions.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            g.suggestions.forEach { s ->
                SuggestionChip(onClick = { client.send(m.conversationId, s) }, label = { Text(s) }, modifier = Modifier.testTag("ggSuggest"))
            }
        }
    }
}

@Composable
private fun GgChatActionCard(a: AssistantActionDTO, onRun: () -> Unit, onDiscard: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val danger = a.kind == "cancel_event"
    Surface(shape = RoundedCornerShape(12.dp), color = scheme.surface,
        border = BorderStroke(if (a.status == "pending") 1.5.dp else 1.dp, if (a.status == "pending") (if (danger) scheme.error else scheme.primary) else scheme.outlineVariant),
        modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth().testTag("ggChatCard-${a.id}")) {
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
            Text(a.text, style = MaterialTheme.typography.bodyMedium)
            a.detail?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant) }
            a.error?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheme.error) }
            if (a.status == "pending" && a.token != null) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val pad = PaddingValues(horizontal = 12.dp, vertical = 0.dp)
                Button(onClick = onRun, contentPadding = pad, modifier = Modifier.height(36.dp).testTag("ggChatRun"),
                    colors = if (danger) ButtonDefaults.buttonColors(containerColor = scheme.error, contentColor = scheme.onError) else ButtonDefaults.buttonColors()) {
                    Text(stringResource(R.string.ai_confirm))
                }
                OutlinedButton(onClick = onDiscard, contentPadding = pad, modifier = Modifier.height(36.dp).testTag("ggChatDiscard")) { Text(stringResource(R.string.ai_discard)) }
            }
        }
    }
}
