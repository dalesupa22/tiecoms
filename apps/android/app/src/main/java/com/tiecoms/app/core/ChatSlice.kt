package com.tiecoms.app.core

/**
 * CH035 (tanda 2): lo que una pantalla de chat lee del estado global, y nada más.
 *
 * El estado de la app es un único [ClientState]; cada tecla que alguien escribe en OTRO chat, cada mensaje que llega a
 * otro grupo y cada «cargando» lo cambian. Una pantalla que lo observa entero se repinta con todo eso. La porción de
 * un chat conserva la misma instancia mientras no cambie nada que ese chat muestre: así ni la pantalla ni sus burbujas
 * se vuelven a componer por lo que pasa en otra parte.
 */
object ChatSlice {
    /**
     * La porción del chat [id] para el estado [st]. Devuelve [prev] (la misma instancia) cuando no cambió nada
     * pertinente; el `data` de la porción también se conserva si solo cambiaron otros chats (ver [sameForChat]).
     */
    fun next(prev: ClientState?, st: ClientState, id: String): ClientState {
        val data = st.data?.let { d -> prev?.data?.takeIf { old -> sameForChat(old, d, id) } ?: d }
        val conv = st.conversations[id]
        val typing = st.typing[id]
        val pins = st.pins[id]
        val topics = st.topics[id]
        val pending = st.pending.filter { it.conversationId == id }
        if (prev != null && prev.status == st.status && prev.connection == st.connection && prev.data === data &&
            prev.conversations[id] === conv && prev.pending == pending && prev.typing[id] == typing &&
            prev.issues === st.issues && prev.pins[id] == pins && prev.topics[id] == topics && prev.events === st.events &&
            prev.blockedUserIds == st.blockedUserIds
        ) return prev
        return ClientState(
            status = st.status, connection = st.connection, data = data,
            conversations = if (conv != null) mapOf(id to conv) else emptyMap(),
            pending = pending,
            typing = if (typing != null) mapOf(id to typing) else emptyMap(),
            issues = st.issues,
            pins = if (pins != null) mapOf(id to pins) else emptyMap(),
            topics = if (topics != null) mapOf(id to topics) else emptyMap(),
            events = st.events, blockedUserIds = st.blockedUserIds,
        )
    }

    /**
     * ¿[new] se ve igual que [old] desde el chat [chatId]? Sí cuando lo único distinto es lo volátil de chats ajenos a su
     * árbol (último mensaje, vista previa, leídos, no leídos, menciones, asuntos abiertos, orden de la lista) o la hora
     * del servidor. El propio chat, su padre y sus derivados (hilos y sidechats: sus no leídos se ven aquí) cuentan enteros.
     */
    fun sameForChat(old: BootstrapDTO, new: BootstrapDTO, chatId: String?): Boolean {
        if (old === new) return true
        if (new.copy(serverTime = old.serverTime, conversations = old.conversations) != old) return false
        if (old.conversations === new.conversations) return true
        if (old.conversations.size != new.conversations.size) return false
        var oldById: Map<String, ConversationDTO>? = null
        var newById: Map<String, ConversationDTO>? = null
        var chatRoot: String? = null
        val a = old.conversations; val b = new.conversations
        for (i in b.indices) {
            val c = b[i]
            // Lo normal: misma posición y misma instancia (patchMeta solo cambia una fila).
            val o = a[i].takeIf { it.id == c.id } ?: (oldById ?: a.associateBy { it.id }.also { oldById = it })[c.id] ?: return false
            if (o === c || o == c) continue
            val byId = newById ?: b.associateBy { it.id }.also { newById = it }
            if (o.parentId != c.parentId) return false
            if (chatId != null) {
                val root = chatRoot ?: rootOf(byId, chatId).also { chatRoot = it }
                if (rootOf(byId, c.id) == root) return false
            }
            if (quiet(o) != quiet(c)) return false
        }
        return true
    }

    /**
     * ¿[new] se ve igual que [old] desde una burbuja? Las filas del chat solo usan de `data` lo que no cambia con cada
     * mensaje o lectura (personas, empresas, espacios, títulos); los no leídos de hilos y sidechats les llegan aparte.
     */
    fun sameForRows(old: BootstrapDTO, new: BootstrapDTO): Boolean = sameForChat(old, new, null)

    /**
     * La porción que leen las listas (Grupos, DMs): los datos, los asuntos, recordatorios, bloqueos y la conexión. No
     * cambia con «escribiendo…», con los mensajes cargados de cada chat ni con los envíos pendientes.
     */
    fun lists(prev: ClientState?, st: ClientState): ClientState {
        if (prev != null && prev.status == st.status && prev.connection == st.connection && prev.data === st.data && prev.issues === st.issues &&
            prev.reminders === st.reminders && prev.blockedUserIds == st.blockedUserIds) return prev
        return ClientState(status = st.status, connection = st.connection, data = st.data, issues = st.issues, reminders = st.reminders, blockedUserIds = st.blockedUserIds)
    }

    /** La conversación sin lo que cambia con cada mensaje o lectura. */
    private fun quiet(c: ConversationDTO) = c.copy(lastMessageSeq = 0, lastEventSeq = 0, lastMessageAt = null, lastMessagePreview = null,
        lastReadSeq = 0, readRevision = null, unread = 0, lastHumanPreview = null, unreadMentions = 0, openIssues = 0)

    /** Raíz del árbol de derivadas de [id] (tope de 32 saltos por si llegara un ciclo). */
    private fun rootOf(byId: Map<String, ConversationDTO>, id: String): String {
        var cur = id
        repeat(32) { cur = byId[cur]?.parentId?.takeIf { it in byId } ?: return cur }
        return cur
    }
}
