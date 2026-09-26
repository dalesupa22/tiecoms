package com.tiecoms.app

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.rightClick
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.pinch
import androidx.compose.ui.geometry.Offset
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.UiDevice
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.platform.NotificationActionReceiver
import com.tiecoms.app.platform.Notifier
import com.tiecoms.app.platform.TcMessagingService
import com.tiecoms.app.ui.CropEditor
import com.tiecoms.app.ui.theme.TieComsTheme
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
import java.util.UUID

internal fun tagPrefix(p: String) = androidx.compose.ui.test.SemanticsMatcher("tag^$p") {
    it.config.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.TestTag) { null }?.startsWith(p) == true
}

/** Capturas en getExternalFilesDir(null)/<nombre>.png (se copian con adb pull). */
internal fun shot(name: String) {
    val ins = InstrumentationRegistry.getInstrumentation()
    val bmp = ins.uiAutomation.takeScreenshot() ?: return
    val f = File(ins.targetContext.getExternalFilesDir(null), "$name.png")
    f.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    Log.i("TieComsUiTest", "captura: ${f.absolutePath}"); println("[v3fb] captura: ${f.absolutePath}")
}

/**
 * SPEC-v3 (feedback de TestFlight) de punta a punta en el emulador contra el API de pruebas (3043):
 * jerarquía de Inicio, menús de pulsación larga (lista y mensaje), avatares, lateral, respuesta en privado,
 * asuntos con comentarios, foto del grupo y la notificación MessagingStyle con Responder.
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3043 -e email … -e password … -e conversationId … -e peerId … \
 *     -e class com.tiecoms.app.FeedbackUiTest com.tiecoms.app.test/androidx.test.runner.AndroidJUnitRunner
 *
 * Con scripts/realtime-peer2.mjs corriendo como el par (responde «eco: …»).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class FeedbackUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[v3fb] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(ins)
    private val app get() = ins.targetContext.applicationContext as TieComsApp

    private fun waitText(text: String, ms: Long = 20_000) =
        compose.waitUntil(ms) { compose.onAllNodes(hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun feedbackV3() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val convId = arg("conversationId"); val peerId = arg("peerId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && convId.isNotBlank() && peerId.isNotBlank())
        assertFalse("Nunca contra producción", (apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com")))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try { flow(convId, peerId, email, password) } catch (t: Throwable) { shot("v3fb-fallo"); throw t } finally { runCatching { scenario.close() } }
    }

    private fun open(uri: String) = ins.targetContext.startActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(ins.targetContext.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

    private fun flow(convId: String, peerId: String, email: String, password: String) {
        compose.waitUntil(20_000) { exists("email") && !exists("splash") }
        compose.onNodeWithTag("email").performTextInput(email)
        compose.onNodeWithTag("password").performTextInput(password)
        compose.onNodeWithTag("login").performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conv-$convId"), 20_000)
        val client = app.container.client.value
        val data = client.state.value.data!!
        val ws = data.conversations.first { it.id == convId }.workspaceId!!
        // Grupos (docs/GRUPOS.md): el espacio compartido es una relación de un solo espacio, sin cabecera propia.
        assertTrue("sección Relaciones", exists("add-RELATIONS"))
        assertTrue("sin cabecera de espacio en una relación de un espacio", !exists("ws-$ws"))
        Thread.sleep(600); shot("v3fb-01-inicio-jerarquia")
        log("Grupos: Relaciones → empresa → grupos; Chats en DMs")

        // §8 Pulsación larga en la lista → menú anclado (fijar, silenciar, no leído, detalles).
        compose.onNodeWithTag("conv-$convId").performTouchInput { longClick() }
        compose.waitUntilAtLeastOneExists(hasTestTag("contextMenu"), 5_000)
        assertTrue("Detalles en el menú de la lista", exists("menuDetails"))
        Thread.sleep(400); shot("v3fb-02-menu-lista")
        device.pressBack()
        compose.waitUntil(5_000) { !exists("contextMenu") }
        log("§8 lista: menú anclado con Detalles; se cierra con Atrás")

        // §5 Avatares: mensaje de A y eco del par.
        compose.onNodeWithTag("conv-$convId").performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 10_000)
        val tag = UUID.randomUUID().toString().take(5)
        val text = "¿Revisamos el presupuesto? $tag"
        compose.onNodeWithTag("composer").performTextInput(text)
        compose.onNodeWithTag("send").performClick()
        waitText("eco: $text")
        compose.waitUntil(5_000) { compose.onAllNodes(tagPrefix("avatar-"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertTrue("encabezado Empresa · Espacio", exists("chatPath"))
        Thread.sleep(500); shot("v3fb-03-chat-avatares")
        log("§5 avatar 28dp y nombre en color a la izquierda del par; §9 encabezado Empresa · Espacio")

        // §8 Pulsación larga en un mensaje del par → menú anclado con íconos, como en iPhone.
        val echo = hasText("eco: $text")
        compose.onNode(echo, useUnmergedTree = true).performScrollTo().performTouchInput { longClick() }
        compose.waitUntilAtLeastOneExists(hasTestTag("contextMenu"), 5_000)
        assertTrue("Responder en privado", exists("menuReplyPrivate")); assertTrue("Preguntar en privado (lateral)", exists("menuSide"))
        Thread.sleep(500); shot("v3fb-04-menu-mensaje")
        // Toque fuera del menú → se cierra.
        device.click(device.displayWidth / 2, (device.displayHeight * 0.12).toInt())
        compose.waitUntil(5_000) { !exists("contextMenu") }
        log("§8 mensaje: menú anclado (con Responder en privado y lateral); se cierra al tocar fuera")
        // Clic derecho (ratón) también abre el menú.
        compose.onNode(echo, useUnmergedTree = true).performScrollTo().performMouseInput { rightClick() }
        compose.waitUntilAtLeastOneExists(hasTestTag("contextMenu"), 5_000)
        device.pressBack(); compose.waitUntil(5_000) { !exists("contextMenu") }
        log("§8 clic derecho abre el mismo menú")

        // §4 Lateral sobre el mensaje del par.
        compose.onNode(echo, useUnmergedTree = true).performScrollTo().performTouchInput { longClick() }
        compose.waitUntilAtLeastOneExists(hasTestTag("menuSide"), 5_000)
        compose.onNodeWithTag("menuSide").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("sideSheet"), 5_000)
        compose.onNodeWithTag("sidePerson-$peerId", useUnmergedTree = true).performScrollTo().performClick()
        compose.onNodeWithTag("sideQuestion").performScrollTo().performTextInput("¿Tú lo apruebas? $tag")
        Thread.sleep(300); shot("v3fb-05-lateral-elegir")
        compose.onNodeWithTag("sideStart").performScrollTo().performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("sideAnchor"), 10_000)
        waitText("¿Tú lo apruebas? $tag")
        Thread.sleep(800); shot("v3fb-06-lateral-panel")
        compose.onNodeWithTag("sideClose").performClick()
        compose.waitUntil(5_000) { !exists("sideAnchor") }
        compose.waitUntilAtLeastOneExists(hasTestTag("sideChip"), 10_000)
        Thread.sleep(400); shot("v3fb-07-lateral-chip")
        log("§4 lateral: selector, panel con el ancla fija, chip bajo el mensaje")

        // §7 Responder en privado → directo con la cita arriba del compositor.
        compose.onNode(echo, useUnmergedTree = true).performScrollTo().performTouchInput { longClick() }
        compose.waitUntilAtLeastOneExists(hasTestTag("menuReplyPrivate"), 5_000)
        compose.onNodeWithTag("menuReplyPrivate").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("privateReplyBar"), 10_000)
        val priv = "Te escribo por aquí $tag"
        compose.onNodeWithTag("composer").performTextInput(priv)
        compose.onNodeWithTag("send").performClick()
        val myQuote = hasTestTag("privateReplyTag") and hasText("eco: $text", substring = true)
        compose.waitUntilAtLeastOneExists(myQuote, 15_000)
        Thread.sleep(600); shot("v3fb-08-respuesta-privada")
        log("§7 respuesta en privado: directo con la cita del servidor (excerpt) y enlace al original")
        compose.onNode(myQuote).performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("chatPath"), 10_000)
        log("§7 la cita abre el chat de origen (?m=messageSeq)")

        // §9 Barra de asuntos abiertos y §3 comentarios.
        val issue = runBlocking { client.createIssue(convId, "Aprobar presupuesto $tag", null, null, null) }
        compose.waitUntilAtLeastOneExists(hasTestTag("barIssues"), 10_000) // barra de accesos del chat (docs/GRUPOS.md)
        Thread.sleep(400); shot("v3fb-09-barra-asuntos")
        open("tiecoms://asuntos")
        compose.waitUntilAtLeastOneExists(hasTestTag("issue-${issue.id}"), 10_000)
        Thread.sleep(400); shot("v3fb-10-asuntos-agrupados")
        compose.onNodeWithTag("issue-${issue.id}").performScrollTo().performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("issueComment"), 10_000)
        compose.onNodeWithTag("issueComment").performTextInput("Lo reviso hoy $tag")
        compose.onNodeWithTag("issueCommentSend").performClick()
        waitText("Lo reviso hoy $tag")
        compose.waitUntil(8_000) { client.state.value.issues[issue.id]?.commentCount == 1 }
        Thread.sleep(400); shot("v3fb-11-comentario")
        log("§3 comentario publicado y en el historial con autor y hora")

        // §1 Foto del grupo: detalles → Poner foto → origen (galería/cámara/archivos).
        open("tiecoms://c/$convId")
        compose.waitUntilExactlyOneExists(hasTestTag("details"), 10_000)
        compose.onNodeWithTag("details").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("groupPhoto"), 10_000)
        compose.onNodeWithTag("groupPhoto").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("photoGallery"), 5_000)
        assertTrue(exists("photoCamera") && exists("photoFiles"))
        Thread.sleep(500); shot("v3fb-12-foto-origen")
        device.pressBack()
        log("§1 foto del grupo: galería, cámara o archivos")

        // §6 Push: con la app en segundo plano llega un data message de FCM.
        device.pressHome()
        compose.waitUntil(5_000) { !app.container.foreground }
        val msgId = UUID.randomUUID().toString()
        val conv = client.meta(convId)!!
        val title = com.tiecoms.app.core.Names.conversationTitle(conv, client.state.value.data, "Interno", "Conversación")
        val peerName = com.tiecoms.app.core.Names.person(client.state.value.data, peerId)?.name ?: "Par"
        val nm = ins.targetContext.getSystemService(NotificationManager::class.java)
        nm.cancelAll()
        TcMessagingService.handle(ins.targetContext, mapOf(
            "type" to "message", "category" to "TC_MESSAGE", "title" to title, "subtitle" to "$peerName · Empresa", "body" to "¿Lo cerramos hoy? $tag",
            "badge" to "3", "threadId" to convId, "conversationId" to convId, "messageId" to msgId, "authorId" to peerId, "authorName" to peerName, "authorAvatarUrl" to "",
        ))
        compose.waitUntil(5_000) { nm.activeNotifications.any { it.id == convId.hashCode() } }
        val sbn = nm.activeNotifications.first { it.id == convId.hashCode() }
        val n = sbn.notification
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        assertNotNull("MessagingStyle", style); assertTrue(style!!.isGroupConversation)
        assertEquals(peerName, style.messages.last().person?.name?.toString())
        assertEquals(convId, n.shortcutId); assertEquals(Notifier.CHANNEL_ID, n.channelId)
        assertEquals(2, n.actions.size); assertEquals(3, n.number)
        if (Build.VERSION.SDK_INT >= 29) assertNotNull("burbuja", n.bubbleMetadata)
        // El mismo mensaje por el socket no se duplica.
        TcMessagingService.handle(ins.targetContext, mapOf("type" to "message", "title" to title, "body" to "x", "conversationId" to convId, "messageId" to msgId))
        assertEquals(1, nm.activeNotifications.count { it.id == convId.hashCode() })
        device.openNotification()
        device.wait(androidx.test.uiautomator.Until.hasObject(androidx.test.uiautomator.By.textContains("Lo cerramos hoy")), 5_000)
        Thread.sleep(1_200); shot("v3fb-13-notificacion")
        log("§6 push: MessagingStyle (Person del autor, título del chat), atajo $convId, burbuja, Responder y Marcar leído, badge 3")

        // Responder desde la notificación (RemoteInput) → llega al chat y el par contesta con eco.
        val reply = "Sí, hoy $tag"
        val intent = Intent(ins.targetContext, NotificationActionReceiver::class.java).setAction(Notifier.ACTION_REPLY).putExtra(Notifier.EXTRA_CONVERSATION, convId)
        RemoteInput.addResultsToIntent(arrayOf(RemoteInput.Builder(Notifier.KEY_REPLY).build()), intent, android.os.Bundle().apply { putCharSequence(Notifier.KEY_REPLY, reply) })
        ins.targetContext.sendBroadcast(intent)
        compose.waitUntil(15_000) { client.state.value.conversations[convId]?.messages?.any { it.body == "eco: $reply" } == true }
        Thread.sleep(600); shot("v3fb-14-notificacion-respondida")
        device.pressBack()
        log("§6 Responder desde la notificación: enviado y el par respondió «eco: $reply»")
    }
}

/** §2 Editor de recorte circular con una foto real: mover, zoom, Guardar → JPEG 512×512 ≤ 3 MB. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class CropEditorUiTest {
    @get:Rule val compose = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    @Test
    fun recorteCircular() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val f = File(ctx.cacheDir, "crop-test.jpg")
        val src = Bitmap.createBitmap(1600, 1000, Bitmap.Config.ARGB_8888)
        android.graphics.Canvas(src).apply {
            drawColor(0xFF2F6FDB.toInt())
            drawCircle(1100f, 500f, 380f, android.graphics.Paint().apply { color = 0xFFFFFFFF.toInt() })
            drawRect(100f, 100f, 500f, 900f, android.graphics.Paint().apply { color = 0xFF1E8E5A.toInt() })
        }
        f.outputStream().use { src.compress(Bitmap.CompressFormat.JPEG, 92, it) }
        var uploaded: ByteArray? = null
        var saved = false
        compose.setContent {
            TieComsTheme { CropEditor(Uri.fromFile(f), onCancel = {}, upload = { uploaded = it }, onSaved = { saved = true }) }
        }
        compose.waitUntilAtLeastOneExists(hasTestTag("cropArea"), 10_000)
        compose.waitForIdle(); Thread.sleep(400); shot("v3fb-15a-recorte-inicial")
        compose.onNodeWithTag("cropArea", useUnmergedTree = true).performTouchInput { swipeLeft(startX = centerX + 60f, endX = centerX - 60f) }
        compose.onNodeWithTag("cropArea", useUnmergedTree = true).performTouchInput {
            pinch(center + Offset(-100f, 0f), center + Offset(-150f, 0f), center + Offset(100f, 0f), center + Offset(150f, 0f))
        }
        compose.waitForIdle(); Thread.sleep(400); shot("v3fb-15b-recorte-movido")
        compose.onNodeWithTag("cropSave").performClick()
        compose.waitUntil(10_000) { saved }
        val bytes = uploaded!!
        val out = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(512, out.width); assertEquals(512, out.height)
        assertTrue("≤ 3 MB", bytes.size <= 3 * 1024 * 1024)
        assertTrue("JPEG", bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte())
        println("[v3fb] recorte: ${bytes.size} B, ${out.width}×${out.height}")
    }
}
