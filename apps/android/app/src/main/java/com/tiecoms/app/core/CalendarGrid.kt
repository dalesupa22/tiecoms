package com.tiecoms.app.core

import java.time.DayOfWeek
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

/**
 * Calendario Día / Semana / Mes (docs/TANDA-LECTURA-REUNIONES.md §5, igual en web e iOS).
 * Semana por defecto y recordada por dispositivo; ‹ Hoy ›; en Mes, cuadrícula 6×7 que empieza en lunes con
 * «+N más», y tocar un día abre la vista Día. Todo en la zona del dispositivo (meses de 28 a 31 días y cambios
 * de horario incluidos).
 */
object CalendarGrid {
    enum class View(val id: String) { DAY("day"), WEEK("week"), MONTH("month");
        companion object { fun of(id: String?): View = entries.firstOrNull { it.id == id } ?: WEEK }
    }

    fun weekStart(d: LocalDate): LocalDate = d.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

    /** Los 42 días de la cuadrícula del mes: desde el lunes de la semana del día 1, 6 filas × 7 columnas. */
    fun monthGrid(month: YearMonth): List<LocalDate> {
        val first = weekStart(month.atDay(1))
        return (0 until 42).map { first.plusDays(it.toLong()) }
    }

    /** Días visibles de cada vista. */
    fun days(view: View, anchor: LocalDate): List<LocalDate> = when (view) {
        View.DAY -> listOf(anchor)
        View.WEEK -> weekStart(anchor).let { s -> (0 until 7).map { s.plusDays(it.toLong()) } }
        View.MONTH -> monthGrid(YearMonth.from(anchor))
    }

    /** [desde, hasta) en instantes para pedir GET /events de lo que se ve. */
    fun range(view: View, anchor: LocalDate, zone: ZoneId): Pair<Instant, Instant> {
        val d = days(view, anchor)
        return d.first().atStartOfDay(zone).toInstant() to d.last().plusDays(1).atStartOfDay(zone).toInstant()
    }

    /** ‹ y ›: un día, una semana o un mes (el 31 pasa al último día del mes siguiente). */
    fun step(view: View, anchor: LocalDate, dir: Int): LocalDate = when (view) {
        View.DAY -> anchor.plusDays(dir.toLong())
        View.WEEK -> anchor.plusWeeks(dir.toLong())
        View.MONTH -> anchor.plusMonths(dir.toLong())
    }

    /** Un evento con su inicio y fin ya leídos. */
    data class Span(val id: String, val start: Instant, val end: Instant)

    /** ¿Toca este día local? (los de varios días salen en cada uno; el fin es exclusivo). */
    fun overlaps(s: Span, day: LocalDate, zone: ZoneId): Boolean {
        val from = day.atStartOfDay(zone).toInstant(); val to = day.plusDays(1).atStartOfDay(zone).toInstant()
        val end = if (s.end.isAfter(s.start)) s.end else s.start.plusSeconds(1)
        return s.start.isBefore(to) && end.isAfter(from)
    }

    /** Resumen de una celda del mes: los primeros [max] y cuántos más («+N más»). */
    data class Cell<T>(val shown: List<T>, val more: Int)
    fun <T> cell(items: List<T>, max: Int): Cell<T> = if (items.size <= max) Cell(items, 0) else Cell(items.take(maxOf(0, max - 1)), items.size - maxOf(0, max - 1))

    /**
     * Posición en la vista Día: minuto de inicio y de fin dentro del día (0..1440), recortado a ese día.
     * Con cambio de horario, el día tiene 23 o 25 horas reales, pero la columna usa la hora local de reloj.
     */
    data class Slot(val startMin: Int, val endMin: Int)
    fun slot(s: Span, day: LocalDate, zone: ZoneId): Slot? {
        if (!overlaps(s, day, zone)) return null
        val from = day.atStartOfDay(zone).toInstant(); val to = day.plusDays(1).atStartOfDay(zone).toInstant()
        val st = if (s.start.isBefore(from)) 0 else minuteOfDay(s.start, zone)
        val en = if (!s.end.isBefore(to)) 24 * 60 else minuteOfDay(s.end, zone)
        return Slot(st, maxOf(en, st + 15).coerceAtMost(24 * 60))
    }
    private fun minuteOfDay(i: Instant, zone: ZoneId): Int = i.atZone(zone).toLocalTime().let { it.hour * 60 + it.minute }

    /** Dura el día entero (o más): va arriba, como «todo el día». */
    fun allDay(s: Span, day: LocalDate, zone: ZoneId): Boolean {
        val from = day.atStartOfDay(zone).toInstant(); val to = day.plusDays(1).atStartOfDay(zone).toInstant()
        return !s.start.isAfter(from) && !s.end.isBefore(to)
    }

    /** Hora propuesta al crear desde una vista: la hora tocada, o la próxima hora en punto si es hoy, o las 10:00. */
    fun proposedStart(day: LocalDate, hour: Int?, zone: ZoneId, now: Instant = Instant.now()): Instant {
        if (hour != null) return day.atTime(LocalTime.of(hour.coerceIn(0, 23), 0)).atZone(zone).toInstant()
        val today = now.atZone(zone).toLocalDate()
        if (day == today) {
            val next = now.atZone(zone).plusHours(1).withMinute(0).withSecond(0).withNano(0)
            return if (next.toLocalDate() == day) next.toInstant() else day.atTime(23, 0).atZone(zone).toInstant()
        }
        return day.atTime(10, 0).atZone(zone).toInstant()
    }

    /** Horas reales de un día local (23 o 25 con cambio de horario). */
    fun hoursIn(day: LocalDate, zone: ZoneId): Long = Duration.between(day.atStartOfDay(zone), day.plusDays(1).atStartOfDay(zone)).toHours()
}
