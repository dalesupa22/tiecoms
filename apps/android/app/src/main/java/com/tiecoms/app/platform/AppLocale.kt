package com.tiecoms.app.platform

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import com.tiecoms.app.core.AppLanguage
import java.util.Locale

/**
 * Idioma por app. Android 13+: LocaleManager (el mismo mecanismo de AppCompatDelegate.setApplicationLocales y del
 * «Idioma de la app» del sistema, con res/xml/locales_config): lo guarda el sistema y recrea las actividades.
 * Android 8–12: se guarda en las preferencias y se aplica al contexto de la app y de cada actividad (attachBaseContext).
 * No se usa AppCompat: las actividades son ComponentActivity, y el respaldo de AppCompat solo cubre AppCompatActivity.
 */
object AppLocale {
    private const val PREFS = "tiecoms_settings"
    private const val KEY = "appLanguage"
    /** Idioma del sistema al arrancar (para «Automático» en Android 8–12, donde cambiamos Locale.getDefault). */
    private val systemLocale: Locale = Locale.getDefault()

    fun current(ctx: Context): AppLanguage {
        if (Build.VERSION.SDK_INT >= 33) {
            val l = ctx.getSystemService(LocaleManager::class.java)?.applicationLocales
            return if (l == null || l.isEmpty) AppLanguage.SYSTEM else AppLanguage.fromTag(l[0].toLanguageTag())
        }
        return AppLanguage.fromTag(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, ""))
    }

    /** Idioma efectivo para el API: es | en. */
    fun effective(ctx: Context): String = AppLanguage.effective(current(ctx), if (Build.VERSION.SDK_INT >= 33) Locale.getDefault() else systemLocale)

    /** Cambia el idioma de toda la app y lo recuerda entre reinicios. En Android 8–12 hay que recrear la actividad. */
    fun set(ctx: Context, lang: AppLanguage) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, lang.tag).commit()
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.getSystemService(LocaleManager::class.java)?.applicationLocales =
                if (lang == AppLanguage.SYSTEM) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(lang.tag)
        } else {
            val loc = if (lang == AppLanguage.SYSTEM) systemLocale else Locale.forLanguageTag(lang.tag)
            Locale.setDefault(loc)
            @Suppress("DEPRECATION")
            ctx.applicationContext.resources.let { r -> r.updateConfiguration(Configuration(r.configuration).apply { setLocale(loc) }, r.displayMetrics) }
        }
    }

    /** Android 8–12: contexto con el idioma elegido (Application y actividades). En 13+ lo hace el sistema. */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= 33) return base
        val lang = AppLanguage.fromTag(base.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, ""))
        if (lang == AppLanguage.SYSTEM) return base
        val loc = Locale.forLanguageTag(lang.tag)
        Locale.setDefault(loc)
        return base.createConfigurationContext(Configuration(base.resources.configuration).apply { setLocale(loc) })
    }
}
