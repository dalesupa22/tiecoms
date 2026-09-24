package com.tiecoms.app.core

import java.util.concurrent.ConcurrentHashMap

/** Almacenamiento clave-valor local (en Android: SharedPreferences). */
interface KeyValueStorage {
    fun get(key: String): String?
    fun set(key: String, value: String?)
    fun clearPrefix(prefix: String)
}

/** Guarda el refresh token cifrado (en Android: clave AES del Android Keystore). */
interface SecretStore {
    fun get(): String?
    fun set(value: String?)
}

class MemoryStorage : KeyValueStorage {
    private val map = ConcurrentHashMap<String, String>()
    override fun get(key: String) = map[key]
    override fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    override fun clearPrefix(prefix: String) { map.keys.filter { it.startsWith(prefix) }.forEach { map.remove(it) } }
}

class MemorySecretStore : SecretStore {
    @Volatile private var v: String? = null
    override fun get() = v
    override fun set(value: String?) { v = value }
}
