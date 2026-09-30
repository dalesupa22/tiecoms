package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 1.7.5 (pedido de Danny del 30-sep-2026): la fila de temas es [General] [Todo] [con no leídos] [resto en el orden guardado],
 * sin repetidos; y abrir desde la burbuja, la notificación, una mención, la búsqueda o un enlace deja el chat en el tema del
 * mensaje (o en «Todo» si no tiene) y en el mensaje.
 */
class TopicsUnreadFirstTest {
    private val me = "u1"
    private fun t(id: String, pos: Int, archived: Boolean = false) =
        TopicDTO(id = id, conversationId = "c1", name = id.uppercase(), position = pos, archivedAt = if (archived) "2026-09-30T00:00:00Z" else null)
    private fun m(seq: Long, topic: String? = null, author: String = "u2") = MessageDTO(id = "m$seq", seq = seq, authorId = author, topicId = topic, body = "x")

    // Orden guardado: a, b, c, d (x archivado).
    private val topics = listOf(t("c", 2), t("a", 0), t("x", 1, archived = true), t("b", 1), t("d", 3))

    @Test fun `sin no leidos General, Todo y el orden guardado`() {
        assertEquals(listOf("a", "b", "c", "d"), Topics.rowOrder(topics, emptyMap()).map { it.id })
        assertEquals(listOf(Topics.GENERAL, Topics.ALL, "a", "b", "c", "d"), Topics.rowKeys(topics, emptyMap()))
        // Un cero no es «no leído».
        assertEquals(listOf("a", "b", "c", "d"), Topics.rowOrder(topics, mapOf("c" to 0)).map { it.id })
    }

    @Test fun `con no leidos General, Todo, los no leidos en el orden guardado y luego el resto`() {
        val unread = mapOf("d" to 2, "b" to 1, "" to 5, "x" to 3)
        // d y b tienen no leídos: van primero, entre ellos en el orden guardado (b antes que d). El archivado no aparece;
        // la clave "" (sin tema) es el número de «General», que sigue primera.
        assertEquals(listOf("b", "d", "a", "c"), Topics.rowOrder(topics, unread).map { it.id })
        assertEquals(listOf(Topics.GENERAL, Topics.ALL, "b", "d", "a", "c"), Topics.rowKeys(topics, unread))
    }

    @Test fun `al leerse vuelve a su lugar`() {
        assertEquals(listOf("c", "a", "b", "d"), Topics.rowOrder(topics, mapOf("c" to 1)).map { it.id })
        assertEquals(listOf("a", "b", "c", "d"), Topics.rowOrder(topics, mapOf("c" to 0)).map { it.id })
    }

    @Test fun `nunca se repite un tema`() {
        val dup = topics + t("a", 7) + t("b", 1)
        val keys = Topics.rowKeys(dup, mapOf("a" to 1, "b" to 4))
        assertEquals(keys.distinct(), keys)
        assertEquals(listOf(Topics.GENERAL, Topics.ALL, "a", "b", "c", "d"), keys)
    }

    @Test fun `sin temas activos una sola banderita`() {
        assertEquals(listOf(Topics.GENERAL), Topics.rowKeys(listOf(t("x", 0, archived = true)), mapOf("" to 3)))
        assertEquals(listOf(Topics.GENERAL), Topics.rowKeys(emptyList(), emptyMap()))
    }

    @Test fun `con los no leidos calculados en el cliente`() {
        val msgs = listOf(m(1, "a"), m(2, "c"), m(3, "d"), m(4, "c", author = me), m(5))
        val unread = Topics.unread(msgs, Topics.activeIds(topics), readSeq = 1, me = me)
        // 2 (c) y 3 (d) de otro; el 4 es mío; el 5 sin tema va a «General».
        assertEquals(listOf(Topics.GENERAL, Topics.ALL, "c", "d", "a", "b"), Topics.rowKeys(topics, unread))
    }

    @Test fun `el arrastre sigue sobre el orden guardado`() {
        // Aunque d se vea primero por tener no leídos, soltar a sobre c reordena el orden guardado.
        val saved = Topics.ordered(topics).map { it.id }
        assertEquals(listOf("b", "c", "a", "d"), Topics.moveTo(saved, "a", "c"))
    }

