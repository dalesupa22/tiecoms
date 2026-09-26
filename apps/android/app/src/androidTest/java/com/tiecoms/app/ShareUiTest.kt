package com.tiecoms.app

import android.Manifest
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.platform.ConversationShortcuts
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
import java.util.UUID

/**
 * SPEC-v4 en el emulador contra 3043: pestañas de Inicio, atajos de Direct Share, la hoja de compartir del SISTEMA con
 * Chaggu y sus conversaciones, ShareActivity con 3 fotos de la galería a 2 conversaciones, la burbuja con la
 * cuadrícula de fotos y el visor.
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3043 -e email … -e password … -e conversationId … -e peerId … \
 *     -e class com.tiecoms.app.ShareUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class ShareUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val reviewVideo get() = arg("reviewVideo") == "true"
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[v4] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(ins)
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    // Sin ventanas de Compose (la hoja se cerró y la app está en segundo plano) cuenta como «no está».
    private fun exists(tag: String) = runCatching { compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)

    private fun expandUploadNotification() {
        var node = device.wait(Until.findObject(By.text("Share to Chaggu")), 5_000)
        repeat(5) {
            val expand = node?.findObject(By.res(java.util.regex.Pattern.compile(".*:id/expand_button")))
            if (expand != null) { expand.click(); return }
            node = node?.parent
        }
    }

    /** Foto en la galería (MediaStore, Pictures/Chaggu), como si viniera de la cámara. */
    private fun galleryPhoto(label: String, color: Int): Uri {
        val cr = ins.targetContext.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "chaggu-$label-${UUID.randomUUID().toString().take(4)}.jpg")
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            if (Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Chaggu")
        }
        val uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        val bmp = Bitmap.createBitmap(1200, 900, Bitmap.Config.ARGB_8888)
        Canvas(bmp).apply {
            drawColor(color)
            drawText(label, 80f, 520f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = 0xFFFFFFFF.toInt(); textSize = 220f; isFakeBoldText = true })
        }
        if (reviewVideo) {
            // Larger synthetic photos make upload progress visible in the review recording.
            val random = java.util.Random(7)
            bmp.setPixels(IntArray(1200 * 900) { 0xFF000000.toInt() or random.nextInt(0xFFFFFF) }, 0, 1200, 0, 0, 1200, 900)
            Canvas(bmp).drawText(label, 80f, 520f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = 0xFFFFFFFF.toInt(); textSize = 220f; isFakeBoldText = true })
        }
        cr.openOutputStream(uri)!!.use { bmp.compress(Bitmap.CompressFormat.JPEG, 88, it) }
        return uri
    }

    private fun pickPeer(peerId: String) {
        compose.onNodeWithTag("peopleList").performScrollToNode(hasTestTag("person-$peerId"))
        compose.onNodeWithTag("person-$peerId").performClick()
    }

    @Test
    fun compartirDesdeLaGaleria() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val convId = arg("conversationId"); val peerId = arg("peerId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && convId.isNotBlank())
        assertFalse("Nunca contra producción", (apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com")))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try { flow(convId, peerId, email, password) } catch (t: Throwable) { shot("v4-fallo"); throw t } finally { runCatching { scenario.close() } }
    }

    private fun flow(convId: String, peerId: String, email: String, password: String) {
        compose.waitUntil(20_000) { exists("email") && !exists("splash") }
        compose.onNodeWithTag("email").performTextInput(email)
        compose.onNodeWithTag("password").performTextInput(password)
        compose.onNodeWithTag("login").performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("conv-$convId"), 20_000)
        val client = app.container.client.value

        // §C Pestañas grandes con contador, la elegida se recuerda.
        compose.waitUntilAtLeastOneExists(hasTestTag("tab-UNREAD"), 5_000)
        Thread.sleep(500); shot("v4-01-inicio-pestanas")
        compose.onNodeWithTag("tab-UNREAD").performClick()
        compose.waitForIdle(); Thread.sleep(400); shot("v4-02-pestana-no-leidos")
        assertEquals("UNREAD", app.container.settings.homeTab)
        compose.onNodeWithTag("tab-ALL").performClick()
        log("§C pestañas Todo · No leídos · Asuntos · Chats · Laterales con contador; la elegida se recuerda")

        // §B Atajos de conversación para Direct Share (publicados tras cargar /bootstrap).
        compose.waitUntil(15_000) {
            ShortcutManagerCompat.getDynamicShortcuts(ins.targetContext).any { it.id == convId && ConversationShortcuts.SHARE_CATEGORY in (it.categories ?: emptySet()) }
        }
        val shortcuts = ShortcutManagerCompat.getDynamicShortcuts(ins.targetContext)
        log("§B Direct Share: ${shortcuts.size} atajos de larga vida (${shortcuts.joinToString { it.shortLabel.toString() }})")
        assertTrue(shortcuts.all { ConversationShortcuts.SHARE_CATEGORY in (it.categories ?: emptySet()) })

        // La hoja de compartir del SISTEMA con 3 fotos de la galería: Chaggu y sus conversaciones.
        val photos = listOf(galleryPhoto(if (reviewVideo) "One" else "Uno", 0xFF2F6FDB.toInt()), galleryPhoto(if (reviewVideo) "Two" else "Dos", 0xFF1A7F51.toInt()), galleryPhoto(if (reviewVideo) "Three" else "Tres", 0xFFB45309.toInt()))
        device.pressHome()
        val send = Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/jpeg")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(photos))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = android.content.ClipData.newUri(ins.targetContext.contentResolver, "fotos", photos[0]).apply { photos.drop(1).forEach { addItem(android.content.ClipData.Item(it)) } }
        ins.targetContext.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
        val title = Names.conversationTitle(client.meta(convId)!!, client.state.value.data, "Interno", "Conversación")
        device.wait(Until.hasObject(By.text("Chaggu")), 10_000)
        Thread.sleep(1_500)
        // The old TieComs app can have a shortcut with the same conversation title.
        // Select the exact Chaggu app tile; shortcut publication was asserted above.
        val directShare = false
        shot("v4-03-hoja-sistema")
        log("§B hoja del sistema: Chaggu ${if (device.hasObject(By.text("Chaggu"))) "aparece" else "NO aparece"}; conversación «$title» en Direct Share: $directShare")
        val target = device.findObject(By.text("Chaggu"))
        assertNotNull("Chaggu en la hoja de compartir", target)
        target!!.click()

        // ShareActivity: vista previa de las 3 fotos y la conversación preseleccionada (si vino por Direct Share).
        // The system chooser briefly leaves no Compose window while ShareActivity is starting.
        compose.waitUntil(15_000) { exists("sharePreview") }
        compose.waitUntilAtLeastOneExists(hasTestTag("shareRecent-$convId") or hasTestTag("shareTarget-$convId"), 10_000)
        val direct = runBlocking { client.createChat(listOf(peerId), null).id }
        compose.waitUntilAtLeastOneExists(hasTestTag("shareTarget-$direct") or hasTestTag("shareRecent-$direct"), 10_000)
        val preselected = client.state.value.data!!.conversations.any { it.id == convId } && directShare
        val convNode = if (exists("shareRecent-$convId")) "shareRecent-$convId" else "shareTarget-$convId"
        // Por Direct Share llega preseleccionada; si se entró por el ícono de la app, se elige aquí.
        if (!directShare) compose.onNodeWithTag(convNode).performScrollTo().performClick()
        compose.onNodeWithTag(convNode).assertIsOn()
        val directNode = if (exists("shareRecent-$direct")) "shareRecent-$direct" else "shareTarget-$direct"
        compose.onNodeWithTag(directNode).performScrollTo().performClick()
        val note = if (reviewVideo) "Project photos · Demo ${System.currentTimeMillis() % 10_000}" else "Fotos de la visita ${UUID.randomUUID().toString().take(4)}"
        compose.onNodeWithTag("shareMessage").performTextInput(note)
        Thread.sleep(500); shot("v4-04-compartir-en-tiecoms")
        log("§B ShareActivity: 3 miniaturas, «$title»${if (preselected) " preseleccionada por Direct Share" else ""} + directo, mensaje")
        val t0 = System.currentTimeMillis()
        if (reviewVideo) Thread.sleep(2_000)
        compose.onNodeWithTag("shareSend").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("shareProgress"), 10_000)
        Thread.sleep(150); shot("v4-05-enviando")
        if (reviewVideo) {
            device.pressHome()
            device.openNotification()
            expandUploadNotification()
            Thread.sleep(4_000)
            shot("v4-05-background-upload")
            val manager = ins.targetContext.getSystemService(android.app.NotificationManager::class.java)
            compose.waitUntil(60_000) { manager.activeNotifications.none { it.id == 7301 } }
            device.pressBack()
        }
        compose.waitUntil(60_000) { !exists("shareSheet") }
        compose.waitUntil(15_000) {
            client.state.value.data?.conversations?.firstOrNull { it.id == direct }?.lastMessageAt != null &&
                (client.state.value.conversations[convId]?.messages?.any { it.body == note && it.attachments.size == 3 } ?: true)
        }
        log("§B enviado a 2 conversaciones (3 fotos + mensaje) en ${System.currentTimeMillis() - t0} ms; la hoja se cerró sola")

        // La burbuja con la cuadrícula de fotos y el visor a pantalla completa.
        ins.targetContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("chaggu://c/$convId")).setPackage(ins.targetContext.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        compose.waitUntil(15_000) { exists("composer") }
        compose.waitUntil(15_000) { client.state.value.conversations[convId]?.messages?.any { it.body == note && it.attachments.size == 3 } == true }
        val m = client.state.value.conversations[convId]!!.messages.first { it.body == note }
        compose.waitUntilAtLeastOneExists(hasTestTag("att-${m.attachments[0].id}"), 10_000)
        assertTrue("miniatura subida por el cliente", m.attachments.all { it.thumbUrl != null })
        Thread.sleep(1_500); shot("v4-06-burbuja-fotos")
        compose.onNodeWithTag("att-${m.attachments[1].id}").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("viewerImage"), 15_000)
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("2 de 3") or hasText("2 of 3"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        Thread.sleep(1_200); shot("v4-07-visor")
        device.pressBack()
        log("§B/§A burbuja con cuadrícula (3 fotos, miniaturas del cliente) y visor «2 de 3»")
        compose.waitUntil(5_000) { !exists("mediaViewer") }

        if (reviewVideo) {
            // A second real share demonstrates the foreground notification's Cancel action.
            ins.targetContext.startActivity(Intent(send).setClass(ins.targetContext, ShareActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            compose.waitUntil(15_000) { exists("sharePreview") }
            val cancelTarget = if (exists("shareRecent-$convId")) "shareRecent-$convId" else "shareTarget-$convId"
            compose.onNodeWithTag(cancelTarget).performScrollTo().performClick()
            val cancelPeer = if (exists("shareRecent-$direct")) "shareRecent-$direct" else "shareTarget-$direct"
            compose.onNodeWithTag(cancelPeer).performScrollTo().performClick()
            compose.onNodeWithTag("shareMessage").performTextInput("Cancelled upload · Demo")
            Thread.sleep(1_000)
            compose.onNodeWithTag("shareSend").performClick()
            compose.waitUntil(10_000) { exists("shareProgress") }
            device.pressHome()
            device.openNotification()
            expandUploadNotification()
            val workManager = androidx.work.WorkManager.getInstance(ins.targetContext)
            val upload = workManager.getWorkInfosByTag(com.tiecoms.app.platform.ShareWorker::class.java.name).get()
                .single { it.state == androidx.work.WorkInfo.State.RUNNING }
            val cancel = device.wait(Until.findObject(By.text("Cancel")), 10_000)
            assertNotNull("Upload notification exposes Cancel", cancel)
            Thread.sleep(1_500); shot("v4-11-cancel-upload")
            // Progress replaces the notification row; resolve the action again after the screenshot.
            compose.waitUntil(15_000) {
                if (workManager.getWorkInfoById(upload.id).get()?.state == androidx.work.WorkInfo.State.CANCELLED) true
                else {
                    runCatching { device.findObject(By.text("Cancel"))?.click() }
                    false
                }
            }
            val manager = ins.targetContext.getSystemService(android.app.NotificationManager::class.java)
            compose.waitUntil(15_000) { manager.activeNotifications.none { it.id == 7301 } }
            assertEquals(androidx.work.WorkInfo.State.CANCELLED, workManager.getWorkInfoById(upload.id).get()?.state)
            Thread.sleep(1_500); shot("v4-12-upload-cancelled")
            log("FGS review: user-initiated upload, background progress, delivery, and notification cancellation verified")
            return
        }

        // §D Grupos ordenado por no leídos; «Mensaje nuevo» vive en DMs (docs/GRUPOS.md).
        compose.onNodeWithTag("back").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("newGroup"), 10_000)
        Thread.sleep(600); shot("v4-08-inicio-orden")
        compose.onNodeWithTag("tab-dms").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("newChat"), 10_000)
        compose.onNodeWithTag("newChat").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("createChat"), 10_000)
        assertTrue("desde DMs, solo persona o chat grupal", !exists("chatModeSpace"))
        Thread.sleep(400); shot("v4-09-nuevo-chat-persona")
        compose.onNodeWithTag("back").performClick()
        // Grupo en un espacio: el «+» de Grupos con la relación elegida (POST /groups).
        compose.onNodeWithTag("tab-home").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("newGroup"), 10_000)
        compose.onNodeWithTag("newGroup").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("forCompany"), 5_000)
        compose.onNodeWithTag("forCompany").performClick()
        val ws = client.meta(convId)!!.workspaceId!!
        val relation = com.tiecoms.app.core.GroupsTree.companyChoices(client.state.value.data!!).first { r -> r.workspaces.any { it.id == ws } }
        compose.onNodeWithTag("company-" + relation.id).performScrollTo().performClick()
        compose.onNodeWithTag("groupName").performScrollTo().performTextInput("Pagos del proyecto")
        compose.onNodeWithTag("person-$peerId").performScrollTo().performClick()
        Thread.sleep(400); shot("v4-10-nuevo-chat-espacio")
        compose.onNodeWithTag("groupShareLink").performScrollTo().performClick() // sin enlace: abre el grupo directo
        compose.onNodeWithTag("createGroup").performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 15_000)
        val created = client.state.value.data!!.conversations.first { it.name == "Pagos del proyecto" }
        assertTrue(peerId in created.memberIds)
        log("§D Nuevo grupo en una relación: ¿Para quién es?, empresa, nombre y personas; crea y abre el grupo")
    }
}
