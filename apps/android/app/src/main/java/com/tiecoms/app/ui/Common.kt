package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.zIndex
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tiecoms.app.AppContainer
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.OrganizationDTO
import com.tiecoms.app.core.PersonDTO
import com.tiecoms.app.ui.theme.Brand
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.NetworkException
import com.tiecoms.app.core.TcJson
import com.tiecoms.app.core.TieComsClient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

val LocalClient = staticCompositionLocalOf<TieComsClient> { error("sin cliente") }
val LocalContainer = staticCompositionLocalOf<AppContainer> { error("sin contenedor") }

fun isSpanish(): Boolean = Locale.getDefault().language == "es"

/** Texto legible de un error del API (el servidor responde en español). */
fun errorText(ctx: Context, e: Throwable): String = when (e) {
    is NetworkException -> ctx.getString(R.string.err_network)
    // 413 del proxy (nginx) o del API: el cuerpo no es JSON y el mensaje sería «HTTP 413».
    is ApiException if e.status == 413 -> ctx.getString(R.string.err_payload_too_large)
    is ApiException -> {
        val key = when (e.code) {
            "unauthorized" -> R.string.err_unauthorized
            "conflict" -> R.string.err_conflict
            "forbidden" -> R.string.err_forbidden
            "not_found" -> R.string.err_not_found
            "rate_limited" -> R.string.err_rate_limited
            "bad_request" -> R.string.err_bad_request
            "internal" -> R.string.err_internal
            "sso_expired" -> R.string.sso_expired
            "sso_state" -> R.string.err_sso_state
            "sso_cancelled" -> R.string.err_sso_cancelled
            "sso_failed" -> R.string.err_sso_failed
            "sso_unavailable" -> R.string.err_sso_unavailable
            "sso_personal_account" -> R.string.err_sso_personal_account
            "sso_email_unverified" -> R.string.err_sso_email_unverified
            "account_disabled" -> R.string.err_account_disabled
            "domain_claimed" -> R.string.err_domain_claimed
            "storage_unavailable" -> R.string.err_storage_unavailable
            "side_outsider" -> R.string.err_side_outsider
            "blocked_user" -> R.string.err_blocked_user
            "calls_disabled" -> R.string.err_calls_disabled
            "not_in_call" -> R.string.err_not_in_call
            else -> null
        }
        when {
            key == null && !e.message.isNullOrBlank() && !e.message!!.startsWith("HTTP ") -> e.message!!
            e.code == "bad_request" -> ctx.getString(R.string.err_bad_request) + detailPaths(e)
            key != null && isSpanish() && e.code != "unauthorized" && e.code != "sso_expired" && !e.code.startsWith("sso_") && !e.message.isNullOrBlank() -> e.message!!
            key != null -> ctx.getString(key)
            else -> ctx.getString(R.string.err_generic)
        }
    }
    else -> ctx.getString(R.string.err_generic)
}

private fun detailPaths(e: ApiException): String {
    val paths = (e.details as? JsonArray)?.mapNotNull { ((it as? JsonObject)?.get("path") as? JsonPrimitive)?.contentOrNull?.takeIf { p -> p.isNotBlank() } }?.distinct()
    return if (paths.isNullOrEmpty()) "" else ": " + paths.joinToString(", ")
}

