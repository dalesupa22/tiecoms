package com.tiecoms.app.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

enum class ConnectionStatus { OFFLINE, CONNECTING, ONLINE }

class SocketNotConnected : Exception("socket not connected")

/**
 * Cliente Socket.IO v5 / Engine.IO v4 propio sobre OkHttp WebSocket (sin librería socket.io).
 * Reconexión con backoff exponencial y jitter (0,5 s → 30 s), vigilancia de latido
 * (pingInterval + pingTimeout) y emisiones con ACK.
 *
 * Todos los callbacks del [Listener] se invocan desde [scope] (el cliente lo confina a un hilo).
 */
class RealtimeSocket(
    private val http: OkHttpClient,
    private val url: () -> String,
    private val scope: CoroutineScope,
    private val listener: Listener,
) {
    interface Listener {
        /** Token de acceso vigente (refresca si hace falta). null = no hay sesión. */
        suspend fun accessToken(): String?
        fun onStatus(status: ConnectionStatus)
        fun onEvent(name: String, args: List<JsonElement>)
        /** El servidor rechazó el token (44). Devuelve false para dejar de intentar (sesión cerrada). */
        suspend fun onUnauthorized(): Boolean
    }

    private sealed interface Signal {
        data class Text(val text: String) : Signal
        data class Closed(val reason: String) : Signal
    }

    private var loop: Job? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var ws: WebSocket? = null
    @Volatile var connected = false
        private set
    private val ackSeq = AtomicLong(0)
    private val acks = ConcurrentHashMap<Long, CompletableDeferred<List<JsonElement>>>()

    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch { run() }
    }

    fun stop() {
        loop?.cancel()
        loop = null
        ws?.cancel()
        ws = null
        failAcks()
        if (connected) connected = false
        listener.onStatus(ConnectionStatus.OFFLINE)
    }

    /** Salta la espera del backoff; con [force] cierra la conexión actual y abre otra. */
    fun reconnectNow(force: Boolean = false) {
        if (force) ws?.cancel()
        wake.trySend(Unit)
    }

    fun emit(name: String, data: JsonElement?): Boolean {
        val socket = ws ?: return false
        if (!connected) return false
        return socket.send(EngineIo.message(SocketIo.event(name, data)))
    }

    suspend fun emitWithAck(name: String, data: JsonElement?, timeoutMs: Long): List<JsonElement> {
        val socket = ws
        if (socket == null || !connected) throw SocketNotConnected()
        val id = ackSeq.incrementAndGet()
        val d = CompletableDeferred<List<JsonElement>>()
        acks[id] = d
        try {
            if (!socket.send(EngineIo.message(SocketIo.event(name, data, id)))) throw SocketNotConnected()
            return withTimeout(timeoutMs) { d.await() }
        } finally {
            acks.remove(id)
        }
    }

    private fun failAcks() {
        val pending = acks.values.toList()
        acks.clear()
        pending.forEach { it.completeExceptionally(SocketNotConnected()) }
    }

    private suspend fun run() {
        var attempt = 0
        while (currentCoroutineContext().isActive) {
            listener.onStatus(ConnectionStatus.CONNECTING)
            val token = listener.accessToken()
            val outcome = if (token == null) Outcome.Unauthorized else session(token)
            connected = false
            ws = null
            failAcks()
            listener.onStatus(ConnectionStatus.OFFLINE)
            when (outcome) {
                Outcome.Unauthorized -> if (!listener.onUnauthorized()) return
                Outcome.WasReady -> attempt = 0
                Outcome.Failed -> Unit
            }
            val base = minOf(30_000.0, 500.0 * (1 shl minOf(attempt, 6)))
            val delayMs = (base * (0.5 + Random.nextDouble())).toLong().coerceIn(250, 30_000)
            attempt++
            withTimeoutOrNull(delayMs) { wake.receive() }
        }
    }

    private enum class Outcome { WasReady, Failed, Unauthorized }

    private suspend fun session(token: String): Outcome {
        val signals = Channel<Signal>(Channel.UNLIMITED)
        val request = Request.Builder().url(url())
            .header("x-tiecoms-client", PLATFORM)
            .header("x-tiecoms-contract", CONTRACT_VERSION)
            .build()
        val socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) { signals.trySend(Signal.Text(text)) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null); signals.trySend(Signal.Closed("closing $code"))
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { signals.trySend(Signal.Closed("closed $code")) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                signals.trySend(Signal.Closed("failure ${t.javaClass.simpleName}: ${t.message}"))
            }
        })
        ws = socket
        var ready = false
        // Antes del "open" del servidor usamos un plazo de conexión; después, el del latido.
        var watchdog = 20_000L
        try {
            while (true) {
                val s = withTimeoutOrNull(watchdog) { signals.receive() } ?: return if (ready) Outcome.WasReady else Outcome.Failed
                when (s) {
                    is Signal.Closed -> return if (ready) Outcome.WasReady else Outcome.Failed
                    is Signal.Text -> when (val p = EngineIo.decode(s.text)) {
                        is EnginePacket.Open -> {
                            watchdog = p.pingInterval + p.pingTimeout
                            socket.send(EngineIo.message(SocketIo.connect(buildJsonObject { put("token", JsonPrimitive(token)) })))
                        }
                        EnginePacket.Ping -> socket.send(EngineIo.PONG)
                        EnginePacket.Close -> return if (ready) Outcome.WasReady else Outcome.Failed
                        is EnginePacket.Message -> when (val sp = SocketIo.decode(p.data)) {
                            is SioPacket.Connect -> { connected = true }
                            is SioPacket.ConnectError -> return if (sp.message == "unauthorized") Outcome.Unauthorized else Outcome.Failed
                            is SioPacket.Ack -> acks.remove(sp.id)?.complete(sp.args)
                            is SioPacket.Event -> {
                                if (sp.name == "ready") { ready = true; listener.onStatus(ConnectionStatus.ONLINE) }
                                listener.onEvent(sp.name, sp.args)
                            }
                            SioPacket.Disconnect -> return if (ready) Outcome.WasReady else Outcome.Failed
                            is SioPacket.Unsupported -> Unit
                        }
                        EnginePacket.Pong, EnginePacket.Noop, is EnginePacket.Invalid -> Unit
                    }
                }
            }
        } finally {
            socket.cancel()
        }
    }
}
