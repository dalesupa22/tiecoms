package com.tiecoms.app.core

/** Enlaces del texto, reenvío a varios chats, rutas de fotos y recorte: lógica pura (probada en la JVM). */
object Links {
    /** Un tramo del texto: [url] no nulo si es un enlace. */
    data class Part(val text: String, val url: String? = null)

    private val URL = Regex("""\bhttps?://[^\s<>"'`]+""", RegexOption.IGNORE_CASE)
    private val TRAIL = Regex("""[.,;:!?¿¡)\]}»”’]+$""")

    /** Parte el texto como Linkify de la web: la puntuación final no es parte del enlace. */
    fun split(text: String): List<Part> {
        val out = mutableListOf<Part>()
        var i = 0
        for (m in URL.findAll(text)) {
            if (m.range.first > i) out += Part(text.substring(i, m.range.first))
            val raw = m.value
            val trail = TRAIL.find(raw)?.value ?: ""
            val href = raw.dropLast(trail.length)
            out += if (href.substringAfter("://").isNotEmpty()) Part(href, href) else Part(href)
            if (trail.isNotEmpty()) out += Part(trail)
            i = m.range.last + 1
        }
        if (i < text.length) out += Part(text.substring(i))
        return out
    }
}

/** Un mensaje a poner en la cola de envío. */
data class Outgoing(val conversationId: String, val body: String, val forwarded: ForwardedInfo? = null)

object Forwarding {
    /**
     * Reenvío a otros chats (como la web): hasta [MAX_FORWARD_TARGETS] destinos distintos, sin el chat de origen.
     * Por cada destino: primero el comentario (si hay) como mensaje normal y luego el texto original con
     * `forwarded {source: tiecoms, author, sentAt, fromConversationId}`.
     */
    fun plan(source: MessageDTO, targets: List<String>, comment: String?, author: String?): List<Outgoing> {
        val note = comment?.trim().orEmpty()
        val info = ForwardedInfo("tiecoms", author, source.createdAt.ifBlank { null }, source.conversationId.ifBlank { null })
        return targets.distinct().filter { it.isNotBlank() && it != source.conversationId }.take(MAX_FORWARD_TARGETS).flatMap { t ->
            listOfNotNull(if (note.isNotEmpty()) Outgoing(t, note) else null, Outgoing(t, source.body, info))
        }
    }
}

object Media {
    /** Las fotos y miniaturas llegan relativas (/api/v1/avatars/…, /api/v1/previews/…): se les antepone el origen del API. */
    fun absolute(path: String?, baseUrl: String): String? {
        if (path.isNullOrBlank()) return null
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        return baseUrl.trimEnd('/') + (if (path.startsWith("/")) path else "/$path")
    }

    /** Cuadrado centrado para recortar una foto de [w]×[h]: (x, y, lado). */
    fun centerSquare(w: Int, h: Int): Triple<Int, Int, Int> {
        val side = minOf(w, h).coerceAtLeast(1)
        return Triple(((w - side) / 2).coerceAtLeast(0), ((h - side) / 2).coerceAtLeast(0), side)
    }

    /** inSampleSize (potencia de 2) para decodificar una imagen sin pasar de [target] en su lado menor. */
    fun sampleSize(w: Int, h: Int, target: Int): Int {
        var s = 1
        while (minOf(w, h) / (s * 2) >= target) s *= 2
        return s
    }

    /** Tamaño legible (como la web): B, KB o MB. */
    fun sizeText(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> "${Math.round(n / 1024.0)} KB"
        n < 10L * 1024 * 1024 -> String.format(java.util.Locale.ROOT, "%.1f MB", n / 1024.0 / 1024.0)
        else -> "${Math.round(n / 1024.0 / 1024.0)} MB"
    }

    /** Ícono por tipo de archivo (fileIcon de la web). */
    fun fileIcon(type: String, name: String): String {
        val n = name.lowercase()
        return when {
            type.startsWith("image/") -> "🖼"
            type.startsWith("video/") -> "🎞"
            type.startsWith("audio/") -> "🎵"
            type == "application/pdf" || n.endsWith(".pdf") -> "📕"
            Regex("sheet|excel|csv").containsMatchIn(type) || Regex("""\.(xlsx?|csv)$""").containsMatchIn(n) -> "📊"
            Regex("presentation|powerpoint").containsMatchIn(type) || Regex("""\.pptx?$""").containsMatchIn(n) -> "📽"
            Regex("word|document|rtf|text/").containsMatchIn(type) || Regex("""\.(docx?|txt|md)$""").containsMatchIn(n) -> "📄"
            Regex("zip|compressed|tar|rar").containsMatchIn(type) -> "🗜"
            else -> "📎"
        }
    }
}
