package com.tiecoms.app.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SocketIoProtocolTest {
    @Test fun `0 open trae sid y tiempos de latido`() {
        val p = EngineIo.decode("""0{"sid":"abc","upgrades":[],"pingInterval":20000,"pingTimeout":20000,"maxPayload":1000000}""")
        assertEquals(EnginePacket.Open("abc", 20000, 20000), p)
    }

    @Test fun `open sin tiempos usa valores por defecto`() {
        assertEquals(EnginePacket.Open("x", 25000, 20000), EngineIo.decode("""0{"sid":"x"}"""))
    }

    @Test fun `2 ping 3 pong 1 close 6 noop`() {
        assertEquals(EnginePacket.Ping, EngineIo.decode("2"))
        assertEquals(EnginePacket.Pong, EngineIo.decode("3"))
        assertEquals(EnginePacket.Close, EngineIo.decode("1"))
        assertEquals(EnginePacket.Noop, EngineIo.decode("6"))
        assertEquals("3", EngineIo.PONG)
        assertTrue(EngineIo.decode("") is EnginePacket.Invalid)
        assertTrue(EngineIo.decode("0no-json") is EnginePacket.Invalid)
    }

    @Test fun `40 connect con sid`() {
        val e = EngineIo.decode("""40{"sid":"s1"}""") as EnginePacket.Message
        assertEquals(SioPacket.Connect("s1"), SocketIo.decode(e.data))
        assertEquals(SioPacket.Connect(null), SocketIo.decode("0"))
    }

    @Test fun `el cliente se autentica con 40 y el token`() {
        val frame = EngineIo.message(SocketIo.connect(buildJsonObject { put("token", JsonPrimitive("t.o.k")) }))
        assertEquals("""40{"token":"t.o.k"}""", frame)
    }

    @Test fun `42 evento con payload`() {
        val raw = """2["conv.event",{"type":"message.created","conversationId":"c1","eventSeq":7}]"""
        val p = SocketIo.decode(raw) as SioPacket.Event
        assertEquals("conv.event", p.name)
        assertNull(p.ackId)
        assertEquals("c1", p.args[0].jsonObject["conversationId"]!!.jsonPrimitive.content)
    }

    @Test fun `evento con ack id y espacio de nombres`() {
        val p = SocketIo.decode("""2/admin,15["ping",1]""") as SioPacket.Event
        assertEquals("ping", p.name)
        assertEquals(15L, p.ackId)
    }

    @Test fun `43 ack con id de varios digitos`() {
        val p = SocketIo.decode("""3123[{"ok":true,"duplicate":false,"message":{"id":"m1"}}]""") as SioPacket.Ack
        assertEquals(123L, p.id)
        assertEquals(true, (p.args[0] as JsonObject)["ok"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test fun `44 connect error unauthorized`() {
        assertEquals(SioPacket.ConnectError("unauthorized"), SocketIo.decode("""4{"message":"unauthorized"}"""))
    }

    @Test fun `emision con ack`() {
        val s = SocketIo.event("message.send", buildJsonObject { put("body", JsonPrimitive("hola")) }, 9)
        assertEquals("""29["message.send",{"body":"hola"}]""", s)
        assertEquals("""42["typing",{"conversationId":"c"}]""", EngineIo.message(SocketIo.event("typing", buildJsonObject { put("conversationId", JsonPrimitive("c")) })))
    }

    @Test fun `paquetes binarios o rotos no revientan`() {
        assertTrue(SocketIo.decode("51-[\"x\",{\"_placeholder\":true,\"num\":0}]") is SioPacket.Unsupported)
        assertTrue(SocketIo.decode("2{not json") is SioPacket.Unsupported)
        assertTrue(SocketIo.decode("3[1]") is SioPacket.Unsupported) // ACK sin id
        assertTrue(SocketIo.decode("") is SioPacket.Unsupported)
        assertEquals(SioPacket.Disconnect, SocketIo.decode("1"))
    }
}
