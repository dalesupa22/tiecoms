package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId

/** Calendario Día / Semana / Mes (docs/TANDA-LECTURA-REUNIONES.md §5). */
class CalendarGridTest {
    private val bogota = ZoneId.of("America/Bogota")
    private val madrid = ZoneId.of("Europe/Madrid") // cambia de horario el último domingo de marzo y de octubre

    @Test fun `cuadricula 6x7 que empieza en lunes para meses de 28 a 31 dias`() {
        // Febrero 2027: 28 días y el 1 cae en lunes. Febrero 2028: 29 días. Abril 2026: 30. Septiembre 2026: 30. Agosto 2026: 31 y el 1 en sábado.
        val cases = mapOf(YearMonth.of(2027, 2) to 28, YearMonth.of(2028, 2) to 29, YearMonth.of(2026, 4) to 30, YearMonth.of(2026, 9) to 30, YearMonth.of(2026, 8) to 31, YearMonth.of(2026, 10) to 31)
        for ((m, len) in cases) {
            val g = CalendarGrid.monthGrid(m)
            assertEquals(42, g.size)
            assertEquals(DayOfWeek.MONDAY, g.first().dayOfWeek)
            assertEquals(DayOfWeek.SUNDAY, g.last().dayOfWeek)
            assertTrue("el 1 está en la primera fila de $m", g.take(7).contains(m.atDay(1)))
            assertEquals(len, g.count { YearMonth.from(it) == m })
            assertTrue("el último día está dentro de $m", g.contains(m.atEndOfMonth()))
            // Días consecutivos, sin saltos ni repetidos.
            g.zipWithNext().forEach { (a, b) -> assertEquals(a.plusDays(1), b) }
        }
        assertEquals(LocalDate.of(2027, 2, 1), CalendarGrid.monthGrid(YearMonth.of(2027, 2)).first())
        assertEquals(LocalDate.of(2026, 7, 27), CalendarGrid.monthGrid(YearMonth.of(2026, 8)).first()) // 1-ago-2026 es sábado
    }

    @Test fun `semana por defecto y vista recordada tolerante`() {
        assertEquals(CalendarGrid.View.WEEK, CalendarGrid.View.of(null))
        assertEquals(CalendarGrid.View.WEEK, CalendarGrid.View.of("year"))
        assertEquals(CalendarGrid.View.MONTH, CalendarGrid.View.of("month"))
        assertEquals(CalendarGrid.View.DAY, CalendarGrid.View.of("day"))
    }

    @Test fun `navegar un dia, una semana o un mes`() {
        val d = LocalDate.of(2026, 1, 31)
        assertEquals(LocalDate.of(2026, 2, 1), CalendarGrid.step(CalendarGrid.View.DAY, d, 1))
        assertEquals(LocalDate.of(2026, 2, 7), CalendarGrid.step(CalendarGrid.View.WEEK, d, 1))
        assertEquals(LocalDate.of(2026, 2, 28), CalendarGrid.step(CalendarGrid.View.MONTH, d, 1)) // 31-ene → 28-feb
        assertEquals(LocalDate.of(2025, 12, 31), CalendarGrid.step(CalendarGrid.View.MONTH, d, -1))
        assertEquals(7, CalendarGrid.days(CalendarGrid.View.WEEK, LocalDate.of(2026, 9, 30)).size)
        assertEquals(LocalDate.of(2026, 9, 28), CalendarGrid.days(CalendarGrid.View.WEEK, LocalDate.of(2026, 10, 4)).first())
    }

    @Test fun `rango de cada vista en la zona del dispositivo`() {
        val (f, t) = CalendarGrid.range(CalendarGrid.View.DAY, LocalDate.of(2026, 9, 28), bogota)
        assertEquals(Instant.parse("2026-09-28T05:00:00Z"), f); assertEquals(Instant.parse("2026-09-29T05:00:00Z"), t)
        val (mf, mt) = CalendarGrid.range(CalendarGrid.View.MONTH, LocalDate.of(2026, 9, 15), bogota)
        assertEquals(Instant.parse("2026-08-31T05:00:00Z"), mf); assertEquals(Instant.parse("2026-10-12T05:00:00Z"), mt)
    }

