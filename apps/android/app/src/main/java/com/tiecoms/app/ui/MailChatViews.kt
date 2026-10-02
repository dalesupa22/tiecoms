package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.Mail
import com.tiecoms.app.core.MailSystem
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.SharedMailDTO
import com.tiecoms.app.ui.theme.LocalChatColors
import kotlinx.coroutines.launch
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * Correo y WhatsApp traídos al chat (docs/CORREO.md; MailCard, MailSharedRow y WaSharedRow de la web):
 * mail.shared se ve como mensaje de quien lo trajo con su comentario y la tarjeta; mail.comments, como la tarjeta con
 * la franja de comentarios; mail.replied y mail.reply_failed, como una línea con «Abrir»; wa.shared, con la tarjeta verde.
 */

/** A dónde van los botones de las tarjetas (lo pone AppRoot; en las pruebas de interfaz no navega). */
class MailNav(
    /** mode: read | comments | reply */
    val openMail: (id: String, mode: String) -> Unit = { _, _ -> },
    /** La lista de correos; con un chat, «Comentar aquí» lo comparte en ese chat. */
    val openList: (conversationId: String?) -> Unit = {},
    val openWhatsApp: () -> Unit = {},
)
val LocalMailNav = staticCompositionLocalOf { MailNav() }

val MailInBlue = Color(0xFF4285F4)
val MailOutTeal = Color(0xFF2A9D8F)
val WaGreen = Color(0xFF25D366)

/** Hoy: la hora; otro día: «29 sept» (con el año si no es este). */
fun mailDate(iso: String?): String {
    val t = parseInstant(iso)?.atZone(ZoneId.systemDefault()) ?: return ""
    val now = java.time.ZonedDateTime.now()
    if (t.toLocalDate() == now.toLocalDate()) return t.format(DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault()))
    return t.format(DateTimeFormatter.ofPattern(if (t.year != now.year) "d MMM yyyy" else "d MMM", Locale.getDefault())).replace(".", "")
}
/** «lun 30 sept, 9:00 a. m.» (hora de una respuesta programada). */
fun mailWhen(iso: String?): String =
    parseInstant(iso)?.atZone(ZoneId.systemDefault())?.format(DateTimeFormatter.ofPattern("EEE d MMM, h:mm a", Locale.getDefault()))?.replace(".", "") ?: ""

/** Texto del estado: «Por responder», «Respuesta programada · …», «Respondido por ti · …», «Enviado por ti»… */
@Composable
fun mailStatusText(e: SharedMailDTO, data: BootstrapDTO): String = when (Mail.status(e, data.me.id)) {
    Mail.Status.REPLIED_BY_ME -> stringResource(R.string.web_mail_repliedByYou, mailDate(e.repliedAt))
    Mail.Status.REPLIED -> stringResource(R.string.web_mail_repliedBy, e.repliedBy?.let { Names.person(data, it) }?.name?.substringBefore(' ') ?: "", mailDate(e.repliedAt))
    Mail.Status.SCHEDULED -> e.scheduledReply?.let { stringResource(R.string.web_mail_scheduledFor, mailWhen(it.sendAt)) } ?: stringResource(R.string.web_mail_scheduled)
    Mail.Status.SENT_BY_ME -> stringResource(R.string.web_mail_sentByYou)
    Mail.Status.SENT -> stringResource(R.string.web_mail_sentMail)
    Mail.Status.PENDING -> stringResource(R.string.web_mail_pending)
}

@Composable
fun MailStatusPill(e: SharedMailDTO, data: BootstrapDTO) {
    val st = Mail.status(e, data.me.id)
    val color = when (st) {
        Mail.Status.REPLIED_BY_ME, Mail.Status.REPLIED -> Color(0xFF2E7D32)
        Mail.Status.SCHEDULED -> Color(0xFF6A4FB6)
        Mail.Status.SENT_BY_ME, Mail.Status.SENT -> MailOutTeal
        Mail.Status.PENDING -> Color(0xFFD9822B)
    }
    Text(mailStatusText(e, data), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.background(color.copy(alpha = 0.12f), RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 3.dp).testTag("mailStatus-${e.id}"))
}

