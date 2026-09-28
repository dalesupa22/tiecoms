package com.tiecoms.app.core

import java.time.Instant
import java.time.ZoneId

/**
 * «No molestar todas las noches» (docs/PROGRAMADOS.md, segunda parte; Sleep.tsx de la web): cada persona tiene
 * un horario de descanso (22:00–07:00 por defecto) en su zona horaria. Funciones puras.
 */
object SleepMode {
    const val DEFAULT_START = "22:00"
    const val DEFAULT_END = "07:00"

    data class Window(val start: String, val end: String, val tz: String)

    fun toMin(hhmm: String): Int = hhmm.split(':').let { (it.getOrNull(0)?.toIntOrNull() ?: 0) * 60 + (it.getOrNull(1)?.toIntOrNull() ?: 0) }

    private fun zone(tz: String): ZoneId = runCatching { ZoneId.of(tz) }.getOrDefault(ZoneId.systemDefault())

    /** Minuto del día (0…1439) en la zona [tz]. */
    fun minutesIn(tz: String, at: Instant): Int = at.atZone(zone(tz)).let { it.hour * 60 + it.minute }

    /** ¿Está dentro de su ventana? Soporta ventanas que cruzan la medianoche; start == end = nunca. */
    fun sleepingNow(w: Window?, at: Instant = Instant.now()): Boolean {
        if (w == null) return false
        val s = toMin(w.start); val e = toMin(w.end); val n = minutesIn(w.tz, at)
        if (s == e) return false
        return if (s < e) n in s until e else n >= s || n < e
    }

    /** Cuándo se despierta: el próximo fin de la ventana, como instante (segundos en 0). */
    fun wakeAt(w: Window, at: Instant = Instant.now()): Instant {
        val diff = ((toMin(w.end) - minutesIn(w.tz, at) + 1440) % 1440).let { if (it == 0) 1440 else it }
        val t = at.plusSeconds(diff * 60L)
        return Instant.ofEpochSecond(t.epochSecond - t.epochSecond % 60)
    }

    fun of(s: SleepDTO?): Window? = s?.takeIf { it.on }?.let { Window(it.start, it.end, it.tz) }
    fun of(s: SleepWindowDTO?): Window? = s?.let { Window(it.start, it.end, it.tz) }

    /** Aviso a quien escribe: una persona (en un directo, con cuándo lo verá) o «N personas del chat…». */
    sealed interface Notice {
        data class One(val person: PersonDTO, val wake: Instant, val canSchedule: Boolean) : Notice
        data class Many(val count: Int) : Notice
    }

    /**
     * En un directo el aviso se ve siempre; en grupos solo mientras escribo. Con una sola persona dormida y
     * ella sola en el chat, se ofrece «🕒 Enviar a las 7:00» (mientras escribo).
     */
    fun notice(d: BootstrapDTO, memberIds: List<String>, typing: Boolean, at: Instant = Instant.now()): Notice? {
        val humans = memberIds.filter { it != d.me.id }.mapNotNull { id -> d.people.firstOrNull { it.id == id } }.filter { it.kind == "human" }
        val asleep = humans.filter { sleepingNow(of(it.sleep), at) }
        if (asleep.isEmpty()) return null
        val one = asleep.singleOrNull()
        if (humans.size > 1 && !typing) return null
        return if (one != null && humans.size == 1) Notice.One(one, wakeAt(of(one.sleep)!!, at), canSchedule = typing)
        else Notice.Many(asleep.size)
    }
}
