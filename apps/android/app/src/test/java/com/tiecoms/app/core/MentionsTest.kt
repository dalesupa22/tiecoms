package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SPEC-v4 §H menciones con @: offsets UTF-16 (emojis, tildes), recorte, buscador, tokens y orden. */
class MentionsTest {
    private val d = TcJson.decodeFromString(BootstrapDTO.serializer(), """
        {"me":{"id":"me"},"organizations":[{"id":"o","name":"Acme"}],
         "conversations":[{"id":"g","kind":"group","memberIds":["me","lau","jose","ana"]},{"id":"d","kind":"direct","memberIds":["me","lau"]}],
         "people":[{"id":"lau","name":"Laura Gómez","orgId":"o","title":"Soporte"},{"id":"jose","name":"José Ñúñez","orgId":"o"},{"id":"ana","name":"Ana Torres"},
                   {"id":"ext","name":"Laurita Fuera","kind":"human"}]}""")

    @Test fun `offsets UTF-16 con emojis y tildes`() {
        val src = "Hola 👋🏽 @jo"
        assertEquals(10 to "jo", Mentions.query(src, src.length)) // «Hola » 5 + 👋🏽 4 unidades UTF-16 + espacio
        val (text, m, cursor) = Mentions.insert(src, emptyList(), 10, src.length, "José Ñúñez", "jose")
        assertEquals("Hola 👋🏽 @José Ñúñez ", text)
        assertEquals(listOf(MentionDTO("jose", 10, 11)), m) // «José Ñúñez» = 10 + «@»
        assertEquals("@José Ñúñez", text.substring(10, 21)); assertEquals(22, cursor)
    }

    @Test fun `recorte corre offsets y descarta los invalidos`() {
        val (t, m) = Mentions.trim("   @Laura hola  ", listOf(MentionDTO("lau", 3, 6), MentionDTO("x", 0, 2), MentionDTO("y", 10, 1)))
        assertEquals("@Laura hola", t); assertEquals(listOf(MentionDTO("lau", 0, 6)), m)
        assertEquals(50, Mentions.trim("@a ".repeat(60), List(60) { MentionDTO("u", it * 3, 2) }).second.size)
    }

    @Test fun `buscador - arroba al inicio o tras espacio, sin salto de linea`() {
        assertEquals(0 to "lau", Mentions.query("@lau", 4))
        assertEquals(5 to "go", Mentions.query("hola @go", 8))
        assertNull(Mentions.query("correo@acme", 11))
        assertNull(Mentions.query("@la\nx", 5))
        assertEquals(0 to "", Mentions.query("@", 1))
        assertNull("un token ya elegido no reabre el buscador", Mentions.query("@Laura Gómez ", 13, listOf(MentionDTO("lau", 0, 12))))
    }

    @Test fun `candidatos sin tildes, primero quienes mas escriben, todos solo en grupos`() {
        val g = d.conversations[0]
        val recent = listOf("ana", "ana", "jose").map { MessageDTO(id = it + Math.random(), authorId = it) }
        assertEquals(listOf("ana", "jose", "lau", "all"), Mentions.candidates(d, g, "", recent, "todos").map { it.userId })
        assertEquals(listOf("jose"), Mentions.candidates(d, g, "nunez", recent, "todos").map { it.userId })
        assertEquals(listOf("lau"), Mentions.candidates(d, g, "GÓM", recent, "todos").map { it.userId })
        assertEquals(listOf("all"), Mentions.candidates(d, g, "tod", recent, "todos").map { it.userId })
        assertFalse(Mentions.candidates(d, d.conversations[1], "", recent, "todos").any { it.userId == "all" })
        assertEquals("ext", Mentions.outsider(d, g, "laurita")?.id)
        assertNull(Mentions.outsider(d, g, "l"))
    }

    @Test fun `retroceso dentro del token lo borra entero, escribir dentro lo quita`() {
        val m = listOf(MentionDTO("lau", 5, 12), MentionDTO("ana", 18, 11))
        val old = "Hola @Laura Gómez @Ana Torres ¿van?"
        // Un retroceso al final de «@Laura Gómez».
        val (t, rest, c) = Mentions.edit(old, old.removeRange(16, 17), m, 16)
        assertEquals("Hola  @Ana Torres ¿van?", t); assertEquals(listOf(MentionDTO("ana", 6, 11)), rest); assertEquals(5, c)
        // Escribir dentro de un token lo deja como texto normal.
        val typed = old.substring(0, 8) + "x" + old.substring(8)
        assertEquals(listOf(MentionDTO("ana", 19, 11)), Mentions.edit(old, typed, m, 9).second)
        // Escribir antes corre los tokens.
        assertEquals(listOf(MentionDTO("lau", 7, 12), MentionDTO("ana", 20, 11)), Mentions.edit(old, "¡¡" + old, m, 2).second)
    }

    @Test fun `me mencionan a mi o a todos, no a mis propios mensajes`() {
        assertTrue(Mentions.mentionsMe(MessageDTO(authorId = "lau", mentions = listOf(MentionDTO("me", 0, 3))), "me"))
        assertTrue(Mentions.mentionsMe(MessageDTO(authorId = "lau", mentions = listOf(MentionDTO("all", 0, 6))), "me"))
        assertFalse(Mentions.mentionsMe(MessageDTO(authorId = "me", mentions = listOf(MentionDTO("all", 0, 6))), "me"))
        assertFalse(Mentions.mentionsMe(MessageDTO(authorId = "lau", mentions = listOf(MentionDTO("ana", 0, 4))), "me"))
    }

    @Test fun `contrato - mentions, unreadMentions, droppedMentions y bandeja`() {
        val body = TcJson.encodeToString(SendBody.serializer(), SendBody("c", "@Laura hola", mentions = listOf(MentionDTO("lau", 0, 6))))
        assertTrue(body.contains("\"mentions\":[{\"userId\":\"lau\",\"start\":0,\"length\":6}]"))
        assertFalse(TcJson.encodeToString(SendBody.serializer(), SendBody("c", "x")).contains("mentions"))
        assertEquals(2, TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c","unreadMentions":2}""").unreadMentions)
        assertEquals(listOf("x"), TcJson.decodeFromString(SendResult.serializer(), """{"message":{"id":"m"},"droppedMentions":["x"]}""").droppedMentions)
        val page = TcJson.decodeFromString(MentionsPage.serializer(), """{"mentions":[{"message":{"id":"m","body":"@todos","mentions":[{"userId":"all","start":0,"length":6}]},"conversationId":"g","all":true,"read":false,"createdAt":"2026-09-25T10:00:00Z"}],"hasMore":true}""")
        assertTrue(page.hasMore); assertTrue(page.mentions[0].all); assertEquals("all", page.mentions[0].message.mentions[0].userId)
    }

    @Test fun `una mencion sin leer sube la conversacion aunque este silenciada`() {
        val a = ConversationDTO(id = "a", kind = "direct", lastMessageAt = "2026-09-25T10:00:00Z")
        val b = ConversationDTO(id = "b", kind = "direct", lastMessageAt = "2026-09-01T00:00:00Z", unread = 3, unreadMentions = 1, mutedUntil = "2999-01-01T00:00:00Z")
        assertEquals(listOf("b", "a"), HomeTree.order(listOf(a, b), 0).map { it.id })
    }
}
