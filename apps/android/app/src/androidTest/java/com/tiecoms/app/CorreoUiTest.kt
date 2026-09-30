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
import androidx.compose.ui.test.swipeUp
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
 * Fixture: scratchpad seed-correo-android.mjs (Danny con Gmail y Outlook conectados; en «Ventas Xertify», g1 compartido con
 * comentario y comentado por Laura, y g6 con historial citado).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class CorreoUiTest {
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

    /** La tarjeta en el chat: icono, dirección, asunto, estado, botones; el aviso de comentarios con su franja. */
    @Test fun tarjetaEnElChatYAbrirYComentar() {
        val scenario = launchLoggedIn()
        try {
            val chat = arg("chat"); val id = arg("sharedId"); val quoted = arg("quotedId")
            val client = app.container.client.value
            openChat(chat)
            compose.waitUntil(20_000) { client.state.value.conversations[chat]?.messages?.any { it.body.contains(id) } == true }
            compose.waitUntil(20_000) { client.state.value.mails[id] != null }
            // La fila entera abre el menú de la tarjeta (sus hijos se fusionan): se busca por la fila.
            val cardSeq = client.state.value.conversations[chat]!!.messages.first { it.kind == "system" && it.body.startsWith("{\"k\":\"mail.shared\"") && it.body.contains(id) }.seq
            compose.onNodeWithTag("messages").performScrollToNode(hasTestTag("mailShared-$cardSeq"))
            compose.waitUntilAtLeastOneExists(hasTestTag("mailCard-$id"), 20_000)
            // Se ve como mensaje de quien lo trajo, con su comentario, y la tarjeta (cargada en lote, sin cuerpo).
            compose.waitUntil(10_000) { shows("Miren este correo, ¿cómo le respondemos?") }
            assertTrue(exists("provIcon-google"))
            assertTrue(shows(str(R.string.web_mail_kind_in, "Gmail")))
            assertTrue(shows("Solicitud de presentación para el comité del jueves"))
            assertTrue(shows("Requisitos_comite.pdf"))
            assertTrue(shows(str(R.string.web_mail_pending)))
            assertTrue("Responder: lo trajo Danny y no está respondido", exists("mailCardReply-$id"))
            // Nunca JSON crudo.
            assertFalse(shows("{\"k\":\"mail."))
            // mail.comments: una línea corta que lleva a la tarjeta; la tarjeta trae los últimos comentarios.
            compose.waitUntil(10_000) { exists("mailCommentsLine") }
            assertTrue(shows("Yo preparo los precios por volumen."))
            assertFalse("Sin botón 💬: los comentarios van en la tarjeta", exists("mailCardComments-$id"))
            assertFalse("El lote no trae el cuerpo", client.state.value.mails[id]!!.full)
            shot("01-tarjeta")
            // Comentar ahí mismo, en la tarjeta.
            val c0 = client.state.value.mails[id]!!.commentCount
            val inline = "Desde la tarjeta ${System.currentTimeMillis() % 10000}"
            compose.onNodeWithTag("mailCardInput-$id").performTextInput(inline)
            compose.onNodeWithTag("mailCardSend-$id").performClick()
            compose.waitUntil(15_000) { (client.state.value.mails[id]?.commentCount ?: 0) > c0 }
            compose.waitUntil(10_000) { shows(inline) }
            shot("01b-comentario-en-tarjeta")

            // Abrir el correo: metadatos, cuerpo (?full=1), adjuntos bajo demanda y el hilo.
            compose.onAllNodesWithTag("mailCardTitle-$id", useUnmergedTree = true).onFirst().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailBody"), 15_000)
            assertTrue(shows("precios por volumen y el cronograma"))
            assertTrue(exists("mailMetaFrom")); assertTrue(shows("jorge.ramirez@uniandes.edu.co")); assertTrue(exists("mailMetaCc"))
            assertTrue(exists("mailFile-a1")); assertTrue(exists("mailFile-a2"))
            compose.onNodeWithTag("mailDetail").performScrollToNode(hasText("Yo preparo los precios por volumen.", substring = true))
            shot("02-correo")

            // Comentar al equipo.
            val before = client.state.value.mails[id]!!.commentCount
            val text = "Lo vemos el jueves ${System.currentTimeMillis() % 10000}"
            compose.onNodeWithTag("mailCommentInput").performTextInput(text)
            compose.onNodeWithTag("mailCommentSend").performClick()
            compose.waitUntil(15_000) { (client.state.value.mails[id]?.commentCount ?: 0) > before }
            compose.waitUntil(10_000) { shows(text) }
            assertTrue("El cuerpo sigue cargado tras mail.updated", client.state.value.mails[id]!!.full)
            shot("03-comentado")

            // Responder: CC por defecto (todos menos yo y el destinatario), gg redacta y ▾ programa.
            compose.onNodeWithText("✉ " + str(R.string.web_mail_replyTo, "Jorge"), substring = true, useUnmergedTree = true).performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailReplyCc"), 5_000)
            assertTrue(shows("oscar@uniandes.edu.co"))
            compose.onNodeWithTag("mailGg").performClick()
            // El LLM falso responde «… Saludos, Danny».
            compose.waitUntil(20_000) { shows("Saludos, Danny") }
            compose.onNodeWithTag("mailReplyBody").performTextClearance()
            compose.onNodeWithTag("mailReplyBody").performTextInput("Hola Jorge, te la enviamos el miércoles.")
            shot("04-responder")
            compose.onNodeWithTag("mailReplySchedule", useUnmergedTree = true).performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailSched-1h"), 5_000)
            shot("05-programar")
            compose.onNodeWithTag("mailSched-1h").performClick()
            compose.waitUntil(15_000) { client.state.value.mails[id]?.status == "scheduled" }
            assertNotNull(client.state.value.mails[id]!!.scheduledReply)
            // Vuelve al chat: la tarjeta dice «Respuesta programada · …» y ya no ofrece Responder.
            compose.waitUntilAtLeastOneExists(hasTestTag("mailCard-$id"), 10_000)
            compose.waitUntil(5_000) { shows(str(R.string.web_mail_scheduled)) }
            assertFalse(exists("mailCardReply-$id"))
            shot("06-programada")

            // Cancelar lo programado desde el correo (se espera a que se vaya el aviso de abajo).
            compose.waitUntil(8_000) { !shows(str(R.string.web_mail_scheduledToast, "").trim().substringBefore(" ")) || true }
            Thread.sleep(4500)
            compose.onNodeWithTag("messages").performScrollToNode(hasTestTag("mailShared-$cardSeq"))
            compose.onNodeWithTag("messages").performTouchInput { swipeUp(startY = bottom * 0.7f, endY = bottom * 0.4f) }
            compose.waitForIdle()
            compose.onAllNodesWithTag("mailCardTitle-$id", useUnmergedTree = true).onFirst().performClick()
            runCatching { compose.waitUntilAtLeastOneExists(hasTestTag("mailCancelSchedule"), 10_000) }.onFailure { shot("xx-sin-cancelar"); throw it }
            compose.onNodeWithTag("mailCancelSchedule").performClick()
            compose.waitUntil(15_000) { client.state.value.mails[id]?.status == "pending" }

            // Tarea desde el correo: título sin RE:, responsable, fecha y «cerrar cuando se responda».
            compose.onNodeWithTag("mailTask").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailTaskSheet"), 5_000)
            assertTrue(shows(str(R.string.web_mail_taskPrefix) + " Jorge: Solicitud de presentación"))
            shot("07-tarea")
            compose.onNodeWithTag("mailTaskCreate").performClick()
            compose.waitUntil(15_000) { client.state.value.mails[id]?.issueId != null }
            compose.waitUntilAtLeastOneExists(hasTestTag("mailSeeTask"), 10_000)
            compose.onNodeWithTag("back").performClick()

            // g6: el cuerpo se guardó recortado; «Ver el historial citado y la firma» lo trae en vivo.
            compose.waitUntilAtLeastOneExists(hasTestTag("messages"), 10_000)
            compose.onNodeWithTag("messages").performScrollToNode(hasTestTag("mailCard-$quoted"))
            compose.waitUntilAtLeastOneExists(hasTestTag("mailCardTitle-$quoted"), 10_000)
            compose.onAllNodesWithTag("mailCardTitle-$quoted", useUnmergedTree = true).onFirst().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailShowHistory"), 15_000)
            assertFalse(shows("ya repusimos los 209 créditos"))
            compose.onNodeWithTag("mailShowHistory").performClick()
            compose.waitUntil(15_000) { shows("ya repusimos los 209 créditos") }
            shot("08-historial")
        } finally { scenario.close() }
    }

    /** ＋ › Correo en el chat: la lista en vivo (pestañas, búsqueda), la vista previa y «Comentar aquí». */
    @Test fun compartirDesdeLaLista() {
        val scenario = launchLoggedIn()
        try {
            val chat = arg("chat")
            val client = app.container.client.value
            openChat(chat)
            compose.onNodeWithTag("attach").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("plusMail"), 5_000)
            assertTrue(exists("plusWhatsApp"))
            compose.onNodeWithTag("plusMail").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailList"), 10_000)
            // Dos cuentas: selector Gmail/Outlook. Recibidos › Principal por defecto (sin la promoción ni el pago).
            assertTrue(exists("mailProvider"))
            compose.waitUntilAtLeastOneExists(hasTestTag("mailRow-g1"), 15_000)
            assertFalse(exists("mailRow-g3")); assertFalse(exists("mailRow-g2"))
            assertTrue(shows(str(R.string.web_mail_latest_inbox) + " · " + str(R.string.web_mail_cat_primary)))
            shot("10-lista")
            // Notificaciones: el pago.
            compose.onNodeWithTag("mailCat-updates").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailRow-g2"), 15_000)
            // Buscar sin haber elegido pestaña va a todas (category=any): «presentación» trae g1 y el viejo de 2025 (g5).
            compose.onNodeWithTag("mailCat-primary").performClick()
            compose.onNodeWithTag("mailSearch").performTextInput("presentación")
            compose.waitUntil(15_000) { exists("mailRow-g5") && exists("mailRow-g1") }
            compose.waitUntil(10_000) { shows(str(R.string.web_mail_results, "2", "Gmail")) }
            shot("11-busqueda")
            // Filtro «Con adjuntos»: solo g1.
            compose.onNodeWithTag("mailFAtt").performClick()
            compose.waitUntil(15_000) { !exists("mailRow-g5") && exists("mailRow-g1") }
            compose.onNodeWithTag("mailClear").performClick()
            compose.onNodeWithTag("mailCat-updates").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailRow-g2"), 15_000)
            // Vista previa y «Comentar aquí».
            compose.onNodeWithTag("mailRow-g2").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailPreview"), 5_000)
            compose.waitUntil(15_000) { shows("ya está en tu cuenta") }
            shot("12-vista-previa")
            compose.onNodeWithTag("mailPreviewPick").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mailShare"), 5_000)
            // El chat de origen ya viene elegido; se puede sumar otro (varios chats, hasta 10).
            assertTrue(exists("pickedChat-$chat"))
            assertTrue(exists("mailWhoSees"))
            val other = arg("topicsChat")
            compose.onNodeWithTag("pick-$other").performScrollTo().performClick()
            compose.waitUntil(5_000) { shows(str(R.string.web_mail_shareInMany, "2")) }
            compose.onNodeWithTag("mailShareComment").performTextReplacement("Llegó el pago de Uniandes")
            compose.waitUntil(5_000) { shows("Llegó el pago de Uniandes") }
            shot("13-compartir")
            compose.onNodeWithTag("mailShareConfirm").performScrollTo().performClick()
            compose.waitUntil(15_000) { client.state.value.mails.values.any { it.conversationId == chat && it.subject.startsWith("Recibiste un pago") } }
            // Una tarjeta e hilo por chat (la respuesta del POST trae las dos).
            compose.waitUntil(15_000) { client.state.value.mails.values.any { it.conversationId == other && it.subject.startsWith("Recibiste un pago") } }
            val shared = client.state.value.mails.values.first { it.conversationId == chat && it.subject.startsWith("Recibiste un pago") }
            // Vuelve al chat con la tarjeta nueva.
            compose.waitUntilAtLeastOneExists(hasTestTag("mailCard-${shared.id}"), 15_000)
            assertTrue(shows("Llegó el pago de Uniandes"))
            assertEquals("in", shared.direction)
            shot("14-compartido")
        } finally { scenario.close() }
    }
}
