package com.tiecoms.app.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

/**
 * Mensajes programados (docs/PROGRAMADOS.md, Scheduled.tsx de la web): opciones de un toque y la etiqueta
 * «hoy / mañana / el lun 5 oct a las 8:00». Todo en la hora local del teléfono. Funciones puras.
 */
object Scheduling {
    enum class Option { IN_HOUR, THIS_AFTERNOON, TOMORROW_MORNING, MONDAY }

    /** El servidor acepta entre +30 s y +1 año; en el selector se pide al menos 1 minuto. */
    const val MIN_AHEAD_MS = 60_000L

    /**
     * «En 1 hora» (redondeado hacia arriba a 5 min), «Esta tarde» 18:00 (solo antes de las 16:00),
     * «Mañana temprano» 8:00 y «El lunes temprano» 8:00 (si mañana no es lunes).
     */
    fun options(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<Pair<Option, Instant>> {
        val z = now.atZone(zone)
        val step = 5 * 60_000L
        val inHour = Instant.ofEpochMilli((now.toEpochMilli() + 3_600_000L + step - 1) / step * step)
        fun at(days: Long, h: Int) = z.toLocalDate().plusDays(days).atTime(h, 0).atZone(zone).toInstant()
        val dow = z.dayOfWeek.value % 7 // 0 = domingo, como getDay()
        val toMonday = ((1 - dow + 7) % 7).let { if (it == 0) 7 else it }
        return buildList {
            add(Option.IN_HOUR to inHour)
            if (z.hour < 16) add(Option.THIS_AFTERNOON to at(0, 18))
            add(Option.TOMORROW_MORNING to at(1, 8))
            if (toMonday > 1) add(Option.MONDAY to at(toMonday.toLong(), 8))
        }
    }

    enum class Day { TODAY, TOMORROW, OTHER }

    /** Si [at] cae hoy, mañana u otro día (para «hoy a las…», «mañana a las…», «el {día} a las…»). */
    fun dayOf(at: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Day {
        val d = ChronoUnit.DAYS.between(now.atZone(zone).toLocalDate(), at.atZone(zone).toLocalDate())
        return when (d) { 0L -> Day.TODAY; 1L -> Day.TOMORROW; else -> Day.OTHER }
    }

    /** Día y hora elegidos a mano (hora local); null si no está al menos 1 minuto en el futuro. */
    fun picked(date: LocalDate, hour: Int, minute: Int, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Instant? =
        date.atTime(hour, minute).atZone(zone).toInstant().takeIf { it.toEpochMilli() > now.toEpochMilli() + MIN_AHEAD_MS }

    /** Deshacer una cancelación: la misma hora, o dentro de 2 minutos si ya pasó. */
    fun undoAt(sendAt: Instant, now: Instant = Instant.now()): Instant = maxOf(sendAt, now.plusSeconds(120))

    /** Valor inicial del selector: mañana a las 8:00. */
    fun defaultPick(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): ZonedDateTime =
        now.atZone(zone).toLocalDate().plusDays(1).atTime(8, 0).atZone(zone)

    /** La franja: pendientes y fallidos de esta conversación, el próximo primero. */
    fun forConversation(list: List<ScheduledMessageDTO>, conversationId: String) = list.filter { it.conversationId == conversationId }.sortedBy { it.sendAt }

    /** Un programado sale de la lista cuando queda enviado o cancelado. */
    fun apply(list: List<ScheduledMessageDTO>, s: ScheduledMessageDTO): List<ScheduledMessageDTO> =
        (list.filter { it.id != s.id } + listOfNotNull(s.takeIf { it.status != "sent" && it.status != "cancelled" })).sortedBy { it.sendAt }

}
