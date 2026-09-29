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
@Serializable data class FeaturesDTO(val calls: Boolean = false)

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

/** Subtítulo en vivo: parciales se reemplazan por resultId hasta que llega la final. */
data class Caption(val resultId: String, val userId: String?, val text: String, val partial: Boolean)

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

    /** Aplica una frase a los subtítulos: reemplaza la del mismo resultId y deja las últimas [MAX_CAPTIONS]. */
    fun mergeCaption(list: List<Caption>, p: TranscriptPiece): List<Caption> {
        val text = p.text.trim()
        if (text.isEmpty()) return list
        return (list.filter { it.resultId != p.resultId } + Caption(p.resultId, p.externalUserId, text, p.partial)).takeLast(MAX_CAPTIONS)
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
        return calls + (call.conversationId to if (call.ended) null else call)
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
