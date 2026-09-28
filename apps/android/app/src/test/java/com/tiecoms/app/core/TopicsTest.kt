package com.tiecoms.app.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Temas del chat (docs/TEMAS.md): decodificación tolerante, evento topics.changed y reglas de la fila, sin servidor. */
class TopicsTest {
    private fun ev(json: String) = decodeConversationEvent(TcJson.parseToJsonElement(json))

    @Test fun `TopicDTO completo, con campos nuevos y con faltantes`() {
        val t = TcJson.decodeFromString(TopicDTO.serializer(), """
            {"id":"t1","conversationId":"c","name":"Finanzas","color":"green","icon":"💰","position":2,"archivedAt":null,
             "createdBy":"u1","createdAt":"2026-09-28T10:00:00Z","futuro":{"x":1}}""")
        assertEquals("Finanzas", t.name); assertEquals("green", t.color); assertEquals("💰", t.icon); assertEquals(2, t.position)
        assertFalse(t.archived)
        val bare = TcJson.decodeFromString(TopicDTO.serializer(), """{"id":"t2","name":"X","color":null,"archivedAt":"2026-09-28T11:00:00Z"}""")
        assertEquals("blue", bare.color); assertEquals("#", bare.icon); assertTrue(bare.archived)
        // Un color que la app no conoce se decodifica igual (la interfaz lo pinta azul).
        assertEquals("teal", TcJson.decodeFromString(TopicDTO.serializer(), """{"id":"t3","color":"teal"}""").color)
    }

    @Test fun `respuestas de la API de temas`() {
        val list = TcJson.decodeFromString(TopicsPage.serializer(), """{"topics":[{"id":"a","name":"A"},{"id":"b","name":"B","archivedAt":"2026-09-28T00:00:00Z"}]}""")
        assertEquals(listOf("a"), Topics.active(list.topics).map { it.id })
        assertEquals(listOf("b"), Topics.archived(list.topics).map { it.id })
        assertEquals(3, TcJson.decodeFromString(TopicsPage.serializer(), """{"topics":[],"cleared":3}""").cleared)
        val created = TcJson.decodeFromString(TopicCreated.serializer(), """{"topic":{"id":"n","name":"Nuevo"},"topics":[{"id":"n","name":"Nuevo"}]}""")
        assertEquals("n", created.topic.id); assertEquals(1, created.topics.size)
    }

