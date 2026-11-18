import Intents
import XCTest
@testable import TieComs

/// CH038: tocar una llamada de chaggu en «Recientes» de Teléfono vuelve a llamar a ese chat.
final class CH038Tests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "CH038Tests"

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func person(_ handle: String) -> INPerson {
        INPerson(personHandle: INPersonHandle(value: handle, type: .unknown), nameComponents: nil, displayName: handle,
                 image: nil, contactIdentifier: nil, customIdentifier: nil)
    }

    func testRemembersTheChatOfEachName() {
        CallKitRecents.remember("Liliana Garcia", conversationId: "c1", defaults: defaults)
        CallKitRecents.remember("Ventas", conversationId: "g1", defaults: defaults)
        let all = CallKitRecents.load(defaults)
        XCTAssertEqual(all["Liliana Garcia"]?.conversationId, "c1")
        XCTAssertEqual(all["Ventas"]?.conversationId, "g1")
    }

    func testTheLastCallWinsAndEmptyIdsAreIgnored() {
        CallKitRecents.remember("Ana", conversationId: "c1", defaults: defaults)
        CallKitRecents.remember("Ana", conversationId: "c2", defaults: defaults)
        CallKitRecents.remember("Ana", conversationId: "", defaults: defaults)
        XCTAssertEqual(CallKitRecents.load(defaults)["Ana"]?.conversationId, "c2")
    }

    func testKeepsOnlyTheMostRecentNames() {
        let base = Date(timeIntervalSince1970: 0)
        for i in 0..<(CallKitRecents.limit + 5) {
            CallKitRecents.remember("p\(i)", conversationId: "c\(i)", at: base.addingTimeInterval(TimeInterval(i)), defaults: defaults)
        }
        let all = CallKitRecents.load(defaults)
        XCTAssertEqual(all.count, CallKitRecents.limit)
        XCTAssertNil(all["p0"])
        XCTAssertEqual(all["p\(CallKitRecents.limit + 4)"]?.conversationId, "c\(CallKitRecents.limit + 4)")
    }

    func testResolvesTheRememberedChatIfIAmStillInIt() {
        let remembered = ["Ana": CallKitRecents.Entry(conversationId: "c2", at: Date())]
        let chats = [(id: "c1", title: "Ana"), (id: "c2", title: "Ana")]
        XCTAssertEqual(CallKitRecents.resolve("Ana", remembered: remembered, chats: chats), "c2")
        // Ya no estoy en ese chat y hay dos con el mismo nombre: no se adivina.
        XCTAssertNil(CallKitRecents.resolve("Ana", remembered: remembered, chats: [(id: "c1", title: "Ana"), (id: "c3", title: "Ana")]))
    }

    func testOlderRecentsEntriesFallBackToTheOnlyChatWithThatName() {
        let chats = [(id: "c1", title: "Liliana Garcia"), (id: "g1", title: "Ventas")]
        XCTAssertEqual(CallKitRecents.resolve("liliana garcia", remembered: [:], chats: chats), "c1")
        XCTAssertNil(CallKitRecents.resolve("Nadie", remembered: [:], chats: chats))
    }

    func testReadsTheRecentsIntent() {
        let audio = INStartCallIntent(callRecordFilter: nil, callRecordToCallBack: nil, audioRoute: .unknown, destinationType: .normal,
                                      contacts: [person(" Liliana Garcia ")], callCapability: .audioCall)
        let a = NSUserActivity(activityType: "INStartCallIntent")
        a.setValue(INInteraction(intent: audio, response: nil), forKey: "interaction")
        XCTAssertEqual(CallKitRecents.request(a), CallKitRecents.Request(handle: "Liliana Garcia", video: false))

        XCTAssertEqual(CallKitRecents.request([person("Ventas")], video: true), CallKitRecents.Request(handle: "Ventas", video: true))
        XCTAssertNil(CallKitRecents.request([], video: false))
        XCTAssertNil(CallKitRecents.request(NSUserActivity(activityType: "INStartCallIntent")))
    }
}
