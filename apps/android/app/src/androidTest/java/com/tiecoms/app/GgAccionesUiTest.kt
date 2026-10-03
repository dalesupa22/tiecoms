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
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 2-oct-2026: gg propone, la persona confirma. Agendar llega lleno con el chat (sin crear nada) y el correo de gg solo sale
 * tras «Enviar» + confirmar. Contra un API local con la IA y Gmail falsos (apps/api/test/fake-mail.mjs):
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3099 -e fake http://10.0.2.2:59499 -e email … -e password … -e chat <id> \
 *     -e class com.tiecoms.app.GgAccionesUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class GgAccionesUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()
    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun text(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
    private fun shot(name: String) {
        Thread.sleep(700)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "ggacciones-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun http(method: String, url: String, json: String? = null): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        if (json != null) { c.doOutput = true; c.setRequestProperty("content-type", "application/json"); c.outputStream.use { it.write(json.toByteArray()) } }
        return c.inputStream.bufferedReader().use { it.readText() }.also { c.disconnect() }
    }
    private fun llm(fake: String, content: JSONObject) = http("POST", "$fake/__llm", JSONObject().put("content", content.toString()).put("sticky", true).toString())

    @Test fun agendarLlenoYCorreoConConfirmacion() {
        val apiUrl = arg("apiUrl"); val fake = arg("fake"); val email = arg("email"); val password = arg("password"); val chat = arg("chat")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && fake.isNotBlank() && email.isNotBlank() && password.isNotBlank() && chat.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val sentBefore = JSONArray(http("GET", "$fake/sent")).length()
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(chat) }
            compose.waitUntilAtLeastOneExists(hasTestTag("ggPillOpen"), 20_000)
            compose.onNodeWithTag("ggPillOpen").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("ggSideChips"), 15_000)
            Thread.sleep(1500) // que termine de abrir el hilo de gg antes de fijar la respuesta falsa

            // 1) Agendar: gg llena el formulario con el chat; nada se crea sin «Confirmar y agendar».
            llm(fake, JSONObject().put("title", "Revisión con el cliente").put("durationMin", 45)
                .put("people", JSONArray(listOf("Beto", "Fantasma Pérez"))).put("emails", JSONArray(listOf("jorge@cliente.com", "inventado@x.com"))).put("description", "Revisar la propuesta"))
            compose.onNodeWithTag("ggSideChips").performScrollToNode(hasTestTag("ggMeetingChip"))
            compose.onNodeWithTag("ggMeetingChip").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("ggMeetingNote"), 20_000)
            assertEquals("Revisión con el cliente", text("ggMeetingTitle"))
            assertEquals("jorge@cliente.com", text("ggMeetingEmails"))
            assertTrue(text("ggMeetingDescription").contains("https://meet.example.com/abc-defg"))
            assertTrue("chip de Beto", exists("ggMeetingInvitees"))
            assertTrue("aviso de Fantasma", exists("ggMeetingMissing"))
            assertEquals("45", text("slotsDuration"))
            shot("1-agendar")
            ins.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            compose.waitUntil(10_000) { !exists("ggCalendar") }

            // 2) Correo: borrador editable, «Enviar» pide confirmar y solo entonces sale.
            llm(fake, JSONObject().put("to", JSONArray(listOf("jorge@cliente.com", "Beto"))).put("subject", "Propuesta y reunión").put("body", "Hola Jorge,\n\nTe comparto la propuesta.\n\nAna"))
            if (!exists("ggSideChips")) { compose.onNodeWithTag("ggPillOpen").performClick(); compose.waitUntilAtLeastOneExists(hasTestTag("ggSideChips"), 15_000) }
            compose.onNodeWithTag("ggSideChips").performScrollToNode(hasTestTag("ggMailChip"))
            compose.onNodeWithTag("ggMailChip").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("ggMailNote"), 20_000)
            assertTrue(exists("ggMailFrom")); assertTrue("aviso de Beto sin correo", exists("ggMailMissing"))
            assertEquals("jorge@cliente.com", text("ggMailTo")); assertEquals("Propuesta y reunión", text("ggMailSubject"))
            shot("2-correo")
            compose.onNodeWithTag("ggMailSend").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("ggMailConfirm"), 5_000)
            assertEquals("aún no sale nada", sentBefore, JSONArray(http("GET", "$fake/sent")).length())
            shot("3-confirmar")
            compose.onNodeWithTag("ggMailConfirmSend").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("ggMailSent"), 20_000)
            shot("4-enviado")
            val sent = JSONArray(http("GET", "$fake/sent"))
            assertEquals("un solo envío", sentBefore + 1, sent.length())
            assertTrue(sent.getJSONObject(sent.length() - 1).toString().contains("jorge@cliente.com"))
        } finally { scenario.close() }
    }
}

