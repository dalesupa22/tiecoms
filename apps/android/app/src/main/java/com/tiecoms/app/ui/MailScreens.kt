package com.tiecoms.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.Mail
import com.tiecoms.app.core.MailAttachmentInfoDTO
import com.tiecoms.app.core.MailConnectionDTO
import com.tiecoms.app.core.MailListItemDTO
import com.tiecoms.app.core.MailMessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.SharedMailCommentDTO
import com.tiecoms.app.core.SharedMailDTO
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.core.WaChatDTO
import com.tiecoms.app.core.WaMessageDTO
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/*
 * Correo en el chat (docs/CORREO.md), pantallas: la lista en vivo con búsqueda y filtros, la vista previa y el paso de
 * compartir, el correo abierto con su hilo y el compositor de dos modos (comentar al equipo / responder), la tarea desde el
 * correo, conectar Gmail u Outlook, la invitación de Inicio y «Comentar en chaggu…» desde WhatsApp.
 */

// ---------- Adjuntos bajo demanda ----------
/** Baja el adjunto del buzón de quien compartió (con Bearer), lo guarda en caché y lo abre con otra app (FileProvider). */
suspend fun openMailAttachment(ctx: Context, client: TieComsClient, emailId: String, a: MailAttachmentInfoDTO) {
    val dir = File(ctx.cacheDir, "att/mail-$emailId-${a.id.hashCode().toUInt()}").apply { mkdirs() }
    val f = File(dir, com.tiecoms.app.platform.ShareIntake.safeName(a.name, a.contentType, 0))
    try {
        if (!f.exists() || f.length() == 0L) {
            Toast.makeText(ctx, R.string.web_mail_openAttachment, Toast.LENGTH_SHORT).show()
            client.downloadMailAttachment(emailId, a.id, f)
        }
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, a.contentType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ctx.startActivity(Intent.createChooser(view, ctx.getString(R.string.att_open_with)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(ctx, R.string.att_no_app, Toast.LENGTH_SHORT).show()
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        // 409 attachment_unavailable: «… desconectó su correo. Pídeselo a …» (el mensaje del API).
        Toast.makeText(ctx, errorText(ctx, e), Toast.LENGTH_LONG).show()
    }
}

// ---------- Tarea desde el correo ----------
@Composable
fun MailTaskSheet(e: SharedMailDTO, data: BootstrapDTO, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val conv = data.conversations.firstOrNull { it.id == e.conversationId }
    val prefix = stringResource(R.string.web_mail_taskPrefix)
    var title by rememberSaveable(e.id) { mutableStateOf(Mail.taskTitle(e, prefix)) }
    var owner by rememberSaveable(e.id) { mutableStateOf<String?>(data.me.id) }
    var due by remember(e.id) { mutableStateOf<LocalDate?>(null) }
    var close by rememberSaveable(e.id) { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    FormSheet(stringResource(R.string.web_mail_taskTitle), onClose, tag = "mailTaskSheet") {
        OutlinedTextField(title, { title = it.take(200) }, label = { Text(stringResource(R.string.web_mail_taskName)) }, modifier = Modifier.fillMaxWidth().testTag("mailTaskName"))
        val people = (conv?.memberIds ?: listOf(data.me.id)).map { it to (Names.person(data, it)?.name ?: it) }
        Dropdown(stringResource(R.string.web_mail_taskOwner), listOf<Pair<String?, String>>(null to stringResource(R.string.web_mail_taskNoOwner)) + people, owner, { owner = it }, tag = "mailTaskOwner")
        DateField(stringResource(R.string.web_mail_taskDue), due, { due = it }, allowClear = true, modifier = Modifier.fillMaxWidth(), tag = "mailTaskDue")
        Row(Modifier.fillMaxWidth().clickable(role = Role.Checkbox) { close = !close }.testTag("mailTaskClose"), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(close, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.web_mail_taskClose), style = MaterialTheme.typography.bodyMedium)
        }
        Text(stringResource(R.string.web_mail_taskHint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        DialogButtons(onClose, stringResource(R.string.web_mail_taskCreate), enabled = !busy && title.trim().length >= 2, confirmTag = "mailTaskCreate") {
            busy = true
            container.scope.launch {
                runCatching { client.mailTask(e.id, title.trim(), owner, due?.toString(), close) }
                    .onSuccess { container.toast(ctx.getString(R.string.web_mail_taskCreated)); onClose() }
                    .onFailure { container.toast(errorText(ctx, it)) }
                busy = false
            }
        }
    }
}

// ---------- El correo abierto: leer, comentar, responder o programar ----------
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MailDetailScreen(id: String, mode: String, onBack: () -> Unit, onOpenIssue: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val e = st.mails[id]
    var missing by remember(id) { mutableStateOf(false) }
    // La tarjeta llega sin cuerpo: se pide al abrir. Mientras carga se ve el snippet.
    LaunchedEffect(id) {
        runCatching { client.loadSharedMailFull(id) }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; if (client.state.value.mails[id] == null) missing = true }
    }
    var tab by rememberSaveable(id) { mutableStateOf(if (mode == "reply") "reply" else "comment") }
    var bodyOpen by rememberSaveable(id) { mutableStateOf(mode == "read") }
    var orig by remember(id) { mutableStateOf<String?>(null) }
    var origBusy by remember { mutableStateOf(false) }
    var task by remember { mutableStateOf(false) }
    // El correo con su diseño (GET /mail/shared/:id/html). Si no tiene HTML, falla o el API aún no lo tiene (404), queda el texto.
    var html by remember(id) { mutableStateOf(MailHtmlCache.get(id)) }
    var asText by rememberSaveable(id) { mutableStateOf(false) }
    val wantsHtml = e != null && !e.isWhatsApp
    LaunchedEffect(id, wantsHtml) {
        if (!wantsHtml || MailHtmlCache.has(id)) return@LaunchedEffect
        val got = try { client.mailHtml(id) } catch (c: kotlinx.coroutines.CancellationException) { throw c } catch (_: Exception) { null }
        MailHtmlCache.put(id, got); html = got
    }
    val mine = e?.sharedBy == data.me.id
    // WhatsApp no se responde desde chaggu: solo comentarios y tarea.
    val canReplyHere = mine && e?.isWhatsApp == false
    val conv = e?.let { m -> data.conversations.firstOrNull { it.id == m.conversationId } }
    val list = rememberLazyListState()
    val title = (if (e?.isWhatsApp == true) e.wa?.chatName else null) ?: e?.subject?.ifBlank { null } ?: stringResource(if (e == null) R.string.web_mail_title else R.string.web_mail_noSubject)
    SimpleScaffold(title, onBack, actions = {
        val link = if (mine) e?.webLink else null
        if (link != null) TextButton(onClick = { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } },
            modifier = Modifier.testTag("mailOpenIn")) { Text(stringResource(R.string.web_mail_openIn, Mail.label(e!!.provider)) + " ↗") }
    }) {
        if (e == null) { EmptyNote(stringResource(if (missing) R.string.web_mail_unavailable else R.string.loading)); return@SimpleScaffold }
        var comments by remember(id) { mutableStateOf<List<SharedMailCommentDTO>?>(null) }
        LaunchedEffect(id, e.commentCount) { comments = runCatching { client.mailComments(id) }.getOrElse { e.lastComments } }
        LaunchedEffect(comments != null) { if (mode == "comments" && comments != null) list.animateScrollToItem(1) }
        // Al llegar un comentario nuevo (mío o en vivo), el hilo baja hasta él.
        var seenComments by remember(id) { mutableIntStateOf(-1) }
        LaunchedEffect(comments?.size) {
            val n = comments?.size ?: return@LaunchedEffect
            if (seenComments in 0 until n) list.animateScrollToItem(maxOf(0, list.layoutInfo.totalItemsCount - 1))
            seenComments = n
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("mailDetail"), state = list) {
            item {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        SrcIcon(e.provider, 20.dp, Modifier.align(Alignment.CenterVertically))
                        Box(Modifier.align(Alignment.CenterVertically)) { MailStatusPill(e, data) }
                        if (e.issueId != null) TextButton(onClick = { onOpenIssue(e.issueId) }, modifier = Modifier.testTag("mailSeeTask")) { Text("◆ " + stringResource(R.string.web_mail_seeTask)) }
                        else if (conv?.canPost == true) TextButton(onClick = { task = true }, modifier = Modifier.testTag("mailTask")) { Text("◆ " + stringResource(R.string.web_mail_task)) }
                        if (e.scheduledReply != null) TextButton(onClick = {
                            container.scope.launch {
                                runCatching { client.cancelMailReply(e.id) }.onSuccess { container.toast(ctx.getString(R.string.web_mail_scheduleCancelled)) }.onFailure { container.toast(errorText(ctx, it)) }
                            }
                        }, modifier = Modifier.testTag("mailCancelSchedule")) { Text(stringResource(R.string.web_mail_cancelSchedule)) }
                    }
                    MailMeta(e.from, e.to, e.cc, e.sentAt, e.provider)
                    val design = html?.takeIf { !asText && orig == null && !e.isWhatsApp }
                    if (design != null) Surface(color = Color.White, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                        MailHtmlView(design, client.baseUrl)
                    } else Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                        val tagBody = Modifier.padding(12.dp).testTag(if (e.full) "mailBody" else "mailBodyLoading")
                        val lines = if (bodyOpen || orig != null) Int.MAX_VALUE else 10
                        // WhatsApp es texto de un chat: se deja tal cual. El correo va sin «alt [http://…png]» y con «dominio ↗».
                        val raw = orig ?: if (e.full) e.body.takeIf { it.isNotBlank() } else null
                        if (raw != null && !e.isWhatsApp) MailBodyText(raw, lines, tagBody)
                        else Text(raw ?: if (e.full) stringResource(R.string.web_mail_noBody) else (if (e.isWhatsApp) e.snippet else com.tiecoms.app.core.MailText.snippet(e.snippet)) + "…",
                            style = MaterialTheme.typography.bodyMedium, maxLines = lines, overflow = TextOverflow.Ellipsis, modifier = tagBody)
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (html != null && orig == null && !e.isWhatsApp) TextButton(onClick = { asText = !asText }, modifier = Modifier.testTag("mailAsText")) {
                            Text(stringResource(if (asText) R.string.web_mail_asDesign else R.string.web_mail_asText))
                        }
                        val textShown = design == null
                        if (textShown && e.full && orig == null && e.body.length > 400) TextButton(onClick = { bodyOpen = !bodyOpen }) { Text(stringResource(if (bodyOpen) R.string.web_mail_less else R.string.web_mail_moreBody)) }
                        if (textShown && e.full && e.trimmed && orig == null) TextButton(enabled = !origBusy, onClick = {
                            origBusy = true
                            container.scope.launch {
                                runCatching { client.mailOriginal(id) }.onSuccess { orig = it; bodyOpen = true }.onFailure { container.toast(errorText(ctx, it)) }
                                origBusy = false
                            }
                        }, modifier = Modifier.testTag("mailShowHistory")) { Text(if (origBusy) stringResource(R.string.loading) else stringResource(R.string.web_mail_showHistory)) }
                        if (orig != null) TextButton(onClick = { orig = null }, modifier = Modifier.testTag("mailHideHistory")) { Text(stringResource(R.string.web_mail_hideHistory)) }
                    }
                    if (e.attachments.isNotEmpty()) {
                        Text(stringResource(R.string.web_mail_attachmentsOnDemand, Mail.label(e.provider)).uppercase(), style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        e.attachments.forEach { a -> AttachmentRow(e.id, a) }
                    }
                }
            }
            item {
                Text(stringResource(R.string.web_mail_thread).uppercase() + if (e.commentCount > 0) " · ${e.commentCount}" else "", style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() }.testTag("mailThread"))
            }
            e.comment?.takeIf { it.isNotBlank() }?.let { c -> item(key = "shared") { CommentRow(e.sharedBy, c, e.createdAt, data) } }
            val cs = comments
            if (cs == null) item { Text(stringResource(R.string.loading), Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            else if (cs.isEmpty() && e.comment.isNullOrBlank()) item { Text(stringResource(R.string.web_mail_noComments), Modifier.padding(16.dp).testTag("mailNoComments"), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            else items(cs, key = { it.id }) { c -> CommentRow(c.authorId, c.body, c.createdAt, data) }
        }
        if (conv?.canPost == true) {
            HorizontalDivider()
            Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val otherName = Mail.firstName(Mail.other(e)).ifBlank { "…" }
                if (canReplyHere) Segmented(listOf("comment" to "💬 " + stringResource(R.string.web_mail_toTeam), "reply" to "✉ " + stringResource(R.string.web_mail_replyTo, otherName)),
                    tab, { tab = it }, Modifier.fillMaxWidth().testTag("mailComposerMode"))
                if (tab == "reply" && canReplyHere) ReplyBox(e, onSent = onBack) else CommentBox(e)
            }
        }
    }
    if (task && e != null) MailTaskSheet(e, data, onClose = { task = false })
}

@Composable
private fun MailMeta(from: com.tiecoms.app.core.MailAddressDTO?, to: List<com.tiecoms.app.core.MailAddressDTO>, cc: List<com.tiecoms.app.core.MailAddressDTO>, date: String?, provider: String) {
    @Composable fun line(k: String, v: String, tag: String) = Row(Modifier.fillMaxWidth().testTag(tag)) {
        Text(k, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(56.dp))
        Text(v, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        line(stringResource(R.string.web_mail_meta_from), from?.let { Mail.full(it) } ?: "—", "mailMetaFrom")
        if (to.isNotEmpty()) line(stringResource(R.string.web_mail_meta_to), to.joinToString(", ") { Mail.full(it) }, "mailMetaTo")
        if (cc.isNotEmpty()) line("CC", cc.joinToString(", ") { Mail.full(it) }, "mailMetaCc")
        if (date != null) line(stringResource(R.string.web_mail_meta_date), shortDateTime(date) + " · " + Mail.label(provider), "mailMetaDate")
    }
}

@Composable
private fun AttachmentRow(emailId: String, a: MailAttachmentInfoDTO) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("mailFile-${a.id}"), verticalAlignment = Alignment.CenterVertically) {
        Text(Mail.ext(a.name), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = Color.White,
            modifier = Modifier.background(Color(0xFF5B6475), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 8.dp).width(36.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(a.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(Mail.kb(a.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        OutlinedButton(onClick = { container.scope.launch { openMailAttachment(ctx, client, emailId, a) } }, modifier = Modifier.testTag("mailFileOpen-${a.id}")) {
            Text(stringResource(R.string.web_mail_open))
        }
    }
}

@Composable
private fun CommentRow(authorId: String, body: String, createdAt: String, data: BootstrapDTO) {
    val p = Names.person(data, authorId)
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).testTag("mailComment"), verticalAlignment = Alignment.Top) {
        AuthorAvatar(p, authorId, 26.dp)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(buildAnnotatedString {
                pushStyle(SpanStyle(fontWeight = FontWeight.Bold)); append(if (authorId == data.me.id) stringResource(R.string.common_you_short) else p?.name?.substringBefore(' ') ?: ""); pop()
                append("  "); pushStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)); append(mailDate(createdAt)); pop()
            }, style = MaterialTheme.typography.labelMedium)
            Text(body, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** «Comentar al equipo»: el remitente nunca lo ve. */
@Composable
private fun CommentBox(e: SharedMailDTO) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    var text by rememberSaveable(e.id) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    fun send() {
        val body = text.trim(); if (body.isEmpty() || busy) return
        busy = true
        container.scope.launch {
            runCatching { client.commentMail(e.id, body) }.onSuccess { text = "" }.onFailure { container.toast(errorText(ctx, it)) }
            busy = false
        }
    }
    OutlinedTextField(text, { text = it.take(4000) }, placeholder = { Text(stringResource(R.string.web_mail_commentTeamPh)) }, maxLines = 4,
        modifier = Modifier.fillMaxWidth().testTag("mailCommentInput"))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.web_mail_teamOnly, Mail.firstName(Mail.other(e))), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Button(onClick = { send() }, enabled = text.isNotBlank() && !busy, modifier = Modifier.testTag("mailCommentSend")) { Text(stringResource(R.string.web_comments_send)) }
    }
}

/** «Responder a …»: solo para quien trajo el correo. CC editable, gg, archivos del chat y ▾ para programar. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ReplyBox(e: SharedMailDTO, onSent: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val to = Mail.replyTo(e)
    var body by rememberSaveable(e.id) { mutableStateOf("") }
    var cc by rememberSaveable(e.id) { mutableStateOf(Mail.defaultCc(e).joinToString(", ")) }
    var picked by rememberSaveable(e.id) { mutableStateOf(listOf<String>()) }
    var busy by remember { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var custom by remember { mutableStateOf(false) }
    var filesOpen by remember { mutableStateOf(false) }
    val ccList = Mail.parseCc(cc)
    val badCc = Mail.badCc(ccList)
    val files = Mail.chatFiles(st.conversations[e.conversationId]?.messages.orEmpty())
    fun send(at: Instant?) {
        if (body.isBlank() || busy != null || badCc) return
        busy = "send"
        container.scope.launch {
            runCatching { client.replyMail(e.id, body.trim(), ccList, picked, at) }
                .onSuccess {
                    container.toast(if (at != null) ctx.getString(R.string.web_mail_scheduledToast, mailWhen(at.toString())) else ctx.getString(R.string.web_mail_sentToast))
                    body = ""; onSent()
                }
                .onFailure { container.toast(errorText(ctx, it)) }
            busy = null
        }
    }
    Text(stringResource(R.string.web_mail_meta_to) + ": " + to.joinToString(", ") { Mail.who(it) } + " · " + stringResource(R.string.web_mail_from) + ": " + (e.accountEmail ?: ""),
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("mailReplyTo"))
    OutlinedTextField(cc, { cc = it }, label = { Text("CC") }, placeholder = { Text(stringResource(R.string.web_mail_ccPh)) }, singleLine = true, isError = badCc,
        supportingText = if (badCc) ({ Text(stringResource(R.string.web_mail_badCc)) }) else null, modifier = Modifier.fillMaxWidth().testTag("mailReplyCc"))
    OutlinedTextField(body, { body = it.take(20000) }, placeholder = { Text(stringResource(R.string.web_mail_replyPh)) }, minLines = 3, maxLines = 8,
        modifier = Modifier.fillMaxWidth().testTag("mailReplyBody"))
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(enabled = busy == null, onClick = {
            busy = "draft"
            container.scope.launch {
                runCatching { client.draftMailReply(e.id, if (isSpanish()) "es" else "en") }.onSuccess { body = it }.onFailure { container.toast(errorText(ctx, it)) }
                busy = null
            }
        }, modifier = Modifier.testTag("mailGg")) { Text(if (busy == "draft") stringResource(R.string.web_mail_ggWorking) else "✨ " + stringResource(R.string.web_mail_gg)) }
        Spacer(Modifier.width(8.dp))
        Text(if (e.commentCount > 0) stringResource(R.string.web_mail_ggHint, e.commentCount.toString()) else stringResource(R.string.web_mail_ggHintNone),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
    }
    if (files.isNotEmpty()) {
        TextButton(onClick = { filesOpen = !filesOpen }, modifier = Modifier.testTag("mailAttachPick")) {
            Text("📎 " + if (picked.isNotEmpty()) stringResource(R.string.web_mail_attachN, picked.size.toString()) else stringResource(R.string.web_mail_attachFromChat))
        }
        if (filesOpen) files.forEach { (a, by) ->
            val on = a.id in picked
            Row(Modifier.fillMaxWidth().clickable(role = Role.Checkbox) { picked = if (on) picked - a.id else (picked + a.id).take(10) }.testTag("mailAttachFile-${a.id}"),
                verticalAlignment = Alignment.CenterVertically) {
                Checkbox(on, null)
                Text("${a.name} · ${Mail.kb(a.sizeBytes)} · ${Names.person(data, by)?.name?.substringBefore(' ') ?: ""}", style = MaterialTheme.typography.bodySmall,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.web_mail_sentVia, Mail.label(e.provider)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        val enabled = body.isNotBlank() && busy == null && !badCc
        // Botón partido: Enviar | ▾ (o pulsación larga en Enviar) abre «Programar envío».
        Surface(shape = RoundedCornerShape(20.dp), color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
            contentColor = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (busy == "send") stringResource(R.string.web_mail_sending) else stringResource(R.string.web_mail_send), fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.combinedClickable(enabled = enabled, onClick = { send(null) }, onLongClick = { menu = true })
                        .padding(horizontal = 16.dp, vertical = 12.dp).testTag("mailReplySend"))
                val schedLabel = stringResource(R.string.web_mail_scheduleMenu)
                Text("▾", modifier = Modifier.clickable(enabled = enabled) { menu = true }.padding(horizontal = 12.dp, vertical = 12.dp)
                    .semantics { contentDescription = schedLabel }.testTag("mailReplySchedule"))
            }
        }
    }
    if (menu) ActionSheet(stringResource(R.string.web_mail_scheduleMenu), Mail.scheduleTimes(Instant.now(), ZoneId.systemDefault()).map { (k, at) ->
        SheetItem(ctx.getString(when (k) { "1h" -> R.string.when_1h; "3h" -> R.string.when_3h; "tomorrow" -> R.string.when_tomorrow; else -> R.string.when_monday }), "🕒", tag = "mailSched-$k") {
            menu = false; send(at)
        }
    } + listOf(null, SheetItem(ctx.getString(R.string.web_mail_pickTime), "📅", tag = "mailSchedPick") { menu = false; custom = true }), onDismiss = { menu = false })
    if (custom) {
        var day by remember { mutableStateOf<LocalDate?>(LocalDate.now().plusDays(1)) }
        var time by remember { mutableStateOf(LocalTime.of(9, 0)) }
        FormSheet(stringResource(R.string.web_mail_pickTime), { custom = false }, tag = "mailSchedSheet") {
            DateField(stringResource(R.string.web_mail_meta_date), day, { day = it }, modifier = Modifier.fillMaxWidth())
            TimeField("", time, { time = it }, modifier = Modifier.fillMaxWidth())
            val at = day?.atTime(time)?.atZone(ZoneId.systemDefault())?.toInstant()
            DialogButtons({ custom = false }, stringResource(R.string.web_mail_schedule), enabled = at != null && Mail.validSendAt(at, Instant.now()) && body.isNotBlank(),
                confirmTag = "mailSchedConfirm") { custom = false; send(at) }
        }
    }
}

// ---------- Conectar ----------
@Composable
fun rememberMailConnections(): Pair<List<MailConnectionDTO>?, String?> {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { client.loadMailConnections() }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; error = errorText(ctx, it) } }
    return st.mailConnections to error
}

@Composable
fun MailConnectCards(list: List<MailConnectionDTO>) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("mailConnect")) {
        list.forEach { c ->
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().testTag("mailConn-${c.provider}")) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    ProviderIcon(c.provider, 26.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(c.label.ifBlank { Mail.label(c.provider) }, fontWeight = FontWeight.Bold)
                        Text(when {
                            !c.available -> c.unavailableReason ?: ""
                            c.status == "active" -> stringResource(R.string.web_mail_connectedAs, c.accountEmail ?: "")
                            c.status == "reconnect" -> stringResource(R.string.web_mail_reconnectHint)
                            else -> stringResource(R.string.web_mail_connectHint)
                        }, style = MaterialTheme.typography.bodySmall, color = if (c.status == "reconnect" || !c.available) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        if (c.available && c.status != "active") Button(onClick = { container.startMailConnect(ctx, c.provider) }, modifier = Modifier.testTag("mailConnectBtn-${c.provider}")) {
                            Text(stringResource(if (c.status == "reconnect") R.string.web_mail_reconnect else R.string.web_mail_connect))
                        }
                        if (c.status != "none") TextButton(onClick = {
                            container.scope.launch { runCatching { client.disconnectMail(c.provider) }.onFailure { container.toast(errorText(ctx, it)) } }
                        }, modifier = Modifier.testTag("mailDisconnect-${c.provider}")) { Text(stringResource(R.string.web_mail_disconnect), color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
        }
        Text(stringResource(R.string.web_mail_privacyHint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Grupos (en la web, Hoy): «Comenta tus correos con el equipo · Conectar», solo si no hay cuenta conectada; ✕ la cierra para siempre. */
@Composable
fun MailConnectNudge(onOpen: () -> Unit) {
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    var off by remember { mutableStateOf(container.settings.mailNudgeOff) }
    val on = st.data?.mailEnabled == true
    LaunchedEffect(on, off) { if (on && !off && client.state.value.mailConnections == null) runCatching { client.loadMailConnections() } }
    val list = st.mailConnections
    if (!on || off || list == null || list.any { it.status == "active" } || list.none { it.available }) return
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).testTag("mailNudge")) {
        Row(Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            ProviderIcon("google", 22.dp); Spacer(Modifier.width(2.dp)); ProviderIcon("microsoft", 22.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.web_mail_nudgeTitle), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                Text(stringResource(R.string.web_mail_nudgeBody), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Button(onClick = onOpen, modifier = Modifier.testTag("mailNudgeConnect")) { Text(stringResource(R.string.web_mail_connect)) }
            IconButton(onClick = { off = true; container.settings.mailNudgeOff = true }, modifier = Modifier.testTag("mailNudgeClose")) { Icon(Icons.Filled.Close, stringResource(R.string.close)) }
        }
    }
}

// ---------- La lista en vivo ----------
/** Caché en memoria por filtro (como la web): volver pinta al instante y se refresca por detrás si tiene más de 20 s. */
private object MailListCache {
    data class Entry(val items: List<MailListItemDTO>, val next: String?, val at: Long)
    private val map = object : LinkedHashMap<String, Entry>(32, 0.75f, true) { override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?) = size > 30 }
    @Synchronized fun get(k: String) = map[k]
    @Synchronized fun put(k: String, e: Entry) { map[k] = e }
    @Synchronized fun clear() = map.clear()
}

