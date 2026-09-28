package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder
import java.util.UUID

/**
 * Reuniones reales con Google Meet, Microsoft Teams o Zoom (docs/TANDA-LECTURA-REUNIONES.md §4).
 * La cuenta de cada persona se conecta por OAuth en el navegador del sistema (Custom Tabs) y vuelve por
 * chaggu://meetings/connected?provider=…&connected=1 (o &error=cancelled|denied|…).
 * El enlace SOLO sale de la respuesta del proveedor: sin confirmación no hay enlace ni mensaje.
 */
@Serializable
data class MeetingConnectionDTO(
    /** google | microsoft | zoom */
    val provider: String = "",
    val label: String = "",
    /** false: falta configurarlo en el servidor; [unavailableReason] dice por qué (sin ofrecer un botón que no funciona). */
    val available: Boolean = false,
    val unavailableReason: String? = null,
    /** none | active | reconnect */
    val status: String = "none",
    val accountEmail: String? = null,
) {
    val connected: Boolean get() = available && status == "active"
}

@Serializable data class MeetingConnectionsPage(val connections: List<MeetingConnectionDTO> = emptyList())
@Serializable data class MeetingConnectResult(val url: String = "")

@Serializable
data class MeetingDTO(
    val id: String = "",
    val provider: String = "",
    /** creating | created | failed */
    val status: String = "created",
    val title: String = "",
    val startsAt: String = "",
    val endsAt: String = "",
    val timezone: String = "UTC",
    /** Enlace real devuelto por el proveedor (nunca inventado). */
    val joinUrl: String? = null,
    val conversationId: String? = null,
    val calendarEventId: String? = null,
    val messageId: String? = null,
    /** La reunión existe pero no se pudo compartir en el chat (se copia el enlace). */
    val error: String? = null,
) {
    /** Solo un https del proveedor cuenta como enlace. */
    val usableUrl: String? get() = joinUrl?.trim()?.takeIf { it.startsWith("https://") }
    val shared: Boolean get() = messageId != null && error == null
}

object Meetings {
    const val HOST = "meetings"
    const val PATH = "/connected"
    val PROVIDERS = listOf("google", "microsoft", "zoom")
    val DURATIONS = listOf(15, 30, 45, 60)

    /** Nombre corto para «Abrir en Meet / Teams / Zoom». */
    fun appName(provider: String): String = when (provider) { "google" -> "Meet"; "microsoft" -> "Teams"; "zoom" -> "Zoom"; else -> provider }

    /** Etiqueta del proveedor si el servidor no la manda. */
    fun label(provider: String): String = when (provider) { "google" -> "Google Meet"; "microsoft" -> "Microsoft Teams"; "zoom" -> "Zoom"; else -> provider }

    /** ¿Es un enlace de Meet, Teams o Zoom? (los eventos del calendario con él llevan 📹). */
    fun isVideoLink(location: String?): Boolean {
        val host = runCatching { URI(location?.trim() ?: return false).host?.lowercase() }.getOrNull() ?: return false
        return host == "meet.google.com" || host.endsWith(".zoom.us") || host == "zoom.us" || host == "teams.microsoft.com" || host == "teams.live.com"
    }

    /** Vuelta de «Conectar» desde el navegador. */
    sealed interface Return {
        val provider: String?
        data class Connected(override val provider: String?) : Return
        data class Failed(override val provider: String?, val error: String) : Return {
            val cancelled: Boolean get() = error == "cancelled" || error == "access_denied"
        }
    }

    /** chaggu://meetings/connected?provider=google&connected=1 | &error=…; null si no es esa vuelta. */
    fun parseReturn(raw: String?): Return? {
        val uri = runCatching { URI(raw?.trim() ?: return null) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != DeepLinks.SCHEME || uri.host?.lowercase() != HOST) return null
        if (uri.rawPath?.trimEnd('/') != PATH) return null
        val q = (uri.rawQuery ?: "").split('&').mapNotNull {
            val i = it.indexOf('=')
            if (i <= 0) null else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }.toMap()
        val provider = q["provider"]?.takeIf { it in PROVIDERS }
        if (q["connected"] == "1" && q["error"].isNullOrBlank()) return Return.Connected(provider)
        return Return.Failed(provider, q["error"]?.takeIf { it.isNotBlank() } ?: "failed")
    }