    @Test fun `eventos por dia, varios dias, cambio de horario y todo el dia`() {
        val s = CalendarGrid.Span("e", Instant.parse("2026-09-28T23:30:00Z"), Instant.parse("2026-09-29T01:00:00Z")) // 18:30–20:00 en Bogotá
        assertTrue(CalendarGrid.overlaps(s, LocalDate.of(2026, 9, 28), bogota))
        assertFalse(CalendarGrid.overlaps(s, LocalDate.of(2026, 9, 29), bogota))
        assertEquals(CalendarGrid.Slot(18 * 60 + 30, 20 * 60), CalendarGrid.slot(s, LocalDate.of(2026, 9, 28), bogota))
        // Termina justo a medianoche: no aparece al día siguiente.
        val midnight = CalendarGrid.Span("m", Instant.parse("2026-09-29T04:00:00Z"), Instant.parse("2026-09-29T05:00:00Z"))
        assertFalse(CalendarGrid.overlaps(midnight, LocalDate.of(2026, 9, 29), bogota))
        // De varios días: sale en cada uno, recortado.
        val multi = CalendarGrid.Span("x", Instant.parse("2026-09-28T20:00:00Z"), Instant.parse("2026-09-30T15:00:00Z"))
        assertEquals(CalendarGrid.Slot(0, 24 * 60), CalendarGrid.slot(multi, LocalDate.of(2026, 9, 29), bogota))
        assertTrue(CalendarGrid.allDay(multi, LocalDate.of(2026, 9, 29), bogota))
        assertFalse(CalendarGrid.allDay(multi, LocalDate.of(2026, 9, 28), bogota))
        assertNull(CalendarGrid.slot(multi, LocalDate.of(2026, 10, 1), bogota))
        // Madrid, 25-oct-2026: el día tiene 25 horas; una reunión a las 10:00 locales sigue a las 10:00.
        assertEquals(25L, CalendarGrid.hoursIn(LocalDate.of(2026, 10, 25), madrid))
        assertEquals(23L, CalendarGrid.hoursIn(LocalDate.of(2026, 3, 29), madrid))
        val dst = CalendarGrid.Span("d", Instant.parse("2026-10-25T09:00:00Z"), Instant.parse("2026-10-25T09:30:00Z"))
        assertEquals(CalendarGrid.Slot(10 * 60, 10 * 60 + 30), CalendarGrid.slot(dst, LocalDate.of(2026, 10, 25), madrid))
        // Cero minutos: se ve igual (mínimo 15).
        val zero = CalendarGrid.Span("z", Instant.parse("2026-09-28T15:00:00Z"), Instant.parse("2026-09-28T15:00:00Z"))
        assertTrue(CalendarGrid.overlaps(zero, LocalDate.of(2026, 9, 28), bogota))
        assertEquals(CalendarGrid.Slot(600, 615), CalendarGrid.slot(zero, LocalDate.of(2026, 9, 28), bogota))
    }

    @Test fun `celda del mes con mas N mas`() {
        assertEquals(CalendarGrid.Cell(listOf(1, 2), 0), CalendarGrid.cell(listOf(1, 2), 3))
        assertEquals(CalendarGrid.Cell(listOf(1, 2, 3), 0), CalendarGrid.cell(listOf(1, 2, 3), 3))
        assertEquals(CalendarGrid.Cell(listOf(1, 2), 3), CalendarGrid.cell(listOf(1, 2, 3, 4, 5), 3)) // dos títulos y «+3 más»
        assertEquals(CalendarGrid.Cell(listOf(1), 2), CalendarGrid.cell(listOf(1, 2, 3), 2)) // texto Máximo: uno y «+2 más»
        assertEquals(CalendarGrid.Cell(emptyList<Int>(), 0), CalendarGrid.cell(emptyList<Int>(), 3))
    }

    @Test fun `hora propuesta al crear desde cada vista`() {
        val day = LocalDate.of(2026, 10, 2)
        assertEquals(Instant.parse("2026-10-02T19:00:00Z"), CalendarGrid.proposedStart(day, 14, bogota)) // hueco de las 14:00
        assertEquals(Instant.parse("2026-10-02T15:00:00Z"), CalendarGrid.proposedStart(day, null, bogota, Instant.parse("2026-09-28T12:00:00Z"))) // otro día: 10:00
        // Hoy: la próxima hora en punto.
        assertEquals(Instant.parse("2026-09-28T18:00:00Z"), CalendarGrid.proposedStart(LocalDate.of(2026, 9, 28), null, bogota, Instant.parse("2026-09-28T17:20:00Z")))
        // Hoy a las 23:30: no salta a mañana.
        assertEquals(Instant.parse("2026-09-29T04:00:00Z"), CalendarGrid.proposedStart(LocalDate.of(2026, 9, 28), null, bogota, Instant.parse("2026-09-29T04:30:00Z")))
    }
}
