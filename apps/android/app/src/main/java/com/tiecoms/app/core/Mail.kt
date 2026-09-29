package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

/*
 * Correo en el chat (docs/CORREO.md). La bandeja se lee en vivo de Gmail u Outlook con el token de cada persona;
 * chaggu solo guarda lo que alguien lleva a un chat. Mismo contrato que packages/contracts (MailListItemDTO,
 * SharedMailDTO…). Decodificación tolerante: todos los campos tienen valor por defecto.
 */

@Serializable
data class MailConnectionDTO(
    /** google | microsoft */
    val provider: String = "",
    /** Gmail | Outlook */
    val label: String = "",
    val available: Boolean = false,
    val unavailableReason: String? = null,
    /** none | active | reconnect */
    val status: String = "none",
    val accountEmail: String? = null,
)
@Serializable data class MailConnectionsPage(val connections: List<MailConnectionDTO> = emptyList())

@Serializable data class MailAddressDTO(val name: String? = null, val email: String = "")
@Serializable data class MailAttachmentInfoDTO(val id: String = "", val name: String = "", val size: Long = 0, val contentType: String = "application/octet-stream")

/** Fila de la lista (en vivo, no se guarda). */
@Serializable
data class MailListItemDTO(
    val provider: String = "google",
    val id: String = "",
    val threadId: String? = null,
    val from: MailAddressDTO? = null,
    val to: List<MailAddressDTO> = emptyList(),
    val subject: String = "",
    val snippet: String = "",
    val date: String? = null,
    val unread: Boolean = false,
    val hasAttachments: Boolean = false,
    /** inbox | sent */
    val box: String = "inbox",
)
@Serializable data class MailListDTO(val items: List<MailListItemDTO> = emptyList(), val nextPage: String? = null, val accountEmail: String? = null)

/** Correo completo leído en vivo (vista previa antes de compartir). */
@Serializable
data class MailMessageDTO(
    val provider: String = "google",
    val id: String = "",
    val threadId: String? = null,
    val from: MailAddressDTO? = null,
    val to: List<MailAddressDTO> = emptyList(),
    val cc: List<MailAddressDTO> = emptyList(),
    val subject: String = "",
    val snippet: String = "",
    val date: String? = null,
    val unread: Boolean = false,
    val hasAttachments: Boolean = false,
    val box: String = "inbox",
    val body: String = "",
    val attachments: List<MailAttachmentInfoDTO> = emptyList(),
)

@Serializable data class SharedMailCommentDTO(val id: String = "", val emailId: String = "", val authorId: String = "", val body: String = "", val createdAt: String = "")
@Serializable data class ScheduledReplyDTO(val id: String = "", val sendAt: String = "")

/** Correo que alguien llevó a un chat (tarjeta). El cuerpo solo llega con ?full=1. */
@Serializable
data class SharedMailDTO(
    val id: String = "",
    val conversationId: String = "",
    val sharedBy: String = "",
    val provider: String = "google",
    val accountEmail: String? = null,
    /** in | out */
    val direction: String = "in",
    val from: MailAddressDTO? = null,
    val to: List<MailAddressDTO> = emptyList(),
    val cc: List<MailAddressDTO> = emptyList(),
    val subject: String = "",
    val snippet: String = "",
    val body: String = "",
    val full: Boolean = false,
    /** Se guardó solo lo nuevo: el historial citado y la firma se ven con GET /mail/shared/:id/original. */
    val trimmed: Boolean = false,
    val sentAt: String? = null,
    val attachments: List<MailAttachmentInfoDTO> = emptyList(),
    val messageId: String? = null,
    val comment: String? = null,
    /** pending | scheduled | replied */
    val status: String = "pending",
    val repliedAt: String? = null,
    val repliedBy: String? = null,
    /** Respuesta programada pendiente (solo la ve quien la programó). */
    val scheduledReply: ScheduledReplyDTO? = null,
    val issueId: String? = null,
    val commentCount: Int = 0,
    val lastComments: List<SharedMailCommentDTO> = emptyList(),
    val createdAt: String = "",
    /** Abrir en Gmail/Outlook (solo para quien lo compartió). */
    val webLink: String? = null,
    /** provider «whatsapp»: un mensaje de WhatsApp llevado al chat (from.name es el autor; subject, el chat). */
    val wa: SharedWaMetaDTO? = null,
) {
    val out: Boolean get() = direction == "out"
    val isWhatsApp: Boolean get() = provider == "whatsapp"
}
@Serializable data class SharedWaMetaDTO(val chatName: String? = null, val isGroup: Boolean = false, val accountKind: String = "personal", val accountId: String = "", val jid: String = "")
@Serializable data class SharedMailsPage(val emails: List<SharedMailDTO> = emptyList())
@Serializable data class MailCommentsPage(val comments: List<SharedMailCommentDTO> = emptyList())
@Serializable data class MailCommentResult(val comment: SharedMailCommentDTO = SharedMailCommentDTO(), val email: SharedMailDTO = SharedMailDTO())
@Serializable data class MailBodyResult(val body: String = "")
@Serializable data class MailTaskResult(val issue: IssueDTO? = null, val email: SharedMailDTO = SharedMailDTO())
@Serializable data class MailConnectResult(val url: String = "")
@Serializable data class MailConfirmResult(val ok: Boolean = false, val provider: String = "")
@Serializable data class WaShareResult(val message: MessageDTO? = null, val messages: List<MessageDTO> = emptyList(), val emails: List<SharedMailDTO> = emptyList())

