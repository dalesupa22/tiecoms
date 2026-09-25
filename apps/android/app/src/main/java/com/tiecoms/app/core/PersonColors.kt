package com.tiecoms.app.core

/**
 * Color estable por persona (quién escribió qué en grupos): se deriva del id con FNV-1a 32 bits,
 * así es el mismo en cada sesión y en cada plataforma. Paleta de 8 colores accesibles con texto blanco,
 * sin naranja (el naranja es de mis burbujas).
 */
object PersonColors {
    /** ARGB, idéntica a PERSON_COLORS de la web (apps/web/src/ui.tsx): avatares con iniciales blancas. */
    val LIGHT = longArrayOf(0xFF2F6FDB, 0xFF1E8E5A, 0xFF7C4DDB, 0xFF0B8793, 0xFFB83280, 0xFF4C51BF, 0xFF52606D, 0xFFC53030)
    /** Mismo tono aclarado (mezcla 45 % con blanco) para el nombre del autor sobre fondo oscuro. */
    val DARK = LongArray(LIGHT.size) { i -> lighten(LIGHT[i], 0.45) }

    /** FNV-1a de 32 bits sobre el id en minúsculas, módulo 8 (como personColor de la web). */
    fun index(id: String): Int {
        var h = 0x811C9DC5L
        for (ch in id.lowercase()) { h = h xor ch.code.toLong(); h = (h * 0x01000193L) and 0xFFFFFFFFL }
        return (h % LIGHT.size).toInt()
    }

    fun light(id: String): Long = LIGHT[index(id)]
    fun dark(id: String): Long = DARK[index(id)]

    private fun lighten(argb: Long, t: Double): Long {
        fun ch(shift: Int): Long { val c = (argb shr shift) and 0xFF; return Math.round(c + (255 - c) * t) and 0xFF }
        return (0xFFL shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }
}

/** Agrupado de rachas: nombre y avatar solo en el primer mensaje de una racha del mismo autor (< 5 min). */
object Runs {
    const val WINDOW_MS = 5 * 60_000L

    fun startsRun(prevAuthor: String?, prevKind: String?, prevAtMs: Long?, author: String, kind: String, atMs: Long, reply: Boolean, forwarded: Boolean): Boolean {
        if (kind == "system") return false
        if (prevAuthor == null || prevKind == "system" || prevKind == null || prevAtMs == null) return true
        if (prevAuthor != author || reply || forwarded) return true
        return atMs - prevAtMs >= WINDOW_MS
    }
}