/**
 * Tú › Correo, o el ＋ del chat › Correo (con [conversationId] el destino ya viene dado y el botón dice «Comentar aquí»).
 * [onShared] recibe el chat donde quedó.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MailListScreen(conversationId: String?, onBack: () -> Unit, onShared: (String, String?) -> Unit) {
    val (connections, error) = rememberMailConnections()
    val ready = connections.orEmpty().filter { it.status == "active" }
    var accounts by remember { mutableStateOf(false) }
    SimpleScaffold(stringResource(if (conversationId != null) R.string.web_mail_pickTitle else R.string.web_mail_title), onBack, actions = {
        if (ready.isNotEmpty()) TextButton(onClick = { accounts = true }, modifier = Modifier.testTag("mailAccounts")) { Text(stringResource(R.string.web_mail_accounts)) }
    }) {
        when {
            connections == null && error != null -> Text(error, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error)
            connections == null -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            ready.isEmpty() -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.web_mail_intro), color = MaterialTheme.colorScheme.onSurfaceVariant)
                MailConnectCards(connections)
            }
            else -> MailBrowser(ready, conversationId, onShared)
        }
    }
    if (accounts && connections != null) FormSheet(stringResource(R.string.web_mail_accounts), { accounts = false }, tag = "mailAccountsSheet") { MailConnectCards(connections) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MailBrowser(ready: List<MailConnectionDTO>, conversationId: String?, onShared: (String, String?) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    // 1.7.7: abre en la última bandeja usada (la elige el acceso con logo de Grupos/DMs) y la recuerda.
    val settings = LocalContainer.current.settings
    var provider by rememberSaveable { mutableStateOf(ready.firstOrNull { it.provider == settings.mailProvider }?.provider ?: ready.first().provider) }
    if (ready.none { it.provider == provider }) provider = ready.first().provider
    LaunchedEffect(provider) { settings.mailProvider = provider }
    var f by remember { mutableStateOf(Mail.Filters()) }
    var cat by remember(provider) { mutableStateOf<String?>(null) }
    var qText by rememberSaveable { mutableStateOf("") }
    var open by remember { mutableStateOf<String?>(null) }
    var dateMenu by remember { mutableStateOf(false) }
    var items by remember { mutableStateOf<List<MailListItemDTO>?>(null) }
    var next by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<MailListItemDTO?>(null) }
    var sharing by remember { mutableStateOf<MailListItemDTO?>(null) }
    var seq by remember { mutableIntStateOf(0) }
    var reloadTick by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    // Escribir busca solo, a los 400 ms.
    LaunchedEffect(qText) { delay(400); if (f.q != qText.trim()) f = f.copy(q = qText.trim()) }
    val cats = Mail.categories(provider)
    val category = Mail.category(f, cat, provider)
    val key = Mail.listQuery(provider, f, category)
    suspend fun load(page: String? = null, fresh: Boolean = false) {
        val my = ++seq
        busy = true; err = null
        try {
            val r = client.listMail(provider, f, category, page, fresh)
            if (my != seq) return
            val list = if (page != null) items.orEmpty() + r.items else r.items
            items = list; next = r.nextPage
            MailListCache.put(key, MailListCache.Entry(list, r.nextPage, System.currentTimeMillis()))
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (my == seq) { err = errorText(ctx, e); if (page == null && items == null) items = emptyList() }
        } finally { if (my == seq) busy = false }
    }
    LaunchedEffect(key, reloadTick) {
        val hit = MailListCache.get(key)
        if (hit != null && reloadTick == 0) { items = hit.items; next = hit.next; if (System.currentTimeMillis() - hit.at > 20_000) load() }
        else { if (reloadTick == 0) items = null; load(fresh = reloadTick > 0) }
    }
    val today = LocalDate.now()
    LazyColumn(Modifier.fillMaxSize().testTag("mailList")) {
        item {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (ready.size > 1) Segmented(ready.map { it.provider to it.label.ifBlank { Mail.label(it.provider) } }, provider, { provider = it }, Modifier.fillMaxWidth().testTag("mailProvider"))
                else Row(verticalAlignment = Alignment.CenterVertically) {
                    ProviderIcon(provider, 16.dp); Spacer(Modifier.width(6.dp))
                    Text(ready.first().accountEmail ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("mailAccount"))
                }
                Segmented(listOf("inbox" to stringResource(R.string.web_mail_box_inbox), "sent" to stringResource(R.string.web_mail_box_sent), "all" to stringResource(R.string.web_mail_box_all)),
                    f.box, { f = f.copy(box = it) }, Modifier.fillMaxWidth().testTag("mailBox"))
                if (f.box == "inbox") LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("mailCats")) {
                    items(cats) { c ->
                        FilterChip(category == c, { cat = c }, label = { Text(catLabel(c)) }, modifier = Modifier.testTag("mailCat-$c"))
                    }
                }
                OutlinedTextField(qText, { qText = it }, singleLine = true, placeholder = { Text(stringResource(R.string.web_mail_searchPh), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingIcon = { Text("🔎") }, trailingIcon = if (qText.isNotEmpty() || f.filtered) ({
                        IconButton(onClick = { qText = ""; f = Mail.Filters(box = f.box); open = null }, modifier = Modifier.testTag("mailClear")) { Icon(Icons.Filled.Close, stringResource(R.string.web_mail_clear)) }
                    }) else null, modifier = Modifier.fillMaxWidth().testTag("mailSearch"))
                val labelKey = if (provider == "microsoft") R.string.web_mail_f_category else R.string.web_mail_f_label
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("mailChips")) {
                    item {
                        Box {
                            FilterChip(f.after.isNotEmpty() || f.before.isNotEmpty(), { dateMenu = true }, label = { Text(rangeLabel(f) + " ▾") }, modifier = Modifier.testTag("mailFDate"))
                            AnchoredMenu(dateMenu, listOf(
                                SheetItem(ctx.getString(R.string.web_mail_date_today), tag = "mailDate-today") { f = Mail.withRange(f, "today", today); dateMenu = false },
                                SheetItem(ctx.getString(R.string.web_mail_date_7), tag = "mailDate-7") { f = Mail.withRange(f, "7", today); dateMenu = false },
                                SheetItem(ctx.getString(R.string.web_mail_date_30), tag = "mailDate-30") { f = Mail.withRange(f, "30", today); dateMenu = false },
                                SheetItem(ctx.getString(R.string.web_mail_date_year), tag = "mailDate-year") { f = Mail.withRange(f, "year", today); dateMenu = false },
                                SheetItem(ctx.getString(R.string.web_mail_date_older), tag = "mailDate-older") { f = Mail.withRange(f, "older", today); dateMenu = false },
                                null,
                                SheetItem(ctx.getString(R.string.web_mail_date_between), "📅", tag = "mailDate-between") { f = f.copy(range = "custom"); open = "range"; dateMenu = false },
                            ) + if (f.after.isNotEmpty() || f.before.isNotEmpty()) listOf(SheetItem(ctx.getString(R.string.web_mail_date_any), "✕", tag = "mailDate-any") { f = Mail.withRange(f, "", today); dateMenu = false }) else emptyList(),
                                onDismiss = { dateMenu = false })
                        }
                    }
                    item { FilterChip(f.from.isNotEmpty(), { open = if (open == "from") null else "from" }, label = { Text((if (f.from.isNotEmpty()) stringResource(R.string.web_mail_f_from) + ": " + f.from else stringResource(R.string.web_mail_f_from)) + " ▾") }, modifier = Modifier.testTag("mailFFrom")) }
                    item { FilterChip(f.to.isNotEmpty(), { open = if (open == "to") null else "to" }, label = { Text((if (f.to.isNotEmpty()) stringResource(R.string.web_mail_f_to) + ": " + f.to else stringResource(R.string.web_mail_f_to)) + " ▾") }, modifier = Modifier.testTag("mailFTo")) }
                    item { FilterChip(f.attachments, { f = f.copy(attachments = !f.attachments) }, label = { Text("📎 " + stringResource(R.string.web_mail_f_attachments)) }, modifier = Modifier.testTag("mailFAtt")) }
                    item { FilterChip(f.unread, { f = f.copy(unread = !f.unread) }, label = { Text(stringResource(R.string.web_mail_f_unread)) }, modifier = Modifier.testTag("mailFUnread")) }
                    item { FilterChip(f.label.isNotEmpty(), { open = if (open == "label") null else "label" }, label = { Text((if (f.label.isNotEmpty()) stringResource(labelKey) + ": " + f.label else stringResource(labelKey)) + " ▾") }, modifier = Modifier.testTag("mailFLabel")) }
                }
                when (val o = open) {
                    "from", "to", "label" -> FilterInput(
                        stringResource(if (o == "from") R.string.web_mail_f_from else if (o == "to") R.string.web_mail_f_to else labelKey),
                        when (o) { "from" -> f.from; "to" -> f.to; else -> f.label },
                    ) { v -> f = when (o) { "from" -> f.copy(from = v); "to" -> f.copy(to = v); else -> f.copy(label = v) }; open = null }
                    "range" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        DateField(stringResource(R.string.web_mail_date_from), f.after.takeIf { it.isNotEmpty() }?.let(LocalDate::parse), { f = f.copy(after = it?.toString() ?: "", range = "custom") }, allowClear = true, modifier = Modifier.weight(1f))
                        DateField(stringResource(R.string.web_mail_date_until), f.before.takeIf { it.isNotEmpty() }?.let(LocalDate::parse), { f = f.copy(before = it?.toString() ?: "", range = "custom") }, allowClear = true, modifier = Modifier.weight(1f))
                        TextButton(onClick = { open = null }) { Text(stringResource(R.string.web_common_done)) }
                    }
                    else -> Unit
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val refresh = stringResource(R.string.web_mail_refresh)
                    Text(if (busy) "…" else "↻", modifier = Modifier.clickable(enabled = !busy) { reloadTick++ }.padding(horizontal = 6.dp, vertical = 4.dp)
                        .semantics { contentDescription = refresh }.testTag("mailRefresh"))
                    Text(when {
                        f.filtered -> items?.let { stringResource(R.string.web_mail_results, "${it.size}${if (next != null) "+" else ""}", Mail.label(provider)) } ?: stringResource(R.string.web_mail_searching)
                        f.box == "inbox" && category != null && category != "any" -> stringResource(R.string.web_mail_latest_inbox) + " · " + catLabel(category)
                        else -> stringResource(when (f.box) { "sent" -> R.string.web_mail_latest_sent; "all" -> R.string.web_mail_latest_all; else -> R.string.web_mail_latest_inbox })
                    }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("mailHeader"))
                }
                err?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("mailError")) }
            }
        }
        val list = items
        if (list == null) item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
        else if (list.isEmpty() && err == null) item { EmptyNote(stringResource(if (f.filtered) R.string.web_mail_noResults else R.string.web_mail_empty)) }
        else items(list, key = { it.id }) { m ->
            MailRow(m, showDir = f.box != "inbox", query = f.q, pickLabel = stringResource(if (conversationId != null) R.string.web_mail_pickHere else R.string.web_mail_bring),
                onOpen = { preview = m }, onPick = { sharing = m })
            HorizontalDivider(Modifier.padding(start = 56.dp))
        }
        if (next != null) item {
            Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                OutlinedButton(enabled = !busy, onClick = { scope.launch { load(next) } }, modifier = Modifier.testTag("mailMore")) { Text(if (busy) stringResource(R.string.loading) else stringResource(R.string.web_mail_more)) }
            }
        }
        item {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                ProviderIcon(provider, 13.dp); Spacer(Modifier.width(6.dp))
                Text(stringResource(if (f.filtered) R.string.web_mail_searchFoot else R.string.web_mail_liveFoot, Mail.label(provider)), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    preview?.let { p ->
        MailPreviewSheet(provider, p, stringResource(if (conversationId != null) R.string.web_mail_pickHere else R.string.web_mail_bring),
            onPick = { preview = null; sharing = p }, onClose = { preview = null })
    }
    sharing?.let { s -> MailShareSheet(provider, s, conversationId, onClose = { sharing = null }, onDone = { cid, mid -> sharing = null; onShared(cid, mid) }) }
}

@Composable
private fun catLabel(c: String): String = stringResource(when (c) {
    "primary" -> R.string.web_mail_cat_primary; "updates" -> R.string.web_mail_cat_updates; "promotions" -> R.string.web_mail_cat_promotions
    "social" -> R.string.web_mail_cat_social; "forums" -> R.string.web_mail_cat_forums; "focused" -> R.string.web_mail_cat_focused
    "other" -> R.string.web_mail_cat_other; else -> R.string.web_mail_cat_any
})

@Composable
private fun rangeLabel(f: Mail.Filters): String = when (f.range) {
    "today" -> stringResource(R.string.web_mail_date_today)
    "7" -> stringResource(R.string.web_mail_date_7)
    "30" -> stringResource(R.string.web_mail_date_30)
    "year" -> stringResource(R.string.web_mail_date_year)
    "older" -> stringResource(R.string.web_mail_date_older)
    else -> if (f.after.isNotEmpty() || f.before.isNotEmpty()) "${f.after.ifEmpty { "…" }} – ${f.before.ifEmpty { "…" }}" else stringResource(R.string.web_mail_f_date)
}

@Composable
private fun FilterInput(label: String, value: String, onApply: (String) -> Unit) {
    var v by remember(label) { mutableStateOf(value) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(v, { v = it }, singleLine = true, placeholder = { Text(label) }, modifier = Modifier.weight(1f).testTag("mailFilterInput"))
        Button(onClick = { onApply(v.trim()) }, modifier = Modifier.testTag("mailFilterApply")) { Text(stringResource(R.string.web_mail_apply)) }
        if (value.isNotEmpty()) TextButton(onClick = { onApply("") }) { Text(stringResource(R.string.web_mail_remove)) }
    }
}

/** Resalta las palabras buscadas (como Highlight de la web). */
private fun highlight(text: String, q: String, bg: Color) = buildAnnotatedString {
    val words = q.split(Regex("\\s+")).filter { it.length > 1 && ':' !in it }
    if (words.isEmpty()) { append(text); return@buildAnnotatedString }
    val re = Regex(words.joinToString("|") { Regex.escape(it) }, RegexOption.IGNORE_CASE)
    var i = 0
    re.findAll(text).forEach { m ->
        append(text.substring(i, m.range.first))
        pushStyle(SpanStyle(background = bg)); append(m.value); pop()
        i = m.range.last + 1
    }
    append(text.substring(i))
}

