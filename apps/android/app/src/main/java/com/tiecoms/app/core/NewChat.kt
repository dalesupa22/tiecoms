package com.tiecoms.app.core

/**
 * «Mensaje nuevo» (1.6.10, como WhatsApp/Slack; web: Chats.tsx NewChatDialog): tocar a una persona la marca y sale como
 * chip en «Para:»; con 1 se abre su directo, con 2 o más se crea un chat (POST /chats). El 💬 abre el directo al instante.
 */
object NewChat {
    enum class Action { NONE, DIRECT, GROUP }

    /** Marca o desmarca, conservando el orden en que se eligieron. */
    fun toggle(picked: List<String>, id: String): List<String> = if (id in picked) picked - id else picked + id

    /** Borrar con el campo vacío quita el último chip. */
    fun backspace(picked: List<String>, query: String): List<String> = if (query.isEmpty() && picked.isNotEmpty()) picked.dropLast(1) else picked

    /** Al marcar desde una búsqueda, el texto se limpia para seguir eligiendo. */
    fun queryAfterToggle(query: String): String = ""

    fun action(picked: List<String>): Action = when (picked.size) { 0 -> Action.NONE; 1 -> Action.DIRECT; else -> Action.GROUP }

    /** «Crear chat (n+1)»: las elegidas más yo. */
    fun memberCount(picked: List<String>): Int = picked.size + 1

    /** Nombre opcional del chat grupal (recortado, hasta 120; vacío = sin nombre). */
    fun chatName(raw: String): String? = raw.trim().take(120).ifEmpty { null }

    /** Grupos de la búsqueda: solo mientras no hay nadie marcado (tocar abre el grupo). */
    fun showGroups(picked: List<String>, query: String): Boolean = picked.isEmpty() && query.isNotBlank()
}
