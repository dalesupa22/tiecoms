package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Llamadas de voz y video con Amazon Chime SDK (docs/LLAMADAS.md, packages/contracts «Llamadas»).
 * Decodificación tolerante como el resto del contrato: todo tiene valor por defecto.
 */
@Serializable
data class CallDTO(
    val id: String = "",
    val conversationId: String = "",
    /** audio | video (un valor futuro se trata como audio). */
    val kind: String = "audio",
    val startedBy: String = "",
    val startedAt: String = "",
    val endedAt: String? = null,
    /** Quienes están dentro ahora mismo. */
    val activeUserIds: List<String> = emptyList(),
    /** La transcripción está prendida (todos en la llamada lo ven). */
    val transcribing: Boolean = false,
    /** Hay transcripción guardada para leer. */
    val hasTranscript: Boolean = false,
    /** Personas agregadas a la llamada que no están en el chat (POST /calls/:id/invite). */
    val invitedUserIds: List<String> = emptyList(),
    /** Nombres de quienes están o fueron agregados, para quien no los tiene en su lista de personas. */
    val names: Map<String, String> = emptyMap(),
    /** 1.7.1: mis dispositivos dentro de esta llamada (solo los míos; ausente en servidores viejos). */
    val myDevices: List<CallDeviceDTO>? = null,
    /** 1.7.1 (GET /calls/active): título de la conversación. */
    val title: String? = null,
    /** 1.7.1 (5dd0443): a quién se llamó con «＋ Agregar» y si ya entró. null = servidor anterior (se sigue en el cliente). */
    val invited: List<CallInviteDTO>? = null,
) {
    val isVideo: Boolean get() = kind == "video"
    val ended: Boolean get() = endedAt != null
}

/**
 * POST /conversations/:id/call y POST /calls/:id/join. [meeting] y [attendee] son las respuestas de CreateMeeting y
 * CreateAttendee tal cual (`{Meeting:{…}}` y `{Attendee:{…}}`): se pasan al SDK y no se guardan.
 */
@Serializable
data class CallJoinDTO(
    val call: CallDTO = CallDTO(),
    val meeting: JsonObject = JsonObject(emptyMap()),
    val attendee: JsonObject = JsonObject(emptyMap()),
)

@Serializable data class CallEnvelope(val call: CallDTO? = null)

@Serializable
data class CallTranscriptSegmentDTO(
    val resultId: String = "",
    val speakerUserId: String? = null,
    val speakerName: String? = null,
    val language: String? = null,
    val text: String = "",
    val startMs: Long = 0,
    val endMs: Long = 0,
)

/** Frase final que el cliente recibió del SDK (TranscriptEvent con isPartial=false): `POST /calls/:id/transcript`. */
@Serializable
data class CallTranscriptSegmentInput(
    val resultId: String,
    val attendeeId: String? = null,
    val externalUserId: String? = null,
    val language: String? = null,
    val text: String,
    val startMs: Long,
    val endMs: Long,
)

@Serializable data class CallTranscriptBody(val segments: List<CallTranscriptSegmentInput>)
@Serializable data class CallTranscriptSaved(val saved: Int = 0)

@Serializable
data class CallTranscriptDTO(
    val call: CallDTO = CallDTO(),
    val summary: String? = null,
    val segments: List<CallTranscriptSegmentDTO> = emptyList(),
)

/** Una fila del historial (pestaña «Llamadas»). */
@Serializable
data class CallHistoryItemDTO(
    val call: CallDTO = CallDTO(),
    /** Todos los que entraron alguna vez, en orden de llegada. */
    val participantIds: List<String> = emptyList(),
    val durationSec: Long? = null,
    val hasSummary: Boolean = false,
)

@Serializable data class CallHistoryPage(val calls: List<CallHistoryItemDTO> = emptyList(), val hasMore: Boolean = false)

@Serializable data class CallShareResult(val message: MessageDTO? = null)

/** Bootstrap: funciones que el servidor tiene prendidas (aditivo; un servidor viejo no lo manda → todo apagado). */
@Serializable data class FeaturesDTO(
    val calls: Boolean = false,
    /** Correo y WhatsApp en el chat (docs/CORREO.md); ausente = servidor anterior o apagado. */
    val mail: Boolean = false,
)

/**
 * Datos de Chime para `MeetingSessionConfiguration`, sacados del JSON de CreateMeeting / CreateAttendee sin depender del SDK
 * (así se prueban en la JVM). Los campos que falten quedan en "" (el proveedor falso no manda AudioFallbackUrl).
 */
