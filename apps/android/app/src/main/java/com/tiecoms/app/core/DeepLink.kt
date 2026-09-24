package com.tiecoms.app.core

import java.net.URI
import java.net.URLDecoder

/** Destinos que la app sabe abrir desde un enlace (https o tiecoms://). */
sealed interface DeepLink {
    data class Conversation(val id: String) : DeepLink
    data class Workspace(val id: String) : DeepLink
    data class Invite(val token: String) : DeepLink
    data class Signup(val orgToken: String?) : DeepLink
}

object DeepLinks {
    val HOSTS = setOf("app.tiecoms.com", "tiecoms.com", "www.tiecoms.com")
    const val SCHEME = "tiecoms"
    private val ID = Regex("^[A-Za-z0-9_-]{1,200}$")

    /**
     * https://app.tiecoms.com/c/<id>, /w/<id>, /invite/<token>, /signup?org=<token>
     * tiecoms://c/<id> (el primer segmento llega como host) · tiecoms:///c/<id>
     */
    fun parse(raw: String?): DeepLink? {
        if (raw.isNullOrBlank()) return null
        // tiecoms://auth/* está reservado para el retorno del SSO (ver [Sso.parseCallback]).
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
            "c" -> arg?.let { DeepLink.Conversation(it) }
            "w" -> arg?.let { DeepLink.Workspace(it) }
            "invite" -> arg?.let { DeepLink.Invite(it) }
            "signup" -> DeepLink.Signup(query["org"]?.takeIf { ID.matches(it) })
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
