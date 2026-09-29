package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 1.6.10: «Mensaje nuevo» con selección directa (chips en «Para:», Abrir chat / Crear chat (n+1), 💬 = directo). */
class NewChatTest {
    @Test fun `marcar, desmarcar y borrar el ultimo chip`() {
        var p = NewChat.toggle(emptyList(), "u2")
        p = NewChat.toggle(p, "u3")
        assertEquals(listOf("u2", "u3"), p)
        assertEquals(listOf("u3"), NewChat.toggle(p, "u2"))
        assertEquals(listOf("u2"), NewChat.backspace(p, ""))
        assertEquals(p, NewChat.backspace(p, "an")) // con texto, borra texto, no chips
        assertEquals(emptyList<String>(), NewChat.backspace(emptyList(), ""))
        assertEquals("", NewChat.queryAfterToggle("carl"))
    }

    @Test fun `boton de abajo segun cuantos`() {
        assertEquals(NewChat.Action.NONE, NewChat.action(emptyList()))
        assertEquals(NewChat.Action.DIRECT, NewChat.action(listOf("u2")))
        assertEquals(NewChat.Action.GROUP, NewChat.action(listOf("u2", "u3")))
        assertEquals(3, NewChat.memberCount(listOf("u2", "u3")))
        assertNull(NewChat.chatName("   ")); assertEquals("Compras", NewChat.chatName("  Compras ")); assertEquals(120, NewChat.chatName("x".repeat(200))!!.length)
        assertTrue(NewChat.showGroups(emptyList(), "ven")); assertFalse(NewChat.showGroups(listOf("u2"), "ven")); assertFalse(NewChat.showGroups(emptyList(), " "))
    }

    @Test fun `textos nuevos en espanol e ingles`() {
        fun s(dir: String) = File("src/main/res/$dir").listFiles { f -> f.name.endsWith(".xml") }!!.flatMap { f ->
            Regex("<string name=\"([^\"]+)\">(.*?)</string>").findAll(f.readText()).map { it.groupValues[1] to it.groupValues[2] }.toList() }.toMap()
        val es = s("values-es"); val en = s("values")
        assertEquals("Toca una o varias personas. El 💬 abre su chat directo.", es["compose_tip"])
        assertEquals("Abrir chat con %1\$s", es["chat_open_with"]); assertEquals("Crear chat (%1\$d)", es["chat_create_n"])
        listOf("compose_tip", "compose_to", "compose_add_more", "chat_open_with", "chat_create_n", "compose_open_direct").forEach { assertTrue(it, en.containsKey(it) && es.containsKey(it)) }
    }
}
