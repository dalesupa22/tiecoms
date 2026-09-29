package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters

/*
 * Tanda 1.7 (docs/TANDA-1.7.md; contratos «contratos 1.7» ea9536e): #grupos, «Es hoy», tarea hecha/vencida,
 * comentarios agrupados, búsqueda en el chat y mensajes de una sola vista. Todo en Kotlin puro (se prueba en la JVM).
 */

/** Etiqueta #Nombre a otra conversación: tramo del body (UTF-16) que empieza con «#». */
@Serializable data class MessageRefDTO(val conversationId: String = "", val name: String = "", val start: Int = 0, val length: Int = 0)
@Serializable data class RefInput(val conversationId: String, val start: Int, val length: Int)
@Serializable data class OpenedBy(val userId: String = "", val at: String = "")
/** POST /messages/:id/open: el contenido, una sola vez (URLs firmadas de 60 s). */
@Serializable data class ViewOnceOpenDTO(val body: String = "", val attachments: List<AttachmentDTO> = emptyList())
@Serializable data class EventCommentDTO(val id: String = "", val eventId: String = "", val authorId: String = "", val body: String = "", val createdAt: String = "")
@Serializable data class ChatSearchResultDTO(
    val message: MessageDTO = MessageDTO(), val snippet: String = "",
    /** [inicio, largo] dentro de snippet. */
    val matches: List<List<Int>> = emptyList(), val field: String? = null,
)
@Serializable data class ChatSearchPageDTO(val results: List<ChatSearchResultDTO> = emptyList(), val hasMore: Boolean = false)

// ---------- #grupos ----------
object Refs {
    /** En el compositor, las #etiquetas viajan junto a las menciones como tokens con este prefijo en userId. */
    const val TOKEN = "#ref:"
    const val MAX = 20
    const val MAX_QUERY = 40

    fun isRef(m: MentionDTO) = m.userId.startsWith(TOKEN)
    fun token(conversationId: String, start: Int, length: Int) = MentionDTO(TOKEN + conversationId, start, length)

    /** Búsqueda activa: «#» al inicio o tras un espacio, hasta el cursor, sin salto de línea. (inicio del #, texto). */
    fun query(text: String, cursor: Int, tokens: List<MentionDTO> = emptyList()): Pair<Int, String>? {
        if (cursor <= 0 || cursor > text.length) return null
        val at = text.lastIndexOf('#', cursor - 1).takeIf { it >= 0 } ?: return null
        if (tokens.any { at >= it.start && at < it.start + it.length }) return null
        if (at > 0 && !text[at - 1].isWhitespace()) return null
        val q = text.substring(at + 1, cursor)
        if (q.length > MAX_QUERY || q.contains('\n') || q.startsWith(' ') || q.contains("  ")) return null
        return at to q
    }

    /** Elegir una conversación: «#consulta» → «#Nombre » y agrega el token (corre los que vienen después). */
    fun insert(text: String, tokens0: List<MentionDTO>, at0: Int, cursor0: Int, name: String, conversationId: String): Triple<String, List<MentionDTO>, Int> {
        val cursor = cursor0.coerceIn(0, text.length)
        val at = at0.coerceIn(0, cursor)
        val tokens = Mentions.sanitize(text, tokens0)
        val tok = "#$name"
        val ins = "$tok "
        val next = text.substring(0, at) + ins + text.substring(cursor)
        val delta = ins.length - (cursor - at)
        val shifted = tokens.filter { it.start + it.length <= at || it.start >= cursor }.map { if (it.start >= cursor) it.copy(start = it.start + delta) else it }
        return Triple(next, (shifted + token(conversationId, at, tok.length)).sortedBy { it.start }, at + ins.length)
    }

