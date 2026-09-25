package com.tiecoms.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PersonDTO
import com.tiecoms.app.core.SideOutsiders
import kotlinx.coroutines.launch

/**
 * Candidatos para una conversación lateral (SPEC-v3 §4): participantes del chat de origen y colegas de mis
 * empresas; nadie de otra empresa que no esté ya en el origen (el servidor lo rechaza con side_outsider).
 */
fun sideCandidates(d: BootstrapDTO, origin: ConversationDTO): List<PersonDTO> {
    val myOrgs = d.organizations.filter { it.myRole != null }.map { it.id }.toSet()
    val inOrigin = origin.memberIds.toSet()
    return d.people.filter { it.kind == "human" && it.id != d.me.id && (it.id in inOrigin || (it.orgId != null && it.orgId in myOrgs)) }
        .sortedWith(compareBy({ it.id !in inOrigin }, { it.name.lowercase() }))
}

/** Laterales de un mensaje ancla visibles para mí (calculado desde /bootstrap). */
fun sidesOf(d: BootstrapDTO, conversationId: String, messageId: String): List<ConversationDTO> =
    d.conversations.filter { it.isSide && it.parentId == conversationId && it.parentMessageId == messageId }

@Composable
fun SideStartSheet(origin: ConversationDTO, anchor: MessageDTO, onClose: () -> Unit, onStarted: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val candidates = remember(data, origin) { sideCandidates(data, origin) }
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var question by rememberSaveable { mutableStateOf("") }
    var q by rememberSaveable { mutableStateOf("") }
    var outsiders by remember { mutableStateOf(setOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    FormSheet(stringResource(R.string.menu_ask_side), onClose, tag = "sideSheet") {
        Text(stringResource(R.string.side_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Quote(excerpt(anchor.body, 220))
        Text(stringResource(R.string.side_pick), style = MaterialTheme.typography.labelLarge)
        OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.side_search)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("sideSearch"))
        val inOrigin = origin.memberIds.toSet()
        var lastGroup: Boolean? = null
        candidates.filter { q.isBlank() || it.name.contains(q, ignoreCase = true) }.forEach { p ->
            val here = p.id in inOrigin
            if (lastGroup != here) {
                lastGroup = here
                Text(stringResource(if (here) R.string.side_in_chat else R.string.side_colleagues), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            }
            val blocked = p.id in outsiders
            val on = p.id in picked
            Row(
                Modifier.fillMaxWidth().toggleable(on, enabled = !blocked, role = Role.Checkbox) { picked = if (on) picked - p.id else picked + p.id }
                    .heightIn(min = 52.dp).testTag("sidePerson-${p.id}"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(on, null, enabled = !blocked)
                Spacer(Modifier.width(6.dp))
                PersonAvatar(p, data, size = 32.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (blocked) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.onSurface)
                    Text(if (blocked) stringResource(R.string.side_outsider) else listOfNotNull(Names.org(data, p.orgId)?.name, if (p.id in inOrigin) titleOf(ctx, origin, data) else null).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = if (blocked) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        OutlinedTextField(question, { question = it.take(4000) }, label = { Text(stringResource(R.string.side_question)) }, placeholder = { Text(stringResource(R.string.side_question_ph)) },
            minLines = 2, modifier = Modifier.fillMaxWidth().testTag("sideQuestion"))
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.side_start), enabled = !busy && picked.isNotEmpty(), confirmTag = "sideStart") {
            busy = true; error = null
            scope.launch {
                try {
                    val id = client.startSide(origin.id, anchor.id, picked, question)
                    onClose(); onStarted(id)
                } catch (e: Exception) {
                    val out = SideOutsiders.from(e)
                    if (out.isNotEmpty()) { outsiders = outsiders + out; picked = picked - out }
                    error = errorText(ctx, e)
                } finally { busy = false }
            }
        }
    }
}

/** Chip «💬 Consulta lateral · N» bajo el mensaje ancla (solo lo ven los miembros de la lateral). */
@Composable
fun SideChip(sides: List<ConversationDTO>, onOpen: (String) -> Unit) {
    if (sides.isEmpty()) return
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.padding(top = 4.dp).clickable { onOpen(sides.maxBy { it.lastMessageAt ?: "" }.id) }.testTag("sideChip")) {
        Text(stringResource(R.string.side_chip, sides.size), Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

/** Encabezado del panel lateral: título, ancla fija arriba, pantalla completa y cerrar. */
@Composable
fun SidePanelHeader(side: ConversationDTO, anchor: MessageDTO?, data: BootstrapDTO, onFull: () -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("💬 " + titleOf(ctx, side, data), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).semantics { heading() })
            IconButton(onClick = onFull, modifier = Modifier.testTag("sideFull")) { Icon(Icons.Filled.OpenInFull, stringResource(R.string.side_open_full)) }
            IconButton(onClick = onClose, modifier = Modifier.testTag("sideClose")) { Icon(Icons.Filled.Close, stringResource(R.string.close)) }
        }
        if (anchor != null) {
            Text(stringResource(R.string.side_anchor), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("«" + excerpt(anchor.body, 160) + "» — " + (Names.person(data, anchor.authorId)?.name ?: ""), style = MaterialTheme.typography.bodySmall,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 6.dp).testTag("sideAnchor"))
        }
    }
}

/** En teléfono: hoja deslizable a casi pantalla completa sobre el chat. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SideSheetHost(onClose: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onClose, sheetState = state, modifier = Modifier.testTag("sidePanel")) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.94f)) { content() }
    }
}

