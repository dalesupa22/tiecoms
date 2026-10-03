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
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * Caso de iOS (1.7.15): un «meme» enviado desde la web (JPEG 800×739 con miniatura + texto con dos enlaces y vista
 * previa) debe verse en Android al cargar el historial y al llegar en tiempo real, con la imagen de la vista previa.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class MemeUiTest {
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
        File(ins.targetContext.getExternalFilesDir(null), "meme-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** Lo que hace la web: sube la imagen, su miniatura y envía el texto con dos enlaces (como otra persona). */
    private fun sendMemeAs(api: String, email: String, password: String, conv: String, text: String): String {
        fun call(method: String, path: String, token: String?, body: ByteArray?, type: String, headers: Map<String, String> = emptyMap()): JSONObject {
            val c = URL("$api/api/v1$path").openConnection() as HttpURLConnection
            c.requestMethod = method; c.doInput = true
            token?.let { c.setRequestProperty("authorization", "Bearer $it") }
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            if (body != null) { c.doOutput = true; c.setRequestProperty("content-type", type); c.outputStream.use { it.write(body) } }
            val text = (if (c.responseCode < 400) c.inputStream else c.errorStream).bufferedReader().readText()
            return runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        }
        val login = call("POST", "/auth/login", null, JSONObject().put("email", email).put("password", password)
            .put("device", JSONObject().put("deviceId", UUID.randomUUID().toString()).put("name", "web").put("platform", "web")).toString().toByteArray(), "application/json")
        val tok = login.getString("accessToken")
        val img = ins.context.assets.open("qa-meme.jpg").readBytes()
        val att = call("POST", "/conversations/$conv/attachments", tok, img, "application/octet-stream", mapOf("x-file-name" to "meme.jpg", "x-file-type" to "image/jpeg")).getString("id")
        call("POST", "/attachments/$att/thumb", tok, ins.context.assets.open("qa-meme-thumb.jpg").readBytes(), "application/octet-stream")
        call("POST", "/conversations/$conv/messages", tok, JSONObject().put("clientMessageId", UUID.randomUUID().toString())
            .put("body", "$text https://www.wikipedia.org y https://github.com").put("attachmentIds", org.json.JSONArray().put(att)).toString().toByteArray(), "application/json")
        return att
    }

    @Test fun memeEnHistorialYEnVivo() {
        val apiUrl = arg("apiUrl"); val general = arg("general"); val oldAtt = arg("memeAtt")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && general.isNotBlank() && oldAtt.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
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

            // 1) Historial: el meme ya estaba en el chat.
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(general) }
            compose.waitUntilAtLeastOneExists(hasTestTag("messages"), 20_000)
            Thread.sleep(1500)
            compose.onNodeWithTag("messages", useUnmergedTree = true).performScrollToNode(hasTestTag("att-$oldAtt"))
            compose.waitUntil(15_000) { exists("attImg-$oldAtt") }
            compose.waitUntil(15_000) { exists("linkPreviewImage") }
            shot("01-historial")

            // 2) En vivo: otra persona lo manda con el chat abierto.
            val newAtt = sendMemeAs(apiUrl, arg("peerEmail"), arg("password"), general, "meme en vivo")
            val client = app.container.client.value
            compose.waitUntil(20_000) { client.state.value.conversations[general]?.messages?.any { m -> m.attachments.any { it.id == newAtt } } == true }
            if (exists("jumpLatest")) compose.onNodeWithTag("jumpLatest").performClick()
            Thread.sleep(800)
            compose.onNodeWithTag("messages", useUnmergedTree = true).performScrollToNode(hasTestTag("att-$newAtt"))
            compose.waitUntil(15_000) { exists("attImg-$newAtt") }
            // La vista previa llega después (message.updated): debe aparecer con su imagen.
            compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("linkPreviewImage"), useUnmergedTree = true).fetchSemanticsNodes().size >= 2 }
            shot("02-en-vivo")
        } catch (t: Throwable) { shot("zz-fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
