package com.tiecoms.app.core

import com.tiecoms.app.core.SplashChoreo.Mode
import com.tiecoms.app.core.SplashChoreo.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

/** La coreografía del splash de «ignición» es una función pura del tiempo: se prueba tramo a tramo. */
class SplashChoreoTest {
    private fun f(t: Float, mode: Mode = Mode.FULL) = SplashChoreo.frame(t, mode)
    private val eps = 1e-3f

    @Test fun `fases en los tiempos de la tabla`() {
        assertEquals(Phase.STILL, f(0.10f).phase)
        assertEquals(Phase.IGNITION, f(0.40f).phase)
        assertEquals(Phase.SLOGAN, f(1.00f).phase)
        assertEquals(Phase.EXIT, f(1.45f).phase)
        assertEquals(Phase.DONE, f(1.60f).phase)
    }

    @Test fun `el primer cuadro es identico al splash del sistema`() {
        val first = f(SplashChoreo.startTime(Mode.FULL))
        assertEquals(0f, SplashChoreo.startTime(Mode.FULL), eps)
        assertEquals(1f, first.orangeScale, eps)
        assertEquals(0f, first.sparksAlpha, eps)
        assertEquals(0f, first.sloganAlpha, eps)
        assertEquals(1f, first.exitAlpha, eps)
        assertEquals(1f, first.exitScale, eps)
        // Quieto hasta que empieza el pop.
        assertEquals(1f, f(0.199f).orangeScale, eps)
    }

    @Test fun `el lienzo cabe en el icono del sistema con las burbujas dentro del circulo de 192 dp`() {
        // Geometría del SVG (lienzo de 780 u con origen en -10,-140): la esquina redondeada de la burbuja
        // papel (centro 118,118, radio 118) es el punto más lejano del centro del lienzo (380,250).
        val farthest = (hypot(380.0 - 118.0, 250.0 - 118.0) + 118.0) / 780.0
        assertTrue(farthest * SplashChoreo.CANVAS_DP <= 96.0)
        assertTrue(SplashChoreo.CANVAS_DP <= 288f)
    }

    @Test fun `la burbuja naranja hace pop 1 a 1,10 a 1 entre 0,20 y 0,55 s`() {
        assertEquals(1f, f(0.20f).orangeScale, eps)
        val peakT = SplashChoreo.POP_START + SplashChoreo.POP_PEAK_AT * (SplashChoreo.POP_END - SplashChoreo.POP_START)
        assertEquals(1.10f, f(peakT).orangeScale, eps)
        assertTrue((20..55).map { f(it / 100f).orangeScale }.all { it in 1f..1.10f + eps })
        assertEquals(1f, f(0.55f).orangeScale, eps)
        assertEquals(1f, f(1.0f).orangeScale, eps)
        assertEquals(0.5f, SplashChoreo.POP_PIVOT_X, eps); assertEquals(0.5f, SplashChoreo.POP_PIVOT_Y, eps)
    }

    @Test fun `las rayitas se encienden y crecen de 0,4 a 1 entre 0,35 y 0,70 s con sonido y vibracion`() {
        assertEquals(0f, f(0.35f).sparksAlpha, eps)
        assertEquals(0.4f, f(0.35f).sparksScale, eps)
        val mid = f(0.50f)
        assertTrue(mid.sparksAlpha in 0.1f..0.99f && mid.sparksScale in 0.41f..0.99f)
        assertEquals(1f, f(0.70f).sparksAlpha, eps)
        assertEquals(1f, f(0.70f).sparksScale, eps)
        assertEquals(0.83f, SplashChoreo.SPARKS_PIVOT_X, eps); assertEquals(0.17f, SplashChoreo.SPARKS_PIVOT_Y, eps)
        assertEquals(0.35f, SplashChoreo.FEEDBACK_AT, eps)
        assertTrue(SplashChoreo.crossed(0.34f, 0.36f, SplashChoreo.FEEDBACK_AT))
        assertFalse(SplashChoreo.crossed(0.36f, 0.40f, SplashChoreo.FEEDBACK_AT))
    }

