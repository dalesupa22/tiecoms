package com.tiecoms.app.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Rutas, cuerpos y cabeceras de la v3: chats, miembros, perfil y foto, archivos y reenvío por la cola. */
class V3ApiContractTest {
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Triple<RecordedRequest, ByteArray, String>>()
    private lateinit var client: TieComsClient
    private var bootstraps = 0

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val bytes = request.body.readByteArray()
                requests += Triple(request, bytes, String(bytes))
                val path = request.path!!.substringBefore('?')
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    path == "/api/v1/bootstrap" -> {
                        bootstraps++
                        """{"me":{"id":"u1","name":"Ana","primaryOrgId":"o1","avatarUrl":"/api/v1/avatars/a1"},"organizations":[{"id":"o1","name":"Acme"}],
                            "people":[{"id":"u1","name":"Ana Ruiz","orgId":"o1"},{"id":"u2","name":"Mateo Gil","orgId":"o2"}],
                            "conversations":[{"id":"c1","kind":"group","memberIds":["u1","u2"]},{"id":"c2","kind":"multi","memberIds":["u1","u2"]}]}"""
                    }
                    path == "/api/v1/reminders" -> """{"reminders":[]}"""
                    path == "/api/v1/chats" -> """{"id":"new","kind":"multi"}"""
                    path.endsWith("/members") -> """{"added":["u3"]}"""
                    path == "/api/v1/me" -> """{"id":"u1","name":"Ana R","title":null}"""
                    path == "/api/v1/me/avatar" -> """{"id":"u1","name":"Ana","avatarUrl":"/api/v1/avatars/a2"}"""
                    path == "/api/v1/drive/tree" -> """{"workspaceId":null,"folders":[],"files":[],"canManageAll":true}"""
                    path == "/api/v1/drive/folders" -> """{"id":"f1","parentId":null,"name":"Actas","createdBy":"u1","createdAt":"2026-09-24T10:00:00Z"}"""
                    path == "/api/v1/drive/files" -> """{"id":"a1","folderId":"f1","name":"x.pdf","contentType":"application/pdf","size":3,"createdBy":"u1","createdAt":"2026-09-24T10:00:00Z"}"""
                    path == "/api/v1/drive/files/a1/link" -> """{"url":"https://s3.example/x.pdf?sig=1"}"""
                    path.matches(Regex("/api/v1/conversations/[^/]+/messages")) && request.method == "POST" -> {
                        val sent = TcJson.parseToJsonElement(String(bytes)).jsonObject
                        val conv = path.split('/')[4]
                        """{"message":{"id":"m-${sent["clientMessageId"]!!.jsonPrimitive.content}","conversationId":"$conv","seq":${requests.size},"authorId":"u1",
                            "clientMessageId":${sent["clientMessageId"]},"body":${sent["body"]},"forwarded":${sent["forwarded"] ?: "null"},"createdAt":"2026-09-24T10:00:00Z"}}"""
                    }
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { client.login("ana@acme.co", "x") }
    }

    @After fun tearDown() { client.close(); server.shutdown() }

    private fun last(method: String, path: String) = requests.last { it.first.method == method && it.first.path!!.substringBefore('?') == path }
    private fun json(s: String) = TcJson.parseToJsonElement(s).jsonObject

    @Test fun `crear chat, sumar personas y salir`() = runBlocking {
        val before = bootstraps
        val r = client.createChat(listOf("u2", "u3", "u2"), "  Obra 12 ")
        assertEquals("new", r.id); assertEquals("multi", r.kind)
        val body = json(last("POST", "/api/v1/chats").third)
        assertEquals(listOf("u2", "u3"), body["userIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("Obra 12", body["name"]!!.jsonPrimitive.content)
        assertTrue("recarga bootstrap", bootstraps > before)
        // Con una persona (directo) no se manda nombre; con nombre de 1 letra tampoco.
        client.createChat(listOf("u2"), "Obra")
        assertTrue(json(last("POST", "/api/v1/chats").third)["name"] == null)
        client.createChat(listOf("u2", "u3"), "x")
        assertTrue(json(last("POST", "/api/v1/chats").third)["name"] == null)
        client.addMembers("c2", listOf("u3"))
        val add = json(last("POST", "/api/v1/conversations/c2/members").third)
        assertEquals("now", add["history"]!!.jsonPrimitive.content)
        assertEquals(listOf("u3"), add["userIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        runCatching { client.removeMember("c2", "u1") }
        assertEquals("DELETE", requests.last { it.first.path == "/api/v1/conversations/c2/members/u1" }.first.method)
    }

    @Test fun `perfil y foto con cuerpo crudo`() = runBlocking {
        client.updateProfile(" Ana R ", "  ", "Operaciones")
        val p = json(last("PATCH", "/api/v1/me").third)
        assertEquals("Ana R", p["name"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, p["title"]); assertEquals("Operaciones", p["area"]!!.jsonPrimitive.content)
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 1, 2, 3)
        client.uploadAvatar(jpeg)
        val up = last("POST", "/api/v1/me/avatar")
        assertEquals("image/jpeg", up.first.getHeader("Content-Type"))
        assertArrayEquals(jpeg, up.second)
        val tooBig = runCatching { client.uploadAvatar(ByteArray(MAX_AVATAR_BYTES + 1)) }.exceptionOrNull() as ApiException
        assertEquals("too_large", tooBig.code)
        client.removeAvatar()
        assertEquals("DELETE", last("DELETE", "/api/v1/me/avatar").first.method)
        assertEquals("http://${server.hostName}:${server.port}/api/v1/avatars/a1", client.mediaUrl(client.state.value.data!!.me.avatarUrl))
    }

    @Test fun `archivos arbol, carpeta, subida y enlace`() = runBlocking {
        assertTrue(client.driveTree(null).canManageAll)
        assertEquals("/api/v1/drive/tree", last("GET", "/api/v1/drive/tree").first.path)
        client.driveTree("w1")
        assertEquals("/api/v1/drive/tree?workspaceId=w1", last("GET", "/api/v1/drive/tree").first.path)
        client.createDriveFolder("w1", null, " Actas ")
        val f = json(last("POST", "/api/v1/drive/folders").third)
        assertEquals("w1", f["workspaceId"]!!.jsonPrimitive.content); assertEquals(JsonNull, f["parentId"]); assertEquals("Actas", f["name"]!!.jsonPrimitive.content)
        client.uploadDriveFile("w1", "f1", "Informe final+v2.pdf", "application/pdf", byteArrayOf(1, 2, 3))
        val up = last("POST", "/api/v1/drive/files")
        val path = up.first.path!!
        assertTrue(path, path.contains("name=Informe%20final%2Bv2.pdf") && path.contains("workspaceId=w1") && path.contains("folderId=f1"))
        assertEquals("application/octet-stream", up.first.getHeader("Content-Type"))
        assertEquals("application/pdf", up.first.getHeader("x-file-type"))
        assertArrayEquals(byteArrayOf(1, 2, 3), up.second)
        client.uploadDriveFile(null, null, "a.bin", null, byteArrayOf(9))
        val up2 = last("POST", "/api/v1/drive/files")
        assertEquals("/api/v1/drive/files?name=a.bin", up2.first.path)
        assertEquals("application/octet-stream", up2.first.getHeader("x-file-type"))
        assertEquals("https://s3.example/x.pdf?sig=1", client.driveFileLink("a1"))
    }

    @Test fun `reenvio a varios chats por la cola con clientMessageId propio`() = runBlocking {
        val src = MessageDTO(id = "m9", conversationId = "c1", seq = 9, authorId = "u2", body = "Original", createdAt = "2026-09-20T08:00:00Z")
        assertEquals(2, client.forward(src, listOf("c2", "c3"), "Ojo"))
        withTimeout(10_000) { while (client.state.value.pending.isNotEmpty() || requests.count { it.first.path!!.endsWith("/messages") } < 4) delay(50) }
        val sent = requests.filter { it.first.method == "POST" && it.first.path!!.endsWith("/messages") }.map { it.first.path!!.split('/')[4] to json(it.third) }
        assertEquals(listOf("c2", "c2", "c3", "c3"), sent.map { it.first })
        assertEquals("Ojo", sent[0].second["body"]!!.jsonPrimitive.content)
        assertTrue(sent[0].second["forwarded"] == null || sent[0].second["forwarded"] == JsonNull)
        val fwd = sent[1].second["forwarded"]!!.jsonObject
        assertEquals("Original", sent[1].second["body"]!!.jsonPrimitive.content)
        assertEquals("tiecoms", fwd["source"]!!.jsonPrimitive.content)
        assertEquals("Mateo Gil", fwd["author"]!!.jsonPrimitive.content)
        assertEquals("2026-09-20T08:00:00Z", fwd["sentAt"]!!.jsonPrimitive.content)
        assertEquals("c1", fwd["fromConversationId"]!!.jsonPrimitive.content)
        assertEquals(4, sent.map { it.second["clientMessageId"]!!.jsonPrimitive.content }.toSet().size)
    }
}
