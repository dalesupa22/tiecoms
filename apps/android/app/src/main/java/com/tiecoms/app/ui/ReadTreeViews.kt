package com.tiecoms.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.ReadTree
import kotlinx.coroutines.launch

/**
 * Franja del chat (1.6.6): «⑂ 11 sin leer en 2 conversaciones de este grupo · Ver». «Ver» abre la lista de las
 * derivadas pendientes (nombre, cifra y «@» si me mencionaron) y cada una lleva a su conversación. Abrir la franja
 * o la lista no marca nada: el cursor de cada conversación solo avanza con lo que se ve.
 */
@Composable
fun TreeUnreadStrip(conv: ConversationDTO, data: BootstrapDTO, onOpen: (String) -> Unit) {
    val tree = remember(data, conv.id) { ReadTree.of(data, conv) }
    val list = tree.pendingChildren
    if (list.isEmpty()) return
    val ctx = LocalContext.current
    var open by rememberSaveable(conv.id) { mutableStateOf(false) }
    val n = list.sumOf { it.unread }
    val mentions = list.sumOf { it.mentions }
    // Como la web: con una sola derivada, su nombre; con varias, cuántas. Y « · @ N» si me mencionaron.
    val text = (if (list.size == 1) stringResource(R.string.tree_banner_one, n, titleOf(ctx, list[0].c, data)) else pluralStringResource(R.plurals.tree_banner, list.size, n, list.size)) +
        if (mentions > 0) " · @ $mentions" else ""
    val view = stringResource(R.string.tree_banner_view)
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()
        .clickable(onClickLabel = view, role = Role.Button) { open = true }.testTag("treeStrip")) {
        Row(Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSecondaryContainer, fontWeight = FontWeight.SemiBold,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).testTag("treeStripText"))
            Text(" · $view", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, maxLines = 1)
        }
    }
    if (open) FormSheet(stringResource(R.string.tree_sheet_title), { open = false }, tag = "treeSheet") {
        val client = LocalClient.current
        val container = LocalContainer.current
        list.forEach { ch ->
            val title = titleOf(ctx, ch.c, data)
            val mentioned = stringResource(R.string.tree_sheet_mentioned)
            Row(Modifier.fillMaxWidth().clickable { open = false; onOpen(ch.c.id) }.heightIn(min = 52.dp).padding(vertical = 6.dp)
                .semantics(mergeDescendants = true) { contentDescription = listOfNotNull(title, ch.unread.toString(), if (ch.mentions > 0) mentioned else null).joinToString(", ") }
                .testTag("treeItem-${ch.c.id}"), verticalAlignment = Alignment.CenterVertically) {
                ConversationIcon(ch.c, data, 32.dp)
                Spacer(Modifier.width(10.dp))
                Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (ch.mentions > 0) MentionDot()
                if (ch.unread > 0) Surface(shape = CircleShape, color = Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE)) {
                    Text(if (ch.unread > 99) "99+" else ch.unread.toString(), color = Color.White, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
                }
            }
        }
        // «Marcar todo como leído»: explícito, el grupo y estas derivadas hasta lo que se ve aquí (read-tree).
        androidx.compose.material3.OutlinedButton(onClick = {
            open = false
            container.scope.launch { runCatching { client.markTreeRead(conv.id) }.onSuccess { container.toast(ctx.getString(R.string.toast_marked_read)) }.onFailure { container.toast(errorText(ctx, it)) } }
        }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("treeMarkAll")) { Text("✓ " + stringResource(R.string.tree_mark_all)) }
    }
}

@Composable
private fun MentionDot() {
    Surface(shape = RoundedCornerShape(50), color = Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), modifier = Modifier.padding(horizontal = 4.dp)) {
        Text(stringResource(R.string.mention_badge), color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp))
    }
}
