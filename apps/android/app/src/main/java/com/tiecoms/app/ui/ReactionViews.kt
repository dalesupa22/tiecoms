package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.ReactionDTO
import com.tiecoms.app.core.Reactions
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Reacciones con emoji (docs/REACCIONES_ENLACES.md): chips bajo la burbuja, barra rápida encima del menú del mensaje
 * y selector completo. Mismas reglas que la web (screens/Reactions.tsx) e iOS.
 */

/** «Laura (Xertify), Beto y Pedro · WhatsApp» (reactorsText de la web). */
fun reactorsText(ctx: Context, d: BootstrapDTO, r: ReactionDTO): String {
    val names = r.userIds.map { u ->
        if (u == d.me.id) return@map ctx.getString(R.string.common_you_short)
        val p = Names.person(d, u) ?: return@map ctx.getString(R.string.former_participant)
        val o = Names.org(d, p.orgId)
        if (o != null && o.id != d.me.primaryOrgId) "${p.name} (${o.name})" else p.name
    } + r.external.map { "${it.name} · ${sourceName(ctx, it.source)}" }
    return if (names.size > 1) names.dropLast(1).joinToString(", ") + " " + ctx.getString(R.string.common_and) + " " + names.last() else names.firstOrNull() ?: ""
}

/** 👀 y ✅ hacen algo más (recordatorio) si la empresa de quien reacciona lo tiene activo. */
fun reactionHint(ctx: Context, emoji: String, actions: Boolean): String? = when {
    !actions -> null
    emoji == Reactions.LOOK -> ctx.getString(R.string.react_look_hint)
    emoji == Reactions.DONE -> ctx.getString(R.string.react_done_hint)
    else -> null
}

/** Reacciones con acción para mí: según mi empresa principal (activas si no dice lo contrario). */
fun reactionActionsFor(d: BootstrapDTO): Boolean = Names.org(d, d.me.primaryOrgId)?.reactionActions != false

/**
 * Poner o quitar mi reacción: optimista en el cliente; avisa el recordatorio de 👀, el cierre de ✅ y ofrece cerrar el
 * asunto que abrió el mensaje. 409 (20 emojis distintos) y cualquier error, en el aviso de abajo.
 */
@Composable
fun rememberReactor(actions: Boolean): (MessageDTO, String, Boolean) -> Unit {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    return remember(client, snackbar, actions) {
        { m: MessageDTO, emoji: String, on: Boolean ->
            container.scope.launch {
                try {
                    val remindAt = if (on && actions && Reactions.normalize(emoji) == Reactions.LOOK) Reactions.lookRemindAt().toInstant() else null
                    val r = client.react(m, emoji, on, remindAt)
                    val reminder = r.reminder
                    if (reminder != null) {
                        val at = runCatching { Instant.parse(reminder.remindAt).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("EEE HH:mm")) }.getOrDefault(reminder.remindAt)
                        snackbar.showSnackbar(ctx.getString(R.string.react_look_done, at))
                    } else if (on && Reactions.normalize(emoji) == Reactions.DONE && r.closedReminderIds.isNotEmpty()) snackbar.showSnackbar(ctx.getString(R.string.react_done_reminders))
                    val issueId = r.openIssueId
                    if (issueId != null) {
                        val title = client.state.value.issues[issueId]?.title ?: ""
                        val res = snackbar.showSnackbar(ctx.getString(R.string.react_close_issue, title), actionLabel = ctx.getString(R.string.react_close_issue_btn), duration = SnackbarDuration.Long)
                        if (res == SnackbarResult.ActionPerformed) {
                            runCatching { client.setIssueStatus(issueId, "done") }
                                .onSuccess { snackbar.showSnackbar(ctx.getString(R.string.react_issue_closed)) }
                                .onFailure { snackbar.showSnackbar(errorText(ctx, it)) }
                        }
                    }
                } catch (e: Exception) {
                    snackbar.showSnackbar(if ((e as? ApiException)?.status == 409) ctx.getString(R.string.react_max) else errorText(ctx, e))
                }
            }
            Unit
        }
    }
}