/** Mensajes de sistema: {"k": clave, ...datos}; los antiguos llegan como texto plano. */
fun systemText(ctx: Context, body: String, author: String? = null): String {
    if (!body.startsWith("{")) return body
    if (body.length > 32_000) return ctx.getString(R.string.system_message)
    // La vista previa de la lista llega recortada (140 caracteres): si el JSON quedó incompleto se
    // recuperan los campos de texto que sí alcanzaron a llegar, para nunca mostrar JSON crudo.
    val o = runCatching { TcJson.parseToJsonElement(body) as JsonObject }.getOrNull() ?: partialSystemJson(body)
        ?: return ctx.getString(R.string.system_message)
    fun str(k: String): String = when (val v = o[k]) {
        is JsonPrimitive -> v.contentOrNull ?: ""
        is JsonArray -> v.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.joinToString(", ")
        else -> ""
    }
    // Llamadas (docs/LLAMADAS.md): call.started, call.ended · m:ss, transcripción prendida/apagada y guardada.
    com.tiecoms.app.core.Calls.systemCall(o)?.let { c -> return callSystemText(ctx, c) }
    // Tanda 1.7: es hoy, tarea hecha/vencida y comentarios agrupados.
    com.tiecoms.app.core.System17.parse(o)?.let { b -> return system17Text(ctx, b) }
    // gg (docs/GG-CHAT.md): lo que dejó listo, como una línea; nunca el JSON.
    if (str("k") == "gg.actions") {
        val n = (o["actions"] as? JsonArray)?.size ?: 0
        return if (n > 0) ctx.getString(R.string.gg_actions_preview, n) else "gg"
    }
    // Correo y WhatsApp en el chat (docs/CORREO.md): el texto de sys.mail.* / sys.wa.shared, nunca el JSON.
    com.tiecoms.app.core.MailSystem.parse(o)?.let { b -> return mailSystemText(ctx, b) }
    return when (str("k")) {
        "workspace.created" -> ctx.getString(R.string.sys_workspace_created, str("name"))
        "group.created" -> ctx.getString(R.string.sys_group_created, str("name"))
        "members.added" -> ctx.getString(if (str("history") == "all") R.string.sys_members_added_all else R.string.sys_members_added, str("names"))
        "member.left" -> ctx.getString(R.string.sys_member_left, str("name"))
        "member.removed" -> ctx.getString(R.string.sys_member_removed, str("name"))
        "member.joined" -> ctx.getString(R.string.sys_member_joined, str("name"))
        "admin.added" -> ctx.getString(R.string.sys_admin_added, str("name"))
        "admin.removed" -> ctx.getString(R.string.sys_admin_removed, str("name"))
        "integration.added" -> ctx.getString(R.string.sys_integration_added, str("name"))
        "integration.removed" -> ctx.getString(R.string.sys_integration_removed, str("name"))
        "chat.created" -> ctx.getString(R.string.sys_chat_created, str("names"))
        "issue.created" -> ctx.getString(R.string.sys_issue_created, str("title"))
        "issue.closed" -> ctx.getString(R.string.sys_issue_closed, str("title"))
        "issue.reopened" -> ctx.getString(R.string.sys_issue_reopened, str("title"))
        "derived.here" -> ctx.getString(R.string.sys_derived_here, str("parent"), str("excerpt"))
        "derived.from" -> ctx.getString(R.string.sys_derived_from)
        "returned" -> ctx.getString(R.string.sys_returned)
        "event.created" -> ctx.getString(R.string.sys_event_created, str("title"), parseInstant(str("startsAt"))?.let { whenText(it) } ?: "")
        "event.moved" -> ctx.getString(R.string.sys_event_moved, str("title"), parseInstant(str("startsAt"))?.let { whenText(it) } ?: "")
        "event.cancelled" -> ctx.getString(R.string.sys_event_cancelled, str("title"))
        // Sin campos: quién lo hizo es el autor del mensaje de sistema.
        "group.photo_changed" -> listOfNotNull(author?.takeIf { it.isNotBlank() }, ctx.getString(R.string.sys_group_photo_changed)).joinToString(" · ")
        "group.photo_removed" -> listOfNotNull(author?.takeIf { it.isNotBlank() }, ctx.getString(R.string.sys_group_photo_removed)).joinToString(" · ")
        "side.started" -> if (str("parentName").isNotEmpty()) ctx.getString(R.string.sys_side_started_in, str("authorName"), str("parentName"), str("excerpt"))
            else ctx.getString(R.string.sys_side_started, str("authorName"), str("excerpt"))
        // Una clave que esta versión no conoce: nunca se muestra el JSON crudo.
        else -> if (str("k").isEmpty()) body else ctx.getString(R.string.system_message)
    }
}

