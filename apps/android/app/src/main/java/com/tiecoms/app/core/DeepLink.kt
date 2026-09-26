package com.tiecoms.app.core

import java.net.URI
import java.net.URLDecoder

/** Destinos que la app sabe abrir desde un enlace (https o chaggu://). */
sealed interface DeepLink {
    /** [seq]: salta a ese mensaje (?m=seq). */
    /** [side]: abre el origen con ese sidechat desplegado (notificación TC_SIDE). */
    data class Conversation(val id: String, val seq: Long? = null, val side: String? = null) : DeepLink
    data class Workspace(val id: String) : DeepLink
    data class Invite(val token: String) : DeepLink
    data class Signup(val orgToken: String?) : DeepLink
    /** Pantallas principales: asuntos, agenda, trazo, whatsapp, ajustes, recordatorios. */
    data class Screen(val name: String) : DeepLink
    /** Texto que llega desde «Compartir» del sistema (o /share?text=). source: whatsapp|slack|email|teams|other */
    data class Share(val text: String, val source: String = "other") : DeepLink
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
            "c" -> arg?.let { DeepLink.Conversation(it, query["m"]?.toLongOrNull()?.takeIf { s -> s > 0 }, query["side"]?.takeIf { s -> ID.matches(s) }) }
            "w" -> arg?.let { DeepLink.Workspace(it) }
            "invite" -> arg?.let { DeepLink.Invite(it) }
            "signup" -> DeepLink.Signup(query["org"]?.takeIf { ID.matches(it) })
            "asuntos" -> DeepLink.Screen(SCREEN_ISSUES)
            "agenda" -> DeepLink.Screen(SCREEN_AGENDA)
            "trazo" -> DeepLink.Screen(SCREEN_TRAZO)
            "whatsapp" -> DeepLink.Screen(SCREEN_WHATSAPP)
            "ajustes" -> DeepLink.Screen(SCREEN_SETTINGS)
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