/** Recibido ↙ / enviado ↗. */
@Composable
fun DirBadge(out: Boolean) {
    val label = stringResource(if (out) R.string.web_mail_dir_out else R.string.web_mail_dir_in)
    Text(if (out) "↗" else "↙", color = if (out) MailOutTeal else MailInBlue, fontWeight = FontWeight.Bold, fontSize = 14.sp,
        modifier = Modifier.semantics { contentDescription = label })
}

/**
 * Dispara la fila correcta para un aviso del correo o de WhatsApp. Con el correo apagado en el servidor
 * (features.mail = false) se ve el texto de sys.* — nunca el JSON.
 */
@Composable
internal fun MailSystemRow(m: MessageDTO, b: MailSystem.Body, data: BootstrapDTO, canPost: Boolean, onOpenIssue: (String) -> Unit,
                            cardActions: ((MessageDTO, String?) -> CardActions)? = null) {
    val nav = LocalMailNav.current
    val on = data.mailEnabled
    val id = b.emailId
    when {
        // Desde la 040 el WhatsApp compartido tiene registro propio (hilo y tarea): su tarjeta; los viejos, del payload.
        b.key == "wa.shared" && on && id != null -> MailSharedRow(m, b, data, canPost, onOpenIssue, cardActions?.invoke(m, id))
        b.key == "wa.shared" -> WaSharedRow(m, b, data, cardActions?.invoke(m, null))
        !on || id == null -> MailSystemText(m, b, data)
        b.key == "mail.shared" -> MailSharedRow(m, b, data, canPost, onOpenIssue, cardActions?.invoke(m, id))
        b.key == "mail.comments" -> CommentsNoticeLine(b.count, b.subject, b.lastByName, b.lastExcerpt, icon = {
            if (b.provider == "whatsapp") WaIcon(14.dp) else Text("✉", style = MaterialTheme.typography.bodySmall)
        }, tag = "mailCommentsLine") { nav.openMail(id, "comments") }
        else -> MailSystemText(m, b, data, onOpen = { nav.openMail(it, "read") })
    }
}

/**
 * Aviso de sistema del correo o de WhatsApp como texto (sys.mail.*, sys.wa.shared), nunca como JSON.
 * Se usa con el correo apagado, para mail.replied / mail.reply_failed y si la tarjeta no se puede cargar.
 */
@Composable
internal fun MailSystemText(m: MessageDTO, b: MailSystem.Body, data: BootstrapDTO, onOpen: ((String) -> Unit)? = null) {
    val ctx = LocalContext.current
    val chat = LocalChatColors.current
    val who = Names.person(data, m.authorId)?.name
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("mailSys-${b.key}"), horizontalAlignment = Alignment.CenterHorizontally) {
        val text = mailSystemText(ctx, b)
        val line = if (b.key == "mail.shared" || b.key == "wa.shared") listOfNotNull(who?.takeIf { it.isNotBlank() }, text).joinToString(" · ") else text
        Text(line, style = MaterialTheme.typography.bodySmall, color = chat.system, textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 24.dp).testTag("system"))
        b.comment?.let { c ->
            Text("«$c»", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, maxLines = 6, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 2.dp).testTag("mailSysComment"))
        }
        b.wa?.text?.takeIf { it.isNotBlank() }?.let { t ->
            Text(listOfNotNull(b.wa.author, b.wa.chatName).joinToString(" · ") + ": " + t, style = MaterialTheme.typography.bodySmall, color = chat.system,
                textAlign = TextAlign.Center, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 24.dp))
        }
        val id = b.emailId
        if (onOpen != null && id != null) TextButton(onClick = { onOpen(id) }, modifier = Modifier.testTag("mailSysOpen")) { Text(stringResource(R.string.web_lin_open)) }
    }
}

