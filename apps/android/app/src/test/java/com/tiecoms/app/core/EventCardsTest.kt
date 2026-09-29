package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** Tarjeta del evento en el chat: qué aviso la muestra, «Todo el día», quiénes van y cuándo se responde. */
class EventCardsTest {
    private fun sys(body: String) = MessageDTO(id = "s", seq = 1, kind = "system", body = body)
    private val bogota = ZoneId.of("America/Bogota")

    @Test fun `solo event created con eventId es tarjeta`() {
        assertEquals("e1", EventCards.cardEventId(sys("""{"k":"event.created","eventId":"e1","title":"Revisión","startsAt":"2026-09-30T20:00:00Z"}""")))
        assertNull(EventCards.cardEventId(sys("""{"k":"event.created","title":"sin id"}""")))
        assertNull(EventCards.cardEventId(sys("""{"k":"event.moved","eventId":"e1"}""")))
        assertNull(EventCards.cardEventId(sys("""{"k":"event.cancelled","eventId":"e1"}""")))
        assertNull(EventCards.cardEventId(sys("no es json")))
        assertNull(EventCards.cardEventId(MessageDTO(kind = "text", body = """{"k":"event.created","eventId":"e1"}""")))
    }

    @Test fun `todo el dia en hora local`() {
        // 00:00 → 23:59 en Bogotá (UTC-5).
        assertTrue(EventCards.isAllDay("2026-09-30T05:00:00Z", "2026-10-01T04:59:00Z", bogota))
        assertTrue(EventCards.isAllDay("2026-09-30T05:00:00Z", "2026-10-01T05:00:00Z", bogota))
        assertFalse(EventCards.isAllDay("2026-09-30T20:00:00Z", "2026-09-30T21:00:00Z", bogota))
        assertFalse(EventCards.isAllDay("2026-09-30T05:00:00Z", "2026-09-30T17:00:00Z", bogota))
        assertFalse(EventCards.isAllDay("x", "y", bogota))
    }

    @Test fun `asistentes y botones de respuesta`() {
        val now = Instant.parse("2026-09-29T00:00:00Z")
        val ev = CalendarEventDTO(id = "e1", startsAt = "2026-09-30T20:00:00Z", endsAt = "2026-09-30T21:00:00Z",
            invitees = listOf(Invitee("u1", "yes"), Invitee("u2", "maybe"), Invitee("u3", "pending"), Invitee("u4", "yes")))
        assertEquals(2, EventCards.going(ev))
        assertTrue(EventCards.canRsvp(ev, "u3", now))
        assertFalse(EventCards.canRsvp(ev, "otro", now)) // no soy invitado
        assertFalse(EventCards.canRsvp(ev.copy(cancelledAt = "2026-09-28T00:00:00Z"), "u3", now))
        assertFalse(EventCards.canRsvp(ev, "u3", Instant.parse("2026-10-01T00:00:00Z"))) // ya pasó
        assertTrue(EventCards.past(ev, Instant.parse("2026-10-01T00:00:00Z")))
        assertFalse(EventCards.past(ev, now))
        // El evento decodifica aunque falten campos.
        val dec = TcJson.decodeFromString(CalendarEventDTO.serializer(), """{"id":"e1","title":"Revisión","invitees":[{"userId":"u1"}],"cancelledAt":null}""")
        assertEquals("pending", dec.invitees.single().rsvp); assertNull(dec.cancelledAt)
    }
}
