package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.time.Duration

/**
 * gg contra un API de pruebas real (con DeepSeek): borradores → Enviar todos → «márcalos todos como leídos».
 * Se omite si no hay cuenta:
 *   TIECOMS_GG_ACCOUNT=/ruta/cuenta.json (email, pw) TIECOMS_GG_API=http://localhost:3081 ./gradlew :app:testDebugUnitTest --tests '*LiveAssistantTest*'
 */
class LiveAssistantTest {
    private val account = System.getenv("TIECOMS_GG_ACCOUNT").orEmpty()
    private val api = System.getenv("TIECOMS_GG_API").orEmpty()

    @Test fun `pendientes, enviar todos y marcar leidos`() = runBlocking {
        assumeTrue("Sin TIECOMS_GG_ACCOUNT: se omite", account.isNotBlank() && File(account).exists() && api.isNotBlank())
        val fx = TcJson.parseToJsonElement(File(account).readText()).jsonObject
        val http = OkHttpClient.Builder().readTimeout(Duration.ofSeconds(90)).callTimeout(Duration.ofSeconds(120)).build()
        val c = TieComsClient(api, "gg-live", MemoryStorage(), MemorySecretStore(), http)
        try {
            c.login(fx["email"]!!.jsonPrimitive.content, fx["pw"]!!.jsonPrimitive.content)
            var turns = listOf(AssistantTurn("user", "Escríbele a Laura que confirmo la reunión de mañana y a Juan que hoy le mando la factura"))
            val out = c.assistantTurn(Assistant.history(turns), "America/Bogota", "es", aiConsent = true)
            println("gg> ${out.reply}\n  acciones: ${out.actions.map { "${it.kind}/${it.status} → ${it.target}: ${it.text}" }}\n  sugerencias: ${out.suggestions}")
            val drafts = out.actions.filter { it.status == "pending" && it.kind == "send_message" }
            assertTrue("gg dejó borradores", drafts.isNotEmpty())
            turns = turns + AssistantTurn("assistant", out.reply, out.actions, suggestions = out.suggestions)
            // «Enviar todos (N)» / «envíalos»: se confirma cada token en el dispositivo.
            assertTrue(Assistant.isSendAll("envíalos"))
            for (d in Assistant.pending(turns)) {
                val done = c.assistantRun(d.token!!)
                println("run> ${done.kind}/${done.status} → ${done.target} link=${done.link} undo=${done.undoToken != null}")
                assertEquals("done", done.status)
                turns = Assistant.patch(turns, d.id) { copy(status = "done", token = null, undoToken = done.undoToken, link = done.link) }
            }
            assertTrue(Assistant.pending(turns).isEmpty())
            turns = turns + AssistantTurn("user", "márcalos todos como leídos")
            val read = c.assistantTurn(Assistant.history(turns), "America/Bogota", "es", aiConsent = true)
            println("gg> ${read.reply}\n  acciones: ${read.actions.map { "${it.kind}/${it.status} → ${it.target}: ${it.text} undo=${it.undoToken != null}" }}")
            assertTrue(read.reply.isNotBlank())
        } finally { c.close() }
    }
}