/** Cabecera de un aviso que se ve como mensaje de quien lo trajo: avatar, nombre y hora; luego su comentario. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun BroughtBy(m: MessageDTO, data: BootstrapDTO, comment: String?, tag: String, actions: CardActions? = null, forwardedFrom: String? = null, content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val author = Names.person(data, m.authorId)
    var menu by remember(m.id) { mutableStateOf(false) }
    // Deslizar a la derecha: responder, igual que en un mensaje normal.
    var swipe by remember(m.id) { androidx.compose.runtime.mutableFloatStateOf(0f) }
    val swipeMax = with(androidx.compose.ui.platform.LocalDensity.current) { 96.dp.toPx() }
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val menuLabel = stringResource(R.string.menu_more)
    Row(Modifier.fillMaxWidth()
        .then(if (actions != null) Modifier
            .pointerInput(m.id) {
                detectHorizontalDragGestures(
                    onDragEnd = { if (swipe >= swipeMax * 0.8f) actions.reply?.invoke(); swipe = 0f },
                    onDragCancel = { swipe = 0f },
                ) { _, dx -> swipe = (swipe + dx).coerceIn(0f, swipeMax) }
            }
            .graphicsLayer { translationX = swipe }
            // Pulsación larga sin fusionar la semántica de la tarjeta (sus botones y el campo siguen accesibles por separado);
            // con TalkBack, la acción «Más opciones».
            .pointerInput(m.id) {
                detectTapGestures(onLongPress = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); menu = true })
            }
            .semantics { customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction(menuLabel) { menu = true; true }) } else Modifier)
        .padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 4.dp).testTag(tag), verticalAlignment = Alignment.Top) {
        AuthorAvatar(author, m.authorId, 34.dp)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(author?.name ?: stringResource(R.string.former_participant), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                    color = personColor(m.authorId), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text("  " + timeText(m.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // Copia reenviada desde otro chat: «↪ Reenviado desde «X»» (o «↪ Reenviado» si ese chat no lo veo).
            forwardedFrom?.let { from ->
                val c = data.conversations.firstOrNull { it.id == from }
                Text("↪ " + (c?.let { stringResource(R.string.fwd_from_conv, titleOf(ctx, it, data)) } ?: stringResource(R.string.card_forwarded)),
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("cardForwarded"))
            }
            comment?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("$tag-comment")) }
            content()
        }
    }
    if (menu && actions != null) ActionSheet(null, listOfNotNull(
        actions.reply?.let { SheetItem(ctx.getString(R.string.menu_reply), "↩", tag = "cardReply") { menu = false; it() } },
        actions.replyPrivately?.let { SheetItem(ctx.getString(R.string.menu_reply_private), "✉", tag = "cardReplyPrivate",
            subtitle = ctx.getString(R.string.menu_reply_private_sub, author?.name?.substringBefore(' ') ?: "")) { menu = false; it() } },
        actions.forward?.let { SheetItem(ctx.getString(R.string.card_forward), "↪", tag = "cardForward") { menu = false; it() } },
        SheetItem(ctx.getString(R.string.menu_copy_link), "⛓", tag = "cardCopyLink") { menu = false; actions.copyLink() },
    ), onDismiss = { menu = false })
}

/** Responder aquí, en privado y reenviar la tarjeta, como un mensaje normal (pulsación larga o deslizar). */
class CardActions(val reply: (() -> Unit)?, val replyPrivately: (() -> Unit)?, val forward: (() -> Unit)?, val copyLink: () -> Unit)

/** mail.shared: el mensaje de quien trajo el correo, con su comentario y la tarjeta. */
@Composable
internal fun MailSharedRow(m: MessageDTO, b: MailSystem.Body, data: BootstrapDTO, canPost: Boolean, onOpenIssue: (String) -> Unit, actions: CardActions? = null) {
    val ctx = LocalContext.current
    BroughtBy(m, data, b.comment, "mailShared-${m.seq}", actions, b.forwardedFrom) {
        MailCard(b.emailId ?: return@BroughtBy, data, canPost, onOpenIssue, fallback = mailSystemText(ctx, b))
    }
}

/**
 * Aviso agrupado de comentarios (mail.comments, issue.comments, event.comments): una línea corta que abre el hilo, sin repetir
 * la tarjeta — «💬 N comentarios nuevos · «título» · Nombre extracto» (CommentsNoticeLine de la web).
 */
@Composable
internal fun CommentsNoticeLine(count: Int, title: String, lastByName: String?, lastExcerpt: String?, icon: @Composable () -> Unit, tag: String, onOpen: () -> Unit) {
    val chat = LocalChatColors.current
    val head = if (count > 1) stringResource(R.string.web_comments_many, count.toString()) else stringResource(R.string.web_comments_one)
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 24.dp, vertical = 6.dp).testTag(tag),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        icon(); Spacer(Modifier.width(6.dp))
        Text(androidx.compose.ui.text.buildAnnotatedString {
            pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.SemiBold)); append(head); pop()
            append(" · «"); append(title); append("» · ")
            pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)); append((lastByName ?: "").substringBefore(' ')); pop()
            append(" "); append(lastExcerpt ?: "")
        }, style = MaterialTheme.typography.bodySmall, color = chat.system, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.weight(1f, fill = false))
    }
}