data class ChimeJoin(
    val meetingId: String,
    val externalMeetingId: String,
    val mediaRegion: String,
    val audioHostUrl: String,
    val audioFallbackUrl: String,
    val signalingUrl: String,
    val turnControlUrl: String,
    val eventIngestionUrl: String?,
    val attendeeId: String,
    val externalUserId: String,
    val joinToken: String,
) {
    /** CALLS_PROVIDER=fake: reunión en memoria sin medios reales (fake-<id> y hosts .invalid). No se conecta el SDK. */
    val isFake: Boolean get() = meetingId.startsWith("fake-") || audioHostUrl.contains(".invalid")

    companion object {
        fun parse(meeting: JsonObject, attendee: JsonObject): ChimeJoin? {
            val m = meeting["Meeting"] as? JsonObject ?: return null
            val a = attendee["Attendee"] as? JsonObject ?: return null
            val mp = m["MediaPlacement"] as? JsonObject ?: JsonObject(emptyMap())
            fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull ?: ""
            val id = m.s("MeetingId"); val att = a.s("AttendeeId"); val token = a.s("JoinToken")
            if (id.isEmpty() || att.isEmpty() || token.isEmpty()) return null
            return ChimeJoin(
                meetingId = id, externalMeetingId = m.s("ExternalMeetingId"), mediaRegion = m.s("MediaRegion"),
                audioHostUrl = mp.s("AudioHostUrl"), audioFallbackUrl = mp.s("AudioFallbackUrl"), signalingUrl = mp.s("SignalingUrl"),
                turnControlUrl = mp.s("TurnControlUrl"), eventIngestionUrl = mp.s("EventIngestionUrl").ifEmpty { null },
                attendeeId = att, externalUserId = a.s("ExternalUserId"), joinToken = token,
            )
        }
    }
}

/** Subtítulo en vivo: parciales se reemplazan por resultId hasta que llega la final. [processing]: pedazo en Groq («⏳ Procesando…»). */
data class Caption(val resultId: String, val userId: String?, val text: String, val partial: Boolean, val processing: Boolean = false)

/** `call.processing` / `call.transcript` por la cuenta (transcripción con Groq Whisper por pedazos). */
data class CallCaptionEvent(val callId: String, val userId: String, val segId: String, val processing: Boolean,
                            val segments: List<CallTranscriptSegmentDTO> = emptyList(), val failed: Boolean = false)

@Serializable data class CallInviteResult(val call: CallDTO? = null)
@Serializable data class CallAudioResult(val saved: Int = 0, val segments: List<CallTranscriptSegmentDTO> = emptyList())

/** Frase del SDK ya normalizada (TranscriptResult → primera alternativa), sin tipos del SDK. */
data class TranscriptPiece(
    val resultId: String, val partial: Boolean, val text: String, val attendeeId: String?, val externalUserId: String?,
    val language: String?, val startMs: Long, val endMs: Long,
)

/** Reglas de las llamadas sin interfaz (las mismas de apps/web/src/call.ts y screens/Call.tsx). */
object Calls {
    const val HEARTBEAT_MS = 30_000L
    /** Las frases finales se mandan en lotes cada ~3 s (máximo 50 por petición, como el contrato). */
    const val FLUSH_MS = 3_000L
    const val BATCH_MAX = 50
    /** El aviso de llamada entrante deja de sonar a los 45 s. */
    const val RING_MS = 45_000L
    const val MAX_CAPTIONS = 6

    /** «m:ss» (duración de la llamada, reloj en vivo y marcas de la transcripción). */
    fun clock(totalSec: Long): String { val s = maxOf(0L, totalSec); return "${s / 60}:${(s % 60).toString().padStart(2, '0')}" }
    fun stamp(ms: Long): String = clock(ms / 1000)

    /** Historial: grupal si la conversación no es un directo (o, sin conversación, si hubo más de 2). */
    fun isGroup(item: CallHistoryItemDTO, conv: ConversationDTO?, me: String): Boolean =
        conv?.let { it.kind != "direct" } ?: (item.participantIds.count { it != me } > 1)
    /** «Sin respuesta»: terminó y nunca hubo dos personas dentro. */
    fun isMissed(item: CallHistoryItemDTO): Boolean = item.call.ended && item.participantIds.size < 2
    fun isLive(item: CallHistoryItemDTO): Boolean = !item.call.ended
    /** Tocar una fila: el detalle si hay algo que leer; si no, el chat. */
    fun hasDetail(item: CallHistoryItemDTO): Boolean = item.call.hasTranscript || item.hasSummary

