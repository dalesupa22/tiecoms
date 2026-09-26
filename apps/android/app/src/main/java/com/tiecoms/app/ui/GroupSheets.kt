package com.tiecoms.app.ui

import android.content.Intent
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.CreateGroupResultDTO
import com.tiecoms.app.core.GroupsTree
import com.tiecoms.app.core.InviteCodes
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.OrganizationDTO
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.core.WorkspaceDTO
import kotlinx.coroutines.launch

/** Idioma de los correos de invitación: el de la app. */
private fun lang() = if (isSpanish()) "es" else "en"

private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

/** Correos separados por coma, punto y coma o espacio: (válidos, inválidos). */
internal fun parseEmails(raw: String): Pair<List<String>, List<String>> {
    val all = raw.split(Regex("[,;\\s]+")).map { it.trim() }.filter { it.isNotEmpty() }.distinctBy { it.lowercase() }
    return all.partition { EMAIL.matches(it) }
}

/**
 * Cómo se abre «Nuevo grupo»: [company] marca «Con otra empresa»; [relationId] deja puesta una relación
 * (GroupsTree.Relation.id) y [workspaceId] un espacio concreto («Nuevo grupo aquí»).
 */
data class NewGroupPreset(val company: Boolean = false, val relationId: String? = null, val workspaceId: String? = null)

private const val NEW_COMPANY = "_new"

