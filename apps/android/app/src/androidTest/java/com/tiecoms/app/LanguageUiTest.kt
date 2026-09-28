package com.tiecoms.app

import android.graphics.Bitmap
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.core.AppLanguage
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.platform.AppLocale
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import java.io.File

/**
 * «Idioma / Language» en Tú (1.6.2): English → la pestaña dice «Tasks»; Español → «Tareas»; se recuerda al volver a
 * abrir la app. Deja la app en el idioma de [-e endLang] (es|en|auto) para las capturas del splash desde adb.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class LanguageUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun hasLabel(t: String) = compose.onAllNodes(hasText(t), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "idioma-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun pick(lang: AppLanguage) {
        compose.onNodeWithTag("tab-settings").performClick()
        compose.waitUntil(10_000) { exists("lang-${lang.name}") }
        compose.onNodeWithTag("lang-${lang.name}", useUnmergedTree = true).performScrollTo().performClick()
        compose.waitUntil(10_000) { AppLocale.current(app) == lang }
        Thread.sleep(2_000) // el sistema recrea la actividad con el idioma nuevo
    }

    @Test fun cambiarIdioma() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password")
        assumeTrue(apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank())
        assertFalse(apiUrl.contains("app.chaggu.com") || apiUrl.contains("app.tiecoms.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c.state.first { it.status != SessionStatus.LOADING } }
            if (c.state.value.status != SessionStatus.ANONYMOUS) c.logout()
        }
        var scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 45_000)

            pick(AppLanguage.EN)
            compose.waitUntil(10_000) { hasLabel("Tasks") }
            shot("en-tu")
            compose.onNodeWithTag("tab-home").performClick(); Thread.sleep(1_000); shot("en-grupos")
            pick(AppLanguage.ES)
            compose.waitUntil(10_000) { hasLabel("Tareas") }
            shot("es-tu")
            compose.onNodeWithTag("tab-home").performClick(); Thread.sleep(1_000); shot("es-grupos")

            // Persistencia: se cierra y se vuelve a abrir la app.
            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 30_000)
            assertEquals(AppLanguage.ES, AppLocale.current(app))
            compose.waitUntil(10_000) { hasLabel("Tareas") }
            Log.i("TieComsUiTest", "Idioma: EN → Subjects, ES → Asuntos, persiste al reabrir")

            val end = when (arg("endLang")) { "en" -> AppLanguage.EN; "auto" -> AppLanguage.SYSTEM; else -> AppLanguage.ES }
            if (end != AppLanguage.ES) pick(end)
        } finally { runCatching { scenario.close() } }
    }
}
