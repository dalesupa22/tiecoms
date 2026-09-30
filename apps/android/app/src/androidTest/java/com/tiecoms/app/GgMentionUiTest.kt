package com.tiecoms.app

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.Gg
import com.tiecoms.app.core.MentionDTO
import com.tiecoms.app.core.UserDTO
import com.tiecoms.app.ui.LocalContainer
import com.tiecoms.app.ui.MentionHighlight
import com.tiecoms.app.ui.MessageText
import com.tiecoms.app.ui.theme.TieComsTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** @gg multicolor (web 63e6b0f): en una burbuja ajena, en la propia de color (pastilla blanca) y en el campo al escribir. */
@RunWith(AndroidJUnit4::class)
class GgMentionUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun ggConDegradado() {
        val data = BootstrapDTO(me = UserDTO(id = "me", name = "Danny"))
        val text = "@gg ¿cómo respondemos a Jorge? (ana@gg.com no)"
        compose.setContent {
            CompositionLocalProvider(LocalContainer provides compose.activity.container) {
                TieComsTheme {
                    Column(Modifier.padding(16.dp)) {
                        Column(Modifier.background(Color(0xFFEFEDE8), RoundedCornerShape(18.dp)).padding(12.dp)) {
                            MessageText(text, listOf(MentionDTO(Gg.ID, 0, 3)), Color(0xFF1F1F1F), data, onPerson = {}, modifier = Modifier.testTag("otra"))
                        }
                        Column(Modifier.padding(top = 12.dp).background(Color(0xFFFF5A36), RoundedCornerShape(18.dp)).padding(12.dp)) {
                            MessageText("Le pregunto a @gg y te cuento", emptyList(), Color.White, data, onPerson = {}, onColored = true, modifier = Modifier.testTag("mia"))
                        }
                        OutlinedTextField("Hola @gg, redacta la respuesta", {}, visualTransformation = MentionHighlight(emptyList(), Color(0xFFFF5A36)),
                            modifier = Modifier.padding(top = 12.dp).testTag("campo"))
                    }
                }
            }
        }
        compose.waitForIdle()
        assertTrue(compose.onAllNodes(hasText("@gg", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithTag("otra").assertExists(); compose.onNodeWithTag("mia").assertExists(); compose.onNodeWithTag("campo").assertExists()
        Thread.sleep(800)
        val ins = InstrumentationRegistry.getInstrumentation()
        val bmp = ins.uiAutomation.takeScreenshot()
        File(ins.targetContext.getExternalFilesDir(null), "gg-mencion.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