/**
 * Nuevo grupo (el «+» de Grupos, docs/GRUPOS.md): una sola hoja con títulos visibles en cada campo.
 * ¿Para quién es? → Empresa (relaciones, pendientes o «Empresa nueva…») → Espacio si hay varios → Nombre →
 * Personas → Invitar de fuera con rol → Crear enlace. Envía POST /groups; [onCreated] recibe la respuesta.
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun NewGroupSheet(preset: NewGroupPreset, onClose: () -> Unit, onCreated: (CreateGroupResultDTO, String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val myOrg = Names.org(data, data.me.primaryOrgId)
    val myName = myOrg?.name ?: stringResource(R.string.common_no_company)
    // Relaciones donde no soy tercero (los terceros no crean grupos).
    val choices = remember(data) {
        GroupsTree.companyChoices(data).map { r -> r.copy(workspaces = r.workspaces.filter { it.myRole != "guest" }) }.filter { it.workspaces.isNotEmpty() }
    }
    // «Nuevo grupo aquí»: un espacio de una relación deja la relación puesta; uno de mi empresa (no casa) queda fijo.
    val presetWs = preset.workspaceId?.let { id -> data.workspaces.firstOrNull { it.id == id } }
    val presetRelation = preset.relationId ?: presetWs?.let { w -> choices.firstOrNull { r -> r.workspaces.any { it.id == w.id } }?.id }
    val fixedOwnWs = presetWs?.takeIf { presetRelation == null && !it.isOrgHome }
    var company by rememberSaveable { mutableStateOf(preset.company || presetRelation != null) }
    var relationId by rememberSaveable { mutableStateOf(presetRelation ?: choices.firstOrNull()?.id ?: NEW_COMPANY) }
    var wsId by rememberSaveable { mutableStateOf(presetWs?.id) }
    var newCompany by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var emails by rememberSaveable { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf("member") }
    var shareLink by rememberSaveable { mutableStateOf(company) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val relation = if (company) choices.firstOrNull { it.id == relationId } else null
    val ws = relation?.let { r -> r.workspaces.firstOrNull { it.id == wsId } ?: r.workspaces.first() }
    val companyName = when {
        !company -> myName
        relation != null -> relation.org?.name ?: relation.pendingName ?: ""
        else -> newCompany.trim()
    }
    // Personas: en una relación existente, las del espacio; si no, mis colegas.
    val candidates = remember(data, ws?.id, company, fixedOwnWs?.id) {
        val base = when {
            company && ws != null -> ws.memberIds.mapNotNull { Names.person(data, it) }
            fixedOwnWs != null -> fixedOwnWs.memberIds.mapNotNull { Names.person(data, it) }
            else -> data.people.filter { it.orgId != null && it.orgId == data.me.primaryOrgId && !it.guest }
        }
        base.filter { it.kind == "human" && it.id != data.me.id }.sortedBy { it.name.lowercase() }
    }
    LaunchedEffect(candidates) { picked = picked.filter { id -> candidates.any { it.id == id } } }

    FormSheet(stringResource(R.string.grp_new), onClose, tag = "newGroupSheet") {
        // 1. ¿Para quién es?
        if (fixedOwnWs == null) {
            FieldTitle(stringResource(R.string.grp_for_whom))
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().testTag("groupForWhom")) {
                listOf(false to (stringResource(R.string.grp_only_mine, myName) to stringResource(R.string.grp_only_mine_hint)),
                    true to (stringResource(R.string.grp_with_company) to stringResource(R.string.grp_with_company_hint))).forEachIndexed { i, (v, labels) ->
                    SegmentedButton(
                        selected = company == v, onClick = { company = v; shareLink = v; if (!v) role = "member" },
                        shape = SegmentedButtonDefaults.itemShape(i, 2), icon = {},
                        modifier = Modifier.heightIn(min = 56.dp).testTag(if (v) "forCompany" else "forMine"),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(labels.first, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                            Text(labels.second, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        } else {
            FieldTitle(stringResource(R.string.grp_space))
            Text(fixedOwnWs.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("groupFixedSpace"))
        }

        // 2. Empresa (y espacio si la relación tiene varios).
        if (company) {
            FieldTitle(stringResource(R.string.grp_company))
            Column(Modifier.fillMaxWidth().testTag("companyPicker")) {
                choices.forEach { r ->
                    ChoiceRow(relationId == r.id, onClick = { relationId = r.id; wsId = null }, tag = "company-" + r.id) {
                        OrgMark(r.org ?: OrganizationDTO(name = r.pendingName ?: "?", colorBg = "#BDB5AE"), size = 22.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(r.org?.name ?: r.pendingName ?: "", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (r.pending) { Spacer(Modifier.width(6.dp)); PendingPill() }
                    }
                }
                ChoiceRow(relationId == NEW_COMPANY, onClick = { relationId = NEW_COMPANY }, tag = "company-new") {
                    Text(stringResource(R.string.grp_company_new), style = MaterialTheme.typography.bodyLarge)
                }
            }
            if (relationId == NEW_COMPANY) OutlinedTextField(newCompany, { newCompany = it.take(120) }, label = { Text(stringResource(R.string.grp_company_name)) },
                singleLine = true, modifier = Modifier.fillMaxWidth().testTag("newCompanyName"))
            if (relation != null && relation.workspaces.size > 1 && ws != null) {
                Dropdown(stringResource(R.string.grp_space), relation.workspaces.map { it.id to it.name }, ws.id, { wsId = it }, tag = "groupSpace")
            }
        }

        // 3. Nombre del grupo.
        FieldTitle(stringResource(R.string.grp_name))
        OutlinedTextField(name, { name = it.take(120) }, placeholder = { Text(stringResource(R.string.grp_name_ph)) }, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("groupName"))

        // 4. Personas de mi empresa (o del espacio, en una relación existente).
        val peopleTitle = if (company && ws != null || fixedOwnWs != null) stringResource(R.string.grp_people_space) else stringResource(R.string.grp_people_of, myName)
        FieldTitle(peopleTitle + if (picked.isNotEmpty()) " · ${picked.size}" else "")
        if (candidates.isEmpty()) Text(stringResource(R.string.grp_nobody), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.fillMaxWidth().testTag("groupPeople")) {
            candidates.forEach { p -> PersonPickRow(p, data, p.id in picked) { picked = if (p.id in picked) picked - p.id else picked + p.id } }
        }

        // 5. Invitar de fuera (opcional).
        FieldTitle(stringResource(R.string.grp_invite_outside))
        OutlinedTextField(emails, { emails = it.take(2000) }, placeholder = { Text(stringResource(R.string.grp_emails_ph)) },
            supportingText = { Text(stringResource(R.string.grp_emails_help)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth().testTag("groupEmails"))
        if (company) {
            val other = companyName.ifBlank { stringResource(R.string.grp_other_company) }
            ChoiceRow(role == "member", onClick = { role = "member" }, tag = "roleMember") { Text(stringResource(R.string.grp_role_member_of, other), style = MaterialTheme.typography.bodyLarge) }
            ChoiceRow(role == "guest", onClick = { role = "guest" }, tag = "roleGuest") { Text(stringResource(R.string.grp_role_guest_own), style = MaterialTheme.typography.bodyLarge) }
        } else Text(stringResource(R.string.grp_guest_notice), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("guestNotice"))

        // 6. Crear enlace para compartir.
        Row(Modifier.fillMaxWidth().toggleable(shareLink, role = Role.Switch) { shareLink = it }.heightIn(min = 56.dp).testTag("groupShareLink"), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.grp_share_link), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text(stringResource(R.string.grp_share_link_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(8.dp))
            Switch(shareLink, null)
        }

        ErrorText(error)
        val valid = name.trim().length >= 2 && (!company || relation != null || newCompany.trim().length >= 2)
        DialogButtons(onClose, stringResource(if (busy) R.string.grp_creating else R.string.grp_create), enabled = valid && !busy, confirmTag = "createGroup") {
            val (ok, bad) = parseEmails(emails)
            if (bad.isNotEmpty()) { error = ctx.getString(R.string.grp_bad_emails, bad.joinToString(", ")); return@DialogButtons }
            val target = when {
                fixedOwnWs != null -> TieComsClient.GroupTarget.Workspace(fixedOwnWs.id)
                !company -> TieComsClient.GroupTarget.Org(data.me.primaryOrgId)
                ws != null -> TieComsClient.GroupTarget.Workspace(ws.id)
                else -> TieComsClient.GroupTarget.Company(newCompany.trim(), data.me.primaryOrgId)
            }
            busy = true; error = null
            val groupName = name.trim()
            scope.launch {
                try {
                    // En «Solo mi empresa» quien viene de fuera entra como tercero.
                    val r = client.createGroup(groupName, target, picked, ok, if (company) role else "guest", shareLink, lang())
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { onCreated(r, groupName) }
                } catch (e: kotlinx.coroutines.CancellationException) { throw e }
                catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
            }
        }
    }
}

@Composable
private fun FieldTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp).semantics { heading() })
}

@Composable
private fun ChoiceRow(selected: Boolean, onClick: () -> Unit, tag: String, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().selectable(selected, role = Role.RadioButton, onClick = onClick).heightIn(min = 48.dp).testTag(tag), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, null)
        Spacer(Modifier.width(8.dp))
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, content = content)
    }
}

@Composable
private fun PendingPill() {
    Surface(color = androidx.compose.ui.graphics.Color(0xFFFFEBCC), shape = RoundedCornerShape(8.dp)) {
        Text(stringResource(R.string.grp_pending), color = androidx.compose.ui.graphics.Color(0xFF7A4100), style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

// ---------- Compartir el enlace y el código ----------
/**
 * Pantalla de compartir: el código en grande con Copiar, el enlace con Copiar, el Compartir del sistema
 * («Te invito a {grupo} en TieComs: {url} (código {code})») y la fecha de vencimiento. «Listo» cierra.
 */
