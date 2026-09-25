package com.tiecoms.app.core

import kotlin.math.pow

/** Contraste WCAG para los badges de no leídos (SPEC-v4 §C): color de la empresa solo si pasa AA con texto blanco. */
object Contrast {
    /** Naranja sobrio de respaldo (BADGE_ORANGE de la web): 5,0:1 con blanco. */
    const val SOBER_ORANGE = 0xFFB45309
    /** Globo de una conversación silenciada. */
    const val MUTED = 0xFF7A7368

    fun parse(hex: String?): Long? {
        // Igual que contrastWithWhite de la web: solo #RRGGBB (otro formato no cuenta como color de empresa).
        val h = hex?.trim()?.removePrefix("#") ?: return null
        if (!Regex("^[0-9a-fA-F]{6}$").matches(h)) return null
        return h.toLong(16) or 0xFF000000
    }

    fun luminance(argb: Long): Double {
        fun ch(shift: Int): Double { val c = ((argb shr shift) and 0xFF) / 255.0; return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4) }
        return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0)
    }

    fun ratio(a: Long, b: Long): Double {
        val la = luminance(a); val lb = luminance(b)
        return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
    }

    /** Fondo del badge con número blanco: el color de la empresa si llega a 4,5:1; si no, el naranja sobrio. */
    fun badgeBackground(companyHex: String?): Long {
        val c = parse(companyHex) ?: return SOBER_ORANGE
        return if (ratio(c, 0xFFFFFFFF) >= 4.5) c else SOBER_ORANGE
    }
}
