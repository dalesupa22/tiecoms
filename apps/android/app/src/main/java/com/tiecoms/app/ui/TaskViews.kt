package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.IssueDTO
import com.tiecoms.app.core.IssueTasks
import com.tiecoms.app.core.Names
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** «Solo Xertify» / «Privada» / «Todo el chat»: quién ve la tarea, en palabras. */
fun visibilityLabel(ctx: Context, d: BootstrapDTO?, i: IssueDTO): String = if (i.personal) ctx.getString(R.string.issue_personal_section) else when (i.visibility) {
    "org" -> ctx.getString(R.string.task_vis_org, Names.org(d, i.visibleOrgId)?.name ?: "")
    "private" -> ctx.getString(R.string.task_vis_private)
    else -> ctx.getString(R.string.task_vis_all)
}

/** Chapita «☑ 1/3», verde cuando están todas hechas. */
@Composable
fun KidsBadge(done: Int, total: Int, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val all = total > 0 && done == total
    Box(modifier.background(if (all) Color(0xFFD7F2E3) else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp))
        .semantics { this.contentDescription = ctx.getString(R.string.task_progress, done, total) }.padding(horizontal = 7.dp, vertical = 2.dp)) {
        Text("☑ $done/$total", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
            color = if (all) Color(0xFF14532D) else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Diálogos de tareas que se abren desde cualquier fila (menú del asunto, franja del sidechat). */
class TaskDialogs {
    var tasksFor by mutableStateOf<Pair<String, String?>?>(null)
    var sideFor by mutableStateOf<IssueDTO?>(null)
    fun openTasks(parentId: String, conversationId: String? = null) { tasksFor = parentId to conversationId }
    fun openSide(i: IssueDTO) { sideFor = i }
}

val LocalTaskDialogs = staticCompositionLocalOf { TaskDialogs() }

@Composable
fun TaskDialogsHost(onOpenIssue: (String) -> Unit = {}, content: @Composable () -> Unit) {
    val dialogs = remember { TaskDialogs() }
    CompositionLocalProvider(LocalTaskDialogs provides dialogs) {
        content()
        dialogs.tasksFor?.let { (p, c) -> TasksSheet(p, c, onClose = { dialogs.tasksFor = null }) }
        dialogs.sideFor?.let { SideFromIssueSheet(it, onClose = { dialogs.sideFor = null }) }
    }
}

/** Hoja «Tareas de «asunto»» (＋ Tarea derivada, la franja del sidechat o «Tarea del asunto»). */
@Composable
fun TasksSheet(parentId: String, conversationId: String?, onClose: () -> Unit) {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val container = LocalContainer.current
    LaunchedEffect(parentId) { if (st.issues[parentId] == null) runCatching { client.issueDetail(parentId) } }
    val parent = st.issues[parentId] ?: return
    val local = remember { androidx.compose.material3.SnackbarHostState() }
    FormSheet(stringResource(R.string.task_dialog_title, parent.title), onClose, tag = "tasksSheet", snackbar = local) {
        TasksSection(parentId, conversationId, onOpen = { id -> onClose(); container.pendingLink.value = com.tiecoms.app.core.DeepLink.Issue(id) })
    }
}

/** «Tareas · 1/3» dentro del asunto: la lista (lo que yo veo) y el alta. */
@Composable
fun TasksSection(parentId: String, conversationId: String?, onOpen: (String) -> Unit) {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val parent = st.issues[parentId] ?: return
    // Los asuntos personales no admiten tareas derivadas (el servidor responde 400).
    if (parent.personal) return
    val kids = IssueTasks.childrenOf(st.issues.values, parentId)
    val p = IssueTasks.progress(kids)
    Column(Modifier.fillMaxWidth().padding(top = 6.dp).testTag("tasksSection"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(stringResource(R.string.task_section) + if (kids.isNotEmpty()) " · ${p.done}/${p.total}" else "", style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
        kids.forEach { androidx.compose.runtime.key(it.id) { IssueRow(it, data, showWhere = false, child = true, onOpen = onOpen) } }
        if (!parent.closed) TaskQuickAdd(parent, conversationId)
        if (!parent.closed && kids.isEmpty()) Text(stringResource(R.string.task_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Alta de una tarea: título y la acción del teclado; «¿Quién lo hace?» (del chat o «＋ Otra persona») y
 * «¿Quién la ve?» (👁 Todo el chat / 🔒 Solo {empresa} / 🔒 Privada). Si la persona no está en el chat, la tarea
 * no puede ser de todo el chat y queda privada, con el aviso. En un sidechat, la ven solo los del sidechat.
 */
@Composable
fun TaskQuickAdd(parent: IssueDTO, conversationId: String?) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val snackbar = LocalSnackbar.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val where = conversationId ?: parent.conversationId
    val inSide = where != parent.conversationId
    val members = humansOf(data, where).sortedByDescending { it.id == data.me.id }
    var title by rememberSaveable(parent.id) { mutableStateOf("") }
    var owner by rememberSaveable(parent.id) { mutableStateOf(data.me.id) }
    var assignees by rememberSaveable(parent.id) { mutableStateOf(listOf<String>()) }
    var vis by rememberSaveable(parent.id) {
        mutableStateOf(if (inSide) "all" else IssueTasks.defaultVisibility(humansOf(data, parent.conversationId).map { it.orgId }, data.me.primaryOrgId))
    }
    var pickOther by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    val outsider = members.none { it.id == owner }
    val effective = IssueTasks.effectiveVisibility(vis, !outsider)
    val myOrg = Names.org(data, data.me.primaryOrgId)
    val contacts = data.people.filter { it.kind == "human" && it.id != data.me.id && members.none { m -> m.id == it.id } }
    val ownerP = Names.person(data, owner)
    fun submit() {
        val text = title.trim()
        if (text.length < 2 || busy) return
        busy = true
        scope.launch {
            try {
                client.createChildIssue(parent.id, text, owner, visibility = effective, conversationId = if (inSide) where else null, assigneeIds = (assignees + owner).distinct())
                title = ""; runCatching { focus.requestFocus() }
            } catch (e: Exception) { snackbar.showSnackbar(errorText(ctx, e)) } finally { busy = false }
        }
    }
    Column(Modifier.fillMaxWidth().testTag("taskAdd"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AssigneesPicker(members, (assignees + owner).distinct()) { assignees = it; owner = it.firstOrNull() ?: data.me.id }
        OutlinedTextField(title, { title = it.take(200).replace("\n", " ") }, placeholder = { Text(stringResource(R.string.task_ph)) },
            leadingIcon = { Text("＋", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }, singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("taskAddField"))
        AnimatedVisibility(title.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.issue_q_who), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    members.forEach { p ->
                        FilterChip(owner == p.id, { owner = p.id }, label = { Text(if (p.id == data.me.id) stringResource(R.string.issue_me) else IssueTasks.firstName(p.name)) },
                            leadingIcon = { PersonAvatar(p, data, size = 20.dp) }, modifier = Modifier.heightIn(min = 48.dp).testTag("taskOwner-${p.id}"))
                    }
                    if (outsider && ownerP != null) FilterChip(true, {}, label = { Text(IssueTasks.firstName(ownerP.name)) },
                        leadingIcon = { PersonAvatar(ownerP, data, size = 20.dp) }, modifier = Modifier.heightIn(min = 48.dp).testTag("taskOwner-${ownerP.id}"))
                    if (contacts.isNotEmpty()) Box {
                        FilterChip(false, { pickOther = true }, label = { Text("＋ " + stringResource(R.string.task_other_person)) }, modifier = Modifier.heightIn(min = 48.dp).testTag("taskOtherPerson"))
                        DropdownMenu(pickOther, { pickOther = false }) {
                            Text(stringResource(R.string.task_pick_person), style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                            contacts.forEach { p ->
                                DropdownMenuItem(text = { Text(p.name + " · " + (Names.org(data, p.orgId)?.name ?: stringResource(R.string.common_guest)), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                    leadingIcon = { PersonAvatar(p, data, size = 24.dp) }, onClick = { owner = p.id; pickOther = false }, modifier = Modifier.testTag("taskContact-${p.id}"))
                            }
                        }
                    }
                }
                Text(stringResource(R.string.task_who_sees), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val opts = if (inSide) listOf("all" to stringResource(R.string.task_vis_side), "private" to stringResource(R.string.task_vis_private))
                    else listOfNotNull("all" to stringResource(R.string.task_vis_all), myOrg?.let { "org" to stringResource(R.string.task_vis_org, it.name) }, "private" to stringResource(R.string.task_vis_private))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    opts.forEach { (v, label) ->
                        FilterChip(effective == v, { vis = v }, enabled = !(outsider && v == "all"), label = { Text((if (v == "all") "👁 " else "🔒 ") + label) },
                            modifier = Modifier.heightIn(min = 48.dp).testTag("taskVis-$v"))
                    }
                }
                if (outsider && ownerP != null) Text(stringResource(R.string.task_outsider_hint, IssueTasks.firstName(ownerP.name)), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("taskOutsiderHint"))
                Button(onClick = { submit() }, enabled = !busy && title.trim().length >= 2, modifier = Modifier.heightIn(min = 48.dp).testTag("taskAddSubmit")) { Text(stringResource(R.string.issue_add)) }
            }
        }
    }
}

/** «¿Quién la ve?» en el detalle de una tarea (solo quien la creó lo cambia). */
@Composable
fun VisibilityChoice(issue: IssueDTO) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val snackbar = LocalSnackbar.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val myOrg = Names.org(data, data.me.primaryOrgId)
    val opts = listOfNotNull("all" to stringResource(R.string.task_vis_all), myOrg?.let { "org" to stringResource(R.string.task_vis_org, it.name) }, "private" to stringResource(R.string.task_vis_private))
    Column(Modifier.fillMaxWidth().padding(top = 6.dp).testTag("taskVisibility"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.task_who_sees), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            opts.forEach { (v, label) ->
                FilterChip((issue.visibility ?: "all") == v, {
                    scope.launch { runCatching { client.updateIssue(issue.id, buildJsonObject { put("visibility", JsonPrimitive(v)) }) }.onFailure { snackbar.showSnackbar(errorText(ctx, it)) } }
                }, label = { Text((if (v == "all") "👁 " else "🔒 ") + label) }, modifier = Modifier.heightIn(min = 48.dp).testTag("vis-$v"))
            }
        }
    }
}

/** «💬 Hablar aparte»: un sidechat desde el asunto con quienes elija y un primer mensaje opcional. */
@Composable
fun SideFromIssueSheet(issue: IssueDTO, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    // Un asunto personal no tiene sidechat (no hay con quién hablarlo).
    val convId = issue.conversationId ?: run { LaunchedEffect(issue.id) { onClose() }; return }
    val others = humansOf(data, convId).filter { it.id != data.me.id }
    var picked by remember { mutableStateOf(listOf<String>()) }
    var question by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    FormSheet(stringResource(R.string.task_sidechat), onClose, tag = "sideFromIssue") {
        Text(stringResource(R.string.task_side_explain, issue.title), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            others.forEach { p ->
                FilterChip(p.id in picked, { picked = if (p.id in picked) picked - p.id else picked + p.id }, label = { Text(IssueTasks.firstName(p.name)) },
                    leadingIcon = { PersonAvatar(p, data, size = 20.dp) }, modifier = Modifier.heightIn(min = 48.dp).testTag("sidePick-${p.id}"))
            }
        }
        OutlinedTextField(question, { question = it.take(4000) }, placeholder = { Text(stringResource(R.string.task_side_first)) }, modifier = Modifier.fillMaxWidth().testTag("sideFirst"))
        ErrorText(error)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), modifier = Modifier.fillMaxWidth()) {
            TextButton(onClick = onClose) { Text(stringResource(R.string.cancel)) }
            Button(enabled = !busy && picked.isNotEmpty(), onClick = {
                busy = true; error = null
                container.scope.launch {
                    try {
                        val id = client.startSideFromIssue(convId, issue.id, picked, question)
                        onClose()
                        container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(id)
                    } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
                }
            }, modifier = Modifier.heightIn(min = 48.dp).testTag("sideGo")) { Text("💬 " + stringResource(R.string.task_side_go)) }
        }
    }
}

/** Franja en un sidechat que salió de un asunto: «◆ asunto · ☑ 1/3 · ＋ Tarea». */
@Composable
fun SideIssueStrip(sideId: String, issueId: String, onOpen: (String) -> Unit) {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val dialogs = LocalTaskDialogs.current
    LaunchedEffect(issueId) { if (st.issues[issueId] == null) runCatching { client.issueDetail(issueId) } }
    val parent = st.issues[issueId] ?: return
    val kids = IssueTasks.childrenOf(st.issues.values, issueId)
    val p = IssueTasks.progress(kids)
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth().testTag("sideIssueStrip")) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clickable { onOpen(issueId) }.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("◆ " + parent.title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
                if (kids.isNotEmpty()) { Spacer(Modifier.width(6.dp)); KidsBadge(p.done, p.total) }
            }
            TextButton(onClick = { dialogs.openTasks(issueId, sideId) }, modifier = Modifier.heightIn(min = 48.dp).testTag("sideAddTask")) { Text("＋ " + stringResource(R.string.task_short)) }
        }
    }
}
