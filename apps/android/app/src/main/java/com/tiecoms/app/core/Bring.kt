package com.tiecoms.app.core

/** Traer texto pegado o compartido (mismas reglas que apps/web/src/screens/Bring.tsx). */
object Bring {
    data class Line(val author: String, val sentAt: String, val body: String)

    // «[24/9/26, 10:12] Juan: texto» o «24/9/26 10:12 - Juan: texto»
    private val WA_LINE = Regex(
        "^‎?\\[?(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}),?\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[ap]\\.?\\s?m\\.?)?)\\]?\\s*(?:-\\s*)?([^:]{1,60}):\\s([\\s\\S]*)$",
        RegexOption.IGNORE_CASE,
    )
    private val MEDIA = Regex("^<(Multimedia omitido|Media omitted)>$", RegexOption.IGNORE_CASE)

    fun parseWhatsApp(text: String): List<Line> {
        val out = mutableListOf<Line>()
        for (raw in text.replace("\r", "").split('\n')) {
            val m = WA_LINE.find(raw)
            if (m != null) out += Line(author = m.groupValues[3].trim(), sentAt = "${m.groupValues[1]} ${m.groupValues[2]}", body = m.groupValues[4].trim())
            else if (out.isNotEmpty() && raw.isNotBlank()) out[out.size - 1] = out.last().let { it.copy(body = it.body + "\n" + raw) }
        }
        return out.filter { it.body.isNotEmpty() && !MEDIA.matches(it.body) }
    }

    data class Mail(val from: String?, val subject: String?)

    fun parseEmail(text: String): Mail {
        val from = Regex("^(?:De|From):\\s*(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)).find(text)?.groupValues?.get(1)?.trim()
        val subject = Regex("^(?:Asunto|Subject):\\s*(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)).find(text)?.groupValues?.get(1)?.trim()
        return Mail(from, subject)
    }

    val SOURCES = listOf("whatsapp", "slack", "email", "teams", "other")
}
