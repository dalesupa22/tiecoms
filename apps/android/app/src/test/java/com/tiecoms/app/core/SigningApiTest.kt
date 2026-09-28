package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
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
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Rutas, cabeceras y cuerpos de Firmar PDFs y del historial (contrato de packages/contracts). */
class SigningApiTest {
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, ByteArray>>()
    private lateinit var client: TieComsClient
    private val sig = """{"id":"11111111-1111-1111-1111-111111111111","kind":"signature","source":"drawn","width":600,"height":200,"url":"/api/v1/me/signatures/11111111-1111-1111-1111-111111111111/image","createdAt":"2026-09-27T10:00:00Z"}"""
    private val signing = """{"id":"3f9a21c0-0000-0000-0000-000000000000","signerId":"u1","signerName":"Ana","signedAt":"2026-09-27T10:00:00Z","originalSha256":"aa","signedSha256":"bb"}"""

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readByteArray()
                val path = request.path!!.substringBefore('?')
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana","primaryOrgId":"o1"},"organizations":[],"conversations":[{"id":"c1","kind":"group","memberIds":["u1"]}]}"""
                    path == "/api/v1/reminders" -> """{"reminders":[]}"""
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path == "/api/v1/me/signatures" && request.method == "GET" -> """{"signatures":[$sig]}"""
                    path == "/api/v1/me/signatures" -> sig
                    path.startsWith("/api/v1/me/signatures/") && request.method == "DELETE" -> """{"ok":true}"""
                    path == "/api/v1/attachments/a1/sign-info" -> """{"attachmentId":"a1","name":"x.pdf","sizeBytes":10,"hasDigitalSignature":true,"encrypted":false,"signing":null,"history":[$signing]}"""
                    path == "/api/v1/attachments/a2/sign" -> return MockResponse().setResponseCode(409).setBody("""{"error":{"code":"has_digital_signature","message":"Este PDF ya tiene una firma digital"}}""")
                    path == "/api/v1/attachments/a1/sign" -> """{"message":{"id":"m9","conversationId":"c1","seq":9,"authorId":"u1","kind":"text","body":"✍️ Documento firmado","attachments":[{"id":"a9","name":"x (firmado).pdf","contentType":"application/pdf","signing":$signing}]},"attachment":{"id":"a9","name":"x (firmado).pdf","signing":$signing},"signing":$signing,"duplicate":false}"""
                    path == "/api/v1/me/signings" -> """{"signings":[],"nextBefore":null,"total":0}"""
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
                return MockResponse().setResponseCode(if (request.method == "POST" && path.endsWith("/sign")) 201 else 200).setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { client.login("ana@acme.co", "x") }
    }

    @After fun tearDown() { client.close(); server.shutdown() }

    private fun last(method: String, prefix: String) = requests.last { it.first.method == method && it.first.path!!.startsWith(prefix) }

    @Test fun `firmas guardadas`() = runBlocking {
        val list = client.listSignatures()
        assertEquals(600, list.single().width)
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 1, 2, 3)
        val s = client.createSignature(png, "initials", "typed")
        assertEquals("signature", s.kind)
        val (r, body) = last("POST", "/api/v1/me/signatures")
        assertEquals("image/png", r.getHeader("content-type"))
        assertEquals("initials", r.getHeader("x-signature-kind"))
        assertEquals("typed", r.getHeader("x-signature-source"))
        assertTrue(r.getHeader("authorization")!!.startsWith("Bearer "))
        assertArrayEquals(png, body)
        client.deleteSignature(s.id)
        assertEquals("/api/v1/me/signatures/${s.id}", last("DELETE", "/api/v1/me/signatures/").first.path)
        // Más de 512 KB no sale del teléfono.
        try { client.createSignature(ByteArray(Signing.MAX_PNG_BYTES + 1), "signature", "drawn"); fail() } catch (e: ApiException) { assertEquals(413, e.status) }
    }

    @Test fun `info y firmar`() = runBlocking {
        val info = client.signInfo("a1")
        assertTrue(info.hasDigitalSignature)
        assertEquals("Ana", info.history.single().signerName)
        val input = SignPdfInput(clientMessageId = "cmid-123456", body = "", timeZone = "America/Bogota", acceptBreakingSignatures = true,
            placements = Signing.placements(listOf(
                SignMark("m", MarkKind.SIGNATURE, 1, 0.55f, 0.8f, 0.3f, 0.08f, signatureId = "11111111-1111-1111-1111-111111111111"),
                SignMark("t", MarkKind.DATE, 1, 0.1f, 0.85f, 0.18f, 0.025f, text = "27/09/2026"))))
        val out = client.signPdf("a1", input)
        assertEquals("Ana", out.signing?.signerName)
        assertEquals("Ana", out.attachment?.signing?.signerName)
        assertEquals("a9", out.message?.attachments?.single()?.id)
        val (r, body) = last("POST", "/api/v1/attachments/a1/sign")
        assertTrue(r.getHeader("content-type")!!.startsWith("application/json"))
        val o = TcJson.parseToJsonElement(body.decodeToString()).jsonObject
        assertEquals("cmid-123456", o["clientMessageId"]!!.jsonPrimitive.content)
        assertEquals("America/Bogota", o["timeZone"]!!.jsonPrimitive.content)
        assertEquals("true", o["acceptBreakingSignatures"]!!.jsonPrimitive.content)
        val p = o["placements"]!!.jsonArray
        assertEquals("signature", p[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("0.55", p[0].jsonObject["x"]!!.jsonPrimitive.content)
        assertEquals("text", p[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("27/09/2026", p[1].jsonObject["text"]!!.jsonPrimitive.content)
        // 409 has_digital_signature llega con su código para pedir la confirmación.
        try { client.signPdf("a2", input); fail() } catch (e: ApiException) { assertEquals("has_digital_signature", e.code); assertEquals(409, e.status) }
    }

    @Test fun `historial con busqueda y pagina`() = runBlocking {
        client.signings(before = "2026-09-28T03:17:14.554Z", q = " Contrato Nexo ", limit = 30)
        val path = last("GET", "/api/v1/me/signings").first.path!!
        assertTrue(path, path.contains("limit=30"))
        assertTrue(path, path.contains("before=2026-09-28T03%3A17%3A14.554Z"))
        assertTrue(path, path.contains("q=Contrato%20Nexo"))
        client.signings()
        assertEquals("/api/v1/me/signings?limit=30", last("GET", "/api/v1/me/signings").first.path)
    }
}
