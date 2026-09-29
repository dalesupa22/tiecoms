package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Sonidos (docs/SONIDOS.md): campos nuevos del contrato, reglas del sonido que suena y los archivos generados. */
class SoundsTest {
    @Test fun `campos nuevos del contrato`() {
        val c = TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c1","sound":"gota"}""")
        assertEquals("gota", c.sound)
        assertNull(TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c1","sound":null}""").sound)
        assertNull(TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c1"}""").sound) // servidor anterior
        val me = TcJson.decodeFromString(UserDTO.serializer(), """{"id":"u1","messageSound":"none","ringtone":"suave"}""")
        assertEquals("none", me.messageSound); assertEquals("suave", me.ringtone)
        val old = TcJson.decodeFromString(UserDTO.serializer(), """{"id":"u1"}""")
        assertNull(old.messageSound); assertNull(old.ringtone)
        val r = TcJson.decodeFromString(MySounds.serializer(), """{"messageSound":null,"ringtone":"marimba"}""")
        assertNull(r.messageSound); assertEquals("marimba", r.ringtone)
    }

    @Test fun `que sonido suena`() {
        assertEquals(10, Sounds.MESSAGE.size); assertEquals(listOf("clasico", "suave", "marimba"), Sounds.RINGTONES)
        assertEquals("pop", Sounds.effective(null, null))           // de fábrica
        assertEquals("brisa", Sounds.effective(null, "brisa"))      // mi predeterminado
        assertEquals("gota", Sounds.effective("gota", "brisa"))     // el del chat gana
        assertEquals("none", Sounds.effective("none", "brisa"))     // sin sonido en este chat
        assertEquals("none", Sounds.effective(null, "none"))
        assertEquals("brisa", Sounds.effective("futuro", "brisa"))  // un nombre que la app no conoce: como si no hubiera
        assertEquals("clasico", Sounds.ringtone(null)); assertEquals("suave", Sounds.ringtone("suave")); assertEquals("clasico", Sounds.ringtone("x"))
        assertEquals("msg_gota", Sounds.channelId("gota")); assertEquals("msg_none", Sounds.channelId("none")); assertEquals("msg_pop", Sounds.channelId("x"))
    }

    @Test fun `hay un archivo por sonido, por mencion y por tono`() {
        val raw = File("src/main/res/raw")
        Sounds.MESSAGE.forEach { s ->
            assertTrue("falta $s", File(raw, "$s.ogg").length() > 500)
            assertTrue("falta ${s}_mention", File(raw, "${s}_mention.ogg").length() > 500)
        }
        Sounds.RINGTONES.forEach { assertTrue("falta ring_$it", File(raw, "ring_$it.ogg").length() > 500) }
    }
}