/** Texto de los mensajes de sistema del correo y de WhatsApp (mismos textos que la web: sys.mail.*, sys.wa.shared). */
fun mailSystemText(ctx: Context, b: com.tiecoms.app.core.MailSystem.Body): String = when (b.key) {
    "mail.shared" -> ctx.getString(R.string.web_sys_mail_shared, b.subject.ifEmpty { ctx.getString(R.string.web_mail_noSubject) })
    "mail.comments" -> ctx.getString(R.string.web_sys_mail_comments, b.lastByName ?: "", b.subject.ifEmpty { ctx.getString(R.string.web_mail_noSubject) }, b.lastExcerpt ?: "")
    "mail.replied" -> ctx.getString(R.string.web_sys_mail_replied, b.byName ?: "", b.subject.ifEmpty { ctx.getString(R.string.web_mail_noSubject) })
    "mail.reply_failed" -> ctx.getString(R.string.web_sys_mail_reply_failed, b.subject.ifEmpty { ctx.getString(R.string.web_mail_noSubject) }, b.error ?: "")
    else -> ctx.getString(R.string.web_sys_wa_shared)
}

fun callSystemText(ctx: Context, c: com.tiecoms.app.core.Calls.SystemCall): String = when (c.key) {
    "call.started" -> ctx.getString(R.string.sys_call_started)
    "call.ended" -> c.durationSec?.let { ctx.getString(R.string.sys_call_ended, com.tiecoms.app.core.Calls.clock(it)) } ?: ctx.getString(R.string.sys_call_ended_plain)
    "call.transcription.on" -> ctx.getString(R.string.sys_call_transcription_on, c.name)
    "call.transcription.off" -> ctx.getString(R.string.sys_call_transcription_off, c.name)
    else -> ctx.getString(R.string.sys_call_transcript)
}

fun system17Text(ctx: Context, b: com.tiecoms.app.core.System17.Body): String = when (b.key) {
    "event.today" -> ctx.getString(R.string.sys_event_today, b.title, parseInstant(b.startsAt)?.atZone(ZoneId.systemDefault())?.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)) ?: "")
    "issue.done" -> ctx.getString(R.string.sys_issue_done, b.byName ?: "", b.title)
    "issue.overdue" -> ctx.getString(R.string.sys_issue_overdue, b.title, dueDateText(b.dueDate))
    "issue.comments" -> if (b.count <= 1) ctx.getString(R.string.sys_issue_comments_one, b.lastByName ?: "", b.title, b.lastExcerpt ?: "") else ctx.getString(R.string.sys_issue_comments_n, b.count, b.title)
    else -> if (b.count <= 1) ctx.getString(R.string.sys_event_comments_one, b.lastByName ?: "", b.title, b.lastExcerpt ?: "") else ctx.getString(R.string.sys_event_comments_n, b.count, b.title)
}

/** AAAA-MM-DD → fecha local media («29 sept 2026»). */
fun dueDateText(d: String?): String = d?.let { runCatching { LocalDate.parse(it.take(10)).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) }.getOrNull() } ?: (d ?: "")

fun roleText(ctx: Context, role: String) = ctx.getString(
    when (role) { "admin" -> R.string.role_admin; "guest" -> R.string.role_guest; "lead" -> R.string.role_lead; else -> R.string.role_member },
)

// ---------- Fechas ----------
fun parseInstant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }
private val zone: ZoneId get() = ZoneId.systemDefault()
fun localDate(iso: String?): LocalDate? = parseInstant(iso)?.atZone(zone)?.toLocalDate()
fun timeText(iso: String?): String = parseInstant(iso)?.atZone(zone)?.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)) ?: ""

/** Hora relativa de la lista: hoy → hora; ayer; esta semana → día; antes → fecha. */
fun relativeTime(ctx: Context, iso: String?): String {
    val t = parseInstant(iso)?.atZone(zone) ?: return ""
    val d = t.toLocalDate()
    val today = LocalDate.now(zone)
    return when {
        d == today -> t.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))
        d == today.minusDays(1) -> ctx.getString(R.string.yesterday)
        d.isAfter(today.minusDays(7)) -> d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
        else -> d.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT))
    }
}

