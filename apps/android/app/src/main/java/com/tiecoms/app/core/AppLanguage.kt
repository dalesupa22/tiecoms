package com.tiecoms.app.core

import java.util.Locale

/**
 * Idioma de la app (1.6.2): Automático (el del sistema), Español o English. Sin Android para probarlo en la JVM.
 * [tag] es lo que se guarda: "" = automático.
 */
enum class AppLanguage(val tag: String) {
    SYSTEM(""), ES("es"), EN("en");

    companion object {
        fun fromTag(tag: String?): AppLanguage = entries.firstOrNull { it.tag == tag?.trim()?.lowercase()?.substringBefore('-') && it != SYSTEM } ?: SYSTEM

        /** Idioma efectivo para el API (push `lang`, Accept-Language): es o en; el automático sigue al sistema. */
        fun effective(choice: AppLanguage, system: Locale = Locale.getDefault()): String = when (choice) {
            ES -> "es"
            EN -> "en"
            SYSTEM -> if (system.language == "es") "es" else "en"
        }
    }
}
