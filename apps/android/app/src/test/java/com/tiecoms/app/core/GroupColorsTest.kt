package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId

/** Agenda: un color por grupo, leyenda y día completo (docs/AGENDA-COLORES.md). */
class GroupColorsTest {
    private val bogota = ZoneId.of("America/Bogota")
    private val madrid = ZoneId.of("Europe/Madrid")
    private fun at(s: String, zone: ZoneId = bogota): Instant = LocalDateTime.parse(s).atZone(zone).toInstant()
    private fun ev(id: String, conv: String, start: Instant, end: Instant) = CalendarEventDTO(id = id, conversationId = conv, startsAt = start.toString(), endsAt = end.toString())

    @Test fun `indice de color igual al de la web (casos de la spec)`() {
        assertEquals(1, GroupColors.index("3a916cc9-0411-4068-be9d-f22075045494"))
        assertEquals(4, GroupColors.index("e1c94905-862f-4e70-9653-5d0e195910e9"))
    }

    @Test fun `hash uint32 con desborde igual a una referencia en Long mod 2 a la 32`() {
        // Referencia independiente con Long y mod 2^32, como el uint32 de la spec.
        fun ref(id: String): Int { var h = 0L; for (c in id) h = (h * 31 + c.code) and 0xFFFFFFFFL; return (h % 10).toInt() }
        listOf("", "a", "grupo-ventas", "3a916cc9-0411-4068-be9d-f22075045494", "ñandú-é", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").forEach {
            assertEquals(it, ref(it), GroupColors.index(it))
        }
        assertEquals(0, GroupColors.index(""))
    }

    @Test fun `paleta de 10 colores con la tabla de la spec`() {
        assertEquals(10, GroupColors.PALETTE.size)
        assertEquals(GroupColors.Swatch(0xFFD7F0E2, 0xFF17603D), GroupColors.of("3a916cc9-0411-4068-be9d-f22075045494")) // verde
        assertEquals(GroupColors.Swatch(0xFFFBDDEB, 0xFF962868), GroupColors.of("e1c94905-862f-4e70-9653-5d0e195910e9")) // rosado
        assertEquals(GroupColors.Swatch(0xFFF6EDC4, 0xFF735600), GroupColors.PALETTE[9]) // ámbar
    }

    @Test fun `dia completo de 00 00 a 23 59 o a las 00 00 del dia siguiente`() {
        assertTrue(GroupColors.isAllDay(at("2026-09-30T00:00"), at("2026-09-30T23:59"), bogota))
        assertTrue(GroupColors.isAllDay(at("2026-09-30T00:00"), at("2026-10-01T00:00"), bogota))
        assertTrue(GroupColors.isAllDay(at("2026-09-30T00:00"), at("2026-10-02T23:59"), bogota)) // varios días
    }

    @Test fun `no es dia completo si no empieza a medianoche, dura menos o termina a otra hora`() {
        assertFalse(GroupColors.isAllDay(at("2026-09-30T00:00"), at("2026-09-30T23:58"), bogota))
        assertFalse(GroupColors.isAllDay(at("2026-09-30T00:01"), at("2026-10-01T00:00"), bogota))
        assertFalse(GroupColors.isAllDay(at("2026-09-30T00:00"), at("2026-09-30T00:00"), bogota)) // 0 min
        assertFalse(GroupColors.isAllDay(at("2026-09-30T00:00"), at("2026-10-01T10:00"), bogota)) // 34 h, termina a las 10
        assertFalse(GroupColors.isAllDay(at("2026-09-30T10:00"), at("2026-09-30T11:00"), bogota))
    }

    @Test fun `dia completo se mide en la hora local de quien mira`() {
        val s = at("2026-09-30T00:00", bogota); val e = at("2026-09-30T23:59", bogota)
        assertTrue(GroupColors.isAllDay(s, e, bogota))
        assertFalse(GroupColors.isAllDay(s, e, madrid)) // en Madrid empieza a las 07:00
        // Día de 23 horas en Madrid (29-mar-2026, cambio de horario): dura 23 h, menos de 23 h 59 min; igual que en la web, no cuenta.
        assertFalse(GroupColors.isAllDay(at("2026-03-29T00:00", madrid), at("2026-03-30T00:00", madrid), madrid))
    }

    @Test fun `en las listas los de dia completo van antes que los de hora`() {
        val timed = ev("t", "g1", at("2026-09-30T08:00"), at("2026-09-30T09:00"))
        val all = ev("a", "g2", at("2026-09-30T00:00"), at("2026-09-30T23:59"))
        val later = ev("l", "g1", at("2026-09-30T15:00"), at("2026-09-30T16:00"))
        assertEquals(listOf("a", "t", "l"), GroupColors.allDayFirst(listOf(later, timed, all), bogota).map { it.id })
        assertTrue(GroupColors.isAllDay(all, bogota))
        assertFalse(GroupColors.isAllDay(CalendarEventDTO(startsAt = "x", endsAt = "y"), bogota)) // fechas ilegibles
    }

    @Test fun `leyenda y filtro de ocultos`() {
        val a = ev("1", "g1", at("2026-09-30T08:00"), at("2026-09-30T09:00"))
        val b = ev("2", "g2", at("2026-09-30T10:00"), at("2026-09-30T11:00"))
        val c = ev("3", "g1", at("2026-09-30T12:00"), at("2026-09-30T13:00"))
        val list = listOf(a, b, c)
        assertEquals(listOf("g1", "g2"), GroupColors.legendIds(list))
        assertEquals(list, GroupColors.withoutHidden(list, emptySet()))
        assertEquals(listOf("2"), GroupColors.withoutHidden(list, setOf("g1")).map { it.id })
        assertEquals(emptyList<CalendarEventDTO>(), GroupColors.withoutHidden(list, setOf("g1", "g2")))
        assertEquals(list, GroupColors.withoutHidden(list, setOf("otro"))) // ocultos que no están en lo que se ve
        // Tocar oculta y volver a tocar muestra.
        val h1 = GroupColors.toggle(emptySet(), "g1")
        assertEquals(setOf("g1"), h1)
        assertEquals(emptySet<String>(), GroupColors.toggle(h1, "g1"))
    }
}
