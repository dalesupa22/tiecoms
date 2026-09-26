package com.tiecoms.app.core

import kotlin.math.abs

/** Reglas puras de cuándo se cierra el teclado (ver ui/Keyboard.kt). */
object KeyboardRules {
    /** Margen antes de soltar el foco tras ocultarse el teclado (cambio de campo = reaparece antes). */
    const val IME_HIDDEN_GRACE_MS = 300L

    /** El teclado se ocultó por otro medio (botón atrás, gesto): se suelta el foco del campo. */
    fun releaseFocusOnImeChange(wasVisible: Boolean, visible: Boolean): Boolean = wasVisible && !visible

    /**
     * Deslizar con el dedo cierra el teclado. No lo cierra el desplazamiento de «llevar el campo a la vista»
     * al enfocarlo (llega como origen «usuario» pero sin dedo apoyado) ni la inercia tras soltar.
     */
    fun dismissOnScroll(userInput: Boolean, fingerDown: Boolean, dy: Float): Boolean = userInput && fingerDown && abs(dy) > 0.5f

    /** Un toque (soltado sin pasar el umbral de arrastre) dentro de la lista de mensajes cierra el teclado. */
    fun dismissOnTap(released: Boolean, moved: Float, touchSlop: Float): Boolean = released && moved <= touchSlop
}