fun dayText(ctx: Context, d: LocalDate): String {
    val today = LocalDate.now(zone)
    return when (d) {
        today -> ctx.getString(R.string.today)
        today.minusDays(1) -> ctx.getString(R.string.yesterday)
        else -> d.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    }
}

fun dateText(iso: String?): String = localDate(iso)?.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) ?: (iso ?: "")

fun parseColor(hex: String?, fallback: Color): Color = runCatching {
    val h = hex!!.removePrefix("#")
    val v = h.toLong(16)
    when (h.length) { 6 -> Color(0xFF000000 or v); 8 -> Color(v); else -> fallback }
}.getOrDefault(fallback)

/**
 * Avatar con iniciales y el color de la empresa (decorativo para lectores de pantalla).
 * Con [photo] (ruta relativa /api/v1/avatars/… o URL) se pinta la foto encima; mientras carga o si falla, quedan las iniciales.
 */
@Composable
fun Avatar(label: String, bg: Color, fg: Color, size: Dp = 44.dp, square: Boolean = false, modifier: Modifier = Modifier, photo: String? = null) {
    Box(
        modifier = modifier.size(size).clip(if (square) RoundedCornerShape(12.dp) else CircleShape).background(bg).clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (label.length <= 2) label else Names.initials(label),
            color = fg,
            fontWeight = FontWeight.SemiBold,
            // Tamaño fijo relativo al círculo: el avatar es decorativo y no debe desbordarse.
            fontSize = with(LocalDensity.current) { (size * 0.38f).toSp() },
            maxLines = 1,
        )
        if (!photo.isNullOrBlank()) RemoteImage(photo, Modifier.matchParentSize(), sizeHint = size)
    }
}

/** Campos "clave":"texto" de un JSON de sistema recortado. null si ni siquiera trae la clave k. */
fun partialSystemJson(body: String): JsonObject? {
    val pairs = Regex("\"(\\w+)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").findAll(body).associate { it.groupValues[1] to JsonPrimitive(it.groupValues[2]) }
    if ("k" !in pairs) return null
    return JsonObject(pairs)
}

/** Color estable de una persona (paleta de 8 sin naranja), para su avatar y su nombre en los grupos. */
@Composable
fun personColor(id: String): Color {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    return Color(if (dark) com.tiecoms.app.core.PersonColors.dark(id) else com.tiecoms.app.core.PersonColors.light(id))
}

/** Avatar del autor en las burbujas: su foto o sus iniciales sobre su color estable (texto blanco). */
@Composable
fun AuthorAvatar(p: PersonDTO?, id: String, size: Dp = 28.dp, modifier: Modifier = Modifier) {
    if (com.tiecoms.app.core.Gg.isGg(id)) { Box(modifier.size(size), contentAlignment = Alignment.Center) { GgMark(size * 0.9f) }; return }
    Avatar(p?.name ?: "?", Color(com.tiecoms.app.core.PersonColors.light(id)), Color.White, size = size, photo = p?.avatarUrl, modifier = modifier)
}

/** Avatar de una persona: su foto o sus iniciales sobre el color de su empresa. Ya no lleva el logo de la empresa en la
 * esquina (`orgBadge` se ignora): el nombre de la empresa va escrito junto a la persona y la letra suelta confundía. */
@Composable
fun PersonAvatar(p: PersonDTO?, data: BootstrapDTO?, size: Dp = 40.dp, orgBadge: Boolean = false, modifier: Modifier = Modifier) {
    if (com.tiecoms.app.core.Gg.isGg(p?.id, data)) { Box(modifier.size(size), contentAlignment = Alignment.Center) { GgMark(size * 0.9f) }; return }
    val org = Names.org(data, p?.orgId)
    Box(modifier.size(size)) {
        Avatar(p?.name ?: "?", parseColor(org?.colorBg, Brand.Black), parseColor(org?.colorFg, Color.White), size = size, photo = p?.avatarUrl)
        Box(Modifier.align(Alignment.BottomEnd)) { AvailabilityBadge(if (p?.id == data?.me?.id) data?.me?.availability else p?.availability) }
    }
}

