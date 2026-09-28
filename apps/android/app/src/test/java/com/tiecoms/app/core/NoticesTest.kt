package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * Incidencia Alicia → Danny (28-sep-2026): un FCM en primer plano con el socket en línea se descartaba sin
 * comprobar que el socket hubiera avisado. Reglas: un aviso por messageId entre socket y FCM, en cualquier
 * orden; lo no anunciado se muestra con las reglas locales (DND, silencio, chat abierto y cargado).
 */
class NoticesTest {
    private val now = Instant.parse("2026-09-28T15:10:00Z").toEpochMilli()
    private val conv = "dm-alicia-danny"

    private fun push(id: String = "m-33", type: String = "message", conversationId: String = conv) = PushMessage(
        type = type, title = "Alicia", subtitle = "", body = "Hola", badge = 1, threadId = conversationId, category = "TC_MESSAGE",
        conversationId = conversationId, messageId = id, authorId = "alicia", authorName = "Alicia", authorAvatarUrl = null,
        reminderId = null, eventId = null,
    )

    /** Primer plano, sesión lista y socket en línea: el caso que antes se descartaba en bloque. */
    private fun fg(
        dnd: Boolean = false, known: Boolean = true, mutedUntil: String? = null, openAndLoaded: Boolean = false,
        foreground: Boolean = true, live: Boolean = true,
    ) = Notices.PushContext(foreground, live, dnd, known, mutedUntil, openAndLoaded, now)

