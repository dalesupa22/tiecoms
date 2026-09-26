package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Menciones sin caídas (revisión tras el cierre de iOS en un sidechat al elegir a alguien con «@»): posiciones viejas,
 * tokens fuera de rango, emoji y tildes antes del «@» y borrar sobre un token.
 */
class MentionsSafetyTest {
    @Test fun `elegir con posiciones viejas no se sale del texto`() {
        // El toque llega con el cursor de antes de borrar: «hola @lau» → «hola @» (cursor 9 > largo 6).
        val (t, m, c) = Mentions.insert("hola @", emptyList(), 5, 9, "Laura", "u1")
        assertEquals("hola @Laura ", t); assertEquals(listOf(MentionDTO("u1", 5, 6)), m); assertEquals(12, c)
        // Arroba después del cursor y cursor negativo: se acotan sin excepción.
        Mentions.insert("abc", emptyList(), 10, 2, "X", "u")
        Mentions.insert("", emptyList(), 3, -1, "X", "u")
    }

    @Test fun `tokens fuera de rango se descartan al insertar y al editar`() {
        val stale = listOf(MentionDTO("u9", 20, 6), MentionDTO("u8", -1, 3), MentionDTO("u7", 0, 0))
        val (_, m, _) = Mentions.insert("@", stale, 0, 1, "Luis", "u1")
        assertEquals(listOf(MentionDTO("u1", 0, 5)), m)
        // Borrar sobre un token cuyo rango venía mal del servidor (más largo que el cuerpo) no revienta.
        val (t, r, _) = Mentions.edit("@Luis hola", "@Luis hol", listOf(MentionDTO("u1", 0, 5), MentionDTO("u2", 6, 40)), 9)
        assertEquals("@Luis hol", t); assertEquals(listOf(MentionDTO("u1", 0, 5)), r)
        assertEquals(listOf(MentionDTO("a", 0, 2)), Mentions.sanitize("@a @b", listOf(MentionDTO("a", 0, 2), MentionDTO("b", 1, 3))))
    }

    @Test fun `emoji y tildes antes del arroba`() {
        val text = "Qué 👍🏽 @lu"
        val q = Mentions.query(text, text.length)
        assertNotNull(q); assertEquals("lu", q!!.second); assertEquals(text.indexOf('@'), q.first)
        val (t, m, c) = Mentions.insert(text, emptyList(), q.first, text.length, "Luis Gómez", "u1")
        assertEquals("Qué 👍🏽 @Luis Gómez ", t)
        assertEquals("@Luis Gómez", t.substring(m[0].start, m[0].start + m[0].length)); assertEquals(t.length, c)
        // Seguir escribiendo y luego borrar el emoji de antes (2 unidades UTF-16 + modificador) corre el token.
        val typed = "$t¿lo ves?"
        val (t2, m2, _) = Mentions.edit(t, typed, m, typed.length)
        assertEquals(m, m2)
        val noEmoji = typed.replace("👍🏽 ", "")
        val (t3, m3, _) = Mentions.edit(typed, noEmoji, m2, 4)
        assertEquals(noEmoji, t3); assertEquals("@Luis Gómez", t3.substring(m3[0].start, m3[0].start + m3[0].length))
    }

    @Test fun `retroceso sobre el token lo borra entero y el cursor queda en rango`() {
        val (t, m, _) = Mentions.insert("Hola @", emptyList(), 5, 6, "Ana", "u1") // «Hola @Ana »
        val back = t.dropLast(2) + " " // borra la «a» final del token: «Hola @An »
        val (t2, m2, c2) = Mentions.edit(t, back, m, back.length - 1)
        assertEquals("Hola  ", t2); assertTrue(m2.isEmpty()); assertTrue(c2 in 0..t2.length)
    }

    @Test fun `sidechat de dos, la otra persona y todos`() {
        val d = BootstrapDTO(me = UserDTO(id = "me"), people = listOf(PersonDTO(id = "me", name = "Yo"), PersonDTO(id = "l", name = "Luis Gómez")))
        val side = ConversationDTO(id = "s", kind = "multi", memberIds = listOf("me", "l"), parentId = "g", deriveKind = "side")
        val c = Mentions.candidates(d, side, "", emptyList(), "todos")
        assertEquals(listOf("l", Mentions.ALL), c.map { it.userId })
        assertEquals(listOf("l"), Mentions.candidates(d, side, "gó", emptyList(), "todos").map { it.userId })
    }
}
