package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.AppLanguage
import com.tiecoms.app.core.MemorySecretStore
import com.tiecoms.app.core.MemoryStorage
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.platform.AppLocale
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Pantallas de Firmar en español (mismo fixture que FirmarUiTest): visor en modo ver, «Mis firmas», Crear › Escribir
 * y Foto, firma escrita en cursiva puesta en la hoja, texto libre con sugerencias y «¿Salir sin firmar?».
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class FirmarPantallasUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[firmar-es] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun hasLabel(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "firmar-es-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun pantallasEnEspanol() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val peerEmail = arg("peerEmail"); val password = arg("password"); val conv = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && peerEmail.isNotBlank() && password.isNotBlank() && conv.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl); AppLocale.set(app, AppLanguage.ES) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val peer = TieComsClient(apiUrl, "Peer", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            val client = app.container.client.value
            runBlocking { com.tiecoms.app.ui.SavedSignatures.ensure(client, force = true) }
            val hadSignatures = com.tiecoms.app.ui.SavedSignatures.list.value.orEmpty().any { it.kind == "signature" }
            val before = com.tiecoms.app.ui.SavedSignatures.list.value.orEmpty().map { it.id }.toSet()

            runBlocking { peer.login(peerEmail, password); peer.openConversation(conv) }
            val att = runBlocking {
                val f = PdfFixture.write(File(ins.targetContext.cacheDir, "Contrato ES.pdf"), listOf(0, 0, 90))
                peer.uploadAttachment(conv, f, "Contrato ES ${System.currentTimeMillis() % 10000}.pdf", "application/pdf").also { peer.send(conv, "Revísalo y fírmalo", attachments = listOf(it)) }
            }
            compose.waitUntilAtLeastOneExists(hasTestTag("conv-$conv"), 15_000)
            compose.onNodeWithTag("conv-$conv").performClick()
            compose.waitUntil(20_000) { exists("attPdf-${att.id}") }
            assertTrue("botón «✍️ Firmar» en la burbuja", hasLabel("Firmar"))

            // Tocar la ficha abre el visor en modo ver; «Firmar» de la barra pasa a modo firma.
            compose.onNodeWithTag("attPdf-${att.id}", useUnmergedTree = true).performClick()
            compose.waitUntil(20_000) { exists("pdfStartSign") && exists("pdfPage-1") }
            assertFalse("modo ver: sin barra de herramientas", exists("pdfTools"))
            shot("01-ver")
            compose.onNodeWithTag("pdfStartSign").performClick()
            compose.waitUntil(5_000) { exists("toolSignature") }
            assertTrue(hasLabel("Iniciales") && hasLabel("Fecha") && hasLabel("Texto"))

            // «Firma»: con firmas guardadas abre «Mis firmas»; «Nueva firma» abre Crear.
            compose.onNodeWithTag("toolSignature").performClick()
            if (hadSignatures) {
                compose.waitUntil(10_000) { exists("pickSignature") && exists("newSig") }
                shot("02-mis-firmas")
                compose.onNodeWithTag("newSig", useUnmergedTree = true).performClick()
            }
            compose.waitUntil(10_000) { exists("createSignature") }
            compose.onNodeWithText("Escribir").performClick()
            compose.waitUntil(5_000) { exists("sigFont-2") }
            compose.onNodeWithTag("sigFont-1", useUnmergedTree = true).performClick()
            shot("03-escribir")
            compose.onNodeWithText("Foto").performClick()
            compose.waitUntil(5_000) { exists("sigGallery") }
            assertTrue(hasLabel("Tomar foto") && hasLabel("quitamos el fondo"))
            shot("04-foto")
            compose.onNodeWithText("Escribir").performClick()
            compose.waitUntil(5_000) { exists("sigFont-1") }
            compose.onNodeWithTag("saveSignature").performClick()
            compose.waitUntil(15_000) { exists("mark-signature") && !exists("createSignature") }
            shot("05-firma-escrita")
            log("Firma escrita (Great Vibes) guardada y puesta")

            // Texto libre con sugerencias (mi nombre, fecha).
            compose.onNodeWithTag("toolDone").performClick()
            compose.onNodeWithTag("toolText").performClick()
            compose.waitUntil(5_000) { exists("markText") }
            shot("06-texto")
            compose.onNodeWithTag("markText").performTextInput("C.C. 1.020.304")
            compose.onNodeWithTag("markTextOk").performClick()
            compose.waitUntil(5_000) { exists("mark-text") }
            shot("07-con-texto")

            // Cerrar con marcas: pide confirmación.
            compose.onNodeWithTag("pdfClose").performClick()
            compose.waitUntil(5_000) { exists("discardOk") }
            assertTrue(hasLabel("¿Salir sin firmar?"))
            shot("08-salir")
            compose.onNodeWithTag("discardOk").performClick()
            compose.waitUntil(5_000) { !exists("pdfSheet") }
            log("Pantallas en español OK")
            runBlocking { client.listSignatures().filter { it.id !in before }.forEach { client.deleteSignature(it.id) } }
        } finally {
            scenario.close()
            peer.close()
            ins.runOnMainSync { AppLocale.set(app, AppLanguage.SYSTEM) }
        }
    }
}
