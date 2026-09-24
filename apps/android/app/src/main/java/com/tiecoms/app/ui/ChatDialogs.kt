package com.tiecoms.app.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.Bring
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.ForwardedInfo
import com.tiecoms.app.core.MAX_FORWARD_TARGETS
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PersonDTO
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

fun excerpt(s: String, n: Int = 90) = s.replace(Regex("\\s+"), " ").trim().take(n)

/** Personas humanas de una conversación. */
fun humansOf(d: BootstrapDTO, conversationId: String): List<PersonDTO> =
    (d.conversations.firstOrNull { it.id == conversationId }?.memberIds ?: emptyList()).mapNotNull { Names.person(d, it) }.filter { it.kind == "human" }

/** Crea un recordatorio y avisa con el texto de la web («Te lo recuerdo …»). */
fun remind(ctx: Context, conversationId: String, at: Instant, messageId: String?, note: String?) {
    val container = ctx.applicationContext.let { (it as com.tiecoms.app.TieComsApp).container }
    container.scope.launch {
        try {
            container.client.value.createReminder(conversationId, messageId, note, at)
            container.toast(ctx.getString(R.string.toast_reminder_set, whenText(at)))
        } catch (e: Exception) { container.toast(errorText(ctx, e)) }
    }
}

/** Submenú «Recordarme»: tiempos rápidos + fecha y hora a elección. */
fun remindMenu(ctx: Context, conv: ConversationDTO, message: MessageDTO?, onCustom: () -> Unit): SheetItem =
    SheetItem(
        ctx.getString(R.string.menu_remind), "⏰", tag = "menuRemind",
        children = quickTimes(ctx).map { (label, at) ->
            SheetItem(label, hint = at.atZone(ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("EEE HH:mm")), onClick = {
                remind(ctx, conv.id, at, message?.id, message?.body?.take(120))
            })
        } + SheetItem(ctx.getString(R.string.when_custom), "…", onClick = onCustom),
    )

