package com.tiecoms.app.core

/** Bounded, session-owned decisions. No network or suspended work is allowed inside [deliver]. */
class NoticeLedger(private val capacity: Int = 300) {
    enum class Decision { SHOWN, OPEN, SILENCED }
    private var owner: Any? = null
    private val decisions = LinkedHashMap<String, Decision>()

    @Synchronized fun clear() { owner = null; decisions.clear() }
    /** Delayed logout A may clear A, but never notifications already presented for session B. */
    @Synchronized fun clearOwned(session: Any, action: () -> Unit): Boolean {
        if (owner != session) return false
        action(); clear()
        return true
    }
    @Synchronized fun decision(key: String?): Decision? = key?.let { decisions[it] }

    /** Legacy non-message callers; message delivery uses [deliver] so failure does not consume the key. */
    @Synchronized fun claim(key: String?, decision: Decision): Decision? {
        if (key == null) return null
        decisions[key]?.let { return it }
        remember(key, decision)
        return null
    }

    /**
     * Decision and synchronous presentation are one short critical section. A second transport waits
     * for the first publication result; failure leaves its fallback available. Policy-silenced/open
     * messages are deliberate decisions and stay deduplicated even if preferences later change.
     */
    @Synchronized fun deliver(
        session: Any, key: String?, decide: () -> Notices.Outcome,
        ownerChanged: () -> Unit = {}, opened: () -> Unit = {}, present: () -> Boolean,
    ): Notices.Outcome {
        if (owner != session) {
            val changingAccount = owner != null
            if (changingAccount) decisions.clear()
            owner = session
            if (changingAccount) ownerChanged()
        }
        if (key != null && decisions.containsKey(key)) return Notices.Outcome.DUPLICATE
        val outcome = decide()
        val decision = when (outcome) {
            Notices.Outcome.SHOW -> {
                if (!runCatching(present).getOrDefault(false)) return Notices.Outcome.NOT_DELIVERED
                Decision.SHOWN
            }
            Notices.Outcome.OPEN -> { opened(); Decision.OPEN }
            Notices.Outcome.DND, Notices.Outcome.MUTED, Notices.Outcome.BLOCKED -> Decision.SILENCED
            else -> return outcome
        }
        if (key != null) remember(key, decision)
        return outcome
    }

    /** Serialize cancellation with publication, but retain decisions so late FCM cannot revive a chat. */
    @Synchronized fun cancel(action: () -> Unit) { action() }

    private fun remember(key: String, decision: Decision) {
        decisions[key] = decision
        while (decisions.size > capacity) decisions.remove(decisions.keys.first())
    }
}

object Notices {
    enum class Outcome { SHOW, DUPLICATE, DND, MUTED, BLOCKED, OPEN, LIVE_ONLY, NOT_DELIVERED }
    val MESSAGE_TYPES = setOf("message", "mention", "side")
    private val IGNORE_MUTE = setOf("event", "reminder", "issue")

    data class PushContext(
        val foreground: Boolean, val live: Boolean, val dnd: Boolean,
        val convKnown: Boolean, val convMutedUntil: String?,
        /** The incoming message is applied in the visible conversation, not merely an old loaded page. */
        val openAndLoaded: Boolean, val nowMs: Long,
        val blocked: Boolean = false,
        val soundsEnabled: Boolean = true,
    )

    fun dedupeKey(p: PushMessage): String? =
        if (p.type == "event" && p.minutes != null) "soon:" + p.eventId else if (p.type == "reaction") null else p.messageId

    fun forPush(
        ledger: NoticeLedger, p: PushMessage, ctx: PushContext, session: Any = Unit,
        ownerChanged: () -> Unit = {}, opened: () -> Unit = {}, present: () -> Boolean = { true },
    ): Outcome {
        if (p.type !in MESSAGE_TYPES && ctx.foreground && ctx.live) return Outcome.LIVE_ONLY
        return ledger.deliver(session, dedupeKey(p), { policy(p.type, ctx) }, ownerChanged, { if (ctx.soundsEnabled) opened() }, present)
    }

    fun forLive(
        ledger: NoticeLedger, messageId: String, ctx: PushContext, mentioned: Boolean,
        session: Any = Unit, ownerChanged: () -> Unit = {}, opened: () -> Unit = {}, present: () -> Boolean = { true },
    ): Outcome = ledger.deliver(session, messageId, { policy(if (mentioned) "mention" else "message", ctx) }, ownerChanged, { if (ctx.soundsEnabled) opened() }, present)

    /** Convenience for pure decision tests; runtime always supplies the complete current policy context. */
    fun forLive(ledger: NoticeLedger, messageId: String, openAndLoaded: Boolean): Outcome = forLive(
        ledger, messageId, PushContext(true, true, false, false, null, openAndLoaded, 0), false,
    )

    fun silenced(ledger: NoticeLedger, messageId: String, session: Any = Unit, ownerChanged: () -> Unit = {}) {
        ledger.deliver(session, messageId, { Outcome.MUTED }, ownerChanged) { false }
    }

    private fun policy(type: String, ctx: PushContext): Outcome = when {
        ctx.blocked -> Outcome.BLOCKED
        ctx.dnd -> Outcome.DND
        ctx.convKnown && type !in IGNORE_MUTE && !Silence.notifies(ctx.convMutedUntil, type == "mention", null, ctx.nowMs) -> Outcome.MUTED
        type in MESSAGE_TYPES && ctx.foreground && ctx.openAndLoaded -> Outcome.OPEN
        else -> Outcome.SHOW
    }

    fun openAndLoaded(
        foreground: Boolean, openConversationId: String?, conversationId: String, state: ClientState,
        messageId: String?,
    ): Boolean = foreground && openConversationId == conversationId && messageId != null &&
        state.conversations[conversationId]?.let { it.loaded && it.messages.any { m -> m.id == messageId } } == true
}
