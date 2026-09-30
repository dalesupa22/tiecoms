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
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Correo en el chat (docs/CORREO.md) contra el API LOCAL con Gmail y Outlook FALSOS (apps/api/test/fake-mail.mjs, un MOCK:
 * no prueba OAuth ni los permisos reales). Nunca producción.
 * Responder, responder en privado y reenviar la tarjeta (76da4d6). Fixture: scratchpad seed-correo-android.mjs (Danny con Gmail y Outlook conectados; en «Ventas Xertify», g1 compartido con
 * comentario y comentado por Laura, y g6 con historial citado).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class CorreoAccionesUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun str(id: Int, vararg a: Any) = app.getString(id, *a)
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shows(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(900)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "correo-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        Log.i("TieComsUiTest", "captura correo-$name")
    }

    private fun launchLoggedIn(): ActivityScenario<MainActivity> {
        assumeTrue("Faltan argumentos del fixture", arg("apiUrl").isNotBlank() && arg("email").isNotBlank() && arg("password").isNotBlank() && arg("sharedId").isNotBlank())
        assertFalse("Nunca contra producción", arg("apiUrl").contains("tiecoms.com") || arg("apiUrl").contains("chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(arg("apiUrl")) }
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
        compose.waitUntil(20_000) { exists("quick.create") }
        compose.waitUntil(10_000) { app.container.client.value.state.value.data?.mailEnabled == true }
        return scenario
    }
    private fun openChat(id: String) {
        ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(id) }
        compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 20_000)
    }

    private fun msgSeqOf(conv: String, emailId: String): Long {
        val c = app.container.client.value
        compose.waitUntil(15_000) { c.state.value.conversations[conv]?.messages?.any { it.kind == "system" && it.body.contains(emailId) } == true }
        return c.state.value.conversations[conv]!!.messages.first { it.kind == "system" && it.body.contains(emailId) && !it.body.contains("mail.comments") }.seq
    }
    private fun scrollTo(tag: String) {
        compose.onNodeWithTag("messages").performScrollToNode(hasTestTag(tag))
        compose.waitUntilAtLeastOneExists(hasTestTag(tag), 5_000)
    }

    @Test fun responderPrivadoYReenviar() {
        val scenario = launchLoggedIn()
        try {
            val chat = arg("chat"); val id = arg("sharedId"); val other = arg("topicsChat"); val fwdId = arg("forwardedId")
            val client = app.container.client.value
            openChat(chat)
            val seq = msgSeqOf(chat, id)
            val cardMsg = client.state.value.conversations[chat]!!.messages.first { it.seq == seq }
            scrollTo("mailShared-$seq")
            // Deslizar a la derecha responde, con la cita «✉ asunto · remitente» (nunca JSON).
            compose.onNodeWithTag("mailShared-$seq").performTouchInput { swipeRight(startX = left + 20f, endX = right - 10f) }
            compose.waitUntilAtLeastOneExists(hasTestTag("replyBar"), 5_000)
            assertTrue(shows("✉ Solicitud de presentación para el comité del jueves · Jorge Ramírez"))
            assertFalse(shows("{\"k\""))
            shot("20-responder-tarjeta")
            val text = "Sí, preparo la presentación ${System.currentTimeMillis() % 10000}"
            compose.onNodeWithTag("composer").performTextInput(text)
            compose.onNodeWithTag("send").performClick()
            compose.waitUntil(15_000) { client.state.value.conversations[chat]?.messages?.any { it.body == text } == true }
            assertEquals(cardMsg.id, client.state.value.conversations[chat]!!.messages.first { it.body == text }.replyTo)
            compose.waitUntil(10_000) { shows(text) }
            assertFalse("La cita no muestra JSON", shows("{\"k\""))
            shot("21-respuesta-citada")

            // Reenviar (pulsación larga): a «Temas Xertify»; la copia dice «Reenviado».
            scrollTo("mailShared-$seq")
            compose.onNodeWithTag("mailShared-$seq").performTouchInput { longClick(androidx.compose.ui.geometry.Offset(60f, 30f)) }
            compose.waitUntilAtLeastOneExists(hasTestTag("cardForward"), 5_000)
            assertFalse("Mi propia tarjeta: sin «Responder en privado»", exists("cardReplyPrivate"))
            shot("22-menu-tarjeta")
            compose.onNodeWithTag("cardForward").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("forwardCard"), 5_000)
            assertFalse("El chat donde ya está no se ofrece", exists("pick-$chat"))
            compose.onNodeWithTag("pick-$other").performScrollTo().performClick()
            compose.onNodeWithTag("forwardComment").performTextReplacement("Reenviado desde Android")
            shot("23-reenviar")
            compose.onNodeWithTag("forwardConfirm").performScrollTo().performClick()
            compose.waitUntil(15_000) { client.state.value.mails.values.count { it.conversationId == other && it.subject.startsWith("Solicitud de presentación") } >= 2 }

            // En «Temas Xertify»: la copia que reenvió Laura; «Responder en privado» a Laura, con la cita de la tarjeta.
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
            val lseq = msgSeqOf(other, fwdId)
            scrollTo("mailShared-$lseq")
            assertTrue(exists("cardForwarded"))
            shot("24-reenviada")
            compose.onNodeWithTag("mailShared-$lseq").performTouchInput { longClick(androidx.compose.ui.geometry.Offset(60f, 30f)) }
            compose.waitUntilAtLeastOneExists(hasTestTag("cardReplyPrivate"), 5_000)
            Thread.sleep(900); compose.waitForIdle() // la hoja termina de subir
            compose.onNodeWithTag("cardReplyPrivate").performClick()
            runCatching { compose.waitUntil(15_000) { shows("✉ Solicitud de presentación para el comité del jueves") && exists("composer") } }.onFailure { shot("xx-privado"); throw it }
            val priv = "Te escribo aparte ${System.currentTimeMillis() % 10000}"
            compose.onNodeWithTag("composer").performTextInput(priv)
            shot("25-privado")
            compose.onNodeWithTag("send").performClick()
            compose.waitUntil(15_000) { client.state.value.conversations.values.any { c -> c.messages.any { it.body == priv && it.forwarded?.messageId != null } } }
            val sent = client.state.value.conversations.values.flatMap { it.messages }.first { it.body == priv }
            assertEquals(client.state.value.conversations[other]!!.messages.first { it.seq == lseq }.id, sent.forwarded?.messageId)
            compose.waitUntil(10_000) { shows(priv) }
            assertFalse(shows("{\"k\""))
            shot("26-privado-enviado")
        } finally { scenario.close() }
    }
}