    @Test fun `el eslogan aparece al 80 por ciento subiendo 8 dp entre 0,55 y 0,95 s`() {
        assertEquals(0f, f(0.55f).sloganAlpha, eps)
        assertEquals(8f, f(0.55f).sloganOffsetDp, eps)
        assertEquals(0.8f, f(0.95f).sloganAlpha, eps)
        assertEquals(0f, f(0.95f).sloganOffsetDp, eps)
        assertEquals(0.8f, f(1.29f).sloganAlpha, eps)
    }

    @Test fun `sale entre 1,30 y 1,60 s con fundido`() {
        assertEquals(1f, f(1.30f).exitAlpha, eps)
        val out = f(1.45f)
        assertTrue(out.exitAlpha in 0.01f..0.99f)
        assertTrue(out.exitScale > 1f && out.exitScale < SplashChoreo.EXIT_SCALE)
        assertEquals(0f, f(1.60f).exitAlpha, eps)
    }

    @Test fun `si la app no esta lista espera en el ultimo cuadro hasta 6 s`() {
        var t = 0f
        repeat(200) { t = SplashChoreo.step(t, 0.016f, canExit = false) }
        assertEquals(SplashChoreo.EXIT_START, t, eps)
        assertEquals(Phase.EXIT, f(t).phase)
        assertEquals(1f, f(t).exitAlpha, eps) // último cuadro, todavía sin salir
        assertFalse(SplashChoreo.canExit(ready = false, real = 5.9f))
        assertTrue(SplashChoreo.canExit(ready = false, real = 6.0f))
        assertTrue(SplashChoreo.canExit(ready = true, real = 0.1f))
        // Al cargar, la salida arranca desde donde esperaba.
        assertEquals(SplashChoreo.EXIT_START + 0.1f, SplashChoreo.step(t, 0.1f, canExit = true), eps)
    }

    @Test fun `tocar adelanta a la salida`() {
        assertEquals(SplashChoreo.EXIT_START + 0.016f, SplashChoreo.step(0.3f, 0.016f, canExit = true, skip = true), eps)
        assertEquals(SplashChoreo.EXIT_START, SplashChoreo.step(0.3f, 0.016f, canExit = false, skip = true), eps)
        // Ya saliendo, tocar no retrocede.
        assertEquals(1.51f, SplashChoreo.step(1.5f, 0.01f, canExit = true, skip = true), eps)
    }

    @Test fun `arranque por enlace empieza en 0,7 s sin volver a sonar`() {
        assertEquals(0.70f, SplashChoreo.startTime(Mode.SHORT), eps)
        val s = f(SplashChoreo.startTime(Mode.SHORT), Mode.SHORT)
        assertEquals(1f, s.sparksAlpha, eps)
        assertFalse(SplashChoreo.crossed(0.70f, 0.72f, SplashChoreo.FEEDBACK_AT))
        // Dura 0,9 s en total.
        var t = SplashChoreo.startTime(Mode.SHORT); var n = 0
        while (f(t, Mode.SHORT).phase != Phase.DONE) { t = SplashChoreo.step(t, 0.01f, canExit = true); n++ }
        assertEquals(90f, n.toFloat(), 1.5f)
    }

    @Test fun `con animaciones reducidas no hay escalas, solo fundidos`() {
        for (i in 0..160) {
            val r = f(i / 100f, Mode.REDUCED)
            assertEquals(1f, r.orangeScale, eps)
            assertEquals(1f, r.sparksScale, eps)
            assertEquals(1f, r.exitScale, eps)
            assertEquals(0f, r.sloganOffsetDp, eps)
        }
        assertEquals(f(0.5f).sparksAlpha, f(0.5f, Mode.REDUCED).sparksAlpha, eps)
        assertEquals(f(0.8f).sloganAlpha, f(0.8f, Mode.REDUCED).sloganAlpha, eps)
        assertEquals(f(1.45f).exitAlpha, f(1.45f, Mode.REDUCED).exitAlpha, eps)
    }
}
