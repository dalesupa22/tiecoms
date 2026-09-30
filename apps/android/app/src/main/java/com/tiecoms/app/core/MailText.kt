package com.tiecoms.app.core

import java.net.URI

/**
 * Texto de un correo para leerlo en el chat (como apps/web/src/mail-text.ts). Los correos HTML pasados a texto traen
 * el «alt» y la dirección de cada imagen («header-logo [http://…/header.png]») y enlaces largos: las imágenes se
 * quitan y los enlaces quedan como «dominio ↗» tocable.
 */
object MailText {
    sealed interface Part
    data class Plain(val text: String) : Part
    data class Link(val href: String, val label: String) : Part

    private val LINK = Regex("\\[(https?://[^\\]\\s]+)]|<(https?://[^>\\s]+)>|(\\bhttps?://[^\\s<>\"'\\]]+)", RegexOption.IGNORE_CASE)
    private val IMG = Regex("\\.(png|jpe?g|gif|svg|webp|bmp)(\\?|#|$)|/(img|images?|pixel|track|open)\\b", RegexOption.IGNORE_CASE)
    // Línea que solo es el «alt» de una imagen: una palabra sin espacios tipo header-logo, img_footer, spacer.
    private val ALT_LINE = Regex("^[\\t ]*[\\w.-]*(logo|img|image|banner|icon|spacer|header|footer|pixel)[\\w.-]*[\\t ]*$",
        setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE))
    private val TRAIL = Regex("[.,;:!?)\\]}»”’]+$")

    fun host(u: String): String = runCatching { URI(u).host?.lowercase()?.removePrefix("www.") }.getOrNull()?.takeIf { it.isNotBlank() } ?: u.take(40)

    fun parts(raw: String): List<Part> {
        val out = mutableListOf<Part>()
        var last = 0
        for (m in LINK.findAll(raw)) {
            val bare = m.groups[3]?.value
            val url = m.groups[1]?.value ?: m.groups[2]?.value ?: bare!!
            val trail = if (bare != null) TRAIL.find(url)?.value ?: "" else ""
            val href = if (trail.isNotEmpty()) url.dropLast(trail.length) else url
            out += Plain(raw.substring(last, m.range.first))
            if (!IMG.containsMatchIn(href)) out += Link(href, host(href))
            if (trail.isNotEmpty()) out += Plain(trail)
            last = m.range.last + 1
        }
        out += Plain(raw.substring(last))
        // Se juntan los tramos de texto seguidos y se limpian las líneas vacías o con solo el «alt» de una imagen.
        val joined = mutableListOf<Part>()
        for (p in out) {
            val prev = joined.lastOrNull()
            if (p is Plain && prev is Plain) joined[joined.size - 1] = Plain(prev.text + p.text) else joined += p
        }
        val clean = joined.map { p ->
            if (p is Plain) Plain(p.text.replace(ALT_LINE, "").replace(Regex("[ \\t]+\\n"), "\n").replace(Regex("\\n{3,}"), "\n\n")) else p
        }.toMutableList()
        (clean.firstOrNull() as? Plain)?.let { clean[0] = Plain(it.text.trimStart()) }
        (clean.lastOrNull() as? Plain)?.let { clean[clean.size - 1] = Plain(it.text.trimEnd()) }
        return clean
    }

    /** Resumen de una línea sin direcciones ni «alt» de imágenes. */
    fun snippet(raw: String): String =
        parts(raw).joinToString(" ") { if (it is Plain) it.text else "" }.replace(Regex("\\s+"), " ").replace(Regex("\\s+([.,;:!?)])"), "$1").trim()

    /**
     * Página para el WebView: el HTML ya viene limpio del API (sin scripts, formularios ni on*). Viewport al ancho y
     * las imágenes sin pasarse del ancho; sin JavaScript en el WebView.
     */
    fun htmlPage(html: String): String =
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:\">" +
            "<style>html,body{margin:0;background:#fff;color:#1f1f1f;font:14px/1.45 -apple-system,Roboto,sans-serif;overflow-wrap:anywhere}" +
            "body{padding:12px}img{max-width:100%!important;height:auto!important}table{max-width:100%!important}a{color:#1a5fd6}</style></head><body>" +
            html + "</body></html>"
}
