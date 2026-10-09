import XCTest
import UIKit
import AVFoundation
@testable import TieComs

@MainActor final class NightContractTests: XCTestCase {
    func testLegacyAndDoubleBoldKeepUTF16MentionOffsets() throws {
        let raw = "👩🏽‍💻 **Hola** *mundo* `@gg https://example.test/a`"
        XCTAssertEqual(MessageFormat.display(raw), "👩🏽‍💻 Hola mundo @gg https://example.test/a")
        let inline = try XCTUnwrap(MessageFormat.parse(raw).first(where: { $0.kind == .code }))
        let rich = RichText.bubble(raw, mentions: [], mine: false, linkify: true)
        let codeStart = MessageFormat.map(inline.inner, hidden: MessageFormat.hiddenOffsets(RichText.formatSpans(raw, mentions: []))).location
        XCTAssertNil(rich.attribute(.link, at: codeStart + 7, effectiveRange: nil))
    }
    func testFencedCodeIsLiteralAndCopyDoesNotContainFences() throws {
        let raw = "**antes**\n```swift\n- literal\n@gg https://example.test/a\nlet emoji = \"👋\"\n```\ndespués"
        let block = try XCTUnwrap(CodeMessages.blocks(raw).first)
        XCTAssertEqual(block.language, "swift")
        XCTAssertEqual(block.code, "- literal\n@gg https://example.test/a\nlet emoji = \"👋\"\n")
        XCTAssertEqual(MessageFormat.bullets(raw), raw)
        XCTAssertEqual(MessageFormat.spans(in: raw).map(\.kind), [.bold])
        XCTAssertTrue(CodeMessages.blocks("```swift\nno closing fence").isEmpty)
    }
    func testListComposerMovesMentionTokensWithoutSplittingUnicode() throws {
        let raw = "👋 hola\n@Ana revisa"
        let start = (raw as NSString).range(of: "@Ana").location
        let result = try XCTUnwrap(MessageFormat.compose(raw, selection: NSRange(location: 0, length: raw.utf16.count), command: "numbered", mentions: [Mention(userId: "ana", start: start, length: 4)]))
        XCTAssertEqual(result.text, "1. 👋 hola\n2. @Ana revisa")
        XCTAssertEqual(result.mentions.first?.start, start + 6)
    }
    func testProvenanceIsExactAndTypedCaptionIsPreserved() throws {
        let json = #"{"id":"a","name":"hello.gif","contentType":"IMAGE/GIF; charset=binary","sizeBytes":20,"url":"/api/v1/attachments/a","provenance":{"version":1,"provider":"openverse","title":"Hello","attribution":"GIF: Author · CC0","sourceUrl":"https://example.test/a"}}"#
        let attachment = try JSONDecoder().decode(AttachmentDTO.self, from: Data(json.utf8))
        XCTAssertTrue(attachment.isGif)
        XCTAssertEqual(MessageCopy.body("GIF: Author · CC0", attachments: [attachment]), "")
        XCTAssertEqual(MessageCopy.body("Comentario\n\nGIF: Author · CC0", attachments: [attachment]), "Comentario\n\nGIF: Author · CC0")
        XCTAssertEqual(MessageCopy.body("GIF: escrito por mí", attachments: [attachment]), "GIF: escrito por mí")
        let message = try JSONDecoder().decode(MessageDTO.self, from: Data(#"{"id":"m","body":"Comentario\n\nCréditos","displayBody":"Comentario"}"#.utf8))
        XCTAssertEqual(message.visibleBody, "Comentario")
    }
    func testLongTextFileIsLosslessAndDraftRoundTrips() throws {
        let text = "  👩🏽‍💻\r\n" + String(repeating: "línea\n", count: 1500) + "FIN\n"
        let file = try XCTUnwrap(LongMessageRules.attachment(text))
        XCTAssertEqual(file.data, Data(text.utf8))
        XCTAssertEqual(file.sourceText, text)
        XCTAssertNil(LongMessageRules.attachment(String(repeating: "a", count: LongMessageRules.maxBytes + 1)))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try DraftStorage.save(ComposerDraft(text: "borrador", mentions: [], files: [file], gifs: [], voice: VoiceDraft(data: Data([1,2,3]), durationMs: 500, waveform: [0.5], replyTo: nil, topicId: "topic-a", viewOnce: false, aiConsent: false)), to: url)
        let saved = try XCTUnwrap(DraftStorage.load(url))
        XCTAssertEqual(saved.files.first?.data, file.data)
        XCTAssertEqual(saved.voice?.topicId, "topic-a")
        XCTAssertFalse(saved.voice?.aiConsent ?? true)
        XCTAssertNotEqual(DraftStorage.url(server: "https://qa.test", account: "ana", conversation: "c"), DraftStorage.url(server: "https://qa.test", account: "bruno", conversation: "c"))
    }
    func testThreeAssigneesAreDecodedAndMineIncludesCorresponsables() throws {
        let issue = try JSONDecoder().decode(IssueDTO.self, from: Data(#"{"id":"i","ownerId":"a","assigneeIds":["a","b","c"],"status":"open","title":"Revisión"}"#.utf8))
        XCTAssertEqual(issue.assignedIds, ["a", "b", "c"])
        XCTAssertEqual(IssueTree.filter([issue], .mine, me: "c").count, 1)
        let legacy = try JSONDecoder().decode(IssueDTO.self, from: Data(#"{"id":"i","ownerId":"a","status":"open"}"#.utf8))
        XCTAssertEqual(legacy.assignedIds, ["a"])
    }
    func testSharedWhatsAppKeepsCanonicalDestinationAttachment() throws {
        let raw = #"{"id":"s","provider":"whatsapp","conversationId":"target","chagguAttachments":[{"id":"a","name":"voice.ogg","kind":"voice","contentType":"audio/ogg","durationMs":1230,"url":"/api/v1/attachments/a","sizeBytes":20}],"mediaStatus":"ready"}"#
        let shared = try JSONDecoder().decode(SharedMailDTO.self, from: Data(raw.utf8))
        XCTAssertEqual(shared.chagguAttachments.first?.durationMs, 1230)
        XCTAssertTrue(shared.chagguAttachments.first?.isVoice == true)
        XCTAssertEqual(shared.chagguAttachments.first?.url, "/api/v1/attachments/a")
    }
    func testAvailabilityUnknownIsNotOnlineAndSilenceExpires() {
        XCTAssertFalse(AvailabilityDTO(mode: nil, until: nil, silent: false, revision: 0).active)
        XCTAssertFalse(AvailabilityDTO(mode: "focus", until: ISODate.string(Date().addingTimeInterval(-1)), silent: true, revision: 1).effectiveSilent)
        XCTAssertTrue(AvailabilityDTO(mode: "focus", until: ISODate.string(Date().addingTimeInterval(300)), silent: true, revision: 2).effectiveSilent)
    }
    func testReadRevisionDecodesExplicitLoweringAndLegacyStillDecodes() throws {
        let revised = try JSONDecoder().decode(AccountEvent.self, from: Data(#"{"type":"me.read","conversationId":"c","lastReadSeq":4,"readRevision":9}"#.utf8))
        XCTAssertEqual(revised, .readUpdated(conversationId: "c", seq: 4, revision: 9))
        let legacy = try JSONDecoder().decode(AccountEvent.self, from: Data(#"{"type":"read.updated","conversationId":"c","seq":7}"#.utf8))
        XCTAssertEqual(legacy, .readUpdated(conversationId: "c", seq: 7, revision: nil))
    }
    func testDraftReservationRejectsLateStaleSave() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let old = DraftStorage.reserve(url), recent = DraftStorage.reserve(url)
        let empty = ComposerDraft(text: "", mentions: [], files: [], gifs: [], voice: nil)
        var newer = empty; newer.text = "actual 👋"
        var stale = empty; stale.text = "antiguo"
        try DraftStorage.save(newer, to: url, generation: recent)
        try DraftStorage.save(stale, to: url, generation: old)
        XCTAssertEqual(DraftStorage.load(url)?.text, newer.text)
        let cleared = DraftStorage.reserve(url)
        try DraftStorage.save(empty, to: url, generation: cleared)
        try DraftStorage.save(stale, to: url, generation: recent)
        XCTAssertNil(DraftStorage.load(url))
    }
    func testThreeAssigneesRoundTripThroughCreateEditChildAndReload() async throws {
        let store = try ControlledURLProtocol.store(user: "a")
        let bootstrap = try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"{"me":{"id":"a","name":"QA","kind":"human"},"people":[],"conversations":[{"id":"c","kind":"group","memberIds":["a","b","c"]}]}"#.utf8))
        store.seedForTesting(bootstrap)
        let issue = #"{"id":"i","conversationId":"c","ownerId":"a","assigneeIds":["a","b","c"],"status":"open","title":"QA"}"#
        var bodies: [[String: Any]] = []
        ControlledURLProtocol.handler = { request in
            if request.request.httpMethod == "GET" { request.respond("{\"issues\":[" + issue + "]}") }
            else { bodies.append(request.json); request.respond(issue) }
        }
        defer { ControlledURLProtocol.handler = nil }
        let created = try await store.createIssue(conversationId: "c", title: "QA", ownerId: "a", dueDate: nil, originMessageId: nil, assigneeIds: ["c", "a", "b", "b"])
        XCTAssertEqual(created.assignedIds.count, 3)
        _ = try await store.updateIssue("i", ["assigneeIds": ["a", "b", "c"]])
        _ = try await store.createChildIssue("i", title: "QA hija", ownerId: "a", visibility: .all, assigneeIds: ["c", "a", "b"])
        XCTAssertEqual(bodies.count, 3)
        for body in bodies { XCTAssertEqual(Set(body["assigneeIds"] as? [String] ?? []), Set(["a", "b", "c"])) }
        let reloaded = try await store.loadIssues()
        XCTAssertEqual(reloaded.first?.assignedIds.count, 3)
        XCTAssertEqual(store.myOpenIssues, 1)
        XCTAssertEqual(IssueTree.sections(reloaded, by: .person, me: "a", title: { $0 }).count, 3)
        XCTAssertNotEqual(ScopedPreference.key(server: "qa", account: "a", purpose: "issues"), ScopedPreference.key(server: "qa", account: "b", purpose: "issues"))
    }

    func testCopyWholeMessageKeepsAllUnicodeCodeAndLineBreaks() throws {
        let store = try ControlledURLProtocol.store(user: "qa")
        let original = String(repeating: "👩🏽‍💻 línea\n", count: 1000) + "```swift\nprint(\"fin\")\n```\nFIN"
        MessageCopy.write(original, store: store)
        XCTAssertEqual(UIPasteboard.general.string, original)
        XCTAssertEqual(store.toast, L("toast.copied"))
    }
    func testCopyImageDownloadsAuthorizedPixelsAndFailureDoesNotPretendSuccess() async throws {
        let store = try ControlledURLProtocol.store(user: "qa")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 8)).image { ctx in UIColor.orange.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 12, height: 8)) }
        let png = try XCTUnwrap(image.pngData())
        let attachment = AttachmentDTO(id: "qa-image", name: "qa.png", contentType: "image/png", sizeBytes: png.count, url: "/attachments/qa-image")
        ControlledURLProtocol.handler = { request in
            XCTAssertEqual(request.request.url?.path, "/api/v1/attachments/qa-image")
            request.respondBytes(png)
        }
        defer { ControlledURLProtocol.handler = nil }
        UIPasteboard.general.items = []
        await ImageClipboard.copy(attachment, store: store)
        XCTAssertTrue(UIPasteboard.general.hasImages)
        XCTAssertNotNil(UIPasteboard.general.image)
        XCTAssertEqual(store.toast, L("copy.imageDone"))
        ControlledURLProtocol.handler = { $0.respond(403, #"{"error":{"code":"forbidden","message":"QA denied"}}"#) }
        store.toast = nil; UIPasteboard.general.items = []
        await ImageClipboard.copy(attachment, store: store)
        XCTAssertFalse(UIPasteboard.general.hasImages)
        XCTAssertNotEqual(store.toast, L("copy.imageDone"))
    }

    func testHeldVoiceDownloadCannotTakeAudioSessionAfterCallStarts() async throws {
        let store = try ControlledURLProtocol.store(user: "qa")
        let player = VoicePlayer.shared
        var available = true
        player.canUseAudio = { available }
        player.setScope(server: "https://qa.test", account: UUID().uuidString)
        let started = expectation(description: "voice download retained")
        var held: ControlledURLProtocol?
        ControlledURLProtocol.handler = { request in Task { @MainActor in held = request; started.fulfill() } }
        defer { ControlledURLProtocol.handler = nil; player.resetScope(); player.canUseAudio = { true } }
        let attachment = AttachmentDTO(id: UUID().uuidString, name: "voice.m4a", contentType: "audio/mp4", sizeBytes: 20, url: "/attachments/" + UUID().uuidString)
        let work = Task { await player.toggle(attachment, api: store.api) }
        await fulfillment(of: [started], timeout: 2)
        available = false
        let category = AVAudioSession.sharedInstance().category
        held?.respondBytes(Data([1, 2, 3]))
        await work.value
        XCTAssertNil(player.currentId)
        XCTAssertFalse(player.playing)
        XCTAssertEqual(player.lastError, L("voice.callBusy"))
        XCTAssertEqual(AVAudioSession.sharedInstance().category, category)
    }

    func testVoiceHeardStateIsScopedToServerAndAccount() {
        let player = VoicePlayer.shared, account = UUID().uuidString
        let key = ScopedPreference.key(server: "qa", account: account, purpose: "voice.heard")
        defer { player.resetScope(); UserDefaults.standard.removeObject(forKey: key) }
        player.setScope(server: "qa", account: account); player.markHeard("shared-id")
        XCTAssertTrue(player.heard.contains("shared-id"))
        player.setScope(server: "qa", account: account + "-other")
        XCTAssertFalse(player.heard.contains("shared-id"))
        player.setScope(server: "qa", account: account)
        XCTAssertTrue(player.heard.contains("shared-id"))
        player.resetScope(); XCTAssertTrue(player.heard.isEmpty)
    }

    func testCompoundFiltersSeparateCompletedCancelledAndMultipleAssignees() throws {
        func issue(_ id: String, _ status: String, _ people: String, parent: String = "") throws -> IssueDTO {
            try JSONDecoder().decode(IssueDTO.self, from: Data("{\"id\":\"\(id)\",\"status\":\"\(status)\",\"assigneeIds\":\(people),\"parentIssueId\":\"\(parent)\"}".utf8))
        }
        let mine = try issue("mine", "open", "[\"me\",\"lorena\"]")
        let done = try issue("done", "done", "[\"lorena\"]")
        let cancelled = try issue("cancelled", "cancelled", "[\"lorena\"]")
        let child = try issue("child", "done", "[\"me\"]", parent: "mine")
        let items = [mine, done, cancelled, child, mine]
        XCTAssertEqual(IssueTaskFilter().apply(items, me: "me").map(\.id), ["mine"])
        var filter = IssueTaskFilter(assignees: ["lorena"], statuses: [.done])
        XCTAssertEqual(filter.apply(items, me: "me").map(\.id), ["done"])
        filter.assignees.insert(IssueTaskFilter.me)
        XCTAssertEqual(filter.apply(items, me: "me").map(\.id), ["done", "child"])
        filter.statuses.insert(.cancelled)
        XCTAssertEqual(filter.apply(items, me: "me").map(\.id), ["done", "cancelled", "child"])
        XCTAssertEqual(IssueTasks.tops(filter.apply(items, me: "me"), Dictionary(uniqueKeysWithValues: [mine, done, cancelled, child].map { ($0.id, $0) })).map(\.id), ["done", "cancelled", "child"], "A matching child stays visible even if its parent does not match")
    }

    func testGgRecalculationIsThrottledAndPurgedWithSource() {
        let center = GgSideCenter(), now = Date()
        XCTAssertTrue(center.beginRecalculation("c:one", now: now))
        XCTAssertFalse(center.beginRecalculation("c:one", now: now.addingTimeInterval(20)))
        XCTAssertTrue(center.beginRecalculation("c:two", now: now))
        XCTAssertTrue(center.beginRecalculation("c:one", now: now.addingTimeInterval(601)))
        center.purge { $0 == "c:one" }
        XCTAssertTrue(center.beginRecalculation("c:one", now: now))
        center.reset()
        XCTAssertTrue(center.beginRecalculation("c:two", now: now))
    }

    func testTaskPaginationDeduplicatesAndKeepsLiveUpdatesAndRevocations() async throws {
        let store = try ControlledURLProtocol.store(user: "a")
        let bootstrap = try JSONDecoder().decode(BootstrapDTO.self, from: Data(#"{"me":{"id":"a","name":"QA","kind":"human"},"conversations":[{"id":"c","kind":"group","memberIds":["a"]}]}"#.utf8))
        store.seedForTesting(bootstrap)
        var pages = 0
        ControlledURLProtocol.handler = { request in
            pages += 1
            if pages == 1 {
                request.respond(#"{"issues":[{"id":"old","conversationId":"c","status":"open"},{"id":"hidden","conversationId":"c","status":"open"}],"nextOffset":200}"#)
            } else {
                store.issueLiveRevisions["hidden", default: 0] += 1
                store.issueLiveRevisions["old", default: 0] += 1
                store.issues["old"] = try! JSONDecoder().decode(IssueDTO.self, from: Data(#"{"id":"old","conversationId":"c","status":"done"}"#.utf8))
                request.respond(#"{"issues":[{"id":"old","conversationId":"c","status":"open"},{"id":"new","conversationId":"c","status":"done"}],"nextOffset":null}"#)
            }
        }
        defer { ControlledURLProtocol.handler = nil }
        let rows = try await store.loadIssues()
        XCTAssertEqual(pages, 2)
        XCTAssertEqual(rows.map(\.id), ["old", "new"])
        XCTAssertEqual(store.issues["old"]?.status, .done)
        XCTAssertNil(store.issues["hidden"])
    }

}


private extension ControlledURLProtocol {
    func respondBytes(_ data: Data) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["content-type": "image/png"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
