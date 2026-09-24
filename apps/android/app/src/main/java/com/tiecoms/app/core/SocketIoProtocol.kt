package com.tiecoms.app.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Engine.IO v4 (transporte websocket, solo texto). Cada frame empieza por el tipo:
 * 0 open · 1 close · 2 ping · 3 pong · 4 message · 5 upgrade · 6 noop.
 */
sealed interface EnginePacket {
    data class Open(val sid: String, val pingInterval: Long, val pingTimeout: Long) : EnginePacket
    data object Close : EnginePacket
    data object Ping : EnginePacket
    data object Pong : EnginePacket
    data class Message(val data: String) : EnginePacket
    data object Noop : EnginePacket
    data class Invalid(val raw: String) : EnginePacket
}

object EngineIo {
    const val PONG = "3"

    fun decode(frame: String): EnginePacket {
        if (frame.isEmpty()) return EnginePacket.Invalid(frame)
        val rest = frame.substring(1)
        return when (frame[0]) {
            '0' -> runCatching {
                val o = TcJson.parseToJsonElement(rest) as JsonObject
                EnginePacket.Open(
                    sid = (o["sid"] as? JsonPrimitive)?.contentOrNull ?: "",
                    pingInterval = (o["pingInterval"] as? JsonPrimitive)?.longOrNull ?: 25_000,
                    pingTimeout = (o["pingTimeout"] as? JsonPrimitive)?.longOrNull ?: 20_000,
                )
            }.getOrElse { EnginePacket.Invalid(frame) }
            '1' -> EnginePacket.Close
            '2' -> EnginePacket.Ping
            '3' -> EnginePacket.Pong
            '4' -> EnginePacket.Message(rest)
            '6' -> EnginePacket.Noop
            else -> EnginePacket.Invalid(frame)
        }
    }

    fun message(socketIoPacket: String) = "4$socketIoPacket"
}

/**
 * Socket.IO v5 sobre Engine.IO: `<tipo>[<nsp>,][<ackId>][<json>]`.
 * 0 CONNECT · 1 DISCONNECT · 2 EVENT · 3 ACK · 4 CONNECT_ERROR · 5/6 binarios (no usados).
 */
sealed interface SioPacket {
    data class Connect(val sid: String?) : SioPacket
    data object Disconnect : SioPacket
    data class Event(val name: String, val args: List<JsonElement>, val ackId: Long?) : SioPacket
    data class Ack(val id: Long, val args: List<JsonElement>) : SioPacket
    data class ConnectError(val message: String) : SioPacket
    data class Unsupported(val raw: String) : SioPacket
}

object SocketIo {
    fun decode(packet: String): SioPacket {
        if (packet.isEmpty()) return SioPacket.Unsupported(packet)
        val type = packet[0]
        var i = 1
        if (type == '5' || type == '6') return SioPacket.Unsupported(packet)
        // Espacio de nombres distinto de "/": "/admin,..."
        if (i < packet.length && packet[i] == '/') {
            val comma = packet.indexOf(',', i)
            if (comma < 0) return SioPacket.Unsupported(packet)
            i = comma + 1
        }
        val idStart = i
        while (i < packet.length && packet[i].isDigit()) i++
        val ackId = if (i > idStart) packet.substring(idStart, i).toLongOrNull() else null
        val json = packet.substring(i)
        val data: JsonElement? = if (json.isEmpty()) null else runCatching { TcJson.parseToJsonElement(json) }.getOrNull()
        return when (type) {
            '0' -> SioPacket.Connect(((data as? JsonObject)?.get("sid") as? JsonPrimitive)?.contentOrNull)
            '1' -> SioPacket.Disconnect
            '2' -> {
                val arr = data as? JsonArray ?: return SioPacket.Unsupported(packet)
                val name = (arr.firstOrNull() as? JsonPrimitive)?.contentOrNull ?: return SioPacket.Unsupported(packet)
                SioPacket.Event(name, arr.drop(1), ackId)
            }
            '3' -> {
                val arr = data as? JsonArray ?: return SioPacket.Unsupported(packet)
                if (ackId == null) SioPacket.Unsupported(packet) else SioPacket.Ack(ackId, arr.toList())
            }
            '4' -> SioPacket.ConnectError(
                ((data as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull
                    ?: (data as? JsonPrimitive)?.contentOrNull ?: "error",
            )
            else -> SioPacket.Unsupported(packet)
        }
    }

    fun connect(auth: JsonObject): String = "0$auth"

    fun event(name: String, data: JsonElement?, ackId: Long? = null): String {
        val arr = buildJsonArray {
            add(JsonPrimitive(name))
            if (data != null) add(data)
        }
        return "2${ackId ?: ""}$arr"
    }
}
