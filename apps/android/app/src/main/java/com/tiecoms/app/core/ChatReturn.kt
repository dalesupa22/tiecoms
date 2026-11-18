package com.tiecoms.app.core

/** CH035 (fluidez): reglas puras de «volver al chat» y de dónde aterriza un salto. */
object ChatReturn {
    /** El salto con que se abrió el chat (seq o id del mensaje) se hace una sola vez; al volver a la pantalla ya no. */
    fun shouldJump(consumed: Boolean, jumpSeq: Long?, jumpMessageId: String?): Boolean =
        !consumed && ((jumpSeq ?: 0) > 0 || jumpMessageId != null)

    /** «Seguir el final» al entrar: solo si la lista (nueva o restaurada) está en el final. */
    fun followAt(firstVisibleIndex: Int): Boolean = firstVisibleIndex <= 1

    /** Desplazamiento del mensaje al que se salta, en una lista invertida: a un tercio del alto desde abajo. */
    fun landingOffset(viewportPx: Int): Int = -(viewportPx.coerceAtLeast(0) / 3)
}

/** Cargas hechas hace poco (por clave): quien vuelve dentro de la ventana no las repite. */
class RecentLoads(private val windowMs: Long) {
    private val at = HashMap<String, Long>()

    /** true = toca cargar (y queda anotado); false = se hizo hace menos de [windowMs]. */
    @Synchronized fun claim(key: String, now: Long): Boolean {
        val last = at[key]
        if (last != null && now - last in 0 until windowMs) return false
        if (at.size > 200) at.clear()
        at[key] = now
        return true
    }

    /** Una carga falló o se canceló: la próxima entrada la repite. */
    @Synchronized fun release(key: String) { at.remove(key) }
}

/** Volver a primer plano o recuperar la red con el socket conectado: cuándo sobra pedir todo otra vez (como PERF-C1 en la web). */
object ResyncRule {
    const val WINDOW_MS = 30_000L

    /**
     * Con cuentas de WhatsApp no se omite nunca: al volver se invalida su privacidad y solo el resync la restablece.
     * [lastAt] = 0 significa que todavía no hubo un resync completo.
     */
    fun skip(hasWhatsApp: Boolean, lastAt: Long, now: Long): Boolean =
        !hasWhatsApp && lastAt > 0 && now - lastAt in 0 until WINDOW_MS

    /** El snapshot nuevo solo difiere en la hora del servidor: se conserva el anterior y nadie se repinta. */
    fun unchanged(old: BootstrapDTO?, new: BootstrapDTO): Boolean = old != null && new.copy(serverTime = old.serverTime) == old
}

/**
 * Caché en memoria acotada por bytes y atada a una sesión: al cambiar de sesión se vacía sola.
 * Sin Android (LinkedHashMap en orden de acceso) para poder probarla.
 */
class SessionLru<V : Any>(private val maxBytes: Long, private val sizeOf: (V) -> Int) {
    private val map = LinkedHashMap<String, V>(16, 0.75f, true)
    private var bytes = 0L
    private var session = Long.MIN_VALUE

    @Synchronized fun get(session: Long, key: String): V? {
        if (session != this.session) { clear(); return null }
        return map[key]
    }

    @Synchronized fun put(session: Long, key: String, value: V) {
        if (session != this.session) { clear(); this.session = session }
        val size = sizeOf(value).toLong()
        if (size > maxBytes) return
        map.put(key, value)?.let { bytes -= sizeOf(it) }
        bytes += size
        val it = map.entries.iterator()
        while (bytes > maxBytes && it.hasNext()) { val e = it.next(); if (e.key == key) continue; bytes -= sizeOf(e.value); it.remove() }
    }

    @Synchronized fun clear() { map.clear(); bytes = 0; session = Long.MIN_VALUE }

    @get:Synchronized val size: Int get() = map.size
}
