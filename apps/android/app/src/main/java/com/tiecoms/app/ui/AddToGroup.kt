package com.tiecoms.app.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.InvitationCreatedDTO
import com.tiecoms.app.core.InviteLinkCache
import com.tiecoms.app.core.InviteRules
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PendingInvitationDTO
import com.tiecoms.app.core.PersonDTO
import com.tiecoms.app.core.TieComsClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

private fun inviteLang() = if (isSpanish()) "es" else "en"

/** Fecha de vencimiento del enlace; sin ella (servidor viejo), 14 días desde ahora. */
private fun expiryText(l: InvitationCreatedDTO) = dateText(l.expiresAt.ifBlank { java.time.Instant.now().plusSeconds(14L * 86400).toString() })

/** Crea la invitación del tipo elegido: por correo con [email]; sin él, el enlace de varios usos por 14 días. */
internal suspend fun createGroupInvite(
    client: TieComsClient, conv: ConversationDTO, kind: InviteRules.Kind, email: String?, history: String,
): InvitationCreatedDTO {
    val ws = conv.workspaceId ?: error("sin espacio")
    return when (kind) {
        is InviteRules.Kind.Mine -> client.inviteColleagueToGroup(kind.orgId, ws, conv.id, email, history, inviteLang())
        // Queda en su propia empresa al aceptar; la regla viral hace coadministradora a la primera de esa empresa.
        is InviteRules.Kind.Company -> client.inviteToGroup(ws, conv.id, "member", email, inviteLang(), history)
        InviteRules.Kind.Guest -> client.inviteToGroup(ws, conv.id, "guest", email, inviteLang(), history)
    }
}

