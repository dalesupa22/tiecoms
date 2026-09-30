package com.tiecoms.app.core

import java.net.URI
import java.net.URLDecoder

/** Destinos que la app sabe abrir desde un enlace (https o chaggu://). */
sealed interface DeepLink {
    /** [seq]: salta a ese mensaje (?m=seq). */
    /** [side]: abre el origen con ese sidechat desplegado (notificación TC_SIDE). */
    /** [messageId]: salta a ese mensaje por id (?mid=, push de reacción: el aviso no trae el seq). */
    /** [topicId]: tema del mensaje (?t=, si el aviso lo trae): pista para abrir filtrado en él (1.7.5). */
    data class Conversation(val id: String, val seq: Long? = null, val side: String? = null, val messageId: String? = null,
                            val topicId: String? = null) : DeepLink
    data class Workspace(val id: String) : DeepLink
    /** Un asunto o tarea (push «te asignó una tarea»): con [conversationId] abre antes el chat, si lo puedo leer. */
    data class Issue(val id: String, val conversationId: String? = null) : DeepLink
    data class Invite(val token: String) : DeepLink
    data class Signup(val orgToken: String?) : DeepLink
    /** Pantallas principales: asuntos, agenda, trazo, whatsapp, ajustes, recordatorios. */
    data class Screen(val name: String) : DeepLink
    /** Texto que llega desde «Compartir» del sistema (o /share?text=). source: whatsapp|slack|email|teams|other */
    data class Share(val text: String, val source: String = "other") : DeepLink
    /** Detalle de una llamada (resumen y transcripción): «Ver transcripción» del chat e historial (docs/LLAMADAS.md). */
    data class CallDetail(val id: String) : DeepLink
    /** Contestar una llamada desde su notificación (chaggu://call/<id>?camera=1): entra con /calls/:id/join. */
    data class CallJoin(val id: String, val camera: Boolean = false) : DeepLink
    /** Enlace de invitado a una llamada (https://app.chaggu.com/llamada/<token>, chaggu://llamada/<token>): con o sin sesión. */
    data class GuestCall(val token: String) : DeepLink
}

object DeepLinks {
    /** App web (y API) y sitio público de Chaggu, para los enlaces que la app genera. */
    const val APP_URL = "https://app.chaggu.com"
    const val WEB_URL = "https://www.chaggu.com"
    /** Chaggu (actual) y TieComs (marca anterior; sus enlaces siguen abriendo la app). */
    val HOSTS = setOf("app.chaggu.com", "chaggu.com", "www.chaggu.com", "app.tiecoms.com", "tiecoms.com", "www.tiecoms.com")
    /** Esquema propio de Chaggu. El SSO pide redirect_scheme=chaggu y el backend vuelve a chaggu://auth/callback. */
    const val SCHEME = "chaggu"
    const val SCREEN_ISSUES = "issues"
    const val SCREEN_AGENDA = "agenda"
    const val SCREEN_TRAZO = "trazo"
    const val SCREEN_WHATSAPP = "whatsapp"
    const val SCREEN_SETTINGS = "settings"
    const val SCREEN_SCHEDULED = "scheduled"

    /** Origen probable según la app que comparte (paquete del referrer). */
    fun sourceForPackage(pkg: String?): String {
        val p = pkg?.lowercase() ?: return "other"
        return when {
            p.startsWith("com.whatsapp") -> "whatsapp"
            p.startsWith("com.slack") -> "slack"
            p.startsWith("com.microsoft.teams") -> "teams"
            p.startsWith("com.google.android.gm") || p.startsWith("com.microsoft.office.outlook") || p.contains("mail") -> "email"
            else -> "other"
        }
    }
    private val ID = Regex("^[A-Za-z0-9_-]{1,200}$")

    /**
     * https://app.chaggu.com/c/<id> (también chaggu.com, www. y los hosts tiecoms.com), /w/<id>, /invite/<token>, /signup?org=<token>
     * chaggu://c/<id> (el primer segmento llega como host) · chaggu:///c/<id>
     */
    /**
     * Enlace de la app a un mensaje de un chat (notificación, burbuja): `chaggu://c/<id>` con `?m=<seq>`, `mid=<messageId>`
     * y `t=<topicId>` cuando se conocen, para abrir en el tema y en el mensaje (1.7.5).
     */
    fun conversationUri(conversationId: String, seq: Long? = null, messageId: String? = null, topicId: String? = null): String {
        val q = listOfNotNull(seq?.takeIf { it > 0 }?.let { "m=$it" }, messageId?.takeIf { ID.matches(it) }?.let { "mid=$it" },
            topicId?.takeIf { ID.matches(it) }?.let { "t=$it" })
        return "$SCHEME://c/$conversationId" + if (q.isEmpty()) "" else "?" + q.joinToString("&")
    }

    fun parse(raw: String?): DeepLink? {
        if (raw.isNullOrBlank()) return null
        // chaggu://auth/* está reservado para el retorno del SSO (ver [Sso.parseCallback]).
        if (Sso.isAuthHost(raw)) return null
        val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val segments: List<String> = when (scheme) {
            "https", "http" -> {
                if (uri.host?.lowercase() !in HOSTS) return null
                split(uri.rawPath)
            }
            SCHEME -> listOfNotNull(uri.host?.takeIf { it.isNotEmpty() }) + split(uri.rawPath)
            else -> return null
        }
        val query = parseQuery(uri.rawQuery)
        val head = segments.firstOrNull()?.lowercase() ?: return null
        val arg = segments.getOrNull(1)?.takeIf { ID.matches(it) }
        return when (head) {
            "c" -> arg?.let { DeepLink.Conversation(it, query["m"]?.toLongOrNull()?.takeIf { s -> s > 0 }, query["side"]?.takeIf { s -> ID.matches(s) }, query["mid"]?.takeIf { s -> ID.matches(s) }, query["t"]?.takeIf { s -> ID.matches(s) }) }
            "w" -> arg?.let { DeepLink.Workspace(it) }
            "issue" -> arg?.let { DeepLink.Issue(it, query["c"]?.takeIf { s -> ID.matches(s) }) }
            "invite" -> arg?.let { DeepLink.Invite(it) }
            "signup" -> DeepLink.Signup(query["org"]?.takeIf { ID.matches(it) })
            "asuntos" -> DeepLink.Screen(SCREEN_ISSUES)
            "agenda" -> DeepLink.Screen(SCREEN_AGENDA)
            "trazo" -> DeepLink.Screen(SCREEN_TRAZO)
            "whatsapp" -> DeepLink.Screen(SCREEN_WHATSAPP)
            "ajustes" -> DeepLink.Screen(SCREEN_SETTINGS)
            "programados" -> DeepLink.Screen(SCREEN_SCHEDULED)
            "call" -> arg?.let { DeepLink.CallJoin(it, query["camera"] == "1") }
            "llamada" -> arg?.let { DeepLink.GuestCall(it) }
            "share" -> DeepLink.Share(listOfNotNull(query["title"], query["text"], query["url"]).joinToString("\n").trim())
            else -> null
        }
    }

    private fun split(path: String?): List<String> =
        (path ?: "").split('/').filter { it.isNotEmpty() }.map { URLDecoder.decode(it, "UTF-8") }

    private fun parseQuery(q: String?): Map<String, String> =
        (q ?: "").split('&').mapNotNull {
            val i = it.indexOf('=')
            if (i <= 0) null else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }.toMap()
}
