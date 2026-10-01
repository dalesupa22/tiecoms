package com.tiecoms.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiecoms.app.core.*
import com.tiecoms.app.platform.MemeRenderer
import com.tiecoms.app.ui.*
import com.tiecoms.app.ui.theme.TieComsTheme
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** Synthetic local server only. No real users or production messages are involved. */
@RunWith(AndroidJUnit4::class)
class CreativeMediaUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private lateinit var client: TieComsClient
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, ByteArray>>()
    private val gif = android.util.Base64.decode("R0lGODlhKAAoAIEAAOstHgAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAKAAAACwAAAAAKAAoAAAIQwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzgJBgQAIfkEASgAAQAsAAAAACgAKACBHjzrAAAAAAAAAAAACEMAAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybKly5cwY8qcSbOmzZs4CQYEADs=", android.util.Base64.DEFAULT)
    private val item = CreativeMediaDTO("g1", "openverse", "Local animation", "/api/v1/gifs/media?t=preview", "/api/v1/gifs/media?t=original", 40, 40, "QA fixture · CC0", "https://commons.wikimedia.org/wiki/File:Fixture.gif")
    private fun png(): ByteArray {
        val bmp = Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(40, 170, 110)) }
        val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bmp.recycle(); return bytes
    }
    private fun open(kind: String = "group") {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val bytes = request.body.readByteArray(); requests += request to bytes
                val path = request.requestUrl!!.encodedPath
                if (path == "/api/v1/gifs/media") return MockResponse().setHeader("content-type", if (request.requestUrl!!.queryParameter("t") == "meme") "image/png" else "image/gif")
                    .setBody(Buffer().write(if (request.requestUrl!!.queryParameter("t") == "meme") png() else gif))
                if (path == "/api/v1/attachments/visible/content") return MockResponse().setHeader("content-type", "image/gif").setBody(Buffer().write(gif))
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA"},"people":[{"id":"me","name":"QA"},{"id":"other","name":"Ana"}],"conversations":[{"id":"creative-qa","kind":"$kind","name":"Local creative QA","memberIds":["me","other"],"lastMessageSeq":2,"lastReadSeq":2,"canPost":true}]}"""
                    path == "/api/v1/conversations/creative-qa/messages" && request.method == "GET" -> TcJson.encodeToString(MessagesPage.serializer(), MessagesPage(listOf(
                        MessageDTO(id = "m1", conversationId = "creative-qa", seq = 1, authorId = "other", body = "Local animation", createdAt = "2026-09-30T10:00:00Z", attachments = listOf(AttachmentDTO("visible", "fixture.gif", "image/gif", gif.size.toLong(), 40, 40, "/api/v1/attachments/visible/content"))),
                        MessageDTO(id = "m2", conversationId = "creative-qa", seq = 2, authorId = "other", body = "", createdAt = "2026-09-30T10:01:00Z", viewOnce = true, viewOnceState = "unopened", attachments = listOf(AttachmentDTO("hidden", "hidden.gif", "image/gif", gif.size.toLong(), 40, 40, "/api/v1/attachments/hidden/content")))
                    ), false, 0))
                    path == "/api/v1/gifs/trending" || path == "/api/v1/gifs/search" -> TcJson.encodeToString(CreativeMediaPage.serializer(), CreativeMediaPage("openverse", listOf(item), poweredBy = CreativeProviderDTO("Openverse / Wikimedia Commons", "https://openverse.org")))
                    path == "/api/v1/memes/templates" -> TcJson.encodeToString(CreativeMediaPage.serializer(), CreativeMediaPage("memegen", listOf(item.copy(id = "template", provider = "memegen", title = "Local meme template", previewUrl = "/api/v1/gifs/media?t=meme", url = "/api/v1/gifs/media?t=meme", attribution = "QA template · CC0", boxCount = 2))))
                    path == "/api/v1/conversations/creative-qa/gifs" -> return MockResponse().setHeadersDelay(1000, java.util.concurrent.TimeUnit.MILLISECONDS).setBody(TcJson.encodeToString(GifAttachmentResult.serializer(), GifAttachmentResult(AttachmentDTO("imported", "fixture.gif", "image/gif", gif.size.toLong(), 40, 40, "/api/v1/attachments/visible/content"), "Signed fixture · CC0")))
                    path == "/api/v1/conversations/creative-qa/attachments" -> TcJson.encodeToString(AttachmentDTO.serializer(), AttachmentDTO("uploaded", "meme.jpg", "image/jpeg", bytes.size.toLong(), 400, 300, "/api/v1/attachments/meme/content"))
                    path == "/api/v1/conversations/creative-qa/messages" && request.method == "POST" -> """{"message":{"id":"sent","conversationId":"creative-qa","seq":3,"authorId":"me","body":"local sent"}}"""
                    path == "/api/v1/messages/m2/open" -> TcJson.encodeToString(ViewOnceOpenDTO.serializer(), ViewOnceOpenDTO(attachments = listOf(AttachmentDTO("once", "once.gif", "image/gif", gif.size.toLong(), 40, 40, "/api/v1/gifs/media?t=once"))))
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
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Creative local UI", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        runBlocking { client.login("qa@example.test", "synthetic") }
        compose.setContent { CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
            TieComsTheme { ConversationScreen("creative-qa", onBack = {}, onDetails = {}, onOpenConversation = { _, _ -> }, onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}) }
        } }
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("msg-1").fetchSemanticsNodes().isNotEmpty() }
    }
    private fun messagePosts() = requests.count { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/messages") }
    private fun shot(name: String) {
        val dir = compose.activity.getExternalFilesDir(null)!!
        compose.onNodeWithTag("creativePicker").captureToImage().asAndroidBitmap().let { bmp -> File(dir, "creative-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) } }
    }
    @After fun close() { if (::client.isInitialized) client.close(); server.shutdown() }

    @Test fun gifAnimatesAndStagesWithoutSending() {
        open()
        compose.waitUntil(10_000) { requests.any { it.first.requestUrl!!.encodedPath == "/api/v1/attachments/visible/content" } }
        val colors = mutableSetOf<String>()
        repeat(12) {
            Thread.sleep(120)
            val bitmap = compose.onNodeWithTag("att-visible").captureToImage().toPixelMap()
            val color = bitmap[bitmap.width / 2, bitmap.height / 2]
            if (color.red > .65f) colors += "red"
            if (color.blue > .65f) colors += "blue"
        }
        assertEquals("GIF frames really change", setOf("red", "blue"), colors)
        assertFalse("A closed one-view message must not fetch its content", requests.any { it.first.requestUrl!!.encodedPath.contains("/hidden/") })
        compose.onNodeWithTag("composer").performTextInput("draft retained")
        compose.onNodeWithTag("creativeButton").performClick()
        compose.onNodeWithTag("creativePicker").assertExists()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("creative-g1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("creative-g1").performClick()
        compose.onNodeWithTag("gifPreview").assertIsDisplayed()
        shot("gif-preview")
        compose.onNodeWithTag("creativeAdd").performClick()
        compose.onNodeWithTag("pendingGif").assertIsDisplayed()
        compose.onNodeWithTag("composer").assertTextContains("draft retained")
        assertEquals(0, messagePosts())
        assertFalse(requests.any { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/gifs") })
        compose.onNodeWithTag("viewOnce").performClick()
        compose.onNodeWithTag("send").performTouchInput { click(); click() }
        compose.waitUntil(10_000) { messagePosts() == 1 }
        assertEquals("Two taps import a GIF only once", 1, requests.count { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/gifs") })
        val body = requests.last { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/messages") }.second.toString(Charsets.UTF_8)
        assertTrue(body.contains("draft retained")); assertTrue(body.contains("Signed fixture")); assertTrue(body.contains("\"viewOnce\":true"))
    }

    @Test fun memeCaptionStaysLocalUntilExplicitSend() {
        open()
        compose.onNodeWithTag("creativeButton").performClick()
        compose.onNodeWithTag("memeTab").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("creative-template").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("creative-template").performClick()
        compose.onNodeWithTag("memeTop").performTextInput("PRIVATE TOP")
        compose.onNodeWithTag("memeBottom").performTextInput("PRIVATE BOTTOM")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("memePreview").fetchSemanticsNodes().isNotEmpty() && runCatching { compose.onNodeWithTag("creativeAdd").assertIsEnabled() }.isSuccess }
        androidx.test.uiautomator.UiDevice.getInstance(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()).pressBack()
        shot("meme-editor")
        assertTrue(requests.none { it.second.toString(Charsets.UTF_8).contains("PRIVATE") || it.first.path!!.contains("PRIVATE") })
        compose.onNodeWithTag("creativeAdd").performClick()
        assertEquals(0, messagePosts())
        assertFalse(requests.any { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/attachments") })
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(10_000) { messagePosts() == 1 }
        val bytes = requests.single { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/attachments") }.second
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertNotNull(decoded)
        var captionPixels = 0
        for (y in 0 until decoded.height / 3) for (x in 0 until decoded.width) {
            val red = Color.red(decoded.getPixel(x, y))
            if (red > 200 || red < 20) captionPixels++
        }
        assertTrue("Rendered caption introduces bright/dark pixels at the top", captionPixels > 100)
        decoded.recycle()
    }

    @Test fun grantedOneViewGifUsesNoStoreAndClosedBubbleNeverPrefetches() {
        open()
        assertFalse(requests.any { it.first.requestUrl!!.encodedPath.contains("/hidden/") })
        compose.onNodeWithTag("viewOnceBubble-2").performClick()
        compose.waitUntil(10_000) { requests.any { it.first.requestUrl!!.queryParameter("t") == "once" } }
        val fetched = requests.last { it.first.requestUrl!!.queryParameter("t") == "once" }.first
        assertEquals("no-store", fetched.getHeader("cache-control"))
        compose.onNodeWithTag("viewOnceViewer").assertIsDisplayed()
        compose.onNodeWithTag("viewOnceClose").performClick()
        compose.onNodeWithTag("viewOnceViewer").assertDoesNotExist()
    }

    @Test fun logoutDuringGifImportNeverSendsIntoAnotherSession() {
        open()
        compose.onNodeWithTag("creativeButton").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("creative-g1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("creative-g1").performClick()
        compose.onNodeWithTag("creativeAdd").performClick()
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(10_000) { requests.any { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/gifs") } }
        runBlocking { client.logout() }
        Thread.sleep(700)
        assertEquals("The old session's GIF must not be sent after logout", 0, messagePosts())
        assertTrue(client.state.value.pending.isEmpty())
    }

    @Test fun canvasRendererLeavesTemplateUntouched() = runBlocking {
        val original = png(); val copy = original.copyOf()
        val plain = MemeRenderer.render(compose.activity, original, "", "")
        val captioned = MemeRenderer.render(compose.activity, original, "LOCAL TOP", "LOCAL BOTTOM")
        assertArrayEquals(copy, original)
        assertEquals("image/jpeg", captioned.contentType)
        val before = BitmapFactory.decodeFile(plain.path); val after = BitmapFactory.decodeFile(captioned.path)
        var changed = 0
        for (y in 0 until before.height) for (x in 0 until before.width) if (before.getPixel(x, y) != after.getPixel(x, y)) changed++
        assertTrue(changed > 1000)
        before.recycle(); after.recycle(); File(plain.path).delete(); File(captioned.path).delete(); Unit
    }
}
