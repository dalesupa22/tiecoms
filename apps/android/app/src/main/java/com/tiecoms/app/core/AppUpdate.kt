package com.tiecoms.app.core

import kotlinx.serialization.Serializable

/**
 * GET /api/v1/app-version?platform=android&lang=es (público, sin token).
 * Decodificación tolerante: sin latestBuild o minBuild valen 0 y no se avisa nada.
 */
@Serializable
data class AppVersionDTO(
    val platform: String = "",
    val latestVersion: String = "",
    val latestBuild: Int = 0,
    /** Por debajo de este build la app ya no funciona (0 = sin mínimo). */
    val minBuild: Int = 0,
    /** Página de la tienda (Play web): respaldo si no abre market://. */
    val url: String? = null,
    val notes: String? = null,
)

/** «Actualización disponible»: la regla, sin interfaz. */
object AppUpdate {
    sealed interface Status {
        data object None : Status
        /** Franja fija arriba, que no se cierra, hasta instalar un versionCode ≥ latestBuild. */
        data class Available(val version: String, val notes: String?, val url: String?) : Status
        /** Pantalla completa que bloquea: versionCode < minBuild. */
        data class Required(val version: String, val url: String?) : Status
    }

    fun evaluate(versionCode: Int, v: AppVersionDTO?): Status = when {
        v == null -> Status.None
        v.minBuild > 0 && versionCode < v.minBuild -> Status.Required(v.latestVersion, v.url?.takeIf { it.isNotBlank() })
        v.latestBuild > 0 && versionCode < v.latestBuild ->
            Status.Available(v.latestVersion, v.notes?.trim()?.takeIf { it.isNotEmpty() }, v.url?.takeIf { it.isNotBlank() })
        else -> Status.None
    }

    /** Ruta del endpoint: plataforma fija y el idioma de la app (es o en) para las notas. */
    fun path(language: String): String = "/app-version?platform=android&lang=" + (if (language.lowercase().startsWith("es")) "es" else "en")

    /** market:// primero (también sirve a testers internos); si no hay Play, la url del endpoint o Play web. */
    fun marketUri(packageName: String) = "market://details?id=$packageName"
    fun webUrl(packageName: String, url: String?) = url ?: "https://play.google.com/store/apps/details?id=$packageName"
}
