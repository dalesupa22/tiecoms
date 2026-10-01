package com.tiecoms.app.core

/** The picker belongs to native chats; external mail/WhatsApp composers cannot use it. */
object CreativeMedia {
    fun available(kind: String?): Boolean = kind in setOf("group", "internal", "direct", "multi")
    fun language(raw: String): String = if (raw.lowercase().startsWith("es")) "es" else "en"
    fun cataloguePath(query: String, lang: String, cursor: String? = null): String {
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        val q = query.trim().take(100)
        val path = if (q.isBlank()) "/gifs/trending?lang=${language(lang)}" else "/gifs/search?q=${enc(q)}&lang=${language(lang)}"
        return path + cursor?.takeIf { it.isNotBlank() }?.let { "&cursor=${enc(it)}" }.orEmpty()
    }
    /** Tokens and private meme captions must never be sent to a provider URL. */
    fun isProxy(path: String): Boolean = path.startsWith("/api/v1/gifs/media?t=") && !path.contains('#')
    fun attribution(item: CreativeMediaDTO): String = listOfNotNull(item.attribution?.takeIf { it.isNotBlank() },
        item.sourceUrl?.takeIf { it.startsWith("https://") }).distinct().joinToString(" · ")
    fun body(text: String, sources: List<String>): String = (listOf(text) + sources.filter { it.isNotBlank() }.distinct()).filter { it.isNotBlank() }.joinToString("\n\n")
}
