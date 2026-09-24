package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList

class SsoTest {
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private var exchangeResponse: MockResponse = MockResponse().setResponseCode(500)

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when (request.path?.substringBefore('?')) {
                    "$AUTH_BASE_PATH/sso/exchange" -> exchangeResponse
                    "/api/v1/bootstrap" -> MockResponse().setBody("""{"contract":"2026-09-23","me":{"id":"u1","name":"Ana SSO"},"conversations":[],"nuevo":true}""")
                    "/api/v1/blocks" -> MockResponse().setBody("""{"userIds":[]}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun tearDown() { server.shutdown() }

    private fun base() = server.url("/").toString().trimEnd('/')

    @Test fun `verifier PKCE de 64 caracteres base64url y challenge S256`() {
        val v = Pkce.newVerifier()
        assertEquals(64, v.length)
        assertTrue(v.all { it.isLetterOrDigit() || it == '-' || it == '_' })
        assertFalse(v == Pkce.newVerifier())
        // Vector calculado de forma independiente (Python hashlib + base64url sin relleno).
        assertEquals("DJpZScnIlYEJpbXxD4ESNrNvNRfPxK1Uly1ZtJP9d-w", Pkce.challenge("dBjftJeZ4CVP-mJ92K9mphV-_4mB3BkQmWC0ljfMmFvhE"))
        assertEquals(43, Pkce.challenge(v).length)
    }

    @Test fun `url de inicio con todos los parametros`() {
        val u = URI(Sso.startUrl("https://app.tiecoms.com/", SsoProvider.MICROSOFT, "dev-1", "abc_-"))
        assertEquals("/api/v1/auth/microsoft/start", u.path)
        assertEquals("platform=android&device_id=dev-1&code_challenge=abc_-&code_challenge_method=S256", u.rawQuery)
    }

    @Test fun `callbacks de sso`() {
        assertEquals(SsoCallback.Code("xyz"), Sso.parseCallback("tiecoms://auth/callback?code=xyz"))
        val e = Sso.parseCallback("tiecoms://auth/callback?error=domain_not_allowed&message=Tu%20dominio%20no%20est%C3%A1%20permitido") as SsoCallback.Error
        assertEquals("domain_not_allowed", e.code)
        assertEquals("Tu dominio no está permitido", e.message)
        assertFalse(e.cancelled)
        assertTrue((Sso.parseCallback("tiecoms://auth/callback?error=access_denied") as SsoCallback.Error).cancelled)
        assertNull(Sso.parseCallback("tiecoms://c/abc"))
        assertNull(Sso.parseCallback("https://app.tiecoms.com/auth/callback?code=x"))
        // El router de enlaces ignora el host reservado auth.
        assertNull(DeepLinks.parse("tiecoms://auth/callback?code=xyz"))
        assertNull(DeepLinks.parse("tiecoms://auth/otra"))
    }

    @Test fun `canje del codigo con verifier y dispositivo, sesion lista`() = runBlocking {
        exchangeResponse = MockResponse().setBody(
            """{"accessToken":"at","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"rt-sso","sessionId":"s","user":{"id":"u1","name":"Ana SSO"},"provider":"google"}""",
        )
        val storage = MemoryStorage(); val secrets = MemorySecretStore()
        val client = TieComsClient(base(), "Pixel 7", storage, secrets, OkHttpClient())
        try {
            val start = URI(client.beginSso(SsoProvider.GOOGLE))
            assertEquals("$AUTH_BASE_PATH/google/start", start.path)
            val challenge = start.rawQuery.split('&').first { it.startsWith("code_challenge=") }.substringAfter('=')
            // Simula la muerte del proceso: otro cliente con el mismo almacenamiento recupera el verifier.
            client.close()
            val revived = TieComsClient(base(), "Pixel 7", storage, secrets, OkHttpClient())
            try {
                revived.completeSso("one-time-code")
                val ex = requests.first { it.path == "$AUTH_BASE_PATH/sso/exchange" }
                assertEquals("POST", ex.method)
                val body = TcJson.parseToJsonElement(ex.body.readUtf8()).jsonObject
                assertEquals("one-time-code", body["code"]!!.jsonPrimitive.content)
                val verifier = body["code_verifier"]!!.jsonPrimitive.content
                assertEquals(challenge, Pkce.challenge(verifier))
                val device = body["device"]!!.jsonObject
                assertEquals("android", device["platform"]!!.jsonPrimitive.content)
                assertEquals(CONTRACT_VERSION, device["contract"]!!.jsonPrimitive.content)
                assertEquals(storage.get("device:id"), device["deviceId"]!!.jsonPrimitive.content)
                assertEquals("Pixel 7", device["name"]!!.jsonPrimitive.content)
                assertEquals(CONTRACT_VERSION, ex.getHeader("x-tiecoms-contract"))
                assertEquals(SessionStatus.READY, revived.state.value.status)
                assertEquals("rt-sso", secrets.get())
                assertFalse("El verifier es de un solo uso", revived.hasSsoAttempt())
            } finally { revived.close() }
        } finally { client.close() }
    }

    @Test fun `codigo vencido o rechazado muestra error del api`() = runBlocking {
        exchangeResponse = MockResponse().setResponseCode(400).setBody("""{"error":{"code":"invalid_code","message":"El código venció"}}""")
        val client = TieComsClient(base(), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        try {
            client.beginSso(SsoProvider.MICROSOFT)
            try { client.completeSso("old"); fail("debió fallar") } catch (e: ApiException) {
                assertEquals("invalid_code", e.code); assertEquals("El código venció", e.message)
            }
            assertEquals(SessionStatus.LOADING, client.state.value.status)
            // Sin intento guardado (p. ej. callback repetido): error local, sin llamar al API.
            val before = requests.size
            try { client.completeSso("again"); fail() } catch (e: ApiException) { assertEquals("sso_expired", e.code) }
            assertEquals(before, requests.size)
        } finally { client.close() }
    }
}
