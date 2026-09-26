import XCTest
@testable import TieComs

/// Parseo de paquetes Engine.IO v4 / Socket.IO v5.
final class SocketIOProtocolTests: XCTestCase {
    func testOpenPacket() {
        let p = EnginePacket.parse(#"0{"sid":"abc123","upgrades":[],"pingInterval":20000,"pingTimeout":20000,"maxPayload":1000000}"#)
        XCTAssertEqual(p, .open(.init(sid: "abc123", pingInterval: 20000, pingTimeout: 20000, maxPayload: 1_000_000)))
    }

    func testOpenPacketWithUnknownFieldsAndDefaults() {
        guard case .open(let info) = EnginePacket.parse(#"0{"sid":"x","nuevo":true}"#) else { return XCTFail() }
        XCTAssertEqual(info.sid, "x")
        XCTAssertEqual(info.pingInterval, 25000)
        XCTAssertEqual(info.pingTimeout, 20000)
    }

    func testPingPongClose() {
        XCTAssertEqual(EnginePacket.parse("2"), .ping)
        XCTAssertEqual(EnginePacket.parse("3"), .pong)
        XCTAssertEqual(EnginePacket.parse("1"), .close)
        XCTAssertEqual(EnginePacket.parse("6"), .noop)
        XCTAssertEqual(EnginePacket.pong.encoded, "3")
        XCTAssertEqual(EnginePacket.ping.encoded, "2")
    }

    func testInvalid() {
        XCTAssertEqual(EnginePacket.parse(""), .invalid(""))
        XCTAssertEqual(EnginePacket.parse("9x"), .invalid("9x"))
        XCTAssertEqual(EnginePacket.parse("0notjson"), .invalid("0notjson"))
    }

    func testConnectAck() {
        guard case .message(let p) = EnginePacket.parse(#"40{"sid":"s1"}"#) else { return XCTFail() }
        XCTAssertEqual(p.kind, .connect)
        XCTAssertEqual(p.namespace, "/")
        XCTAssertNil(p.ackId)
        XCTAssertEqual(p.jsonObject?["sid"] as? String, "s1")
    }

    func testConnectPacketEncoding() {
        let enc = EnginePacket.message(.connect(auth: ["token": "t.o.k"])).encoded
        XCTAssertEqual(enc, #"40{"token":"t.o.k"}"#)
    }

    func testConnectError() {
        guard case .message(let p) = EnginePacket.parse(#"44{"message":"unauthorized"}"#) else { return XCTFail() }
        XCTAssertEqual(p.kind, .connectError)
        XCTAssertEqual(p.jsonObject?["message"] as? String, "unauthorized")
    }

    func testEvent() {
        guard case .message(let p) = EnginePacket.parse(#"42["conv.event",{"type":"message.created","eventSeq":5}]"#) else { return XCTFail() }
        XCTAssertEqual(p.kind, .event)
        XCTAssertNil(p.ackId)
        XCTAssertEqual(p.event?.name, "conv.event")
        XCTAssertEqual((p.event?.args.first as? [String: Any])?["eventSeq"] as? Int, 5)
    }

    func testEventWithoutPayload() {
        guard case .message(let p) = EnginePacket.parse(#"42["ready"]"#) else { return XCTFail() }
        XCTAssertEqual(p.event?.name, "ready")
        XCTAssertEqual(p.event?.args.count, 0)
    }

    func testEventWithNamespaceAndAck() {
        guard case .message(let p) = EnginePacket.parse(#"42/admin,17["x",1]"#) else { return XCTFail() }
        XCTAssertEqual(p.namespace, "/admin")
        XCTAssertEqual(p.ackId, 17)
        XCTAssertEqual(p.event?.name, "x")
    }

    func testEmitWithAckEncoding() {
        let pkt = SocketPacket.event("message.send", ["body": "hola"], ackId: 12)
        XCTAssertEqual(EnginePacket.message(pkt).encoded, #"4212["message.send",{"body":"hola"}]"#)
    }

    func testAckResponse() {
        guard case .message(let p) = EnginePacket.parse(#"4312[{"ok":true,"duplicate":false,"message":{"id":"m1","seq":3}}]"#) else { return XCTFail() }
        XCTAssertEqual(p.kind, .ack)
        XCTAssertEqual(p.ackId, 12)
        let r = p.jsonArray?.first as? [String: Any]
        XCTAssertEqual(r?["ok"] as? Bool, true)
    }

    func testAckError() {
        guard case .message(let p) = EnginePacket.parse(#"430[{"ok":false,"error":{"code":"forbidden","message":"no"}}]"#) else { return XCTFail() }
        XCTAssertEqual(p.ackId, 0)
        XCTAssertEqual(((p.jsonArray?.first as? [String: Any])?["error"] as? [String: Any])?["code"] as? String, "forbidden")
    }

    func testDisconnectPacket() {
        guard case .message(let p) = EnginePacket.parse("41") else { return XCTFail() }
        XCTAssertEqual(p.kind, .disconnect)
    }

    func testSocketURL() {
        XCTAssertEqual(SocketIOClient.socketURL(for: URL(string: "https://app.chaggu.com")!).absoluteString,
                       "wss://app.chaggu.com/api/socket.io/?EIO=4&transport=websocket")
        XCTAssertEqual(SocketIOClient.socketURL(for: URL(string: "http://localhost:3021")!).absoluteString,
                       "ws://localhost:3021/api/socket.io/?EIO=4&transport=websocket")
    }

    func testBackoffBounds() {
        XCTAssertEqual(SocketIOClient.backoffDelay(attempt: 0, random: 0), 0.5, accuracy: 0.001)
        XCTAssertEqual(SocketIOClient.backoffDelay(attempt: 0, random: 1), 0.75, accuracy: 0.001)
        XCTAssertEqual(SocketIOClient.backoffDelay(attempt: 20, random: 1), 30, accuracy: 0.001)
        XCTAssertLessThanOrEqual(SocketIOClient.backoffDelay(attempt: 7), 30)
    }
}
