package com.tiecoms.app.core

import com.tiecoms.app.core.SplashChoreo.Mode
import com.tiecoms.app.core.SplashChoreo.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

/** La coreografía del splash de «puntitos» es una función pura del tiempo: se prueba tramo a tramo. */
class SplashChoreoTest {
    private fun f(t: Float, mode: Mode = Mode.FULL) = SplashChoreo.frame(t, mode)
    private val eps = 1e-3f

    /** Inicio del pulso k del punto i de una burbuja. */
    private fun at(start: Float, i: Int, k: Int) = start + 0.13f * i + 0.40f * k

    @Test fun `fases en los tiempos de la tabla`() {
        assertEquals(Phase.STILL, f(0.10f).phase)
        assertEquals(Phase.TYPING_WHITE, f(0.30f).phase)
        assertEquals(Phase.TYPING_ORANGE, f(1.10f).phase)
        assertEquals(Phase.PUM, f(1.70f).phase)
        assertEquals(Phase.SLOGAN, f(2.00f).phase)
        assertEquals(Phase.EXIT, f(2.50f).phase)
        assertEquals(Phase.DONE, f(2.65f).phase)
    }

    @Test fun `quieto y con los puntos llenos hasta 0,15 s, identico al splash del sistema`() {
        assertEquals(0f, SplashChoreo.startTime(Mode.FULL), eps)
        for (t in listOf(0f, 0.10f, 0.15f)) {
            val fr = f(t)
            assertTrue(fr.whiteDotAlpha.all { it == 1f } && fr.orangeDotAlpha.all { it == 1f })
            assertTrue(fr.whiteDotLift.all { it == 0f } && fr.orangeDotLift.all { it == 0f })
            assertEquals(1f, fr.orangeScale, eps)
            assertEquals(0f, fr.sparksAlpha, eps)
            assertEquals(0f, fr.sloganAlpha, eps)
            assertEquals(1f, fr.exitAlpha, eps)
            assertEquals(1f, fr.exitScale, eps)
        }
    }

    @Test fun `los puntos coinciden con los huecos del simbolo`() {
        // capa-0: huecos de r=23 en y=125 y x=105,165,225 / 405,465,525 (lienzo de 780 u con origen en -10,-140).
        assertEquals(23f / 780f, SplashChoreo.DOT_R, 1e-4f)
        assertEquals((125f + 140f) / 780f, SplashChoreo.DOT_Y, 1e-4f)
        listOf(105f, 165f, 225f).forEachIndexed { i, x -> assertEquals((x + 10f) / 780f, SplashChoreo.WHITE_DOTS_X[i], 1e-4f) }
        listOf(405f, 465f, 525f).forEachIndexed { i, x -> assertEquals((x + 10f) / 780f, SplashChoreo.ORANGE_DOTS_X[i], 1e-4f) }
    }

    @Test fun `el lienzo cabe en el icono del sistema con las burbujas dentro del circulo de 192 dp`() {
        val farthest = (hypot(380.0 - 118.0, 250.0 - 118.0) + 118.0) / 780.0
        assertTrue(farthest * SplashChoreo.CANVAS_DP <= 96.0)
    }

    @Test fun `un pulso dura 0,30 s, baja a 25 por ciento y sube 0,35 radios en la mitad`() {
        val s = at(0.15f, 0, 0)
        assertEquals(1f, f(s).whiteDotAlpha[0], eps)
        assertEquals(0.25f, f(s + 0.15f).whiteDotAlpha[0], eps)
        assertEquals(0.35f, f(s + 0.15f).whiteDotLift[0], eps)
        assertEquals(1f, f(s + 0.30f).whiteDotAlpha[0], eps)
        assertEquals(0f, f(s + 0.30f).whiteDotLift[0], eps)
        // Ease in-out: a un cuarto del pulso va por la mitad de la subida.
        assertEquals(0.35f * 0.5f, f(s + 0.075f).whiteDotLift[0], 0.01f)
    }

    @Test fun `los puntos blancos escriben en secuencia y en dos olas`() {
        for (k in 0..1) for (i in 0..2) {
            val mid = at(0.15f, i, k) + 0.15f
            val fr = f(mid)
            assertEquals("blanco $i ola $k", 0.25f, fr.whiteDotAlpha[i], eps)
            // Los naranjas todavía no, salvo el solape final (el primero naranja empieza en 0,85 s).
            if (mid < 0.85f) assertTrue(fr.orangeDotAlpha.all { it == 1f })
        }
        // En el máximo del punto 1 de la primera ola, el 0 ya bajó y el 2 apenas empieza.
        val fr = f(at(0.15f, 1, 0) + 0.15f)
        assertTrue(fr.whiteDotLift[1] > fr.whiteDotLift[0] && fr.whiteDotLift[1] > fr.whiteDotLift[2])
        // Terminadas las dos olas vuelven a estar llenos.
        assertTrue(f(1.12f).whiteDotAlpha.all { it == 1f })
    }

    @Test fun `luego escriben los naranjas`() {
        assertTrue(f(0.84f).orangeDotAlpha.all { it == 1f })
        for (k in 0..1) for (i in 0..2) assertEquals("naranja $i ola $k", 0.25f, f(at(0.85f, i, k) + 0.15f).orangeDotAlpha[i], eps)
        assertTrue(f(1.82f).orangeDotAlpha.all { it == 1f })
    }