object Mail {
    const val HOST = "mail"
    const val PATH = "/connected"
    val PROVIDERS = listOf("google", "microsoft")
    const val BATCH = 50

    fun label(provider: String): String = when (provider) { "microsoft" -> "Outlook"; "whatsapp" -> "WhatsApp"; else -> "Gmail" }
    /** Compartir en varios chats a la vez: hasta 10. */
    const val MAX_CHATS = 10
    fun toggleChat(picked: List<String>, id: String): List<String> = if (id in picked) picked - id else if (picked.size >= MAX_CHATS) picked else picked + id

    // ---------- Lista: carpeta, pestañas y filtros ----------
    /** Pestañas de Recibidos. La primera es la de por defecto (Principal / Prioritarios, sin promociones). */
    fun categories(provider: String): List<String> =
        if (provider == "microsoft") listOf("focused", "other", "any") else listOf("primary", "updates", "promotions", "social", "forums", "any")

    data class Filters(
        /** inbox | sent | all */
        val box: String = "inbox",
        val q: String = "",
        val from: String = "",
        val to: String = "",
        /** AAAA-MM-DD */
        val after: String = "",
        val before: String = "",
        val attachments: Boolean = false,
        val unread: Boolean = false,
        val label: String = "",
        /** today | 7 | 30 | year | older | custom | null */
        val range: String? = null,
    ) {
        /** Hay búsqueda o algún filtro: el encabezado dice «N resultados en todo tu Gmail». */
        val filtered: Boolean get() = q.isNotEmpty() || from.isNotEmpty() || to.isNotEmpty() || after.isNotEmpty() || before.isNotEmpty() || attachments || unread || label.isNotEmpty()
    }

