package com.tiecoms.app.platform

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.tiecoms.app.core.KeyValueStorage
import com.tiecoms.app.core.SecretStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class PrefsStorage(context: Context) : KeyValueStorage {
    private val prefs: SharedPreferences = context.getSharedPreferences("tiecoms_state", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    // commit() síncrono: la cola de salida debe estar en disco antes de intentar enviar.
    override fun set(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.commit()
    }
    override fun clearPrefix(prefix: String) {
        val e = prefs.edit()
        prefs.all.keys.filter { it.startsWith(prefix) }.forEach { e.remove(it) }
        e.commit()
    }
}

/**
 * Refresh token cifrado con AES-256/GCM; la clave vive en el Android Keystore
 * (no exportable) y el texto cifrado en preferencias privadas excluidas del respaldo.
 */
class KeystoreSecretStore(context: Context) : SecretStore {
    private val prefs = context.getSharedPreferences("tiecoms_secure", Context.MODE_PRIVATE)
    private val alias = "tiecoms_refresh_token"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    @Synchronized
    override fun get(): String? {
        val blob = prefs.getString("rt", null) ?: return null
        return try {
            val raw = Base64.decode(blob, Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, 12)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            String(c.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8)
        } catch (e: Exception) {
            // Clave invalidada (restauración de respaldo, cambio de dispositivo): se pide login otra vez.
            Log.w("TieComs", "No se pudo descifrar la sesión guardada: ${e.javaClass.simpleName}")
            prefs.edit().remove("rt").commit()
            null
        }
    }

    @Synchronized
    override fun set(value: String?) {
        if (value == null) { prefs.edit().remove("rt").commit(); return }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString("rt", Base64.encodeToString(out, Base64.NO_WRAP)).commit()
    }
}

/** Preferencias de la persona en este dispositivo. */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("tiecoms_settings", Context.MODE_PRIVATE)
    /** Empresas y espacios colapsados en Inicio (claves «org:<id>» y «ws:<id>»). */
    var collapsed: Set<String>
        get() = prefs.getStringSet("collapsed", emptySet()) ?: emptySet()
        set(v) { prefs.edit().putStringSet("collapsed", v).apply() }
    /** Velocidad de las notas de voz (1, 1,5 o 2) y las ya escuchadas (SPEC-v4 §F). */
    var voiceSpeed: Float
        get() = prefs.getFloat("voiceSpeed", 1f)
        set(v) { prefs.edit().putFloat("voiceSpeed", v).apply() }
    var listenedVoice: Set<String>
        get() = prefs.getStringSet("listenedVoice", emptySet()) ?: emptySet()
        set(v) { prefs.edit().putStringSet("listenedVoice", v).apply() }
    /** Pestaña de Inicio elegida (SPEC-v4 §C): ALL | UNREAD | ISSUES | CHATS | SIDES. */
    var homeTab: String
        get() = prefs.getString("homeTab", "ALL") ?: "ALL"
        set(v) { prefs.edit().putString("homeTab", v).apply() }
    var soundsEnabled: Boolean
        get() = prefs.getBoolean("sounds", true)
        set(v) { prefs.edit().putBoolean("sounds", v).apply() }
    var askedNotificationPermission: Boolean
        get() = prefs.getBoolean("askedNotif", false)
        set(v) { prefs.edit().putBoolean("askedNotif", v).apply() }
    /** Solo en builds debug: servidor alternativo (p. ej. http://10.0.2.2:3021). */
    var debugApiUrl: String?
        get() = prefs.getString("debugApiUrl", null)
        set(v) { prefs.edit().apply { if (v.isNullOrBlank()) remove("debugApiUrl") else putString("debugApiUrl", v.trim().trimEnd('/')) }.commit() }
}
