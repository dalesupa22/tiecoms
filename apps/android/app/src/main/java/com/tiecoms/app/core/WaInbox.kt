package com.tiecoms.app.core

/**
 * WhatsApp en la bandeja (docs/CONTRATO-GG-CHAT-WA-INBOX.md, parte A).
 *
 * Los chats de WhatsApp movidos a «mi lista principal» (`inboxPlace` no nulo) se mezclan con las conversaciones de
 * chaggu en Grupos (`groups`) o en DMs (`dms`), con el MISMO orden y los mismos separadores (Fijados · Sin leer ·
 * Recientes). Truco limpio (igual que la web): se adaptan a un [ConversationDTO] sintético con id `wa:<cuenta>:<jid>`
 * y `pinnedAt = inboxPinnedAt`, así pasan por [HomeTree.comparator] y [HomeTree.blockOf] sin tocarlos.
 */
object WaInbox {
    const val PREFIX = "wa:"
    const val GROUPS = "groups"
    const val DMS = "dms"
    /** kind del ConversationDTO sintético (ninguna conversación real lo usa). */
    const val KIND = "whatsapp"

    fun key(accountId: String, jid: String) = PREFIX + accountId + ":" + jid
    fun key(c: WaChatDTO) = key(c.accountId, c.jid)
    fun isWa(conversationId: String?) = conversationId?.startsWith(PREFIX) == true

    /** `wa:<cuenta>:<jid>` → (cuenta, jid). El jid puede llevar «:» (p. ej. dispositivos), la cuenta no. */
    fun parse(key: String): Pair<String, String>? {
        if (!key.startsWith(PREFIX)) return null
        val rest = key.removePrefix(PREFIX)
        val i = rest.indexOf(':')
        if (i <= 0 || i == rest.lastIndex) return null
        return rest.substring(0, i) to rest.substring(i + 1)
    }

    /** Sección sugerida al moverlo: un grupo de WhatsApp va a Grupos y un chat 1 a 1 a DMs. */
    fun suggested(c: WaChatDTO) = if (c.isGroup) GROUPS else DMS

    /** La cuenta está desconectada (fila atenuada). null = el servidor no lo dice: se asume conectada. */
    fun disconnected(c: WaChatDTO) = c.accountStatus != null && c.accountStatus != "connected"

    /** Conversación sintética para ordenar y separar como las de chaggu. */
    fun asConversation(c: WaChatDTO): ConversationDTO = ConversationDTO(
        id = key(c), kind = KIND, name = c.name, lastMessageAt = c.lastMessageAt, lastMessagePreview = c.lastPreview,
        unread = c.unread, pinnedAt = c.inboxPinnedAt, canPost = false,
    )

    /** Chats de una sección (groups | dms), ya como conversaciones sintéticas. */
    fun inPlace(d: BootstrapDTO, place: String): List<ConversationDTO> =
        d.waInbox.filter { it.inboxPlace == place && !it.hidden }.map { asConversation(it) }

    fun chat(d: BootstrapDTO, conversationId: String): WaChatDTO? = d.waInbox.firstOrNull { key(it) == conversationId }

    /** Búsqueda en la lista: por nombre, vista previa o etiqueta de la cuenta. */
    fun matches(d: BootstrapDTO, c: ConversationDTO, q: String): Boolean {
        if (q.isBlank()) return true
        val w = chat(d, c.id) ?: return false
        val needle = q.trim().lowercase()
        return w.name.lowercase().contains(needle) || (w.lastPreview?.lowercase()?.contains(needle) == true) || w.accountLabel.lowercase().contains(needle)
    }

    /** No leídos de los chats de WhatsApp de una sección (cuentan en «Sin leer», nunca en «Menciones»). */
    fun unreadIn(d: BootstrapDTO, place: String): Int = d.waInbox.count { it.inboxPlace == place && !it.hidden && it.unread > 0 }

    /**
     * Aplica un chat que llega (respuesta del PATCH o evento `wa.inbox`): lo reemplaza, lo agrega si entró a la
     * bandeja o lo quita si salió (inboxPlace nulo) u ocultó.
     */
    fun apply(list: List<WaChatDTO>, chat: WaChatDTO): List<WaChatDTO> {
        val k = key(chat)
        val keep = chat.inboxPlace != null && !chat.hidden
        val out = list.filter { key(it) != k }
        if (!keep) return out
        val i = list.indexOfFirst { key(it) == k }
        return if (i < 0) out + chat else list.map { if (key(it) == k) chat else it }
    }

    /** Lo que el PATCH cambia, para aplicarlo en el acto (optimista). [place] "auto" se resuelve con is_group. */
    fun optimistic(c: WaChatDTO, place: String?, placeSet: Boolean, pinned: Boolean?, nowIso: String): WaChatDTO {
        var out = c
        if (placeSet) out = if (place == null) out.copy(inboxPlace = null, inboxPinnedAt = null)
            else out.copy(inboxPlace = if (place == "auto") suggested(c) else place)
        if (pinned != null) {
            out = if (pinned) out.copy(inboxPinnedAt = nowIso, inboxPlace = out.inboxPlace ?: suggested(c)) else out.copy(inboxPinnedAt = null)
        }
        return out
    }

    /** El servidor respondió sin los campos nuevos (API anterior a la 081): el cambio no se guardó. */
    fun serverIgnored(requested: WaChatDTO, got: WaChatDTO): Boolean =
        requested.inboxPlace != null && got.inboxPlace == null && got.inboxPinnedAt == null
}