    /** Qué pasó al crear o conectar, para decir el motivo y ofrecer lo que sí funciona. */
    sealed interface Problem {
        /** 409 not_connected: ofrecer «Conectar». */
        data object NotConnected : Problem
        /** 409 reconnect_required: ofrecer «Reconectar». */
        data object Reconnect : Problem
        /** 409 no_teams: la cuenta de Microsoft no tiene Teams para empresas. */
        data object NoTeams : Problem
        /** 503 provider_unavailable: explicar el motivo, sin botón. */
        data class Unavailable(val reason: String) : Problem
        /** 502 (u otro error del proveedor), con su mensaje. */
        data class Provider(val message: String) : Problem
        /** Sin red o sin respuesta: se puede reintentar con la misma llave. */
        data object Network : Problem
        /** 409 meeting_in_progress: la misma llave se está creando; reintentar. */
        data object InProgress : Problem
        data class Other(val message: String) : Problem
    }

    fun problem(e: Throwable): Problem = when (e) {
        is ApiException -> when {
            e.code == "not_connected" -> Problem.NotConnected
            e.code == "reconnect_required" -> Problem.Reconnect
            e.code == "no_teams" -> Problem.NoTeams
            e.code == "provider_unavailable" || e.status == 503 -> Problem.Unavailable(e.message ?: "")
            e.code == "meeting_in_progress" -> Problem.InProgress
            e.code == "provider_unreachable" -> Problem.Network
            e.status == 502 || e.status == 504 -> Problem.Provider(e.message ?: "")
            else -> Problem.Other(e.message ?: "")
        }
        is NetworkException, is java.io.IOException -> Problem.Network
        else -> Problem.Other(e.message ?: "")
    }

    /** ¿Tiene sentido reintentar con la misma llave? (red, en curso o el proveedor falló). */
    fun retryable(p: Problem): Boolean = p is Problem.Network || p is Problem.InProgress || p is Problem.Provider

    /** Proveedor que el diálogo elige al abrir: el recordado si está conectado; si no, el primero conectado. */
    fun defaultProvider(list: List<MeetingConnectionDTO>, remembered: String?): String? =
        list.firstOrNull { it.provider == remembered && it.connected }?.provider ?: list.firstOrNull { it.connected }?.provider
}

/**
 * Idempotencia de «Crear y compartir»: una llave (UUID) por toque, reusada si ese intento falla y se reintenta,
 * y el botón desactivado mientras crea. Así un doble toque, un reintento o un fallo de red nunca duplican la reunión
 * (el servidor devuelve la misma para la misma llave). Tras crearla, un toque nuevo sería otra reunión.
 */
class MeetingAttempt(private val newKey: () -> String = { UUID.randomUUID().toString() }) {
    var creating: Boolean = false; private set
    private var key: String? = null

    /** Llave de este toque; null si ya hay una creación en curso (el toque se ignora). */
    fun begin(): String? {
        if (creating) return null
        creating = true
        return key ?: newKey().also { key = it }
    }

    /** Creada: la próxima reunión lleva otra llave. */
    fun succeeded() { creating = false; key = null }

    /**
     * Falló: con [keepKey] (red, en curso o caída del proveedor) el reintento usa la MISMA llave (si el servidor
     * alcanzó a crearla, devuelve esa). Si el proveedor respondió que no se puede (sin Teams, sin conexión,
     * permiso revocado), repetir la misma llave devolvería la misma respuesta: el siguiente intento es otro.
     */
    fun failed(keepKey: Boolean = true) { creating = false; if (!keepKey) key = null }

    /** Cambió el formulario (proveedor, hora, duración o título): es otra reunión, llave nueva (como la web). */
    fun reset() { if (!creating) key = null }

    /** La llave que se reusará (pruebas y diagnóstico). */
    val pendingKey: String? get() = key
}
