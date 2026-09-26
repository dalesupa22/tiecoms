package com.tiecoms.app

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.ui.dismissKeyboardOnOutsideInteraction
import com.tiecoms.app.ui.dismissKeyboardOnTouch
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * El teclado se cierra al tocar un mensaje (y el toque sigue llegando), al deslizar la lista y al tocar
 * un espacio vacío; tocar el propio campo no lo cierra. Mismo montaje que el chat: la raíz con
 * [dismissKeyboardOnOutsideInteraction] y la lista de mensajes con [dismissKeyboardOnTouch].
 * Guarda capturas «teclado abierto → cerrado» en los archivos externos de la app.
 */
@RunWith(AndroidJUnit4::class)
class KeyboardDismissUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private var clicks by mutableIntStateOf(0)

    private fun imeVisible(): Boolean {
        var v = false
        rule.runOnUiThread { v = ViewCompat.getRootWindowInsets(rule.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true }
        return v
    }

    private fun waitIme(visible: Boolean) = rule.waitUntil(5_000) { imeVisible() == visible }

    private fun shot(name: String) {
        rule.waitForIdle(); Thread.sleep(400)
        val ins = InstrumentationRegistry.getInstrumentation()
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun setUp() {
        rule.setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize().dismissKeyboardOnOutsideInteraction()) {
                    var text by remember { mutableStateOf("") }
                    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
                        LazyColumn(Modifier.weight(1f).fillMaxWidth().dismissKeyboardOnTouch().testTag("messages")) {
                            items(60) { i -> Text("Mensaje $i", Modifier.fillMaxWidth().clickable { clicks++ }.padding(16.dp).testTag("m$i")) }
                        }
                        Spacer(Modifier.fillMaxWidth().height(56.dp).testTag("blank"))
                        OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().padding(8.dp).testTag("field"))
                    }
                }
            }
        }
    }

    private fun openKeyboard() {
        // En una actividad recién creada la ventana puede no tener foco aún y el teclado no aparece al
        // primer toque: se reintenta (como haría una persona) antes de dar por fallida la prueba.
        repeat(3) { attempt ->
            rule.onNodeWithTag("field").performClick()
            rule.onNodeWithTag("field").assertIsFocused()
            val shown = runCatching { rule.waitUntil(3_000) { imeVisible() } }.isSuccess
            if (shown) return
            if (attempt < 2) { rule.onNodeWithTag("blank").performClick(); rule.waitForIdle() }
        }
        waitIme(true)
    }

    @Test fun tocarUnMensajeCierraElTecladoYElToqueLlega() {
        setUp()
        openKeyboard(); shot("teclado-1-abierto")
        rule.onNodeWithTag("m2").performClick()
        rule.onNodeWithTag("field").assertIsNotFocused()
        waitIme(false); shot("teclado-2-cerrado-al-tocar-mensaje")
        assertEquals(1, clicks)
    }

    @Test fun deslizarLaListaCierraElTeclado() {
        setUp()
        openKeyboard()
        rule.onNodeWithTag("messages").performTouchInput { swipeDown() }
        rule.onNodeWithTag("field").assertIsNotFocused()
        waitIme(false); shot("teclado-3-cerrado-al-deslizar")
        assertEquals(0, clicks)
    }

    @Test fun tocarUnEspacioVacioCierraElTeclado() {
        setUp()
        openKeyboard()
        rule.onNodeWithTag("blank").performClick()
        rule.onNodeWithTag("field").assertIsNotFocused()
        waitIme(false); shot("teclado-4-cerrado-al-tocar-fuera")
    }

    @Test fun tocarElCampoNoLoCierra() {
        setUp()
        openKeyboard()
        rule.onNodeWithTag("field").performClick()
        rule.onNodeWithTag("field").assertIsFocused()
        assertEquals(true, imeVisible())
    }
}
