package com.tiecoms.app.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Varios mensajes de WhatsApp llevados juntos: una sola tarjeta (wa.items) y POST /whatsapp/share con messageIds. */
class WaBundleTest {
    private fun dec(json: String) = TcJson.decodeFromString(SharedMailDTO.serializer(), json)

    @Test fun `decodifica items en orden y tolera campos desconocidos`() {
        val e = dec("""{"id":"s1","conversationId":"c1","provider":"whatsapp","snippet":"Ana: hola","futuro":{"x":1},
            "wa":{"chatName":"Obra","isGroup":true,"accountKind":"business","accountId":"a1","jid":"g@g.us","nuevo":true,
              "items":[{"waMessageId":"w1","author":"Ana","fromMe":false,"text":"hola","sentAt":"2026-10-14T10:00:00Z","attachmentId":null,"otro":2},
                       {"waMessageId":"w2","author":null,"fromMe":true,"text":"","sentAt":null,"attachmentId":"att2"}]},
            "chagguAttachments":[{"id":"att2","name":"foto.jpg","contentType":"image/jpeg","url":"/f/att2"}]}""")
        val items = WaBundle.items(e)!!
        assertEquals(listOf("w1", "w2"), items.map { it.waMessageId })
        assertEquals("Ana", items[0].author); assertFalse(items[0].fromMe); assertEquals("2026-10-14T10:00:00Z", items[0].sentAt); assertNull(items[0].attachmentId)
        assertNull(items[1].author); assertTrue(items[1].fromMe); assertNull(items[1].sentAt)
        assertEquals("foto.jpg", WaBundle.attachment(items[1], e)?.name)
        assertNull(WaBundle.attachment(items[0], e))
        assertTrue(WaBundle.loose(e, items).isEmpty())
    }

    @Test fun `sin items, null o con uno solo es la tarjeta de siempre`() {
        assertNull(WaBundle.items(dec("""{"id":"s1","provider":"whatsapp","wa":{"chatName":"Obra"}}""")))
        assertNull(WaBundle.items(dec("""{"id":"s1","provider":"whatsapp","wa":{"chatName":"Obra","items":null}}""")))
        assertNull(WaBundle.items(dec("""{"id":"s1","provider":"whatsapp","wa":{"items":[{"waMessageId":"w1","text":"x"}]}}""")))
        assertNull(WaBundle.items(dec("""{"id":"s1","provider":"google","wa":null}""")))
    }

    @Test fun `adjunto borrado no se dibuja y los sueltos se conservan`() {
        val e = dec("""{"id":"s1","provider":"whatsapp","wa":{"items":[{"waMessageId":"w1","text":"a","attachmentId":"gone"},{"waMessageId":"w2","text":"b"}]},
            "chagguAttachments":[{"id":"extra","name":"x.pdf","contentType":"application/pdf"}]}""")
        val items = WaBundle.items(e)!!
        assertNull(WaBundle.attachment(items[0], e))
        assertEquals(listOf("extra"), WaBundle.loose(e, items).map { it.id })
    }

    @Test fun `los seleccionados van en el orden del chat sin repetidos`() {
        val chat = listOf("m1", "m2", "m3", "m4", "m5").map { WaMessageDTO(id = it) }
        assertEquals(listOf("m1", "m3", "m5"), WaBundle.orderByChat(listOf("m5", "m1", "m3", "m1"), chat))
        // Los que ya no están en la lista quedan al final, en el orden de selección.
        assertEquals(listOf("m2", "x9", "x1"), WaBundle.orderByChat(listOf("x9", "m2", "x1"), chat))
        assertEquals(emptyList<String>(), WaBundle.orderByChat(emptyList(), chat))
    }

    @Test fun `cuerpo del envio con varios mensajes`() {
        val b = WaBundle.shareBody("acc", "57300@s.whatsapp.net", listOf("w1", "w2", "w2"), listOf("c1", "c2"), "  míralo  ", "cm-1")
        assertEquals("acc", b["accountId"]!!.jsonPrimitive.content)
        assertEquals("57300@s.whatsapp.net", b["jid"]!!.jsonPrimitive.content)
        assertEquals(JsonArray(listOf(JsonPrimitive("w1"), JsonPrimitive("w2"))), b["messageIds"])
        assertFalse("con varios no va messageId (un servidor viejo llevaría solo uno)", b.containsKey("messageId"))
        assertEquals(JsonArray(listOf(JsonPrimitive("c1"), JsonPrimitive("c2"))), b["conversationIds"])
        assertEquals("míralo", b["comment"]!!.jsonPrimitive.content)
        assertEquals("cm-1", b["clientMessageId"]!!.jsonPrimitive.content)
    }

    @Test fun `cuerpo del envio con un mensaje sigue sirviendo a servidores viejos`() {
        val b = WaBundle.shareBody("acc", "j", listOf("w1"), listOf("c1"), "   ")
        assertEquals("w1", b["messageId"]!!.jsonPrimitive.content)
        assertEquals(JsonArray(listOf(JsonPrimitive("w1"))), b["messageIds"])
        assertFalse(b.containsKey("comment")); assertFalse(b.containsKey("clientMessageId"))
    }

    @Test fun `primeras ocho filas y vista previa corta`() {
        val l = (1..12).toList()
        assertEquals(8, WaBundle.visible(l, expanded = false).size)
        assertEquals(12, WaBundle.visible(l, expanded = true).size)
        val msgs = listOf(WaMessageDTO(id = "1", author = "Ana", body = "hola\n  qué tal"), WaMessageDTO(id = "2", fromMe = true, body = "x".repeat(100)),
            WaMessageDTO(id = "3", body = "ok"), WaMessageDTO(id = "4", author = "Ana", body = "no sale"))
        val p = WaBundle.preview(msgs, you = "Tú", someone = "Alguien").lines()
        assertEquals(3, p.size)
        assertEquals("Ana: hola qué tal", p[0])
        assertEquals("Tú: " + "x".repeat(80) + "…", p[1])
        assertEquals("Alguien: ok", p[2])
    }

    @Test fun `textos en ingles y espanol`() {
        val keys = listOf("wa_bring_n", "wa_bring_title_n", "wa_n_messages", "wa_see_all_n", "wa_see_less", "wa_select_max")
        for (dir in listOf("values", "values-es")) {
            val xml = File("src/main/res/$dir/strings_wavarios.xml").readText()
            keys.forEach { k -> assertTrue("$dir sin $k", xml.contains("name=\"$k\"")) }
        }
        assertTrue(File("src/main/res/values-es/strings_wavarios.xml").readText().contains("Llevar a un chat (%1\$d)"))
    }
}
