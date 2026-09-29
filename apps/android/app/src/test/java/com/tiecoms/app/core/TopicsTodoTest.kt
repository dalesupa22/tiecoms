package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * La regla nueva de «Todo» (docs/TEMAS.md, pedido de Danny del 29-sep-2026; web: Conversation.tsx hideTopicsInAll,
 * topicUnread y la auto-selección al abrir): qué se ve en «Todo», el número de cada banderita y en qué banderita abre.
 */
class TopicsTodoTest {
    private val me = "u1"
    private val topics = listOf(TopicDTO(id = "a", name = "Ventas"), TopicDTO(id = "b", name = "Pagos"), TopicDTO(id = "z", name = "Viejo", archivedAt = "2026-09-28T00:00:00Z"))
    private val active = Topics.activeIds(topics)
    private fun m(seq: Long, topic: String? = null, author: String = "u2", kind: String = "text", deleted: Boolean = false) =
        MessageDTO(id = "m$seq", seq = seq, authorId = author, kind = kind, topicId = topic, deletedAt = if (deleted) "x" else null, body = "x$seq")

    // Leído hasta el 4: 1..4 leídos, 5..8 sin leer.
    private val msgs = listOf(m(1), m(2, "a"), m(3, "b"), m(4, "z"), m(5, "a"), m(6), m(7, "b", author = me), m(8, "a", kind = "system"))

    @Test fun `temas activos sin los archivados`() {
        assertEquals(setOf("a", "b"), active)
    }

    @Test fun `Todo con temas activos esconde lo leido que tiene tema`() {
        val all = Topics.view(msgs, topics, null, readFrom = 4, revealed = emptySet()).map { it.seq }
        // 1 sin tema; 2 y 3 leídos con tema: fuera; 4 con tema archivado cuenta como sin tema; 5..8 no leídos se ven con su etiqueta.
        assertEquals(listOf(1L, 4L, 5L, 6L, 7L, 8L), all)
        // Si se saltó a un mensaje con tema (mención, enlace, ?m=), queda a la vista en «Todo».
        assertEquals(listOf(1L, 2L, 4L, 5L, 6L, 7L, 8L), Topics.view(msgs, topics, null, 4, setOf(2L)).map { it.seq })
        // Con una banderita elegida se ve solo ese tema, leído o no.
        assertEquals(listOf(2L, 5L, 8L), Topics.view(msgs, topics, "a", 4, emptySet()).map { it.seq })
        // Sin temas activos, «Todo» muestra todo, como antes.
        assertEquals(msgs.size, Topics.view(msgs, listOf(TopicDTO(id = "a", archivedAt = "x")), null, 4, emptySet()).size)
        assertEquals(msgs.size, Topics.view(msgs, emptyList(), null, 4, emptySet()).size)
        assertTrue(Topics.visibleInAll(m(2, "gone"), active, 4, emptySet())) // tema quitado: sin tema
    }

    @Test fun `numero de cada banderita es lo sin leer`() {
        val n = Topics.unread(msgs, active, readSeq = 4, me = me)
        // 5 (a, de otro) → a=1; 6 sin tema → ""=1; 7 es mío y 8 es de sistema: no cuentan; b sin pendientes → sin número.
        assertEquals(mapOf("a" to 1, "" to 1), n)
        assertNull(n["b"])
        // Un tema archivado cuenta en «Todo» (sin tema); los eliminados no cuentan.
        assertEquals(mapOf("" to 1), Topics.unread(listOf(m(9, "z"), m(10, "a", deleted = true)), active, 4, me))
        // Leído en vivo: al avanzar el cursor, los números bajan.
        assertEquals(emptyMap<String, Int>(), Topics.unread(msgs, active, readSeq = 8, me = me))
    }

    @Test fun `al abrir con todo lo no leido en un tema abre en esa banderita`() {
        val onlyA = listOf(m(1), m(2, "b"), m(3, "a"), m(4, me.let { "a" }), m(5, author = me), m(6, kind = "system"))
        // No leídos (>2): 3 y 4 en «a»; el 5 es mío y el 6 de sistema no cuentan → abre en «a», en el primer no leído (3).
        assertEquals("a", Topics.autoTopic(onlyA, active, readFrom = 2, me = me))
        assertEquals(3L, Topics.firstUnreadIn(onlyA, "a", 2, me))
        // Repartido entre temas: abre en «Todo».
        assertNull(Topics.autoTopic(listOf(m(3, "a"), m(4, "b")), active, 2, me))
        // Hay no leídos sin tema: «Todo».
        assertNull(Topics.autoTopic(listOf(m(3, "a"), m(4)), active, 2, me))
        // Un tema archivado es «sin tema»: «Todo».
        assertNull(Topics.autoTopic(listOf(m(3, "z")), active, 2, me))
        // Sin no leídos: nada que elegir.
        assertNull(Topics.autoTopic(onlyA, active, readFrom = 10, me = me))
    }
}