    /** Qué se puede compartir: summary | transcript | both (en ese orden). */
    fun shareOptions(t: CallTranscriptDTO): List<String> = buildList {
        val s = !t.summary.isNullOrBlank(); val x = t.segments.isNotEmpty()
        if (s) add("summary"); if (x) add("transcript"); if (s && x) add("both")
    }

    /** Texto para la hoja de compartir del sistema y para copiar (asText de la web). */
    fun asText(t: CallTranscriptDTO, what: String, summaryLabel: String, transcriptLabel: String, speaker: (CallTranscriptSegmentDTO) -> String): String {
        val parts = mutableListOf<String>()
        if (what != "transcript" && !t.summary.isNullOrBlank()) parts += "$summaryLabel:\n${t.summary}"
        if (what != "summary" && t.segments.isNotEmpty()) parts += "$transcriptLabel:\n" + t.segments.joinToString("\n") { "[${stamp(it.startMs)}] ${speaker(it)}: ${it.text}" }
        return parts.joinToString("\n\n")
    }

    /** Pedazos de audio para Groq (docs/LLAMADAS.md): 12–20 s, corte en el primer silencio (> 700 ms) después de 12 s. */
    const val CHUNK_MIN_MS = 12_000L
    const val CHUNK_MAX_MS = 20_000L
    const val SILENCE_CUT_MS = 700L
    /** Solo se manda un pedazo con ≥ 0,8 s de voz (RMS > 0,015) y con el micrófono abierto. */
    const val MIN_VOICE_MS = 800L
    const val VOICE_RMS = 0.015
    const val MAX_CAPTIONS_GROQ = 8

    fun shouldCut(elapsedMs: Long, msSinceVoice: Long): Boolean =
        elapsedMs >= CHUNK_MAX_MS || (elapsedMs >= CHUNK_MIN_MS && msSinceVoice > SILENCE_CUT_MS)

    /** RMS de un bloque PCM de 16 bits normalizado a [0, 1]. */
    fun rms(pcm: ShortArray, n: Int = pcm.size): Double {
        if (n <= 0) return 0.0
        var sum = 0.0
        for (i in 0 until n) { val v = pcm[i] / 32768.0; sum += v * v }
        return kotlin.math.sqrt(sum / n)
    }

    fun worthSending(voicedMs: Long): Boolean = voicedMs >= MIN_VOICE_MS

    /** «Procesando…» y luego las frases (onCallTranscriptEvent de la web). */
    fun applyCaptionEvent(list: List<Caption>, e: CallCaptionEvent): List<Caption> {
        val key = "p:${e.segId}"
        var out = list.filter { it.resultId != key }
        if (e.processing) out = out + Caption(key, e.userId, "", partial = true, processing = true)
        else for (s in e.segments) out = out.filter { it.resultId != s.resultId } + Caption(s.resultId, s.speakerUserId ?: e.userId, s.text, partial = false)
        return out.takeLast(MAX_CAPTIONS_GROQ)
    }

    /** Nombre corto: el de mi lista de personas o, si me agregaron a la llamada y no lo conozco, el de call.names. */
    fun firstName(personName: String?, call: CallDTO?, id: String?): String =
        (personName ?: id?.let { call?.names?.get(it) } ?: "").substringBefore(' ')

    /** A quién puedo agregar: mi lista, sin agentes, sin los que están dentro, invitados ni yo. */
    fun addable(people: List<PersonDTO>, call: CallDTO, me: String, query: String = ""): List<PersonDTO> {
        val inside = (call.activeUserIds + call.invitedUserIds + me).toSet()
        val q = query.trim().lowercase()
        return people.filter { it.id !in inside && it.kind != "agent" && (q.isEmpty() || it.name.lowercase().contains(q)) }.take(80)
    }

    /** Aplica una frase a los subtítulos: reemplaza la del mismo resultId y deja las últimas [MAX_CAPTIONS]. */
    fun mergeCaption(list: List<Caption>, p: TranscriptPiece): List<Caption> {
        val text = p.text.trim()
        if (text.isEmpty()) return list
        return (list.filter { it.resultId != p.resultId } + Caption(p.resultId, Calls171.personOf(p.externalUserId) ?: p.externalUserId, text, p.partial)).takeLast(MAX_CAPTIONS)
    }

