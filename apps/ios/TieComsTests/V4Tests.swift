import Intents
import UniformTypeIdentifiers
import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

/// SPEC-v4: adjuntos, Chaggu en la hoja de compartir, pestañas de Inicio y sesión por servidor.
final class V4Tests: XCTestCase {
    static let json = #"""
    {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"oA"},
     "organizations":[{"id":"oA","name":"Xertify","mark":"X","colorBg":"#112233","colorFg":"#ffffff","myRole":"owner"},
                      {"id":"oB","name":"Estudio Norte","mark":"EN","colorBg":"#f5c518","colorFg":"#000000"}],
     "workspaces":[{"id":"w1","name":"Lanzamiento","owningOrgId":"oA","organizationIds":["oA","oB"],"memberIds":["me","bob"],"myRole":"lead","createdAt":""},
                   {"id":"w2","name":"Interno","owningOrgId":"oA","organizationIds":["oA"],"memberIds":["me"],"myRole":"lead","createdAt":""}],
     "conversations":[
       {"id":"c1","workspaceId":"w1","kind":"group","name":"Comité directivo","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T10:00:00Z","unread":2,"openIssues":3,
        "lastMessagePreview":"📷 ×3","lastHumanPreview":{"messageId":"m9","seq":9,"authorId":"bob","body":"Mira esto","attachments":{"count":3,"images":3,"videos":0,"files":0,"firstName":"a.jpg"},"createdAt":"2026-09-25T10:00:00Z"}},
       {"id":"c2","workspaceId":"w1","kind":"internal","name":"Equipo interno","memberIds":["me"],"lastMessageAt":"2026-09-24T10:00:00Z","unread":1,"mutedUntil":"2099-01-01T00:00:00Z"},
       {"id":"c3","workspaceId":"w2","kind":"group","name":"Planeación","memberIds":["me"],"lastMessageAt":"2026-09-23T10:00:00Z","lastHumanPreview":null,"lastMessagePreview":"📎 plan.pdf"},
       {"id":"s1","workspaceId":null,"kind":"multi","name":"Consulta · fecha","memberIds":["me","col"],"parentId":"c1","parentMessageId":"m1","deriveKind":"side","unread":4},
       {"id":"d1","workspaceId":null,"kind":"direct","memberIds":["me","bob"],"lastMessageAt":"2026-09-25T11:00:00Z"}],
     "people":[{"id":"me","name":"Ana","kind":"human","orgId":"oA"},{"id":"bob","name":"Bob","kind":"human","orgId":"oB","avatarUrl":"/api/v1/avatars/bob"},{"id":"col","name":"Carla","kind":"human","orgId":"oA"}]}
    """#
    private func boot() throws -> BootstrapDTO { try dec(BootstrapDTO.self, Self.json) }

    // MARK: Adjuntos

    func testAttachmentDecodeAndPreviews() throws {
        let m = try dec(MessageDTO.self, #"""
        {"id":"m","seq":1,"authorId":"u","body":"","createdAt":"","attachments":[
          {"id":"a1","name":"foto.jpg","contentType":"image/jpeg","sizeBytes":1200,"width":800,"height":600,"url":"/api/v1/attachments/a1","thumbUrl":"/api/v1/attachments/a1/thumb"},
          {"id":"a2","name":"clip.mov","contentType":"video/quicktime","sizeBytes":99,"width":null,"height":null,"url":"/api/v1/attachments/a2","thumbUrl":null},
          {"roto":true}]}
        """#)
        XCTAssertEqual(m.attachments.map(\.id), ["a1", "a2"], "orden de envío; ítems inválidos se ignoran")
        XCTAssertTrue(m.attachments[0].isImage)
        XCTAssertEqual(m.attachments[0].width, 800)
        XCTAssertTrue(m.attachments[1].isVideo)
        XCTAssertNil(m.attachments[1].thumbUrl)
        XCTAssertEqual(try dec(MessageDTO.self, #"{"id":"x","seq":1,"authorId":"u","body":"hola","createdAt":""}"#).attachments, [], "sin campo = sin adjuntos")

        let img = AttachmentDTO(id: "i", name: "a.jpg", contentType: "image/jpeg", sizeBytes: 1, width: nil, height: nil, url: "/u", thumbUrl: nil)
        let pdf = AttachmentDTO(id: "p", name: "plan.pdf", contentType: "application/pdf", sizeBytes: 1, width: nil, height: nil, url: "/u", thumbUrl: nil)
        XCTAssertEqual(L10n.attachmentsLabel([img]), L("att.photo"))
        XCTAssertEqual(L10n.attachmentsLabel([img, img, img]), L("att.photos", ["n": 3]))
        XCTAssertEqual(L10n.attachmentsLabel([pdf]), L("att.file", ["name": "plan.pdf"]))
        XCTAssertEqual(L10n.attachmentsLabel([img, pdf]), L("att.files", ["n": 2]))
        var withText = m; withText.body = "Mira"; withText.attachments = [img]
        XCTAssertEqual(L10n.messagePreview(withText), "\(L("att.photo")) · Mira")

        let d = try boot()
        XCTAssertEqual(L10n.listPreview(d.conversations[0]), "\(L("att.photos", ["n": 3])) · Mira esto", "se prefiere lastHumanPreview (objeto)")
        XCTAssertEqual(L10n.listPreview(d.conversations[2]), "📎 plan.pdf", "sin lastHumanPreview se usa lastMessagePreview")
    }

    func testAttachmentRulesAndThumbnail() throws {
        XCTAssertEqual(AttachmentRules.maxBytes, 25 * 1024 * 1024)
        XCTAssertEqual(AttachmentRules.maxPerMessage, 10)
        XCTAssertEqual(AttachmentRules.mimeType(for: URL(fileURLWithPath: "/x/plan.pdf")), "application/pdf")
        XCTAssertEqual(AttachmentRules.icon("image/png", "a.png"), "photo")
        XCTAssertEqual(AttachmentRules.icon("application/octet-stream", "a.pdf"), "doc.richtext")
        XCTAssertTrue(LocalAttachment(name: "big.bin", contentType: "application/octet-stream", data: Data(count: 25 * 1024 * 1024 + 1)).tooBig)
        let big = UIGraphicsImageRenderer(size: CGSize(width: 2400, height: 1200)).image { ctx in
            UIColor.systemOrange.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 2400, height: 1200))
        }
        let thumb = try XCTUnwrap(Thumbnails.jpeg(for: LocalAttachment(name: "a.png", contentType: "image/png", data: big.pngData()!)))
        let t = try XCTUnwrap(UIImage(data: thumb))
        XCTAssertEqual(max(t.size.width * t.scale, t.size.height * t.scale), 480)
        XCTAssertLessThanOrEqual(thumb.count, 512 * 1024)
        XCTAssertNil(Thumbnails.jpeg(for: LocalAttachment(name: "a.pdf", contentType: "application/pdf", data: Data([1, 2]))))
    }

    // MARK: Hoja de compartir

    func testActivationRuleMatchesInfoPlistAndPredicate() throws {
        // El Info.plist de la extensión compilada lleva exactamente la regla del código.
        let appex = Bundle.main.builtInPlugInsURL!.appendingPathComponent("TieComsShare.appex")
        let info = try XCTUnwrap(Bundle(url: appex)?.infoDictionary)
        let ext = try XCTUnwrap(info["NSExtension"] as? [String: Any])
        let attrs = try XCTUnwrap(ext["NSExtensionAttributes"] as? [String: Any])
        let rule = try XCTUnwrap(attrs["NSExtensionActivationRule"] as? String)
        func norm(_ s: String) -> String { s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ") }
        XCTAssertEqual(norm(rule), norm(ShareItems.activationRule))
        XCTAssertEqual(attrs["IntentsSupported"] as? [String], ["INSendMessageIntent"])

        // Evaluación de la regla sobre elementos simulados (sin UTI-CONFORMS-TO, que solo evalúa el sistema: se usa IN).
        let evalRule = ShareItems.activationRule.replacingOccurrences(of: "UTI-CONFORMS-TO", with: "IN")
            .replacingOccurrences(of: "\"public.image\"", with: "{'public.image','public.jpeg','public.heic'}")
            .replacingOccurrences(of: "\"public.movie\"", with: "{'public.movie','com.apple.quicktime-movie'}")
            .replacingOccurrences(of: "\"public.data\"", with: "{'public.data','com.adobe.pdf','public.jpeg'}")
            .replacingOccurrences(of: "\"public.content\"", with: "{'public.content'}")
            .replacingOccurrences(of: "\"public.url\"", with: "{'public.url'}")
            .replacingOccurrences(of: "\"public.plain-text\"", with: "{'public.plain-text'}")
            .replacingOccurrences(of: "\"public.item\"", with: "{'public.jpeg','com.adobe.pdf','public.url','public.plain-text','com.apple.quicktime-movie'}")
        let pred = NSPredicate(format: evalRule)
        func ctx(_ items: [[[String]]]) -> NSDictionary {
            ["extensionItems": items.map { atts in ["attachments": atts.map { ["registeredTypeIdentifiers": $0] }] }]
        }
        XCTAssertTrue(pred.evaluate(with: ctx([[["public.jpeg"]]])), "una foto")
        XCTAssertTrue(pred.evaluate(with: ctx([[["public.jpeg"], ["com.apple.quicktime-movie"], ["com.adobe.pdf"]]])), "mezcla foto+video+archivo")
        XCTAssertTrue(pred.evaluate(with: ctx([[["public.url"], ["public.plain-text"]]])), "enlace y texto")
        XCTAssertTrue(pred.evaluate(with: ctx([Array(repeating: ["public.jpeg"], count: 10)])), "10 fotos")
        XCTAssertFalse(pred.evaluate(with: ctx([Array(repeating: ["public.jpeg"], count: 11)])), "11 fotos no")
        XCTAssertFalse(pred.evaluate(with: ctx([[["com.example.raro"]]])), "tipo desconocido no")
        XCTAssertFalse(pred.evaluate(with: ctx([])), "nada no")
    }

    func testShareItemParser() {
        XCTAssertEqual(ShareItems.kind(for: ["public.jpeg"]), .image)
        XCTAssertEqual(ShareItems.kind(for: ["public.heic", "public.jpeg"]), .image)
        XCTAssertEqual(ShareItems.kind(for: ["com.apple.quicktime-movie"]), .video)
        XCTAssertEqual(ShareItems.kind(for: ["public.file-url"]), .file)
        XCTAssertEqual(ShareItems.kind(for: ["com.adobe.pdf"]), .file)
        XCTAssertEqual(ShareItems.kind(for: ["public.url"]), .url)
        XCTAssertEqual(ShareItems.kind(for: ["public.plain-text"]), .text)
        XCTAssertEqual(ShareItems.kind(for: ["public.url", "public.plain-text"]), .url, "Safari: enlace antes que texto")
        XCTAssertNil(ShareItems.kind(for: []))
        XCTAssertEqual(ShareItems.loadType(for: .image, typeIdentifiers: ["public.heic"]), UTType.heic)
        XCTAssertEqual(ShareItems.loadType(for: .file, typeIdentifiers: ["com.adobe.pdf"]), UTType.pdf)
        XCTAssertEqual(ShareItems.defaultName(kind: .image, type: .jpeg, index: 0), "foto-1.jpeg")
        XCTAssertEqual(ShareItems.defaultName(kind: .video, type: .quickTimeMovie, index: 2), "video-3.mov")

        let items = [SharedItem(kind: .url, url: URL(string: "https://tiecoms.com")), SharedItem(kind: .text, text: "  https://tiecoms.com "),
                     SharedItem(kind: .text, text: "Mira esto"), SharedItem(kind: .image, name: "a.jpg", contentType: "image/jpeg", data: Data([1]))]
        XCTAssertEqual(ShareItems.text(of: items), "https://tiecoms.com\nMira esto", "sin duplicados, sin adjuntos")
        XCTAssertEqual(items[3].asAttachment?.name, "a.jpg")
        XCTAssertNil(items[0].asAttachment)
        XCTAssertEqual(ShareItems.problems(items), [])
        let big = SharedItem(kind: .video, name: "largo.mov", contentType: "video/quicktime", data: Data(count: AttachmentRules.maxBytes + 1))
        XCTAssertEqual(ShareItems.problems([big]), [L("att.tooBig", ["name": "largo.mov"])])
        let eleven = (0..<11).map { SharedItem(kind: .image, name: "\($0).jpg", data: Data([1])) }
        XCTAssertEqual(ShareItems.problems(eleven).count, 1)
    }

    func testShareSectionsGroupLikeHome() throws {
        let targets = ShareTargets.targets(try boot())
        XCTAssertEqual(Set(targets.map(\.id)), ["c1", "c2", "c3", "s1", "d1"])
        XCTAssertEqual(targets.first { $0.id == "c1" }?.group, "Estudio Norte · Lanzamiento")
        XCTAssertNil(targets.first { $0.id == "d1" }?.group)
        XCTAssertEqual(targets.first { $0.id == "d1" }?.avatarPath, "/api/v1/avatars/bob", "directo: foto de la otra persona")
        XCTAssertTrue(targets.first { $0.id == "s1" }!.isSide)

        let s = ShareSections.build(targets, query: "", suggested: "c3", recentCount: 2)
        XCTAssertEqual(s.first?.title, L("shareX.suggested"))
        XCTAssertEqual(s[0].items.map(\.id), ["c3"])
        XCTAssertEqual(s[1].title, L("share.recent"))
        XCTAssertEqual(s[1].items.map(\.id), ["d1", "c1"], "recientes primero")
        XCTAssertEqual(Set(s.flatMap(\.items).map(\.id)).count, s.flatMap(\.items).count, "sin repetidos")
        XCTAssertEqual(s.last?.title == L("side.directs") || s.contains { $0.title == "Estudio Norte · Lanzamiento" }, true)

        let q = ShareSections.build(targets, query: "comite", suggested: nil)
        XCTAssertEqual(q.flatMap(\.items).map(\.id), ["c1"], "búsqueda sin tildes; sin «recientes»")
        XCTAssertFalse(q.contains { $0.title == L("share.recent") })
        // La sugerencia de iOS solo se usa si la conversación sigue disponible.
        XCTAssertNotEqual(ShareSections.build(targets, query: "", suggested: "borrada").first?.title, L("shareX.suggested"))

        // Compatibilidad: una lista guardada por la build 5 (id/title/subtitle) sigue leyéndose.
        let old = try dec([ShareTargets.Target].self, #"[{"id":"x","title":"General","subtitle":"Lanzamiento"}]"#)
        XCTAssertEqual(old[0].kind, "group")
        XCTAssertNil(old[0].group)
    }

    @MainActor
    func testDonationIntent() throws {
        let d = try boot()
        let group = Donations.intent(d, d.conversations[0], image: nil)
        XCTAssertEqual(group.conversationIdentifier, "c1")
        XCTAssertEqual(group.speakableGroupName?.spokenPhrase, "Comité directivo")
        XCTAssertEqual(group.recipients?.map(\.customIdentifier), ["bob"], "sin incluirme")
        XCTAssertEqual(group.sender?.isMe, true)
        XCTAssertEqual(group.serviceName, "Chaggu")

        let direct = Donations.intent(d, d.conversations[4], image: INImage(imageData: Data([1, 2, 3])))
        XCTAssertNil(direct.speakableGroupName, "un directo se sugiere como la persona")
        XCTAssertEqual(direct.recipients?.first?.displayName, "Bob")
        XCTAssertNotNil(direct.recipients?.first?.image)
        XCTAssertEqual(Donations.photoPath(d, d.conversations[4]), "/api/v1/avatars/bob")
        XCTAssertNil(Donations.photoPath(d, d.conversations[0]))
        XCTAssertFalse(Donations.enabled, "las unitarias no tocan el índice del simulador")
    }

    // MARK: Inicio

    func testHomeFiltersAndCounts() throws {
        let d = try boot()
        XCTAssertEqual(HomeFilter.allCases.map(\.labelKey), ["home.tab.all", "home.tab.unread", "home.tab.mentions", "home.tab.issues", "home.tab.chats", "home.tab.sides"])
        XCTAssertEqual(HomeFilter.all.count(d), 5)
        XCTAssertEqual(HomeFilter.unread.count(d), 2, "c1 y s1; c2 está silenciada")
        XCTAssertEqual(HomeFilter.issues.count(d), 1)
        XCTAssertEqual(HomeFilter.chats.count(d), 2, "directo + lateral (multi), como la web")
        XCTAssertEqual(HomeFilter.sides.count(d), 1)

        let unread = Naming.homeTree(d, tab: .unread)
        XCTAssertEqual(unread.companies.map { $0.org?.name ?? "" }, ["Estudio Norte"], "se ocultan grupos vacíos")
        XCTAssertEqual(unread.companies[0].workspaces[0].convs.map(\.conv.id), ["c1"])
        XCTAssertTrue(unread.chats.isEmpty)
        let chats = Naming.homeTree(d, tab: .chats)
        XCTAssertEqual(chats.chats.map(\.conv.id), ["d1"])
        XCTAssertEqual(chats.companies.flatMap { $0.workspaces.flatMap { $0.convs.flatMap(\.sides) } }.map(\.id), ["s1"], "la lateral sigue colgando de su origen")
        let sides = Naming.homeTree(d, tab: .sides)
        XCTAssertEqual(sides.companies.flatMap { $0.workspaces.flatMap { $0.convs.flatMap(\.sides) } }.map(\.id), ["s1"])

        let before = UserDefaults.standard.string(forKey: "tc.home.tab")
        HomeFilter.saved = .issues
        XCTAssertEqual(HomeFilter.saved, .issues, "se recuerda la pestaña")
        UserDefaults.standard.set(before, forKey: "tc.home.tab")
    }

    func testUnreadBadgeContrast() throws {
        XCTAssertEqual(try XCTUnwrap(Theme.contrastWithWhite("#ffffff")), 1, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(Theme.contrastWithWhite("#000000")), 21, accuracy: 0.01)
        XCTAssertNotNil(Theme.badgeColor("#112233"), "azul oscuro: AA con blanco")
        XCTAssertNil(Theme.badgeColor("#f5c518"), "amarillo: naranja sobrio")
        XCTAssertNil(Theme.badgeColor("#aaaaaa"))
        XCTAssertNil(Theme.badgeColor("rojo"), "color inválido: naranja sobrio")
        XCTAssertNotNil(Theme.badgeColor("2F6FDB"))
    }

    // MARK: Sesión

    func testSessionIsScopedPerServer() {
        XCTAssertEqual(KeychainSecretStore.account(for: URL(string: "https://app.chaggu.com")), "refreshToken", "producción usa la cuenta refreshToken")
        XCTAssertEqual(KeychainSecretStore.account(for: URL(string: "https://app.tiecoms.com")), "refreshToken", "el dominio anterior comparte la sesión de producción")
        XCTAssertEqual(KeychainSecretStore.account(for: nil), "refreshToken")
        XCTAssertEqual(KeychainSecretStore.account(for: URL(string: "http://localhost:3043")), "refreshToken@localhost:3043")
        XCTAssertEqual(KeychainSecretStore.account(for: URL(string: "http://LOCALHOST:3021/")), "refreshToken@localhost:3021")
        XCTAssertEqual(KeychainSecretStore.account(for: URL(string: "https://staging.tiecoms.com")), "refreshToken@staging.tiecoms.com:443")
    }

    /// Un API que se reinicia (refresh con 502 o sin red) no cierra la sesión; solo un 401 del refresh la cierra.
    @MainActor
    func testSessionSurvivesApiRestart() async throws {
        MockURLProtocol.requests = []
        MockURLProtocol.routes = ["/api/v1/me": (401, #"{"error":{"code":"unauthorized","message":"no"}}"#),
                                  "/api/v1/auth/refresh": (502, "Bad Gateway")]
        let secrets = MemorySecretStore()
        secrets.set("rt-1")
        var signedOut = false
        let api = APIClient(baseURL: URL(string: "http://localhost:3043")!, secrets: secrets, session: MockURLProtocol.session())
        api.onSignedOut = { signedOut = true }
        do { try await api.requestData("/me") ; XCTFail("debía fallar") } catch {}
        XCTAssertEqual(secrets.get(), "rt-1", "502 del refresh: la sesión se conserva")
        XCTAssertFalse(signedOut)
        MockURLProtocol.routes["/api/v1/auth/refresh"] = (401, #"{"error":{"code":"unauthorized","message":"no"}}"#)
        do { try await api.requestData("/me") ; XCTFail("debía fallar") } catch {}
        XCTAssertNil(secrets.get(), "401 del refresh: sesión cerrada")
        XCTAssertTrue(signedOut)
    }

    /// Keychain real del simulador: cada servidor tiene su propia sesión y no se copia la de producción
    /// (Chaggu es una app nueva; ya no existe la migración de la build 6 de TieComs).
    func testKeychainSessionsPerServerAreIsolated() {
        let service = "com.chaggu.test.\(UUID().uuidString)"
        let prod = KeychainSecretStore(service: service)
        prod.set("rt-prod")
        XCTAssertEqual(prod.get(), "rt-prod")
        let dev = KeychainSecretStore(service: service, apiURL: URL(string: "http://localhost:3043"))
        XCTAssertNil(dev.get(), "no hereda la sesión de producción")
        dev.set("rt-dev")
        XCTAssertEqual(dev.get(), "rt-dev")
        XCTAssertEqual(prod.get(), "rt-prod", "no toca la de producción")
        dev.set(nil)
        XCTAssertNil(dev.get())
        XCTAssertEqual(prod.get(), "rt-prod")
        prod.set(nil)
    }

    // MARK: D. Orden y «Grupo en un espacio»

    private func conv(_ id: String, unread: Int = 0, muted: Bool = false, pinned: Bool = false, at: String, human: String? = nil) throws -> ConversationDTO {
        let h = human.map { #","lastHumanPreview":{"seq":1,"body":"x","createdAt":"\#($0)"}"# } ?? ""
        return try dec(ConversationDTO.self, #"{"id":"\#(id)","kind":"group","unread":\#(unread),"lastMessageAt":"\#(at)"\#(muted ? #","mutedUntil":"2099-01-01T00:00:00Z""# : "")\#(pinned ? #","pinnedAt":"2026-01-01T00:00:00Z""# : "")\#(h)}"#)
    }

    func testHomeOrderMatchesWeb() throws {
        let a = try conv("a", at: "2026-09-25T10:00:00Z")
        let b = try conv("b", unread: 2, at: "2026-09-20T10:00:00Z")
        let c = try conv("c", unread: 5, muted: true, at: "2026-09-25T12:00:00Z")
        let d = try conv("d", pinned: true, at: "2026-09-01T10:00:00Z")
        let e = try conv("e", at: "2026-09-25T09:00:00Z", human: "2026-09-25T11:00:00Z")
        let f = try conv("f", at: "2026-09-25T10:00:00Z")
        let sorted = [a, b, c, d, e, f].sorted(by: HomeOrder.before).map(\.id)
        // No leídos primero; silenciada cuenta como leída; fijada arriba de su bloque; actividad = lastHumanPreview ?? lastMessageAt; desempate por id.
        XCTAssertEqual(sorted, ["b", "d", "c", "e", "a", "f"])
        XCTAssertTrue(HomeOrder.rankBefore(.init(unread: 1, activity: "2020"), .init(unread: 0, activity: "2030")))
        XCTAssertTrue(HomeOrder.rankBefore(.init(unread: 3, activity: "2020"), .init(unread: 1, activity: "2030")))
        XCTAssertTrue(HomeOrder.rankBefore(.init(unread: 0, activity: "2030"), .init(unread: 0, activity: "2020")))

        let t = Naming.homeTree(try boot())
        XCTAssertEqual(t.companies.map { $0.org?.name ?? "" }, ["Estudio Norte", "Xertify"], "la empresa con no leídos va primero")
        XCTAssertEqual(t.companies[0].workspaces[0].convs.map(\.conv.id), ["c1", "c2"], "c1 con no leídos; c2 silenciada")
        XCTAssertFalse(t.orderSignature.isEmpty)
    }

    func testSpaceGroupFormData() throws {
        let d = try dec(BootstrapDTO.self, #"""
        {"contract":"x","serverTime":"","me":{"id":"me","name":"Ana","kind":"human","primaryOrgId":"oA"},
         "organizations":[{"id":"oA","name":"Xertify","myRole":"owner"},{"id":"oB","name":"Norte"}],
         "workspaces":[{"id":"w1","name":"Lanzamiento","owningOrgId":"oA","organizationIds":["oA","oB"],"memberIds":["me","bob","col"],"myRole":"lead","createdAt":""},
                       {"id":"w2","name":"Ajeno","owningOrgId":"oB","organizationIds":["oA","oB"],"memberIds":["me","bob"],"myRole":"guest","createdAt":""}],
         "conversations":[],
         "people":[{"id":"me","name":"Ana","kind":"human","orgId":"oA"},{"id":"bob","name":"Bob","kind":"human","orgId":"oB"},{"id":"col","name":"Carla Núñez","kind":"human","orgId":"oA"}]}
        """#)
        let groups = SpaceGroupForm.groups(d)
        XCTAssertEqual(groups.flatMap { $0.1.map(\.id) }, ["w1"], "sin espacios donde soy tercero")
        XCTAssertEqual(groups.first?.0, "oB", "agrupado por la empresa contraparte")
        let ws = d.workspaces[0]
        XCTAssertEqual(SpaceGroupForm.candidates(d, ws, isInternal: false, query: "").map(\.id), ["bob", "col"])
        XCTAssertEqual(SpaceGroupForm.candidates(d, ws, isInternal: true, query: "").map(\.id), ["col"], "interno: solo mi empresa")
        XCTAssertEqual(SpaceGroupForm.candidates(d, ws, isInternal: false, query: "nunez").map(\.id), ["col"], "búsqueda sin tildes")
    }

    // MARK: E. Asuntos y agenda en chats; aviso de 10 min

    func testIssuesAndEventsInChats() throws {
        let d = try boot()
        let i1 = try dec(IssueDTO.self, #"{"id":"i1","workspaceId":null,"conversationId":"d1","title":"Contrato","status":"open"}"#)
        let i2 = try dec(IssueDTO.self, #"{"id":"i2","workspaceId":"w1","conversationId":"c1","title":"Fecha","status":"open"}"#)
        XCTAssertNil(i1.workspaceId)
        let tree = IssueTree.group(d, [i1, i2])
        XCTAssertEqual(tree.map(\.isChats), [false, true], "«Chats» después de las empresas")
        XCTAssertEqual(tree.last?.workspaces.first?.convs.map(\.id), ["d1"])
        let ev = try dec(CalendarEventDTO.self, #"{"id":"e1","workspaceId":null,"conversationId":"d1","title":"Revisión","startsAt":"2026-09-25T15:00:00Z","endsAt":"2026-09-25T15:30:00Z"}"#)
        XCTAssertNil(ev.workspaceId)

        let soon = try dec(AccountEvent.self, #"{"type":"event.soon","minutes":10,"event":{"id":"e1","conversationId":"d1","title":"Revisión","startsAt":"2026-09-25T15:00:00Z","endsAt":"2026-09-25T15:30:00Z"}}"#)
        guard case .eventSoon(let e, let m) = soon else { return XCTFail("event.soon") }
        XCTAssertEqual(e.id, "e1"); XCTAssertEqual(m, 10)
        XCTAssertEqual(L("cal.soon", ["n": 10, "title": "Revisión"]).contains("Revisión"), true)

        let push = PushPayload(userInfo: ["type": "event", "conversationId": "d1", "eventId": "e1", "minutes": 10,
                                          "aps": ["alert": ["title": "Empieza en 10 min: Revisión", "body": "10:00"], "category": "TC_EVENT", "thread-id": "d1"]])
        XCTAssertEqual(push?.isEventSoon, true)
        XCTAssertEqual(push?.category, PushPayload.eventCategory)
        let invite = PushPayload(userInfo: ["type": "event", "conversationId": "d1", "eventId": "e1", "aps": ["alert": ["title": "Reunión", "body": "x"]]])
        XCTAssertEqual(invite?.isEventSoon, false, "la convocatoria no trae minutes")
    }

    // MARK: F. Notas de voz

    func testVoiceNoteDecodeAndPreview() throws {
        let m = try dec(MessageDTO.self, #"""
        {"id":"m","seq":1,"authorId":"u","body":"","createdAt":"","attachments":[
          {"id":"v1","name":"nota.m4a","contentType":"audio/mp4","sizeBytes":9000,"url":"/api/v1/attachments/v1","kind":"voice","durationMs":42400,
           "waveform":[0.1,0.5,1.4,-2],"transcript":{"status":"done","text":"Hola, te envío el contrato el jueves","language":"es","summary":null,"suggestedIssue":"Enviar el contrato el jueves"}}]}
        """#)
        let v = try XCTUnwrap(m.attachments.first)
        XCTAssertTrue(v.isVoice); XCTAssertFalse(v.isMedia)
        XCTAssertEqual(v.durationMs, 42400)
        XCTAssertEqual(v.waveform, [0.1, 0.5, 1, 0], "0…1")
        XCTAssertEqual(v.transcript?.status, .done)
        XCTAssertEqual(v.transcript?.suggestedIssue, "Enviar el contrato el jueves")
        XCTAssertEqual(L10n.duration(42400), "0:42")
        XCTAssertEqual(L10n.duration(61_600), "1:02")
        XCTAssertEqual(L10n.messagePreview(m), L("voice.preview", ["d": "0:42"]))
        let fresh = try dec(AttachmentDTO.self, #"{"id":"v2","name":"n.m4a","contentType":"audio/mp4","sizeBytes":1,"kind":"voice","transcript":null}"#)
        XCTAssertNil(fresh.transcript, "recién subido llega null")
        XCTAssertEqual(try dec(VoiceTranscript.self, #"{"status":"raro"}"#).status, .pending)
        let counts = HumanPreview.Counts(count: 1, images: 0, videos: 0, files: 0, firstName: nil, voices: 1, voiceDurationMs: 42400)
        XCTAssertEqual(L10n.countsLabel(counts), L("voice.preview", ["d": "0:42"]))
        XCTAssertEqual(L10n.countsLabel(.init(count: 3, images: 2, videos: 1, files: 0, firstName: nil)), L("att.media", ["n": 3]))
    }

    func testVoiceWaveformHelpers() {
        XCTAssertEqual(VoiceRules.downsample([]), [])
        XCTAssertEqual(VoiceRules.downsample([0.2, 0.4]), [0.2, 0.4])
        let many = (0..<640).map { Double($0 % 10) / 10 }
        let w = VoiceRules.downsample(many)
        XCTAssertEqual(w.count, 64)
        XCTAssertTrue(w.allSatisfy { $0 >= 0 && $0 <= 1 })
        XCTAssertEqual(w.first, 0.9, "máximo por tramo")
        XCTAssertEqual(VoiceRules.waveformHeader([0, 0.5, 1]), "0.00,0.50,1.00")
        XCTAssertLessThan(VoiceRules.level(db: -160), 0.05)
        XCTAssertEqual(VoiceRules.level(db: 0), 1, accuracy: 0.001)
        XCTAssertGreaterThan(VoiceRules.level(db: -20), VoiceRules.level(db: -40))
        XCTAssertEqual(VoiceRules.maxMs, 900_000)
    }
}
