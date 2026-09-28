package com.tiecoms.app.core

/**
 * Navegar un chat largo (1.6.4, igual en web e iOS): abrir en el primer no leído con la línea «N mensajes nuevos»,
 * y las menciones a mí sin leer para el botón «@». Sin servidor: solo con los mensajes cargados.
 */
object ChatNav {
    private fun countable(m: MessageDTO, me: String) = m.authorId != me && m.deletedAt == null

    /**
     * Seq del primer mensaje no leído de otra persona después de un prefijo continuo desde [lastReadSeq].
     * El conteo de pendientes y hasMore=false nunca permiten saltar secuencias ausentes.
     * [messages] en orden cronológico.
     */
    fun firstUnreadSeq(messages: List<MessageDTO>, lastReadSeq: Long, unread: Int, me: String, hasMore: Boolean = false): Long? {
        if (unread <= 0) return null
        return (position(messages, lastReadSeq, unread, me, messages.lastOrNull()?.seq ?: lastReadSeq) as? Position.Ready)?.seq
    }

    sealed interface Position {
        data class Ready(val seq: Long?) : Position
        data object Incomplete : Position
    }
    /** A terminal page is not proof that skipped sequence numbers were read. */
    fun position(messages: List<MessageDTO>, floor: Long, unread: Int, me: String, lastMessageSeq: Long,
                 blocked: Set<String> = emptySet()): Position {
        if (unread <= 0) return Position.Ready(null)
        var cursor = floor
        for (message in messages.filter { it.seq > floor }) {
            if (message.seq != cursor + 1) return Position.Incomplete
            cursor = message.seq
            if (countable(message, me) && message.authorId !in blocked) return Position.Ready(message.seq)
        }
        return if (cursor >= lastMessageSeq) Position.Ready(null) else Position.Incomplete
    }

    /** ¿Lo cargado ya llega hasta justo después de lastReadSeq (o antes)? */
    private fun loadedFrom(messages: List<MessageDTO>, lastReadSeq: Long): Boolean = (messages.firstOrNull()?.seq ?: Long.MAX_VALUE) <= lastReadSeq + 1

    /** Hay que cargar más antiguos para ver el primer no leído. */
    fun needsOlder(messages: List<MessageDTO>, lastReadSeq: Long, unread: Int, me: String, hasMore: Boolean): Boolean =
        unread > 0 && hasMore && !loadedFrom(messages, lastReadSeq)

    /** Menciones a mí (o a todos) sin leer, después de [afterSeq], en orden cronológico. */
    fun unreadMentionSeqs(messages: List<MessageDTO>, afterSeq: Long, me: String): List<Long> =
        messages.filter { it.seq > afterSeq && countable(it, me) && it.mentions.any { m -> m.userId == me || m.userId == "all" } }.map { it.seq }
}
