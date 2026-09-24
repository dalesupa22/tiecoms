package com.tiecoms.app

import android.Manifest
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
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
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Prueba de UI de punta a punta contra el API de PRUEBAS. Las credenciales del fixture
 * llegan como argumentos de instrumentación (nunca están en el código de la app):
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3021 -e email … -e password … \
 *     -e conversationId … -e class com.tiecoms.app.LiveUiTest com.tiecoms.app.test/androidx.test.runner.AndroidJUnitRunner
 *
 * Con scripts/realtime-peer.mjs corriendo como B, espera el "eco: hola desde Android".
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class LiveUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[ui] $s") }

    private fun screenshot(name: String) {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val bmp = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return
        val f = File(ctx.getExternalFilesDir(null), "$name.png")
        f.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        log("captura: ${f.absolutePath}")
    }

    @Test
    fun loginConversacionEcoYDeepLinks() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val convId = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && convId.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com"))

        val ins = InstrumentationRegistry.getInstrumentation()
        val app = ins.targetContext.applicationContext as TieComsApp
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        // Empieza sin sesión: espera a que termine el arranque y cierra la sesión que hubiera.
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }

        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try { flow(scenario, ins, convId, email, password) } catch (t: Throwable) {
            screenshot("ui-fallo")
            runCatching { compose.onAllNodes(hasTestTag("error")).fetchSemanticsNodes().forEach { log("error en pantalla: ${it.config}") } }
            throw t
        } finally { runCatching { scenario.close() } }
    }

    private fun flow(scenario: ActivityScenario<MainActivity>, ins: android.app.Instrumentation, convId: String, email: String, password: String) {

        // 1. Login como A
        compose.waitUntilExactlyOneExists(hasTestTag("email"), 20_000)
        compose.onNodeWithTag("email").performTextInput(email)
        compose.onNodeWithTag("password").performTextInput(password)
        var t0 = System.currentTimeMillis()
        compose.onNodeWithTag("login").performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conv-$convId"), 20_000)
        log("login → lista de conversaciones: ${System.currentTimeMillis() - t0} ms")

        // 2. Abrir la conversación
        compose.onNodeWithTag("conv-$convId").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)

        // 4. Enviar y esperar el eco del par en vivo
        val text = "hola desde Android"
        compose.onNodeWithTag("composer").performTextInput(text)
        t0 = System.currentTimeMillis()
        compose.onNodeWithTag("send").performClick()
        compose.waitUntilAtLeastOneExists(hasText(text), 5_000)
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("sending"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        log("envío confirmado: ${System.currentTimeMillis() - t0} ms")
        compose.waitUntil(20_000) { compose.onAllNodes(hasText("eco: $text"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        log("eco del par visible: ${System.currentTimeMillis() - t0} ms desde enviar")
        Thread.sleep(600)
        screenshot("ui-01-eco")

        // 5. Deep link tiecoms://c/<id> desde el inicio
        compose.onNodeWithTag("back").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conv-$convId"), 10_000)
        fun open(uri: String) {
            ins.targetContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(ins.targetContext.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        t0 = System.currentTimeMillis()
        open("tiecoms://c/$convId")
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)
        log("deep link tiecoms://c/<id> → conversación: ${System.currentTimeMillis() - t0} ms")

        // 6. App Link https (con paquete explícito; la verificación de dominio se prueba aparte con adb)
        compose.onNodeWithTag("back").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conv-$convId"), 10_000)
        t0 = System.currentTimeMillis()
        open("https://app.tiecoms.com/c/$convId")
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)
        log("deep link https://app.tiecoms.com/c/<id> → conversación: ${System.currentTimeMillis() - t0} ms")

        // 7. Conversación fuera de alcance → aviso
        open("tiecoms://c/00000000-0000-0000-0000-000000000000")
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("No tienes acceso", substring = true) or hasText("have access", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        log("deep link sin acceso → aviso mostrado")
        // 8. Rotación: el borrador sobrevive
        compose.onNodeWithTag("composer").performTextInput("borrador")
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        compose.waitUntilExactlyOneExists(hasTestTag("composer") and hasText("borrador"), 10_000)
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        compose.waitUntilExactlyOneExists(hasTestTag("composer") and hasText("borrador"), 10_000)
        log("rotación: borrador conservado")

        screenshot("ui-02-final")
    }
}