@Composable
fun ShareInviteSheet(groupName: String, url: String, code: String?, expiresAt: String?, onDone: () -> Unit) {
    FormSheet(stringResource(R.string.gshare_title), onDone, tag = "shareInvite") { ShareInviteContent(groupName, url, code, expiresAt, onDone) }
}

@Composable
private fun ShareInviteContent(groupName: String, url: String, code: String?, expiresAt: String?, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val copied = stringResource(R.string.toast_copied)
    // Sin fecha del servidor (POST /groups no la trae): el enlace vale 14 días desde ahora.
    val expires = expiresAt?.let { dateText(it) } ?: dateText(java.time.Instant.now().plusSeconds(14L * 86400).toString())
    Text(groupName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    if (!code.isNullOrBlank()) {
        FieldTitle(stringResource(R.string.gshare_code))
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(code, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 32.sp, letterSpacing = 2.sp,
                    modifier = Modifier.weight(1f).testTag("inviteCode"))
                OutlinedButton(onClick = { copyToClipboard(ctx, code); container.scope.launch { container.toast(copied) } }, modifier = Modifier.testTag("copyCode")) {
                    Text(stringResource(R.string.gshare_copy))
                }
            }
        }
    }
    FieldTitle(stringResource(R.string.gshare_link))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(url, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).testTag("inviteUrl"))
        TextButton(onClick = { copyToClipboard(ctx, url); container.scope.launch { container.toast(copied) } }, modifier = Modifier.testTag("copyLink")) { Text(stringResource(R.string.gshare_copy)) }
    }
    Button(
        onClick = {
            val text = if (code.isNullOrBlank()) ctx.getString(R.string.gshare_text_nocode, groupName, url) else ctx.getString(R.string.gshare_text, groupName, url, code)
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            runCatching { ctx.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        },
        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("shareSystem"),
    ) { Text(stringResource(R.string.gshare_system), fontWeight = FontWeight.SemiBold) }
    Text(stringResource(R.string.gshare_expires, expires), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    OutlinedButton(onClick = onDone, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("shareDone")) { Text(stringResource(R.string.gshare_done)) }
}

// ---------- Invitar ----------
/** A qué se invita: un grupo, un espacio (la relación, sin grupo) o mi empresa (colegas por correo). */
sealed interface InviteTarget {
    data class Group(val ws: WorkspaceDTO, val conv: ConversationDTO) : InviteTarget
    data class Space(val ws: WorkspaceDTO, val label: String) : InviteTarget
    data class Org(val org: OrganizationDTO) : InviteTarget
}

/**
 * «Invitar a {grupo}» (docs/GRUPOS.md): rol persona de otra empresa (member) o tercero (guest; en Tu
 * organización solo tercero), por correo o con enlace y código de varios usos. También sirve para invitar
 * a la relación (espacio) y a mi empresa (solo por correo).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InviteSheet(target: InviteTarget, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data
    val title = when (target) {
        is InviteTarget.Group -> titleOf(ctx, target.conv, data)
        is InviteTarget.Space -> target.label
        is InviteTarget.Org -> target.org.name
    }
    val orgHome = target is InviteTarget.Group && target.ws.isOrgHome
    var role by rememberSaveable { mutableStateOf(if (orgHome) "guest" else "member") }
    var email by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var link by remember { mutableStateOf<com.tiecoms.app.core.InvitationCreatedDTO?>(null) }

    val made = link
    if (made != null) {
        ShareInviteSheet(title, made.url, made.code, made.expiresAt.ifBlank { null }, onDone = onClose)
        return
    }
    FormSheet(stringResource(R.string.ginv_title, title), onClose, tag = "inviteSheet") {
        when (target) {
            is InviteTarget.Group -> {
                FieldTitle(stringResource(R.string.ginv_role))
                if (orgHome) Text(stringResource(R.string.ginv_org_home), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("inviteOrgHome"))
                else {
                    ChoiceRow(role == "member", onClick = { role = "member" }, tag = "inviteRoleMember") { Text(stringResource(R.string.ginv_role_member), style = MaterialTheme.typography.bodyLarge) }
                    ChoiceRow(role == "guest", onClick = { role = "guest" }, tag = "inviteRoleGuest") { Text(stringResource(R.string.ginv_role_guest), style = MaterialTheme.typography.bodyLarge) }
                }
            }
            is InviteTarget.Space -> Text(stringResource(R.string.ginv_space_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            is InviteTarget.Org -> Text(stringResource(R.string.ginv_colleague_hint, target.org.name), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        HorizontalDivider()
        FieldTitle(stringResource(R.string.ginv_by_email))
        OutlinedTextField(email, { email = it.take(2000) }, label = { Text(stringResource(R.string.ginv_email)) }, placeholder = { Text(stringResource(R.string.grp_emails_ph)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth().testTag("inviteEmail"))
        ErrorText(error)
        Button(
            enabled = !busy && email.isNotBlank(),
            onClick = {
                val (ok, bad) = parseEmails(email)
                if (bad.isNotEmpty() || ok.isEmpty()) { error = ctx.getString(R.string.grp_bad_emails, bad.joinToString(", ")); return@Button }
                busy = true; error = null
                scope.launch {
                    try {
                        // Un POST por correo, como el diálogo de invitar de la web.
                        for (e in ok) when (target) {
                            is InviteTarget.Group -> client.inviteToGroup(target.ws.id, target.conv.id, role, e, lang())
                            is InviteTarget.Space -> client.inviteToGroup(target.ws.id, null, "member", e, lang())
                            is InviteTarget.Org -> client.inviteToOrg(target.org.id, e, lang())
                        }
                        container.toast(ctx.getString(R.string.ginv_sent, ok.joinToString(", ")))
                        onClose()
                    } catch (e: kotlinx.coroutines.CancellationException) { throw e }
                    catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
                }
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("inviteSend"),
        ) { Text(stringResource(R.string.ginv_send)) }
        if (target !is InviteTarget.Org) {
            HorizontalDivider()
            FieldTitle(stringResource(R.string.ginv_link))
            Text(stringResource(R.string.ginv_link_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(
                enabled = !busy,
                onClick = {
                    busy = true; error = null
                    scope.launch {
                        try {
                            link = when (target) {
                                is InviteTarget.Group -> client.inviteToGroup(target.ws.id, target.conv.id, role, null, lang())
                                is InviteTarget.Space -> client.inviteToGroup(target.ws.id, null, "member", null, lang())
                                is InviteTarget.Org -> null
                            }
                        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
                        catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("inviteLink"),
            ) { Text(stringResource(R.string.ginv_link_create)) }
        }
    }
}

// ---------- Unirme con código ----------
/** Campo para XXXX-XXXX (acepta minúsculas, espacios y sin guion). [onGo] recibe el código normalizado. */
@Composable
fun JoinCodeDialog(onClose: () -> Unit, onGo: (String) -> Unit) {
    var raw by rememberSaveable { mutableStateOf("") }
    var bad by remember { mutableStateOf(false) }
    fun go() { val c = InviteCodes.normalize(raw); if (c == null) bad = true else onGo(c) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(stringResource(R.string.join_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.join_hint))
                OutlinedTextField(raw, { raw = it.take(20); bad = false }, placeholder = { Text(stringResource(R.string.join_ph)) }, singleLine = true,
                    isError = bad, supportingText = if (bad) ({ Text(stringResource(R.string.join_bad)) }) else null,
                    textStyle = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace, textAlign = TextAlign.Center),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii,
                        imeAction = androidx.compose.ui.text.input.ImeAction.Go),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = { go() }),
                    modifier = Modifier.fillMaxWidth().testTag("joinCode"))
            }
        },
        confirmButton = { TextButton(onClick = { go() }, enabled = raw.isNotBlank(), modifier = Modifier.testTag("joinGo")) { Text(stringResource(R.string.join_go)) } },
        dismissButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.cancel)) } },
    )
}
