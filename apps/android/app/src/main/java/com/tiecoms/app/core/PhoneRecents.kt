package com.tiecoms.app.core

/**
 * CH038: tocar una llamada de Chaggu en el historial de la app Teléfono vuelve a llamar a ese chat, como WhatsApp.
 * Telecom solo devuelve la «dirección» con que se anotó la llamada (sip:Nombre@chaggu, ver PhoneLog.address), así que
 * se recuerda a qué chat corresponde cada nombre al anotar cada llamada. Las entradas anteriores a CH038 caen en el
 * único chat con ese nombre.
 */
object PhoneRecents {
    const val DOMAIN = "@chaggu"
    /** Nombres recordados como máximo (los más recientes). */
    const val LIMIT = 300

    data class Entry(val conversationId: String, val at: Long)

    /** El nombre anotado en la dirección sip:«Nombre@chaggu» (null si no es de Chaggu). */
    fun nameFromAddress(schemeSpecificPart: String?): String? {
        val s = schemeSpecificPart?.trim().orEmpty()
        if (!s.endsWith(DOMAIN, ignoreCase = true)) return null
        return s.dropLast(DOMAIN.length).trim().ifBlank { null }
    }

    /** Valor guardado por nombre: «<at>|<conversationId>». */
    fun encode(e: Entry) = "${e.at}|${e.conversationId}"
    fun decode(raw: String?): Entry? {
        val i = raw?.indexOf('|') ?: return null
        if (i <= 0) return null
        val at = raw.substring(0, i).toLongOrNull() ?: return null
        return raw.substring(i + 1).takeIf { it.isNotBlank() }?.let { Entry(it, at) }
    }

    /** Nombres que sobran (los más viejos) para quedarse con [limit]. */
    fun overflow(all: Map<String, Entry>, limit: Int = LIMIT): List<String> =
        if (all.size <= limit) emptyList() else all.entries.sortedBy { it.value.at }.take(all.size - limit).map { it.key }

    /** El chat al que se vuelve a llamar: el recordado si sigo en él; si no, el único chat con ese nombre. */
    fun resolve(name: String, remembered: Map<String, Entry>, chats: List<Pair<String, String>>): String? {
        val n = name.trim()
        remembered[n]?.conversationId?.let { id -> if (chats.any { it.first == id }) return id }
        val same = chats.filter { it.second.replace('@', ' ').trim().equals(n, ignoreCase = true) }
        return same.singleOrNull()?.first
    }
}
