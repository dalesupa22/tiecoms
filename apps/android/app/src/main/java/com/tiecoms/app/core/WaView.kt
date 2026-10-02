package com.tiecoms.app.core

/**
 * Pantalla WhatsApp (2-oct-2026): cabecera compacta, orden con los fijados en WhatsApp arriba y el punto de color
 * de la cuenta cuando hay más de una. Lógica pura (se prueba en la JVM).
 */
object WaView {
    /** Resumen de la línea «● N cuentas conectadas ›»: [connected] de [total]; [waiting] = alguna esperando QR o código. */
    data class Summary(val connected: Int, val total: Int, val waiting: Boolean) {
        val allConnected: Boolean get() = total > 0 && connected == total
    }
    fun summary(accounts: List<WaAccountDTO>) = Summary(
        connected = accounts.count { it.status == "connected" }, total = accounts.size,
        waiting = accounts.any { it.status == "pending" || it.status == "qr" || it.status == "reconnecting" },
    )

    /** Fijados en WhatsApp arriba; luego lo más reciente. Estable por cuenta y jid. */
    val order: Comparator<WaChatDTO> = compareByDescending<WaChatDTO> { it.pinned }.thenByDescending { it.lastMessageAt ?: "" }.thenBy { it.accountId }.thenBy { it.jid }
    fun sort(chats: List<WaChatDTO>): List<WaChatDTO> = chats.distinctBy { it.accountId to it.jid }.sortedWith(order)

    /** Colores del punto de cuenta (en el orden de las cuentas). */
    val ACCOUNT_COLORS = listOf(0xFF1FA855, 0xFF3B82F6, 0xFFF59E0B, 0xFF9333EA, 0xFFEF4444)
    /** Color del punto de una cuenta, o null si hay una sola (no hace falta distinguir). */
    fun accountColor(accounts: List<WaAccountDTO>, accountId: String): Long? {
        if (accounts.size < 2) return null
        val i = accounts.indexOfFirst { it.id == accountId }
        return if (i < 0) null else ACCOUNT_COLORS[i % ACCOUNT_COLORS.size]
    }

    /** Contador del chip de categoría: null mientras carga (no se muestra «0» que luego salta). */
    fun chipCount(counts: Map<String, WaCount>, loaded: Boolean, category: String?): Int? {
        if (!loaded) return null
        return if (category == null) counts.values.sumOf { it.total } else counts[category]?.total ?: 0
    }

    /** Cambio optimista de un chat en la lista (fijar en WhatsApp, ocultar…): reemplaza y reordena; oculto sale si no se ven los ocultos. */
    fun applyLocal(chats: List<WaChatDTO>, up: WaChatDTO, showHidden: Boolean): List<WaChatDTO> {
        val out = chats.map { if (it.accountId == up.accountId && it.jid == up.jid) up else it }
        return sort(if (!showHidden && up.hidden) out.filterNot { it.accountId == up.accountId && it.jid == up.jid } else out)
    }

    /** «💼 Solo trabajo»: categorías que quedan (trabajo y clientes; WaCategory del API). */
    val WORK = setOf("trabajo", "clientes")
    fun isWork(c: WaChatDTO) = c.category in WORK
    /** Pantalla WhatsApp con «Solo trabajo»: solo trabajo y clientes. */
    fun workFilter(chats: List<WaChatDTO>, workOnly: Boolean): List<WaChatDTO> = if (!workOnly) chats else chats.filter(::isWork)
    /** Contador del chip «💼 Solo trabajo» (null mientras carga). */
    fun workCount(counts: Map<String, WaCount>, loaded: Boolean): Int? = if (!loaded) null else WORK.sumOf { counts[it]?.total ?: 0 }
    /** Bandeja (Grupos/DMs) con «Solo trabajo»: se esconden los de otras categorías, salvo los fijados en la pantalla principal. */
    fun inboxFilter(waInbox: List<WaChatDTO>, workOnly: Boolean): List<WaChatDTO> = if (!workOnly) waInbox else waInbox.filter { it.inboxPinnedAt != null || isWork(it) }
}