@Composable
private fun MailRow(m: MailListItemDTO, showDir: Boolean, query: String, pickLabel: String, onOpen: () -> Unit, onPick: () -> Unit) {
    val other = Mail.other(m)
    val hl = Color(0x55FFD54F)
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 12.dp, vertical = 8.dp).testTag("mailRow-${m.id}"), verticalAlignment = Alignment.CenterVertically) {
        Avatar(Mail.who(other).ifBlank { "?" }, personColor(other?.email ?: m.id), Color.White, size = 32.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (showDir) { DirBadge(m.box == "sent"); Spacer(Modifier.width(4.dp)) }
                Text((if (m.box == "sent") stringResource(R.string.web_mail_toShort) + " " else "") + Mail.who(other), fontWeight = if (m.unread) FontWeight.Bold else FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(mailDate(m.date), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(highlight(m.subject.ifBlank { stringResource(R.string.web_mail_noSubject) }, query, hl), style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (m.unread) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(highlight((if (m.hasAttachments) "📎 " else "") + m.snippet, query, hl), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        TextButton(onClick = onPick, contentPadding = ButtonDefaults.TextButtonContentPadding, modifier = Modifier.testTag("mailPick-${m.id}")) {
            Text(pickLabel, style = MaterialTheme.typography.labelMedium, maxLines = 2)
        }
    }
}

/** Vista previa del correo completo (en vivo) antes de llevarlo al chat. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MailPreviewSheet(provider: String, item: MailListItemDTO, pickLabel: String, onPick: () -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    var m by remember(item.id) { mutableStateOf<MailMessageDTO?>(null) }
    var err by remember(item.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(item.id) { runCatching { client.getMail(provider, item.id) }.onSuccess { m = it }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; err = errorText(ctx, it) } }
    FormSheet(item.subject.ifBlank { stringResource(R.string.web_mail_noSubject) }, onClose, tag = "mailPreview") {
        MailMeta(item.from, m?.to ?: item.to, m?.cc.orEmpty(), item.date, provider)
        err?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
            Text(m?.let { it.body.ifBlank { stringResource(R.string.web_mail_noBody) } } ?: stringResource(R.string.loading), Modifier.padding(12.dp).testTag("mailPreviewBody"),
                style = MaterialTheme.typography.bodyMedium)
        }
        m?.attachments?.takeIf { it.isNotEmpty() }?.let { atts ->
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                atts.forEach { a -> Text("📎 ${a.name} · ${Mail.kb(a.size)}", style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 6.dp)) }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onClose) { Text(stringResource(R.string.close)) }
            Spacer(Modifier.width(8.dp))
            Button(onClick = onPick, modifier = Modifier.testTag("mailPreviewPick")) { Text(pickLabel) }
        }
    }
}

/** Elegir uno o varios chats (hasta 10) para llevar un correo o un WhatsApp; los elegidos van como chips arriba. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MultiChatPicker(data: BootstrapDTO, picked: List<String>, exclude: String? = null, onChange: (List<String>) -> Unit) {
    val ctx = LocalContext.current
    var q by rememberSaveable { mutableStateOf("") }
    val direct = stringResource(R.string.kind_direct)
    val list = data.conversations.filter { it.canPost && it.id != exclude && (q.isBlank() || titleOf(ctx, it, data).contains(q, ignoreCase = true)) }.take(80)
    OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.web_mail_pickChat)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("pickerSearch"))
    if (picked.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        picked.forEach { id -> data.conversations.firstOrNull { it.id == id }?.let { c ->
            FilterChip(true, { onChange(Mail.toggleChat(picked, id)) }, label = { Text(titleOf(ctx, c, data) + " ✕", maxLines = 1) }, modifier = Modifier.testTag("pickedChat-$id"))
        } }
    }
    Column(Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(androidx.compose.foundation.rememberScrollState())) {
        list.forEach { c ->
            val on = c.id in picked
            Row(Modifier.fillMaxWidth().clickable(role = Role.Checkbox) { onChange(Mail.toggleChat(picked, c.id)) }.heightIn(min = 52.dp).testTag("pick-${c.id}"),
                verticalAlignment = Alignment.CenterVertically) {
                Checkbox(on, null); Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(titleOf(ctx, c, data), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(data.workspaces.firstOrNull { it.id == c.workspaceId }?.name ?: direct, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/** «Lo verán las N personas de X» o, con varios chats, «Lo verán N personas en M chats». */
@Composable
private fun WhoSees(data: BootstrapDTO, picked: List<String>) {
    val ctx = LocalContext.current
    val convs = picked.mapNotNull { id -> data.conversations.firstOrNull { it.id == id } }
    if (convs.isEmpty()) return
    val text = if (convs.size == 1) stringResource(R.string.web_mail_whoSees, convs[0].memberIds.size.toString(), titleOf(ctx, convs[0], data))
        else stringResource(R.string.web_mail_whoSeesMany, convs.flatMap { it.memberIds }.toSet().size.toString(), convs.size.toString())
    Text(text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().background(Color(0x1FD9822B), RoundedCornerShape(8.dp)).padding(10.dp).testTag("mailWhoSees"))
}
@Composable
private fun shareLabel(data: BootstrapDTO, picked: List<String>): String {
    val ctx = LocalContext.current
    return when {
        picked.size == 1 -> data.conversations.firstOrNull { it.id == picked[0] }?.let { stringResource(R.string.web_mail_shareIn, titleOf(ctx, it, data)) } ?: stringResource(R.string.web_mail_share)
        picked.size > 1 -> stringResource(R.string.web_mail_shareInMany, picked.size.toString())
        else -> stringResource(R.string.web_mail_share)
    }
}

/** Paso de compartir: uno o varios chats (el de origen ya elegido), el comentario y quiénes lo verán. POST /mail/share. */
@Composable
private fun MailShareSheet(provider: String, item: MailListItemDTO, conversationId: String?, onClose: () -> Unit, onDone: (String, String?) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var picked by rememberSaveable { mutableStateOf(listOfNotNull(conversationId)) }
    var comment by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    FormSheet(stringResource(R.string.web_mail_shareTitle), onClose, tag = "mailShare") {
        Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                ProviderIcon(provider, 20.dp); Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        DirBadge(item.box == "sent")
                        Text(" " + item.subject.ifBlank { stringResource(R.string.web_mail_noSubject) }, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(Mail.who(Mail.other(item)) + " · " + mailDate(item.date) + if (item.hasAttachments) " · 📎" else "", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        MultiChatPicker(data, picked) { picked = it }
        OutlinedTextField(comment, { comment = it.take(4000) }, placeholder = { Text(stringResource(R.string.web_mail_commentPh)) }, minLines = 2, maxLines = 5,
            modifier = Modifier.fillMaxWidth().testTag("mailShareComment"))
        WhoSees(data, picked)
        DialogButtons(onClose, if (busy) stringResource(R.string.web_mail_sharing) else shareLabel(data, picked),
            enabled = picked.isNotEmpty() && !busy, confirmTag = "mailShareConfirm") {
            val targets = picked
            busy = true
            container.scope.launch {
                runCatching { client.shareMail(provider, item.id, targets, comment) }
                    .onSuccess { list ->
                        container.toast(if (targets.size > 1) ctx.getString(R.string.web_mail_sharedMany, targets.size.toString()) else ctx.getString(R.string.web_mail_shared))
                        // Vuelve al chat de origen si está entre los elegidos; si no, al primero.
                        val go = conversationId?.takeIf { it in targets } ?: targets.first()
                        onDone(go, list.firstOrNull { it.conversationId == go }?.messageId)
                    }
                    .onFailure { container.toast(errorText(ctx, it)) }
                busy = false
            }
        }
    }
}

// ---------- Reenviar una tarjeta ----------
/** Reenviar un correo o WhatsApp ya compartido a otros chats: cada uno recibe su copia con hilo propio (POST …/forward). */
@Composable
fun ForwardCardSheet(emailId: String, onClose: () -> Unit, onDone: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    val e = st.mails[emailId]
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var comment by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    FormSheet(stringResource(R.string.card_forward_title), onClose, tag = "forwardCard") {
        if (e != null) Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                SrcIcon(e.provider, 20.dp); Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(if (e.isWhatsApp) e.wa?.chatName ?: e.subject else e.subject.ifBlank { stringResource(R.string.web_mail_noSubject) }, fontWeight = FontWeight.Bold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (e.isWhatsApp) e.snippet else com.tiecoms.app.core.MailText.snippet(e.snippet), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        // El chat donde ya está no se ofrece.
        MultiChatPicker(data, picked, exclude = e?.conversationId) { picked = it }
        OutlinedTextField(comment, { comment = it.take(4000) }, placeholder = { Text(stringResource(R.string.web_mail_commentPh)) }, minLines = 2, maxLines = 4,
            modifier = Modifier.fillMaxWidth().testTag("forwardComment"))
        WhoSees(data, picked)
        DialogButtons(onClose, if (busy) stringResource(R.string.web_mail_sharing) else shareLabel(data, picked), enabled = picked.isNotEmpty() && !busy, confirmTag = "forwardConfirm") {
            val targets = picked
            busy = true
            container.scope.launch {
                runCatching { client.forwardShared(emailId, targets, comment) }
                    .onSuccess { container.toast(if (targets.size > 1) ctx.getString(R.string.web_mail_sharedMany, targets.size.toString()) else ctx.getString(R.string.web_mail_shared)); onDone(targets.first()) }
                    .onFailure { container.toast(errorText(ctx, it)) }
                busy = false
            }
        }
    }
}

// ---------- WhatsApp: «Comentar en chaggu…» ----------
@Composable
fun WaShareSheet(c: WaChatDTO, message: WaMessageDTO, onClose: () -> Unit, onDone: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val state = client.state.collectAsStateWithLifecycle().value
    val source = com.tiecoms.app.core.WaInbox.key(c)
    val epoch = remember(source) { state.waPrivacy.token(source) }
    val permitted = state.waPrivacy.allows(source) && epoch == state.waPrivacy.token(source)
    LaunchedEffect(permitted) { if (!permitted) onClose() }
    if (!permitted) return
    val data = state.data ?: return
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var comment by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    FormSheet(stringResource(R.string.web_wa_bringTitle), onClose, tag = "waShare") {
        Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    WaIcon(20.dp); Spacer(Modifier.width(8.dp))
                    Column {
                        Text((if (c.isGroup) "👥 " else "") + c.name, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (message.fromMe) stringResource(R.string.common_you_short) else message.author ?: stringResource(R.string.web_wa_someone), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Text(message.body.take(400), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.background(WaGreen.copy(alpha = 0.08f), RoundedCornerShape(6.dp)).padding(8.dp))
            }
        }
        MultiChatPicker(data, picked) { picked = it }
        OutlinedTextField(comment, { comment = it.take(4000) }, placeholder = { Text(stringResource(R.string.web_wa_commentPh)) }, minLines = 2, maxLines = 4,
            modifier = Modifier.fillMaxWidth().testTag("waShareComment"))
        WhoSees(data, picked)
        DialogButtons(onClose, if (busy) stringResource(R.string.web_mail_sharing) else shareLabel(data, picked), enabled = picked.isNotEmpty() && !busy, confirmTag = "waShareConfirm") {
            val targets = picked
            busy = true
            container.scope.launch {
                runCatching { client.shareWhatsApp(c.accountId, c.jid, message.id, targets, comment) }
                    .onSuccess { container.toast(if (targets.size > 1) ctx.getString(R.string.web_mail_sharedMany, targets.size.toString()) else ctx.getString(R.string.web_mail_shared)); onDone(targets.first()) }
                    .onFailure { container.toast(errorText(ctx, it)) }
                busy = false
            }
        }
    }
}
