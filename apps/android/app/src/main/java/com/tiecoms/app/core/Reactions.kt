package com.tiecoms.app.core

import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Reacciones con emoji (docs/REACCIONES_ENLACES.md; mismas reglas en web, iOS y Android).
 * Sin dependencias de Android: se prueba en la JVM. Las tablas de Unicode son las de emoji-data.txt (Emoji 15.1);
 * el servidor vuelve a normalizar de todos modos, así que un emoji más nuevo que estas tablas igual pasa.
 */
object Reactions {
    /** Barra rápida, en este orden (QUICK_REACTIONS del contrato). */
    val QUICK = listOf("👍", "❤️", "😂", "👀", "✅", "🙏")
    const val LOOK = "👀"
    const val DONE = "✅"
    /** Máximo de emojis distintos por mensaje (MAX_REACTIONS_PER_MESSAGE): pasado eso el API responde 409. */
    const val MAX_PER_MESSAGE = 20

    /** Selector completo: los de uso diario en el trabajo primero; el teclado del sistema trae el resto. */
    val PICKER = listOf(
        "👍", "❤️", "😂", "👀", "✅", "🙏", "👏", "🙌", "🎉", "🔥", "💯", "💪",
        "😀", "😃", "😄", "😁", "😅", "🤣", "😊", "🙂", "😉", "😍", "🥰", "😘",
        "😎", "🤩", "🥳", "😇", "🤗", "🤔", "🤨", "😐", "😑", "🙄", "😏", "😬",
        "😮", "😯", "😲", "😳", "🥺", "😢", "😭", "😤", "😡", "🤯", "😱", "😴",
        "🤝", "👌", "✌️", "🤞", "👋", "✋", "👆", "👇", "👉", "👈", "🫡", "🫶",
        "👎", "🤦", "🤷", "🙋", "💁", "🙆", "🙅", "🧠", "💡", "📌", "📎", "📝",
        "📅", "⏰", "⌛", "🚀", "⭐", "✨", "⚡", "☕", "🍻", "🎂", "🎁", "🏆",
        "💰", "📈", "📉", "📊", "💼", "🏠", "🚗", "✈️", "📞", "💬", "📣", "🔔",
        "❌", "⚠️", "❓", "❗", "➕", "➖", "🆗", "🆕", "🟢", "🟡", "🔴", "⚪",
        "💚", "💙", "💛", "🧡", "💜", "🖤", "🤍", "💔", "🇨🇴", "🇲🇽", "🇵🇪", "🇪🇸",
    )

    private const val VS16 = 0xFE0F
    private const val ZWJ = 0x200D
    private const val KEYCAP = 0x20E3

    // Extended_Pictographic (emoji-data.txt).
    private val PICTO = intArrayOf(
        0x00A9, 0x00A9, 0x00AE, 0x00AE, 0x203C, 0x203C, 0x2049, 0x2049, 0x2122, 0x2122, 0x2139, 0x2139,
        0x2194, 0x2199, 0x21A9, 0x21AA, 0x231A, 0x231B, 0x2328, 0x2328, 0x2388, 0x2388, 0x23CF, 0x23CF,
        0x23E9, 0x23F3, 0x23F8, 0x23FA, 0x24C2, 0x24C2, 0x25AA, 0x25AB, 0x25B6, 0x25B6, 0x25C0, 0x25C0,
        0x25FB, 0x25FE, 0x2600, 0x2605, 0x2607, 0x2612, 0x2614, 0x2685, 0x2690, 0x2705, 0x2708, 0x2712,
        0x2714, 0x2714, 0x2716, 0x2716, 0x271D, 0x271D, 0x2721, 0x2721, 0x2728, 0x2728, 0x2733, 0x2734,
        0x2744, 0x2744, 0x2747, 0x2747, 0x274C, 0x274C, 0x274E, 0x274E, 0x2753, 0x2755, 0x2757, 0x2757,
        0x2763, 0x2767, 0x2795, 0x2797, 0x27A1, 0x27A1, 0x27B0, 0x27B0, 0x27BF, 0x27BF, 0x2934, 0x2935,
        0x2B05, 0x2B07, 0x2B1B, 0x2B1C, 0x2B50, 0x2B50, 0x2B55, 0x2B55, 0x3030, 0x3030, 0x303D, 0x303D,
        0x3297, 0x3297, 0x3299, 0x3299,
        0x1F000, 0x1F0FF, 0x1F10D, 0x1F10F, 0x1F12F, 0x1F12F, 0x1F16C, 0x1F171, 0x1F17E, 0x1F17F,
        0x1F18E, 0x1F18E, 0x1F191, 0x1F19A, 0x1F1AD, 0x1F1E5, 0x1F201, 0x1F20F, 0x1F21A, 0x1F21A,
        0x1F22F, 0x1F22F, 0x1F232, 0x1F23A, 0x1F23C, 0x1F23F, 0x1F249, 0x1F3FA, 0x1F400, 0x1F53D,
        0x1F546, 0x1F64F, 0x1F680, 0x1F6FF, 0x1F774, 0x1F77F, 0x1F7D5, 0x1F7FF, 0x1F80C, 0x1F80F,
        0x1F848, 0x1F84F, 0x1F85A, 0x1F85F, 0x1F888, 0x1F88F, 0x1F8AE, 0x1F8FF, 0x1F90C, 0x1F93A,
        0x1F93C, 0x1F945, 0x1F947, 0x1FAFF, 0x1FC00, 0x1FFFD,
    )

