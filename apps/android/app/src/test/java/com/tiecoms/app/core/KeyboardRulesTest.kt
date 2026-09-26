package com.tiecoms.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardRulesTest {
    @Test fun `al ocultarse el teclado se suelta el foco, no al abrirse`() {
        assertTrue(KeyboardRules.releaseFocusOnImeChange(wasVisible = true, visible = false))
        assertFalse(KeyboardRules.releaseFocusOnImeChange(wasVisible = false, visible = true))
        assertFalse(KeyboardRules.releaseFocusOnImeChange(wasVisible = false, visible = false))
        assertFalse(KeyboardRules.releaseFocusOnImeChange(wasVisible = true, visible = true))
    }

    @Test fun `solo el deslizamiento del usuario cierra el teclado`() {
        assertTrue(KeyboardRules.dismissOnScroll(userInput = true, fingerDown = true, dy = 12f))
        assertTrue(KeyboardRules.dismissOnScroll(userInput = true, fingerDown = true, dy = -12f))
        assertFalse(KeyboardRules.dismissOnScroll(userInput = false, fingerDown = true, dy = 40f))
        assertFalse(KeyboardRules.dismissOnScroll(userInput = true, fingerDown = true, dy = 0f))
        // Al enfocar un campo el formulario se desplaza para mostrarlo: no hay dedo, no se cierra.
        assertFalse(KeyboardRules.dismissOnScroll(userInput = true, fingerDown = false, dy = 80f))
    }

    @Test fun `un toque en la lista cierra el teclado, un arrastre lo deja al desplazamiento`() {
        assertTrue(KeyboardRules.dismissOnTap(released = true, moved = 2f, touchSlop = 8f))
        assertFalse(KeyboardRules.dismissOnTap(released = true, moved = 30f, touchSlop = 8f))
        assertFalse(KeyboardRules.dismissOnTap(released = false, moved = 0f, touchSlop = 8f))
    }
}
