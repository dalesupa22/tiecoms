package com.tiecoms.app.core

/**
 * Navegar un chat largo (1.6.4, igual en web e iOS): abrir en el primer no leído con la línea «N mensajes nuevos»,
 * y las menciones a mí sin leer para el botón «@». Sin servidor: solo con los mensajes cargados.
 */
object ChatNav {
    /** Páginas antiguas que se cargan como mucho para encontrar el primer no leído (si no, se abre al final). */
    const val MAX_OLDER_PAGES = 3

    private fun countable(m: MessageDTO, me: String) = m.authorId != me && m.deletedAt == null

    /**
     * Seq del primer mensaje no leído: el primero de otra persona después de mi [lastReadSeq]; si no hay
     * lastReadSeq, el primero de los últimos [unread] mensajes de otros. null si no hay no leídos o no está cargado.
     * [messages] en orden cronológico.
     */
    fun firstUnreadSeq(messages: List<MessageDTO>, lastReadSeq: Long, unread: Int, me: String, hasMore: Boolean = false): Long? {
        if (unread <= 0) return null
        val others = messages.filter { countable(it, me) }
        if (lastReadSeq > 0) return others.firstOrNull { it.seq > lastReadSeq }?.seq?.takeIf { !hasMore || loadedFrom(messages, lastReadSeq) }
        val tail = others.takeLast(unread)
        return if (tail.size < unread && hasMore) null else tail.firstOrNull()?.seq
    }

    /** ¿Lo cargado ya llega hasta justo después de lastReadSeq (o antes)? */
    private fun loadedFrom(messages: List<MessageDTO>, lastReadSeq: Long): Boolean = (messages.firstOrNull()?.seq ?: Long.MAX_VALUE) <= lastReadSeq + 1

    /** Hay que cargar más antiguos para ver el primer no leído. */
    fun needsOlder(messages: List<MessageDTO>, lastReadSeq: Long, unread: Int, me: String, hasMore: Boolean): Boolean =
        unread > 0 && hasMore && firstUnreadSeq(messages, lastReadSeq, unread, me, hasMore) == null

    /** Menciones a mí (o a todos) sin leer, después de [afterSeq], en orden cronológico. */
    fun unreadMentionSeqs(messages: List<MessageDTO>, afterSeq: Long, me: String): List<Long> =
        messages.filter { it.seq > afterSeq && countable(it, me) && it.mentions.any { m -> m.userId == me || m.userId == "all" } }.map { it.seq }
}
