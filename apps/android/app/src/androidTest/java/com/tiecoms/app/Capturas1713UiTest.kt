package com.tiecoms.app

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.DeepLink
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
 * 1.7.13 contra un API local de pruebas: píldora de gg abajo y cabecera sin gg, barra de reacciones con «＋» visible,
 * compartir con 2 directos («Enviar por separado» / «Enviar en un grupo») y Tareas en claro y oscuro.
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3113 -e email … -e password … -e general id -e dmB id -e dmC id \
 *     -e class com.tiecoms.app.Capturas1713UiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class Capturas1713UiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()
    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(900)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "1713-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun shell(cmd: String) { ins.uiAutomation.executeShellCommand(cmd).close() }

    private fun login(): ActivityScenario<MainActivity> {
        val apiUrl = arg("apiUrl")
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        compose.waitUntil(20_000) { exists("email") && !exists("splash") }
        compose.onNodeWithTag("email").performTextInput(arg("email"))
        compose.onNodeWithTag("password").performTextInput(arg("password"))
        compose.onNodeWithTag("login").performScrollTo().performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
        return scenario
    }

    /** 54: tarjeta de evento con reacciones (la 🎉 de Laura llega del fixture; el 👍 se pone desde la barra). */
    @Test fun reaccionesEnTarjeta() {
        val general = arg("general"); val seq = arg("cardSeq")
        assumeTrue("Faltan argumentos del fixture", arg("apiUrl").isNotBlank() && general.isNotBlank() && seq.isNotBlank())
        shell("cmd uimode night no")
        val scenario = login()
        try {
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(general) }
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 20_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("messages"), 20_000)
            Thread.sleep(2000)
            compose.onNodeWithTag("messages", useUnmergedTree = true).performScrollToNode(hasTestTag("cardReactable-$seq"))
            compose.onNodeWithTag("messages", useUnmergedTree = true).performScrollToNode(hasTestTag("reactions-$seq"))
            compose.waitUntilAtLeastOneExists(hasTestTag("reactions-$seq"), 10_000)
            compose.onNodeWithTag("cardReactable-$seq").performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("quickMore"), 5_000)
            val more = compose.onNodeWithTag("quickMore", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            assertTrue("«＋» dentro de la pantalla", more.right <= ins.targetContext.resources.displayMetrics.widthPixels && more.left >= 0)
            shot("11-tarjeta-barra")
            compose.onNodeWithTag("quick-👍").performClick()
            val c = app.container.client.value
            compose.waitUntil(10_000) { c.state.value.conversations[general]?.messages?.firstOrNull { it.seq.toString() == seq }?.reactions?.any { r -> r.emoji == "👍" && c.state.value.data?.me?.id in r.userIds } == true }
            Thread.sleep(800)
            compose.onNodeWithTag("messages", useUnmergedTree = true).performScrollToNode(hasTestTag("reactions-$seq"))
            shot("12-tarjeta-con-reacciones")
        } finally { scenario.close() }
    }

    @Test fun capturas() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password")
        val general = arg("general"); val dmB = arg("dmB"); val dmC = arg("dmC")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && general.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        shell("cmd uimode night no")
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
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
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)

            // 1) Chat: cabecera atrás · nombre · 📞 · 🔎 · ⋯ y la píldora «✨ Preguntar a gg» abajo.
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(general) }
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 20_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("ggPillOpen"), 15_000)
            assertFalse("gg salió de la cabecera", exists("ggSideButton"))
            assertTrue("🔎", exists("chatSearch")); assertTrue("⋯", exists("convMenu"))
            assertFalse("la ✨ suelta salió del compositor", exists("ggSpark"))
            shot("01-chat-gg-abajo")

            // 2) Mantener presionado un mensaje: 6 emojis y «＋» visibles sin deslizar.
            compose.onNodeWithTag("back").performClick()
            Thread.sleep(800)
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(dmB) }
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 20_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("ggPillOpen"), 15_000)
            shot("01b-directo-gg-abajo")
            compose.waitUntilAtLeastOneExists(androidx.compose.ui.test.hasText("Me compartes la propuesta", substring = true), 20_000)
            compose.onNodeWithText("Me compartes la propuesta", substring = true).performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("quickMore"), 5_000)
            val more = compose.onNodeWithTag("quickMore", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val width = ins.targetContext.resources.displayMetrics.widthPixels
            assertTrue("«＋» dentro de la pantalla", more.right <= width && more.left >= 0)
            shot("02-reacciones")
            androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack()
            Thread.sleep(600)

            // 3) ✕ de la píldora: se esconde en este chat y vuelve desde ⋯ «Preguntar a gg».
            compose.onNodeWithTag("ggPillHide").performClick()
            compose.waitUntil(5_000) { !exists("ggPillOpen") }
            shot("03-pildora-escondida")
            compose.onNodeWithTag("convMenu").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("menuGgOpen"), 5_000)
            compose.onNodeWithTag("menuGgOpen").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("ggSideSheet"), 10_000)
            Thread.sleep(800)
            shot("04-hoja-gg-desde-menu")
            // Sin permiso de IA en el API local sale primero el diálogo de DeepSeek: atrás hasta cerrar la hoja.
            repeat(3) { if (exists("ggSideSheet")) { androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack(); Thread.sleep(900) } }
            compose.waitUntil(8_000) { !exists("ggSideSheet") }
            compose.waitUntil(8_000) { exists("ggPillOpen") }
            shot("04b-pildora-de-vuelta")
            compose.onNodeWithTag("back").performClick()
            Thread.sleep(800)

            // 4) Tareas, claro y oscuro.
            compose.onNodeWithTag("tab-issues").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("taskFilter"), 10_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("taskBucket-OVERDUE"), 10_000)
            shot("05-tareas-claro")
            compose.onNodeWithTag("taskFilter-open").performClick()
            shot("06-tareas-abiertas")
            compose.onNodeWithTag("taskGrouping").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("taskGrouping-date"), 5_000)
            shot("07-tareas-menu-orden")
            compose.onNodeWithTag("taskGrouping-date").performClick()
            Thread.sleep(400)

            // 4b) Mantener presionado: «Cambiar responsable» → Josué y «Cambiar fecha» → Mañana, contra el API.
            val task = arg("task"); val josue = arg("josue")
            if (task.isNotBlank() && josue.isNotBlank()) {
                val client = app.container.client.value
                compose.onNodeWithTag("issues").performScrollToNode(hasTestTag("issue-$task"))
                compose.onNodeWithTag("issue-$task").performTouchInput { longClick() }
                compose.waitUntilAtLeastOneExists(hasTestTag("menuTaskOwner"), 5_000)
                shot("07b-tarea-menu-editar")
                compose.onNodeWithTag("menuTaskOwner").performClick()
                compose.waitUntilAtLeastOneExists(hasTestTag("owner-$josue"), 5_000)
                shot("07c-cambiar-responsable")
                compose.onNodeWithTag("owner-$josue").performClick()
                compose.waitUntil(10_000) { client.state.value.issues[task]?.ownerId == josue }
                Thread.sleep(1500)
                compose.waitUntil(10_000) { runBlocking { client.issueDetail(task).issue }.ownerId == josue } // lo guardó el API
                compose.onNodeWithTag("issue-$task").performTouchInput { longClick() }
                compose.waitUntilAtLeastOneExists(hasTestTag("menuTaskDue"), 5_000)
                compose.onNodeWithTag("menuTaskDue").performClick()
                compose.waitUntilAtLeastOneExists(hasTestTag("dueQuick-TOMORROW"), 5_000)
                shot("07d-cambiar-fecha")
                compose.onNodeWithTag("dueQuick-TOMORROW").performClick()
                val tomorrow = com.tiecoms.app.core.IssueTasks.localToday().plusDays(1).toString()
                compose.waitUntil(10_000) { client.state.value.issues[task]?.dueDate == tomorrow }
                Thread.sleep(1500)
                compose.waitUntil(10_000) { runBlocking { client.issueDetail(task).issue }.dueDate == tomorrow } // lo guardó el API
                Thread.sleep(800)
                shot("07e-tareas-tras-editar")
                // Detalle: responsable de un toque y campos propios.
                compose.onNodeWithTag("issue-$task").performClick()
                compose.waitUntilAtLeastOneExists(hasTestTag("issueOwnerChange"), 10_000)
                shot("07f-detalle")
                compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("taskFields"))
                shot("07g-detalle-campos")
                compose.onNodeWithTag("back").performClick()
                compose.waitUntilAtLeastOneExists(hasTestTag("taskFilter"), 10_000)
            }
            compose.onNodeWithTag("taskFilter-mine").performClick()
            shell("cmd uimode night yes")
            Thread.sleep(2500)
            compose.waitUntilAtLeastOneExists(hasTestTag("taskFilter"), 10_000)
            shot("08-tareas-oscuro")
            compose.onNodeWithTag("taskAddFab").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issueQuickAdd"), 5_000)
            shot("09-anadir-tarea-oscuro")
            androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack()
            androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack()
            shell("cmd uimode night no")
            Thread.sleep(2000)

            // 5) Compartir texto a 2 directos: botón grande abajo y «Enviar en un grupo».
            if (dmB.isNotBlank() && dmC.isNotBlank()) {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "https://xertify.co/propuesta-andina.pdf")
                ins.targetContext.startActivity(Intent(send).setClass(ins.targetContext, ShareActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                compose.waitUntilAtLeastOneExists(hasTestTag("shareRecent-$dmB") or hasTestTag("shareTarget-$dmB"), 15_000)
                compose.onNodeWithTag(if (exists("shareRecent-$dmB")) "shareRecent-$dmB" else "shareTarget-$dmB").performClick()
                compose.onNodeWithTag(if (exists("shareRecent-$dmC")) "shareRecent-$dmC" else "shareTarget-$dmC").performClick()
                compose.waitUntilAtLeastOneExists(hasTestTag("shareSendGroup"), 5_000)
                shot("10-compartir-dos-directos")
                compose.onNodeWithTag("shareSendGroup").performClick()
                val c = app.container.client.value
                compose.waitUntil(20_000) { c.state.value.data?.conversations?.any { it.kind == "multi" && it.lastMessagePreview?.contains("propuesta-andina") == true } == true }
            }
        } finally { shell("cmd uimode night no"); scenario.close() }
    }
}
