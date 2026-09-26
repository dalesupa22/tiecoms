package com.tiecoms.app.core

import com.tiecoms.app.ui.sideAnchor
import com.tiecoms.app.ui.sideSuggestions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SPEC-v4 §G Sidechats: sugerencias, tarjeta del ancla, nombres, push TC_SIDE y enlace ?side=. */
class SidechatTest {
    private val d = TcJson.decodeFromString(BootstrapDTO.serializer(), """
        {"me":{"id":"me"},"organizations":[{"id":"mine","name":"Mía","myRole":"admin"},{"id":"acme","name":"Acme"}],
         "conversations":[{"id":"g","kind":"group","memberIds":["me","ana","beto","otro"]},
                          {"id":"s","kind":"multi","name":"Consulta · ¿quién aprueba?","parentId":"g","parentMessageId":"m1","parentMessageSeq":4,"deriveKind":"side","memberIds":["me","ana"]}],
         "people":[{"id":"ana","name":"Ana Torres","orgId":"acme"},{"id":"beto","name":"Beto Ruiz","orgId":"acme"},
                   {"id":"lau","name":"Laura Gómez","orgId":"mine"},{"id":"otro","name":"Otro Externo","orgId":"acme"},{"id":"ext","name":"Fuera","orgId":"acme"}]}""")

    @Test fun `sugerencias - autor, mencionados y quienes mas escriben, solo candidatos`() {
        val anchor = MessageDTO(id = "m1", conversationId = "g", authorId = "ana", body = "@Laura ¿lo revisas?", mentions = listOf(MentionDTO("lau", 0, 6), MentionDTO("all", 0, 1)))
        val recent = listOf("beto", "otro", "otro", "otro", "me", "ext").mapIndexed { i, a -> MessageDTO(id = "r$i", authorId = a, body = "x") }
        val ids = sideSuggestions(d, d.conversations[0], anchor, recent).map { it.id }
        assertEquals(listOf("ana", "lau", "otro", "beto"), ids) // «ext» no está en el chat ni es de mi empresa
    }

    @Test fun `tarjeta del ancla desde el mensaje o desde side_started`() {
        val side = d.conversations[1]
        val sys = MessageDTO(id = "x", kind = "system", body = """{"k":"side.started","excerpt":"¿quién aprueba?","authorName":"Ana Torres","parentName":null,"messageId":"m1"}""")
        val a = sideAnchor(d, side, null, listOf(sys))!!
        assertEquals("Ana Torres", a.authorName); assertEquals("¿quién aprueba?", a.text); assertEquals(4L, a.seq); assertNull(a.authorId)
        val b = sideAnchor(d, side, MessageDTO(id = "m1", authorId = "ana", body = "texto completo", seq = 4, createdAt = "2026-09-25T10:00:00Z"), emptyList())!!
        assertEquals("ana", b.authorId); assertEquals("texto completo", b.text)
        assertNull(sideAnchor(d, side, null, emptyList()))
    }

    @Test fun `nombres viejos Consulta se muestran como Sidechat`() {
        val l = Names.Labels(sideName = "Sidechat · %1\$s")
        assertEquals("Sidechat · ¿quién aprueba?", Names.conversationTitle(d.conversations[1], d, "Interno", "Conv", l))
        assertEquals("Sidechat · x", Names.sideName("Sidechat · x", l))
        assertEquals("Otro nombre", Names.sideName("Otro nombre", l))
    }

    @Test fun `push TC_SIDE plano y con sideOf en JSON`() {
        val p = PushPayload.parse(mapOf("type" to "side", "category" to "TC_SIDE", "title" to "💬 Sidechat de Ana", "subtitle" to "Sobre: «¿quién aprueba?»",
            "body" to "¿Lo apruebas tú?", "conversationId" to "s", "messageId" to "m9", "authorId" to "ana", "authorName" to "Ana",
            "sideOfConversationId" to "g", "sideOfMessageId" to "m1", "sideOfExcerpt" to "¿quién aprueba?"))!!
        assertEquals("side", p.type); assertEquals("TC_SIDE", p.category); assertEquals("g", p.sideOfConversationId); assertEquals("m1", p.sideOfMessageId)
        val q = PushPayload.parse(mapOf("type" to "side", "conversationId" to "s", "sideOf" to """{"conversationId":"g","messageId":"m1","excerpt":"hola"}"""))!!
        assertEquals("g", q.sideOfConversationId); assertEquals("hola", q.sideOfExcerpt); assertEquals("TC_SIDE", q.category)
        assertEquals("mention", PushPayload.parse(mapOf("type" to "mention", "conversationId" to "c"))!!.type)
    }

    @Test fun `enlace al origen con el sidechat desplegado`() {
        val l = DeepLinks.parse("chaggu://c/g?side=s") as DeepLink.Conversation
        assertEquals("g", l.id); assertEquals("s", l.side)
        assertNull((DeepLinks.parse("chaggu://c/g?side=../x") as DeepLink.Conversation).side)
        assertTrue((DeepLinks.parse("https://app.tiecoms.com/c/g?m=5&side=s") as DeepLink.Conversation).let { it.seq == 5L && it.side == "s" })
    }
}
