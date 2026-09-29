package com.tiecoms.app.core

import kotlinx.serialization.Serializable

/*
 * Velocidad (fase 2 de 1.7.0): la app se pinta desde una copia local (bootstrap + los últimos 50 mensajes de las
 * ~30 conversaciones más recientes, por usuario) y se revalida en segundo plano; precarga los chats con no leídos
 * o fijados. Todo en Kotlin puro (se prueba en la JVM); el disco lo pone la plataforma ([SnapshotCache]).
 */

/** Copia local de la sesión por usuario. Se borra al cerrar sesión. */
interface SnapshotCache {
    fun read(userId: String): String?
    fun write(userId: String, json: String)
    fun clear(userId: String?)
}

object NoSnapshotCache : SnapshotCache {
    override fun read(userId: String): String? = null
    override fun write(userId: String, json: String) {}
    override fun clear(userId: String?) {}
}

class MemorySnapshotCache : SnapshotCache {
    val map = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun read(userId: String) = map[userId]
    override fun write(userId: String, json: String) { map[userId] = json }
    override fun clear(userId: String?) { if (userId == null) map.clear() else map.remove(userId) }
}

@Serializable data class CachedConversation(
    val id: String = "",
    val messages: List<MessageDTO> = emptyList(),
    val lastEventSeq: Long = 0,
    val hasMore: Boolean = true,
)

@Serializable data class SessionSnapshot(
    val v: Int = Speed.VERSION,
    val userId: String = "",
    val savedAt: Long = 0,
    val data: BootstrapDTO = BootstrapDTO(),
    val conversations: List<CachedConversation> = emptyList(),
    val blockedUserIds: List<String> = emptyList(),
)

object Speed {
    const val VERSION = 1
    const val MAX_CONVERSATIONS = 30
    const val MAX_MESSAGES = 50
    const val PREFETCH_MAX = 8
    const val PREFETCH_PARALLEL = 2
    /** Tareas no críticas del arranque: esperan el primer fotograma, como mucho esto. */
    const val FIRST_FRAME_WAIT_MS = 3_000L
    /** Escribir la copia local como mucho cada tanto (los cambios llegan en ráfagas). */
    const val SAVE_DEBOUNCE_MS = 2_000L
    /** Una copia más vieja que esto no se pinta (mejor el splash que algo muy desactualizado). */
    const val MAX_AGE_MS = 30L * 24 * 3600 * 1000

    /**
     * Qué guardar: el bootstrap entero y, de las conversaciones con mensajes en memoria, las [MAX_CONVERSATIONS] más
     * recientes con sus últimos [MAX_MESSAGES] mensajes. Los de «una sola vista» se guardan sin contenido.
     */
    fun snapshot(state: ClientState, now: Long): SessionSnapshot? {
        val d = state.data ?: return null
        if (d.me.id.isEmpty()) return null
        val recent = d.conversations.sortedByDescending { it.lastMessageAt ?: "" }.map { it.id }
        val convs = recent.asSequence().mapNotNull { id -> state.conversations[id]?.takeIf { it.loaded && it.messages.isNotEmpty() }?.let { id to it } }
            .take(MAX_CONVERSATIONS)
            .map { (id, c) ->
                val tail = c.messages.takeLast(MAX_MESSAGES).map { m -> if (m.viewOnce) m.copy(body = "", attachments = emptyList()) else m }
                CachedConversation(id, tail, c.lastEventSeq, hasMore = c.hasMore || c.messages.size > tail.size)
            }.toList()
        return SessionSnapshot(VERSION, d.me.id, now, d, convs, state.blockedUserIds.toList())
    }

    fun encode(s: SessionSnapshot): String = TcJson.encodeToString(SessionSnapshot.serializer(), s)

    /** Copia utilizable para [userId]: misma versión, mismo usuario y no demasiado vieja. */
    fun decode(json: String?, userId: String, now: Long): SessionSnapshot? {
        json ?: return null
        val s = runCatching { TcJson.decodeFromString(SessionSnapshot.serializer(), json) }.getOrNull() ?: return null
        if (s.v != VERSION || s.userId != userId || s.data.me.id != userId) return null
        if (now - s.savedAt > MAX_AGE_MS) return null
        return s
    }

    /** Conversaciones en memoria a partir de la copia: cargadas, con su cursor para recuperar lo que falta. */
    fun restore(s: SessionSnapshot): Map<String, ConversationState> {
        val allowed = s.data.conversations.map { it.id }.toSet()
        return s.conversations.filter { it.id in allowed && it.messages.isNotEmpty() }.associate {
            it.id to ConversationState(messages = it.messages.sortedBy { m -> m.seq }, lastEventSeq = it.lastEventSeq, hasMore = it.hasMore, loaded = true)
        }
    }

    /**
     * Precarga: conversaciones con no leídos (sin silenciar) o fijadas, las más recientes primero, como mucho
     * [PREFETCH_MAX]. Se saltan las que ya están en memoria y al día.
     */
    fun prefetchTargets(d: BootstrapDTO, local: Map<String, ConversationState>, nowMs: Long): List<String> =
        d.conversations.asSequence()
            .filter { (it.unread > 0 && !it.mutedAt(nowMs)) || it.pinnedAt != null }
            .filter { c -> local[c.id]?.let { !it.loaded || c.lastEventSeq > it.lastEventSeq } ?: true }
            .sortedWith(compareByDescending<ConversationDTO> { it.unread > 0 }.thenByDescending { it.lastMessageAt ?: "" })
            .take(PREFETCH_MAX).map { it.id }.toList()
}
