package com.tiecoms.app.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Ruta base de autenticación. Todas las llamadas de auth (login, signup, refresh,
 * logout, SSO) cuelgan de aquí; si el backend la mueve (p. ej. a /api/auth) basta
 * con cambiar esta constante.
 */
const val AUTH_BASE_PATH = "/api/v1/auth"

enum class SsoProvider(val path: String) { GOOGLE("google"), MICROSOFT("microsoft") }

/** PKCE (RFC 7636) con S256. */
object Pkce {
    private val rng = SecureRandom()
    private val b64 = Base64.getUrlEncoder().withoutPadding()

    /** 48 bytes aleatorios → 64 caracteres base64url (rango permitido 43–128). */
    fun newVerifier(): String = ByteArray(48).also { rng.nextBytes(it) }.let { b64.encodeToString(it) }

    fun challenge(verifier: String): String =
        b64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
}

/** Intento de SSO en curso; se guarda en disco para sobrevivir a la muerte del proceso mientras está abierto el navegador. */
@Serializable
data class SsoAttempt(val provider: String, val verifier: String, val startedAt: Long)

@Serializable
data class SsoExchangeBody(
    val code: String,
    @SerialName("code_verifier") val codeVerifier: String,
    val device: DeviceInfo,
)

sealed interface SsoCallback {
    data class Code(val code: String) : SsoCallback
    data class Error(val code: String, val message: String?) : SsoCallback {
        /** La persona cerró o rechazó el acceso: no se muestra ningún error. */
        val cancelled: Boolean get() = code in setOf("access_denied", "cancelled", "canceled", "user_cancelled", "user_canceled", "sso_cancelled")
    }
}

object Sso {
    const val CALLBACK_HOST = "auth"
    const val CALLBACK_PATH = "/callback"

    /** [orgInviteToken] une a una empresa por invitación; [orgName] crea la empresa (registro). */
    fun startUrl(baseUrl: String, provider: SsoProvider, deviceId: String, challenge: String, orgInviteToken: String? = null, orgName: String? = null): String {
        fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        return "${baseUrl.trimEnd('/')}$AUTH_BASE_PATH/${provider.path}/start" +
            "?platform=$PLATFORM&device_id=${enc(deviceId)}&code_challenge=${enc(challenge)}&code_challenge_method=S256&redirect_scheme=${DeepLinks.SCHEME}" +
            (orgInviteToken?.let { "&org=${enc(it)}" } ?: "") + (orgName?.takeIf { it.isNotBlank() }?.let { "&org_name=${enc(it.trim())}" } ?: "")
    }

    /** chaggu://auth/callback?code=… | ?error=…&message=… (null si no es un callback de SSO). */
    fun parseCallback(raw: String?): SsoCallback? {
        if (raw.isNullOrBlank()) return null
        val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != DeepLinks.SCHEME || uri.host?.lowercase() != CALLBACK_HOST) return null
        if (uri.rawPath?.trimEnd('/') != CALLBACK_PATH) return null
        val q = (uri.rawQuery ?: "").split('&').mapNotNull {
            val i = it.indexOf('=')
            if (i <= 0) null else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }.toMap()
        q["code"]?.takeIf { it.isNotBlank() }?.let { return SsoCallback.Code(it) }
        return SsoCallback.Error(q["error"]?.takeIf { it.isNotBlank() } ?: "unknown", q["message"]?.takeIf { it.isNotBlank() })
    }

    fun isAuthHost(raw: String?): Boolean =
        raw != null && runCatching { URI(raw.trim()) }.getOrNull()?.let { it.scheme?.lowercase() == DeepLinks.SCHEME && it.host?.lowercase() == CALLBACK_HOST } == true
}
