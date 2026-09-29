import XCTest
@testable import TieComs

/// Sonidos por chat, predeterminado y tono de llamada (docs/SONIDOS.md).
@MainActor
final class SoundsTests: XCTestCase {
    func testDecodesSoundFields() throws {
        let b = try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"""
        {"me":{"id":"a","name":"Ana","messageSound":"gota","ringtone":"suave"},
         "conversations":[{"id":"c1","kind":"direct","memberIds":["a"],"sound":"none"},{"id":"c2","kind":"group","memberIds":["a"],"sound":null},{"id":"c3","kind":"group","memberIds":["a"]}]}
        """#.utf8))
        XCTAssertEqual(b.me.messageSound, "gota"); XCTAssertEqual(b.me.ringtone, "suave")
        XCTAssertEqual(b.conversations.map(\.sound), ["none", nil, nil])
        let old = try JSONDecoder().decode(UserDTO.self, from: Data(#"{"id":"a","name":"Ana"}"#.utf8))
        XCTAssertNil(old.messageSound); XCTAssertNil(old.ringtone)
    }

    func testEffectiveSoundAndFiles() {
        XCTAssertEqual(ChatSounds.effective(chat: nil, userDefault: nil), "pop", "de fábrica")
        XCTAssertEqual(ChatSounds.effective(chat: nil, userDefault: "gota"), "gota")
        XCTAssertEqual(ChatSounds.effective(chat: "tambor", userDefault: "gota"), "tambor", "el del chat manda")
        XCTAssertEqual(ChatSounds.effective(chat: "none", userDefault: "gota"), "none")
        XCTAssertEqual(ChatSounds.effective(chat: "futuro", userDefault: nil), "pop", "uno que esta versión no conoce")
        XCTAssertNil(ChatSounds.file("none"))
        XCTAssertEqual(ChatSounds.file("brisa"), "snd_brisa")
        XCTAssertEqual(ChatSounds.file("brisa", mention: true), "snd_brisa_m")
        XCTAssertEqual(ChatSounds.ringFile(nil), "ring_clasico")
        XCTAssertEqual(ChatSounds.ringFile("marimba"), "ring_marimba")
        XCTAssertEqual(ChatSounds.ringFile("otro"), "ring_clasico")
        XCTAssertEqual(ChatSounds.message.count, 10); XCTAssertEqual(ChatSounds.ringtones.count, 3)
    }

    func testAllSoundFilesAndLabelsShip() {
        for s in ChatSounds.message {
            for m in [false, true] { XCTAssertNotNil(Bundle.main.url(forResource: ChatSounds.file(s, mention: m), withExtension: "caf"), s) }
            XCTAssertNotEqual(L("sound.n.\(s)"), "sound.n.\(s)")
        }
        for r in ChatSounds.ringtones {
            XCTAssertNotNil(Bundle.main.url(forResource: ChatSounds.ringFile(r), withExtension: "caf"), r)
            XCTAssertNotEqual(ChatSounds.ringLabel(r), "ring.n.\(r)")
        }
    }

    func testPrefsRequests() async throws {
        let s = try ControlledURLProtocol.store()
        s.seedForTesting(try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"{"me":{"id":"a","name":"Ana"},"conversations":[{"id":"c1","kind":"direct","memberIds":["a"]}]}"#.utf8)))
        var got: [(String, [String: Any])] = []
        ControlledURLProtocol.handler = { req in Task { @MainActor in got.append((req.request.url!.path, req.json)); req.respond(#"{"ok":true}"#) } }
        try await s.setConversationSound("c1", "campana")
        XCTAssertEqual(s.meta("c1")?.sound, "campana")
        try await s.setConversationSound("c1", nil)
        try await s.setMySounds(messageSound: .some("gota"))
        try await s.setMySounds(ringtone: .some("suave"))
        XCTAssertEqual(got.map(\.0), ["/api/v1/conversations/c1/prefs", "/api/v1/conversations/c1/prefs", "/api/v1/me/sounds", "/api/v1/me/sounds"])
        XCTAssertEqual(got[0].1["sound"] as? String, "campana")
        XCTAssertTrue(got[1].1["sound"] is NSNull, "null = el predeterminado")
        XCTAssertEqual(got[2].1.keys.sorted(), ["messageSound"])
        XCTAssertEqual(got[3].1["ringtone"] as? String, "suave")
        XCTAssertEqual(s.me?.messageSound, "gota"); XCTAssertEqual(s.me?.ringtone, "suave")
        XCTAssertEqual(s.soundFor(s.meta("c1")!), "gota")
    }
}
