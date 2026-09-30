package com.tiecoms.app.core

import com.tiecoms.app.core.IssueTasks.QuickAction
import com.tiecoms.app.core.IssueTasks.Shortcut
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate

/** Asuntos como tareas (1.6.4 / 22): círculo, orden por urgencia, fechas de un toque y secciones, sin servidor. */
class IssueTasksTest {
    private val now = Instant.parse("2026-09-28T02:00:00Z")
    private val today = LocalDate.parse("2026-09-27") // domingo en Bogotá (UTC ya es lunes 28)

    private fun issue(id: String, status: String = "open", due: String? = null, since: String = "2026-09-27T20:00:00Z", created: String = "2026-09-20T10:00:00Z",
                      owner: String? = null, conv: String = "c1", closedAt: String? = null) =
        IssueDTO(id = id, conversationId = conv, title = id, status = status, dueDate = due, statusSince = since, createdAt = created, ownerId = owner, closedAt = closedAt)

    @Test fun `el numero de Todo cuenta solo mis tareas sin cerrar`() {
        val list = listOf(
            issue("a", owner = "me"), issue("b", "in_progress", owner = "me"), issue("c", "waiting", owner = "me"),
            issue("d", "done", owner = "me"), issue("e", "cancelled", owner = "me"), issue("f", owner = "otro"), issue("g"),
        )
        assertEquals(3, IssueTasks.myOpenCount(list, "me"))
        assertEquals(0, IssueTasks.myOpenCount(list, null))
    }

    @Test fun `el circulo completa lo activo y reabre lo cerrado`() {
        assertEquals("done", IssueTasks.toggleTarget(issue("a")))
        assertEquals("done", IssueTasks.toggleTarget(issue("a", "in_progress")))
        assertEquals("done", IssueTasks.toggleTarget(issue("a", "waiting")))
        assertEquals("open", IssueTasks.toggleTarget(issue("a", "done")))
        assertEquals("open", IssueTasks.toggleTarget(issue("a", "cancelled")))
    }

    @Test fun `menu de pulsacion larga`() {
        assertEquals(listOf(QuickAction.COMPLETE, QuickAction.IN_PROGRESS, QuickAction.WAITING), IssueTasks.quickActions(issue("a")))
        assertEquals(listOf(QuickAction.COMPLETE, QuickAction.WAITING, QuickAction.OPEN), IssueTasks.quickActions(issue("a", "in_progress")))
        assertEquals(listOf(QuickAction.COMPLETE, QuickAction.IN_PROGRESS, QuickAction.OPEN), IssueTasks.quickActions(issue("a", "waiting")))
        assertEquals(listOf(QuickAction.REOPEN), IssueTasks.quickActions(issue("a", "done")))
        assertEquals("open", IssueTasks.statusOf(QuickAction.REOPEN))
        assertEquals("done", IssueTasks.statusOf(QuickAction.COMPLETE))
    }

    @Test fun `vencido y hoy en hora local, no en UTC`() {
        // A las 21:00 de Bogotá (02:00 UTC del 28), un asunto para el 27 vence HOY, no está vencido.
        val f = IssueTasks.flags(issue("a", due = "2026-09-27"), today, now)
        assertTrue(f.dueToday); assertFalse(f.overdue)
        assertTrue(IssueTasks.flags(issue("b", due = "2026-09-26"), today, now).overdue)
        assertFalse(IssueTasks.flags(issue("c", "done", due = "2026-09-01"), today, now).overdue)
    }

    @Test fun `estancado desde dos dias`() {
        assertEquals(0, IssueTasks.flags(issue("a", since = "2026-09-26T20:00:00Z"), today, now).stalledDays)
        assertEquals(3, IssueTasks.flags(issue("a", since = "2026-09-24T20:00:00Z"), today, now).stalledDays)
    }

    @Test fun `orden por urgencia`() {
        val list = listOf(
            issue("sinFecha", created = "2026-09-25T00:00:00Z"),
            issue("enCurso", "in_progress"),
            issue("lejana", due = "2026-10-20"),
            issue("cercana", due = "2026-09-29"),
            issue("estancado", since = "2026-09-20T00:00:00Z"),
            issue("vencido", due = "2026-09-20"),
            issue("nuevo", created = "2026-09-26T00:00:00Z"),
        )
        val sorted = list.sortedWith(IssueTasks.byUrgency(today, now)).map { it.id }
        assertEquals(listOf("vencido", "estancado", "cercana", "lejana", "enCurso", "nuevo", "sinFecha"), sorted)
    }

