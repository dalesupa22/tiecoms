package com.tiecoms.app

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.core.content.FileProvider
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
 * 1.7.15 contra un API local: «Compartir en chaggu» con un PDF. Acciones (claro y oscuro), selector nuevo con dos
 * elegidos, Analizar con gg (llega al chat con gg), Guardar en mis archivos, Crear tarea con el PDF y Firmar.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class Capturas1715UiTest {
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
        File(ins.targetContext.getExternalFilesDir(null), "1715-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun shell(cmd: String) { ins.uiAutomation.executeShellCommand(cmd).close() }
    private fun back() { androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack(); Thread.sleep(700) }

    /** Abre «Compartir en chaggu» con el PDF, como si viniera del sistema. */
    private fun sharePdf(name: String) {
        val dir = File(ins.targetContext.cacheDir, "att/qa-share").apply { mkdirs() }
        val f = File(dir, name).apply { writeBytes(ins.context.assets.open("qa-acta.pdf").readBytes()) }
        val uri = FileProvider.getUriForFile(ins.targetContext, ins.targetContext.packageName + ".files", f)
        val send = Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ins.targetContext.startActivity(send.setClass(ins.targetContext, ShareActivity::class.java))
        compose.waitUntil(15_000) { exists("shareActions") }
        compose.waitUntil(10_000) { exists("shareFileMeta") }
    }

    @Test fun compartirConAcciones() {
        val apiUrl = arg("apiUrl")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && arg("dmB").isNotBlank())
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

            // 1) Acciones, claro y oscuro.
            sharePdf("Contrato-Andina.pdf")
            assertTrue("firmar (PDF)", exists("shareActSign")); assertTrue("guardar", exists("shareActSave"))
            shot("01-acciones")
            shell("cmd uimode night yes"); Thread.sleep(2500)
            compose.waitUntil(10_000) { exists("shareActions") }
            shot("02-acciones-oscuro")
            shell("cmd uimode night no"); Thread.sleep(2500)

            // 2) Selector: buscador arriba, recientes en círculos, lista plana; dos elegidos abajo.
            compose.waitUntil(10_000) { exists("shareActSend") }
            compose.onNodeWithTag("shareActSend").performClick()
            compose.waitUntil(5_000) { exists("shareSearch") && exists("sharePickHint") }
            shot("03-selector")
            val dmB = arg("dmB"); val dmC = arg("dmC")
            compose.onNodeWithTag(if (exists("shareRecent-$dmB")) "shareRecent-$dmB" else "shareTarget-$dmB").performClick()
            compose.onNodeWithTag(if (exists("shareRecent-$dmC")) "shareRecent-$dmC" else "shareTarget-$dmC").performClick()
            compose.waitUntil(5_000) { exists("shareSelected") && exists("shareSendGroup") }
            shot("04-selector-dos-elegidos")
            compose.onNodeWithTag("shareSearch").performTextInput("andina")
            Thread.sleep(500)
            shot("05-selector-buscando")
            back(); back()

            // 3) Guardar en mis archivos.
            sharePdf("Guardado-QA.pdf")
            compose.onNodeWithTag("shareActSave").performClick()
            compose.waitUntil(20_000) { runCatching { runBlocking { client.driveTree(null) }.files.any { it.name == "Guardado-QA.pdf" } }.getOrDefault(false) }

            // 4) Crear tarea con el PDF: la hoja de siempre, título del archivo.
            sharePdf("Propuesta-Tarea.pdf")
            compose.onNodeWithTag("shareActTask").performClick()
            compose.waitUntil(5_000) { exists("issueQuickAdd") }
            Thread.sleep(500)
            shot("06-crear-tarea")
            compose.onNodeWithTag("issueQuickSubmit").performClick()
            compose.waitUntil(25_000) { client.state.value.issues.values.any { it.title == "Propuesta-Tarea" && it.attachments.isNotEmpty() } }

            // 5) Firmar: el PDF queda en «Tú» y se abre el firmador.
            sharePdf("Firmar-QA.pdf")
            compose.onNodeWithTag("shareActSign").performClick()
            compose.waitUntil(25_000) { exists("pdfSheet") }
            Thread.sleep(1500)
            shot("07-firmar")
            back(); Thread.sleep(800)
            if (exists("pdfSheet")) back()

            // 6) Analizar con gg: el PDF y la pregunta llegan al chat con gg y se abre ese chat.
            sharePdf("Analizar-QA.pdf")
            compose.onNodeWithTag("shareActAnalyze").performClick()
            val gg = runBlocking { client.ggChatId() }
            compose.waitUntil(30_000) { exists("composer") }
            compose.waitUntil(20_000) {
                client.state.value.conversations[gg]?.messages?.any { m -> m.attachments.any { it.name == "Analizar-QA.pdf" } && m.body.startsWith("Analiza este archivo") } == true
            }
            shot("08-analizar-con-gg")
        } catch (t: Throwable) { shot("zz-fallo"); throw t } finally { shell("cmd uimode night no"); runCatching { scenario.close() } }
    }
}
