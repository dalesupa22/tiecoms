package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.ui.TaskUploads
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
 * 1.7.14 contra un API local: Deshacer al ocultar gg, acciones desde un archivo abierto (foto y PDF) y archivos en
 * la tarea (crear tarea desde la foto con el archivo adjunto y adjuntar otro desde el detalle).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class Capturas1714UiTest {
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
        File(ins.targetContext.getExternalFilesDir(null), "1714-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun shell(cmd: String) { ins.uiAutomation.executeShellCommand(cmd).close() }
    private fun back() { androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack(); Thread.sleep(700) }

    @Test fun archivosYGg() {
        val apiUrl = arg("apiUrl"); val general = arg("general"); val imgId = arg("imgId"); val pdfId = arg("pdfId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && general.isNotBlank() && imgId.isNotBlank() && pdfId.isNotBlank())
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
            compose.onNodeWithTag("email").performTextInput(arg("email"))
            compose.onNodeWithTag("password").performTextInput(arg("password"))
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            val client = app.container.client.value

            // 1) ✕ de la píldora: aviso con «Deshacer» que dice dónde recuperarla; Deshacer la devuelve.
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(general) }
            compose.waitUntilAtLeastOneExists(hasTestTag("ggPillOpen"), 20_000)
            compose.onNodeWithTag("ggPillHide").performClick()
            compose.waitUntilAtLeastOneExists(hasText("Deshacer"), 5_000)
            assertFalse("píldora oculta", exists("ggPillOpen"))
            shot("01-gg-oculto-deshacer")
            compose.onNodeWithText("Deshacer").performClick()
            compose.waitUntil(5_000) { exists("ggPillOpen") }
            shot("02-gg-de-vuelta")

            // 2) Foto abierta → ⋯ → «Crear tarea con este archivo»: la tarea nace con la foto adjunta.
            compose.onNodeWithTag("messages", useUnmergedTree = true).performScrollToNode(hasTestTag("att-$imgId"))
            compose.onNodeWithTag("att-$imgId", useUnmergedTree = true).performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("viewerImage"), 10_000)
            compose.onNodeWithTag("fileActions").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("faCreateTask"), 5_000)
            assertTrue("gg desde el archivo", exists("faAskGg")); assertTrue("compartir", exists("faShare")); assertTrue("reenviar", exists("faForward"))
            shot("03-visor-foto-acciones")
            compose.onNodeWithTag("faCreateTask").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issueCreate"), 5_000)
            shot("04-crear-tarea-desde-foto")
            compose.onNodeWithTag("issueCreate").performClick()
            compose.waitUntil(20_000) { client.state.value.issues.values.any { it.title == "plantilla-diploma" && it.attachments.isNotEmpty() } }
            val task = client.state.value.issues.values.first { it.title == "plantilla-diploma" }
            shot("04b-chat-tarea-creada")
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Issue(task.id, general) }
            compose.waitUntilAtLeastOneExists(hasTestTag("issueDetail"), 10_000)
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("taskFiles"))
            val photo = client.state.value.issues[task.id]!!.attachments.first()
            compose.waitUntil(15_000) { exists("taskFileThumb-${photo.id}") }
            shot("05-tarea-con-foto")

            // 3) Adjuntar otro archivo desde el detalle (mismo camino que «Adjuntar»; el selector del sistema no se automatiza).
            val pdf = File(ins.targetContext.cacheDir, "qa-acta.pdf").apply { writeBytes(ins.context.assets.open("qa-acta.pdf").readBytes()) }
            runBlocking { TaskUploads.attach(ins.targetContext, client, task.id, listOf(Attachments.Shared("acta-de-inicio.pdf", "application/pdf", pdf.length(), pdf.absolutePath))) {} }
            compose.waitUntil(15_000) { (client.state.value.issues[task.id]?.attachments?.size ?: 0) == 2 }
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("taskFiles"))
            shot("06-tarea-dos-archivos")
            assertTrue("el API guardó los dos", runBlocking { client.issueDetail(task.id).issue }.attachments.size == 2)
            back()

            // 4) PDF abierto (modo oscuro) → ⋯ con las mismas acciones.
            shell("cmd uimode night yes"); Thread.sleep(2500)
            compose.waitUntilAtLeastOneExists(hasTestTag("messages"), 15_000)
            compose.onNodeWithTag("messages", useUnmergedTree = true).performScrollToNode(hasTestTag("attPdf-$pdfId"))
            compose.onNodeWithText("propuesta.pdf", useUnmergedTree = true).performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("pdfSheet"), 10_000)
            Thread.sleep(1500)
            compose.onNodeWithTag("fileActions").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("faShare"), 5_000)
            shot("07-pdf-acciones-oscuro")
            back(); back()
        } catch (t: Throwable) { shot("zz-fallo"); throw t } finally { shell("cmd uimode night no"); runCatching { scenario.close() } }
    }
}
