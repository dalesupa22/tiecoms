package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** 1.6.8 (docs/LLAMADAS.md): transcripción con Groq por pedazos, agregar personas y push de llamada entrante. */
class CallsGroqTest {
    @Test fun `CallDTO con invitados y nombres`() {
        val c = TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k1","conversationId":"c1","activeUserIds":["u2"],"invitedUserIds":["u9"],"names":{"u9":"Zoe Ext","u2":"Beto"}}""")
        assertEquals(listOf("u9"), c.invitedUserIds); assertEquals("Zoe Ext", c.names["u9"])
        val old = TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k1","invitedUserIds":null,"names":null}""")
        assertTrue(old.invitedUserIds.isEmpty()); assertTrue(old.names.isEmpty())
        assertEquals("Zoe", Calls.firstName(null, c, "u9"))      // no está en mi lista: de call.names
        assertEquals("Beto", Calls.firstName("Beto Ruiz", c, "u2"))
        assertEquals("", Calls.firstName(null, c, "u7"))
    }

    @Test fun `eventos de cuenta call updated, processing y transcript`() {
        fun acc(j: String) = decodeAccountEvent(TcJson.parseToJsonElement(j))
        val u = acc("""{"type":"call.updated","call":{"id":"k1","conversationId":"c9","activeUserIds":["u2"]}}""") as AccountEvent.CallUpdated
        assertEquals("c9", u.call.conversationId)
        assertTrue(acc("""{"type":"call.updated","call":{"id":"k1"}}""") is AccountEvent.Unknown)
        val p = (acc("""{"type":"call.processing","callId":"k1","userId":"u2","segId":"s1"}""") as AccountEvent.CallCaption).event
        assertTrue(p.processing); assertEquals("s1", p.segId)
        val t = (acc("""{"type":"call.transcript","callId":"k1","userId":"u2","segId":"s1","segments":[{"resultId":"r1","speakerUserId":"u2","text":"hola","startMs":0,"endMs":900}]}""") as AccountEvent.CallCaption).event
        assertFalse(t.processing); assertEquals("hola", t.segments.single().text); assertFalse(t.failed)
        assertTrue((acc("""{"type":"call.transcript","callId":"k1","userId":"u2","segId":"s2","segments":[],"failed":true}""") as AccountEvent.CallCaption).event.failed)
        assertTrue(acc("""{"type":"call.processing","callId":"k1"}""") is AccountEvent.Unknown) // sin segId
    }

    @Test fun `procesando y luego las frases`() {
        var caps = Calls.applyCaptionEvent(emptyList(), CallCaptionEvent("k1", "u2", "s1", processing = true))
        assertTrue(caps.single().processing); assertEquals("u2", caps.single().userId)
        caps = Calls.applyCaptionEvent(caps, CallCaptionEvent("k1", "u2", "s1", processing = false, segments = listOf(
            CallTranscriptSegmentDTO("r1", "u2", "Beto", "es", "hola", 0, 900), CallTranscriptSegmentDTO("r2", null, null, "es", "¿cómo vas?", 900, 1800))))
        assertEquals(listOf("hola", "¿cómo vas?"), caps.map { it.text }); assertTrue(caps.none { it.processing })
        assertEquals("u2", caps[1].userId) // sin speaker: quien mandó el pedazo
        // Falló o no hubo frases: el «Procesando…» se quita.
        val failed = Calls.applyCaptionEvent(Calls.applyCaptionEvent(emptyList(), CallCaptionEvent("k1", "u3", "s9", true)), CallCaptionEvent("k1", "u3", "s9", false, failed = true))
        assertTrue(failed.isEmpty())
        repeat(12) { caps = Calls.applyCaptionEvent(caps, CallCaptionEvent("k1", "u2", "x$it", true)) }
        assertEquals(Calls.MAX_CAPTIONS_GROQ, caps.size)
    }

    @Test fun `pedazos de 12 a 20 s con voz`() {
        assertFalse(Calls.shouldCut(5_000, 5_000))       // antes de 12 s no corta aunque haya silencio
        assertFalse(Calls.shouldCut(13_000, 200))        // hablando
        assertTrue(Calls.shouldCut(13_000, 800))         // primer silencio después de 12 s
        assertTrue(Calls.shouldCut(20_000, 0))           // tope de 20 s
        assertFalse(Calls.worthSending(700)); assertTrue(Calls.worthSending(800))
        assertEquals(0.0, Calls.rms(ShortArray(160)), 1e-9)
        val loud = ShortArray(160) { if (it % 2 == 0) 3000 else -3000 }
        assertTrue(Calls.rms(loud) > Calls.VOICE_RMS)
        assertTrue(Calls.rms(ShortArray(160) { 100 }) < Calls.VOICE_RMS)
        assertEquals(0.0, Calls.rms(loud, 0), 1e-9)
    }

    @Test fun `a quien puedo agregar`() {
        val people = listOf(PersonDTO("u1", "Ana"), PersonDTO("u2", "Beto"), PersonDTO("u3", "Carla"), PersonDTO("u4", "Dario"), PersonDTO("bot", "gg", kind = "agent"))
        val call = CallDTO(id = "k1", activeUserIds = listOf("u1", "u2"), invitedUserIds = listOf("u3"))
        assertEquals(listOf("u4"), Calls.addable(people, call, "u1").map { it.id })
        assertEquals(emptyList<String>(), Calls.addable(people, call, "u1", "zz").map { it.id })
        assertEquals(listOf("u4"), Calls.addable(people, call.copy(invitedUserIds = emptyList()), "u1", "dar").map { it.id })
    }

    @Test fun `push de llamada entrante y enlace para contestar`() {
        val p = PushPayload.parse(mapOf("type" to "call", "callId" to "k1", "conversationId" to "c1", "kind" to "video", "title" to "Beto", "body" to "📞 Te está llamando", "category" to "TC_CALL"))!!
        assertEquals("call", p.type); assertEquals("k1", p.callId); assertEquals("video", p.kind); assertEquals("TC_CALL", p.category); assertEquals("Beto", p.title)
        assertEquals("TC_CALL", PushPayload.parse(mapOf("type" to "call", "callId" to "k1", "conversationId" to "c1"))!!.category)
        assertNull(PushPayload.parse(mapOf("type" to "call", "conversationId" to "c1"))) // sin callId
        assertEquals(DeepLink.CallJoin("k1"), DeepLinks.parse("chaggu://call/k1"))
        assertEquals(DeepLink.CallJoin("k1", camera = true), DeepLinks.parse("chaggu://call/k1?camera=1"))
    }

    // ---------- API ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, ByteArray>>()
    private lateinit var client: TieComsClient
    @Volatile private var audioCode = 200

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val bytes = request.body.readByteArray()
                requests += request to bytes
                val body = when (request.path!!.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana"},"features":{"calls":true},"conversations":[]}"""
                    "/api/v1/calls/k1/invite" -> """{"call":{"id":"k1","conversationId":"c1","activeUserIds":["u1"],"invitedUserIds":${TcJson.parseToJsonElement(String(bytes)).jsonObject["userIds"]}}}"""
                    "/api/v1/calls/k1/audio" -> if (audioCode == 200) """{"saved":1,"segments":[{"resultId":"r1","text":"hola"}]}""" else return MockResponse().setResponseCode(audioCode).setBody("""{"error":{"code":"internal","message":"x"}}""")
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { client.login("ana@acme.co", "x") }
    }
    @After fun tearDown() { client.close(); server.shutdown() }

    @Test fun `invitar y subir un pedazo de audio`() = runBlocking {
        val c = client.inviteToCall("k1", listOf("u7", "u8"))!!
        assertEquals(listOf("u7", "u8"), c.invitedUserIds)
        assertEquals("k1", client.state.value.calls["c1"]?.id)
        val audio = byteArrayOf(0, 0, 0, 24, 102, 116, 121, 112)
        assertEquals("hola", client.sendCallAudio("k1", audio, "audio/mp4", "seg-1", 12_345, 15_000).segments.single().text)
        val (req, sent) = requests.last { it.first.path == "/api/v1/calls/k1/audio" }
        assertTrue(audio.contentEquals(sent))
        assertEquals("application/octet-stream", req.getHeader("content-type")?.substringBefore(';'))
        assertEquals("audio/mp4", req.getHeader("x-file-type")); assertEquals("seg-1", req.getHeader("x-seg-id"))
        assertEquals("12345", req.getHeader("x-offset-ms")); assertEquals("15000", req.getHeader("x-duration-ms"))
        audioCode = 503
        val e = runCatching { client.sendCallAudio("k1", audio, "audio/mp4", "seg-2", -5, 1) }.exceptionOrNull()!!
        assertTrue(Calls.retryBatch(e)) // 5xx: un reintento con el mismo segId
        assertEquals("0", requests.last().first.getHeader("x-offset-ms"))
    }
}
