package com.tiecoms.app.core

import kotlinx.serialization.Serializable

/*
 * 1.7.6: «Nueva llamada» rápida con enlace para invitados (pestaña Llamadas). Kotlin puro (se prueba en la JVM).
 *
 * - POST /api/v1/calls/instant {title?, video?} → 201 {call, conversationId, link: {url, token}}.
 *   La llamada ya está iniciada con quien la crea; el cliente entra con el flujo normal (POST /conversations/:id/call).
 * - El invitado entra por la web https://app.chaggu.com/llamada/<token> con nombre y correo. El enlace muere al terminar la llamada.
 * - Un servidor sin llamadas rápidas responde 404: «Actualiza pronto…».
 */

@Serializable data class InstantCallLinkDTO(val url: String = "", val token: String = "")

@Serializable
data class InstantCallDTO(
    val call: CallDTO = CallDTO(),
    val conversationId: String = "",
    val link: InstantCallLinkDTO = InstantCallLinkDTO(),
)

object InstantCalls {
    const val TITLE_MAX = 120
    const val WEB = "https://app.chaggu.com"

    /** Título que se manda: sin espacios de sobra; null (el servidor pone uno automático) si queda vacío. */
    fun cleanTitle(raw: String?): String? = raw?.trim()?.replace(Regex("\\s+"), " ")?.take(TITLE_MAX)?.trim()?.ifEmpty { null }

    /**
     * El enlace para compartir: el `url` del servidor si es https; si no viene (o no sirve), se arma con el token.
     * null si no hay ni url ni token.
     */
    fun linkUrl(r: InstantCallDTO): String? {
        val u = r.link.url.trim()
        if (u.startsWith("https://")) return u
        val t = r.link.token.trim().ifEmpty { return null }
        return "$WEB/llamada/" + java.net.URLEncoder.encode(t, "UTF-8")
    }

    /** Conversación de la llamada: la de la respuesta o, si falta, la de la llamada. */
    fun conversationOf(r: InstantCallDTO): String = r.conversationId.ifEmpty { r.call.conversationId }

    /** Texto sugerido para compartir. [template] es `call_instant_share_text` (con %1$s en el lugar del enlace). */
    fun shareText(template: String, url: String): String = template.replace("%1\$s", url).trim()

    /** El servidor todavía no tiene llamadas rápidas (la ruta no existe). */
    fun unsupported(e: Throwable): Boolean = e is ApiException && (e.status == 404 || e.status == 405 || e.status == 501)
}