    @Test fun `pum a 1,65 s - rayitas en 0,08 s, escala 0,3 a 1,15 a 1 y golpecito de la burbuja`() {
        assertEquals(0f, f(1.65f).sparksAlpha, eps)
        assertEquals(0.3f, f(1.65f).sparksScale, eps)
        assertEquals(1f, f(1.73f).sparksAlpha, eps)
        assertEquals(1.15f, f(1.75f).sparksScale, eps)
        assertEquals(1f, f(1.85f).sparksScale, eps)
        assertTrue((165..185).map { f(it / 100f).sparksScale }.max() <= 1.15f + eps)
        assertEquals(1f, f(1.65f).orangeScale, eps)
        assertEquals(1.04f, f(1.65f + 0.4f * 0.20f).orangeScale, eps)
        assertEquals(1f, f(1.85f).orangeScale, eps)
        assertEquals(0.609f, SplashChoreo.TAP_PIVOT_X, eps); assertEquals(0.340f, SplashChoreo.TAP_PIVOT_Y, eps)
        assertEquals(0.83f, SplashChoreo.SPARKS_PIVOT_X, eps); assertEquals(0.17f, SplashChoreo.SPARKS_PIVOT_Y, eps)
        assertEquals(1.65f, SplashChoreo.FEEDBACK_AT, eps)
        assertTrue(SplashChoreo.crossed(1.64f, 1.66f, SplashChoreo.FEEDBACK_AT))
        assertFalse(SplashChoreo.crossed(1.66f, 1.70f, SplashChoreo.FEEDBACK_AT))
    }

    @Test fun `el eslogan aparece al 80 por ciento subiendo 8 dp entre 1,80 y 2,15 s`() {
        assertEquals(0f, f(1.80f).sloganAlpha, eps)
        assertEquals(8f, f(1.80f).sloganOffsetDp, eps)
        assertEquals(0.8f, f(2.15f).sloganAlpha, eps)
        assertEquals(0f, f(2.15f).sloganOffsetDp, eps)
    }

    @Test fun `sale entre 2,35 y 2,65 s con fundido`() {
        assertEquals(1f, f(2.35f).exitAlpha, eps)
        val out = f(2.50f)
        assertTrue(out.exitAlpha in 0.01f..0.99f)
        assertTrue(out.exitScale > 1f && out.exitScale < SplashChoreo.EXIT_SCALE)
        assertEquals(0f, f(2.65f).exitAlpha, eps)
    }

    @Test fun `si la app no esta lista espera en el ultimo cuadro hasta 6 s`() {
        var t = 0f
        repeat(300) { t = SplashChoreo.step(t, 0.016f, canExit = false) }
        assertEquals(SplashChoreo.EXIT_START, t, eps)
        assertEquals(1f, f(t).exitAlpha, eps)
        assertEquals(1f, f(t).sparksAlpha, eps)
        assertFalse(SplashChoreo.canExit(ready = false, real = 5.9f))
        assertTrue(SplashChoreo.canExit(ready = false, real = 6.0f))
        assertEquals(SplashChoreo.EXIT_START + 0.1f, SplashChoreo.step(t, 0.1f, canExit = true), eps)
    }

    @Test fun `tocar adelanta a la salida`() {
        assertEquals(SplashChoreo.EXIT_START + 0.016f, SplashChoreo.step(0.3f, 0.016f, canExit = true, skip = true), eps)
        assertEquals(SplashChoreo.EXIT_START, SplashChoreo.step(0.3f, 0.016f, canExit = false, skip = true), eps)
        assertEquals(2.51f, SplashChoreo.step(2.5f, 0.01f, canExit = true, skip = true), eps)
    }

    @Test fun `arranque por enlace empieza en 1,55 s, justo antes del pum`() {
        assertEquals(1.55f, SplashChoreo.startTime(Mode.SHORT), eps)
        assertEquals(0f, f(1.55f, Mode.SHORT).sparksAlpha, eps)
        assertTrue(SplashChoreo.crossed(1.55f, 1.70f, SplashChoreo.FEEDBACK_AT))
        var t = SplashChoreo.startTime(Mode.SHORT); var n = 0
        while (f(t, Mode.SHORT).phase != Phase.DONE) { t = SplashChoreo.step(t, 0.01f, canExit = true); n++ }
        assertEquals(110f, n.toFloat(), 1.5f)
    }

    @Test fun `con animaciones reducidas los puntos solo cambian de opacidad y no hay escalas`() {
        for (i in 0..265) {
            val r = f(i / 100f, Mode.REDUCED)
            assertTrue(r.whiteDotLift.all { it == 0f } && r.orangeDotLift.all { it == 0f })
            assertEquals(1f, r.orangeScale, eps)
            assertEquals(1f, r.sparksScale, eps)
            assertEquals(1f, r.exitScale, eps)
            assertEquals(0f, r.sloganOffsetDp, eps)
        }
        assertEquals(0.25f, f(at(0.15f, 0, 0) + 0.15f, Mode.REDUCED).whiteDotAlpha[0], eps)
        // Rayitas: fundido durante el pum (sin el golpe de 0,08 s).
        assertTrue(f(1.73f, Mode.REDUCED).sparksAlpha in 0.2f..0.8f)
        assertEquals(1f, f(1.85f, Mode.REDUCED).sparksAlpha, eps)
    }
}
