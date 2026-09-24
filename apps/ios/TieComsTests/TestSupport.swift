import XCTest
@testable import TieComs

@MainActor
final class FeedbackSpy: FeedbackSink {
    var sends = 0
    var receives = 0
    var notifications: [(conversationId: String, body: String)] = []
    func playSend() { sends += 1 }
    func playReceive() { receives += 1 }
    func notifyIncoming(conversationId: String, title: String, author: String, body: String) {
        notifications.append((conversationId, body))
    }
}

func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("tc-tests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

/// Espera activa (en el hilo principal) hasta que se cumpla la condición.
@MainActor
func waitUntil(_ timeout: TimeInterval, _ what: String = "", _ cond: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !cond() {
        if Date() > deadline { throw XCTSkipFailure(what) }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
}

struct XCTSkipFailure: Error, CustomStringConvertible {
    var what: String
    init(_ w: String) { what = w }
    var description: String { "Tiempo agotado esperando: \(what)" }
}

func jsonData(_ s: String) -> Data { Data(s.utf8) }
