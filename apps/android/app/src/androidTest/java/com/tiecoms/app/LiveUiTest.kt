package com.tiecoms.app

import android.Manifest
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Pruebas de UI de punta a punta contra el API de PRUEBAS. Las credenciales del fixture
 * llegan como argumentos de instrumentación (nunca están en el código de la app):
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3041 -e email … -e password … \
 *     -e conversationId … -e class com.tiecoms.app.LiveUiTest com.tiecoms.app.test/androidx.test.runner.AndroidJUnitRunner
 *
 * Con scripts/realtime-peer2.mjs corriendo como B (eco, «visto editado», «visto fijado»).
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
    private val ins = InstrumentationRegistry.getInstrumentation()

    private fun screenshot(name: String) {
        val ctx = ins.targetContext
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        val f = File(ctx.getExternalFilesDir(null), "$name.png")
        f.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        log("captura: ${f.absolutePath}")
    }

    /** Servidor de pruebas y sin sesión (el arranque del cliente termina antes de abrir la actividad). */
    private fun prepare(apiUrl: String) {
        val app = ins.targetContext.applicationContext as TieComsApp
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
    }

    @Test
    fun loginConversacionAccionesYDeepLinks() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val convId = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && convId.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com"))
        prepare(apiUrl)
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try { flow(scenario, convId, email, password) } catch (t: Throwable) {
            screenshot("ui-fallo")
            throw t
        } finally { runCatching { scenario.close() } }
    }

    private fun waitText(text: String, ms: Long = 20_000) =
        compose.waitUntil(ms) { compose.onAllNodes(hasText(text), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun longPressText(text: String) {
        compose.onNode(hasText(text), useUnmergedTree = true).performTouchInput { longClick() }
        compose.waitUntilAtLeastOneExists(hasTestTag("actionSheet"), 5_000)
    }

    private fun flow(scenario: ActivityScenario<MainActivity>, convId: String, email: String, password: String) {
        // 1. Login como A (si quedó un splash corto por la primera prueba, se espera a que salga).
        compose.waitUntil(20_000) { compose.onAllNodes(hasTestTag("email")).fetchSemanticsNodes().isNotEmpty() && compose.onAllNodes(hasTestTag("splash")).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("email").performTextInput(email)
        compose.onNodeWithTag("password").performTextInput(password)
        var t0 = System.currentTimeMillis()
        compose.onNodeWithTag("login").performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conv-$convId"), 20_000)
        compose.onNodeWithTag("tabs").assertIsDisplayed()
        log("login → Inicio con pestañas: ${System.currentTimeMillis() - t0} ms")

        // 2. Conversación: enviar y esperar el eco del par.
        compose.onNodeWithTag("conv-$convId").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)
        val text = "hola desde Android"
        compose.onNodeWithTag("composer").performTextInput(text)
        t0 = System.currentTimeMillis()
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("sending"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        waitText("eco: $text")
        log("envío + eco del par: ${System.currentTimeMillis() - t0} ms")

        // 3. Pulsación larga → Fijar mensaje → el par responde «visto fijado: 1».
        longPressText(text)
        screenshot("ui-03-menu")
        compose.onNodeWithTag("menuPin").performClick()
        t0 = System.currentTimeMillis()
        compose.waitUntilAtLeastOneExists(hasTestTag("pinsButton"), 5_000)
        waitText("visto fijado: 1")
        log("fijar → barra de fijados + respuesta del par: ${System.currentTimeMillis() - t0} ms")

        // 4. Pulsación larga → Editar → Guardar → el par responde «visto editado: …».
        longPressText(text)
        compose.onNodeWithTag("menuEdit").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("editBar"), 5_000)
        compose.onNodeWithTag("composer").performTextReplacement("$text (editado)")
        t0 = System.currentTimeMillis()
        compose.onNodeWithTag("saveEdit").performClick()
        waitText("visto editado: $text (editado)")
        waitText("$text (editado)")
        // Marca de edición en el pie de la burbuja (es: «(editado)», en: «(edited)»).
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("(editado)", substring = true) or hasText("(edited)", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        log("editar → respuesta del par: ${System.currentTimeMillis() - t0} ms")
        Thread.sleep(500)
        screenshot("ui-04-fijado-editado")

        // 5. Compartir hacia TieComs (ACTION_SEND de otra app) → elegir conversación → Traer.
        val shared = "Pedido 4411 listo para despacho"
        ins.targetContext.startActivity(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, shared)
            .setPackage(ins.targetContext.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        compose.waitUntilExactlyOneExists(hasTestTag("share"), 10_000)
        compose.onNodeWithTag("pick-$convId").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("bringDialog"), 5_000)
        compose.onNodeWithTag("bringSend").performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)
        waitText(shared)
        waitText("eco: $shared")
        log("compartir → mensaje con origen en la conversación y eco del par")

        // 6. Deep links (con la app viva: sin splash).
        compose.onNodeWithTag("back").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conv-$convId"), 10_000)
        fun open(uri: String) {
            ins.targetContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(ins.targetContext.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        t0 = System.currentTimeMillis()
        open("tiecoms://c/$convId")
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)
        log("deep link tiecoms://c/<id>: ${System.currentTimeMillis() - t0} ms")
        compose.onNodeWithTag("back").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conv-$convId"), 10_000)
        t0 = System.currentTimeMillis()
        open("https://app.tiecoms.com/c/$convId")
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)
        log("deep link https://app.tiecoms.com/c/<id>: ${System.currentTimeMillis() - t0} ms")
        open("tiecoms://asuntos")
        compose.waitUntilExactlyOneExists(hasTestTag("issues"), 10_000)
        open("tiecoms://agenda")
        compose.waitUntilExactlyOneExists(hasTestTag("agenda"), 10_000)
        log("deep links /asuntos y /agenda → pestañas")
        open("tiecoms://c/00000000-0000-0000-0000-000000000000")
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("No tienes acceso", substring = true) or hasText("have access", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        log("deep link sin acceso → aviso")

        // 7. Rotación: el borrador y los mensajes sobreviven.
        open("tiecoms://c/$convId")
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)
        compose.onNodeWithTag("composer").performTextInput("borrador")
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        Thread.sleep(2_000); compose.waitForIdle()
        compose.waitUntilExactlyOneExists(hasTestTag("composer") and hasText("borrador"), 10_000)
        compose.onNode(hasText("eco: $shared"), useUnmergedTree = true).assertIsDisplayed()
        screenshot("ui-05-landscape")
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        Thread.sleep(2_000); compose.waitForIdle()
        compose.waitUntilExactlyOneExists(hasTestTag("composer") and hasText("borrador"), 10_000)
        log("rotación: borrador y mensajes visibles")
        screenshot("ui-06-final")
    }
}
