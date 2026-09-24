import XCTest
import UIKit
@testable import TieComs

/// Integración v3 contra un API de PRUEBAS con almacenamiento (S3 falso: apps/api/test/fake-s3.mjs) y worker:
/// perfil y foto, chats grupales entre empresas, sumar/salir, vista previa de enlaces en vivo y archivos.
/// Entorno: TEST_RUNNER_TC_FIXTURE=<fx.json> y TEST_RUNNER_TC_V3=1.
@MainActor
final class IntegrationV3Tests: XCTestCase {
    typealias Fixture = IntegrationTests.Fixture

    private func store() async throws -> (AppStore, Fixture) {
        guard ProcessInfo.processInfo.environment["TC_V3"] == "1" else { throw XCTSkip("Sin TC_V3=1") }
        guard let path = ProcessInfo.processInfo.environment["TC_FIXTURE"], !path.isEmpty else { throw XCTSkip("Sin TC_FIXTURE") }
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertFalse(f.apiUrl.contains("app.tiecoms.com"), "no se prueba contra producción")
        let s = AppStore(baseURL: URL(string: f.apiUrl)!, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: FeedbackSpy())
        try await s.login(email: f.a.email, password: f.password)
        return (s, f)
    }

    func test1_ProfileAndAvatar() async throws {
        let (s, _) = try await store()
        let before = s.data!.me
        try await s.updateProfile(name: before.name, title: "Coordinadora iOS", area: "Pruebas")
        XCTAssertEqual(s.data?.me.title, "Coordinadora iOS")
        XCTAssertEqual(Naming.person(s.data!, before.id)?.area, "Pruebas")
        let img = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 600)).image { c in UIColor.orange.setFill(); c.fill(CGRect(x: 0, y: 0, width: 900, height: 600)) }
        try await s.uploadAvatar(jpeg: try XCTUnwrap(AvatarCrop.squareJPEG(img)))
        let url = try XCTUnwrap(Naming.person(s.data!, before.id)?.avatarUrl, "bootstrap trae la foto")
        let (data, res) = try await URLSession.shared.data(from: try XCTUnwrap(MediaURL.absolute(url)))
        XCTAssertEqual((res as? HTTPURLResponse)?.statusCode, 200, "la foto es pública")
        XCTAssertEqual(UIImage(data: data).map { $0.size.width * $0.scale }, 512)
        try await s.removeAvatar()
        XCTAssertNil(Naming.person(s.data!, before.id)?.avatarUrl)
        // Restaura el perfil del fixture.
        try await s.updateProfile(name: before.name, title: before.title, area: before.area)
    }

    func test2_MultiChatAddLeaveAndLivePreview() async throws {
        let (s, f) = try await store()
        try await waitUntil(10, "socket online") { s.connection == .online }
        // Una persona: el directo (existente o nuevo).
        let direct = try await s.createChat(userIds: [f.b.id], name: nil)
        XCTAssertEqual(direct.kind, .direct)
        let again = try await s.createChat(userIds: [f.b.id], name: nil)
        XCTAssertEqual(again.id, direct.id, "reusa el directo")
        let others = s.data!.people.filter { $0.id != f.a.id && $0.id != f.b.id && $0.kind == "human" }
        guard let third = others.first else { throw XCTSkip("El fixture no tiene una tercera persona (seed v3)") }
        let r = try await s.createChat(userIds: [f.b.id, third.id], name: "Compras iOS \(Int.random(in: 1000...9999))")
        XCTAssertEqual(r.kind, .multi)
        let c = try XCTUnwrap(s.meta(r.id), "tras crear, el snapshot ya lo trae")
        XCTAssertEqual(c.kind, .multi)
        XCTAssertNil(c.workspaceId)
        XCTAssertTrue(Naming.sections(s.data!, filterWorkspace: nil, query: "").first { $0.id == "_directs" }?.conversations.contains { $0.id == r.id } ?? false)
        // Vista previa en vivo: llega con message.updated después del envío.
        try await s.openConversation(r.id)
        s.send(r.id, body: "Ficha: https://github.com/")
        try await waitUntil(30, "linkPreview por message.updated") {
            s.conversations[r.id]?.messages.contains { $0.body.hasPrefix("Ficha:") && $0.linkPreview != nil } ?? false
        }
        // Salir del chat grupal.
        try await s.leaveConversation(r.id)
        XCTAssertNil(s.meta(r.id), "ya no está en mi alcance")
    }

    func test3_DriveFolderUploadDownload() async throws {
        let (s, _) = try await store()
        let name = "iOS \(Int.random(in: 1000...9999))"
        let folder = try await s.createDriveFolder(workspaceId: nil, parentId: nil, name: name)
        let body = Data("hola archivo & más".utf8)
        let file = try await s.uploadDriveFile(workspaceId: nil, folderId: folder.id, name: "nota + prueba.txt", contentType: "text/plain", data: body)
        XCTAssertEqual(file.name, "nota + prueba.txt", "el nombre con + y espacios llega intacto")
        let tree = try await s.driveTree(workspaceId: nil)
        XCTAssertEqual(tree.files(in: folder.id).map(\.id), [file.id])
        let link = try await s.driveFileLink(file.id)
        let (data, _) = try await URLSession.shared.data(from: link)
        XCTAssertEqual(data, body)
    }
}