    @Test fun `saltar a un mensaje con tema deja el filtro en su tema`() {
        // Burbuja, notificación, mención, búsqueda o enlace: desde «General» (así abría) o desde otro tema.
        assertEquals("c", Topics.jumpFilter(topics, null, m(9, "c")))
        assertEquals("c", Topics.jumpFilter(topics, "a", m(9, "c")))
        // En «Todo» no cambia.
        assertEquals(Topics.ALL, Topics.jumpFilter(topics, Topics.ALL, m(9, "c")))
    }

    @Test fun `saltar a un mensaje sin tema deja el filtro en Todo`() {
        assertEquals(Topics.ALL, Topics.jumpFilter(topics, null, m(9)))
        assertEquals(Topics.ALL, Topics.jumpFilter(topics, "a", m(9)))
        // Tema archivado o quitado: como sin tema.
        assertEquals(Topics.ALL, Topics.jumpFilter(topics, null, m(9, "x")))
        assertEquals(Topics.ALL, Topics.jumpFilter(topics, null, m(9, "borrado")))
        // Sin temas activos no hay filtro.
        assertNull(Topics.jumpFilter(emptyList(), null, m(9, "c")))
    }

    @Test fun `saltar a la tarjeta de una tarea usa el tema de la tarea`() {
        val card = MessageDTO(id = "s", seq = 9, kind = "system", body = """{"k":"issue.created","issueId":"i1","title":"T"}""")
        assertEquals("b", Topics.jumpFilter(topics, null, card) { if (it == "i1") "b" else null })
        assertEquals(Topics.ALL, Topics.jumpFilter(topics, null, card))
    }

    @Test fun `sin el mensaje usa la pista del aviso o se queda como estaba`() {
        assertEquals("d", Topics.jumpFilter(topics, null, null, hintTopic = "d"))
        assertEquals("a", Topics.jumpFilter(topics, "a", null, hintTopic = "x")) // pista archivada: no cambia
        assertNull(Topics.jumpFilter(topics, null, null))
        // Con el mensaje, manda su tema real, no la pista.
        assertEquals("c", Topics.jumpFilter(topics, null, m(9, "c"), hintTopic = "d"))
    }

    @Test fun `enlace de la notificacion y la burbuja lleva el mensaje y el tema`() {
        assertEquals("chaggu://c/c1", DeepLinks.conversationUri("c1"))
        assertEquals("chaggu://c/c1?m=42", DeepLinks.conversationUri("c1", seq = 42))
        assertEquals("chaggu://c/c1?mid=msg-1&t=top1", DeepLinks.conversationUri("c1", messageId = "msg-1", topicId = "top1"))
        assertEquals("chaggu://c/c1?m=42&mid=msg-1&t=top1", DeepLinks.conversationUri("c1", 42, "msg-1", "top1"))
        assertEquals("chaggu://c/c1", DeepLinks.conversationUri("c1", seq = 0, messageId = "mal id", topicId = ""))
        val link = DeepLinks.parse(DeepLinks.conversationUri("c1", 42, "msg-1", "top1")) as DeepLink.Conversation
        assertEquals(DeepLink.Conversation("c1", 42, null, "msg-1", "top1"), link)
        assertEquals(DeepLink.Conversation("c1", null, null, "msg-1", null), DeepLinks.parse("chaggu://c/c1?mid=msg-1"))
        assertEquals("t9", (DeepLinks.parse("https://app.chaggu.com/c/c1?m=3&t=t9") as DeepLink.Conversation).topicId)
    }

    @Test fun `el push lee seq y tema si vienen`() {
        val p = PushPayload.parse(mapOf("type" to "message", "conversationId" to "c1", "messageId" to "m1", "seq" to "17", "topicId" to "t1"))!!
        assertEquals(17L, p.seq); assertEquals("t1", p.topicId); assertEquals("m1", p.messageId)
        // Servidor de hoy: solo messageId.
        val old = PushPayload.parse(mapOf("type" to "message", "conversationId" to "c1", "messageId" to "m1"))!!
        assertNull(old.seq); assertNull(old.topicId)
        assertNull(PushPayload.parse(mapOf("conversationId" to "c1", "seq" to "x"))!!.seq)
    }
}