    /** Separa los tokens del compositor en menciones y refs, recortando el body como el servidor. */
    fun split(body: String, tokens: List<MentionDTO>): Triple<String, List<MentionDTO>, List<RefInput>> {
        val (text, ments) = Mentions.trim(body, tokens.filter { !isRef(it) })
        val lead = body.length - body.trimStart().length
        val refs = tokens.filter(::isRef).map { it.copy(start = it.start - lead) }
            .filter { it.start >= 0 && it.start + it.length <= text.length && it.length in 2..200 && text[it.start] == '#' }
            .sortedBy { it.start }.take(MAX)
            .map { RefInput(it.userId.removePrefix(TOKEN), it.start, it.length) }
        return Triple(text, ments, refs)
    }

    /** Refs de un mensaje como tokens (para editar o pintar junto a las menciones). */
    fun tokens(m: MessageDTO): List<MentionDTO> = m.refs.map { token(it.conversationId, it.start, it.length) }

    /** Al tocar #Nombre: la abro si la tengo en mi lista; si no, «No tienes acceso a #Nombre». */
    fun canOpen(d: BootstrapDTO?, conversationId: String): Boolean = d?.conversations?.any { it.id == conversationId } == true

    /** Conversaciones que puedo etiquetar: grupos, chats y directos que veo, por nombre (sin tildes). */
    fun candidates(d: BootstrapDTO, q: String, title: (ConversationDTO) -> String, exclude: String? = null): List<Pair<ConversationDTO, String>> {
        val f = Mentions.fold(q.trim())
        return d.conversations.asSequence().filter { !it.isSide && it.id != exclude }
            .map { it to title(it) }
            .filter { (_, t) -> f.isEmpty() || Mentions.fold(t).contains(f) }
            .sortedWith(compareBy<Pair<ConversationDTO, String>> { (_, t) -> if (Mentions.fold(t).startsWith(f)) 0 else 1 }.thenByDescending { it.first.lastMessageAt ?: "" })
            .take(8).toList()
    }
}

// ---------- Mensajes de sistema nuevos ----------
object System17 {
    val KEYS = setOf("event.today", "issue.done", "issue.overdue", "issue.comments", "event.comments")

    data class Body(
        val key: String, val eventId: String?, val issueId: String?, val title: String, val startsAt: String?, val timezone: String?,
        val byId: String?, val byName: String?, val ownerId: String?, val ownerName: String?, val dueDate: String?,
        val count: Int, val lastById: String?, val lastByName: String?, val lastExcerpt: String?,
    )

    fun parse(m: MessageDTO): Body? = if (m.kind != "system" || !m.body.startsWith("{")) null
        else runCatching { TcJson.parseToJsonElement(m.body) as? JsonObject }.getOrNull()?.let { parse(it) }

