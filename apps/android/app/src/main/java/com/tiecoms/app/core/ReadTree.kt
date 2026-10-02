package com.tiecoms.app.core

import kotlinx.serialization.Serializable

/**
 * Pendientes del árbol (docs/TANDA-LECTURA-REUNIONES.md §1, la misma regla en web, iOS y Android).
 *
 * El caso de Danny: «Estudio Norte · General» tenía todo leído (unread 0, el menú ofrecía «Marcar como no leído»),
 * pero dos conversaciones derivadas que nunca abrió sumaban 11. La fila las sumaba en «💬 11» sin decir dónde,
 * y los filtros solo miraban el unread propio.
 *
 *   pendientesDelÁrbol(g) = g.unread + Σ x.unread de las conversaciones con x.parentId == g.id y deriveKind != 'side'
 *   (en las que participo: las que trae el snapshot). Los sidechats cuentan en DMs. Menciones igual, con unreadMentions.
 *
 * Esa cifra manda en la sección y el filtro «No leídos», en el globo de Grupos y en el menú de la fila.
 * Como en todo Inicio, una conversación silenciada con no leídos cuenta como leída ([HomeTree.pending]).
 */
object ReadTree {
    /** Una derivada directa del grupo (hilo, rama, interna o directiva; nunca un sidechat). */
    data class Child(val c: ConversationDTO, val pending: Int, val unread: Int, val mentions: Int) {
        /** Tiene algo sin leer (aunque esté silenciada: «Marcar como leído» también la limpia). */
        val hasUnread: Boolean get() = unread > 0 || mentions > 0
    }

    data class Pending(
        /** No leídos propios que cuentan (sin silenciadas). */
        val own: Int,
        /** No leídos de las derivadas que cuentan: el chip «⑂ N». */
        val threads: Int,
        val ownMentions: Int,
        val threadMentions: Int,
        /** No leídos propios aunque esté silenciada (para decidir el menú). */
        val ownRaw: Int,
        val children: List<Child>,
    ) {
        /** pendientesDelÁrbol. */
        val total: Int get() = own + threads
        val mentions: Int get() = ownMentions + threadMentions
        /** Derivadas con algo sin leer (la lista «Ver» del chat y los items de read-tree). */
        val pendingChildren: List<Child> get() = children.filter { it.hasUnread }
        /** Cuántas derivadas tienen no leídos que cuentan (la franja «en X conversaciones»). */
        val childrenWithPending: Int get() = children.count { it.pending > 0 || it.mentions > 0 }
        /** El menú ofrece «Marcar como leído» (si no, «Marcar como no leído»). */
        val markable: Boolean get() = total > 0 || mentions > 0 || ownRaw > 0 || children.any { it.hasUnread }
    }

    val EMPTY = Pending(0, 0, 0, 0, 0, emptyList())

    /** Derivada que cuenta en el árbol de su padre: tiene padre y no es sidechat. */
    fun isTreeChild(c: ConversationDTO): Boolean = c.parentId != null && c.deriveKind != "side"

    private fun pendingOf(root: ConversationDTO, kids: List<ConversationDTO>, nowMs: Long): Pending {
        val children = kids.map { Child(it, HomeTree.pending(it, nowMs), it.unread, it.unreadMentions) }
        return Pending(
            own = HomeTree.pending(root, nowMs), threads = children.sumOf { it.pending },
            ownMentions = root.unreadMentions, threadMentions = children.sumOf { it.mentions },
            ownRaw = root.unread, children = children,
        )
    }

    /** Pendientes del árbol de [root] (sus derivadas directas). */
    fun of(d: BootstrapDTO, root: ConversationDTO, nowMs: Long = System.currentTimeMillis()): Pending =
        pendingOf(root, d.conversations.filter { isTreeChild(it) && it.parentId == root.id }, nowMs)

    /** Todos de una vez (id → pendientes), para ordenar y filtrar listas sin recorrer el snapshot por fila. */
    fun all(d: BootstrapDTO, nowMs: Long = System.currentTimeMillis()): Map<String, Pending> {
        val kids = d.conversations.filter { isTreeChild(it) }.groupBy { it.parentId!! }
        return d.conversations.associate { it.id to pendingOf(it, kids[it.id].orEmpty(), nowMs) }
    }

    /**
     * Items de POST /conversations/:id/read-tree: el grupo y cada derivada con algo sin leer, cada uno hasta el
     * lastMessageSeq que el cliente CONOCE. Lo que llegue después (seq mayor) sigue sin leer: no hay carrera.
     * El grupo va siempre (el servidor exige al menos uno y no baja un cursor que ya está más adelante).
     */
    fun items(d: BootstrapDTO, root: ConversationDTO, nowMs: Long = System.currentTimeMillis()): List<ReadTreeItem> {
        val p = of(d, root, nowMs)
        return listOf(ReadTreeItem(root.id, root.lastMessageSeq)) +
            p.pendingChildren.map { ReadTreeItem(it.c.id, it.c.lastMessageSeq) }.take(MAX_ITEMS - 1)
    }

    /** Tope del contrato (MarkTreeReadInput: 1..200). */
    const val MAX_ITEMS = 200

    /**
     * Metadatos tras marcar hasta [seq]: el cursor nunca retrocede y lo que llegó después del seq enviado sigue
     * contando. Las menciones se limpian solo si ya no queda nada por leer.
     */
    /** Server revision orders deliberate unread, viewport ACKs and socket events together. */
    fun applyCursor(c: ConversationDTO, seq: Long, revision: Long?, legacyDecrease: Boolean = false): ConversationDTO {
        if (revision != null) {
            if (revision <= (c.readRevision ?: -1)) return c
        } else if (c.readRevision != null) return c // A revision-less response cannot overwrite modern state.
        val read = if (revision != null || legacyDecrease) seq else maxOf(c.lastReadSeq, seq)
        return c.copy(lastReadSeq = read, readRevision = revision ?: c.readRevision,
            unread = maxOf(0L, c.lastMessageSeq - maxOf(read, c.historyFromSeq)).toInt(),
            unreadMentions = if (read >= c.lastMessageSeq) 0 else c.unreadMentions)
    }

    fun applyRead(c: ConversationDTO, seq: Long): ConversationDTO {
        val read = maxOf(c.lastReadSeq, seq)
        val unread = maxOf(0L, c.lastMessageSeq - maxOf(read, c.historyFromSeq)).toInt()
        return c.copy(lastReadSeq = read, unread = unread, unreadMentions = if (read >= c.lastMessageSeq) 0 else c.unreadMentions)
    }
}

@Serializable data class ReadTreeItem(val conversationId: String, val seq: Long)
@Serializable data class ReadTreeBody(val items: List<ReadTreeItem>)
@Serializable data class ReadTreeMarked(val conversationId: String = "", val lastReadSeq: Long = 0, val readRevision: Long? = null)
@Serializable data class ReadTreeResult(val marked: List<ReadTreeMarked> = emptyList())