    @Test fun `activos y completados de un chat`() {
        val (open, done) = IssueTasks.split(listOf(
            issue("a"), issue("b", "done", closedAt = "2026-09-25T00:00:00Z"), issue("c", "cancelled", closedAt = "2026-09-26T00:00:00Z"), issue("d", due = "2026-09-20"),
        ), today, now)
        assertEquals(listOf("d", "a"), open.map { it.id })
        assertEquals(listOf("c", "b"), done.map { it.id })
    }

    @Test fun `fechas de un toque`() {
        fun keys(d: LocalDate) = IssueTasks.dateShortcuts(d).map { it.first }
        // Lunes: hoy, mañana, el viernes (faltan 4) y el lunes que viene.
        val mon = LocalDate.parse("2026-09-28")
        assertEquals(listOf(Shortcut.TODAY, Shortcut.TOMORROW, Shortcut.FRIDAY, Shortcut.NEXT_WEEK), keys(mon))
        val m = IssueTasks.dateShortcuts(mon).toMap()
        assertEquals(mon, m[Shortcut.TODAY]); assertEquals(mon.plusDays(1), m[Shortcut.TOMORROW])
        assertEquals(LocalDate.parse("2026-10-02"), m[Shortcut.FRIDAY]); assertEquals(LocalDate.parse("2026-10-05"), m[Shortcut.NEXT_WEEK])
        // Jueves: el viernes es mañana, no se repite.
        assertEquals(listOf(Shortcut.TODAY, Shortcut.TOMORROW, Shortcut.NEXT_WEEK), keys(LocalDate.parse("2026-10-01")))
        // Viernes: «el viernes» sería hoy; no sale.
        assertFalse(Shortcut.FRIDAY in keys(LocalDate.parse("2026-10-02")))
        // Sábado: el viernes de la otra semana (faltan 6); domingo: el lunes es mañana y también la otra semana.
        assertEquals(LocalDate.parse("2026-10-09"), IssueTasks.dateShortcuts(LocalDate.parse("2026-10-03")).toMap()[Shortcut.FRIDAY])
        assertEquals(LocalDate.parse("2026-09-28"), IssueTasks.dateShortcuts(today).toMap()[Shortcut.NEXT_WEEK])
        // «La otra semana» siempre es un lunes futuro.
        (0L..13L).map { today.plusDays(it) }.forEach { d ->
            val nw = IssueTasks.dateShortcuts(d).toMap()[Shortcut.NEXT_WEEK]!!
            assertEquals(DayOfWeek.MONDAY, nw.dayOfWeek); assertTrue(nw.isAfter(d))
        }
    }

    @Test fun `filtros de la pestana`() {
        val mine = issue("a", owner = "me"); val other = issue("b", owner = "x"); val done = issue("c", "done", owner = "me")
        assertTrue(IssueTasks.matches("mine", mine, "me")); assertFalse(IssueTasks.matches("mine", other, "me")); assertFalse(IssueTasks.matches("mine", done, "me"))
        assertTrue(IssueTasks.matches("open", other, "me")); assertFalse(IssueTasks.matches("open", done, "me"))
        assertTrue(IssueTasks.matches("closed", done, "me")); assertFalse(IssueTasks.matches("closed", mine, "me"))
    }

    @Test fun `por responsable yo primero y sin responsable al final`() {
        val names = mapOf("me" to "Zoe", "ana" to "Ana", "beto" to "Beto", IssueTasks.NO_OWNER to "Sin responsable")
        val list = listOf(issue("1", owner = "beto"), issue("2", owner = null), issue("3", owner = "me"), issue("4", owner = "ana"), issue("5", owner = "beto"))
        val s = IssueTasks.sections(list, byPerson = true, myId = "me") { names[it]!! }
        assertEquals(listOf("me", "ana", "beto", IssueTasks.NO_OWNER), s.map { it.first })
        assertEquals(listOf("1", "5"), s[2].second.map { it.id })
        // Por grupo: el que tiene más primero.
        val g = IssueTasks.sections(listOf(issue("1", conv = "b"), issue("2", conv = "a"), issue("3", conv = "b")), byPerson = false, myId = "me") { it }
        assertEquals(listOf("b", "a"), g.map { it.first })
    }

    @Test fun `primer nombre`() {
        assertEquals("Lorena", IssueTasks.firstName("Lorena Tapias"))
        assertEquals("", IssueTasks.firstName(null))
    }
}
