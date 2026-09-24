package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tiecoms.app.AppContainer
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
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
fun systemText(ctx: Context, body: String): String {
    if (!body.startsWith("{")) return body
    val o = runCatching { TcJson.parseToJsonElement(body) as JsonObject }.getOrNull() ?: return body
    fun str(k: String): String = when (val v = o[k]) {
        is JsonPrimitive -> v.contentOrNull ?: ""
        is JsonArray -> v.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.joinToString(", ")
        else -> ""
    }
    return when (str("k")) {
        "workspace.created" -> ctx.getString(R.string.sys_workspace_created, str("name"))
        "group.created" -> ctx.getString(R.string.sys_group_created, str("name"))
        "members.added" -> ctx.getString(if (str("history") == "all") R.string.sys_members_added_all else R.string.sys_members_added, str("names"))
        "member.left" -> ctx.getString(R.string.sys_member_left, str("name"))
        "member.removed" -> ctx.getString(R.string.sys_member_removed, str("name"))
        "member.joined" -> ctx.getString(R.string.sys_member_joined, str("name"))
        "issue.created" -> ctx.getString(R.string.sys_issue_created, str("title"))
        "issue.closed" -> ctx.getString(R.string.sys_issue_closed, str("title"))
        "issue.reopened" -> ctx.getString(R.string.sys_issue_reopened, str("title"))
        "derived.here" -> ctx.getString(R.string.sys_derived_here, str("parent"), str("excerpt"))
        "derived.from" -> ctx.getString(R.string.sys_derived_from)
        "returned" -> ctx.getString(R.string.sys_returned)
        "event.created" -> ctx.getString(R.string.sys_event_created, str("title"), parseInstant(str("startsAt"))?.let { whenText(it) } ?: "")
        "event.moved" -> ctx.getString(R.string.sys_event_moved, str("title"), parseInstant(str("startsAt"))?.let { whenText(it) } ?: "")
        "event.cancelled" -> ctx.getString(R.string.sys_event_cancelled, str("title"))
        else -> body
    }
}

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

/** Avatar con iniciales y el color de la empresa (decorativo para lectores de pantalla). */
@Composable
fun Avatar(label: String, bg: Color, fg: Color, size: Dp = 44.dp, square: Boolean = false, modifier: Modifier = Modifier) {
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
    }
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