    // Emoji_Presentation: se ven como emoji sin U+FE0F.
    private val PRESENTATION = intArrayOf(
        0x231A, 0x231B, 0x23E9, 0x23EC, 0x23F0, 0x23F0, 0x23F3, 0x23F3, 0x25FD, 0x25FE, 0x2614, 0x2615,
        0x2648, 0x2653, 0x267F, 0x267F, 0x2693, 0x2693, 0x26A1, 0x26A1, 0x26AA, 0x26AB, 0x26BD, 0x26BE,
        0x26C4, 0x26C5, 0x26CE, 0x26CE, 0x26D4, 0x26D4, 0x26EA, 0x26EA, 0x26F2, 0x26F3, 0x26F5, 0x26F5,
        0x26FA, 0x26FA, 0x26FD, 0x26FD, 0x2705, 0x2705, 0x270A, 0x270B, 0x2728, 0x2728, 0x274C, 0x274C,
        0x274E, 0x274E, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797, 0x27B0, 0x27B0, 0x27BF, 0x27BF,
        0x2B1B, 0x2B1C, 0x2B50, 0x2B50, 0x2B55, 0x2B55,
        0x1F004, 0x1F004, 0x1F0CF, 0x1F0CF, 0x1F18E, 0x1F18E, 0x1F191, 0x1F19A, 0x1F1E6, 0x1F1FF,
        0x1F201, 0x1F201, 0x1F21A, 0x1F21A, 0x1F22F, 0x1F22F, 0x1F232, 0x1F236, 0x1F238, 0x1F23A,
        0x1F250, 0x1F251, 0x1F300, 0x1F320, 0x1F32D, 0x1F335, 0x1F337, 0x1F37C, 0x1F37E, 0x1F393,
        0x1F3A0, 0x1F3CA, 0x1F3CF, 0x1F3D3, 0x1F3E0, 0x1F3F0, 0x1F3F4, 0x1F3F4, 0x1F3F8, 0x1F43E,
        0x1F440, 0x1F440, 0x1F442, 0x1F4FC, 0x1F4FF, 0x1F53D, 0x1F54B, 0x1F54E, 0x1F550, 0x1F567,
        0x1F57A, 0x1F57A, 0x1F595, 0x1F596, 0x1F5A4, 0x1F5A4, 0x1F5FB, 0x1F64F, 0x1F680, 0x1F6C5,
        0x1F6CC, 0x1F6CC, 0x1F6D0, 0x1F6D2, 0x1F6D5, 0x1F6D7, 0x1F6DC, 0x1F6DF, 0x1F6EB, 0x1F6EC,
        0x1F6F4, 0x1F6FC, 0x1F7E0, 0x1F7EB, 0x1F7F0, 0x1F7F0, 0x1F90C, 0x1F93A, 0x1F93C, 0x1F945,
        0x1F947, 0x1F9FF, 0x1FA70, 0x1FA7C, 0x1FA80, 0x1FA89, 0x1FA8F, 0x1FAC6, 0x1FACE, 0x1FADC,
        0x1FADF, 0x1FAE9, 0x1FAF0, 0x1FAF8,
    )

    private fun inRanges(t: IntArray, cp: Int): Boolean {
        var i = 0
        while (i < t.size) { if (cp < t[i]) return false; if (cp <= t[i + 1]) return true; i += 2 }
        return false
    }
    fun isPictographic(cp: Int) = inRanges(PICTO, cp)
    private fun isPresentation(cp: Int) = inRanges(PRESENTATION, cp)
    private fun isSkin(cp: Int) = cp in 0x1F3FB..0x1F3FF
    private fun isRegional(cp: Int) = cp in 0x1F1E6..0x1F1FF
    private fun isTag(cp: Int) = cp in 0xE0020..0xE007F
    private fun isKeycapBase(cp: Int) = cp in '0'.code..'9'.code || cp == '#'.code || cp == '*'.code
    /** Pelirrojo, rizos, calvo, canas: van después de un ZWJ. */
    private fun isHairComponent(cp: Int) = cp in 0x1F9B0..0x1F9B3

    private fun cps(s: String): IntArray = s.codePoints().toArray()
    private fun str(cp: IntArray, from: Int = 0, to: Int = cp.size) = String(cp, from, to - from)

