package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.AppLanguage
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.platform.AppLocale
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
 * Llamadas perdidas (30-sep-2026): con perdidas sin ver, «Llamadas» lleva la pastilla roja; al abrir la pestaña se
 * quita (POST /calls/seen) y el historial marca «Perdida». Argumentos: apiUrl, email, password y missed (cuántas espera).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class PerdidasUiTest {
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
        File(ins.targetContext.getExternalFilesDir(null), "perdidas-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun pastillaRojaSeQuitaAlAbrirYHistorialPerdida() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        val expected = arg("missed").toIntOrNull() ?: 1
        // En español para la captura («Perdida»); al final vuelve el idioma de antes.
        val langBefore = AppLocale.current(app)
        ins.runOnMainSync { AppLocale.set(app, AppLanguage.ES); app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("tabs"), 20_000)
            val client = app.container.client.value
            compose.waitUntil(15_000) { exists("tab-calls") }
            // Pastilla roja con el número del bootstrap.
            compose.waitUntil(10_000) { exists("tabBadgeMissed") }
            assertEquals(expected, client.state.value.data!!.missedCalls)
            shot("01-pastilla-roja")

            compose.onNodeWithTag("tab-calls").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("callsList"), 10_000)
            // Al abrir: 0 aquí y POST /calls/seen; la pastilla se va.
            compose.waitUntil(10_000) { client.state.value.data!!.missedCalls == 0 && !exists("tabBadgeMissed") }
            // La fila fusiona su semántica: la etiqueta se busca en el árbol sin fusionar.
            compose.waitUntil(15_000) { exists("callMissedTag") }
            shot("02-historial-perdida")
            // El servidor también quedó en 0: un bootstrap nuevo no la trae de vuelta.
            runBlocking { client.loadBootstrap() }
            assertEquals(0, client.state.value.data!!.missedCalls)
            assertTrue(!exists("tabBadgeMissed"))
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { scenario.close() }; ins.runOnMainSync { AppLocale.set(app, langBefore) } }
    }
}