/** Icono de la fuente: Gmail, Outlook o WhatsApp. */
@Composable
fun SrcIcon(provider: String, size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    if (provider == "whatsapp") WaIcon(size, modifier) else ProviderIcon(provider, size, modifier)
}

/** La tarjeta del correo en el chat. Se carga en lote (GET /mail/shared?ids=) y se actualiza con `mail.updated`. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun MailCard(emailId: String, data: BootstrapDTO, canPost: Boolean, onOpenIssue: (String) -> Unit,
                      fallback: String? = null, banner: (@Composable () -> Unit)? = null) {
    val client = LocalClient.current
    val nav = LocalMailNav.current
    val st by client.state.collectAsStateWithLifecycle()
    val e = st.mails[emailId]
    var missing by remember(emailId) { mutableStateOf(false) }
    var task by remember(emailId) { mutableStateOf(false) }
    LaunchedEffect(emailId, e == null) {
        if (e != null) return@LaunchedEffect
        // Un error pasajero (sin red, 429, 5xx) se reintenta con espera 1, 2, 4, 8 y 15 s; solo un 403/404 dice
        // «Este correo ya no está disponible».
        for (wait in com.tiecoms.app.core.ChatRecovery.BACKOFF_MS.toList() + null) {
            val r = runCatching { client.loadSharedMail(emailId) }
            val err = r.exceptionOrNull() ?: return@LaunchedEffect
            if (err is kotlinx.coroutines.CancellationException) throw err
            if (wait == null || !com.tiecoms.app.core.ChatRecovery.transient(err)) { missing = true; return@LaunchedEffect }
            kotlinx.coroutines.delay(wait)
        }
    }
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.9f).coerceAtMost(520f).dp
    if (e == null) {
        if (!missing) Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow,
            modifier = Modifier.widthIn(max = maxW).fillMaxWidth().height(96.dp).testTag("mailCardLoading")) {}
        else Column(Modifier.widthIn(max = maxW).testTag("mailCardMissing")) {
            Text(stringResource(R.string.web_mail_unavailable), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            fallback?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalChatColors.current.system) }
        }
        return
    }
    val me = data.me.id
    val conv = data.conversations.firstOrNull { it.id == e.conversationId }
    if (e.isWhatsApp) { WaMailCard(e, data, canPost && conv?.canPost != false, maxW, onOpenIssue); return }
    val other = Mail.other(e)
    val edge = if (e.out) MailOutTeal else MailInBlue
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, shadowElevation = 1.dp,
        modifier = Modifier.widthIn(max = maxW).fillMaxWidth().testTag("mailCard-${e.id}")) {
        Column(Modifier.drawBehind { drawRect(edge, size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height)) }
            .padding(start = 14.dp, end = 12.dp, top = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            banner?.invoke()
            Row(verticalAlignment = Alignment.Top) {
                ProviderIcon(e.provider, 22.dp, Modifier.padding(top = 2.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        DirBadge(e.out)
                        Text(" " + stringResource(if (e.out) R.string.web_mail_kind_out else R.string.web_mail_kind_in, Mail.label(e.provider)),
                            style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                            modifier = Modifier.testTag("mailKind-${e.id}"))
                    }
                    Text(e.subject.ifBlank { stringResource(R.string.web_mail_noSubject) }, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold,
                        maxLines = 3, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable { nav.openMail(e.id, "read") }.padding(vertical = 2.dp).testTag("mailCardTitle-${e.id}"))
                    Text((if (e.out) stringResource(R.string.web_mail_toShort) + " " else "") + Mail.who(other) +
                        (if (!other?.name.isNullOrBlank()) " · ${other?.email}" else "") + " · " + mailDate(e.sentAt),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            // Sin «alt [http://…png]» ni direcciones sueltas (web: mailSnippet).
            val snip = remember(e.snippet) { com.tiecoms.app.core.MailText.snippet(e.snippet) }
            if (snip.isNotBlank()) Text(snip, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("mailSnippet-${e.id}"))
            if (e.attachments.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val ctx = LocalContext.current
                val container = LocalContainer.current
                e.attachments.take(4).forEach { a ->
                    FileChip("📎 ${a.name} · ${Mail.kb(a.size)}", "mailAtt-${a.id}") { container.scope.launch { openMailAttachment(ctx, client, e.id, a) } }
                }
                if (e.attachments.size > 4) FileChip("+${e.attachments.size - 4}", "mailAttMore") { nav.openMail(e.id, "read") }
            }
            // Comentarios como en la tarjeta de tarea: los 2 últimos, «Ver los N comentarios» y el campo para comentar ahí mismo.
            MailCardComments(e, data, canPost && conv?.canPost != false) { nav.openMail(e.id, "comments") }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                Box(Modifier.align(Alignment.CenterVertically)) { MailStatusPill(e, data) }
                Spacer(Modifier.weight(1f))
                val small = Modifier.heightIn(min = 36.dp)
                val pad = ButtonDefaults.TextButtonContentPadding
                if (e.issueId != null) OutlinedButton(onClick = { onOpenIssue(e.issueId) }, contentPadding = pad, modifier = small.testTag("mailCardSeeTask")) { Text("◆ " + stringResource(R.string.web_mail_seeTask)) }
                else if (canPost && conv?.canPost != false) OutlinedButton(onClick = { task = true }, contentPadding = pad, modifier = small.testTag("mailCardTask")) { Text("◆ " + stringResource(R.string.web_mail_task)) }
                if (Mail.canReply(e, me)) Button(onClick = { nav.openMail(e.id, "reply") }, contentPadding = pad, modifier = small.testTag("mailCardReply-${e.id}")) { Text(stringResource(R.string.web_mail_reply)) }
            }
        }
    }
    if (task) MailTaskSheet(e, data, onClose = { task = false })
}

/** WhatsApp compartido con hilo y tarea (provider «whatsapp»): tarjeta verde, el mensaje citado, comentarios y ◆ Tarea; sin Responder. */
@Composable
private fun WaMailCard(e: SharedMailDTO, data: BootstrapDTO, canPost: Boolean, maxW: androidx.compose.ui.unit.Dp, onOpenIssue: (String) -> Unit) {
    val nav = LocalMailNav.current
    var task by remember(e.id) { mutableStateOf(false) }
    val w = e.wa
    val mine = e.sharedBy == data.me.id
    val author = if (e.out) (if (mine) stringResource(R.string.common_you_short) else Names.person(data, e.sharedBy)?.name?.substringBefore(' ') ?: "")
        else e.from?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.web_wa_someone)
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, shadowElevation = 1.dp,
        modifier = Modifier.widthIn(max = maxW).fillMaxWidth().testTag("mailCard-${e.id}")) {
        Column(Modifier.drawBehind { drawRect(WaGreen, size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height)) }
            .padding(start = 14.dp, end = 12.dp, top = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                WaIcon(22.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("WhatsApp" + (if (w?.accountKind == "business") " Business" else "") + " · " + (if (w?.isGroup == true) "👥 " + stringResource(R.string.web_wa_groupShort) else "") +
                        (w?.chatName ?: e.subject), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("waKind"))
                    Text(androidx.compose.ui.text.buildAnnotatedString {
                        pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)); append(author); pop(); append(" · " + mailDate(e.sentAt))
                    }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(Modifier.fillMaxWidth().height(androidx.compose.foundation.layout.IntrinsicSize.Min).clickable { nav.openMail(e.id, "read") }.testTag("mailCardTitle-${e.id}")) {
                Box(Modifier.width(3.dp).fillMaxHeight().background(WaGreen, RoundedCornerShape(2.dp)))
                Text(e.snippet, style = MaterialTheme.typography.bodyMedium, maxLines = 6, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp).weight(1f).testTag("waQuote"))
            }
            CanonicalAttachments(e.chagguAttachments, e.mediaStatus)
            MailCardComments(e, data, canPost) { nav.openMail(e.id, "comments") }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)) {
                val pad = ButtonDefaults.TextButtonContentPadding
                if (e.issueId != null) OutlinedButton(onClick = { onOpenIssue(e.issueId) }, contentPadding = pad, modifier = Modifier.heightIn(min = 36.dp).testTag("mailCardSeeTask")) { Text("◆ " + stringResource(R.string.web_mail_seeTask)) }
                else if (canPost) OutlinedButton(onClick = { task = true }, contentPadding = pad, modifier = Modifier.heightIn(min = 36.dp).testTag("mailCardTask")) { Text("◆ " + stringResource(R.string.web_mail_task)) }
                if (mine && w != null) OutlinedButton(onClick = nav.openWhatsApp, contentPadding = pad, modifier = Modifier.heightIn(min = 36.dp).testTag("waSeeIn")) { Text(stringResource(R.string.web_wa_seeIn)) }
            }
        }
    }
    if (task) MailTaskSheet(e, data, onClose = { task = false })
}