    /** Frase final → segmento para el API (texto recortado a 4000, tiempos no negativos). null si es parcial o vacía. */
    fun segmentOf(p: TranscriptPiece): CallTranscriptSegmentInput? {
        val text = p.text.trim()
        if (p.partial || text.isEmpty() || p.resultId.isEmpty()) return null
        return CallTranscriptSegmentInput(p.resultId.take(128), p.attendeeId?.take(128), p.externalUserId?.take(128), p.language?.take(16),
            text.take(4000), maxOf(0L, p.startMs), maxOf(0L, p.endMs))
    }

    /** ¿Se reintenta un lote que falló? Solo sin red o error interno; apagada o fuera de la llamada se descarta. */
    fun retryBatch(e: Throwable): Boolean = e is NetworkException || (e is ApiException && (e.code.isEmpty() || e.code == "internal" || e.status >= 500))

    /** Latido con 409 `not_in_call` (o la llamada ya no existe): hay que cerrar la llamada local. */
    fun heartbeatEnds(e: Throwable): Boolean = e is ApiException && (e.code == "not_in_call" || e.code == "call_ended" || e.status == 404)

    /** Mensaje de sistema de una llamada: clave call.* y sus datos, o null si es otro aviso. */
    data class SystemCall(val key: String, val callId: String?, val name: String, val durationSec: Long?)

    fun systemCall(o: JsonObject): SystemCall? {
        val k = (o["k"] as? JsonPrimitive)?.contentOrNull ?: return null
        if (k !in SYSTEM_KEYS) return null
        fun s(key: String) = (o[key] as? JsonPrimitive)?.contentOrNull
        val dur = (o["durationSec"] as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() ?: it.contentOrNull?.toDoubleOrNull()?.toLong() }
        return SystemCall(k, s("callId")?.ifEmpty { null }, s("name") ?: "", dur)
    }

    val SYSTEM_KEYS = setOf("call.started", "call.ended", "call.transcription.on", "call.transcription.off", "call.transcript")

    /** El botón «Ver transcripción» del aviso `call.transcript`. */
    fun transcriptCallId(m: MessageDTO): String? {
        if (m.kind != "system" || !m.body.startsWith("{")) return null
        val o = runCatching { TcJson.parseToJsonElement(m.body) as? JsonObject }.getOrNull() ?: return null
        return systemCall(o)?.takeIf { it.key == "call.transcript" }?.callId
    }

    /** Estado de la llamada en vivo por conversación: una terminada (o de otra llamada vieja) no pisa la actual. */
    fun put(calls: Map<String, CallDTO?>, call: CallDTO): Map<String, CallDTO?> {
        val cur = calls[call.conversationId]
        if (call.ended && cur != null && cur.id != call.id) return calls
        // 1.7.1: el call.updated de la conversación no trae myDevices: se conserva el último de mi cuenta para esa llamada.
        val merged = if (call.myDevices == null && cur != null && cur.id == call.id && cur.myDevices != null) call.copy(myDevices = cur.myDevices) else call
        return calls + (call.conversationId to if (call.ended) null else merged)
    }

    fun decode(el: JsonElement?): CallDTO? = el?.let { runCatching { TcJson.decodeFromJsonElement(CallDTO.serializer(), it) }.getOrNull() }?.takeIf { it.id.isNotEmpty() }
}

/**
 * Cola de frases finales para `POST /calls/:id/transcript` (flush de la web): deduplica por resultId,
 * saca lotes de hasta [Calls.BATCH_MAX] y devuelve al frente un lote que hay que reintentar.
 */
class TranscriptOutbox {
    private val queue = ArrayDeque<CallTranscriptSegmentInput>()
    private val seen = HashSet<String>()
    val size: Int @Synchronized get() = queue.size

    @Synchronized fun add(s: CallTranscriptSegmentInput): Boolean {
        if (!seen.add(s.resultId)) return false
        queue.addLast(s); return true
    }
    @Synchronized fun take(max: Int = Calls.BATCH_MAX): List<CallTranscriptSegmentInput> {
        val out = ArrayList<CallTranscriptSegmentInput>(minOf(max, queue.size))
        while (out.size < max && queue.isNotEmpty()) out += queue.removeFirst()
        return out
    }
    @Synchronized fun putBack(batch: List<CallTranscriptSegmentInput>) { batch.asReversed().forEach { queue.addFirst(it) } }
    @Synchronized fun clear() { queue.clear(); seen.clear() }
}
