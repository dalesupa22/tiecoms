package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Los mensajes de sistema del correo y de WhatsApp (docs/CORREO.md) nunca se ven como JSON crudo. */
class MailSystemTest {
    private fun sys(body: String) = MessageDTO(id = "m1", kind = "system", body = body)

    @Test fun parsesMailShared() {
        val b = MailSystem.parse(sys("""{"k":"mail.shared","emailId":"e1","provider":"google","subject":"Comité","from":"Jorge","comment":"¿Cómo respondemos?"}"""))
        assertNotNull(b); b!!
        assertEquals("mail.shared", b.key); assertEquals("e1", b.emailId); assertEquals("google", b.provider)
        assertEquals("Comité", b.subject); assertEquals("Jorge", b.from); assertEquals("¿Cómo respondemos?", b.comment)
        assertNull(b.wa)
    }

    @Test fun parsesMailCommentsRepliedAndFailed() {
        val c = MailSystem.parse(sys("""{"k":"mail.comments","emailId":"e1","title":"Comité","count":3,"lastById":"u2","lastByName":"Ana Ruiz","lastExcerpt":"yo lo reviso"}"""))!!
        assertEquals(3, c.count); assertEquals("Comité", c.subject); assertEquals("Ana Ruiz", c.lastByName); assertEquals("yo lo reviso", c.lastExcerpt)
        val r = MailSystem.parse(sys("""{"k":"mail.replied","emailId":"e1","subject":"Comité","byName":"Danny"}"""))!!
        assertEquals("Danny", r.byName)
        val f = MailSystem.parse(sys("""{"k":"mail.reply_failed","emailId":"e1","subject":"Comité","error":"Gmail no respondió"}"""))!!
        assertEquals("Gmail no respondió", f.error)
    }

    @Test fun parsesWaShared() {
        val b = MailSystem.parse(sys("""{"k":"wa.shared","accountId":"a1","jid":"573001@g.us","waMessageId":"w1","accountKind":"business","chatName":"Pedidos","isGroup":true,"author":"Luis","fromMe":false,"text":"Llegó el pedido","sentAt":"2026-09-29T15:00:00.000Z","comment":"Miren"}"""))!!
        assertEquals("wa.shared", b.key); assertEquals("Miren", b.comment); assertNull(b.emailId)
        val w = b.wa!!
        assertEquals("business", w.accountKind); assertEquals("Pedidos", w.chatName); assertTrue(w.isGroup); assertFalse(w.fromMe)
        assertEquals("Luis", w.author); assertEquals("Llegó el pedido", w.text)
    }

    @Test fun ignoresOtherKeysAndHumanMessages() {
        assertNull(MailSystem.parse(sys("""{"k":"issue.created","issueId":"i1","title":"x"}""")))
        assertNull(MailSystem.parse(MessageDTO(kind = "text", body = """{"k":"mail.shared","emailId":"e1"}""")))
        assertNull(MailSystem.parse(sys("""{"k":"mail.unknown","emailId":"e1"}""")))
        assertNull(MailSystem.parse(sys("{\"k\":\"mail.shared\",\"emailId\":")))
    }

    /** Vista previa recortada (140 caracteres) en la lista de chats: se recupera lo que llegó. */
    @Test fun truncatedPreviewStillParses() {
        val cut = """{"k":"mail.shared","emailId":"e1","provider":"google","subject":"Comité de compras","from":"Jorge Pérez","comment":"Miren este correo, ¿cómo le respond"""
        val pairs = Regex("\"(\\w+)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").findAll(cut).associate { it.groupValues[1] to kotlinx.serialization.json.JsonPrimitive(it.groupValues[2]) }
        val b = MailSystem.parse(kotlinx.serialization.json.JsonObject(pairs))!!
        assertEquals("Comité de compras", b.subject)
    }

    /** Mismos textos que la web (sys.mail.*, sys.wa.shared) en es y en; systemText los usa y no cae al JSON. */
    @Test fun stringsMatchWebAndSystemTextNeverRaw() {
        fun strings(dir: String): Map<String, String> = Regex("<string name=\"([^\"]+)\">(.*?)</string>")
            .findAll(File("src/main/res/$dir/strings_mail.xml").readText()).associate { it.groupValues[1] to it.groupValues[2] }
        val es = strings("values-es"); val en = strings("values")
        assertEquals(es.keys, en.keys)
        assertEquals("✉ Compartió el correo «%1\$s»", es["web_sys_mail_shared"])
        assertEquals("💬 %1\$s comentó el correo «%2\$s»: %3\$s", es["web_sys_mail_comments"])
        assertEquals("✉ %1\$s respondió el correo «%2\$s»", es["web_sys_mail_replied"])
        assertEquals("⚠ No salió la respuesta a «%1\$s»: %2\$s", es["web_sys_mail_reply_failed"])
        assertEquals("Compartió un mensaje de WhatsApp", es["web_sys_wa_shared"])
        assertEquals("✉ Shared the email “%1\$s”", en["web_sys_mail_shared"])
        assertEquals("Shared a WhatsApp message", en["web_sys_wa_shared"])
        val common = File("src/main/java/com/tiecoms/app/ui/Common.kt").readText()
        assertTrue(common.contains("MailSystem.parse(o)?.let { b -> return mailSystemText(ctx, b) }"))
        // Una clave desconocida muestra «Mensaje del sistema», no el cuerpo.
        assertFalse(Regex("\n\\s*else -> body\n").containsMatchIn(common))
        MailSystem.KEYS.forEach { k -> assertTrue(k, common.contains("\"$k\" ->") || k == "wa.shared") }
    }

    /** Responder una tarjeta: la cita nunca es JSON, ni con el cuerpo cortado a 140 de las vistas previas. */
    @Test fun cardQuoteAndForwarded() {
        val mail = """{"k":"mail.shared","emailId":"e1","provider":"google","subject":"Comité","from":"Jorge","forwardedFrom":"c9"}"""
        assertEquals("✉ Comité · Jorge", MailSystem.cardQuote("system", mail))
        assertEquals("c9", MailSystem.parse(mail)!!.forwardedFrom)
        assertEquals("✉ (sin asunto)", MailSystem.cardQuote("system", """{"k":"mail.shared","emailId":"e1","subject":""}"""))
        assertEquals("WhatsApp · Pedidos: Llegó el pedido", MailSystem.cardQuote("system", """{"k":"wa.shared","emailId":"w1","chatName":"Pedidos","text":"Llegó el pedido","isGroup":true}"""))
        val cut = """{"k":"mail.shared","emailId":"e1","provider":"google","subject":"Solicitud de presentación para el comité","from":"Jorge Ramírez","comment":"Mir"""
        assertEquals("✉ Solicitud de presentación para el comité · Jorge Ramírez", MailSystem.cardQuote("system", cut))
        assertNull(MailSystem.cardQuote("text", mail)); assertNull(MailSystem.cardQuote("system", """{"k":"issue.created","issueId":"i"}"""))
        assertTrue(MailSystem.isCard(MailSystem.parse(mail))); assertFalse(MailSystem.isCard(MailSystem.parse("""{"k":"mail.replied","emailId":"e1"}""")))
        // Las citas de la app pasan por quoteText.
        val conv = File("src/main/java/com/tiecoms/app/ui/ConversationScreen.kt").readText()
        assertFalse(conv.contains("excerpt(quoted.body")); assertFalse(conv.contains("excerpt(replyTo.body")); assertFalse(conv.contains("excerpt(privateHere.source.body"))
    }
}
