package com.tiecoms.app.core

import com.tiecoms.app.ui.PasteImages
import org.junit.Assert.*
import org.junit.Test

/** 1.7.1: «Ver más», deslizar a la derecha para responder y el marcador de imagen pegada. */
class ChatGesturesTest {
    @Test fun `solo los mensajes muy largos se pliegan`() {
        assertFalse(LongText.collapsible("Hola"))
        assertFalse(LongText.collapsible("a".repeat(500)))
        assertTrue(LongText.collapsible("a".repeat(4000)))
        assertTrue(LongText.collapsible((1..60).joinToString("\n") { "línea $it con texto" }))
        // 25 líneas cortas: cabe sin plegar.
        assertFalse(LongText.collapsible((1..25).joinToString("\n") { "línea $it con un poco más de texto" }))
        assertEquals(3, LongText.estimatedLines("a\n\nb"))
    }

    @Test fun `solo lo claramente horizontal hacia la derecha es responder`() {
        val slop = 20f
        assertEquals(SwipeReply.Decision.UNDECIDED, SwipeReply.decide(5f, 5f, slop))
        assertEquals(SwipeReply.Decision.CLAIM, SwipeReply.decide(30f, 4f, slop))
        assertEquals(SwipeReply.Decision.REJECT, SwipeReply.decide(3f, 25f, slop))      // vertical: es de la lista
        assertEquals(SwipeReply.Decision.REJECT, SwipeReply.decide(15f, -30f, slop))    // diagonal con más vertical
        assertEquals(SwipeReply.Decision.REJECT, SwipeReply.decide(-30f, 0f, slop))     // hacia la izquierda
        assertEquals(SwipeReply.Decision.UNDECIDED, SwipeReply.decide(30f, 18f, slop))  // diagonal: todavía no
    }

    @Test fun `la burbuja sigue al dedo y luego con resistencia`() {
        assertEquals(0f, SwipeReply.resist(-10f, 60f, 96f))
        assertEquals(40f, SwipeReply.resist(40f, 60f, 96f))
        assertEquals(60f + 40f * 0.35f, SwipeReply.resist(100f, 60f, 96f), 0.01f)
        assertEquals(96f, SwipeReply.resist(1000f, 60f, 96f))
    }

    @Test fun `el marcador de imagen pegada nunca queda en el texto`() {
        val m = PasteImages.MARKER
        assertEquals(Triple("hola", 4, false), PasteImages.strip("hola", 4))
        assertEquals(Triple("hola", 4, true), PasteImages.strip("hola$m", 5))
        assertEquals(Triple("ho @Ana la", 2, true), PasteImages.strip("ho$m @Ana la", 3))
    }
}