    /**
     * Pestaña que se pide: fuera de Recibidos, ninguna. Si la persona eligió una, esa. Al buscar sin haber elegido,
     * todas (any). Si no, la primera (Principal / Prioritarios).
     */
    fun category(f: Filters, chosen: String?, provider: String): String? = when {
        f.box != "inbox" -> null
        chosen != null -> chosen
        f.q.isNotEmpty() || f.from.isNotEmpty() || f.to.isNotEmpty() || f.label.isNotEmpty() -> "any"
        else -> categories(provider).first()
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /** GET /mail/messages?… con lo que tiene valor (igual que client-core listMail). */
    fun listQuery(provider: String, f: Filters, category: String?, page: String? = null, fresh: Boolean = false): String {
        val p = mutableListOf("provider" to provider, "box" to f.box)
        category?.let { p += "category" to it }
        if (f.q.isNotEmpty()) p += "q" to f.q
        if (f.from.isNotEmpty()) p += "from" to f.from
        if (f.to.isNotEmpty()) p += "to" to f.to
        if (f.after.isNotEmpty()) p += "after" to f.after
        if (f.before.isNotEmpty()) p += "before" to f.before
        if (f.attachments) p += "attachments" to "1"
        if (f.unread) p += "unread" to "1"
        if (f.label.isNotEmpty()) p += "label" to f.label
        page?.let { p += "page" to it }
        if (fresh) p += "fresh" to "1"
        return "/mail/messages?" + p.joinToString("&") { "${it.first}=${enc(it.second)}" }
    }

    /** Filtro de fecha rápido → (after, before), en AAAA-MM-DD. «Cualquier fecha» ("") los borra. */
    fun dateRange(key: String, today: LocalDate): Pair<String, String> {
        fun back(days: Long) = today.minusDays(days).toString()
        return when (key) {
            "today" -> back(0) to ""
            "7" -> back(7) to ""
            "30" -> back(30) to ""
            "year" -> "${today.year}-01-01" to ""
            "older" -> "" to back(365)
            else -> "" to ""
        }
    }
    fun withRange(f: Filters, key: String, today: LocalDate): Filters {
        val (a, b) = dateRange(key, today)
        return f.copy(after = a, before = b, range = key.ifEmpty { null })
    }

    // ---------- Tarjeta y estado ----------
    /** Una tarjeta sin cuerpo (lote o en vivo) no borra el cuerpo que ya se había cargado al abrir el correo. */
    fun merge(prev: SharedMailDTO?, next: SharedMailDTO): SharedMailDTO =
        if (!next.full && prev?.full == true) next.copy(body = prev.body, full = true) else next

    /**
     * `mail.updated` llega sin cuerpo, sin respuesta programada ni enlace (va igual para todos): se conserva lo que yo
     * ya sabía mientras siga programado, y el enlace a Gmail/Outlook.
     */
    fun fromLive(prev: SharedMailDTO?, live: SharedMailDTO): SharedMailDTO =
        merge(prev, live.copy(scheduledReply = if (live.status == "scheduled") prev?.scheduledReply else null, webLink = prev?.webLink))

    /** Al comentar vuelve la tarjeta; la respuesta programada que ya conocía no se pierde. */
    fun afterComment(prev: SharedMailDTO?, next: SharedMailDTO): SharedMailDTO = merge(prev, next.copy(scheduledReply = prev?.scheduledReply ?: next.scheduledReply))

    enum class Status { REPLIED_BY_ME, REPLIED, SCHEDULED, SENT_BY_ME, SENT, PENDING }

    fun status(e: SharedMailDTO, me: String?): Status = when {
        e.status == "replied" -> if (e.repliedBy == me) Status.REPLIED_BY_ME else Status.REPLIED
        e.status == "scheduled" -> Status.SCHEDULED
        e.out -> if (e.sharedBy == me) Status.SENT_BY_ME else Status.SENT
        else -> Status.PENDING
    }

    /** «Responder» solo para quien lo trajo (sale de su buzón) y si no está respondido ni programado. */
    fun canReply(e: SharedMailDTO, me: String?): Boolean = !e.isWhatsApp && me != null && e.sharedBy == me && e.status != "replied" && e.status != "scheduled"

    /** La otra persona del correo: el remitente si lo recibí, el primer destinatario si lo envié. */
    fun other(e: SharedMailDTO): MailAddressDTO? = if (e.out) e.to.firstOrNull() else e.from
    fun other(m: MailListItemDTO): MailAddressDTO? = if (m.box == "sent") m.to.firstOrNull() else m.from
    fun who(a: MailAddressDTO?): String = a?.let { it.name?.takeIf { n -> n.isNotBlank() } ?: it.email } ?: ""
    fun full(a: MailAddressDTO): String = when {
        a.name.isNullOrBlank() -> a.email
        a.email.isBlank() -> a.name // WhatsApp: el autor, sin correo
        else -> "${a.name} <${a.email}>"
    }
    fun firstName(a: MailAddressDTO?): String = who(a).substringBefore(' ')

    fun kb(n: Long): String = if (n >= 1024 * 1024) String.format(java.util.Locale.US, "%.1f MB", n / 1024.0 / 1024.0) else "${maxOf(1L, Math.round(n / 1024.0))} KB"

    /** Extensión corta para el ícono del adjunto (PDF, XLSX…). */
    fun ext(name: String): String = name.substringAfterLast('.', "").take(4).uppercase()

    // ---------- Responder ----------
    /** A quién va la respuesta: al remitente; si el correo lo mandé yo, a los mismos destinatarios. */
    fun replyTo(e: SharedMailDTO): List<MailAddressDTO> = if (e.out) e.to else listOfNotNull(e.from)

    /** CC por defecto: todos los del correo menos yo y el destinatario, sin repetir. */
    fun defaultCc(e: SharedMailDTO): List<String> {
        val me = (e.accountEmail ?: "").lowercase()
        val to = replyTo(e).map { it.email.lowercase() }.toSet()
        return (e.to + e.cc).map { it.email.lowercase() }.filter { it.isNotEmpty() && it != me && it !in to }.distinct()
    }

    fun parseCc(text: String): List<String> = text.split(Regex("[,;\\s]+")).map { it.trim() }.filter { it.isNotEmpty() }
    private val EMAIL = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")
    fun badCc(list: List<String>): Boolean = list.any { !EMAIL.matches(it) }

    /** Archivos del chat para adjuntar a la respuesta: los últimos 12 de los mensajes cargados (sin notas de voz), el más nuevo primero. */
    fun chatFiles(messages: List<MessageDTO>): List<Pair<AttachmentDTO, String>> =
        messages.filter { it.deletedAt == null }.flatMap { m -> m.attachments.filter { !it.isVoice }.map { it to m.authorId } }.takeLast(12).reversed()

    // ---------- Tarea ----------
    /** RE:, RV:, FW:, FWD: y AW: del principio del asunto, repetidos o no. */
    fun cleanSubject(s: String): String = s.replace(Regex("^\\s*((re|rv|fw|fwd|aw)\\s*:\\s*)+", RegexOption.IGNORE_CASE), "")

    /** Título propuesto: «Responder a Jorge: Comité…» si lo recibí; el asunto si lo envié. Máx. 200. */
    fun taskTitle(e: SharedMailDTO, prefix: String): String =
        (if (!e.out) "$prefix ${firstName(e.from)}: ${cleanSubject(e.subject)}" else e.subject).take(200)

    // ---------- Conectar ----------
    /** Vuelta de «Conectar» desde el navegador: chaggu://mail/connected?mail=1&provider=…&receipt=… | &error=… */
    fun parseReturn(raw: String?): Meetings.Return? {
        val uri = runCatching { URI(raw?.trim() ?: return null) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != DeepLinks.SCHEME || uri.host?.lowercase() != HOST) return null
        if (uri.rawPath?.trimEnd('/') != PATH) return null
        val q = (uri.rawQuery ?: "").split('&').mapNotNull {
            val i = it.indexOf('=')
            if (i <= 0) null else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }.toMap()
        val provider = q["provider"]?.takeIf { it in PROVIDERS }
        val receipt = q["receipt"]
        if (provider != null && receipt?.matches(Regex("[A-Za-z0-9_-]{20,200}")) == true && q["error"].isNullOrBlank()) return Meetings.Return.Pending(provider, receipt)
        return Meetings.Return.Failed(provider, q["error"]?.takeIf { it.isNotBlank() } ?: "failed")
    }

    // ---------- Programar ----------
    /** «Programar envío»: En 1 hora, En 3 horas, Mañana a las 9:00 y El lunes a las 9:00 (quickTimes sin «20 min»). */
    fun scheduleTimes(now: Instant, zone: ZoneId): List<Pair<String, Instant>> {
        val today = now.atZone(zone).toLocalDate()
        fun at9(d: LocalDate) = d.atTime(9, 0).atZone(zone).toInstant()
        return listOf(
            "1h" to now.plusSeconds(3600),
            "3h" to now.plusSeconds(3 * 3600),
            "tomorrow" to at9(today.plusDays(1)),
            "monday" to at9(today.with(TemporalAdjusters.next(DayOfWeek.MONDAY))),
        )
    }
    /** El servidor acepta hasta 90 días y no una hora que ya pasó (con un minuto de margen). */
    fun validSendAt(at: Instant, now: Instant): Boolean = at.isAfter(now.minusSeconds(60)) && at.isBefore(now.plusSeconds(90L * 86_400))
}