@Composable
fun ReminderDialog(conv: ConversationDTO, message: MessageDTO?, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val def = remember { Instant.now().plusSeconds(3600).atZone(ZoneId.systemDefault()) }
    var date by rememberSaveable { mutableStateOf(def.toLocalDate().toString()) }
    var time by rememberSaveable { mutableStateOf(def.toLocalTime().withSecond(0).withNano(0).toString()) }
    var note by rememberSaveable { mutableStateOf(message?.body?.take(120) ?: "") }
    FormSheet(stringResource(R.string.rem_custom), onClose, tag = "reminderDialog") {
        Text(stringResource(R.string.rem_about, titleOf(ctx, conv, data)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DateField(stringResource(R.string.rem_date), LocalDate.parse(date), { it?.let { d -> date = d.toString() } }, modifier = Modifier.weight(1f))
            TimeField(stringResource(R.string.rem_time), LocalTime.parse(time), { time = it.toString() }, modifier = Modifier.weight(1f))
        }
        OutlinedTextField(note, { note = it.take(300) }, label = { Text(stringResource(R.string.rem_note)) }, modifier = Modifier.fillMaxWidth())
        DialogButtons(onClose, stringResource(R.string.rem_save), confirmTag = "saveReminder") {
            val at = LocalDate.parse(date).atTime(LocalTime.parse(time)).atZone(ZoneId.systemDefault()).toInstant()
            remind(ctx, conv.id, at, message?.id, note.ifBlank { null })
            onClose()
        }
    }
}

/** Submenú «Reenviar»: a otra conversación de TieComs o hacia otras apps (texto como la web). */
fun forwardMenu(ctx: Context, d: BootstrapDTO, conv: ConversationDTO, m: MessageDTO): SheetItem {
    val container = (ctx.applicationContext as com.tiecoms.app.TieComsApp).container
    val author = Names.person(d, m.authorId)?.name ?: ""
    val title = titleOf(ctx, conv, d)
    val link = messageLink(m.conversationId, m.seq)
    val plain = "$author: ${m.body}\n\n— $title · TieComs\n$link"
    fun open(uri: String) = runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    return SheetItem(
        ctx.getString(R.string.menu_forward), "↪", tag = "menuForward",
        children = listOf(
            SheetItem(ctx.getString(R.string.fwd_whatsapp), "🟢", onClick = { open("https://wa.me/?text=" + Uri.encode(plain)) }),
            SheetItem(ctx.getString(R.string.fwd_slack), "#", onClick = {
                copyToClipboard(ctx, ">" + m.body.split('\n').joinToString("\n>") + "\n— *$author* · $title · <$link|TieComs>")
                container.toast(ctx.getString(R.string.toast_slack_copied))
            }),
            SheetItem(ctx.getString(R.string.fwd_teams), "T", onClick = { copyToClipboard(ctx, plain); container.toast(ctx.getString(R.string.toast_teams_copied)) }),
            SheetItem(ctx.getString(R.string.fwd_email), "✉", onClick = { open("mailto:?subject=" + Uri.encode("$title · TieComs") + "&body=" + Uri.encode(plain)) }),
        ),
    )
}

/**
 * Reenviar a otros chats (ForwardToChatsDialog de la web): buscador, selección de hasta 10 chats y comentario
 * opcional. Todo va por la cola persistente: en cada destino, primero el comentario y luego el original con su autor y origen.
 */
@Composable
fun ForwardDialog(source: MessageDTO, onClose: () -> Unit, onSent: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var comment by rememberSaveable { mutableStateOf("") }
    var q by rememberSaveable { mutableStateOf("") }
    val author = Names.person(data, source.authorId)?.name
    val list = remember(data, q, source.conversationId) {
        data.conversations.filter { it.canPost && it.id != source.conversationId && (q.isBlank() || titleOf(ctx, it, data).contains(q.trim(), ignoreCase = true)) }
            .sortedByDescending { it.lastMessageAt ?: "" }
    }
    FormSheet(stringResource(R.string.fwd_title), onClose, tag = "forwardDialog") {
        Quote(source.body.take(240))
        author?.let { Text("— $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.fwd_search)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("fwdSearch"))
        if (picked.size >= MAX_FORWARD_TARGETS) Text(stringResource(R.string.fwd_limit, MAX_FORWARD_TARGETS), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxWidth().heightIn(max = 340.dp).testTag("fwdList")) {
            items(list.size, key = { list[it].id }) { i ->
                val c = list[i]
                val on = c.id in picked
                ChatOption(c, data, on, enabled = on || picked.size < MAX_FORWARD_TARGETS) {
                    picked = if (on) picked - c.id else if (picked.size >= MAX_FORWARD_TARGETS) picked else picked + c.id
                }
            }
        }
        OutlinedTextField(comment, { comment = it }, placeholder = { Text(stringResource(R.string.fwd_comment)) }, modifier = Modifier.fillMaxWidth().testTag("fwdComment"))
        DialogButtons(onClose, if (picked.size > 1) stringResource(R.string.fwd_send_many, picked.size) else stringResource(R.string.fwd_send), enabled = picked.isNotEmpty(), confirmTag = "forwardSend") {
            val n = client.forward(source, picked, comment)
            container.toast(if (n == 1) ctx.getString(R.string.toast_sent) else ctx.getString(R.string.fwd_sent_many, n))
            val one = picked.singleOrNull()
            onClose(); one?.let(onSent)
        }
    }
}

/** Fila de chat para elegir destinos: avatar (persona, caritas apiladas o espacio), título, subtítulo y logos. */
@Composable
private fun ChatOption(c: ConversationDTO, data: BootstrapDTO, on: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    val ctx = LocalContext.current
    val other = if (c.kind == "direct") Names.otherInDirect(c, data) else null
    val ws = data.workspaces.firstOrNull { it.id == c.workspaceId }
    val sub = when {
        other != null -> listOfNotNull(other.title, Names.org(data, other.orgId)?.name).filter { it.isNotBlank() }.joinToString(" · ")
        ws != null -> ws.name
        else -> stringResource(R.string.chat_group_chat)
    }
    Row(
        Modifier.fillMaxWidth().toggleable(on, enabled = enabled, role = Role.Checkbox) { onToggle() }.heightIn(min = 56.dp).padding(vertical = 4.dp).testTag("fwd-${c.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(on, null, enabled = enabled)
        Spacer(Modifier.width(6.dp))
        when {
            other != null -> PersonAvatar(other, data, size = 34.dp)
            c.kind == "multi" -> StackedAvatars(c, data, size = 34.dp)
            else -> {
                val o = Names.org(data, c.internalOrgId ?: ws?.owningOrgId)
                Avatar(ws?.glyph?.takeIf { it.isNotBlank() } ?: if (c.kind == "internal") "◌" else "#",
                    parseColor(o?.colorBg, com.tiecoms.app.ui.theme.Brand.Orange), parseColor(o?.colorFg, androidx.compose.ui.graphics.Color.White), size = 34.dp, square = true)
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(titleOf(ctx, c, data), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub.isNotBlank()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (other == null) Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) { Names.participantOrgs(c, data).take(4).forEach { OrgMark(it, size = 16.dp) } }
    }
}

/** Traer desde WhatsApp, Slack, correo u otra app (y destino de «Compartir»). */
@Composable
fun BringDialog(conversationId: String, initialText: String = "", initialSource: String = "whatsapp", onClose: () -> Unit, onDone: (() -> Unit)? = null) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    var source by rememberSaveable { mutableStateOf(initialSource) }
    var text by rememberSaveable { mutableStateOf(initialText) }
    var author by rememberSaveable { mutableStateOf("") }
    var split by rememberSaveable { mutableStateOf(true) }
    val parsed = remember(source, text) { if (source == "whatsapp") Bring.parseWhatsApp(text) else emptyList() }
    val mail = if (source == "email") Bring.parseEmail(text) else null
    FormSheet(stringResource(R.string.imp_title), onClose, tag = "bringDialog") {
        Text(stringResource(R.string.imp_body), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.imp_source), style = MaterialTheme.typography.labelMedium)
        Segmented(Bring.SOURCES.map { it to sourceName(ctx, it) }, source, { source = it })
        OutlinedTextField(text, { text = it }, placeholder = { Text(stringResource(R.string.imp_paste)) }, minLines = 5, maxLines = 12, modifier = Modifier.fillMaxWidth().testTag("bringText"))
        if (parsed.size > 1) {
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.imp_detected, parsed.size), fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall)
                    Segmented(listOf(true to stringResource(R.string.imp_as_many, parsed.size), false to stringResource(R.string.imp_as_one)), split, { split = it })
                }
            }
        }
        mail?.subject?.let { Text(stringResource(R.string.imp_subject, it), style = MaterialTheme.typography.bodySmall) }
        if (!(parsed.size > 1 && split)) {
            OutlinedTextField(author, { author = it.take(120) }, label = { Text(stringResource(R.string.imp_author)) },
                placeholder = { Text(parsed.firstOrNull()?.author ?: mail?.from ?: "") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        }
        DialogButtons(onClose, stringResource(R.string.imp_send), enabled = text.isNotBlank(), confirmTag = "bringSend") {
            if (parsed.size > 1 && split) {
                parsed.forEach { l -> client.send(conversationId, l.body, null, ForwardedInfo(source, l.author, l.sentAt)) }
            } else {
                val who = author.ifBlank { null } ?: parsed.firstOrNull()?.author ?: mail?.from
                client.send(conversationId, text.trim(), null, ForwardedInfo(source, who, parsed.firstOrNull()?.sentAt))
            }
            container.toast(ctx.getString(R.string.toast_sent))
            onDone?.invoke(); onClose()
        }
    }
}

fun sourceName(ctx: Context, s: String) = ctx.getString(
    when (s) { "whatsapp" -> R.string.src_whatsapp; "slack" -> R.string.src_slack; "email" -> R.string.src_email; "teams" -> R.string.src_teams; "tiecoms" -> R.string.src_tiecoms; else -> R.string.src_other },
)

@Composable
fun DeriveDialog(conv: ConversationDTO, message: MessageDTO, onClose: () -> Unit, onCreated: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val myOrg = Names.org(data, data.me.primaryOrgId)
    val full = excerpt(message.body, 10_000)
    val short = if (full.length > 40) full.take(40).replace(Regex("\\s+\\S*$"), "") + "…" else full
    fun prefix(k: String) = ctx.getString(when (k) { "internal" -> R.string.derive_prefix_internal; "directive" -> R.string.derive_prefix_directive; else -> R.string.derive_prefix_same })
    var kind by rememberSaveable { mutableStateOf("same") }
    var name by rememberSaveable { mutableStateOf("${prefix("same")} · $short") }
    var reason by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val options = listOf(
        Triple("same", stringResource(R.string.derive_same), stringResource(R.string.derive_same_note)),
        Triple("internal", stringResource(R.string.derive_internal, myOrg?.name ?: ""), stringResource(R.string.derive_internal_note)),
        Triple("directive", stringResource(R.string.derive_directive), stringResource(R.string.derive_directive_note)),
    )
    FormSheet(stringResource(R.string.derive_title), onClose, tag = "deriveDialog") {
        Text(stringResource(R.string.derive_body), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Quote(full.take(220))
        options.forEach { (k, label, note) ->
            Row(
                Modifier.fillMaxWidth().selectable(kind == k, role = Role.RadioButton) { kind = k; name = "${prefix(k)} · $short" }.heightIn(min = 56.dp).testTag("derive-$k"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(kind == k, null)
                Spacer(Modifier.width(8.dp))
                Column { Text(label, fontWeight = FontWeight.SemiBold); Text(note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        OutlinedTextField(name, { name = it.take(120) }, label = { Text(stringResource(R.string.derive_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(reason, { reason = it.take(300) }, label = { Text(stringResource(R.string.derive_reason)) }, modifier = Modifier.fillMaxWidth())
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.derive_create), enabled = !busy && name.trim().length >= 2, confirmTag = "deriveCreate") {
            busy = true; error = null
            scope.launch {
                try { val id = client.derive(conv.id, message.id, kind, name.trim(), reason.trim()); onClose(); onCreated(id) }
                catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }
    }
}

@Composable
fun ReturnDialog(conv: ConversationDTO, parentName: String, onClose: () -> Unit, onReturned: (String, Long?) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val st = client.state.collectAsStateWithLifecycle().value
    val last = st.conversations[conv.id]?.messages?.lastOrNull { it.kind == "text" && it.deletedAt == null }?.body ?: ""
    var summary by rememberSaveable { mutableStateOf(last) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    FormSheet(stringResource(R.string.lin_return_title), onClose, tag = "returnDialog") {
        Text(stringResource(R.string.lin_return_body, parentName), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(summary, { summary = it.take(4000) }, minLines = 4, modifier = Modifier.fillMaxWidth().testTag("returnSummary"))
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.lin_return_send), enabled = !busy && summary.trim().length >= 2, confirmTag = "returnSend") {
            busy = true; error = null
            scope.launch {
                try {
                    val r = client.returnResult(conv.id, summary.trim())
                    onClose(); onReturned(r.parentId, client.meta(r.parentId)?.lastMessageSeq)
                } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> Dropdown(label: String, options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier, tag: String? = null) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(open, { open = it }, modifier) {
        OutlinedTextField(
            value = options.firstOrNull { it.first == selected }?.second ?: "", onValueChange = {}, readOnly = true, label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) }, singleLine = true,
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth().then(if (tag != null) Modifier.testTag(tag) else Modifier),
        )
        ExposedDropdownMenu(open, { open = false }) {
            options.forEach { (v, l) -> DropdownMenuItem(text = { Text(l, maxLines = 1, overflow = TextOverflow.Ellipsis) }, onClick = { open = false; onSelect(v) }) }
        }
    }
}

@Composable
fun NewIssueDialog(conversationId: String, originMessageId: String?, defaultTitle: String, onClose: () -> Unit, onCreated: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val members = humansOf(data, conversationId)
    var title by rememberSaveable { mutableStateOf(defaultTitle) }
    var owner by rememberSaveable { mutableStateOf(data.me.id) }
    var due by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val you = stringResource(R.string.you); val guest = stringResource(R.string.common_guest)
    FormSheet(stringResource(R.string.issue_new_title), onClose, tag = "issueDialog") {
        OutlinedTextField(title, { title = it.take(200) }, label = { Text(stringResource(R.string.issue_title)) }, modifier = Modifier.fillMaxWidth().testTag("issueTitle"))
        Dropdown(stringResource(R.string.issue_owner), members.map { p -> p.id to "${p.name}${if (p.id == data.me.id) " $you" else ""} · ${Names.org(data, p.orgId)?.name ?: guest}" }, owner, { owner = it })
        DateField(stringResource(R.string.issue_due), due?.let { LocalDate.parse(it) }, { due = it?.toString() }, allowClear = true, modifier = Modifier.fillMaxWidth())
        ErrorText(error)
        DialogButtons(onClose, stringResource(R.string.issue_create), enabled = !busy && title.trim().length >= 2, confirmTag = "issueCreate") {
            busy = true; error = null
            scope.launch {
                try { val i = client.createIssue(conversationId, title.trim(), owner, due, originMessageId); onClose(); onCreated(i.id) }
                catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }
    }
}

@Composable
fun PinsSheet(conv: ConversationDTO, onJump: (Long) -> Unit, onClose: () -> Unit) {
    val client = LocalClient.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var list by remember { mutableStateOf<List<MessageDTO>?>(null) }
    LaunchedEffect(conv.id) { list = runCatching { client.loadPins(conv.id) }.getOrDefault(emptyList()) }
    FormSheet(stringResource(R.string.pins_title), onClose, tag = "pinsSheet") {
        when {
            list == null -> CircularProgressIndicator()
            list!!.isEmpty() -> EmptyNote(stringResource(R.string.pins_empty))
            else -> list!!.forEach { m ->
                val p = Names.person(data, m.authorId)
                Row(Modifier.fillMaxWidth().clickable { onJump(m.seq) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    PersonAvatar(p, data, size = 30.dp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(p?.name ?: "", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall)
                        Text(excerpt(m.body, 140), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