@Composable
private fun MailCardComments(e: SharedMailDTO, data: BootstrapDTO, canPost: Boolean, onAll: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    var text by androidx.compose.runtime.saveable.rememberSaveable(e.id) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    fun send() {
        val body = text.trim(); if (body.isEmpty() || busy) return
        busy = true
        container.scope.launch {
            runCatching { client.commentMail(e.id, body) }.onSuccess { text = "" }.onFailure { container.toast(errorText(ctx, it)) }
            busy = false
        }
    }
    val shown = e.lastComments.takeLast(2)
    if (shown.isNotEmpty()) Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        shown.forEach { c ->
            val who = if (c.authorId == data.me.id) stringResource(R.string.common_you_short) else Names.person(data, c.authorId)?.name?.substringBefore(' ') ?: ""
            Text(androidx.compose.ui.text.buildAnnotatedString {
                pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)); append(who); pop(); append(" "); append(c.body)
            }, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("mailCardComment"))
        }
        if (e.commentCount > shown.size) TextButton(onClick = onAll, modifier = Modifier.heightIn(min = 32.dp).testTag("mailCardAllComments-${e.id}")) {
            Text(stringResource(R.string.task_card_all, e.commentCount), style = MaterialTheme.typography.labelMedium)
        }
    }
    if (canPost) Row(verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.material3.OutlinedTextField(text, { text = it.take(4000) }, singleLine = true,
            placeholder = { Text(stringResource(if (e.isWhatsApp) R.string.web_mail_commentWaPh else R.string.web_mail_commentCardPh), style = MaterialTheme.typography.bodySmall) },
            textStyle = MaterialTheme.typography.bodySmall,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Send),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSend = { send() }),
            shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("mailCardInput-${e.id}"))
        TextButton(onClick = { send() }, enabled = text.isNotBlank() && !busy, modifier = Modifier.testTag("mailCardSend-${e.id}")) { Text(stringResource(R.string.web_comments_send)) }
    }
}