    /**
     * Forma canónica (normalizeEmoji del contrato): sin selectores de variación sobrantes y con U+FE0F donde hace
     * falta para verse como emoji (❤ → ❤️, 👍️ → 👍, 1⃣ → 1️⃣). null si no es exactamente un emoji.
     */
    fun normalize(input: String): String? {
        val raw = input.trim()
        if (raw.isEmpty() || raw.length > 32) return null
        val parts = raw.replace("️", "").split("‍").map { part ->
            val p = cps(part)
            if (p.size == 2 && isKeycapBase(p[0]) && p[1] == KEYCAP) return@map str(intArrayOf(p[0], VS16, KEYCAP))
            if (p.isEmpty()) return@map part
            val first = p[0]
            val needs = isPictographic(first) && !isPresentation(first) && !(p.size > 1 && isSkin(p[1]))
            if (needs) str(intArrayOf(first, VS16) + p.copyOfRange(1, p.size)) else part
        }
        val out = parts.joinToString("‍")
        if (clusters(out)?.size != 1) return null
        val o = cps(out)
        if (o.none { isPictographic(it) || isRegional(it) || it == KEYCAP }) return null
        return out
    }

    /**
     * Parte un texto que debería ser solo emojis en sus emojis (grafemas). null si hay algo que no es emoji.
     * Reglas de UAX #29 reducidas a lo que hace falta aquí: banderas (dos indicadores regionales), keycaps,
     * secuencias con ZWJ, tonos de piel y banderas de subdivisión (etiquetas).
     */
    fun clusters(s: String): List<String>? {
        val c = cps(s)
        if (c.isEmpty()) return null
        val out = mutableListOf<String>()
        var i = 0
        fun elementEnd(start: Int): Int {
            var j = start
            val cp = c[j]
            if (isKeycapBase(cp)) {
                j++
                if (j < c.size && c[j] == VS16) j++
                return if (j < c.size && c[j] == KEYCAP) j + 1 else -1
            }
            if (!isPictographic(cp) && !isSkin(cp) && !isHairComponent(cp)) return -1
            j++
            if (j < c.size && c[j] == VS16) j++
            if (j < c.size && isSkin(c[j])) j++
            if (j < c.size && c[j] == VS16) j++
            while (j < c.size && isTag(c[j])) j++
            return j
        }
        while (i < c.size) {
            val start = i
            if (isRegional(c[i])) {
                if (i + 1 >= c.size || !isRegional(c[i + 1])) return null
                i += 2
                out += str(c, start, i); continue
            }
            var j = elementEnd(i)
            if (j < 0) return null
            while (j < c.size && c[j] == ZWJ && j + 1 < c.size) {
                val k = elementEnd(j + 1)
                if (k < 0) return null
                j = k
            }
            i = j
            out += str(c, start, i)
        }
        return out
    }

    /** Solo emojis (de 1 a 3, sin contar espacios): el mensaje se muestra grande (isJumbo de la web). */
    fun isJumbo(body: String): Boolean {
        val s = body.trim()
        if (s.isEmpty() || s.length > 40) return false
        val n = clusters(s.filterNot { it.isWhitespace() })?.size ?: return false
        return n in 1..3
    }

    /** Mi reacción puesta o quitada (la actualización optimista, igual que client.react de la web). */
    fun toggle(list: List<ReactionDTO>, emoji: String, me: String, on: Boolean): List<ReactionDTO> {
        var next = list.map { r -> if (r.emoji == emoji) r.copy(userIds = r.userIds.filter { it != me }) else r }
        if (on) {
            next = if (next.any { it.emoji == emoji }) next.map { r -> if (r.emoji == emoji) r.copy(userIds = r.userIds + me) else r }
            else next + ReactionDTO(emoji, listOf(me))
        }
        return next.filter { it.userIds.isNotEmpty() || it.external.isNotEmpty() }
    }

    fun mine(r: ReactionDTO, me: String) = me in r.userIds

    /** ¿Cabe otro emoji distinto? (el máximo es por emoji nuevo; sumarse a uno que ya está siempre se puede). */
    fun canAdd(list: List<ReactionDTO>, emoji: String) = list.any { it.emoji == emoji } || list.count { it.count > 0 } < MAX_PER_MESSAGE

    /** Recordatorio de 👀: en 3 horas, o mañana a las 9:00 si eso cae de noche (19:00 o después) o en otro día. */
    fun lookRemindAt(now: ZonedDateTime = ZonedDateTime.now(ZoneId.systemDefault())): ZonedDateTime {
        val at = now.plusHours(3)
        if (at.hour >= 19 || at.toLocalDate() != now.toLocalDate()) {
            return ZonedDateTime.of(LocalDateTime.of(now.toLocalDate().plusDays(1), java.time.LocalTime.of(9, 0)), now.zone)
        }
        return at
    }
}
