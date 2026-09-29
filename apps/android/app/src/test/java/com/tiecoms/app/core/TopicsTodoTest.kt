package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Las tres vistas de los temas (docs/TEMAS.md, pedido de Danny del 29-sep-2026; web bae3d7f: Conversation.tsx generalOnly,
 * TOPIC_ALL, topicUnread, el salto a un mensaje y la auto-selección al abrir): «General», «Todo» y un tema.
 */
class TopicsTodoTest {
    private val me = "u1"
    private val topics = listOf(TopicDTO(id = "a", name = "Ventas"), TopicDTO(id = "b", name = "Pagos"), TopicDTO(id = "z", name = "Viejo", archivedAt = "2026-09-28T00:00:00Z"))
    private val active = Topics.activeIds(topics)
    private fun m(seq: Long, topic: String? = null, author: String = "u2", kind: String = "text", deleted: Boolean = false, body: String = "x$seq") =
        MessageDTO(id = "m$seq", seq = seq, authorId = author, kind = kind, topicId = topic, deletedAt = if (deleted) "x" else null, body = body)
    private fun card(seq: Long, issue: String) = m(seq, kind = "system", body = """{"k":"issue.created","issueId":"$issue","title":"T"}""")

    // Leído hasta el 4: 1..4 leídos, 5..8 sin leer.
    private val msgs = listOf(m(1), m(2, "a"), m(3, "b"), m(4, "z"), m(5, "a"), m(6), m(7, "b", author = me), m(8, "a", kind = "system"))

    @Test fun `temas activos sin los archivados`() {
        assertEquals(setOf("a", "b"), active)
    }

    @Test fun `General solo sin tema, Todo con todo y un tema solo lo suyo`() {
        // General (null): solo lo sin tema; el 4 es de un tema archivado y cuenta como sin tema. Leído o no, da igual.
        assertEquals(listOf(1L, 4L, 6L), Topics.view(msgs, topics, null).map { it.seq })
        // Si se saltó a un mensaje (mención, enlace, ?m=), queda a la vista.
        assertEquals(listOf(1L, 2L, 4L, 6L), Topics.view(msgs, topics, null, setOf(2L)).map { it.seq })
        // Todo: todos los mensajes, cada uno con su etiqueta.
        assertEquals(msgs.map { it.seq }, Topics.view(msgs, topics, Topics.ALL).map { it.seq })
        // Un tema: solo lo suyo.
        assertEquals(listOf(2L, 5L, 8L), Topics.view(msgs, topics, "a").map { it.seq })
        // Sin temas activos, una sola banderita («Todo»): se ve todo, y «Todo» no es un filtro válido.
        assertEquals(msgs.size, Topics.view(msgs, listOf(TopicDTO(id = "a", archivedAt = "x")), null).size)
        assertEquals(msgs.size, Topics.view(msgs, emptyList(), null).size)
        assertNull(Topics.validFilter(emptyList(), Topics.ALL))
        assertEquals(Topics.ALL, Topics.validFilter(topics, Topics.ALL))
        // Tema quitado o archivado: sin tema, y deja de filtrar (vuelve a General).
        assertTrue(Topics.inGeneral(m(2, "gone"), active, emptySet()))
        assertEquals(listOf(1L, 4L, 6L), Topics.view(msgs, topics, "z").map { it.seq })
    }

    @Test fun `General no muestra las tarjetas de tareas de un tema`() {
        val list = listOf(m(1), card(2, "i-a"), card(3, "i-none"), card(4, "i-old"))
        val topicOf = mapOf("i-a" to "a", "i-old" to "z")
        assertEquals(listOf(1L, 3L, 4L), Topics.view(list, topics, null) { topicOf[it] }.map { it.seq })
        assertEquals(listOf(2L), Topics.view(list, topics, "a") { topicOf[it] }.map { it.seq })
        assertEquals(4, Topics.view(list, topics, Topics.ALL) { topicOf[it] }.size)
    }

    @Test fun `lo escrito en General o Todo va sin tema y en un tema con ese tema`() {
        assertNull(Topics.composeTopic(topics, null))
        assertNull(Topics.composeTopic(topics, Topics.ALL))
        assertEquals("a", Topics.composeTopic(topics, "a"))
        assertNull(Topics.composeTopic(topics, "z")) // archivado
    }

    @Test fun `saltar a un mensaje cambia el filtro a su tema o a General y en Todo no cambia`() {
        assertEquals("a", Topics.jumpFilter(topics, null, m(9, "a")))
        assertEquals("a", Topics.jumpFilter(topics, "b", m(9, "a")))
        assertNull(Topics.jumpFilter(topics, "b", m(9)))
        assertNull(Topics.jumpFilter(topics, "a", m(9, "z"))) // tema archivado: General
        assertEquals(Topics.ALL, Topics.jumpFilter(topics, Topics.ALL, m(9, "a")))
        assertEquals(Topics.ALL, Topics.jumpFilter(topics, Topics.ALL, m(9)))
    }

    @Test fun `numero de cada banderita es lo sin leer`() {
        val n = Topics.unread(msgs, active, readSeq = 4, me = me)
        // 5 (a, de otro) → a=1; 6 sin tema → ""=1; 7 es mío y 8 es de sistema: no cuentan; b sin pendientes → sin número.
        assertEquals(mapOf("a" to 1, "" to 1), n)
        assertNull(n["b"])
        // Un tema archivado cuenta en «General» (sin tema); los eliminados no cuentan.
        assertEquals(mapOf("" to 1), Topics.unread(listOf(m(9, "z"), m(10, "a", deleted = true)), active, 4, me))
        // Leído en vivo: al avanzar el cursor, los números bajan.
        assertEquals(emptyMap<String, Int>(), Topics.unread(msgs, active, readSeq = 8, me = me))
    }

    @Test fun `al abrir con todo lo no leido en un tema abre en esa banderita`() {
        val onlyA = listOf(m(1), m(2, "b"), m(3, "a"), m(4, me.let { "a" }), m(5, author = me), m(6, kind = "system"))
        // No leídos (>2): 3 y 4 en «a»; el 5 es mío y el 6 de sistema no cuentan → abre en «a», en el primer no leído (3).
        assertEquals("a", Topics.autoTopic(onlyA, active, readFrom = 2, me = me))
        assertEquals(3L, Topics.firstUnreadIn(onlyA, "a", 2, me))
        // Repartido entre temas: abre en «General».
        assertNull(Topics.autoTopic(listOf(m(3, "a"), m(4, "b")), active, 2, me))
        // Hay no leídos sin tema: «General».
        assertNull(Topics.autoTopic(listOf(m(3, "a"), m(4)), active, 2, me))
        // Un tema archivado es «sin tema»: «General».
        assertNull(Topics.autoTopic(listOf(m(3, "z")), active, 2, me))
        // Sin no leídos: nada que elegir.
        assertNull(Topics.autoTopic(onlyA, active, readFrom = 10, me = me))
    }
}