    @Test fun `MessageDTO con y sin topicId`() {
        val with = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","seq":1,"authorId":"u1","body":"hola","topicId":"t1","topicBy":"u2"}""")
        assertEquals("t1", with.topicId); assertEquals("u2", with.topicBy)
        assertEquals("u2", Topics.setBy(with))
        val none = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","seq":1,"body":"hola","topicId":null,"topicBy":null}""")
        assertNull(none.topicId); assertNull(none.topicBy)
        // Servidor anterior: no manda el campo.
        val old = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","seq":1,"body":"hola"}""")
        assertNull(old.topicId); assertNull(Topics.setBy(old))
        // El autor se lo puso a su propio mensaje: no se dice «tema puesto por».
        assertNull(Topics.setBy(old.copy(authorId = "u1", topicId = "t1", topicBy = "u1")))
    }

    @Test fun `evento topics changed trae la lista completa`() {
        val e = ev("""{"type":"topics.changed","conversationId":"c","eventSeq":9,"topics":[
            {"id":"t1","name":"Ventas","color":"orange","icon":"📈"},{"id":"t2","conversationId":"c","name":"Viejo","archivedAt":"2026-09-28T00:00:00Z"},{"name":"sin id"}]}""")
            as ConversationEvent.TopicsChanged
        assertEquals(9, e.eventSeq)
        assertEquals(listOf("t1", "t2"), e.topics.map { it.id })
        assertEquals("c", e.topics[0].conversationId)
        // Sin lista legible: solo avanza el cursor.
        val bad = ev("""{"type":"topics.changed","conversationId":"c","eventSeq":10,"topics":"x"}""")
        assertTrue(bad is ConversationEvent.CursorOnly)
        // message.updated trae el topicId nuevo.
        val u = ev("""{"type":"message.updated","conversationId":"c","eventSeq":11,"message":{"id":"m","seq":1,"body":"x","topicId":"t1","topicBy":"u2"}}""")
            as ConversationEvent.MessageUpdated
        assertEquals("t1", upsertMessage(listOf(MessageDTO(id = "m", seq = 1)), u.message).single().topicId)
    }

    @Test fun `el envio lleva topicId solo si hay tema`() {
        val with = TcJson.encodeToJsonElement(SendBody.serializer(), SendBody("cm", "hola", topicId = "t1")) as JsonObject
        assertEquals(JsonPrimitive("t1"), with["topicId"])
        val without = TcJson.encodeToJsonElement(SendBody.serializer(), SendBody("cm", "hola")) as JsonObject
        assertFalse(without.containsKey("topicId"))
        val socket = TcJson.encodeToJsonElement(SocketSendBody.serializer(), SocketSendBody("c", "cm", "hola", topicId = "t1")) as JsonObject
        assertEquals(JsonPrimitive("t1"), socket["topicId"])
        // La cola persistente conserva el tema.
        val p = TcJson.decodeFromString(PendingMessage.serializer(), """{"clientMessageId":"cm","conversationId":"c","body":"x","createdAt":"2026-09-28T00:00:00Z","topicId":"t1"}""")
        assertEquals("t1", p.topicId)
    }

    @Test fun `filtro, conteo, sugerencias y quitar tema`() {
        val topics = listOf(TopicDTO(id = "a", color = "blue", icon = "🌐"), TopicDTO(id = "b", color = "green", icon = "🌱", archivedAt = "2026-09-28T00:00:00Z"))
        val msgs = listOf(MessageDTO(id = "1", seq = 1, topicId = "a"), MessageDTO(id = "2", seq = 2), MessageDTO(id = "3", seq = 3, topicId = "a", deletedAt = "x"),
            MessageDTO(id = "4", seq = 4, topicId = "b"))
        assertEquals(mapOf("a" to 1, "b" to 1), Topics.counts(msgs))
        assertEquals(listOf("1", "3"), Topics.filter(msgs, "a").map { it.id })
        assertEquals(4, Topics.filter(msgs, null).size)
        assertEquals("a", Topics.validFilter(topics, "a"))
        assertNull(Topics.validFilter(topics, "b")) // archivado: deja de filtrar
        assertNull(Topics.validFilter(topics, "zzz")) // quitado
        assertEquals("orange", Topics.nextColor(topics))
        assertEquals("💰", Topics.nextIcon(topics))
        val cleared = Topics.clear(msgs, "a")
        assertTrue(cleared.none { it.topicId == "a" }); assertEquals("b", cleared[3].topicId)
        // Sin límite práctico: el tope técnico es del servidor.
        assertEquals(50, Topics.LIMIT)
    }

    @Test fun `tarjeta de tarea en el chat y filtro por tema de la tarea`() {
        fun sys(body: String, seq: Long) = MessageDTO(id = "s$seq", seq = seq, kind = "system", body = body)
        val card = sys("""{"k":"issue.created","issueId":"i1","title":"Cotizar"}""", 1)
        val child = sys("""{"k":"issue.created","issueId":"i2","title":"Parte","parentIssueId":"i1"}""", 2)
        val closed = sys("""{"k":"issue.closed","issueId":"i1","title":"Cotizar"}""", 3)
        assertEquals("i1", Topics.cardIssueId(card))
        assertNull(Topics.cardIssueId(child)) // las derivadas siguen como línea
        assertNull(Topics.cardIssueId(closed))
        assertNull(Topics.cardIssueId(MessageDTO(kind = "text", body = """{"k":"issue.created","issueId":"i1"}""")))
        assertNull(Topics.cardIssueId(sys("no es json", 4)))
        val msgs = listOf(card, child, MessageDTO(id = "m", seq = 5, topicId = "t1"), MessageDTO(id = "n", seq = 6))
        val issueTopics = mapOf("i1" to "t1")
        assertEquals(listOf("s1", "m"), Topics.filter(msgs, "t1") { issueTopics[it] }.map { it.id })
        assertEquals(listOf("m"), Topics.filter(msgs, "t1").map { it.id })
        // IssueDTO.topicId es opcional.
        assertEquals("t1", TcJson.decodeFromString(IssueDTO.serializer(), """{"id":"i1","title":"x","topicId":"t1"}""").topicId)
        assertNull(TcJson.decodeFromString(IssueDTO.serializer(), """{"id":"i1","title":"x"}""").topicId)
    }
}
