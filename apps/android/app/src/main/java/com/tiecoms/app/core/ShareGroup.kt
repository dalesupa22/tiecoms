package com.tiecoms.app.core

/**
 * 1.7.13, compartir desde otra app como Instagram: con 2+ destinos que son todos directos con personas, además de
 * «Enviar por separado» (un mensaje a cada uno) se ofrece «Enviar en un grupo»: POST /chats con esas personas (sin
 * nombre, así el servidor retoma el chat grupal que ya exista con exactamente esa gente) y se envía ahí una vez.
 */
object ShareGroup {
    /**
     * Personas para el chat grupal, o null si no aplica: menos de 2 destinos, alguno no es un directo (grupos,
     * chats grupales, «Tú», gg u otro agente) o no sé quién es la otra persona.
     */
    fun people(selected: List<String>, data: BootstrapDTO): List<String>? {
        if (selected.size < 2) return null
        val me = data.me.id
        val ids = selected.map { id ->
            val c = data.conversations.firstOrNull { it.id == id } ?: return null
            if (c.kind != "direct" || c.isSide) return null
            val other = c.memberIds.filter { it != me }.singleOrNull() ?: return null
            if (Gg.isGg(other, data)) return null
            val p = data.people.firstOrNull { it.id == other }
            if (p != null && p.kind != "human") return null
            other
        }.distinct()
        return ids.takeIf { it.size >= 2 }
    }
}
