package com.tiecoms.app.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * Silenciar un chat y «No molestar» (SPEC-silencio §2 y §3), sin nada de Android para poder probarlo.
 *
 * - Silencio de chat: `mutedUntil` de la conversación. Una mención suena igual, salvo el silencio
 *   «hasta que lo reactive» (el servidor usa el mismo corte: más de 366 días).
 * - «No molestar»: `me.dndUntil`. Mientras está activo no hay ninguna notificación local ni sonido de aviso.
 */
object Silence {
    /** «Hasta que lo reactive». */
    const val FOREVER = "9999-12-31T00:00:00Z"
    /** Más de esto = silencio «siempre» (mismo corte que apps/api/src/modules/push.ts). */
    const val FOREVER_AFTER_MS = 366L * 86_400_000
    private const val HOUR = 3_600_000L

    enum class MuteOption { HOUR_1, HOURS_8, WEEK, FOREVER }
    enum class DndOption { HOUR_1, HOURS_8, TOMORROW, FOREVER }

    sealed interface Status {
        data object Off : Status
        data class Until(val atMs: Long) : Status
        data object Forever : Status
        val active: Boolean get() = this != Off
    }

    fun parse(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

    fun status(iso: String?, nowMs: Long): Status {
        val at = parse(iso) ?: return Status.Off
        return when {
            at <= nowMs -> Status.Off
            at - nowMs > FOREVER_AFTER_MS -> Status.Forever
            else -> Status.Until(at)
        }
    }

    fun active(iso: String?, nowMs: Long): Boolean = status(iso, nowMs).active

    fun muteUntil(o: MuteOption, nowMs: Long): String = when (o) {
        MuteOption.HOUR_1 -> iso(nowMs + HOUR)
        MuteOption.HOURS_8 -> iso(nowMs + 8 * HOUR)
        MuteOption.WEEK -> iso(nowMs + 7 * 24 * HOUR)
        MuteOption.FOREVER -> FOREVER
    }

    /** «Hasta mañana» = mañana a las 8:00 hora local. */
    fun dndUntil(o: DndOption, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String = when (o) {
        DndOption.HOUR_1 -> iso(nowMs + HOUR)
        DndOption.HOURS_8 -> iso(nowMs + 8 * HOUR)
        DndOption.TOMORROW -> Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().plusDays(1).atTime(8, 0).atZone(zone).toInstant().toString()
        DndOption.FOREVER -> FOREVER
    }

    /**
     * ¿Avisa (notificación local o sonido de aviso) un mensaje de otra persona?
     * «No molestar» apaga todo; un chat silenciado solo deja pasar la mención, salvo el silencio «siempre».
     */
    fun notifies(convMutedUntil: String?, mentioned: Boolean, dndUntil: String?, nowMs: Long): Boolean {
        if (active(dndUntil, nowMs)) return false
        return when (status(convMutedUntil, nowMs)) {
            Status.Off -> true
            is Status.Until -> mentioned
            Status.Forever -> false
        }
    }

    /** Reuniones, recordatorios y reacciones: «No molestar» los apaga; el silencio del chat, según el llamador. */
    fun dndBlocks(dndUntil: String?, nowMs: Long): Boolean = active(dndUntil, nowMs)

    /** Hora («18:00») si es hoy; si no, fecha corta y hora («mar 30 sep, 18:00»). [sameDay] dice cuál. */
    data class When(val text: String, val sameDay: Boolean)

    fun whenText(atMs: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): When {
        val at: ZonedDateTime = Instant.ofEpochMilli(atMs).atZone(zone)
        val today: LocalDate = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val time = at.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
        if (at.toLocalDate() == today) return When(time, true)
        val date = at.format(DateTimeFormatter.ofPattern("EEE d MMM", locale)).replace(".", "")
        return When("$date, $time", false)
    }

    /** Milisegundos hasta que cambie el estado (para refrescar la interfaz al vencer); null si nunca. */
    fun msUntilChange(iso: String?, nowMs: Long): Long? = (status(iso, nowMs) as? Status.Until)?.let { (it.atMs - nowMs).coerceAtLeast(0) + 50 }

    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()
}
