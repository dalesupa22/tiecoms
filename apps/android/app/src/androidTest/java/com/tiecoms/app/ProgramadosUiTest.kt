package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.click
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
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
 * 1.6.4 (23), mensajes programados contra el API de pruebas (docs/PROGRAMADOS.md): 🕒 junto a enviar,
 * «Mañana temprano», la franja «🕒 1 mensaje programado», la lista (Cambiar hora, Enviar ahora, Cancelar con
 * Deshacer), la pulsación larga en ➤ y la pantalla «Programados».
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class ProgramadosUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[programados] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun str(id: Int, vararg a: Any) = app.getString(id, *a)
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun hasTextNow(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        compose.waitForIdle(); Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "programados-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun programar() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val conv = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && conv.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        app.container.settings.groupsView = "list"
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            val client = app.container.client.value
            compose.waitUntilAtLeastOneExists(hasTestTag("conv-$conv"), 15_000)
            compose.onNodeWithTag("conv-$conv").performTouchInput { click(androidx.compose.ui.geometry.Offset(width * 0.3f, height * 0.3f)) }
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)

            // 🕒 aparece solo con texto.
            assertFalse(exists("schedButton"))
            compose.onNodeWithTag("composer").performTextInput("Recordemos la demo del lunes")
            compose.waitUntilAtLeastOneExists(hasTestTag("schedButton"), 5_000)
            compose.onNodeWithTag("schedButton").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("sched-TOMORROW_MORNING"), 5_000)
            shot("01-menu")
            compose.onNodeWithTag("sched-TOMORROW_MORNING").performClick()
            compose.waitUntil(10_000) { client.state.value.scheduled.any { it.conversationId == conv && it.body == "Recordemos la demo del lunes" } }
            compose.waitUntilAtLeastOneExists(hasTestTag("schedStrip"), 5_000)
            assertTrue("el compositor se vació", compose.onAllNodes(hasText("Recordemos la demo del lunes"), useUnmergedTree = true).fetchSemanticsNodes().size <= 1)
            shot("02-franja-aviso")
            log("🕒 → Mañana temprano: programado, franja y aviso con Deshacer")

            // Pulsación larga en ➤ abre el mismo menú.
            compose.onNodeWithTag("composer").performTextInput("Segundo programado")
            compose.onNodeWithTag("send").performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("sched-IN_HOUR"), 5_000)
            compose.onNodeWithTag("sched-IN_HOUR").performClick()
            compose.waitUntil(10_000) { client.state.value.scheduled.count { it.conversationId == conv } == 2 }
            log("Pulsación larga en ➤ → En 1 hora")

            // Lista: Enviar ahora el segundo, cancelar el primero con Deshacer.
            // El aviso «Programado para …» tapa parte de la franja: se espera a que se vaya (el emulador va lento).
            runCatching { compose.waitUntil(30_000) { !hasTextNow(str(R.string.undo)) } }
            compose.onNodeWithTag("schedStrip").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("schedList"), 5_000)
            shot("03-lista")
            val second = client.state.value.scheduled.first { it.body == "Segundo programado" }
            compose.onNodeWithTag("sched-${second.id}").performScrollTo()
            // La lista va por hora: «En 1 hora» (el segundo) sale antes que «Mañana temprano».
            val order = client.state.value.scheduled.filter { it.conversationId == conv }.sortedBy { it.sendAt }.map { it.id }
            compose.onAllNodes(hasTestTag("schedSendNow"), useUnmergedTree = true)[order.indexOf(second.id)].performClick()
            compose.waitUntil(15_000) { client.state.value.scheduled.none { it.id == second.id } }
            compose.waitUntil(15_000) { client.state.value.conversations[conv]?.messages?.any { it.body == "Segundo programado" } == true }
            log("Enviar ahora: sale y deja la lista")
            val first = client.state.value.scheduled.first { it.conversationId == conv }
            // El aviso «Enviado» tapa el pie de la hoja unos segundos.
            runCatching { compose.waitUntil(15_000) { !hasTextNow(str(R.string.sched_sent_now)) } }
            compose.onNodeWithTag("schedCancel").performTouchInput { click() }
            compose.waitUntil(10_000) { client.state.value.scheduled.none { it.id == first.id } }
            compose.waitUntil(5_000) { hasTextNow(str(R.string.sched_cancelled)) }
            compose.onNodeWithText(str(R.string.undo)).performClick()
            compose.waitUntil(10_000) { client.state.value.scheduled.any { it.body == first.body } }
            log("Cancelar envío con Deshacer")
            androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack()

            // Pantalla «Programados» (Tú).
            compose.onNodeWithTag("back").performClick()
            compose.onNodeWithTag("tab-settings").performClick()
            compose.onNodeWithTag("rowScheduled").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("scheduledScreen"), 10_000)
            assertEquals(1, client.state.value.scheduled.size)
            shot("04-pantalla")
            log("Pantalla Programados")
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
