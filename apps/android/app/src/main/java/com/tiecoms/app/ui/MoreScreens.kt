package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.OrgDomainDTO
import com.tiecoms.app.core.ReminderDTO
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

// ---------- Trazo ----------
@Composable
fun KindBadge(kind: String?) {
    kind ?: return
    val ctx = LocalContext.current
    val label = ctx.getString(when (kind) { "internal" -> R.string.lin_kind_internal; "directive" -> R.string.lin_kind_directive; else -> R.string.lin_kind_same })
    Box(Modifier.background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(8.dp)).padding(horizontal = 6.dp, vertical = 2.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

private fun orgsIn(d: BootstrapDTO, c: ConversationDTO) = Names.participantOrgs(c, d)

@Composable
fun TrazoScreen(onBack: () -> Unit, onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val convs = data.conversations.filter { it.kind != "direct" }
    val byId = convs.associateBy { it.id }
    fun kidsOf(id: String) = convs.filter { it.parentId == id }.sortedBy { it.lastMessageAt ?: "" }
    val roots = convs.filter { kidsOf(it.id).isNotEmpty() && (it.parentId == null || it.parentId !in byId) } +
        convs.filter { it.parentId != null && it.parentId !in byId && kidsOf(it.id).isEmpty() }
    val chains = roots.map { root ->
        val nodes = mutableListOf<Pair<ConversationDTO, Int>>()
        fun walk(c: ConversationDTO, depth: Int) { nodes += c to depth; kidsOf(c.id).forEach { walk(it, depth + 1) } }
        walk(root, 0)
        root to nodes
    }
    SimpleScaffold(stringResource(R.string.nav_trazo), onBack) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("trazo")) {
            item {
                Text(stringResource(R.string.trazo_sub), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                if (chains.isEmpty()) EmptyNote(stringResource(R.string.trazo_empty))
            }
            chains.forEach { (root, nodes) ->
                item(key = root.id) {
                    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(titleOf(ctx, root, data), fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(stringResource(R.string.trazo_tramos, nodes.size), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            data.workspaces.firstOrNull { it.id == root.workspaceId }?.let { Text(it.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            nodes.forEach { (c, depth) ->
                                Row(Modifier.fillMaxWidth().padding(start = (depth * 20).dp).clickable { onOpen(c.id) }.heightIn(min = 48.dp).padding(vertical = 4.dp).testTag("trazo-${c.id}"), verticalAlignment = Alignment.CenterVertically) {
                                    if (depth > 0) Text("└ ", color = Brand.Orange)
                                    Column(Modifier.weight(1f)) {
                                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                            Text(titleOf(ctx, c, data), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                            KindBadge(c.deriveKind)
                                        }
                                        if (c.parentId != null) Text(
                                            if (c.returnedAt != null) "↩ " + stringResource(R.string.trazo_returned_on, dateText(c.returnedAt)) else "● " + stringResource(R.string.trazo_open),
                                            style = MaterialTheme.typography.labelSmall, color = if (c.returnedAt != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                        c.deriveReason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                        Text(orgsIn(data, c).joinToString(" · ") { it.name } + " · ${c.memberIds.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------- Recordatorios ----------
@Composable
fun RemindersScreen(onBack: () -> Unit, onOpen: (String, Long?) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    var tick by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) { runCatching { client.loadReminders() }; while (true) { delay(30_000); tick++ } }
    val now = Instant.now().also { tick.hashCode() }
    val visible = data.conversations.map { it.id }.toSet()
    val mine = st.reminders.filter { it.conversationId in visible }
    val due = mine.filter { parseInstant(it.remindAt)?.isAfter(now) == false }
    val next = mine.filter { parseInstant(it.remindAt)?.isAfter(now) == true }
    fun act(block: suspend () -> Unit) = scope.launch { runCatching { block() }.onFailure { container.toast(errorText(ctx, it)) } }
    SimpleScaffold(stringResource(R.string.rem_title), onBack) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("reminders")) {
            if (due.isEmpty() && next.isEmpty()) item { EmptyNote(stringResource(R.string.rem_empty)) }
            if (due.isNotEmpty()) item { SectionHeader(stringResource(R.string.rem_due), Modifier.padding(top = 12.dp).semantics { heading() }) }
            items(due, key = { it.id }) { r -> ReminderRow(r, data, true, onOpen, { act { client.snoozeReminder(r.id, Instant.now().plusSeconds(3600)) } }, { act { client.completeReminder(r.id) } }) }
            if (next.isNotEmpty()) item { SectionHeader(stringResource(R.string.rem_upcoming), Modifier.padding(top = 12.dp).semantics { heading() }) }
            items(next, key = { it.id }) { r -> ReminderRow(r, data, false, onOpen, {}, { act { client.completeReminder(r.id) } }) }
        }
    }
}

@Composable
private fun ReminderRow(r: ReminderDTO, data: BootstrapDTO, due: Boolean, onOpen: (String, Long?) -> Unit, onSnooze: () -> Unit, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val conv = data.conversations.firstOrNull { it.id == r.conversationId }
    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(vertical = 6.dp).testTag("reminder-${r.id}"), verticalAlignment = Alignment.CenterVertically) {
        Text("⏰", Modifier.padding(end = 10.dp))
        Column(Modifier.weight(1f).clickable { onOpen(r.conversationId, r.messageSeq) }) {
            Text(r.note?.ifBlank { null } ?: conv?.let { titleOf(ctx, it, data) } ?: "", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${conv?.let { titleOf(ctx, it, data) } ?: ""} · ${parseInstant(r.remindAt)?.let { whenText(it) } ?: ""}", style = MaterialTheme.typography.bodySmall,
                color = if (due) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (due) OutlinedButton(onClick = onSnooze, modifier = Modifier.padding(start = 6.dp)) { Text(stringResource(R.string.rem_snooze)) }
        OutlinedButton(onClick = onDone, modifier = Modifier.padding(start = 6.dp).testTag("remDone-${r.id}")) { Text(stringResource(R.string.rem_done)) }
    }
}

// ---------- Compartir hacia Chaggu ----------
@Composable
fun ShareScreen(text: String, source: String, onBack: () -> Unit, onDone: (String) -> Unit) {
    val client = LocalClient.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var target by rememberSaveable { mutableStateOf<String?>(null) }
    SimpleScaffold(stringResource(R.string.share_title), onBack) {
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("share"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.share_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (text.isNotBlank()) Quote(text.take(400)) else EmptyNote(stringResource(R.string.share_empty))
            Text(stringResource(R.string.select_conversation), style = MaterialTheme.typography.labelLarge)
            ConversationPicker(data, target, { target = it })
        }
    }
    target?.let { t -> BringDialog(t, initialText = text, initialSource = source, onClose = { target = null }, onDone = { onDone(t) }) }
}

// ---------- Dominios de empresa (owner/admin) ----------
@Composable
fun DomainsScreen(orgId: String, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val org = Names.org(data, orgId)
    val admin = org?.myRole == "owner" || org?.myRole == "admin"
    var list by remember { mutableStateOf<List<OrgDomainDTO>?>(null) }
    var domain by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    suspend fun load() { runCatching { list = client.listDomains(orgId) }.onFailure { error = errorText(ctx, it); list = emptyList() } }
    LaunchedEffect(orgId) { if (admin) load() }
    SimpleScaffold(stringResource(R.string.dom_title), onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(org?.name ?: "", style = MaterialTheme.typography.titleMedium)
            if (org?.verification != null && org.verification != "none") Text("✓ " + stringResource(R.string.org_verified, org.verifiedDomain ?: ""), color = MaterialTheme.colorScheme.primary)
            if (!admin) { Text(stringResource(R.string.dom_only_admins)); return@Column }
            Text(stringResource(R.string.dom_hint), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(domain, { domain = it.trim() }, placeholder = { Text(stringResource(R.string.dom_add_ph)) }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done), modifier = Modifier.weight(1f).testTag("domainInput"))
                Spacer(Modifier.width(8.dp))
                Button(enabled = !busy && domain.length >= 3, onClick = {
                    busy = true; error = null
                    scope.launch { runCatching { client.addDomain(orgId, domain); domain = ""; load() }.onFailure { error = errorText(ctx, it) }; busy = false }
                }, modifier = Modifier.testTag("domainAdd")) { Text(stringResource(R.string.dom_add)) }
            }
            ErrorText(error)
            when {
                list == null -> CircularProgressIndicator()
                list!!.isEmpty() -> EmptyNote(stringResource(R.string.dom_empty))
                else -> list!!.forEach { d ->
                    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().testTag("domain-${d.domain}")) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(d.domain, fontWeight = FontWeight.SemiBold)
                            Text(stringResource(when (d.status) { "idp" -> R.string.dom_idp; "dns" -> R.string.dom_dns; else -> R.string.dom_pending }),
                                color = if (d.status == "pending") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall)
                            if (d.status == "pending") {
                                Text(stringResource(R.string.dom_txt, d.txtName, d.txtValue), style = MaterialTheme.typography.bodySmall, modifier = Modifier.clickable {
                                    copyToClipboard(ctx, d.txtValue); (ctx.applicationContext as com.tiecoms.app.TieComsApp).container.toast(ctx.getString(R.string.toast_copied))
                                })
                                OutlinedButton(onClick = { scope.launch { runCatching { client.verifyDomain(orgId, d.domain); load() }.onFailure { error = errorText(ctx, it) } } }) { Text(stringResource(R.string.dom_verify)) }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------- Eliminar cuenta ----------
@Composable
fun DeleteAccountScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    SimpleScaffold(stringResource(R.string.del_title), onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(16.dp).testTag("deleteAccount"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.del_intro), fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.error)
            Text(stringResource(R.string.del_what_goes))
            Text(stringResource(R.string.del_what_stays), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(email, { email = it }, label = { Text(stringResource(R.string.del_email)) }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next), modifier = Modifier.fillMaxWidth().testTag("delEmail"))
            PasswordField(password, { password = it }, stringResource(R.string.del_password), ImeAction.Done, {}, stringResource(R.string.del_password_hint), tag = "delPassword")
            ErrorText(error)
            Button(
                enabled = !busy && email.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                onClick = {
                    busy = true; error = null
                    scope.launch {
                        try {
                            client.deleteAccount(email, password.ifEmpty { null })
                            container.toast(ctx.getString(R.string.del_done))
                        } catch (e: ApiException) {
                            error = when (e.status) {
                                400 -> ctx.getString(R.string.del_email_mismatch)
                                403 -> ctx.getString(if (password.isEmpty()) R.string.del_password_needed else R.string.del_wrong_password)
                                else -> errorText(ctx, e)
                            }
                        } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("delConfirm"),
            ) { if (busy) CircularProgressIndicator(Modifier.width(22.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.del_button), fontWeight = FontWeight.SemiBold) }
        }
    }
}
