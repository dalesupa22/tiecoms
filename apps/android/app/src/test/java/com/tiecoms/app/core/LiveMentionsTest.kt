package com.tiecoms.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.Collections
import java.util.UUID
import java.util.concurrent.TimeUnit

/** SPEC-v4 §H contra 3043 (mobile-feedback c956a26): enviar/editar con menciones, descartes, @todos, unreadMentions y bandeja. */
class LiveMentionsTest {
    private val fxPath = System.getenv("TIECOMS_FIXTURE").orEmpty()
    private fun log(step: String, detail: String) = println("[v6] $step: $detail")
    private val ok = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()
    private suspend fun until(ms: Long, what: String, cond: () -> Boolean): Long {
        val t0 = System.currentTimeMillis()
        try { withTimeout(ms) { while (!cond()) delay(50) } } catch (e: Exception) { throw AssertionError("No ocurrió en $ms ms: $what") }
        return System.currentTimeMillis() - t0
    }

    @Test
    fun mencionesEnVivo() = runBlocking {
        assumeTrue("Sin TIECOMS_FIXTURE: se omite", fxPath.isNotBlank() && File(fxPath).exists())
        val fx = TcJson.parseToJsonElement(File(fxPath).readText()).jsonObject
        val api = fx["apiUrl"]!!.jsonPrimitive.content
        assertFalse(api.contains("app.tiecoms.com"))
        val password = fx["password"]!!.jsonPrimitive.content
        val group = fx["conversationId"]!!.jsonPrimitive.content
        val a = TieComsClient(api, "JVM A", MemoryStorage(), MemorySecretStore(), ok)
        val b = TieComsClient(api, "JVM B", MemoryStorage(), MemorySecretStore(), ok)
        val sigA = Collections.synchronizedList(mutableListOf<ClientSignal>())
        val sigB = Collections.synchronizedList(mutableListOf<ClientSignal>())
        val bg = CoroutineScope(Dispatchers.Default)
        bg.launch { a.signals.collect { sigA += it } }; bg.launch { b.signals.collect { sigB += it } }
        val tag = UUID.randomUUID().toString().take(5)
        try {
            a.login((fx["a"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            b.login((fx["b"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            until(10_000, "sockets") { a.state.value.connection == ConnectionStatus.ONLINE && b.state.value.connection == ConnectionStatus.ONLINE }
            a.openConversation(group); b.loadBootstrap()
            val bId = b.myId!!; val bName = Names.person(a.state.value.data, bId)!!.name
            val before = b.meta(group)!!.unreadMentions

            // 1. Emoji y tildes antes de la mención; espacios a los lados (el servidor recorta).
            val prefix = "  👋🏽 Qué tal, "
            val (text, ments, _) = Mentions.insert(prefix + "@be", emptyList(), prefix.length, prefix.length + 3, bName, bId)
            val body = "$text¿lo revisas? $tag  "
            a.send(group, body, mentions = ments)
            until(10_000, "el mensaje con mención llega a B") { sigB.any { it is ClientSignal.Incoming && it.message.body.contains(tag) } }
            val got = (sigB.first { it is ClientSignal.Incoming && it.message.body.contains(tag) } as ClientSignal.Incoming).message
            assertEquals(1, got.mentions.size)
            val m = got.mentions[0]
            assertEquals(bId, m.userId); assertEquals("@$bName", got.body.substring(m.start, m.start + m.length))
            log("enviar", "body recortado «${got.body}», mención [${m.start},${m.length}) = «${got.body.substring(m.start, m.start + m.length)}» (emoji = 4 unidades UTF-16)")
            assertTrue(Mentions.mentionsMe(got, bId))
            val um = b.loadBootstrap().conversations.first { it.id == group }.unreadMentions
            log("unreadMentions", "B: $before → $um")
            assertEquals(before + 1, um)

            // 2. Bandeja de B.
            val inbox = b.loadMentions()
            assertTrue(inbox.mentions.any { it.message.id == got.id && !it.read })
            log("bandeja", "${inbox.mentions.size} menciones, la nueva sin leer; hasMore=${inbox.hasMore}")

            // 3. Mención a alguien que no está → droppedMentions (sin error), y @todos en el grupo.
            val ghost = UUID.randomUUID().toString()
            val t2 = "@Fantasma y @todos mañana $tag"
            a.send(group, t2, mentions = listOf(MentionDTO(ghost, 0, 9), MentionDTO(Mentions.ALL, 12, 6)))
            until(10_000, "A recibe droppedMentions") { sigA.any { it is ClientSignal.MentionsDropped && it.userIds.contains(ghost) } }
            until(10_000, "B recibe el @todos") { sigB.any { it is ClientSignal.Incoming && it.message.body == t2.trim() } }
            val all = (sigB.first { it is ClientSignal.Incoming && it.message.body == t2.trim() } as ClientSignal.Incoming).message
            assertEquals(listOf(Mentions.ALL), all.mentions.map { it.userId })
            log("descartes y @todos", "droppedMentions=[fantasma]; B recibe solo @todos, que cuenta como mención")

            // 4. Editar conservando la mención; leer la conversación limpia unreadMentions.
            val mine = a.state.value.conversations[group]!!.messages.first { it.id == got.id }
            val edited = a.editMessage(mine.id, mine.body + " (editado)", mine.mentions)
            assertEquals(mine.mentions, edited.mentions)
            b.openConversation(group); b.markConversationRead(group)
            val after = b.loadBootstrap().conversations.first { it.id == group }.unreadMentions
            assertEquals(0, after)
            log("editar y leer", "la edición conserva la mención; tras leer, unreadMentions=0")

            // 5. @todos en un directo se descarta.
            val direct = a.createChat(listOf(bId), null).id
            a.openConversation(direct)
            a.send(direct, "@todos hola $tag", mentions = listOf(MentionDTO(Mentions.ALL, 0, 6)))
            until(10_000, "@todos en directo descartado") { sigA.any { it is ClientSignal.MentionsDropped && it.conversationId == direct && it.userIds.contains(Mentions.ALL) } }
            log("directo", "@todos en un directo → droppedMentions [all]")
        } finally { bg.cancel(); runCatching { a.logout() }; runCatching { b.logout() } }
    }
}
