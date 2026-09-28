package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** Modo sueño (Sleep.tsx de la web): ventana que cruza la medianoche, wakeAt y el aviso a quien escribe. */
class SleepModeTest {
    private val bog = ZoneId.of("America/Bogota")
    private fun at(s: String, z: ZoneId = bog) = java.time.LocalDateTime.parse(s).atZone(z).toInstant()
    private val night = SleepMode.Window("22:00", "07:00", "America/Bogota")

    @Test fun `ventana nocturna cruza la medianoche`() {
        assertTrue(SleepMode.sleepingNow(night, at("2026-09-27T23:30")))
        assertTrue(SleepMode.sleepingNow(night, at("2026-09-28T06:59")))
        assertFalse(SleepMode.sleepingNow(night, at("2026-09-28T07:00")))
        assertFalse(SleepMode.sleepingNow(night, at("2026-09-27T21:59")))
        assertTrue(SleepMode.sleepingNow(night, at("2026-09-27T22:00")))
        // Ventana de día y ventana vacía.
        assertTrue(SleepMode.sleepingNow(SleepMode.Window("13:00", "14:00", "America/Bogota"), at("2026-09-27T13:30")))
        assertFalse(SleepMode.sleepingNow(SleepMode.Window("08:00", "08:00", "America/Bogota"), at("2026-09-27T08:00")))
        assertFalse(SleepMode.sleepingNow(null))
    }

    @Test fun `la zona es la de la persona, no la mia`() {
        // 23:30 en Madrid = 16:30 en Bogotá: Ana (Madrid) duerme aunque aquí sea de tarde.
        val madrid = SleepMode.Window("22:00", "07:00", "Europe/Madrid")
        assertTrue(SleepMode.sleepingNow(madrid, at("2026-09-27T16:30")))
        assertFalse(SleepMode.sleepingNow(night, at("2026-09-27T16:30")))
    }

    @Test fun `wakeAt es el proximo fin de la ventana`() {
        assertEquals(at("2026-09-28T07:00"), SleepMode.wakeAt(night, at("2026-09-27T23:30")))
        assertEquals(at("2026-09-28T07:00"), SleepMode.wakeAt(night, at("2026-09-28T02:10:42")))
        // Justo a las 7:00 ya despertó: el siguiente es mañana.
        assertEquals(at("2026-09-29T07:00"), SleepMode.wakeAt(night, at("2026-09-28T07:00")))
    }

    private fun person(id: String, sleep: SleepWindowDTO?, kind: String = "human") = PersonDTO(id = id, name = "$id Pérez", kind = kind, sleep = sleep)
    private val win = SleepWindowDTO("22:00", "07:00", "America/Bogota")

    @Test fun `aviso en directo y en grupos`() {
        val d = BootstrapDTO(me = UserDTO(id = "me"), people = listOf(person("me", null), person("ana", win), person("beto", null), person("bot", win, kind = "agent")))
        val night = at("2026-09-27T23:00")
        // Directo: siempre; el botón solo mientras escribo.
        val one = SleepMode.notice(d, listOf("me", "ana"), typing = false, at = night) as SleepMode.Notice.One
        assertEquals("ana", one.person.id); assertFalse(one.canSchedule); assertEquals(at("2026-09-28T07:00"), one.wake)
        assertTrue((SleepMode.notice(d, listOf("me", "ana"), typing = true, at = night) as SleepMode.Notice.One).canSchedule)
        // Grupo: solo mientras escribo, «N personas…»; los bots no cuentan.
        assertNull(SleepMode.notice(d, listOf("me", "ana", "beto", "bot"), typing = false, at = night))
        assertEquals(1, (SleepMode.notice(d, listOf("me", "ana", "beto", "bot"), typing = true, at = night) as SleepMode.Notice.Many).count)
        // De día, nada.
        assertNull(SleepMode.notice(d, listOf("me", "ana"), typing = true, at = at("2026-09-27T12:00")))
    }

    @Test fun `mi horario apagado no cuenta`() {
        assertNull(SleepMode.of(SleepDTO(on = false)))
        assertEquals(SleepMode.Window("22:00", "07:00", "America/Bogota"), SleepMode.of(SleepDTO()))
    }
}
