package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tareas derivadas (docs/TAREAS.md): anidado, principales, visibilidad por defecto, push y enlace. */
class TaskNestingTest {
    private fun i(id: String, conv: String = "g", parent: String? = null, status: String = "open", created: String = "2026-09-2${id.length}T10:00:00Z",
                  vis: String? = null, viewers: List<String> = emptyList(), org: String? = null) =
        IssueDTO(id = id, conversationId = conv, title = id, parentIssueId = parent, status = status, createdAt = created, visibility = vis, viewerIds = viewers, visibleOrgId = org)

    private val parent = i("A")
    private val k1 = i("k1", parent = "A", created = "2026-09-20T10:00:00Z")
    private val k2 = i("k2", parent = "A", status = "done", created = "2026-09-19T10:00:00Z")
    private val k3 = i("k3", conv = "side", parent = "A", created = "2026-09-21T10:00:00Z") // en un sidechat
    private val orphan = i("o", parent = "X") // su asunto no lo veo
    private val all = listOf(parent, k1, k2, k3, orphan).associateBy { it.id }

    @Test fun `hijas abiertas primero y progreso`() {
        assertEquals(listOf("k1", "k3", "k2"), IssueTasks.childrenOf(all.values, "A").map { it.id })
        val p = IssueTasks.progress(IssueTasks.childrenOf(all.values, "A"))
        assertEquals(1, p.done); assertEquals(3, p.total); assertFalse(p.allDone)
        assertTrue(IssueTasks.progress(listOf(k2)).allDone)
    }

    @Test fun `lista del chat, tareas bajo su asunto`() {
        // En el chat del asunto: el asunto y la huérfana (su asunto no lo veo); las hijas van debajo del asunto.
        assertEquals(setOf("A", "o"), IssueTasks.conversationTops(all, "g").map { it.id }.toSet())
        // En el sidechat, la tarea suelta (su asunto es de otro chat).
        assertEquals(listOf("k3"), IssueTasks.conversationTops(all, "side").map { it.id })
    }

    @Test fun `principales en la pestana por grupo`() {
        assertEquals(setOf("A", "o"), IssueTasks.tops(all.values.toList(), all).map { it.id }.toSet())
        // Si el asunto no está en la lista filtrada (p. ej. Míos), la tarea sale sola.
        assertEquals(listOf("k1"), IssueTasks.tops(listOf(k1), all).map { it.id })
        // Se agrupa en la conversación del asunto, aunque viva en un sidechat.
        assertEquals("g", IssueTasks.groupConversation(k3, all))
        assertEquals("g", IssueTasks.groupConversation(orphan, all))
    }

    @Test fun `visibilidad por defecto y fuera del chat`() {
        assertEquals("org", IssueTasks.defaultVisibility(listOf("x", "y"), "x"))
        assertEquals("all", IssueTasks.defaultVisibility(listOf("x", "x"), "x"))
        assertEquals("org", IssueTasks.defaultVisibility(listOf("x", null), "x")) // un tercero invitado cuenta como otra empresa
        assertEquals("private", IssueTasks.effectiveVisibility("all", ownerInChat = false))
        assertEquals("org", IssueTasks.effectiveVisibility("org", ownerInChat = false))
        assertEquals("all", IssueTasks.effectiveVisibility("all", ownerInChat = true))
    }

    @Test fun `quien la ve en el detalle`() {
        val a = PersonDTO(id = "a", orgId = "x"); val b = PersonDTO(id = "b", orgId = "y"); val c = PersonDTO(id = "c", orgId = "z")
        val chat = listOf(a, b)
        assertEquals(listOf("a"), IssueTasks.audience(i("t", vis = "org", org = "x"), chat, listOf(a, b, c)).map { it.id })
        assertEquals(listOf("b", "c"), IssueTasks.audience(i("t", vis = "private", viewers = listOf("b", "c")), chat, listOf(a, b, c)).map { it.id })
        assertEquals(listOf("a", "b"), IssueTasks.audience(i("t"), chat, listOf(a, b, c)).map { it.id })
        assertTrue(i("t", vis = "org").restricted); assertFalse(i("t").restricted)
    }

    @Test fun `el arbol de grupos no repite las tareas`() {
        assertEquals(setOf("A", "o"), GroupsTree.openIssues(all.values, "g").map { it.id }.toSet())
    }

    @Test fun `push de tarea y enlace al asunto`() {
        val p = PushPayload.parse(mapOf("type" to "issue", "conversationId" to "c1", "issueId" to "i1", "inChat" to "false", "title" to "Laura te asignó una tarea"))!!
        assertEquals("i1", p.issueId); assertFalse(p.inChat)
        assertTrue(PushPayload.parse(mapOf("type" to "issue", "conversationId" to "c1", "issueId" to "i1", "inChat" to "true"))!!.inChat)
        assertEquals(DeepLink.Issue("i1", "c1"), DeepLinks.parse("chaggu://issue/i1?c=c1"))
        assertEquals(DeepLink.Issue("i1", null), DeepLinks.parse("chaggu://issue/i1"))
        assertEquals(DeepLink.Screen(DeepLinks.SCREEN_SCHEDULED), DeepLinks.parse("https://app.chaggu.com/programados"))
        assertNull(DeepLinks.parse("chaggu://issue/"))
    }

    @Test fun `eventos de cuenta nuevos`() {
        fun ev(s: String) = decodeAccountEvent(TcJson.parseToJsonElement(s))
        assertTrue(ev("""{"type":"issue.updated","issue":{"id":"i1","conversationId":"c","visibility":"org"}}""") is AccountEvent.IssueUpdated)
        assertEquals(AccountEvent.IssueHidden("i1", "c"), ev("""{"type":"issue.hidden","issueId":"i1","conversationId":"c"}"""))
        assertTrue(ev("""{"type":"me.sleep","sleep":{"on":true,"start":"23:00","end":"06:30","tz":"Europe/Madrid","tzAuto":false}}""") is AccountEvent.SleepUpdated)
        assertTrue(ev("""{"type":"scheduled.updated","scheduled":{"id":"s1","conversationId":"c","body":"x","sendAt":"2026-09-30T13:00:00Z","status":"pending"}}""") is AccountEvent.ScheduledUpdated)
    }
}