/** Logo de una empresa: su marca (org.mark) sobre sus colores. */
@Composable
fun OrgMark(org: OrganizationDTO?, size: Dp = 20.dp, modifier: Modifier = Modifier) {
    val bg = parseColor(org?.colorBg, Color(0xFFBDB5AE))
    val fg = parseColor(org?.colorFg, Color.White)
    val label = org?.mark?.takeIf { it.isNotBlank() } ?: org?.name?.let { Names.initials(it) } ?: "?"
    Box(
        modifier.size(size).clip(RoundedCornerShape(size * 0.28f)).background(bg)
            .border(1.dp, MaterialTheme.colorScheme.surface, RoundedCornerShape(size * 0.28f)).clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        Text(label.take(3), color = fg, fontWeight = FontWeight.Bold, maxLines = 1,
            fontSize = with(LocalDensity.current) { (size * if (label.length > 2) 0.34f else 0.46f).toSp() })
    }
}

/** Caritas apiladas de un chat grupal (hasta 3 personas distintas de mí). */
@Composable
fun StackedAvatars(c: ConversationDTO, data: BootstrapDTO?, size: Dp = 44.dp) {
    val others = Names.others(c, data).take(3)
    if (others.isEmpty()) {
        Avatar("👥", MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant, size = size)
        return
    }
    val face = if (others.size == 1) size else size * 0.66f
    val step = if (others.size == 1) 0.dp else (size - face) / (others.size - 1)
    Box(Modifier.size(size).clearAndSetSemantics {}) {
        others.forEachIndexed { i, p ->
            val org = Names.org(data, p.orgId)
            Avatar(
                p.name, parseColor(org?.colorBg, Brand.Black), parseColor(org?.colorFg, Color.White), size = face, photo = p.avatarUrl,
                modifier = Modifier.offset(x = step * i, y = if (i % 2 == 0) 0.dp else size - face).zIndex((3 - i).toFloat())
                    .border(1.5.dp, MaterialTheme.colorScheme.surface, CircleShape),
            )
        }
    }
}

/** Imagen pública del API (foto o miniatura) con caché; no pinta nada mientras carga o si falla. */
@Composable
fun RemoteImage(path: String, modifier: Modifier = Modifier, sizeHint: Dp = 96.dp, contentScale: ContentScale = ContentScale.Crop) {
    val client = LocalClient.current
    val images = LocalContainer.current.images
    val url = remember(path, client.baseUrl) { client.mediaUrl(path) } ?: return
    val px = with(LocalDensity.current) { sizeHint.roundToPx() }.coerceIn(32, 1024)
    // 1.7.15: un reintento corto si la primera carga falla (la vista previa puede tardar en estar lista en el servidor).
    val bmp by produceState(images.cached(url, px), url, px) {
        if (value == null) value = images.load(url, px)
        if (value == null) { kotlinx.coroutines.delay(2_000); value = images.load(url, px, retry = true) }
    }
    bmp?.let { Image(it, contentDescription = null, modifier = modifier, contentScale = contentScale) }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontWeight = FontWeight.SemiBold,
        modifier = modifier,
    )
}

/** Texto de error para el retorno del SSO (?error=código&message=texto), como errorText({code, message}) de la web. */
fun ssoErrorText(ctx: Context, code: String, message: String?): String {
    val e = ApiException(400, code, message ?: "")
    val mapped = errorText(ctx, e)
    return if (mapped == ctx.getString(R.string.err_generic) && !message.isNullOrBlank()) message else mapped
}

/** Textos de la vista previa de adjuntos («📷 Foto», «📷 3 fotos»…), de la web (att.*). */
fun attLabels(ctx: Context): com.tiecoms.app.core.Attachments.Labels {
    fun f(id: Int) = ctx.getString(id).replace("%1\$d", "%d").replace("%1\$s", "%s")
    return com.tiecoms.app.core.Attachments.Labels(f(R.string.att_photo), f(R.string.att_photos), f(R.string.att_video), f(R.string.att_videos),
        f(R.string.att_media), f(R.string.att_file), f(R.string.att_files), f(R.string.voice_preview))
}
