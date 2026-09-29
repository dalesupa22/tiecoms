package com.tiecoms.app

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.view.inputmethod.EditorInfo
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.content.FileProvider
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import androidx.core.view.inputmethod.InputContentInfoCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.tiecoms.app.core.*
import com.tiecoms.app.ui.ConversationScreen
import com.tiecoms.app.ui.LocalClient
import com.tiecoms.app.ui.LocalContainer
import com.tiecoms.app.ui.theme.TieComsTheme
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.regex.Pattern

/**
 * 1.7.1: pegar una imagen del portapapeles en el compositor, por el menú «Pegar» del campo y por el teclado
 * (commitContent, como Gboard). Se adjunta igual que desde la galería y el texto escrito no cambia.
 * Servidor sintético dentro del emulador.
 */
@RunWith(AndroidJUnit4::class)
class PasteImageUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private lateinit var client: TieComsClient

    @After fun close() { if (::client.isInitialized) client.close(); server.shutdown() }

    private fun open() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA"},"people":[{"id":"me","name":"QA"},{"id":"other","name":"Ana Pega"}],"conversations":[{"id":"paste-qa","kind":"group","name":"Pegar","memberIds":["me","other"],"lastMessageSeq":1,"lastReadSeq":1,"unread":0,"canPost":true}]}"""
                    path == "/api/v1/conversations/paste-qa/messages" -> TcJson.encodeToString(MessagesPage.serializer(), MessagesPage(listOf(
                        MessageDTO(id = "p-1", conversationId = "paste-qa", seq = 1, authorId = "other", body = "Pega una captura", createdAt = "2026-09-28T10:00:00Z")), false, 0))
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path.endsWith("/pins") -> """{"messageIds":[]}"""
                    path.endsWith("/topics") -> """{"topics":[]}"""
                    path == "/api/v1/issues" -> """{"issues":[]}"""
                    path == "/api/v1/calendar/events" -> """{"events":[]}"""
                    path == "/api/v1/scheduled" -> """{"scheduled":[]}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Paste UI", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        runBlocking { client.login("paste@example.test", "synthetic") }
        compose.setContent {
            CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
                TieComsTheme { ConversationScreen("paste-qa", onBack = {}, onDetails = {}, onOpenConversation = { _, _ -> }, onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}) }
            }
        }
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("msg-1").fetchSemanticsNodes().isNotEmpty() }
    }

    /** PNG real de 64×64 en la caché, servido por el FileProvider de la app (como lo daría otra app). */
    private fun imageUri(name: String): android.net.Uri {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val f = java.io.File(ctx.cacheDir, "photos/$name").apply { parentFile!!.mkdirs() }
        val bmp = android.graphics.Bitmap.createBitmap(64, 64, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF1F7A74.toInt()) }
        f.outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        return FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
    }

    private fun pendingCount() = compose.onAllNodes(hasTestTag("attRemove-0") or hasTestTag("attRemove-1") or hasTestTag("attRemove-2")).fetchSemanticsNodes().size

    @Test fun pasteImageFromMenuAndFromKeyboard() {
        open()
        val ctx = compose.activity
        compose.onNodeWithTag("composer").performClick()
        compose.onNodeWithTag("composer").performTextInput("hola")
        // 1) Menú «Pegar» del campo con una imagen en el portapapeles.
        val uri = imageUri("paste-menu.png")
        compose.runOnUiThread {
            ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newUri(ctx.contentResolver, "captura", uri))
        }
        compose.onNodeWithTag("composer").performTouchInput { longClick(center) }
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val paste = device.wait(Until.findObject(By.text(Pattern.compile("Paste|Pegar"))), 5_000)
        assertNotNull("El menú del campo ofrece «Pegar» con una imagen en el portapapeles", paste)
        paste.click()
        compose.waitUntil(10_000) { pendingCount() == 1 }
        compose.onNodeWithTag("pendingFiles").assertIsDisplayed()
        assertTrue("El texto escrito no cambia", compose.onNodeWithTag("composer").fetchSemanticsNode().config.toString().contains("hola"))
        assertFalse("El marcador no queda en el texto", compose.onNodeWithTag("composer").fetchSemanticsNode().config.toString().contains(com.tiecoms.app.ui.PasteImages.MARKER))
        // 2) Teclado (Gboard): el campo anuncia imágenes y acepta commitContent.
        val kb = imageUri("paste-keyboard.png")
        var accepted = false
        var mimes = emptyArray<String>()
        compose.runOnUiThread {
            val view = ctx.window.decorView.findFocus()!!
            val info = EditorInfo()
            val ic = view.onCreateInputConnection(info)!!
            mimes = EditorInfoCompat.getContentMimeTypes(info)
            accepted = InputConnectionCompat.commitContent(ic, info, InputContentInfoCompat(kb, ClipDescription("sticker", arrayOf("image/png")), null), 0, null)
        }
        assertTrue("El EditorInfo anuncia image/png (${mimes.toList()})", "image/png" in mimes)
        assertTrue("commitContent aceptado", accepted)
        compose.waitUntil(10_000) { pendingCount() == 2 }
        // Un tipo que no es imagen se rechaza.
        compose.runOnUiThread {
            val view = ctx.window.decorView.findFocus()!!
            val info = EditorInfo()
            val ic = view.onCreateInputConnection(info)!!
            accepted = InputConnectionCompat.commitContent(ic, info, InputContentInfoCompat(kb, ClipDescription("doc", arrayOf("application/pdf")), null), 0, null)
        }
        assertFalse(accepted)
        val ins = InstrumentationRegistry.getInstrumentation()
        ins.uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(ins.targetContext.getExternalFilesDir(null), "paste-image.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
