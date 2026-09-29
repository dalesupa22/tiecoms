package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/*
 * Llamadas 1.7.1 (docs/LLAMADAS.md › «Varios dispositivos, altavoz y llamadas en curso»): un attendee por dispositivo
 * (ExternalUserId = "{userId}#{deviceKey}"), contestar/rechazar coordinado entre mis dispositivos, la franja
 * «En llamada en tu …», las llamadas en curso y la salida de audio. Kotlin puro (se prueba en la JVM).
 */

/** Invitación de «＋ Agregar» (CallDTO.invited). */
@Serializable data class CallInviteDTO(val userId: String = "", val at: String = "", val joined: Boolean = false)

/** Uno de mis dispositivos dentro de la llamada. */
@Serializable data class CallDeviceDTO(val deviceKey: String = "", val platform: String = "", val label: String = "")

/** `call.answered` (contesté en otro dispositivo) o `call.declined` (lo rechacé en alguno): deja de sonar aquí. */
data class CallElsewhere(val callId: String, val answered: Boolean, val deviceKey: String? = null, val platform: String? = null, val label: String? = null)

object Calls171 {
    /** Id de la persona en Chime: `externalUserId.split('#')[0]` (el API también acepta el id sin `#`). */
    fun personOf(externalUserId: String?): String? = externalUserId?.substringBefore('#')?.takeIf { it.isNotEmpty() }

    /** Mi clave de dispositivo como la calcula el servidor: los primeros 8 caracteres del id de sesión o de dispositivo. */
    fun keyOf(id: String?): String? = id?.take(8)?.takeIf { it.isNotEmpty() }

    /**
     * Franja «📞 En llamada en tu {dispositivo}»: la llamada en la que estoy desde OTRO dispositivo y no desde este.
     * Sale de `myActiveCall` (bootstrap) y de `myDevices` en `call.updated`.
     */
    fun elsewhere(myActive: CallDTO?, calls: Map<String, CallDTO?>, localCallId: String?, myKeys: Set<String>): CallDTO? {
        val candidates = buildList {
            calls.values.filterNotNull().forEach { add(it) }
            if (myActive != null && calls[myActive.conversationId]?.id != myActive.id) {
                // Una llamada que el socket ya dio por terminada no revive desde el bootstrap.
                if (!(calls.containsKey(myActive.conversationId) && calls[myActive.conversationId] == null)) add(myActive)
            }
        }
        return candidates.firstOrNull { c ->
            !c.ended && c.id != localCallId && c.myDevices.orEmpty().any { it.deviceKey !in myKeys }
        }
    }

    /** El otro dispositivo para el texto de la franja: el primero que no es este. */
    fun otherDevice(call: CallDTO, myKeys: Set<String>): CallDeviceDTO? = call.myDevices.orEmpty().firstOrNull { it.deviceKey !in myKeys }

    /** Nombre del dispositivo: la etiqueta del servidor, o la plataforma. */
    fun deviceName(d: CallDeviceDTO?, iphone: String, android: String, web: String, desktop: String, other: String): String =
        d?.label?.takeIf { it.isNotBlank() } ?: when (d?.platform?.lowercase()) {
            "ios" -> iphone; "android" -> android; "web" -> web; "desktop", "mac", "windows" -> desktop; else -> other
        }

    /** GET /calls/active: `{calls:[CallDTO]}` (o `{calls:[{call, title}]}`, o una lista). Solo las que siguen. */
    fun decodeActive(el: JsonElement): List<CallDTO> {
        val arr = (el as? JsonObject)?.get("calls") as? JsonArray ?: el as? JsonArray ?: return emptyList()
        return arr.mapNotNull { item ->
            val o = item as? JsonObject ?: return@mapNotNull null
            val inner = o["call"] as? JsonObject
            val c = Calls.decode(inner ?: o) ?: return@mapNotNull null
            val title = (o["title"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
            if (title != null && c.title == null) c.copy(title = title) else c
        }.filter { !it.ended }.distinctBy { it.id }
    }

    // ---------- Salida de audio ----------
    enum class Route { EARPIECE, SPEAKER, BLUETOOTH, WIRED }

    /** Por defecto: Bluetooth o audífonos si hay; si no, auricular en voz y altavoz en video. */
    fun defaultRoute(available: Collection<Route>, video: Boolean): Route = when {
        Route.BLUETOOTH in available -> Route.BLUETOOTH
        Route.WIRED in available -> Route.WIRED
        video && Route.SPEAKER in available -> Route.SPEAKER
        Route.EARPIECE in available -> Route.EARPIECE
        Route.SPEAKER in available -> Route.SPEAKER
        else -> if (video) Route.SPEAKER else Route.EARPIECE
    }

    /**
     * Tocar 🔊: con solo auricular y altavoz alterna; con Bluetooth o cable se abre la lista ([choices] no vacío).
     * El orden de la lista: auricular, altavoz, Bluetooth, cable.
     */
    fun choices(available: Collection<Route>): List<Route> = Route.entries.filter { it in available }
    fun needsPicker(available: Collection<Route>): Boolean = available.any { it == Route.BLUETOOTH || it == Route.WIRED }
    fun toggle(current: Route, available: Collection<Route>): Route =
        if (current == Route.SPEAKER) (if (Route.EARPIECE in available) Route.EARPIECE else current) else Route.SPEAKER
}

/** Invitados a la llamada que aún no entran: «Llamando…» y, a los 45 s, «No contestó» con «Volver a llamar». */
object Calls171Invites {
    const val NO_ANSWER_MS = Calls.RING_MS

    /**
     * Invitados que no han entrado → cuándo se les llamó. Con `CallDTO.invited` (servidor 1.7.1) manda el servidor
     * (hora `at`, `joined`); con un servidor anterior, la hora en que los vi por primera vez en invitedUserIds.
     */
    fun track(prev: Map<String, Long>, call: CallDTO, now: Long): Map<String, Long> {
        call.invited?.let { list ->
            return list.filter { !it.joined && it.userId !in call.activeUserIds && it.userId.isNotEmpty() }
                .associate { it.userId to (runCatching { java.time.Instant.parse(it.at).toEpochMilli() }.getOrNull()?.let { t -> minOf(t, now) } ?: prev[it.userId] ?: now) }
        }
        val pending = call.invitedUserIds.filter { it !in call.activeUserIds }.toSet()
        return pending.associateWith { prev[it] ?: now }
    }

    enum class State { CALLING, NO_ANSWER }

    fun state(invitedAt: Long, now: Long): State = if (now - invitedAt >= NO_ANSWER_MS) State.NO_ANSWER else State.CALLING
}