@Composable
internal fun FileChip(text: String, tag: String, onClick: () -> Unit) {
    Text(text, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.widthIn(max = 240.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp).testTag(tag))
}

/** wa.shared: el mensaje de quien lo trajo con su comentario y la tarjeta verde con el mensaje citado. */
@Composable
internal fun WaSharedRow(m: MessageDTO, b: MailSystem.Body, data: BootstrapDTO, actions: CardActions? = null) {
    val w = b.wa ?: return
    val nav = LocalMailNav.current
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.9f).coerceAtMost(520f).dp
    BroughtBy(m, data, b.comment, "waShared-${m.seq}", actions, b.forwardedFrom) {
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, shadowElevation = 1.dp,
            modifier = Modifier.widthIn(max = maxW).fillMaxWidth().testTag("waCard")) {
            Column(Modifier.drawBehind { drawRect(WaGreen, size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height)) }
                .padding(start = 14.dp, end = 12.dp, top = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    WaIcon(22.dp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text("WhatsApp" + (if (w.accountKind == "business") " Business" else "") +
                            (w.chatName?.let { " · " + (if (w.isGroup) stringResource(R.string.web_wa_groupShort) else "") + it } ?: ""),
                            style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("waKind"))
                        Text((if (w.fromMe) stringResource(R.string.common_you_short) else w.author ?: stringResource(R.string.web_wa_someone)) +
                            (w.sentAt?.let { " · " + mailDate(it) } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Row(Modifier.fillMaxWidth().height(androidx.compose.foundation.layout.IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(WaGreen, RoundedCornerShape(2.dp)))
                    Text(w.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp).weight(1f).testTag("waQuote"))
                }
                if (m.authorId == data.me.id) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    OutlinedButton(onClick = nav.openWhatsApp, modifier = Modifier.heightIn(min = 36.dp).testTag("waSeeIn")) { Text(stringResource(R.string.web_wa_seeIn)) }
                }
            }
        }
    }
}
