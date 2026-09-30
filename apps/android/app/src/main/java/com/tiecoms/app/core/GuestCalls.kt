package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/*
 * Invitados por enlace y pantallas compartidas (docs/LLAMADAS.md › «Invitados por enlace» y «Compartir pantalla»;
 * referencia: apps/web/src/call.ts joinAsGuest/beatOnce y screens/GuestCall.tsx). Kotlin puro (se prueba en la JVM).
 *
 * - https://app.chaggu.com/llamada/<token> (o chaggu://llamada/<token>) abre «Entrar a la llamada», con o sin sesión.
 * - API público, sin sesión: GET /call-links/:token, POST /call-links/:token/join {name},
 *   POST /call-guests/:id/heartbeat {secret} cada 15 s y POST /call-guests/:id/leave {secret}.
 * - En Chime el invitado es `guest:<id>` y una pantalla compartida es `<externalUserId>#content`.
 */

/** Invitado por enlace que está dentro de la llamada (CallDTO.guests y GuestCallState.guests). */
@Serializable data class CallGuestDTO(
    val id: String = "",
    val name: String = "",
    /** 1.7.6: correo que dejó al entrar (llamadas rápidas). null en servidores anteriores. */
    val email: String? = null,
)

/** GET /call-links/:token: lo que ve el invitado antes de entrar (sin ids de la conversación). */
@Serializable
data class GuestCallPreviewDTO(
    /** null en chats directos. */
    val title: String? = null,
    val hostName: String = "",
    val orgName: String? = null,
    val kind: String = "audio",
    /** Hay alguien de chaggu dentro (si no, «Todavía no hay nadie»). */
    val active: Boolean = false,
)

/** Estado de la llamada para el invitado (no tiene socket: llega al entrar y en cada latido). */
@Serializable
data class GuestCallStateDTO(
    val callId: String = "",
    val kind: String = "audio",
    val active: Boolean = false,
    val transcribing: Boolean = false,
    val activeUserIds: List<String> = emptyList(),
    val guests: List<CallGuestDTO> = emptyList(),
    /** Nombres por id: personas de chaggu y `guest:<id>`. */
    val names: Map<String, String> = emptyMap(),
)

/** POST /call-links/:token/join. [meeting]/[attendee] son CreateMeeting/CreateAttendee tal cual (como CallJoinDTO). */
@Serializable
data class GuestJoinDTO(
    val guestId: String = "",
    val secret: String = "",
    val call: GuestCallStateDTO = GuestCallStateDTO(),
    val meeting: JsonObject = JsonObject(emptyMap()),
    val attendee: JsonObject = JsonObject(emptyMap()),
)

object GuestCalls {
    /** Los invitados laten más seguido que las personas (30 s): así se enteran de quién entra y sale. */
    const val HEARTBEAT_MS = 15_000L
    const val NAME_MAX = 60
    const val PREFIX = "guest:"

    /** Id del invitado como lo ven los demás (externalUserId en Chime). */
    fun externalId(guestId: String): String = PREFIX + guestId
    fun isGuest(id: String?): Boolean = id != null && id.startsWith(PREFIX)

    /** Nombre para entrar: sin espacios de sobra, 1–60 caracteres; null si queda vacío. */
    fun cleanName(raw: String?): String? {
        val n = raw?.trim()?.replace(Regex("\\s+"), " ") ?: return null
        return n.take(NAME_MAX).trim().ifEmpty { null }
    }

    /** Lo que ve el invitado, con la forma de CallDTO para reusar la llamada (guestCall de la web). */
    fun toCall(g: GuestCallStateDTO, prev: CallDTO? = null, nowIso: String = java.time.Instant.now().toString()): CallDTO = CallDTO(
        id = g.callId, conversationId = "", kind = g.kind, startedBy = "",
        startedAt = prev?.startedAt?.takeIf { it.isNotEmpty() } ?: nowIso,
        endedAt = if (g.active) null else nowIso,
        activeUserIds = g.activeUserIds, transcribing = g.transcribing, hasTranscript = false,
        names = g.names, guests = g.guests,
    )

    /** Quienes están dentro: personas de chaggu y, al final, los invitados (callPeople de la web). */
    fun people(c: CallDTO): List<String> = (c.activeUserIds + c.guests.orEmpty().map { externalId(it.id) }).distinct()

    /** Nombre de un invitado (`guest:<id>`): el de CallDTO.guests o, si no, el de names. null si no es invitado. */
    fun guestName(c: CallDTO?, id: String?): String? {
        if (!isGuest(id)) return null
        val gid = id!!.removePrefix(PREFIX)
        return c?.guests?.firstOrNull { it.id == gid }?.name?.takeIf { it.isNotBlank() } ?: c?.names?.get(id) ?: ""
    }

    /** 1.7.6: correo de un invitado (`guest:<id>`), si lo dejó; null si no es invitado o no hay. */
    fun guestEmail(c: CallDTO?, id: String?): String? {
        if (!isGuest(id)) return null
        val gid = id!!.removePrefix(PREFIX)
        return c?.guests?.firstOrNull { it.id == gid }?.email?.trim()?.takeIf { it.isNotEmpty() }
    }

    const val EMAIL_MAX = 254
    private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

    /** Correo para entrar: sin espacios y en minúsculas; null si no parece un correo. */
    fun cleanEmail(raw: String?): String? {
        val e = raw?.trim()?.lowercase() ?: return null
        return e.takeIf { it.length <= EMAIL_MAX && EMAIL.matches(it) }
    }

    /** Estado de la pantalla «Entrar a la llamada» según el error del API. */
    enum class Problem { INVALID, NOT_LIVE, ENDED, FULL, OTHER }

    fun problemOf(e: Throwable): Problem {
        if (e !is ApiException) return Problem.OTHER
        return when {
            e.code == "link_revoked" || e.status == 404 || e.status == 410 -> Problem.INVALID
            e.code == "call_not_live" -> Problem.NOT_LIVE
            e.code == "call_ended" -> Problem.ENDED
            e.code == "call_full" -> Problem.FULL
            else -> Problem.OTHER
        }
    }

    /** Latido del invitado con 409 `not_in_call` o 404: la llamada terminó o lo sacaron. */
    fun heartbeatEnds(e: Throwable): Boolean = e is ApiException && (e.code == "not_in_call" || e.code == "call_ended" || e.status == 404 || e.status == 410)

    /** Recuadro de contenido (pantalla compartida): attendee `<attendeeId>#content`. */
    fun isContentAttendee(attendeeId: String?): Boolean = attendeeId?.endsWith("#content") == true

    /** Mi propia pantalla no se muestra (sería un espejo): el contenido cuyo attendee empieza por el mío. */
    fun isMyContent(contentAttendeeId: String?, myAttendeeId: String?): Boolean =
        !myAttendeeId.isNullOrEmpty() && contentAttendeeId?.startsWith(myAttendeeId) == true
}
