package com.tiecoms.app.core

import java.time.Instant
import java.time.LocalDate

/**
 * Asuntos como tareas (1.6.4 / 22, paridad con la web 8174998 + 861306c): completar o reabrir con un toque,
 * orden por urgencia, fechas de un toque y agrupación por responsable. Funciones puras, probadas en la JVM.
 * Todas las fechas son de la hora LOCAL del teléfono: en Colombia, de noche, UTC ya es mañana y todo saldría vencido.
 */
object IssueTasks {
    const val STALL_DAYS = 2
    /** Clave de la sección «Sin responsable» al agrupar por responsable. */
    const val NO_OWNER = "__none"

    data class Flags(val stalledDays: Int, val overdue: Boolean, val dueToday: Boolean)

    fun localToday(): LocalDate = LocalDate.now() // zona del sistema, nunca UTC

    private fun parse(iso: String?): Instant? = iso?.takeIf { it.isNotBlank() }?.let { runCatching { Instant.parse(it) }.getOrNull() }

    /** Señal de cuello de botella (issueFlags de la web): días sin moverse (≥ 2), vencido o vence hoy. */
    fun flags(i: IssueDTO, today: LocalDate = localToday(), now: Instant = Instant.now()): Flags {
        if (i.closed) return Flags(0, false, false)
        val since = parse(i.statusSince)
        val days = if (since == null) 0 else ((now.toEpochMilli() - since.toEpochMilli()) / 86_400_000L).toInt()
        val t = today.toString()
        return Flags(if (days >= STALL_DAYS) days else 0, i.dueDate != null && i.dueDate < t, i.dueDate == t)
    }

    /** El círculo: un asunto cerrado (hecho o descartado) se reabre; uno activo se completa. */
    fun toggleTarget(i: IssueDTO): String = if (i.closed) "open" else "done"

    /** Lo más urgente arriba: vencidos, estancados, fecha más cercana, en curso y luego lo más nuevo (byUrgency). */
    fun byUrgency(today: LocalDate = localToday(), now: Instant = Instant.now()): Comparator<IssueDTO> = Comparator { a, b ->
        val fa = flags(a, today, now); val fb = flags(b, today, now)
        (fb.overdue.compareTo(fa.overdue)).takeIf { it != 0 }
            ?: (fb.stalledDays - fa.stalledDays).takeIf { it != 0 }
            ?: (a.dueDate ?: "9").compareTo(b.dueDate ?: "9").takeIf { it != 0 }
            ?: ((b.status == "in_progress").compareTo(a.status == "in_progress")).takeIf { it != 0 }
            ?: b.createdAt.compareTo(a.createdAt)
    }

    /** Completados: el cerrado más reciente primero. */
    val byClosedDesc: Comparator<IssueDTO> = Comparator { a, b -> (b.closedAt ?: "").compareTo(a.closedAt ?: "") }

    /** Asuntos de un chat: activos por urgencia y «Completados · N» (hechos y descartados). */
    fun split(list: Collection<IssueDTO>, today: LocalDate = localToday(), now: Instant = Instant.now()): Pair<List<IssueDTO>, List<IssueDTO>> =
        list.filter { !it.closed }.sortedWith(byUrgency(today, now)) to list.filter { it.closed }.sortedWith(byClosedDesc)

    enum class Shortcut { TODAY, TOMORROW, FRIDAY, NEXT_WEEK }

    /** Fechas de un toque: hoy, mañana, el viernes (solo si falta más de 1 día) y «la otra semana» = el próximo lunes. */
    fun dateShortcuts(today: LocalDate = localToday()): List<Pair<Shortcut, LocalDate>> {
        val dow = today.dayOfWeek.value % 7 // 0 = domingo, como getDay() de la web
        val toFriday = (5 - dow + 7) % 7
        val toMonday = ((1 - dow + 7) % 7).let { if (it == 0) 7 else it }
        return buildList {
            add(Shortcut.TODAY to today)
            add(Shortcut.TOMORROW to today.plusDays(1))
            if (toFriday > 1) add(Shortcut.FRIDAY to today.plusDays(toFriday.toLong()))
            add(Shortcut.NEXT_WEEK to today.plusDays(toMonday.toLong()))
        }
    }

    enum class QuickAction { COMPLETE, IN_PROGRESS, WAITING, OPEN, REOPEN }

    /** Pulsación larga: Completar y los estados que no tiene; si está cerrado, solo Reabrir. */
    fun quickActions(i: IssueDTO): List<QuickAction> =
        if (i.closed) listOf(QuickAction.REOPEN)
        else buildList {
            add(QuickAction.COMPLETE)
            if (i.status != "in_progress") add(QuickAction.IN_PROGRESS)
            if (i.status != "waiting") add(QuickAction.WAITING)
            if (i.status != "open") add(QuickAction.OPEN)
        }

    fun statusOf(a: QuickAction) = when (a) { QuickAction.COMPLETE -> "done"; QuickAction.IN_PROGRESS -> "in_progress"; QuickAction.WAITING -> "waiting"; QuickAction.OPEN, QuickAction.REOPEN -> "open" }

    /** Filtros de la pestaña: Míos (activos míos), Abiertos (activos) y Completados (cerrados). */
    fun matches(filter: String, i: IssueDTO, myId: String) = when (filter) {
        "closed" -> i.closed
        "open" -> !i.closed
        else -> !i.closed && i.ownerId == myId
    }

    /**
     * Secciones de la pestaña Asuntos. Por responsable: yo primero, luego por nombre y «Sin responsable» al final.
     * Por grupo: el que más asuntos tiene primero y luego por nombre. [title] da el nombre de la sección.
     */
    fun sections(list: List<IssueDTO>, byPerson: Boolean, myId: String, title: (String) -> String): List<Pair<String, List<IssueDTO>>> {
        val buckets = LinkedHashMap<String, MutableList<IssueDTO>>()
        for (i in list) buckets.getOrPut(if (byPerson) i.ownerId ?: NO_OWNER else i.conversationId) { mutableListOf() }.add(i)
        val cmp: Comparator<Map.Entry<String, MutableList<IssueDTO>>> = if (byPerson)
            compareByDescending<Map.Entry<String, MutableList<IssueDTO>>> { it.key == myId }.thenBy { it.key == NO_OWNER }.thenBy { title(it.key).lowercase() }
        else compareByDescending<Map.Entry<String, MutableList<IssueDTO>>> { it.value.size }.thenBy { title(it.key).lowercase() }
        return buckets.entries.sortedWith(cmp).map { it.key to it.value.toList() }
    }

    /** Primer nombre (para chips y el árbol de Grupos). */
    fun firstName(name: String?) = name?.trim()?.split(Regex("\\s+"))?.firstOrNull().orEmpty()
}
