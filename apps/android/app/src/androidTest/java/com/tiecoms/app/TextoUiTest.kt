package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 1.6.4 (22): «Tamaño del texto» en Tú. El slider cambia el factor en vivo; la lista de Grupos se captura en
 * Normal, Grande y Máximo, y con Máximo la barra inferior sigue mostrando sus cinco pestañas completas.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class TextoUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        compose.waitForIdle(); Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "texto-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun tamanoDelTexto() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        app.container.settings.textScale = 1f
        app.container.settings.groupsView = "list"
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("conversationList"), 10_000)
            shot("01-grupos-normal")

            // Slider en Tú: Grande (paso 2), en vivo.
            compose.onNodeWithTag("tab-settings").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("textSizeSlider"), 10_000)
            compose.onNodeWithTag("textSizeSlider").performScrollTo()
            compose.onNodeWithTag("textSizeSlider").performSemanticsAction(SemanticsActions.SetProgress) { it(2f) }
            compose.waitUntil(5_000) { app.container.settings.textScale == 1.15f }
            shot("02-ajuste-grande")
            compose.onNodeWithTag("tab-home").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("conversationList"), 10_000)
            shot("03-grupos-grande")

            // Máximo: las pestañas siguen ahí y la fila de Grupos no se corta.
            compose.onNodeWithTag("tab-settings").performClick()
            compose.onNodeWithTag("textSizeSlider").performScrollTo().performSemanticsAction(SemanticsActions.SetProgress) { it(4f) }
            compose.waitUntil(5_000) { app.container.settings.textScale == 1.45f }
            shot("04-ajuste-maximo")
            compose.onNodeWithTag("tab-home").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("conversationList"), 10_000)
            listOf("tab-home", "tab-dms", "tab-issues", "tab-agenda", "tab-settings").forEach { assertTrue(it, exists(it)) }
            shot("05-grupos-maximo")
            assertEquals(1.45f, app.container.settings.textScale)
        } catch (t: Throwable) { shot("fallo"); throw t } finally {
            app.container.settings.textScale = 1f
            runCatching { scenario.close() }
        }
    }
}
