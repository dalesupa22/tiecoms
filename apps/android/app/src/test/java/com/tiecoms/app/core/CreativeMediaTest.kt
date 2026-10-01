package com.tiecoms.app.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class CreativeMediaTest {
    @Test fun `native scope language and safe proxy`() {
        listOf("group", "internal", "direct", "multi").forEach { assertTrue(CreativeMedia.available(it)) }
        listOf(null, "mail", "email", "whatsapp", "wa", "unknown").forEach { assertFalse(CreativeMedia.available(it)) }
        assertEquals("/gifs/search?q=caf%C3%A9%20%26%20fiesta&lang=es&cursor=a%2Fb%2B%3D", CreativeMedia.cataloguePath(" café & fiesta ", "es-CO", "a/b+="))
        assertEquals("/gifs/trending?lang=en", CreativeMedia.cataloguePath("", "fr"))
        assertTrue(CreativeMedia.isProxy("/api/v1/gifs/media?t=signed"))
        listOf("https://api.memegen.link/x", "//evil.test/x", "/api/v1/gifs/media?t=x#evil").forEach { assertFalse(CreativeMedia.isProxy(it)) }
    }

    @Test fun `source provenance and GIF one-view use image rules`() {
        val gif = AttachmentDTO(id = "a", contentType = "image/gif", url = "/api/v1/attachments/a")
        assertTrue(gif.isGif); assertTrue(ViewOnce.allowed(listOf(gif)))
        assertFalse(gif.copy(contentType = "video/mp4").isGif)
        val source = CreativeMediaDTO(attribution = "Author · CC BY 4.0", sourceUrl = "https://commons.wikimedia.org/wiki/File:Fixture.gif")
        val label = CreativeMedia.attribution(source)
        assertTrue(label.contains("CC BY 4.0")); assertTrue(label.contains("commons.wikimedia.org"))
        assertEquals("Draft @Ana\n\n$label", CreativeMedia.body("Draft @Ana", listOf(label, label, "")))
        val body = CreativeMedia.body("@Ana draft", listOf(label))
        assertEquals(listOf(MentionDTO("u2", 0, 4)), Refs.split(body, listOf(MentionDTO("u2", 0, 4))).second)
    }

    @Test fun `authenticated catalog import then explicit send preserves reply topic and once`() = runBlocking {
        val recorded = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
        val s = MockWebServer()
        val item = CreativeMediaDTO("g1", "openverse", "Fixture", "/api/v1/gifs/media?t=preview", "/api/v1/gifs/media?t=original", 64, 64,
            "Fixture author · CC0", "https://commons.wikimedia.org/wiki/File:Fixture.gif")
        val attachment = AttachmentDTO("gif1", "Fixture.gif", "image/gif", 100, 64, 64, "/api/v1/attachments/gif1/content")
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val body = r.body.readUtf8(); recorded += r to body
                return when (r.requestUrl!!.encodedPath) {
                    "$AUTH_BASE_PATH/login" -> MockResponse().setBody("""{"accessToken":"local-token","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local","user":{"id":"u1","name":"QA"}}""")
                    "/api/v1/bootstrap" -> MockResponse().setBody("""{"me":{"id":"u1","name":"QA"},"conversations":[{"id":"c1","kind":"direct","memberIds":["u1","u2"]},{"id":"external","kind":"whatsapp"}]}""")
                    "/api/v1/blocks" -> MockResponse().setBody("""{"userIds":[]}""")
                    "/api/v1/gifs/trending", "/api/v1/gifs/search", "/api/v1/memes/templates" -> MockResponse().setBody(TcJson.encodeToString(CreativeMediaPage.serializer(), CreativeMediaPage("openverse", listOf(item), "cursor", CreativeProviderDTO("Openverse / Wikimedia Commons", "https://openverse.org"))))
                    "/api/v1/conversations/c1/gifs" -> MockResponse().setBody(TcJson.encodeToString(GifAttachmentResult.serializer(), GifAttachmentResult(attachment, "Signed author · CC0")))
                    "/api/v1/conversations/c1/messages" -> if (r.method == "POST") MockResponse().setBody("""{"message":{"id":"sent","conversationId":"c1","seq":2,"authorId":"u1","body":"ok"}}""") else MockResponse().setBody("""{"messages":[],"hasMore":false}""")
                    else -> MockResponse().setResponseCode(404).setBody("{}")
                }
            }
        }
        s.start()
        val c = TieComsClient(s.url("/").toString().trimEnd('/'), "Creative fixture", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        try {
            c.login("qa@example.test", "fixture")
            assertEquals(item, c.creativeCatalogue(language = "es").items.single())
            c.creativeCatalogue("café", "en", "a/b")
            assertEquals(item, c.memeTemplates().items.single())
            val imported = c.importGif("c1", item)
            assertEquals("Signed author · CC0", imported.attribution)
            assertFalse(recorded.any { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/messages") })
            val import = recorded.single { it.first.requestUrl!!.encodedPath.endsWith("/gifs") }
            assertEquals("Bearer local-token", import.first.getHeader("authorization"))
            assertEquals(setOf("url"), TcJson.parseToJsonElement(import.second).jsonObject.keys)
            assertEquals(item.url, TcJson.parseToJsonElement(import.second).jsonObject["url"]!!.jsonPrimitive.content)
            assertEquals("café", recorded.last { it.first.requestUrl!!.encodedPath.endsWith("/search") }.first.requestUrl!!.queryParameter("q"))
            c.send("c1", CreativeMedia.body("draft", listOf(imported.attribution!!)), "reply-1", attachments = listOf(imported.attachment), topicId = "topic-1", viewOnce = true)
            withTimeout(5000) { while (recorded.none { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/messages") }) delay(10) }
            val sent = TcJson.parseToJsonElement(recorded.last { it.first.method == "POST" && it.first.requestUrl!!.encodedPath.endsWith("/messages") }.second).jsonObject
            assertEquals("reply-1", sent["replyTo"]!!.jsonPrimitive.content)
            assertEquals("topic-1", sent["topicId"]!!.jsonPrimitive.content)
            assertEquals("true", sent["viewOnce"]!!.toString())
            assertTrue(sent["body"]!!.jsonPrimitive.content.contains("Signed author"))
            assertTrue(runCatching { c.importGif("external", item) }.exceptionOrNull() is IllegalArgumentException)
            assertTrue(runCatching { c.importGif("c1", item.copy(url = "https://evil.test/g.gif")) }.exceptionOrNull() is IllegalArgumentException)
        } finally { c.close(); s.shutdown() }
    }
}
