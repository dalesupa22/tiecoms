package com.tiecoms.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.util.Collections
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * SPEC-v4 §E (asuntos, reuniones y recordatorios en directos, aviso 10 min antes) y §F (notas de voz) contra 3043
 * (mobile-feedback 1fa4c21 / cbeebe7). Se omite sin fixture: TIECOMS_FIXTURE=/ruta/fx4.json … --tests '*LiveV4ChatsVoice*'
 */
class LiveV4ChatsVoiceTest {
    private val fxPath = System.getenv("TIECOMS_FIXTURE").orEmpty()
    private fun log(step: String, detail: String) = println("[v4ef] $step: $detail")
    private val ok = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()

    private suspend fun until(ms: Long, what: String, cond: () -> Boolean): Long {
        val t0 = System.currentTimeMillis()
        try { withTimeout(ms) { while (!cond()) delay(50) } } catch (e: Exception) { throw AssertionError("No ocurrió en $ms ms: $what") }
        return System.currentTimeMillis() - t0
    }

    @Test
    fun chatsYNotasDeVozEnVivo() = runBlocking {
        assumeTrue("Sin TIECOMS_FIXTURE: se omite", fxPath.isNotBlank() && File(fxPath).exists())
        val fx = TcJson.parseToJsonElement(File(fxPath).readText()).jsonObject
        val api = fx["apiUrl"]!!.jsonPrimitive.content
        assertFalse("Nunca contra producción", (api.contains("app.tiecoms.com") || api.contains("app.chaggu.com")))
        val password = fx["password"]!!.jsonPrimitive.content
        val a = TieComsClient(api, "JVM A", MemoryStorage(), MemorySecretStore(), ok)
        val b = TieComsClient(api, "JVM B (par)", MemoryStorage(), MemorySecretStore(), ok)
        val sigA = Collections.synchronizedList(mutableListOf<ClientSignal>())
        val bg = CoroutineScope(Dispatchers.Default)
        bg.launch { a.signals.collect { sigA += it } }
        val tag = UUID.randomUUID().toString().take(6)
        try {
            a.login((fx["a"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            b.login((fx["b"] as JsonObject)["email"]!!.jsonPrimitive.content, password)
            until(10_000, "sockets en vivo") { a.state.value.connection == ConnectionStatus.ONLINE && b.state.value.connection == ConnectionStatus.ONLINE }
            val bId = b.myId!!
            val direct = a.createChat(listOf(bId), null).id
            a.openConversation(direct); b.loadBootstrap(); b.openConversation(direct)

            // §E Asunto en un directo: sin espacio, con responsable B; B lo ve en su lista y openIssues cuenta.
            val issue = a.createIssue(direct, "Revisar contrato $tag", bId, null, null)
            assertNull(issue.workspaceId)
            val mine = b.loadIssues(mine = true)
            assertTrue("B ve el asunto del directo", mine.any { it.id == issue.id })
            b.loadBootstrap(); assertEquals(1, b.meta(direct)!!.openIssues)
            log("asunto en directo", "workspaceId=null, B lo ve en «Míos», openIssues=1")

            // §E Reunión en el directo que empieza en ~9 min → aviso «event.soon» (10 min antes) para A.
            val start = Instant.now().plusSeconds(9 * 60 + 30); val end = start.plusSeconds(1800)
            val ev = a.createEvent(direct, buildJsonObject {
                put("title", JsonPrimitive("Llamada $tag")); put("startsAt", JsonPrimitive(start.toString())); put("endsAt", JsonPrimitive(end.toString()))
                put("timezone", JsonPrimitive("America/Bogota")); put("inviteeIds", JsonArray(listOf(JsonPrimitive(bId))))
            })
            assertNull(ev.workspaceId)
            val dt = until(150_000, "A recibe event.soon") { sigA.any { it is ClientSignal.EventSoon && it.event.id == ev.id } }
            val soon = sigA.first { it is ClientSignal.EventSoon && it.event.id == ev.id } as ClientSignal.EventSoon
            assertEquals(10, soon.minutes)
            log("aviso 10 min", "reunión en directo (workspaceId=null) → event.soon minutes=${soon.minutes} en $dt ms")

            // §E Recordatorio en el directo: vence y llega reminder.due.
            val rem = a.createReminder(direct, null, "Llamar a Beto $tag", Instant.now().plusSeconds(3))
            val dr = until(120_000, "A recibe reminder.due") { sigA.any { it is ClientSignal.ReminderDue && it.reminder.id == rem.id } }
            log("recordatorio en directo", "reminder.due en $dr ms")

            // §F Nota de voz: m4a AAC real, cabeceras de voz, envío solo-adjunto; B la recibe y la descarga.
            val m4a = javaClass.classLoader!!.getResourceAsStream("voice-test.m4a")!!.use { it.readBytes() }
            val f = File.createTempFile("tcv4", ".m4a").apply { writeBytes(m4a); deleteOnExit() }
            val wave = Waveform.downsample(List(40) { i -> ((i % 8) / 8f) })
            val v = a.uploadAttachment(direct, f, "Nota de voz.m4a", "audio/mp4", voice = TieComsClient.Voice(3_100, wave))
            assertEquals("voice", v.kind); assertEquals(3_100L, v.durationMs); assertEquals(wave.size, v.waveform?.size)
            log("voz subir", "kind=${v.kind} ${v.contentType} ${v.sizeBytes} B, ${v.durationMs} ms, onda ${v.waveform?.size} barras, transcript=${v.transcript}")
            a.send(direct, "", attachments = listOf(v))
            until(10_000, "B recibe la nota de voz") { b.state.value.conversations[direct]?.messages?.any { m -> m.attachments.any { it.id == v.id } } == true }
            val got = b.state.value.conversations[direct]!!.messages.first { m -> m.attachments.any { it.id == v.id } }.attachments.first()
            assertTrue(got.isVoice); assertNotNull(got.transcript)
            assertTrue("pending, disabled o done: ${got.transcript?.status}", got.transcript!!.status in setOf("pending", "disabled", "done", "failed"))
            val out = File.createTempFile("tcv4", "dl").apply { deleteOnExit() }
            b.downloadAttachment(got.url, out)
            assertArrayEquals(m4a, out.readBytes())
            log("voz recibir", "B la recibe (transcript.status=${got.transcript?.status}) y descarga ${out.length()} B idénticos")
            val boot = b.loadBootstrap().conversations.first { it.id == direct }
            log("voz vista previa", "lastMessagePreview=«${boot.lastMessagePreview}» · resumen=${boot.lastHumanPreview?.attachments}")
            assertEquals(1, boot.lastHumanPreview?.attachments?.voices)
            // Reintento: sin llave de Inworld → 503 transcription_disabled.
            val retry = runCatching { a.retranscribe(v.id) }
            log("voz reintento", retry.fold({ "→ ${it.transcript?.status}" }, { e -> "→ ${(e as? ApiException)?.status} ${(e as? ApiException)?.code}" }))
            if (got.transcript?.status == "disabled") assertEquals("transcription_disabled", (retry.exceptionOrNull() as? ApiException)?.code)
        } finally {
            bg.cancel()
            runCatching { a.logout() }; runCatching { b.logout() }
        }
    }
}
