package com.tiecoms.app.core

/**
 * Formato básico en los mensajes, como en WhatsApp y en la web (apps/web/src/fmt.tsx): *negrilla*, _cursiva_,
 * ~tachado~ y `código`. Mismas reglas: sin espacio junto a la marca por dentro, nada multilínea, y «_» (o cualquier
 * marca) pegada a una letra o número por fuera no cuenta (nombre_de_archivo.pdf). Las viñetas («- » o «* » al inicio
 * de línea) se ven como «• » ([bullets], mide lo mismo: las posiciones de las menciones no cambian).
 *
 * [spans] da los rangos en el texto original, con las marcas incluidas; la burbuja las oculta al pintar.
 */
object Fmt {
    enum class Kind { BOLD, ITALIC, STRIKE, CODE }

    /** [start, end) incluye las dos marcas: la de apertura en [start] y la de cierre en end - 1. */
    data class Span(val start: Int, val end: Int, val kind: Kind)

    private val FMT = Regex("`[^`\\n]+`|\\*[^\\s*](?:[^*\\n]*[^\\s*])?\\*|_[^\\s_](?:[^_\\n]*[^\\s_])?_|~[^\\s~](?:[^~\\n]*[^\\s~])?~")
    private val WORD = Regex("[\\p{L}\\p{N}]")
    private val BULLET = Regex("(^|\\n)([ \\t]*)[-*] (?=\\S)")

    private fun kind(c: Char) = when (c) { '*' -> Kind.BOLD; '_' -> Kind.ITALIC; '~' -> Kind.STRIKE; else -> Kind.CODE }
    private fun word(c: Char?) = c != null && WORD.matches(c.toString())

    /** Rangos con formato de un tramo de texto plano (sin enlaces ni menciones: la burbuja los separa antes). */
    fun spans(text: String): List<Span> {
        if (text.length < 3 || text.none { it == '*' || it == '_' || it == '~' || it == '`' }) return emptyList()
        return FMT.findAll(text).mapNotNull { m ->
            val start = m.range.first
            val end = m.range.last + 1
            // Pegado a una letra o número por fuera (a_b_c, 2*3*4 sin espacios) no es formato.
            if (word(text.getOrNull(start - 1)) || word(text.getOrNull(end))) null else Span(start, end, kind(text[start]))
        }.toList()
    }

    /** «- » o «* » al inicio de línea → «• » (misma longitud). */
    fun bullets(s: String): String = if (s.none { it == '-' || it == '*' }) s else s.replace(BULLET, "$1$2• ")

    /** El texto como se ve (sin marcas) y los rangos del formato sobre ese texto (sin las marcas). */
    fun render(text: String): Pair<String, List<Span>> {
        val sb = StringBuilder()
        val out = mutableListOf<Span>()
        var at = 0
        spans(text).forEach { sp ->
            sb.append(text, at, sp.start)
            val s = sb.length
            sb.append(text, sp.start + 1, sp.end - 1)
            out += Span(s, sb.length, sp.kind)
            at = sp.end
        }
        sb.append(text, at, text.length)
        return sb.toString() to out
    }
}
