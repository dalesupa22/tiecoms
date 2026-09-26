package com.tiecoms.app.core

import kotlinx.coroutines.delay
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
import java.util.UUID
import java.util.concurrent.TimeUnit

/** SPEC-v4 §G contra 3043 (mobile-feedback 7089994 / f222d74): sidechat, respuesta, resumen sugerido y «Llevar al hilo». */
class LiveSidechatTest {
    private val fxPath = System.getenv("TIECOMS_FIXTURE").orEmpty()
    private fun log(step: String, detail: String) = println("[v5] $step: $detail")
    private val ok = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
    private suspend fun until(ms: Long, what: String, cond: () -> Boolean): Long {
        val t0 = System.currentTimeMillis()
        try { withTimeout(ms) { while (!cond()) delay(50) } } catch (e: Exception) { throw AssertionError("No ocurrió en $ms ms: $what") }
        return System.currentTimeMillis() - t0
    }

    @Test
    fun sidechatEnVivo() = runBlocking {
        assumeTrue("Sin TIECOMS_FIXTURE: se omite", fxPath.isNotBlank() && File(fxPath).exists())
        val fx = TcJson.parseToJsonElement(File(fxPath).readText()).jsonObject
        val api = fx["apiUrl"]!!.jsonPrimitive.content
        assertFalse((api.contains("app.tiecoms.com") || api.contains("app.chaggu.com")))
        val password = fx["password"]!!.jsonPrimitive.content
        val group = fx["conversationId"]!!.jsonPrimitive.content
        val a = TieComsClient(api, "JVM A", MemoryStorage(), MemorySecretStore(), ok)
        val b = TieComsClient(api, "JVM B", MemoryStorage(), MemorySecretStore(), ok)
        val tag = UUID.randomUUID().toString().take(6)
        try {
            a.login((fx["a"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            b.login((fx["b"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            until(10_000, "sockets") { a.state.value.connection == ConnectionStatus.ONLINE && b.state.value.connection == ConnectionStatus.ONLINE }
            a.openConversation(group); b.openConversation(group)
            val body = "¿Quién firma el anexo? $tag"
            b.send(group, body)
            until(10_000, "A ve el ancla") { a.state.value.conversations[group]!!.messages.any { it.body == body } }
            val anchor = a.state.value.conversations[group]!!.messages.first { it.body == body }
            val sideId = a.startSide(group, anchor.id, listOf(b.myId!!), "¿Lo firmas tú? $tag")
            val side = a.meta(sideId)!!
            log("iniciar", "sidechat «${Names.conversationTitle(side, a.state.value.data, "", "")}» con la pregunta; kind=${side.kind}")
            b.loadBootstrap(); b.openConversation(sideId)
            b.send(sideId, "Sí, lo firmo el jueves $tag")
            a.openConversation(sideId)
            until(10_000, "A recibe la respuesta") { a.state.value.conversations[sideId]!!.messages.any { it.body.startsWith("Sí, lo firmo") } }
            a.loadBootstrap()
            val chipN = (a.meta(sideId)!!.lastMessageSeq - 1).toInt()
            log("chip-hilo", "lastMessageSeq=${a.meta(sideId)!!.lastMessageSeq} → «$chipN mensajes»")
            val t0 = System.currentTimeMillis()
            val sug = a.suggestReturn(sideId)
            log("resumen sugerido", "source=${sug.source} en ${System.currentTimeMillis() - t0} ms: «${sug.summary}»")
            assertTrue(sug.summary.isNotBlank()); assertTrue(sug.source in setOf("ai", "fallback"))
            val r = a.returnResult(sideId, sug.summary)
            assertEquals(group, r.parentId)
            until(10_000, "B ve el resultado en el hilo") { b.state.value.conversations[group]!!.messages.any { it.mergedFrom == sideId } }
            val merged = b.state.value.conversations[group]!!.messages.first { it.mergedFrom == sideId }
            log("llevar al hilo", "mensaje en el grupo con mergedKind=${merged.mergedKind}")
            assertEquals("side", merged.mergedKind)
        } finally { runCatching { a.logout() }; runCatching { b.logout() } }
    }
}
