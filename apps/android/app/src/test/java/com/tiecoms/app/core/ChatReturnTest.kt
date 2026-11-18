package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** CH035 (fluidez): volver al chat sin repetir el salto, resync acotado, caché de miniaturas por sesión. */
class ChatReturnTest {
    @Test fun routeJumpHappensOnce() {
        assertTrue(ChatReturn.shouldJump(consumed = false, jumpSeq = 42, jumpMessageId = null))
        assertTrue(ChatReturn.shouldJump(consumed = false, jumpSeq = null, jumpMessageId = "m1"))
        // Al volver de Detalles la ruta trae el mismo salto, pero ya se hizo.
        assertFalse(ChatReturn.shouldJump(consumed = true, jumpSeq = 42, jumpMessageId = null))
        assertFalse(ChatReturn.shouldJump(consumed = true, jumpSeq = null, jumpMessageId = "m1"))
        assertFalse(ChatReturn.shouldJump(consumed = false, jumpSeq = null, jumpMessageId = null))
        assertFalse(ChatReturn.shouldJump(consumed = false, jumpSeq = 0, jumpMessageId = null))
    }

    @Test fun followDependsOnRestoredPosition() {
        assertTrue(ChatReturn.followAt(0))
        assertTrue(ChatReturn.followAt(1))
        assertFalse(ChatReturn.followAt(2))
        assertFalse(ChatReturn.followAt(40))
    }

    @Test fun landingLeavesTheMessageAThirdUp() {
        assertEquals(-600, ChatReturn.landingOffset(1800))
        assertEquals(0, ChatReturn.landingOffset(0))
        assertEquals(0, ChatReturn.landingOffset(-5))
    }

    @Test fun recentLoadsAreNotRepeatedInsideTheWindow() {
        val loads = RecentLoads(15_000)
        assertTrue(loads.claim("1:c1", 1_000))
        assertFalse(loads.claim("1:c1", 5_000))
        // Otro chat y otra sesión no comparten la marca.
        assertTrue(loads.claim("1:c2", 5_000))
        assertTrue(loads.claim("2:c1", 5_000))
        assertTrue(loads.claim("1:c1", 16_000))
        // Una carga fallida o cancelada se repite en la próxima entrada.
        loads.release("1:c1")
        assertTrue(loads.claim("1:c1", 16_500))
        // El reloj retrocedió: se carga.
        assertTrue(loads.claim("1:c1", 10))
    }

    @Test fun resyncIsSkippedOnlyWhenRecentAndWithoutWhatsApp() {
        assertTrue(ResyncRule.skip(hasWhatsApp = false, lastAt = 10_000, now = 20_000))
        assertFalse(ResyncRule.skip(hasWhatsApp = false, lastAt = 10_000, now = 10_000 + ResyncRule.WINDOW_MS))
        // Nunca hubo un resync completo, o el reloj retrocedió.
        assertFalse(ResyncRule.skip(hasWhatsApp = false, lastAt = 0, now = 5_000))
        assertFalse(ResyncRule.skip(hasWhatsApp = false, lastAt = 10_000, now = 9_000))
        // Con WhatsApp, volver invalida su privacidad: siempre se pide todo.
        assertFalse(ResyncRule.skip(hasWhatsApp = true, lastAt = 10_000, now = 10_001))
    }

    @Test fun bootstrapThatOnlyMovesServerTimeIsUnchanged() {
        val old = BootstrapDTO(serverTime = "2026-11-18T10:00:00Z", me = UserDTO(id = "u1"), conversations = listOf(ConversationDTO(id = "c1", unread = 2)))
        assertTrue(ResyncRule.unchanged(old, old.copy(serverTime = "2026-11-18T10:00:30Z")))
        assertFalse(ResyncRule.unchanged(old, old.copy(conversations = listOf(ConversationDTO(id = "c1", unread = 3)))))
        assertFalse(ResyncRule.unchanged(null, old))
    }

    @Test fun sessionLruEvictsOldestAndDiesWithTheSession() {
        val lru = SessionLru<ByteArray>(100) { it.size }
        val a = ByteArray(40); val b = ByteArray(40); val c = ByteArray(40)
        lru.put(1, "a", a); lru.put(1, "b", b)
        assertSame(a, lru.get(1, "a"))          // «a» pasa a ser el más reciente
        lru.put(1, "c", c)                       // no cabe: sale «b», el menos usado
        assertNull(lru.get(1, "b"))
        assertSame(a, lru.get(1, "a")); assertSame(c, lru.get(1, "c"))
        assertEquals(2, lru.size)
        // Más grande que todo el presupuesto: no entra.
        lru.put(1, "huge", ByteArray(101)); assertNull(lru.get(1, "huge"))
        // Reemplazar una clave no duplica su peso.
        lru.put(1, "a", ByteArray(60)); assertEquals(2, lru.size)
        // Otra sesión no ve nada y vacía lo anterior.
        assertNull(lru.get(2, "a"))
        assertEquals(0, lru.size)
        assertNull(lru.get(1, "c"))
        lru.put(2, "x", ByteArray(10)); lru.clear()
        assertNull(lru.get(2, "x"))
    }
}
