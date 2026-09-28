package com.tiecoms.app.core

import java.time.Duration
import java.time.Instant
import java.time.ZoneId

/**
 * Agenda: un color por grupo, el mismo en web, iOS y Android (docs/AGENDA-COLORES.md,
 * packages/client-core/src/group-colors.ts). Leyenda para ocultar grupos y eventos de «día completo».
 */
object GroupColors {
    /** Fondo y texto en ARGB. */
    data class Swatch(val bg: Long, val fg: Long)

    val PALETTE: List<Swatch> = listOf(
        Swatch(0xFFDCE8FB, 0xFF1E4E9C), // azul
        Swatch(0xFFD7F0E2, 0xFF17603D), // verde
        Swatch(0xFFE9DEFB, 0xFF5B32A8), // morado
        Swatch(0xFFD3EEF0, 0xFF0A5F67), // turquesa
        Swatch(0xFFFBDDEB, 0xFF962868), // rosado
        Swatch(0xFFFDE8CF, 0xFF8A4B0B), // naranja
        Swatch(0xFFE2E4F8, 0xFF3C4196), // índigo
        Swatch(0xFFF9DADA, 0xFF9B2525), // rojo
        Swatch(0xFFEEF3C9, 0xFF5B6412), // oliva
        Swatch(0xFFF6EDC4, 0xFF735600), // ámbar
    )

    /**
     * h = (h * 31 + código UTF-16) mod 2^32 por cada carácter; índice = h mod 10.
     * El Int de Kotlin desborda igual que Math.imul; se lee como sin signo para igualar el uint32 de la web.
     */
    fun index(conversationId: String): Int {
        var h = 0
        for (c in conversationId) h = h * 31 + c.code
        return (h.toUInt() % PALETTE.size.toUInt()).toInt()
    }

    fun of(conversationId: String): Swatch = PALETTE[index(conversationId)]

    private const val MIN_ALL_DAY_MS = 86_340_000L // 23 h 59 min

    /**
     * Día completo: en la hora local de quien mira empieza a las 00:00, termina a las 23:59 (o a las 00:00 de otro
     * día) y dura al menos 23 h 59 min.
     */
    fun isAllDay(start: Instant, end: Instant, zone: ZoneId): Boolean {
        val s = start.atZone(zone); val e = end.atZone(zone)
        if (s.hour != 0 || s.minute != 0) return false
        if (Duration.between(start, end).toMillis() < MIN_ALL_DAY_MS) return false
        return (e.hour == 23 && e.minute >= 59) || (e.hour == 0 && e.minute == 0)
    }

    fun isAllDay(ev: CalendarEventDTO, zone: ZoneId): Boolean {
        val s = parse(ev.startsAt) ?: return false
        val e = parse(ev.endsAt) ?: return false
        return isAllDay(s, e, zone)
    }

    /** Los de día completo primero; luego por hora de inicio. */
    fun allDayFirst(events: List<CalendarEventDTO>, zone: ZoneId): List<CalendarEventDTO> =
        events.sortedWith(compareBy<CalendarEventDTO> { !isAllDay(it, zone) }.thenBy { it.startsAt })

    /** Grupos de la leyenda: los que tienen eventos en lo que se ve, en el orden en que aparecen, sin repetir. */
    fun legendIds(events: List<CalendarEventDTO>): List<String> = events.map { it.conversationId }.distinct()

    /** Quita los eventos de los grupos ocultos. */
    fun withoutHidden(events: List<CalendarEventDTO>, hidden: Set<String>): List<CalendarEventDTO> =
        if (hidden.isEmpty()) events else events.filter { it.conversationId !in hidden }

    /** Tocar un grupo de la leyenda: lo oculta si se ve, lo muestra si estaba oculto. */
    fun toggle(hidden: Set<String>, conversationId: String): Set<String> =
        if (conversationId in hidden) hidden - conversationId else hidden + conversationId

    private fun parse(iso: String): Instant? = runCatching { Instant.parse(iso) }.getOrNull()
}