    fun parse(o: JsonObject): Body? {
        fun s(k: String) = (o[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
        val k = s("k") ?: return null
        if (k !in KEYS) return null
        return Body(k, s("eventId"), s("issueId"), s("title") ?: "", s("startsAt"), s("timezone"), s("byId"), s("byName"),
            s("ownerId"), s("ownerName"), s("dueDate"), (o["count"] as? JsonPrimitive)?.intOrNull ?: 1, s("lastById"), s("lastByName"), s("lastExcerpt"))
    }

    /** Fechas rápidas de «Nueva fecha» en una tarea vencida: Hoy, Mañana y Próximo lunes. */
    fun quickDates(today: LocalDate): List<LocalDate> = listOf(today, today.plusDays(1), today.with(TemporalAdjusters.next(DayOfWeek.MONDAY)))
}

// ---------- Una sola vista ----------
object ViewOnce {
    enum class Kind { TEXT, PHOTO, VOICE }

    /** Estado para mí: sent si lo escribí yo; opened si estoy en openedBy (o el servidor lo dice); si no, unopened. */
    fun state(m: MessageDTO, me: String?): String = when {
        m.authorId == me -> "sent"
        m.viewOnceState == "opened" || m.openedBy.any { it.userId == me } -> "opened"
        else -> "unopened"
    }

    fun kind(m: MessageDTO): Kind = when {
        m.attachments.any { it.isVoice } -> Kind.VOICE
        m.attachments.any { it.isImage } -> Kind.PHOTO
        else -> Kind.TEXT
    }

    /** Se puede prender «una vista» para el próximo mensaje: solo texto, imágenes o una nota de voz (nunca archivos). */
    fun allowed(attachments: List<AttachmentDTO>): Boolean = attachments.all { it.isImage || it.isVoice }

    /** Lo que no se puede hacer con un mensaje de una sola vista (el servidor responde 409 view_once). */
    fun blocksActions(m: MessageDTO): Boolean = m.viewOnce

    /** Quiénes lo abrieron (el autor ve «Visto por …»). */
    fun openedNames(m: MessageDTO, name: (String) -> String?): List<String> = m.openedBy.mapNotNull { name(it.userId) }

    /** Vista previa y notificación: «① Foto», «① Mensaje», «① Nota de voz», nunca el contenido. */
    fun preview(s: AttachmentSummaryDTO?, photo: String, voice: String, text: String): String = "① " + when {
        (s?.images ?: 0) > 0 -> photo
        (s?.voices ?: 0) > 0 -> voice
        else -> text
    }
    fun preview(m: MessageDTO, photo: String, voice: String, text: String): String = "① " + when (kind(m)) { Kind.PHOTO -> photo; Kind.VOICE -> voice; Kind.TEXT -> text }
}

// ---------- Buscar dentro del chat ----------
/** «3 de 17» con ↑ ↓: el índice actual sobre los resultados (del más nuevo al más viejo). */
data class ChatSearchNav(val results: List<ChatSearchResultDTO> = emptyList(), val index: Int = 0, val hasMore: Boolean = false) {
    val current: ChatSearchResultDTO? get() = results.getOrNull(index)
    val total: Int get() = results.size
    /** ↑ = más viejo (siguiente resultado), ↓ = más nuevo. */
    fun older(): ChatSearchNav = if (index < results.size - 1) copy(index = index + 1) else this
    fun newer(): ChatSearchNav = if (index > 0) copy(index = index - 1) else this
    val needsMore: Boolean get() = hasMore && index >= results.size - 1
    /** before = seq del último resultado que ya tengo. */
    val before: Long? get() = results.lastOrNull()?.message?.seq
    fun append(page: ChatSearchPageDTO): ChatSearchNav = copy(results = (results + page.results).distinctBy { it.message.id }, hasMore = page.hasMore)

    companion object {
        const val MIN = 2
        const val DEBOUNCE_MS = 250L
        fun ready(q: String) = q.trim().length >= MIN
    }
}

/** Rangos a resaltar de [query] dentro de [text], sin importar mayúsculas ni tildes (mismo largo: NFD por carácter). */
fun matchRanges(text: String, query: String): List<IntRange> {
    val q = Mentions.fold(query.trim())
    if (q.length < ChatSearchNav.MIN) return emptyList()
    // Doblar carácter a carácter conserva los índices del texto original.
    val folded = buildString { text.forEach { c -> val f = Mentions.fold(c.toString()); append(if (f.length == 1) f[0] else c.lowercaseChar()) } }
    val out = mutableListOf<IntRange>()
    var i = folded.indexOf(q)
    while (i >= 0) { out += i until i + q.length; i = folded.indexOf(q, i + q.length) }
    return out
}

/** Comentarios de eventos: GET /events/:id/comments puede llegar como {comments:[…]} o como lista. */
fun decodeEventComments(el: JsonElement): List<EventCommentDTO> {
    val arr = (el as? JsonObject)?.get("comments") as? JsonArray ?: el as? JsonArray ?: return emptyList()
    return arr.mapNotNull { runCatching { TcJson.decodeFromJsonElement(EventCommentDTO.serializer(), it) }.getOrNull()?.takeIf { c -> c.id.isNotEmpty() } }
}