/**
 * «Agregar al grupo» (SPEC-invitar, igual en web e iOS): buscador «Nombre o correo» arriba; candidatos con casilla,
 * «Ven solo lo nuevo / Ven el historial» y «Agregar (N)»; si lo escrito es un correo que no es de nadie, la fila
 * «✉ Invitar a {correo}»; abajo, «Invitar a alguien nuevo» con el tipo de persona, «Invitar por correo»,
 * «Copiar enlace» y «Compartir…», y las invitaciones pendientes de este grupo con Reenviar y Anular.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun AddMembersScreen(conversationId: String, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val conv = data.conversations.firstOrNull { it.id == conversationId }
    var query by rememberSaveable { mutableStateOf("") }
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var history by rememberSaveable { mutableStateOf("now") }
    var emailMode by rememberSaveable { mutableStateOf(false) }
    var kindKey by rememberSaveable { mutableStateOf<String?>(null) }
    var sent by rememberSaveable { mutableStateOf(listOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var link by remember { mutableStateOf<InvitationCreatedDTO?>(null) }
    var pending by remember { mutableStateOf(listOf<PendingInvitationDTO>()) }
    var pendingOpen by rememberSaveable { mutableStateOf(false) }
    val searchFocus = remember { FocusRequester() }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current

    SimpleScaffold(title = stringResource(R.string.dlg_add_to_group), onBack = onBack) {
        if (conv == null) { EmptyNote(stringResource(R.string.chat_not_found)); return@SimpleScaffold }
        val all = remember(data, conv) { InviteRules.candidates(data, conv) }
        val shown = remember(all, query) { InviteRules.filter(data, all, query) }
        val invitable = conv.workspaceId != null && conv.kind != "multi" && conv.kind != "direct"
        val canInvite = invitable && InviteRules.canInvite(data, conv)
        val kinds = remember(data, conv) { InviteRules.kinds(data, conv) }
        val kind = kinds.firstOrNull { it.key == kindKey } ?: InviteRules.defaultKind(data, conv, kinds)
        val emailRow = if (canInvite) InviteRules.emailToInvite(data, query) else null
        val groupName = titleOf(ctx, conv, data)
        val myOrgId = data.me.primaryOrgId

        /** Pendientes de este grupo: las del espacio y, de la empresa, las que entran aquí (cada colega ve las suyas). */
        suspend fun loadPending() {
            if (!invitable) return
            val out = mutableListOf<PendingInvitationDTO>()
            runCatching { client.pendingInvitations("workspaces", conv.workspaceId!!) }.onSuccess { out += InviteRules.pendingFor(it, conv.id) }
            if (myOrgId != null) runCatching { client.pendingInvitations("organizations", myOrgId) }
                .onSuccess { l -> out += l.filter { it.conversationIds?.contains(conv.id) == true } }
            pending = out.distinctBy { it.scope + it.id }
        }
        LaunchedEffect(conv.id) { loadPending() }

        fun sendEmail(email: String) {
            val k = kind ?: return
            busy = true; error = null
            focus.clearFocus() // en el hilo de la UI, antes de salir a la red
            scope.launch(Dispatchers.Main.immediate) {
                try {
                    createGroupInvite(client, conv, k, email, history)
                    sent = sent + email
                    container.toast(ctx.getString(R.string.ainv_sent, email))
                    loadPending()
                } catch (e: CancellationException) { throw e } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }

        /** Enlace vigente de este grupo y tipo (en memoria de la sesión) o uno nuevo. */
        suspend fun ensureLink(k: InviteRules.Kind): InvitationCreatedDTO =
            "${k.key}|$history".let { key -> InviteLinkCache.get(conv.id, key) ?: createGroupInvite(client, conv, k, null, history).also { InviteLinkCache.put(conv.id, key, it) } }

        fun shareTextOf(l: InvitationCreatedDTO) =
            InviteRules.shareText(ctx.getString(R.string.gshare_text), ctx.getString(R.string.gshare_text_nocode), groupName, l.url, l.code)

        fun copyLink(system: Boolean) {
            val k = kind ?: return
            busy = true; error = null
            scope.launch(Dispatchers.Main.immediate) {
                try {
                    val l = ensureLink(k)
                    link = l
                    val text = shareTextOf(l)
                    if (system) {
                        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                        runCatching { ctx.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    } else {
                        copyToClipboard(ctx, text)
                        container.toast(ctx.getString(R.string.ainv_copied, expiryText(l)))
                    }
                } catch (e: CancellationException) { throw e } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }

        OutlinedTextField(
            query, { query = it.take(254) },
            placeholder = { Text(stringResource(if (emailMode) R.string.ainv_search_email_ph else R.string.ainv_search_ph)) },
            singleLine = true, leadingIcon = { Icon(Icons.Filled.Search, null) },
            trailingIcon = if (query.isNotEmpty()) ({ IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, stringResource(R.string.common_remove)) } }) else null,
            keyboardOptions = KeyboardOptions(keyboardType = if (emailMode) KeyboardType.Email else KeyboardType.Text, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { emailRow?.let { if (it !in sent && !busy) sendEmail(it) } }),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).focusRequester(searchFocus).testTag("addSearch"),
        )
        LazyColumn(Modifier.fillMaxWidth().weight(1f).testTag("addList")) {
            if (emailRow != null) item(key = "emailRow") {
                EmailInviteRow(emailRow, emailRow in sent, busy, kinds, kind, onKind = { kindKey = it.key }, onSend = { sendEmail(emailRow) })
            }
            items(shown, key = { it.id }) { p ->
                CandidateRow(p, data, p.id in picked) { picked = if (p.id in picked) picked - p.id else picked + p.id }
            }
            if (shown.isEmpty() && all.isNotEmpty() && emailRow == null && query.isNotBlank()) item(key = "nobody") { EmptyNote(stringResource(R.string.chat_nobody)) }
            if (error != null) item(key = "err") { Column(Modifier.padding(horizontal = 16.dp)) { ErrorText(error) } }
            if (invitable) item(key = "invite") {
                InviteNewSection(
                    canInvite = canInvite, kinds = kinds, kind = kind, busy = busy, link = link,
                    onKind = { kindKey = it.key; link = null },
                    onByEmail = { emailMode = true; runCatching { searchFocus.requestFocus() } },
                    onCopy = { copyLink(false) }, onShare = { copyLink(true) },
                    onCopyCode = { c -> copyToClipboard(ctx, c); container.toast(ctx.getString(R.string.toast_copied)) },
                )
            }
            val sentOnly = sent.filter { e -> pending.none { it.email.equals(e, ignoreCase = true) } && e != emailRow }
            if (invitable && (pending.isNotEmpty() || sentOnly.isNotEmpty())) item(key = "pending") {
                PendingSection(pending, sentOnly, pendingOpen, onToggle = { pendingOpen = !pendingOpen },
                    onResend = { inv ->
                        scope.launch(Dispatchers.Main.immediate) {
                            try { client.resendInvitation(inv); container.toast(ctx.getString(R.string.ainv_resent, inv.email)); loadPending() }
                            catch (e: CancellationException) { throw e } catch (e: Exception) { container.toast(errorText(ctx, e)) }
                        }
                    },
                    onRevoke = { inv ->
                        scope.launch(Dispatchers.Main.immediate) {
                            try { client.revokeInvitation(inv); sent = sent - inv.email; container.toast(ctx.getString(R.string.ainv_revoked)); loadPending() }
                            catch (e: CancellationException) { throw e } catch (e: Exception) { container.toast(errorText(ctx, e)) }
                        }
                    })
            }
        }
        // Abajo, fijos: cómo entran (también para las invitaciones) y «Agregar (N)» si hay a quién sumar.
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (all.isNotEmpty() || canInvite) SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().testTag("addHistory")) {
                SegmentedButton(history == "now", { history = "now"; link = null }, SegmentedButtonDefaults.itemShape(0, 2), modifier = Modifier.testTag("historyNow")) {
                    Text(stringResource(R.string.ainv_see_new), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                SegmentedButton(history == "all", { history = "all"; link = null }, SegmentedButtonDefaults.itemShape(1, 2), modifier = Modifier.testTag("historyAll")) {
                    Text(stringResource(R.string.ainv_see_all), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (all.isNotEmpty()) Button(
                enabled = picked.isNotEmpty() && !busy,
                onClick = {
                    busy = true
                    scope.launch(Dispatchers.Main.immediate) {
                        try { client.addMembers(conversationId, picked, history); onBack() }
                        catch (e: CancellationException) { throw e } catch (e: Exception) { container.toast(errorText(ctx, e)) } finally { busy = false }
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("addMembersConfirm"),
            ) { Text(stringResource(R.string.ainv_add, picked.size), fontWeight = FontWeight.SemiBold) }
        }
    }
}

/** Candidato con casilla: «Nombre · Empresa» o «Nombre · Tercero invitado». */
@Composable
private fun CandidateRow(p: PersonDTO, data: BootstrapDTO, on: Boolean, onToggle: () -> Unit) {
    val org = Names.org(data, p.orgId)
    val where = if (p.guest || org == null) stringResource(R.string.common_guest) else org.name
    Row(
        Modifier.fillMaxWidth().toggleable(on, role = Role.Checkbox) { onToggle() }.heightIn(min = 60.dp).padding(horizontal = 12.dp, vertical = 6.dp).testTag("person-${p.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(on, null); Spacer(Modifier.width(6.dp))
        PersonAvatar(p, data, size = 40.dp, orgBadge = true)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(" · $where", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            val line = Names.roleLine(p)
            if (line.isNotBlank()) Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KindChips(kinds: List<InviteRules.Kind>, kind: InviteRules.Kind?, tagPrefix: String, onKind: (InviteRules.Kind) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag(tagPrefix)) {
        kinds.forEach { k ->
            FilterChip(
                selected = k.key == kind?.key, onClick = { onKind(k) },
                label = { Text(kindLabel(k), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                modifier = Modifier.testTag("$tagPrefix.${k.key}"),
            )
        }
    }
}

@Composable
private fun kindLabel(k: InviteRules.Kind): String = when (k) {
    is InviteRules.Kind.Mine -> stringResource(R.string.ainv_from, k.name)
    is InviteRules.Kind.Company -> stringResource(R.string.ainv_from, k.name)
    InviteRules.Kind.Guest -> stringResource(R.string.ainv_guest)
}

@Composable
private fun kindHint(k: InviteRules.Kind): String = when (k) {
    is InviteRules.Kind.Mine -> stringResource(R.string.ainv_hint_mine, k.name)
    is InviteRules.Kind.Company -> stringResource(R.string.ainv_hint_company, k.name)
    InviteRules.Kind.Guest -> stringResource(R.string.ainv_hint_guest)
}

/** Fila destacada «✉ Invitar a {correo}» con el tipo y «Enviar invitación»; ya enviada queda «Pendiente». */
@Composable
private fun EmailInviteRow(
    email: String, isSent: Boolean, busy: Boolean, kinds: List<InviteRules.Kind>, kind: InviteRules.Kind?,
    onKind: (InviteRules.Kind) -> Unit, onSend: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("emailInviteRow")) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("✉ " + stringResource(R.string.ainv_invite_email, email), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (isSent) PendingTag()
            }
            if (isSent) {
                Text(stringResource(R.string.ainv_sent, email), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.testTag("emailInviteSent"))
            } else {
                KindChips(kinds, kind, "emailKind", onKind)
                Button(onClick = onSend, enabled = !busy && kind != null, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("emailInviteSend")) {
                    Text(stringResource(R.string.ainv_send), fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun PendingTag() {
    Surface(color = androidx.compose.ui.graphics.Color(0xFFFFEBCC), shape = RoundedCornerShape(8.dp)) {
        Text(stringResource(R.string.ainv_pending_one), color = androidx.compose.ui.graphics.Color(0xFF7A4100), style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).testTag("pendingTag"))
    }
}

/** Sección fija «Invitar a alguien nuevo»: tipo de persona, por correo, copiar enlace y compartir. */
@Composable
private fun InviteNewSection(
    canInvite: Boolean, kinds: List<InviteRules.Kind>, kind: InviteRules.Kind?, busy: Boolean, link: InvitationCreatedDTO?,
    onKind: (InviteRules.Kind) -> Unit, onByEmail: () -> Unit, onCopy: () -> Unit, onShare: () -> Unit, onCopyCode: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).testTag("inviteNew"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HorizontalDivider()
        Text(stringResource(R.string.ainv_new), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
        if (!canInvite || kind == null) {
            Text(stringResource(R.string.ainv_members_only), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("membersOnly"))
            return@Column
        }
        Text(stringResource(R.string.ainv_kind), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        KindChips(kinds, kind, "inviteKind", onKind)
        Text(kindHint(kind), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("inviteKindHint"))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onByEmail, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("inviteByEmail")) {
                Text("✉ " + stringResource(R.string.ainv_by_email), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Button(onClick = onCopy, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("inviteCopyLink")) {
                Text("🔗 " + stringResource(R.string.ainv_copy_link), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        OutlinedButton(onClick = onShare, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("inviteShare")) {
            Text(stringResource(R.string.ainv_share))
        }
        if (link != null) {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().testTag("linkCopied")) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(stringResource(R.string.ainv_copied, expiryText(link)), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    val code = link.code
                    if (!code.isNullOrBlank()) Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.ainv_code, code), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f).testTag("linkCode"))
                        TextButton(onClick = { onCopyCode(code) }, modifier = Modifier.testTag("linkCopyCode")) { Text(stringResource(R.string.ainv_copy_code)) }
                    }
                }
            }
        }
    }
}

/** «Invitaciones pendientes (N)», plegado: correo, vencida o no, Reenviar y Anular (si puedo gestionarla). */
@Composable
private fun PendingSection(
    list: List<PendingInvitationDTO>, sentOnly: List<String>, open: Boolean, onToggle: () -> Unit,
    onResend: (PendingInvitationDTO) -> Unit, onRevoke: (PendingInvitationDTO) -> Unit,
) {
    val n = list.size + sentOnly.size
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("pendingSection")) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onToggle).heightIn(min = 48.dp).testTag("pendingToggle"), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.ainv_pending, n), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(if (open) "▾" else "▸", style = MaterialTheme.typography.titleMedium)
        }
        if (!open) return@Column
        sentOnly.forEach { e ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(e, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f)); PendingTag()
            }
        }
        list.forEach { inv ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("pending-${inv.id}"), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(inv.email, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (inv.expired) Text(stringResource(R.string.ainv_expired), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                }
                if (inv.canManage) {
                    TextButton(onClick = { onResend(inv) }, modifier = Modifier.testTag("pendingResend-${inv.id}")) { Text(stringResource(R.string.ainv_resend)) }
                    TextButton(onClick = { onRevoke(inv) }, modifier = Modifier.testTag("pendingRevoke-${inv.id}")) { Text(stringResource(R.string.ainv_revoke), color = MaterialTheme.colorScheme.error) }
                } else PendingTag()
            }
        }
    }
}
