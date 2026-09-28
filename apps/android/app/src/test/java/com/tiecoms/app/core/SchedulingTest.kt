package com.tiecoms.app.core

import com.tiecoms.app.core.Scheduling.Option
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Opciones de «Programar envío» (docs/PROGRAMADOS.md), en hora de Bogotá. */
class SchedulingTest {
    private val bog = ZoneId.of("America/Bogota")
    private fun at(s: String) = java.time.LocalDateTime.parse(s).atZone(bog).toInstant()

    @Test fun `martes por la manana trae las cuatro opciones`() {
        val o = Scheduling.options(at("2026-09-29T10:02"), bog).toMap()
        assertEquals(listOf(Option.IN_HOUR, Option.THIS_AFTERNOON, Option.TOMORROW_MORNING, Option.MONDAY), Scheduling.options(at("2026-09-29T10:02"), bog).map { it.first })
        assertEquals(at("2026-09-29T11:05"), o[Option.IN_HOUR]) // redondeado a 5 min hacia arriba
        assertEquals(at("2026-09-29T18:00"), o[Option.THIS_AFTERNOON])
        assertEquals(at("2026-09-30T08:00"), o[Option.TOMORROW_MORNING])
        assertEquals(at("2026-10-05T08:00"), o[Option.MONDAY])
    }

    @Test fun `desde las 16 no hay esta tarde y el domingo no hay lunes`() {
        assertTrue(Scheduling.options(at("2026-09-29T16:00"), bog).none { it.first == Option.THIS_AFTERNOON })
        // Domingo: mañana ya es lunes.
        assertTrue(Scheduling.options(at("2026-09-27T21:00"), bog).none { it.first == Option.MONDAY })
        // Sábado: el lunes que viene (en 2 días).
        assertEquals(at("2026-09-28T08:00"), Scheduling.options(at("2026-09-26T09:00"), bog).toMap()[Option.MONDAY])
        // Hora exacta en múltiplo de 5: +1 h justa.
        assertEquals(at("2026-09-29T11:00"), Scheduling.options(at("2026-09-29T10:00"), bog).toMap()[Option.IN_HOUR])
    }

    @Test fun `hoy manana u otro dia en hora local`() {
        val now = at("2026-09-27T21:30") // en UTC ya es 28
        assertEquals(Scheduling.Day.TODAY, Scheduling.dayOf(at("2026-09-27T23:00"), now, bog))
        assertEquals(Scheduling.Day.TOMORROW, Scheduling.dayOf(at("2026-09-28T07:00"), now, bog))
        assertEquals(Scheduling.Day.OTHER, Scheduling.dayOf(at("2026-10-05T08:00"), now, bog))
    }

    @Test fun `elegir a mano exige futuro y deshacer no queda en el pasado`() {
        val now = at("2026-09-29T10:00")
        assertNull(Scheduling.picked(LocalDate.parse("2026-09-29"), 10, 0, now, bog))
        assertEquals(at("2026-09-29T10:05"), Scheduling.picked(LocalDate.parse("2026-09-29"), 10, 5, now, bog))
        assertEquals(now.plusSeconds(120), Scheduling.undoAt(at("2026-09-29T09:00"), now))
        assertEquals(at("2026-09-30T08:00"), Scheduling.undoAt(at("2026-09-30T08:00"), now))
    }

    @Test fun `enviados y cancelados salen de la lista`() {
        val a = ScheduledMessageDTO(id = "a", conversationId = "c", sendAt = "2026-09-30T13:00:00Z")
        val b = ScheduledMessageDTO(id = "b", conversationId = "c", sendAt = "2026-09-29T13:00:00Z")
        var l = Scheduling.apply(emptyList(), a); l = Scheduling.apply(l, b)
        assertEquals(listOf("b", "a"), l.map { it.id })
        assertEquals(listOf("a"), Scheduling.apply(l, b.copy(status = "sent")).map { it.id })
        assertEquals(listOf("b"), Scheduling.apply(l, a.copy(status = "cancelled")).map { it.id })
        assertEquals("failed", Scheduling.apply(l, a.copy(status = "failed")).first { it.id == "a" }.status)
    }
}
