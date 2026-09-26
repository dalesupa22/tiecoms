package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.ForwardedInfo
import com.tiecoms.app.core.MemorySecretStore
import com.tiecoms.app.core.MemoryStorage
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.TieComsClient
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
 * Regresión «reaccioné a una imagen y se crasheó» (1.6.2) contra el API de pruebas: mensajes con foto sin texto,
 * foto con texto, varias fotos, video, archivo, reenviada; míos y recibidos; en el grupo y en un directo.
 * Para cada uno: mantener la foto (y la burbuja) → barra rápida → poner, cambiar y quitar; selector completo; y una
 * reacción en vivo de la otra persona (message.updated). La otra persona es un segundo cliente en el mismo proceso.
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3050 -e email <a> -e peerEmail <b> -e password … -e conversationId … \
 *     -e class com.tiecoms.app.ReaccionImagenUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class ReaccionImagenUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val perms: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[reaccion-imagen] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(500)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "reaccion-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private val client get() = app.container.client.value

    private fun png(name: String, color: Int, w: Int = 800, h: Int = 600): File {
        val f = File(ins.targetContext.cacheDir, name)
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        Canvas(b).drawColor(color)
        f.outputStream().use { b.compress(Bitmap.CompressFormat.JPEG, 80, it) }
        return f
    }
    private fun txt(name: String) = File(ins.targetContext.cacheDir, name).apply { writeText("informe de prueba\n".repeat(50)) }

    /** Envía con [c] y espera a que el mensaje confirmado llegue a mi cliente. */
    private fun post(c: TieComsClient, conv: String, body: String, files: List<Pair<File, String>>, fwd: ForwardedInfo? = null): MessageDTO = runBlocking {
        val atts: List<AttachmentDTO> = files.map { (f, t) -> c.uploadAttachment(conv, f, f.name, t) }
        val before = client.state.value.conversations[conv]?.messages?.maxOfOrNull { it.seq } ?: 0
        c.send(conv, body, forwarded = fwd, attachments = atts)
        kotlinx.coroutines.withTimeout(30_000) {
            client.state.first { s -> s.conversations[conv]?.messages?.any { it.seq > before && it.attachments.map { a -> a.id }.containsAll(atts.map { a -> a.id }) } == true }
        }
        client.state.value.conversations[conv]!!.messages.last { it.attachments.map { a -> a.id }.containsAll(atts.map { a -> a.id }) }
    }

    private fun live(conv: String, id: String) = client.state.value.conversations[conv]?.messages?.firstOrNull { it.id == id }

    /** Mantener [target] → barra rápida → 👍, cambiar a ❤️ (quitar 👍), quitar ❤️, 🎉 por el selector, 😂 en vivo del otro. */
    private fun exercise(conv: String, m: MessageDTO, target: String, peer: TieComsClient, label: String) {
        val me = client.myId!!
        compose.waitUntil(15_000) { exists(target) }
        compose.onNodeWithTag(target, useUnmergedTree = true).performScrollTo()
        // -e target bubble: mantener el borde inferior de la burbuja (la hora) en vez de la foto, como en 1.6.1.
        val bubble = arg("target") == "bubble"
        fun open() {
            if (bubble) compose.onNodeWithTag("msg-${m.seq}", useUnmergedTree = true).performTouchInput { longClick(androidx.compose.ui.geometry.Offset(width - 40f, height - 12f)) }
            else compose.onNodeWithTag(target, useUnmergedTree = true).performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("quickReactions"), 5_000)
        }
        open(); compose.onNodeWithTag("quick-👍").performClick()
        compose.waitUntil(15_000) { live(conv, m.id)?.reactions?.any { it.emoji == "👍" && me in it.userIds } == true }
        open(); compose.onNodeWithTag("quick-❤️").performClick()
        open(); compose.onNodeWithTag("quick-👍").performClick() // quitar el 👍 (cambiar a ❤️)
        compose.waitUntil(15_000) { live(conv, m.id)?.reactions?.let { r -> r.any { it.emoji == "❤️" && me in it.userIds } && r.none { it.emoji == "👍" && me in it.userIds } } == true }
        compose.onNodeWithTag("reaction-${m.seq}-❤️", useUnmergedTree = true).performClick() // quitar desde el chip
        compose.waitUntil(15_000) { live(conv, m.id)?.reactions?.none { me in it.userIds } == true }
        open(); compose.onNodeWithTag("quickMore").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("emojiPicker"), 5_000)
        compose.onNodeWithTag("pick-🎉").performScrollTo().performClick()
        compose.waitUntil(15_000) { live(conv, m.id)?.reactions?.any { it.emoji == "🎉" } == true }
        // En vivo: la otra persona reacciona (message.updated).
        runBlocking { peer.openConversation(conv); peer.react(peer.state.value.conversations[conv]!!.messages.first { it.id == m.id }, "😂", true) }
        compose.waitUntil(15_000) { exists("reaction-${m.seq}-😂") }
        compose.onNodeWithTag("reaction-${m.seq}-😂", useUnmergedTree = true).performTouchInput { longClick() }
        compose.waitUntil(5_000) { exists("reactors") }
        shot(label)
        ins.uiAutomation.executeShellCommand("input keyevent 4").close(); Thread.sleep(400)
        log("$label: poner, cambiar, quitar, selector y en vivo sin fallar")
    }

    @Test
    fun reaccionarAImagenesYAdjuntos() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val peerEmail = arg("peerEmail"); val password = arg("password"); val group = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", listOf(apiUrl, email, peerEmail, password, group).all { it.isNotBlank() })
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { client.state.first { it.status != SessionStatus.LOADING } }
            if (client.state.value.status != SessionStatus.ANONYMOUS) client.logout()
        }
        val peer = TieComsClient(apiUrl, "Peer", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("newGroup"), 20_000)
            runBlocking { peer.login(peerEmail, password) }
            val peerId = peer.myId!!
            val direct = runBlocking { client.createChat(listOf(peerId), null).id }
            runBlocking { client.loadBootstrap(); peer.loadBootstrap() }

            compose.onNodeWithTag("conv-$group").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
            runBlocking { client.openConversation(group) }
            // Uno por uno: el mensaje nuevo queda abajo, a la vista.
            val cases: List<Pair<String, () -> MessageDTO>> = listOf(
                "recibida-sin-texto" to { post(peer, group, "", listOf(png("a.jpg", Color.RED) to "image/jpeg")) },
                "recibida-con-texto" to { post(peer, group, "Mira la obra", listOf(png("b.jpg", Color.BLUE) to "image/jpeg")) },
                "varias" to { post(peer, group, "", listOf(png("c1.jpg", Color.GREEN) to "image/jpeg", png("c2.jpg", Color.GRAY) to "image/jpeg", png("c3.jpg", Color.CYAN) to "image/jpeg")) },
                "archivo" to { post(peer, group, "", listOf(txt("informe.txt") to "text/plain")) },
                "mia-sin-texto" to { post(client, group, "", listOf(png("d.jpg", Color.MAGENTA, 600, 900) to "image/jpeg")) },
                "reenviada" to { post(peer, group, "", listOf(png("e.jpg", Color.YELLOW) to "image/jpeg"), ForwardedInfo(source = "whatsapp", author = "Pedro")) },
            )
            for ((label, make) in cases) {
                val m = make()
                val a = m.attachments.first()
                val target = if (a.isImage) "att-${a.id}" else "attFile-${a.id}"
                exercise(group, m, target, peer, "grupo-$label")
            }
            // Directo: foto sin texto recibida.
            compose.onNodeWithTag("back").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("tab-dms"), 10_000)
            compose.onNodeWithTag("tab-dms").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("conv-$direct"), 15_000)
            compose.onNodeWithTag("conv-$direct").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
            runBlocking { client.openConversation(direct) }
            val dm = post(peer, direct, "", listOf(png("f.jpg", Color.DKGRAY) to "image/jpeg"))
            exercise(direct, dm, "att-${dm.attachments.first().id}", peer, "directo-sin-texto")
            assertTrue(scenario.state.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED))
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { peer.close() }; runCatching { scenario.close() } }
    }
}
