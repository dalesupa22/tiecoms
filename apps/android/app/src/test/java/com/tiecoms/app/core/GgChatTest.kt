package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** gg como chat y «Tú» (docs/GG-CHAT.md): gg.actions nunca crudo, el directo conmigo se llama «Tú» y gg se ve como «gg». */
class GgChatTest {
    private val me = UserDTO(id = "u1", name = "Danny Suárez")
    private val data = BootstrapDTO(me = me, people = listOf(PersonDTO(id = "u1", name = "Danny Suárez"), PersonDTO(id = "u2", name = "Ana Ruiz"),
        PersonDTO(id = Gg.ID, name = "asistente", kind = "agent")), assistantId = Gg.ID)

    @Test fun parsesActionsMessage() {
        val body = """{"k":"gg.actions","forUserId":"u1","actions":[{"id":"a1","kind":"create_issue","status":"pending","target":"Ventas","text":"Preparar precios","token":"t1"}],"suggestions":["Sí, hazlo","Mañana"],"nuevo":1}"""
        val g = Gg.parseActions(MessageDTO(kind = "system", body = body))!!
        assertEquals("u1", g.forUserId); assertEquals("t1", g.actions.single().token); assertEquals(listOf("Sí, hazlo", "Mañana"), g.suggestions)
        assertNull(Gg.parseActions(MessageDTO(kind = "text", body = body)))
        assertNull(Gg.parseActions(MessageDTO(kind = "system", body = """{"k":"mail.shared"}""")))
        assertNull(Gg.parseActions(MessageDTO(kind = "system", body = """{"k":"gg.actions","forUserId":""")))
    }

    @Test fun selfChatIsCalledYou() {
        val self = ConversationDTO(id = "c1", kind = "direct", memberIds = listOf("u1"))
        val withAna = ConversationDTO(id = "c2", kind = "direct", memberIds = listOf("u1", "u2"))
        assertTrue(Gg.isSelfChat(self, data)); assertFalse(Gg.isSelfChat(withAna, data))
        assertEquals("Tú", Names.conversationTitle(self, data, "Interno", "Conversación"))
        assertEquals("Ana Ruiz", Names.conversationTitle(withAna, data, "Interno", "Conversación"))
    }

    @Test fun ggIsAlwaysCalledGg() {
        assertEquals("gg", Names.person(data, Gg.ID)?.name)
        // Aunque no venga en people, un mensaje de gg lleva su nombre.
        assertEquals("gg", Names.person(data.copy(people = emptyList()), Gg.ID)?.name)
        val dm = ConversationDTO(id = "c3", kind = "direct", memberIds = listOf("u1", Gg.ID))
        assertEquals("gg", Names.conversationTitle(dm, data, "Interno", "Conversación"))
        assertTrue(Gg.isGg(Gg.ID)); assertFalse(Gg.isGg("u2"))
    }

    @Test fun systemTextHandlesGgActions() {
        val common = File("src/main/java/com/tiecoms/app/ui/Common.kt").readText()
        assertTrue(common.contains("if (str(\"k\") == \"gg.actions\")"))
        val es = File("src/main/res/values-es/strings_ggchat.xml").readText()
        assertTrue(es.contains("<string name=\"gg_for_other\">Para %1\$s</string>"))
    }

    /** @gg como palabra (ggRanges de la web): no en un correo ni en «@ggg». */
    @Test fun detectsGgMentions() {
        assertEquals(listOf(5 to 3), Gg.handRanges("hola @gg ayúdame"))
        assertEquals(listOf(0 to 3), Gg.handRanges("@GG, ¿qué opinas?"))
        assertEquals(listOf(1 to 3), Gg.handRanges("(@gg)"))
        assertEquals(listOf(0 to 3), Gg.handRanges("@gg."))
        assertTrue(Gg.handRanges("escríbele a ana@gg.com").isEmpty())
        assertTrue(Gg.handRanges("@ggg y @gg_bot").isEmpty())
        assertTrue(Gg.handRanges("x.@gg").isEmpty())
        assertEquals(2, Gg.handRanges("@gg y otra vez @gg").size)
        // Estructurada: la de gg; una escrita a mano encima de otra mención no se duplica.
        val text = "@gg mira esto, @Ana"
        val ms = listOf(MentionDTO(Gg.ID, 0, 3), MentionDTO("u2", 15, 4))
        assertEquals(listOf(MentionDTO(Gg.ID, 0, 3)), Gg.ggMentions(text, ms))
        assertEquals(listOf(MentionDTO(Gg.ID, 11, 3)), Gg.ggMentions("hola, mira @gg", emptyList()))
    }
}