/** Chips bajo la burbuja: emoji y cuántos; resaltado si reaccioné. Tocar pone o quita la mía; mantener dice quiénes. */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun ReactionChips(m: MessageDTO, data: BootstrapDTO, canReact: Boolean, onToggle: (String, Boolean) -> Unit, modifier: Modifier = Modifier) {
    val list = m.reactions.filter { it.count > 0 }
    if (list.isEmpty()) return
    val ctx = LocalContext.current
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    FlowRow(modifier.padding(top = 2.dp).testTag("reactions-${m.seq}"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        list.forEach { r ->
            val mine = Reactions.mine(r, data.me.id)
            val names = reactorsText(ctx, data, r)
            var who by remember { mutableStateOf(false) }
            Box {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = if (mine) Brand.Orange.copy(alpha = 0.16f) else MaterialTheme.colorScheme.surfaceContainerHigh,
                    border = BorderStroke(1.dp, if (mine) Brand.Orange.copy(alpha = 0.7f) else MaterialTheme.colorScheme.outlineVariant),
                    modifier = Modifier
                        .combinedClickable(enabled = true, onClickLabel = if (mine) stringResource(R.string.react_mine_on) else stringResource(R.string.react_mine_off, r.emoji),
                            onClick = { if (canReact) onToggle(r.emoji, !mine) else who = true },
                            onLongClick = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); who = true })
                        .semantics(mergeDescendants = true) {
                            contentDescription = ctx.getString(R.string.react_chip_label, r.emoji, r.count, names)
                            selected = mine; role = Role.Button
                        }
                        .testTag("reaction-${m.seq}-${r.emoji}"),
                ) {
                    Row(Modifier.heightIn(min = 28.dp).padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(r.emoji, fontSize = 16.sp)
                        Spacer(Modifier.width(4.dp))
                        Text(r.count.toString(), style = MaterialTheme.typography.labelMedium, fontWeight = if (mine) FontWeight.Bold else FontWeight.SemiBold,
                            color = if (mine) Brand.Orange else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                DropdownMenu(who, onDismissRequest = { who = false }) {
                    Text("${r.emoji}  $names", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp).widthIn(max = 280.dp).testTag("reactors"))
                }
            }
        }
    }
}

/**
 * Barra rápida encima del menú del mensaje (como WhatsApp): 👍 ❤️ 😂 👀 ✅ 🙏 y «＋». 👀 y ✅ llevan un punto
 * si mi empresa tiene las reacciones con acción; las que ya puse van resaltadas.
 */
@Composable
fun QuickReactionBar(mine: Set<String>, actions: Boolean, onPick: (String) -> Unit, onMore: () -> Unit) {
    val ctx = LocalContext.current
    Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp).testTag("quickReactions"), verticalAlignment = Alignment.CenterVertically) {
        Reactions.QUICK.forEach { e ->
            val on = e in mine
            val hint = reactionHint(ctx, e, actions)
            Box(
                Modifier.size(40.dp).background(if (on) Brand.Orange.copy(alpha = 0.18f) else Color.Transparent, CircleShape)
                    .clickable(onClickLabel = hint) { onPick(e) }
                    .semantics { contentDescription = hint ?: e; selected = on; if (on) stateDescription = ctx.getString(R.string.react_mine_on) }
                    .testTag("quick-$e"),
                contentAlignment = Alignment.Center,
            ) {
                Text(e, fontSize = 22.sp)
                if (hint != null) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 2.dp).size(5.dp).background(Brand.Orange, CircleShape).testTag("quickAction-$e"))
            }
        }
        Box(
            Modifier.size(40.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape).clickable(onClick = onMore)
                .semantics { contentDescription = ctx.getString(R.string.react_more) }.testTag("quickMore"),
            contentAlignment = Alignment.Center,
        ) { Text("＋", fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** Selector completo: los emojis de trabajo más comunes y un campo que acepta un emoji del teclado del sistema. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EmojiPickerSheet(mine: Set<String>, actions: Boolean, onPick: (String) -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    var typed by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    fun pick(e: String) { onClose(); onPick(e) }
    FormSheet(stringResource(R.string.react_picker), onClose, tag = "emojiPicker") {
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Reactions.PICKER.forEach { e ->
                val on = e in mine
                Box(
                    Modifier.size(44.dp).background(if (on) Brand.Orange.copy(alpha = 0.18f) else Color.Transparent, RoundedCornerShape(10.dp))
                        .clickable { pick(e) }.semantics { contentDescription = reactionHint(ctx, e, actions) ?: e; selected = on }.testTag("pick-$e"),
                    contentAlignment = Alignment.Center,
                ) { Text(e, fontSize = 24.sp) }
            }
        }
        Column {
            OutlinedTextField(typed, { v ->
                typed = v.take(32); error = null
                // Un emoji escrito con el teclado se usa de una vez.
                Reactions.normalize(typed)?.let { pick(it) }
            }, label = { Text(stringResource(R.string.react_type)) }, singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { Reactions.normalize(typed)?.let { pick(it) } ?: run { error = ctx.getString(R.string.react_invalid) } }),
                modifier = Modifier.fillMaxWidth().testTag("emojiInput"))
            ErrorText(error)
        }
    }
}
