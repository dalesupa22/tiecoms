package com.tiecoms.app.core

/**
 * Registro compartido de avisos por messageId (socket en vivo y FCM), con la decisión tomada.
 *
 * El socket y FCM pueden traer el mismo mensaje en cualquier orden. El primero que decide
 * deja constancia aquí: el segundo no vuelve a mostrarlo. «Sin aviso» también es una decisión
 * (silenciado, «No molestar», chat abierto y cargado): un FCM tardío del mismo mensaje no
 * debe aparecer después. LRU de [capacity] entradas, como el antiguo `Notifier.firstTime`.
 */
class NoticeLedger(private val capacity: Int = 300) {
    enum class Decision { SHOWN, OPEN, SILENCED }

    private val decisions = LinkedHashMap<String, Decision>()

    /** Registra [decision] si [key] aún no tenía una. Devuelve la previa (null = la registró esta llamada). */
    fun claim(key: String?, decision: Decision): Decision? {
        if (key == null) return null
        synchronized(decisions) {
            decisions[key]?.let { return it }
            decisions[key] = decision
            while (decisions.size > capacity) decisions.remove(decisions.keys.first())
        }
        return null
    }

    fun decision(key: String?): Decision? = key?.let { synchronized(decisions) { decisions[it] } }
}

/**
 * Cuándo se presenta un aviso de mensaje (incidencia 28-sep-2026: FCM en primer plano se descartaba
 * en bloque si el socket estaba en línea, aunque el socket no hubiera avisado: conversación desconocida,
 * hueco/catch-up, mensaje anterior a la reconexión tras un despliegue).
 */
object Notices {
    enum class Outcome {
        /** Mostrar la notificación. */
        SHOW,
        /** Ya decidido antes (mostrado, silenciado o visto en el chat abierto). */
        DUPLICATE,
        DND,
        MUTED,
        /** La conversación está en pantalla, en primer plano y cargada: el mensaje se ve ahí. */
        OPEN,
        /** Aviso que no es un mensaje (recordatorio, reunión, reacción, tarea) con la app en vivo: lo da el socket. */
        LIVE_ONLY,
    }

    /** Pushes que son un mensaje de conversación: los mismos que el socket anuncia con [ClientSignal.Incoming]. */
    val MESSAGE_TYPES = setOf("message", "mention", "side")

    /** Tipos que avisan aunque el chat esté silenciado (igual que el filtro del servidor). */
    private val IGNORE_MUTE = setOf("event", "reminder", "issue")

    data class PushContext(
        val foreground: Boolean,
        /** Sesión lista y socket en línea. */
        val live: Boolean,
        /** «No molestar» o «Todas las noches» activos. */
        val dnd: Boolean,
        /** La conversación está en el snapshot local (si no, no hay silencio que aplicar). */
        val convKnown: Boolean,
        val convMutedUntil: String?,
        /** [openAndLoaded] para la conversación del push. */
        val openAndLoaded: Boolean,
        val nowMs: Long,
    )

    /** Clave de deduplicación de un push (null = no se deduplica: la reacción comparte messageId con el mensaje). */
    fun dedupeKey(p: PushMessage): String? =
        if (p.type == "event" && p.minutes != null) "soon:" + p.eventId else if (p.type == "reaction") null else p.messageId

    /** Decisión para un push de FCM. Registra la decisión en [ledger] (salvo [Outcome.LIVE_ONLY]). */
    fun forPush(ledger: NoticeLedger, p: PushMessage, ctx: PushContext): Outcome {
        val isMessage = p.type in MESSAGE_TYPES
        // Recordatorios, reuniones, reacciones y tareas: con la app en vivo los anuncia el socket (sin cambios).
        if (!isMessage && ctx.foreground && ctx.live) return Outcome.LIVE_ONLY
        val key = dedupeKey(p)
        if (ledger.decision(key) != null) return Outcome.DUPLICATE
        // SPEC-silencio: con «No molestar» el servidor ya no manda push; si llega uno (servidor viejo, carrera), no se muestra.
        if (ctx.dnd) return record(ledger, key, NoticeLedger.Decision.SILENCED, Outcome.DND)
        // Chat silenciado: solo pasa la mención (salvo el silencio «siempre»).
        if (ctx.convKnown && p.type !in IGNORE_MUTE && !Silence.notifies(ctx.convMutedUntil, p.type == "mention", null, ctx.nowMs))
            return record(ledger, key, NoticeLedger.Decision.SILENCED, Outcome.MUTED)
        if (isMessage && ctx.foreground && ctx.openAndLoaded) return record(ledger, key, NoticeLedger.Decision.OPEN, Outcome.OPEN)
        return record(ledger, key, NoticeLedger.Decision.SHOWN, Outcome.SHOW)
    }

    /**
     * Decisión para un mensaje recibido en vivo por el socket ([ClientSignal.Incoming]: ya pasó silencio y
     * «No molestar» en el cliente). [Outcome.OPEN]: solo sonido de recepción; [Outcome.DUPLICATE]: ya avisó FCM.
     */
    fun forLive(ledger: NoticeLedger, messageId: String, openAndLoaded: Boolean): Outcome =
        if (openAndLoaded) record(ledger, messageId, NoticeLedger.Decision.OPEN, Outcome.OPEN)
        else record(ledger, messageId, NoticeLedger.Decision.SHOWN, Outcome.SHOW)

    /** El cliente decidió «sin aviso» (silencio o «No molestar») para un mensaje en vivo: un FCM tardío tampoco avisa. */
    fun silenced(ledger: NoticeLedger, messageId: String) { ledger.claim(messageId, NoticeLedger.Decision.SILENCED) }

    /**
     * «Abierta» exige «cargada»: si el chat no cargó (p. ej. un 502 durante un despliegue) la pantalla está
     * vacía y no puede callar los avisos de esa conversación.
     */
    fun openAndLoaded(foreground: Boolean, openConversationId: String?, conversationId: String, state: ClientState): Boolean =
        foreground && openConversationId == conversationId && state.conversations[conversationId]?.loaded == true

    private fun record(ledger: NoticeLedger, key: String?, d: NoticeLedger.Decision, outcome: Outcome): Outcome =
        if (ledger.claim(key, d) == null) outcome else Outcome.DUPLICATE
}
