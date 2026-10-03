package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/** 1.7.13: «Enviar en un grupo» al compartir y la pantalla de Tareas por fecha, sin servidor. */
class Android1713Test {
    // ---------- Compartir: ¿se ofrece «Enviar en un grupo»? ----------
    private val data = BootstrapDTO(
        me = UserDTO(id = "me"),
        people = listOf(PersonDTO(id = "ana"), PersonDTO(id = "beto"), PersonDTO(id = "bot", kind = "agent")),
        conversations = listOf(
            ConversationDTO(id = "dmAna", kind = "direct", memberIds = listOf("me", "ana")),
            ConversationDTO(id = "dmBeto", kind = "direct", memberIds = listOf("beto", "me")),
            ConversationDTO(id = "dmAna2", kind = "direct", memberIds = listOf("ana", "me")),
            ConversationDTO(id = "tu", kind = "direct", memberIds = listOf("me")),
            ConversationDTO(id = "dmBot", kind = "direct", memberIds = listOf("me", "bot")),
            ConversationDTO(id = "dmGg", kind = "direct", memberIds = listOf("me", Gg.ID)),
            ConversationDTO(id = "grupo", kind = "group", memberIds = listOf("me", "ana", "beto")),
            ConversationDTO(id = "multi", kind = "multi", memberIds = listOf("me", "ana", "beto")),
        ),
    )

    @Test fun `dos directos con personas ofrecen el grupo con esas personas`() {
        assertEquals(listOf("ana", "beto"), ShareGroup.people(listOf("dmAna", "dmBeto"), data))
    }

    @Test fun `con uno solo, grupos mezclados, Tu, gg o agentes solo se envia por separado`() {
        assertNull(ShareGroup.people(listOf("dmAna"), data))
        assertNull(ShareGroup.people(listOf("dmAna", "grupo"), data))
        assertNull(ShareGroup.people(listOf("dmAna", "multi"), data))
        assertNull(ShareGroup.people(listOf("dmAna", "tu"), data))
        assertNull(ShareGroup.people(listOf("dmAna", "dmGg"), data))
        assertNull(ShareGroup.people(listOf("dmAna", "dmBot"), data))
        assertNull(ShareGroup.people(listOf("dmAna", "noExiste"), data))
        // Dos directos con la misma persona no hacen un grupo.
        assertNull(ShareGroup.people(listOf("dmAna", "dmAna2"), data))
    }

    // ---------- Tareas por fecha ----------
    private val today = LocalDate.parse("2026-10-03") // sábado
    private val now = Instant.parse("2026-10-03T15:00:00Z")
    private fun issue(id: String, due: String? = null, status: String = "open", since: String = "2026-10-03T10:00:00Z") =
        IssueDTO(id = id, conversationId = "c", title = id, status = status, dueDate = due, statusSince = since, createdAt = "2026-09-01T00:00:00Z")

    @Test fun `franjas vencidas, hoy, esta semana hasta el domingo, mas adelante y sin fecha`() {
        assertEquals(IssueTasks.DueBucket.OVERDUE, IssueTasks.dueBucket(issue("a", "2026-10-02"), today))
        assertEquals(IssueTasks.DueBucket.TODAY, IssueTasks.dueBucket(issue("b", "2026-10-03"), today))
        assertEquals(IssueTasks.DueBucket.WEEK, IssueTasks.dueBucket(issue("c", "2026-10-04"), today)) // domingo
        assertEquals(IssueTasks.DueBucket.LATER, IssueTasks.dueBucket(issue("d", "2026-10-05"), today)) // lunes
        assertEquals(IssueTasks.DueBucket.NONE, IssueTasks.dueBucket(issue("e"), today))
        // Una hecha con fecha pasada no es «vencida».
        assertEquals(IssueTasks.DueBucket.LATER, IssueTasks.dueBucket(issue("f", "2026-09-01", "done"), today))
    }

    @Test fun `byDate respeta el orden de las franjas y la fecha dentro`() {
        val list = listOf(issue("sin"), issue("lunes", "2026-10-05"), issue("hoy", "2026-10-03"), issue("ayer", "2026-10-02"), issue("antier", "2026-10-01"), issue("dom", "2026-10-04"))
        val r = IssueTasks.byDate(list, today, now)
        assertEquals(listOf(IssueTasks.DueBucket.OVERDUE, IssueTasks.DueBucket.TODAY, IssueTasks.DueBucket.WEEK, IssueTasks.DueBucket.LATER, IssueTasks.DueBucket.NONE), r.map { it.first })
        assertEquals(listOf("antier", "ayer"), r[0].second.map { it.id })
    }

    @Test fun `dias de atraso y sin movimiento solo si no esta vencida`() {
        assertEquals(3, IssueTasks.overdueDays(issue("a", "2026-09-30"), today))
        assertEquals(0, IssueTasks.overdueDays(issue("b", "2026-10-04"), today))
        assertEquals(0, IssueTasks.overdueDays(issue("c", "2026-09-30", "done"), today))
        val quieta = "2026-09-28T10:00:00Z"
        assertEquals(5, IssueTasks.idleDays(issue("d", "2026-10-10", since = quieta), today, now))
        assertEquals(0, IssueTasks.idleDays(issue("e", "2026-09-30", since = quieta), today, now))
    }
}
