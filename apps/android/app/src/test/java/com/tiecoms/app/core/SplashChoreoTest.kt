package com.tiecoms.app.core

import com.tiecoms.app.core.SplashChoreo.Mode
import com.tiecoms.app.core.SplashChoreo.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** La coreografía del splash es una función pura del tiempo (SPEC-v2 §4): se prueba fase a fase. */
class SplashChoreoTest {
    private fun f(t: Float, ready: Boolean = true, mode: Mode = Mode.FULL) = SplashChoreo.frame(t, ready, 0f, mode)
    private val eps = 1e-3f

    @Test fun `fases en los tiempos de la SPEC`() {
        assertEquals(Phase.PEOPLE, f(0.10f).phase)
        assertEquals(Phase.THREAD, f(0.50f).phase)
        assertEquals(Phase.KNOT, f(1.10f).phase)
        assertEquals(Phase.LOGO, f(1.50f).phase)
        assertEquals(Phase.SLOGAN, f(2.00f).phase)
        assertEquals(Phase.EXIT, f(2.50f).phase)
        assertEquals(Phase.DONE, f(2.80f).phase)
    }

    @Test fun `personas aparecen con 70 ms de retraso y resorte`() {
        val t = 0.05f
        val fr = f(t)
        assertTrue(fr.nodeScale[0] > fr.nodeScale[1])
        assertEquals(0f, f(0.0f).nodeScale[0], eps)
        assertEquals(0f, f(0.069f).nodeScale[1], eps)
        assertTrue(f(0.45f).nodeScale.all { it > 0.95f })
        // El resorte rebota por encima de 1 antes de asentarse.
        assertTrue((0..45).map { f(it / 100f).nodeScale[0] }.max() > 1.0f)
        assertEquals(5, SplashChoreo.PEOPLE.size)
        assertEquals(listOf("SR", "TB", "LP", "KA", "MG"), SplashChoreo.PEOPLE.map { it.initials })
    }

    @Test fun `el hilo se dibuja entre 300 y 1000 ms y anilla cada nodo al pasar`() {
        assertEquals(0f, f(0.29f).rope, eps)
        assertEquals(0.5f, f(0.65f).rope, 0.01f) // ease-in-out: mitad del recorrido a mitad de tiempo
        assertEquals(1f, f(1.0f).rope, eps)
        val reach = (0 until 5).map { SplashChoreo.nodeReachedAt(it) }
        assertEquals(SplashChoreo.ROPE_START, reach.first(), 0.01f)
        assertEquals(SplashChoreo.ROPE_END, reach.last(), 0.01f)
        assertTrue(reach.zipWithNext().all { (a, b) -> b > a })
        assertEquals(0f, f(reach[2] - 0.01f).ringScale[2], eps)
        assertEquals(1.25f, f(reach[2] + 0.001f).ringScale[2], 0.02f)
        assertEquals(1f, f(reach[2] + 0.3f).ringScale[2], 0.02f)
        assertEquals(0.30f, SplashChoreo.SOUND_AT, eps)
    }

    @Test fun `se amarra girando 20 grados y los nodos se desvanecen`() {
        assertEquals(0f, f(1.0f).gather, eps)
        assertEquals(1f, f(1.35f).gather, eps)
        assertEquals(20f, f(1.40f).rotationDeg, eps)
        assertTrue(f(1.35f).nodeAlpha.all { it <= eps })
        assertEquals(0f, f(1.40f).rope, eps)
        assertEquals(1.02f, SplashChoreo.HAPTIC_AT, eps)
    }

    @Test fun `nace el logo con pulso, chispas, resorte y tinta de izquierda a derecha`() {
        assertEquals(0f, f(1.29f).orangeAlpha, eps)
        assertTrue(f(1.40f).pulseAlpha > 0f)
        assertTrue(f(1.50f).sparks > 0f)
        assertEquals(0f, f(1.96f).sparks, eps)
        assertEquals(0.8f, f(1.30f).orangeScale, 0.01f)
        assertEquals(1f, f(1.85f).orangeScale, 0.01f)
        assertEquals(0f, f(1.40f).inkReveal, eps)
        assertEquals(1f, f(1.95f).inkReveal, eps)
        assertTrue(f(1.70f).inkReveal in 0.3f..0.8f)
        assertEquals(10, SplashChoreo.SPARKS)
        assertEquals(0.728f, SplashChoreo.KNOT_FX, eps); assertEquals(0.474f, SplashChoreo.KNOT_FY, eps)
    }

    @Test fun `eslogan sube 8 pt y aparece`() {
        assertEquals(0f, f(1.84f).sloganAlpha[0], eps)
        assertEquals(8f, f(1.85f).sloganOffset[0], eps)
        assertEquals(1f, f(2.40f).sloganAlpha[2], eps)
        assertEquals(0f, f(2.40f).sloganOffset[2], eps)
    }

    @Test fun `sale solo si la app ya cargo y si no espera con un punto que late`() {
        val out = f(2.60f)
        assertTrue(out.exitScale > 1f && out.exitScale <= 1.06f)
        assertTrue(out.exitAlpha < 1f)
        val wait = SplashChoreo.frame(2.40f, ready = false, waited = 0.2f)
        assertEquals(Phase.SLOGAN, wait.phase)
        assertEquals(1f, wait.exitAlpha, eps)
        assertTrue(wait.waitingDot > 0f)
        assertEquals(1.06f, f(2.75f).exitScale, eps)
        assertEquals(6f, SplashChoreo.MAX_WAIT, eps)
    }

    @Test fun `version corta para deep link en frio y reducida`() {
        assertEquals(SplashChoreo.LOGO_START, SplashChoreo.timelineTime(0f, Mode.SHORT), eps)
        assertEquals(SplashChoreo.TOTAL, SplashChoreo.timelineTime(1.2f, Mode.SHORT), eps)
        assertTrue(SplashChoreo.duration(Mode.SHORT) <= 1.2f)
        val r = f(0.2f, mode = Mode.REDUCED)
        assertEquals(0f, r.sparks, eps); assertEquals(0f, r.rope, eps)
        assertTrue(r.nodeAlpha.all { it == 0f })
        assertEquals(0.5f, r.orangeAlpha, 0.01f)
        assertEquals(Phase.DONE, f(1.3f, mode = Mode.REDUCED).phase)
    }
}
