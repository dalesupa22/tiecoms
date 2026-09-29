package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** Llamadas (docs/LLAMADAS.md): DTOs y eventos nuevos, textos de sistema call.*, reglas de la pantalla y la API, sin servidor real. */
class CallsTest {
    private val callJson = """{"id":"k1","conversationId":"c1","kind":"video","startedBy":"u2","startedAt":"2026-09-29T01:00:00Z","endedAt":null,
        "activeUserIds":["u2","u1"],"transcribing":true,"hasTranscript":false,"futuro":1}"""

    // ---------- Decodificación ----------
    @Test fun `CallDTO completo, con faltantes y con valores nuevos`() {
        val c = TcJson.decodeFromString(CallDTO.serializer(), callJson)
        assertEquals("k1", c.id); assertTrue(c.isVideo); assertFalse(c.ended); assertEquals(listOf("u2", "u1"), c.activeUserIds); assertTrue(c.transcribing)
        val bare = TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k2","kind":"hologram","activeUserIds":null,"transcribing":null}""")
        assertFalse(bare.isVideo); assertEquals(emptyList<String>(), bare.activeUserIds); assertFalse(bare.transcribing); assertFalse(bare.hasTranscript)
        assertTrue(TcJson.decodeFromString(CallDTO.serializer(), """{"id":"k3","endedAt":"2026-09-29T01:05:00Z"}""").ended)
    }

    @Test fun `CallJoinDTO se pasa al SDK tal cual`() {
        val j = TcJson.decodeFromString(CallJoinDTO.serializer(), """{"call":$callJson,
            "meeting":{"Meeting":{"MeetingId":"m-1","ExternalMeetingId":"k1","MediaRegion":"us-east-1","MediaPlacement":{"AudioHostUrl":"a.chime:3478",
              "AudioFallbackUrl":"wss://fb","SignalingUrl":"wss://sig","TurnControlUrl":"https://turn","EventIngestionUrl":"https://ev","ScreenDataUrl":"x"},"MeetingFeatures":{"Audio":{"EchoReduction":"AVAILABLE"}}}},
            "attendee":{"Attendee":{"AttendeeId":"a-1","ExternalUserId":"u1","JoinToken":"tok"}}}""")
        assertEquals("k1", j.call.id)
        val info = ChimeJoin.parse(j.meeting, j.attendee)!!
        assertEquals("m-1", info.meetingId); assertEquals("k1", info.externalMeetingId); assertEquals("us-east-1", info.mediaRegion)
        assertEquals("a.chime:3478", info.audioHostUrl); assertEquals("wss://fb", info.audioFallbackUrl); assertEquals("wss://sig", info.signalingUrl)
        assertEquals("https://turn", info.turnControlUrl); assertEquals("https://ev", info.eventIngestionUrl)
        assertEquals("a-1", info.attendeeId); assertEquals("u1", info.externalUserId); assertEquals("tok", info.joinToken)
        assertFalse(info.isFake)
    }

    @Test fun `proveedor falso y datos incompletos`() {
        // Lo que manda CALLS_PROVIDER=fake (apps/api/src/modules/calls.ts FakeProvider): sin AudioFallbackUrl ni EventIngestionUrl.
        val meeting = TcJson.parseToJsonElement("""{"Meeting":{"MeetingId":"fake-k1","ExternalMeetingId":"k1","MediaRegion":"us-east-1",
            "MediaPlacement":{"AudioHostUrl":"fake.invalid:3478","SignalingUrl":"wss://fake.invalid/control","TurnControlUrl":"https://fake.invalid/turn"}}}""").jsonObject
        val attendee = TcJson.parseToJsonElement("""{"Attendee":{"AttendeeId":"att-1","ExternalUserId":"u1","JoinToken":"tok-1"}}""").jsonObject
        val fake = ChimeJoin.parse(meeting, attendee)!!
        assertTrue(fake.isFake); assertEquals("", fake.audioFallbackUrl); assertNull(fake.eventIngestionUrl)
        assertNull(ChimeJoin.parse(JsonObject(emptyMap()), attendee))
        assertNull(ChimeJoin.parse(meeting, TcJson.parseToJsonElement("""{"Attendee":{"AttendeeId":"a"}}""").jsonObject)) // sin JoinToken
        // Una respuesta sin meeting ni attendee se decodifica igual (y no conecta el SDK).
        val empty = TcJson.decodeFromString(CallJoinDTO.serializer(), """{"call":{"id":"k9"}}""")
        assertNull(ChimeJoin.parse(empty.meeting, empty.attendee))
    }

    @Test fun `historial, transcripcion y compartir`() {
        val page = TcJson.decodeFromString(CallHistoryPage.serializer(), """{"calls":[
            {"call":$callJson,"participantIds":["u2","u1"],"durationSec":83,"hasSummary":true},
            {"call":{"id":"k2","conversationId":"c2","endedAt":"2026-09-28T00:00:00Z"},"participantIds":["u1"],"durationSec":null}],"hasMore":true}""")
        assertTrue(page.hasMore); assertEquals(2, page.calls.size)
        assertEquals(83L, page.calls[0].durationSec); assertTrue(page.calls[0].hasSummary); assertNull(page.calls[1].durationSec)
        val t = TcJson.decodeFromString(CallTranscriptDTO.serializer(), """{"call":{"id":"k1"},"summary":null,"segments":[
            {"resultId":"r1","speakerUserId":"u2","speakerName":"Beto","language":"es-US","text":"hola","startMs":1500,"endMs":2500},
            {"resultId":"r2","speakerUserId":null,"speakerName":null,"text":"chao","startMs":65000,"endMs":66000,"x":1}]}""")
        assertNull(t.summary); assertEquals(2, t.segments.size); assertNull(t.segments[1].speakerName)
        assertEquals(listOf("transcript"), Calls.shareOptions(t))
        assertEquals(listOf("summary", "transcript", "both"), Calls.shareOptions(t.copy(summary = "Acordaron el precio")))
        assertEquals(emptyList<String>(), Calls.shareOptions(t.copy(segments = emptyList(), summary = "  ")))
        val text = Calls.asText(t.copy(summary = "S"), "both", "Resumen", "Transcripción") { it.speakerName ?: "?" }
        assertEquals("Resumen:\nS\n\nTranscripción:\n[0:01] Beto: hola\n[1:05] ?: chao", text)
        assertEquals("Resumen:\nS", Calls.asText(t.copy(summary = "S"), "summary", "Resumen", "Transcripción") { "" })
        assertNull(TcJson.decodeFromString(CallShareResult.serializer(), "{}").message)
    }

    @Test fun `features calls del bootstrap`() {
        assertFalse(TcJson.decodeFromString(BootstrapDTO.serializer(), """{"me":{"id":"u1"}}""").callsEnabled) // servidor viejo
        assertFalse(TcJson.decodeFromString(BootstrapDTO.serializer(), """{"features":null}""").callsEnabled)
        assertFalse(TcJson.decodeFromString(BootstrapDTO.serializer(), """{"features":{"calls":false}}""").callsEnabled)
        assertTrue(TcJson.decodeFromString(BootstrapDTO.serializer(), """{"features":{"calls":true,"otra":true}}""").callsEnabled)
    }

    // ---------- Eventos ----------
    @Test fun `call updated y call ringing`() {
        val e = decodeConversationEvent(TcJson.parseToJsonElement("""{"type":"call.updated","conversationId":"c1","eventSeq":12,"call":$callJson}""")) as ConversationEvent.CallUpdated
        assertEquals(12, e.eventSeq); assertEquals("k1", e.call.id); assertEquals("c1", e.call.conversationId)
        // Sin conversationId dentro de la llamada: se completa con el del evento.
        val filled = decodeConversationEvent(TcJson.parseToJsonElement("""{"type":"call.updated","conversationId":"c7","eventSeq":1,"call":{"id":"k7"}}""")) as ConversationEvent.CallUpdated
        assertEquals("c7", filled.call.conversationId)
        // Ilegible: solo avanza el cursor.
        assertTrue(decodeConversationEvent(TcJson.parseToJsonElement("""{"type":"call.updated","conversationId":"c1","eventSeq":13,"call":"x"}""")) is ConversationEvent.CursorOnly)
        val r = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"call.ringing","call":$callJson,"conversationTitle":"Ventas","callerName":"Beto Ruiz"}""")) as AccountEvent.CallRinging
        assertEquals("Beto Ruiz", r.callerName); assertEquals("Ventas", r.conversationTitle); assertEquals("k1", r.call.id)
        val direct = decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"call.ringing","call":$callJson,"conversationTitle":null,"callerName":"Beto"}""")) as AccountEvent.CallRinging
        assertNull(direct.conversationTitle)
        assertTrue(decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"call.ringing"}""")) is AccountEvent.Unknown)
        assertTrue(decodeAccountEvent(TcJson.parseToJsonElement("""{"type":"call.ringing","call":{"id":"k"}}""")) is AccountEvent.Unknown) // sin conversación
    }

    @Test fun `estado de la llamada por conversacion`() {
        val live = CallDTO(id = "k1", conversationId = "c1")
        var m = Calls.put(emptyMap(), live)
        assertEquals(live, m["c1"])
        // Una terminada vieja (otra llamada) no pisa la actual.
        m = Calls.put(m, CallDTO(id = "k0", conversationId = "c1", endedAt = "2026-09-28T00:00:00Z"))
        assertEquals(live, m["c1"])
        // La actual terminó: queda null (se sabe que no hay llamada).
        m = Calls.put(m, live.copy(endedAt = "2026-09-29T00:00:00Z"))
        assertTrue(m.containsKey("c1")); assertNull(m["c1"])
    }

    // ---------- Mensajes de sistema ----------
    private fun sys(json: String) = Calls.systemCall(TcJson.parseToJsonElement(json).jsonObject)

    @Test fun `mensajes de sistema call`() {
        assertEquals("call.started", sys("""{"k":"call.started","kind":"audio","callId":"k1"}""")!!.key)
        val ended = sys("""{"k":"call.ended","callId":"k1","durationSec":83}""")!!
        assertEquals(83L, ended.durationSec); assertEquals("1:23", Calls.clock(ended.durationSec!!))
        assertEquals(125L, sys("""{"k":"call.ended","durationSec":125.7}""")!!.durationSec)
        assertNull(sys("""{"k":"call.ended","callId":"k1"}""")!!.durationSec)
        assertEquals("Ana", sys("""{"k":"call.transcription.on","name":"Ana","callId":"k1"}""")!!.name)
        assertEquals("Ana", sys("""{"k":"call.transcription.off","name":"Ana","callId":"k1"}""")!!.name)
        assertEquals("k1", sys("""{"k":"call.transcript","callId":"k1"}""")!!.callId)
        assertNull(sys("""{"k":"issue.created","title":"x"}"""))
        assertNull(sys("""{"k":"call.nuevo"}""")) // una clave futura cae al texto genérico
        assertEquals("0:00", Calls.clock(0)); assertEquals("0:09", Calls.clock(9)); assertEquals("61:01", Calls.clock(3661)); assertEquals("0:00", Calls.clock(-5))
        // «Ver transcripción» solo en call.transcript de sistema.
        assertEquals("k1", Calls.transcriptCallId(MessageDTO(kind = "system", body = """{"k":"call.transcript","callId":"k1"}""")))
        assertNull(Calls.transcriptCallId(MessageDTO(kind = "text", body = """{"k":"call.transcript","callId":"k1"}""")))
        assertNull(Calls.transcriptCallId(MessageDTO(kind = "system", body = """{"k":"call.ended","callId":"k1"}""")))
        assertNull(Calls.transcriptCallId(MessageDTO(kind = "system", body = "texto plano")))
    }

    /** Los textos del pedido, en es y en, para que las apps no muestren JSON crudo. */
    @Test fun `textos de sistema call en espanol e ingles`() {
        fun strings(dir: String): Map<String, String> {
            val out = HashMap<String, String>()
            File("src/main/res/$dir").listFiles { f -> f.name.endsWith(".xml") }!!.forEach { f ->
                Regex("<string name=\"([^\"]+)\">(.*?)</string>", RegexOption.DOT_MATCHES_ALL).findAll(f.readText()).forEach { out[it.groupValues[1]] = it.groupValues[2] }
            }
            return out
        }
        val es = strings("values-es"); val en = strings("values")
        assertEquals("Empezó una llamada.", es["sys_call_started"])
        assertEquals("Terminó la llamada · %1\$s.", es["sys_call_ended"])
        assertEquals("%1\$s prendió la transcripción de la llamada.", es["sys_call_transcription_on"])
        assertEquals("%1\$s apagó la transcripción de la llamada.", es["sys_call_transcription_off"])
        assertEquals("Quedó guardada la transcripción de la llamada.", es["sys_call_transcript"])
        assertEquals("Ver transcripción", es["call_transcript_open"])
        assertEquals("A call started.", en["sys_call_started"])
        assertEquals("The call ended · %1\$s.", en["sys_call_ended"])
        assertEquals("View transcript", en["call_transcript_open"])
        assertEquals("Llamadas", es["nav_calls"]); assertEquals("Calls", en["nav_calls"])
        // Cada texto de llamadas existe en los dos idiomas.
        val keys = en.keys.filter { it.startsWith("call") || it.startsWith("sys_call") }
        assertTrue(keys.size > 40)
        keys.forEach { assertNotNull("falta en es: $it", es[it]) }
    }

    // ---------- Subtítulos y transcripción ----------
    private fun piece(id: String, text: String, partial: Boolean = false, start: Long = 0) = TranscriptPiece(id, partial, text, "a1", "u2", "es-US", start, start + 900)

    @Test fun `subtitulos en vivo reemplazan la parcial por la final`() {
        var caps = Calls.mergeCaption(emptyList(), piece("r1", "hol", partial = true))
        caps = Calls.mergeCaption(caps, piece("r1", "hola a todos"))
        assertEquals(1, caps.size); assertEquals("hola a todos", caps[0].text); assertFalse(caps[0].partial); assertEquals("u2", caps[0].userId)
        assertEquals(caps, Calls.mergeCaption(caps, piece("r9", "   "))) // vacías no cuentan
        repeat(10) { caps = Calls.mergeCaption(caps, piece("x$it", "frase $it")) }
        assertEquals(Calls.MAX_CAPTIONS, caps.size); assertEquals("frase 9", caps.last().text)
    }

    @Test fun `solo las frases finales van al API`() {
        assertNull(Calls.segmentOf(piece("r1", "hol", partial = true)))
        assertNull(Calls.segmentOf(piece("r1", "  ")))
        assertNull(Calls.segmentOf(piece("", "hola")))
        val s = Calls.segmentOf(TranscriptPiece("r2", false, " hola ", "a1", "u2", "es-US", -3, 1200))!!
        assertEquals("hola", s.text); assertEquals(0L, s.startMs); assertEquals(1200L, s.endMs); assertEquals("a1", s.attendeeId); assertEquals("u2", s.externalUserId)
        assertEquals(4000, Calls.segmentOf(piece("r3", "x".repeat(5000)))!!.text.length)
    }

    @Test fun `cola de frases deduplica y manda lotes de 50`() {
        val o = TranscriptOutbox()
        repeat(60) { assertTrue(o.add(Calls.segmentOf(piece("r$it", "f$it"))!!)) }
        assertFalse(o.add(Calls.segmentOf(piece("r3", "otra vez"))!!)) // mismo resultId
        val first = o.take()
        assertEquals(50, first.size); assertEquals("r0", first[0].resultId); assertEquals(10, o.size)
        o.putBack(first) // sin red: vuelve al frente en el mismo orden
        assertEquals(60, o.size); assertEquals("r0", o.take(1)[0].resultId)
        o.clear(); assertEquals(0, o.size); assertTrue(o.add(Calls.segmentOf(piece("r3", "x"))!!))
        // Reintento solo sin red o error interno; apagada o fuera de la llamada, se descarta.
        assertTrue(Calls.retryBatch(NetworkException(java.io.IOException("x"))))
        assertTrue(Calls.retryBatch(ApiException(500, "internal", "x")))
        assertFalse(Calls.retryBatch(ApiException(409, "not_in_call", "x")))
        assertFalse(Calls.retryBatch(ApiException(409, "not_transcribing", "x")))
        assertTrue(Calls.heartbeatEnds(ApiException(409, "not_in_call", "x")))
        assertFalse(Calls.heartbeatEnds(NetworkException(java.io.IOException("x"))))
    }

    @Test fun `filas del historial`() {
        val me = "u1"
        val direct = ConversationDTO(id = "c1", kind = "direct", memberIds = listOf("u1", "u2"))
        val group = ConversationDTO(id = "c2", kind = "group", memberIds = listOf("u1", "u2", "u3"))
        val answered = CallHistoryItemDTO(CallDTO(id = "k1", conversationId = "c1", endedAt = "2026-09-29T00:00:00Z", hasTranscript = true), listOf("u2", "u1"), 83)
        val missed = CallHistoryItemDTO(CallDTO(id = "k2", conversationId = "c1", endedAt = "2026-09-29T00:00:00Z"), listOf("u1"), 30)
        val live = CallHistoryItemDTO(CallDTO(id = "k3", conversationId = "c2"), listOf("u1"))
        assertFalse(Calls.isMissed(answered)); assertTrue(Calls.isMissed(missed)); assertFalse(Calls.isMissed(live))
        assertTrue(Calls.isLive(live)); assertFalse(Calls.isLive(answered))
        assertFalse(Calls.isGroup(answered, direct, me)); assertTrue(Calls.isGroup(live, group, me))
        // Sin la conversación (ya no la veo): grupal si hubo más de una persona aparte de mí.
        assertTrue(Calls.isGroup(answered.copy(participantIds = listOf("u1", "u2", "u3")), null, me))
        assertTrue(Calls.hasDetail(answered)); assertFalse(Calls.hasDetail(missed)); assertTrue(Calls.hasDetail(missed.copy(hasSummary = true)))
        assertEquals("1:05", Calls.stamp(65_400))
    }

    // ---------- API ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient
    @Volatile private var heartbeatReply: Pair<Int, String> = 200 to "{}"

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val text = request.body.readUtf8()
                requests += request to text
                val path = request.path!!.substringBefore('?')
                val join = """{"call":$callJson,"meeting":{"Meeting":{"MeetingId":"fake-k1","MediaPlacement":{"AudioHostUrl":"fake.invalid:3478"}}},"attendee":{"Attendee":{"AttendeeId":"att","ExternalUserId":"u1","JoinToken":"t"}}}"""
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana"},"features":{"calls":true},
                        "people":[{"id":"u1","name":"Ana"},{"id":"u2","name":"Beto"}],"conversations":[{"id":"c1","kind":"direct","memberIds":["u1","u2"],"canPost":true}]}"""
                    path == "/api/v1/conversations/c1/call" && request.method == "GET" -> """{"call":null}"""
                    path == "/api/v1/conversations/c1/call" -> join
                    path == "/api/v1/calls/k1/join" -> join
                    path == "/api/v1/calls/k1/heartbeat" -> return MockResponse().setResponseCode(heartbeatReply.first).setBody(heartbeatReply.second)
                    path == "/api/v1/calls/k1/leave" -> """{"call":${callJson.replace("\"endedAt\":null", "\"endedAt\":\"2026-09-29T01:02:00Z\"")}}"""
                    path == "/api/v1/calls/k1/transcription" -> """{"call":${callJson.replace("\"transcribing\":true", "\"transcribing\":${TcJson.parseToJsonElement(text).jsonObject["on"]}")}}"""
                    path == "/api/v1/calls/k1/transcript" && request.method == "POST" -> """{"saved":${TcJson.parseToJsonElement(text).jsonObject["segments"]!!.let { (it as kotlinx.serialization.json.JsonArray).size }}}"""
                    path == "/api/v1/calls/k1/transcript" -> """{"call":$callJson,"summary":"S","segments":[]}"""
                    path == "/api/v1/calls" -> """{"calls":[{"call":$callJson,"participantIds":["u2","u1"]}],"hasMore":false}"""
                    path == "/api/v1/calls/k1/share" -> """{"message":{"id":"m9","conversationId":"c2","seq":4,"authorId":"u1","body":"Resumen"}}"""
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
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

    private fun last(path: String) = requests.last { it.first.path!!.substringBefore('?') == path }

    @Test fun `llamar, latir, transcribir, colgar e historial`() = runBlocking {
        assertTrue(client.state.value.data!!.callsEnabled)
        assertNull(client.loadCall("c1")); assertTrue(client.state.value.calls.containsKey("c1"))
        val j = client.startCall("c1", "video")
        assertEquals("video", TcJson.parseToJsonElement(last("/api/v1/conversations/c1/call").second).jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals("k1", client.state.value.calls["c1"]?.id)
        assertTrue(ChimeJoin.parse(j.meeting, j.attendee)!!.isFake)
        assertEquals("k1", client.joinCall("k1").call.id)
        client.callHeartbeat("k1")
        heartbeatReply = 409 to """{"error":{"code":"not_in_call","message":"Ya no estás en esa llamada"}}"""
        val e = runCatching { client.callHeartbeat("k1") }.exceptionOrNull()
        assertTrue(e is ApiException && Calls.heartbeatEnds(e))
        val off = client.setCallTranscription("k1", false)
        assertFalse(off!!.transcribing)
        val sent = TcJson.parseToJsonElement(last("/api/v1/calls/k1/transcription").second).jsonObject
        assertEquals("false", sent["on"].toString()); assertEquals("false", sent["aiSummary"].toString())
        client.setCallTranscription("k1", true, aiSummary = true)
        assertEquals("true", TcJson.parseToJsonElement(last("/api/v1/calls/k1/transcription").second).jsonObject["aiSummary"].toString())
        val seg = Calls.segmentOf(TranscriptPiece("r1", false, "hola", "att", "u1", "es-US", 10, 900))!!
        assertEquals(1, client.sendCallTranscript("k1", listOf(seg)))
        val posted = TcJson.parseToJsonElement(last("/api/v1/calls/k1/transcript").second).jsonObject["segments"]!!.toString()
        assertEquals("""[{"resultId":"r1","attendeeId":"att","externalUserId":"u1","language":"es-US","text":"hola","startMs":10,"endMs":900}]""", posted)
        val page = client.callHistory(before = "2026-09-29T01:00:00.000Z")
        assertEquals(1, page.calls.size)
        assertEquals("limit=30&before=2026-09-29T01%3A00%3A00.000Z", last("/api/v1/calls").first.path!!.substringAfter('?'))
        assertEquals("S", client.callTranscript("k1").summary)
        assertEquals("m9", client.shareCall("k1", "c2", "summary")?.id)
        val share = TcJson.parseToJsonElement(last("/api/v1/calls/k1/share").second).jsonObject
        assertEquals("c2", share["conversationId"]!!.jsonPrimitive.content); assertEquals("summary", share["what"]!!.jsonPrimitive.content)
        val rev = client.state.value.callsRevision
        assertNotNull(client.leaveCall("k1"))
        assertNull(client.state.value.calls["c1"]) // colgué la última: ya no hay llamada en curso
        assertTrue(client.state.value.callsRevision > rev)
    }
}
