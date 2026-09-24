package com.tiecoms.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.util.Collections
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Integración contra el API de PRUEBAS (http://localhost:3021, base tiecoms_test).
 * Se omite si no hay fixture:
 *   TIECOMS_FIXTURE=/ruta/fx.json TIECOMS_PEER_DIR=/ruta/con/node_modules ./gradlew :app:testDebugUnitTest
 * El fixture lo genera scripts/mobile-fixture.mjs (contraseña aleatoria, nunca en el código).
 */
class LiveApiIntegrationTest {
    private val fxPath = System.getenv("TIECOMS_FIXTURE").orEmpty()
    private val peerDir = System.getenv("TIECOMS_PEER_DIR").orEmpty()

    private fun log(step: String, detail: String) = println("[integración] $step: $detail")

    @Test
    fun flujoCompletoContraApiDePruebas() = runBlocking {
        assumeTrue("Sin TIECOMS_FIXTURE: se omite la integración", fxPath.isNotBlank() && File(fxPath).exists())
        val fx = TcJson.parseToJsonElement(File(fxPath).readText()).jsonObject
        val api = fx["apiUrl"]!!.jsonPrimitive.content
        assertFalse("Nunca contra producción", api.contains("app.tiecoms.com"))
        val password = fx["password"]!!.jsonPrimitive.content
        val convId = fx["conversationId"]!!.jsonPrimitive.content
        val a = fx["a"] as JsonObject
        val b = fx["b"] as JsonObject
        val aId = a["id"]!!.jsonPrimitive.content
        val bId = b["id"]!!.jsonPrimitive.content

        val ok = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()
        val client = TieComsClient(api, "JVM integración", MemoryStorage(), MemorySecretStore(), ok)
        val signals = Collections.synchronizedList(mutableListOf<Pair<Long, ClientSignal>>())
        val collector = CoroutineScope(Dispatchers.Default).launch { client.signals.collect { signals += System.currentTimeMillis() to it } }

        try {
            // 1. Login de A + bootstrap
            var t0 = System.currentTimeMillis()
            client.login(a["email"]!!.jsonPrimitive.content, password)
            val st = client.state.value
            assertEquals(SessionStatus.READY, st.status)
            assertEquals(aId, st.data!!.me.id)
            assertTrue("La conversación del fixture está en el bootstrap", st.data!!.conversations.any { it.id == convId })
            log("login+bootstrap", "${System.currentTimeMillis() - t0} ms, ${st.data!!.conversations.size} conversaciones, ${st.data!!.people.size} personas")

            // 2. Socket conecta y recibe `ready`
            t0 = System.currentTimeMillis()
            withTimeout(10_000) { client.state.first { it.connection == ConnectionStatus.ONLINE } }
            log("socket ready", "${System.currentTimeMillis() - t0} ms")

            client.openConversation(convId)
            assertTrue(client.state.value.conversations[convId]!!.loaded)

            // 3. Envío con ACK por socket
            val body = "android-int ${UUID.randomUUID().toString().take(8)}"
            t0 = System.currentTimeMillis()
            client.send(convId, body)
            val sent = withTimeout(10_000) {
                while (true) {
                    val hit = signals.toList().firstOrNull { (it.second as? ClientSignal.Sent)?.message?.body == body }
                    if (hit != null) return@withTimeout hit
                    kotlinx.coroutines.delay(10)
                }
                @Suppress("UNREACHABLE_CODE") error("")
            }
            log("envío con ACK", "${sent.first - t0} ms (socket=${client.sentViaSocket}, http=${client.sentViaHttp})")
            assertEquals("Salió por socket con ACK", 1, client.sentViaSocket)
            withTimeout(5_000) { client.state.first { s -> s.pending.isEmpty() && s.conversations[convId]!!.messages.count { it.body == body } == 1 } }

            // 4. Recepción en vivo de un mensaje del par (scripts/realtime-peer.mjs como B)
            if (peerDir.isNotBlank()) {
                val peerText = "peer-live ${UUID.randomUUID().toString().take(8)}"
                val pb = ProcessBuilder("node", "scripts/realtime-peer.mjs").directory(File(peerDir)).redirectErrorStream(true)
                pb.environment()["FIXTURE"] = fxPath
                pb.environment()["API_URL"] = api
                pb.environment()["PEER_SEND"] = peerText
                val proc = pb.start()
                val incoming = withTimeout(20_000) {
                    while (true) {
                        val hit = signals.toList().firstOrNull { (it.second as? ClientSignal.Incoming)?.message?.body == peerText }
                        if (hit != null) return@withTimeout hit
                        kotlinx.coroutines.delay(5)
                    }
                    @Suppress("UNREACHABLE_CODE") error("")
                }
                proc.waitFor(10, TimeUnit.SECONDS)
                val out = proc.inputStream.bufferedReader().readText().trim().replace('\n', ' ')
                val m = (incoming.second as ClientSignal.Incoming).message
                val latency = incoming.first - Instant.parse(m.createdAt).toEpochMilli()
                log("recepción en vivo del par", "latencia servidor→cliente $latency ms · salida del par: $out")
                assertEquals(bId, m.authorId)
                assertTrue("Latencia < 2 s (fue $latency ms)", latency < 2000)
            } else log("recepción en vivo del par", "OMITIDA (sin TIECOMS_PEER_DIR)")

            // 5. Catch-up por /events tras desconectar mientras B escribe
            val beforeSignals = signals.size
            client.debugDisconnect()
            withTimeout(5_000) { client.state.first { it.connection == ConnectionStatus.OFFLINE } }
            val bHttp = HttpApi(api, ok)
            val bLogin = bHttp.exec("POST", "/auth/login", TcJson.encodeToString(LoginBody.serializer(), LoginBody(b["email"]!!.jsonPrimitive.content, password, DeviceInfo(UUID.randomUUID().toString(), "JVM par B"))))
            assertTrue("login B: ${bLogin.code} ${bLogin.body}", bLogin.ok)
            val bToken = TcJson.decodeFromString(AuthResult.serializer(), bLogin.body).accessToken
            val offline = (1..3).map { "offline-$it ${UUID.randomUUID().toString().take(6)}" }
            for (text in offline) {
                val r = bHttp.exec("POST", "/conversations/$convId/messages", TcJson.encodeToString(SendBody.serializer(), SendBody(UUID.randomUUID().toString(), text)), bToken)
                assertTrue(r.ok)
            }
            val cursorBefore = client.state.value.conversations[convId]!!.lastEventSeq
            assertTrue(client.state.value.conversations[convId]!!.messages.none { it.body in offline })
            t0 = System.currentTimeMillis()
            client.debugReconnect()
            withTimeout(15_000) { client.state.first { s -> offline.all { t -> s.conversations[convId]!!.messages.any { it.body == t } } } }
            val cursorAfter = client.state.value.conversations[convId]!!.lastEventSeq
            log("catch-up", "3 mensajes recuperados en ${System.currentTimeMillis() - t0} ms tras reconectar; cursor $cursorBefore → $cursorAfter")
            assertTrue(cursorAfter >= cursorBefore + 3)
            val soundsForCatchUp = signals.drop(beforeSignals).count { (it.second as? ClientSignal.Incoming)?.message?.body in offline }
            assertEquals("El catch-up no dispara sonidos/notificaciones", 0, soundsForCatchUp)
            val seqs = client.state.value.conversations[convId]!!.messages.map { it.seq }
            assertEquals("Sin duplicados ni desorden", seqs.sorted().distinct(), seqs)

            // 6. Idempotencia: mismo clientMessageId dos veces → un solo mensaje
            val aHttp = HttpApi(api, ok)
            val aLogin = aHttp.exec("POST", "/auth/login", TcJson.encodeToString(LoginBody.serializer(), LoginBody(a["email"]!!.jsonPrimitive.content, password, DeviceInfo(UUID.randomUUID().toString(), "JVM idempotencia"))))
            val aToken = TcJson.decodeFromString(AuthResult.serializer(), aLogin.body).accessToken
            val cmid = UUID.randomUUID().toString()
            val payload = TcJson.encodeToString(SendBody.serializer(), SendBody(cmid, "idempotente $cmid"))
            val r1 = aHttp.exec("POST", "/conversations/$convId/messages", payload, aToken)
            val r2 = aHttp.exec("POST", "/conversations/$convId/messages", payload, aToken)
            val s1 = TcJson.decodeFromString(SendResult.serializer(), r1.body)
            val s2 = TcJson.decodeFromString(SendResult.serializer(), r2.body)
            assertEquals(201, r1.code); assertEquals(200, r2.code)
            assertFalse(s1.duplicate); assertTrue(s2.duplicate)
            assertEquals(s1.message!!.id, s2.message!!.id)
            val page = aHttp.exec("GET", "/conversations/$convId/messages?limit=100", null, aToken)
            val count = TcJson.decodeFromString(MessagesPage.serializer(), page.body).messages.count { it.clientMessageId == cmid }
            assertEquals(1, count)
            // El cliente también reconcilia: al llegar el evento no aparece dos veces.
            withTimeout(5_000) { client.state.first { s -> s.conversations[convId]!!.messages.count { it.clientMessageId == cmid } == 1 } }
            log("idempotencia", "HTTP ${r1.code} duplicate=${s1.duplicate} → HTTP ${r2.code} duplicate=${s2.duplicate}, mismo id; 1 mensaje en el historial")

            assertNotNull(client.meta(convId))
        } finally {
            collector.cancel()
            client.logout()
            client.close()
        }
    }
}