    @Test fun `FCM en primer plano sin aviso local se muestra una vez`() {
        val ledger = NoticeLedger()
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push(), fg()))
        // FCM repetido (reintento del servidor o del transporte): no se duplica.
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forPush(ledger, push(), fg()))
    }

    @Test fun `aviso local y luego FCM dan uno solo`() {
        val ledger = NoticeLedger()
        assertEquals(Notices.Outcome.SHOW, Notices.forLive(ledger, "m-33", openAndLoaded = false))
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forPush(ledger, push(), fg()))
        // También con la app ya en segundo plano cuando llega el FCM.
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forPush(ledger, push(), fg(foreground = false, live = false)))
    }

    @Test fun `FCM y luego aviso local dan uno solo`() {
        val ledger = NoticeLedger()
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push(), fg()))
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forLive(ledger, "m-33", openAndLoaded = false))
    }

    @Test fun `conversacion abierta y cargada no avisa`() {
        val ledger = NoticeLedger()
        assertEquals(Notices.Outcome.OPEN, Notices.forPush(ledger, push(), fg(openAndLoaded = true)))
        // El mensaje ya se vio en el chat: un FCM tardío después de salir no lo muestra.
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forPush(ledger, push(), fg(openAndLoaded = false)))
        // Aviso local en el chat abierto y cargado: solo sonido de recepción, y el FCM posterior tampoco.
        val l2 = NoticeLedger()
        assertEquals(Notices.Outcome.OPEN, Notices.forLive(l2, "m-40", openAndLoaded = true))
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forPush(l2, push("m-40"), fg()))
    }

    @Test fun `conversacion abierta pero no cargada si avisa`() {
        val loading = ClientState(conversations = mapOf(conv to ConversationState(loaded = false, loading = true)))
        val failed = ClientState(conversations = mapOf(conv to ConversationState(loaded = false, loading = false)))
        val loaded = ClientState(conversations = mapOf(conv to ConversationState(loaded = true, messages = listOf(MessageDTO(id = "m-33", conversationId = conv)))))
        assertFalse(Notices.openAndLoaded(true, conv, conv, failed, "m-33"))
        assertFalse(Notices.openAndLoaded(true, conv, conv, loading, "m-33"))
        assertFalse("Sin estado local (502 antes del primer GET)", Notices.openAndLoaded(true, conv, conv, ClientState(), "m-33"))
        assertFalse("En segundo plano no hay nada abierto", Notices.openAndLoaded(false, conv, conv, loaded, "m-33"))
        assertFalse("Otra conversación abierta", Notices.openAndLoaded(true, "otra", conv, loaded, "m-33"))
        assertTrue(Notices.openAndLoaded(true, conv, conv, loaded, "m-33"))

        val ledger = NoticeLedger()
        val open = Notices.openAndLoaded(true, conv, conv, failed, "m-33")
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push(), fg(openAndLoaded = open)))
        assertEquals(Notices.Outcome.SHOW, Notices.forLive(NoticeLedger(), "m-34", openAndLoaded = open))
    }

    @Test fun `silenciada sin mencion no avisa y con mencion si`() {
        val hour = "2026-09-28T16:10:00Z"
        val ledger = NoticeLedger()
        assertEquals(Notices.Outcome.MUTED, Notices.forPush(ledger, push("m-1"), fg(mutedUntil = hour)))
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push("m-2", type = "mention"), fg(mutedUntil = hour)))
        // Silencio «siempre»: tampoco la mención.
        assertEquals(Notices.Outcome.MUTED, Notices.forPush(ledger, push("m-3", type = "mention"), fg(mutedUntil = Silence.FOREVER)))
        // En segundo plano, igual.
        assertEquals(Notices.Outcome.MUTED, Notices.forPush(ledger, push("m-4"), fg(mutedUntil = hour, foreground = false, live = false)))
        // Silencio vencido: avisa.
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push("m-5"), fg(mutedUntil = "2026-09-28T15:00:00Z")))
    }

    @Test fun `decision local sin aviso por silencio o DND no deja pasar el FCM`() {
        val ledger = NoticeLedger()
        Notices.silenced(ledger, "m-7")
        // Aunque al llegar el FCM ya no esté silenciada (se reactivó en medio), el mensaje ya se decidió.
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forPush(ledger, push("m-7"), fg()))
    }

    @Test fun `DND no avisa`() {
        val ledger = NoticeLedger()
        assertEquals(Notices.Outcome.DND, Notices.forPush(ledger, push(), fg(dnd = true)))
        assertEquals(Notices.Outcome.DND, Notices.forPush(ledger, push("m-9", type = "mention"), fg(dnd = true, foreground = false, live = false)))
        // DND incluso por encima del chat abierto o desconocido.
        assertEquals(Notices.Outcome.DND, Notices.forPush(ledger, push("m-10"), fg(dnd = true, known = false)))
    }

    @Test fun `catch-up o hueco sin aviso local y luego FCM si avisa`() {
        // El socket aplicó el mensaje por catch-up (o era anterior a la reconexión): no hubo Incoming.
        val ledger = NoticeLedger()
        assertNull(ledger.decision("m-33"))
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push(), fg()))
        // Luego el despacho tardío del socket no duplica.
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forLive(ledger, "m-33", openAndLoaded = false))
    }

    @Test fun `conversacion desconocida en primer plano si avisa`() {
        // DM nuevo que aún no está en el snapshot: el socket no anuncia (bumpMeta sin meta).
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(NoticeLedger(), push(conversationId = "nueva"), fg(known = false)))
    }

    @Test fun `avisos que no son mensajes siguen siendo del socket con la app en vivo`() {
        val ledger = NoticeLedger()
        for (t in listOf("reminder", "event", "reaction", "issue"))
            assertEquals(t, Notices.Outcome.LIVE_ONLY, Notices.forPush(ledger, push("x-$t", type = t), fg()))
        // Sin socket en línea (o en segundo plano) sí pasan, sin mirar el silencio del chat.
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push("x-rem", type = "reminder"), fg(live = false, mutedUntil = Silence.FOREVER)))
        // Sidechat es un mensaje: el mismo registro que el socket.
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push("s-1", type = "side"), fg()))
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forLive(ledger, "s-1", openAndLoaded = false))
    }

    @Test fun `aviso de reunion y reaccion conservan sus claves`() {
        val soon = push(type = "event").copy(eventId = "ev1", minutes = 10, messageId = null)
        assertEquals("soon:ev1", Notices.dedupeKey(soon))
        assertNull(Notices.dedupeKey(push(type = "reaction")))
        val ledger = NoticeLedger()
        // La misma clave que usa el aviso local `soon:` (Notifier.firstTime).
        assertNull(ledger.claim("soon:ev1", NoticeLedger.Decision.SHOWN))
        assertEquals(Notices.Outcome.DUPLICATE, Notices.forPush(ledger, soon, fg(foreground = false, live = false)))
        // Las reacciones nunca se deduplican contra el mensaje.
        Notices.forLive(ledger, "m-33", openAndLoaded = false)
        assertEquals(Notices.Outcome.SHOW, Notices.forPush(ledger, push(type = "reaction"), fg(foreground = false, live = false)))
    }

    @Test fun `registro LRU de 300 conserva la decision`() {
        val ledger = NoticeLedger(300)
        assertNull(ledger.claim("m-0", NoticeLedger.Decision.SILENCED))
        assertEquals(NoticeLedger.Decision.SILENCED, ledger.claim("m-0", NoticeLedger.Decision.SHOWN))
        for (i in 1..300) ledger.claim("m-$i", NoticeLedger.Decision.SHOWN)
        assertNull("El más antiguo sale del registro", ledger.decision("m-0"))
        assertEquals(NoticeLedger.Decision.SHOWN, ledger.decision("m-300"))
        assertNull("Sin messageId no se deduplica", ledger.claim(null, NoticeLedger.Decision.SHOWN))
    }
}
