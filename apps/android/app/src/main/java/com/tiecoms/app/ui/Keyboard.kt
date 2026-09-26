package com.tiecoms.app.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import com.tiecoms.app.core.KeyboardRules

/**
 * Cierre del teclado para una ventana entera (la raíz de la app, cada hoja inferior, compartir, burbuja):
 *  - al deslizar cualquier lista o formulario con el dedo (desplazamiento anidado de origen «usuario»);
 *  - al tocar fuera de un campo: un toque que ningún hijo consumió (fondo, espacios vacíos). Los toques
 *    en botones, mensajes o menús los consume su control y siguen funcionando igual;
 *  - cuando el teclado se oculta por otro medio (botón atrás), se suelta el foco para que el campo no
 *    quede «activo» sin teclado y no vuelva a abrirse solo.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Modifier.dismissKeyboardOnOutsideInteraction(): Modifier {
    val focus = LocalFocusManager.current
    val ime = WindowInsets.isImeVisible
    var wasVisible by remember { mutableStateOf(false) }
    LaunchedEffect(ime) {
        val hidden = KeyboardRules.releaseFocusOnImeChange(wasVisible, ime)
        wasVisible = ime
        // Se espera un poco: al pasar de un campo a otro el teclado puede ocultarse un instante y volver
        // (el efecto se cancela al reaparecer y el foco no se toca).
        if (hidden) { kotlinx.coroutines.delay(KeyboardRules.IME_HIDDEN_GRACE_MS); focus.clearFocus() }
    }
    val imeNow by rememberUpdatedState(ime)
    // Dedo apoyado en la pantalla: distingue el arrastre del usuario del desplazamiento que hace el propio
    // campo al enfocarse («llevar a la vista»), que también llega como origen «usuario».
    val finger = remember { booleanArrayOf(false) }
    val connection = remember(focus) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (imeNow && KeyboardRules.dismissOnScroll(source == NestedScrollSource.UserInput, finger[0], available.y)) focus.clearFocus()
                return Offset.Zero
            }
        }
    }
    return this.pointerInput(Unit) {
        awaitPointerEventScope {
            while (true) {
                val e = awaitPointerEvent(PointerEventPass.Initial)
                finger[0] = e.changes.any { it.pressed }
            }
        }
    }.nestedScroll(connection).pointerInput(focus) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Final)
            // null si un hijo consumió el toque (botón, campo, mensaje) o se canceló.
            val up = waitForUpOrCancellation(PointerEventPass.Final)
            if (up != null) focus.clearFocus()
        }
    }
}

/**
 * Para la lista de mensajes: cualquier toque o arrastre dentro de ella cierra el teclado, también sobre
 * una burbuja. No consume nada: el toque, el toque largo (menú) y el desplazamiento siguen llegando.
 */
@Composable
fun Modifier.dismissKeyboardOnTouch(): Modifier {
    val focus = LocalFocusManager.current
    return this.pointerInput(focus) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val up = waitForUpOrCancellation(PointerEventPass.Initial)
            val moved = up?.let { (it.position - down.position).getDistance() } ?: Float.MAX_VALUE
            if (KeyboardRules.dismissOnTap(up != null, moved, viewConfiguration.touchSlop)) focus.clearFocus()
        }
    }
}
