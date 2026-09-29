package com.tiecoms.app.core

import java.time.Duration
import java.time.Instant
import java.time.ZoneId

/** Tarjeta del evento en el chat (EventChatCard de la web): reglas sin interfaz. */
object EventCards {
    /** Aviso `event.created` con eventId que se pinta como tarjeta; null si es otro mensaje. */
    fun cardEventId(m: MessageDTO): String? {
        if (m.kind != "system" || !m.body.startsWith("{")) return null
        val o = runCatching { TcJson.parseToJsonElement(m.body) as? kotlinx.serialization.json.JsonObject }.getOrNull() ?: return null
        fun str(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        return if (str("k") == "event.created") str("eventId") else null
    }

    /** «Todo el día» (isAllDayEvent de la web): empieza a las 00:00 local, dura ~24 h y termina 23:59 o 00:00. */
    fun isAllDay(startsAt: String, endsAt: String, zone: ZoneId = ZoneId.systemDefault()): Boolean {
        val s = runCatching { Instant.parse(startsAt) }.getOrNull() ?: return false
        val e = runCatching { Instant.parse(endsAt) }.getOrNull() ?: return false
        val ls = s.atZone(zone).toLocalTime(); val le = e.atZone(zone).toLocalTime()
        return ls.hour == 0 && ls.minute == 0 && Duration.between(s, e).toMillis() >= 86_340_000L &&
            ((le.hour == 23 && le.minute >= 59) || (le.hour == 0 && le.minute == 0))
    }

    fun going(ev: CalendarEventDTO): Int = ev.invitees.count { it.rsvp == "yes" }
    fun past(ev: CalendarEventDTO, now: Instant = Instant.now()): Boolean = runCatching { Instant.parse(ev.endsAt).isBefore(now) }.getOrDefault(false)

    /** Botones de respuesta: solo si soy invitado, no está cancelado y no pasó. */
    fun canRsvp(ev: CalendarEventDTO, me: String, now: Instant = Instant.now()): Boolean =
        ev.cancelledAt == null && !past(ev, now) && ev.invitees.any { it.userId == me }
}
