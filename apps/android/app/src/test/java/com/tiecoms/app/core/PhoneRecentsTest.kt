package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** CH038: tocar una llamada de Chaggu en el historial del teléfono vuelve a llamar a ese chat. */
class PhoneRecentsTest {
    @Test fun leeElNombreDeLaDireccionAnotada() {
        assertEquals("Liliana Garcia", PhoneRecents.nameFromAddress("Liliana Garcia@chaggu"))
        assertEquals("Xertify - Ventas", PhoneRecents.nameFromAddress(" Xertify - Ventas@chaggu "))
        assertNull(PhoneRecents.nameFromAddress("+573001234567"))
        assertNull(PhoneRecents.nameFromAddress("@chaggu"))
        assertNull(PhoneRecents.nameFromAddress(null))
    }

    @Test fun guardaYLeeCadaEntrada() {
        val e = PhoneRecents.Entry("c1", 42L)
        assertEquals(e, PhoneRecents.decode(PhoneRecents.encode(e)))
        assertNull(PhoneRecents.decode("x|c1"))
        assertNull(PhoneRecents.decode("42|"))
        assertNull(PhoneRecents.decode(null))
    }

    @Test fun seQuedaConLosMasRecientes() {
        val all = (0 until 5).associate { "p$it" to PhoneRecents.Entry("c$it", it.toLong()) }
        assertEquals(listOf("p0", "p1"), PhoneRecents.overflow(all, limit = 3))
        assertEquals(emptyList<String>(), PhoneRecents.overflow(all, limit = 5))
    }

    @Test fun usaElChatRecordadoSiSigoEnEl() {
        val remembered = mapOf("Ana" to PhoneRecents.Entry("c2", 1L))
        assertEquals("c2", PhoneRecents.resolve("Ana", remembered, listOf("c1" to "Ana", "c2" to "Ana")))
        // Ya no estoy en ese chat y hay dos con el mismo nombre: no se adivina.
        assertNull(PhoneRecents.resolve("Ana", remembered, listOf("c1" to "Ana", "c3" to "Ana")))
    }

    @Test fun lasEntradasViejasUsanElUnicoChatConEseNombre() {
        val chats = listOf("c1" to "Liliana Garcia", "g1" to "Xertify - Ventas")
        assertEquals("c1", PhoneRecents.resolve("liliana garcia", emptyMap(), chats))
        assertNull(PhoneRecents.resolve("Nadie", emptyMap(), chats))
    }
}
