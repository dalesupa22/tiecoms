package com.tiecoms.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** CH038: tono de «llamando» para quien llama (Calls.shouldRingback). */
class RingbackTest {
    private fun call(startedBy: String = "me", active: List<String> = listOf("me"), guests: List<CallGuestDTO>? = null, ended: String? = null) =
        CallDTO(id = "k1", conversationId = "c1", startedBy = startedBy, activeUserIds = active, guests = guests, endedAt = ended)

    private fun ring(c: CallDTO?, me: String? = "me", guest: Boolean = false, live: Boolean = true, elapsed: Long = 1_000, seen: Boolean = false) =
        Calls.shouldRingback(c, me, guest, live, elapsed, seen)

    @Test fun `suena si yo llamo y estoy solo`() {
        assertTrue(ring(call()))
        // Aunque el servidor todavía no me cuente dentro.
        assertTrue(ring(call(active = emptyList())))
        assertTrue(ring(call(), elapsed = 0))
    }

    @Test fun `no suena para quien recibe ni al entrar a una llamada de otro`() {
        assertFalse(ring(call(startedBy = "u2", active = listOf("u2", "me"))))
        assertFalse(ring(call(startedBy = "u2", active = listOf("me"))))
    }

    @Test fun `se corta cuando entra alguien`() {
        assertFalse(ring(call(active = listOf("me", "u2"))))
        // Un invitado por enlace también cuenta.
        assertFalse(ring(call(guests = listOf(CallGuestDTO("g1", "Ana")))))
        // Ya entró alguien antes (aunque haya salido): no vuelve a sonar.
        assertFalse(ring(call(), seen = true))
    }

    @Test fun `mis otros dispositivos no cuentan como otra persona`() {
        assertTrue(ring(call(active = listOf("me", "me"))))
    }

    @Test fun `se corta a los 45 s`() {
        assertTrue(ring(call(), elapsed = Calls.RING_MS - 1))
        assertFalse(ring(call(), elapsed = Calls.RING_MS))
        assertFalse(ring(call(), elapsed = Calls.RING_MS + 10_000))
        assertFalse(ring(call(), elapsed = -1))
    }

    @Test fun `no suena sin audio conectado, terminada, como invitado o sin llamada`() {
        assertFalse(ring(call(), live = false))
        assertFalse(ring(call(ended = "2026-11-19T10:00:00Z")))
        assertFalse(ring(call(startedBy = GuestCalls.externalId("g1"), active = emptyList()), me = GuestCalls.externalId("g1"), guest = true))
        assertFalse(ring(null))
        assertFalse(ring(call(), me = null))
        assertFalse(ring(call(startedBy = ""), me = ""))
    }

    @Test fun `othersIn`() {
        assertFalse(Calls.othersIn(call(), "me"))
        assertTrue(Calls.othersIn(call(active = listOf("me", "u2")), "me"))
        assertTrue(Calls.othersIn(call(active = emptyList(), guests = listOf(CallGuestDTO("g1"))), "me"))
    }
}
