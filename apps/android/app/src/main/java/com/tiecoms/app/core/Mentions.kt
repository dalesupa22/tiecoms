package com.tiecoms.app.core

import java.text.Normalizer

/**
 * Menciones con @ (SPEC-v4 §H), en Kotlin puro. Los offsets son unidades UTF-16 sobre el body, igual que los String de
 * Kotlin: un emoji ocupa 2 y «á» (NFC) ocupa 1. El body viaja legible («@Laura Gómez ¿lo revisas?») y las menciones al lado.
 */
object Mentions {
    const val ALL = "all"
    const val MAX = 50
    const val MAX_QUERY = 30

    /** Sin tildes y en minúsculas, para buscar «lau», «gomez», «LAURA». */
    fun fold(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase()

    /** El servidor recorta el body: se recorta aquí y se corren los offsets (lo que queda fuera se descarta). */
    fun trim(body: String, mentions: List<MentionDTO>): Pair<String, List<MentionDTO>> {
        val lead = body.length - body.trimStart().length
        val text = body.trim()
        val out = mentions.map { it.copy(start = it.start - lead) }
            .filter { it.start >= 0 && it.start + it.length <= text.length && it.length in 2..200 && text[it.start] == '@' }
            .sortedBy { it.start }.take(MAX)
        return text to out
    }

    /** Búsqueda activa: «@» al inicio o tras un espacio, hasta el cursor, sin salto de línea. Devuelve (inicio del @, texto). */
    fun query(text: String, cursor: Int, tokens: List<MentionDTO> = emptyList()): Pair<Int, String>? {
        if (cursor <= 0 || cursor > text.length) return null
        val at = text.lastIndexOf('@', cursor - 1).takeIf { it >= 0 } ?: return null
        // Un «@» que ya es un token elegido no abre el buscador.
        if (tokens.any { at >= it.start && at < it.start + it.length }) return null
        if (at > 0 && !text[at - 1].isWhitespace()) return null
        val q = text.substring(at + 1, cursor)
        if (q.length > MAX_QUERY || q.contains('\n') || q.startsWith(' ') || q.contains("  ")) return null
        return at to q
    }

    data class Candidate(val userId: String, val name: String, val line: String)

    /**
     * Participantes de la conversación (sin mí) que coinciden por nombre, apellido o correo (sin tildes), primero los que
     * más escriben ahí; «@todos» al final en grupos, chats grupales y sidechats.
     */
    fun candidates(d: BootstrapDTO, c: ConversationDTO, q: String, recent: List<MessageDTO>, allLabel: String): List<Candidate> {
        val f = fold(q.trim())
        val count = recent.groupingBy { it.authorId }.eachCount()
        val people = c.memberIds.filter { it != d.me.id }.mapNotNull { Names.person(d, it) }
            .filter { p -> f.isEmpty() || fold(p.name).split(' ').any { it.startsWith(f) } || fold(p.name).startsWith(f) }
            .sortedWith(compareByDescending<PersonDTO> { count[it.id] ?: 0 }.thenBy { fold(it.name) })
            .map { p -> Candidate(p.id, p.name, listOfNotNull(Names.roleLine(p).ifBlank { null }, Names.org(d, p.orgId)?.name).joinToString(" · ")) }
        val group = c.kind != "direct"
        val all = if (group && (f.isEmpty() || fold(allLabel).startsWith(f) || "all".startsWith(f) || "todos".startsWith(f))) listOf(Candidate(ALL, allLabel, "")) else emptyList()
        return people.take(8) + all
    }

    /** Alguien que NO está en la conversación y coincide («Laura no está en este chat · Añadir / Sidechat»). */
    fun outsider(d: BootstrapDTO, c: ConversationDTO, q: String): PersonDTO? {
        val f = fold(q.trim()); if (f.length < 2) return null
        return d.people.firstOrNull { p -> p.id != d.me.id && p.id !in c.memberIds && p.kind == "human" && fold(p.name).split(' ').any { it.startsWith(f) } }
    }

    /**
     * Tokens que caben en [text]: dentro del rango, sin solaparse y ordenados. Un token viejo (de un borrador restaurado,
     * de un mensaje editado o de un toque que llegó después de que cambió el texto) nunca debe provocar un substring fuera
     * de rango.
     */
    fun sanitize(text: String, mentions: List<MentionDTO>): List<MentionDTO> {
        var end = 0
        return mentions.filter { it.start >= 0 && it.length > 0 && it.start + it.length <= text.length }.sortedBy { it.start }
            .filter { m -> (m.start >= end).also { ok -> if (ok) end = m.start + m.length } }
    }

    /** Elegir un candidato: reemplaza «@consulta» por «@Nombre » y agrega el token; corre los que vienen después. */
    fun insert(text: String, mentions0: List<MentionDTO>, at0: Int, cursor0: Int, name: String, userId: String): Triple<String, List<MentionDTO>, Int> {
        // El toque puede llegar con posiciones de una composición anterior (se siguió escribiendo o se borró): se acotan.
        val cursor = cursor0.coerceIn(0, text.length)
        val at = at0.coerceIn(0, cursor)
        val mentions = sanitize(text, mentions0)
        val token = "@$name"
        val insert = "$token "
        val next = text.substring(0, at) + insert + text.substring(cursor)
        val delta = insert.length - (cursor - at)
        val shifted = mentions.filter { it.start + it.length <= at || it.start >= cursor }.map { if (it.start >= cursor) it.copy(start = it.start + delta) else it }
        return Triple(next, (shifted + MentionDTO(userId, at, token.length)).sortedBy { it.start }, at + insert.length)
    }

    /**
     * Cambio de texto con tokens: un retroceso dentro de un token lo borra entero; escribir dentro de un token lo quita (vuelve
     * a ser texto). Devuelve (texto, tokens, cursor).
     */
    fun edit(old: String, new: String, mentions0: List<MentionDTO>, cursor: Int): Triple<String, List<MentionDTO>, Int> {
        val mentions = sanitize(old, mentions0)
        if (old == new || mentions.isEmpty()) return Triple(new, sanitize(new, mentions), cursor.coerceIn(0, new.length))
        var p = 0
        while (p < old.length && p < new.length && old[p] == new[p]) p++
        var so = old.length; var sn = new.length
        while (so > p && sn > p && old[so - 1] == new[sn - 1]) { so--; sn-- }
        // old[p, so) se reemplazó por new[p, sn)
        val deletion = sn == p && so > p
        val hit = mentions.filter { it.start < so && it.start + it.length > p }
        if (deletion && hit.isNotEmpty()) {
            val from = minOf(p, hit.minOf { it.start }); val to = maxOf(so, hit.maxOf { it.start + it.length })
            val text = old.substring(0, from) + old.substring(to)
            val d = to - from
            val rest = mentions.filter { it !in hit }.map { if (it.start >= to) it.copy(start = it.start - d) else it }
            return Triple(text, rest, from)
        }
        val delta = (sn - p) - (so - p)
        val rest = mentions.filter { it.start + it.length <= p || it.start >= so }.map { if (it.start >= so) it.copy(start = it.start + delta) else it }
        return Triple(new, rest, cursor)
    }

    /** ¿Me mencionan (a mí o @todos)? */
    fun mentionsMe(m: MessageDTO, me: String?): Boolean = me != null && m.authorId != me && m.mentions.any { it.userId == me || it.userId == ALL }
}
