import AuthenticationServices
import XCTest
@testable import TieComs

@MainActor
private final class FakeAppleAuthorizer: AppleAuthorizing {
    var onAuthorize: ((AppleChallenge) async throws -> AppleAuthorization)?
    var calls = 0
    func authorize(challenge: AppleChallenge) async throws -> AppleAuthorization {
        calls += 1
        if let onAuthorize { return try await onAuthorize(challenge) }
        return AppleAuthorization(userID: "apple-subject", state: challenge.challengeId,
            identityToken: "apple-signed-token", authorizationCode: "one-use-code", fullName: "Ana")
    }
}

@MainActor
private final class FakeAppleCredentialChecker: AppleCredentialChecking {
    var credentialState: ASAuthorizationAppleIDProvider.CredentialState = .authorized
    var failure: Error?
    var onCheck: (() async -> Void)?
    var checked: [String] = []
    func state(for userID: String) async throws -> ASAuthorizationAppleIDProvider.CredentialState {
        checked.append(userID)
        await onCheck?()
        if let failure { throw failure }
        return credentialState
    }
}

private final class ControlledAppleController: ASAuthorizationController {
    var onStart: (() -> Void)?
    var onCancel: (() -> Void)?
    override func performRequests() { onStart?() }
    override func cancel() { onCancel?() }
    func finishCancellation() {
        delegate?.authorizationController?(controller: self, didCompleteWithError: ASAuthorizationError(.canceled))
    }
}

@MainActor
final class AppleSignInTests: XCTestCase {
    private let base = URL(string: "https://apple-auth.mock.test")!
    private let challenge = AppleChallenge(challengeId: "challenge-1", nonce: "server-nonce", expiresAt: "2099-01-01T00:00:00.000Z")
    private let authJSON = #"{"accessToken":"acc-apple","accessExpiresAt":"2099-01-01T00:00:00.000Z","refreshToken":"refresh-apple","sessionId":"s1","user":{"id":"u1","name":"Ana","kind":"human","primaryOrgId":null}}"#
    private let bootstrapJSON = #"{"contract":"2026-09-23","serverTime":"","me":{"id":"u1","name":"Ana","kind":"human","primaryOrgId":null},"organizations":[],"workspaces":[],"conversations":[],"people":[]}"#

    override func setUp() {
        MockURLProtocol.routes = [:]
        MockURLProtocol.requests = []
        MockURLProtocol.httpRequests = []
        let challengeJSON = #"{"challengeId":"challenge-1","nonce":"server-nonce","expiresAt":"2099-01-01T00:00:00.000Z"}"#
        MockURLProtocol.routes[AuthRoutes.base + "/apple/challenge"] = (200, challengeJSON)
        MockURLProtocol.routes[AuthRoutes.base + "/apple/link/challenge"] = (200, challengeJSON)
        MockURLProtocol.routes[AuthRoutes.base + "/apple/complete"] = (200, authJSON)
        MockURLProtocol.routes[AuthRoutes.base + "/apple/link/complete"] = (200, #"{"linked":true}"#)
        MockURLProtocol.routes[AuthRoutes.base + "/login"] = (200, authJSON)
        MockURLProtocol.routes[AuthRoutes.base + "/logout"] = (200, "{}")
        MockURLProtocol.routes["/api/v1/bootstrap"] = (200, bootstrapJSON)
        MockURLProtocol.routes["/api/v1/blocks"] = (200, #"{"userIds":[]}"#)
    }

    private func store(secrets: SecretStore = MemorySecretStore(), identity: SecretStore = MemorySecretStore(),
                       checker: AppleCredentialChecking? = nil) -> AppStore {
        AppStore(baseURL: base, secrets: secrets, outbox: OutboxStore(directory: tempDir()), feedback: nil,
                 session: MockURLProtocol.session(), appleIdentitySecrets: identity, appleCredentialChecker: checker ?? FakeAppleCredentialChecker())
    }

    func testSecureProofHasPKCES256AndUniqueRandomness() throws {
        let a = try AppleProof.generate(), b = try AppleProof.generate()
        XCTAssertEqual(a.verifier.count, 64)
        XCTAssertEqual(a.challenge.count, 43)
        XCTAssertNotEqual(a.verifier, b.verifier)
        XCTAssertEqual(PKCE(verifier: a.verifier).challenge, a.challenge)
        XCTAssertFalse(a.challenge.contains("="))
    }

    func testNativeRequestRequestsOnlyNameEmailAndExactServerNonceAndState() throws {
        let request = try AppleNativeAuthorizer.request(for: challenge)
        XCTAssertEqual(request.requestedScopes, [.fullName, .email])
        XCTAssertEqual(request.state, challenge.challengeId)
        XCTAssertEqual(request.nonce, challenge.nonce)
    }

    func testExpiredOrMalformedChallengeCannotOpenAuthorization() {
        for expiry in ["2020-01-01T00:00:00.000Z", "not-a-date"] {
            XCTAssertThrowsError(try AppleNativeAuthorizer.request(for: AppleChallenge(challengeId: "id", nonce: "nonce", expiresAt: expiry)))
        }
        XCTAssertThrowsError(try AppleNativeAuthorizer.request(for: AppleChallenge(challengeId: "", nonce: "", expiresAt: challenge.expiresAt)))
    }

    func testStateMismatchAndMissingCredentialsRejectedBeforeComplete() async throws {
        let authorizer = FakeAppleAuthorizer()
        let store = store()
        authorizer.onAuthorize = { c in AppleAuthorization(userID: "apple", state: "other", identityToken: "token", authorizationCode: "code", fullName: nil) }
        do { try await store.loginWithApple(authorizer: authorizer); XCTFail("state mismatch must fail") }
        catch { XCTAssertEqual(error as? AppleSignInError, .invalidResponse) }
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path.hasSuffix("/apple/complete") })
        XCTAssertFalse(store.appleSignInBusy)
        let empty = AppleAuthorization(userID: "apple", state: challenge.challengeId, identityToken: "", authorizationCode: "code", fullName: nil)
        XCTAssertThrowsError(try empty.validate(for: challenge))
    }

    func testCancellationHasNoErrorNoSessionAndFlowCanRetry() async throws {
        let authorizer = FakeAppleAuthorizer(), store = store()
        authorizer.onAuthorize = { _ in throw AppleSignInError.cancelled }
        let completed = try await store.loginWithApple(authorizer: authorizer)
        XCTAssertFalse(completed)
        XCTAssertFalse(store.appleSignInBusy)
        XCTAssertNil(store.api.accessToken)
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path.hasSuffix("/apple/complete") })
        authorizer.onAuthorize = nil
        let retried = try await store.loginWithApple(authorizer: authorizer)
        XCTAssertTrue(retried)
        await store.signOutLocally()
    }

    func testLoginSendsProofAndDevicePersistsOnlyScopedIdentityAndUsesNormalSession() async throws {
        let secrets = MemorySecretStore(), identity = MemorySecretStore(), authorizer = FakeAppleAuthorizer()
        let store = store(secrets: secrets, identity: identity)
        let completed = try await store.loginWithApple(orgInviteToken: "invitation", orgName: "ignored", authorizer: authorizer)
        XCTAssertTrue(completed)
        XCTAssertEqual(store.status, .ready)
        XCTAssertEqual(store.me?.id, "u1")
        XCTAssertEqual(secrets.get(), "refresh-apple")
        XCTAssertEqual(AppleSessionIdentity.read(from: identity), AppleSessionIdentity(userID: "u1", appleUserID: "apple-subject"))
        XCTAssertFalse(identity.get()?.contains("token") ?? true)
        XCTAssertFalse(identity.get()?.contains("one-use-code") ?? true)
        let challengeRequest = try XCTUnwrap(MockURLProtocol.requests.last { $0.path.hasSuffix("/apple/challenge") })
        let complete = try XCTUnwrap(MockURLProtocol.requests.last { $0.path.hasSuffix("/apple/complete") })
        XCTAssertEqual(challengeRequest.body["orgInviteToken"] as? String, "invitation")
        XCTAssertNil(challengeRequest.body["orgName"])
        let verifier = try XCTUnwrap(complete.body["codeVerifier"] as? String)
        XCTAssertEqual(challengeRequest.body["codeChallenge"] as? String, PKCE(verifier: verifier).challenge)
        XCTAssertEqual(complete.body["challengeId"] as? String, challenge.challengeId)
        XCTAssertEqual(complete.body["identityToken"] as? String, "apple-signed-token")
        XCTAssertEqual(complete.body["authorizationCode"] as? String, "one-use-code")
        XCTAssertEqual((complete.body["device"] as? [String: Any])?["platform"] as? String, "ios")
        let http = try XCTUnwrap(MockURLProtocol.httpRequests.last { $0.url?.path.hasSuffix("/apple/complete") == true })
        XCTAssertNil(http.value(forHTTPHeaderField: "authorization"))
        XCTAssertEqual(http.value(forHTTPHeaderField: "cache-control"), "no-store")
        await store.signOutLocally()
        XCTAssertNil(identity.get())
        XCTAssertNil(secrets.get())
    }

    func testReturningPrivateEmailUserCanCompleteWithoutNameOrEmail() async throws {
        let api = APIClient(baseURL: base, secrets: MemorySecretStore(), session: MockURLProtocol.session())
        let credential = AppleAuthorization(userID: "stable-private-subject", state: challenge.challengeId, identityToken: "token", authorizationCode: "code", fullName: nil)
        _ = try await api.appleComplete(challenge: challenge, proof: AppleProof.generate(), authorization: credential)
        let complete = try XCTUnwrap(MockURLProtocol.requests.last { $0.path.hasSuffix("/apple/complete") })
        XCTAssertNil(complete.body["email"], "Email must come from the server-verified token, not client input")
        XCTAssertNil(complete.body["fullName"])
    }

    func testServerLinkRequiredDoesNotCreateOrReplaceSession() async throws {
        MockURLProtocol.routes[AuthRoutes.base + "/apple/complete"] = (409, #"{"error":{"code":"apple_link_required","message":"Use your existing method"}}"#)
        let secrets = MemorySecretStore(), identity = MemorySecretStore(), store = store(secrets: secrets, identity: identity)
        do { try await store.loginWithApple(authorizer: FakeAppleAuthorizer()); XCTFail("must not auto-link") }
        catch let error as ApiRequestError { XCTAssertEqual(error.code, "apple_link_required") }
        XCTAssertNil(secrets.get())
        XCTAssertNil(identity.get())
        XCTAssertFalse(store.appleSignInBusy)
    }

    func testLinkingRequiresSessionAndUsesAuthenticatedEndpointsWithoutReplacingTokens() async throws {
        let identity = MemorySecretStore(), secrets = MemorySecretStore(), store = store(secrets: secrets, identity: identity)
        do { try await store.loginWithApple(linking: true, authorizer: FakeAppleAuthorizer()); XCTFail("anonymous link") }
        catch { XCTAssertEqual(error as? AppleSignInError, .unavailable) }
        try await store.login(email: "ana@mock.test", password: "fixture-password")
        let refresh = secrets.get()
        let linked = try await store.loginWithApple(linking: true, authorizer: FakeAppleAuthorizer())
        XCTAssertTrue(linked)
        XCTAssertEqual(secrets.get(), refresh)
        for suffix in ["/apple/link/challenge", "/apple/link/complete"] {
            let request = try XCTUnwrap(MockURLProtocol.httpRequests.last { $0.url?.path.hasSuffix(suffix) == true })
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer acc-apple")
        }
        XCTAssertEqual(AppleSessionIdentity.read(from: identity)?.userID, "u1")
        await store.signOutLocally()
    }

    func testPasswordSignInClearsPreviousAppleIdentity() async throws {
        let identity = MemorySecretStore(), store = store(identity: identity)
        try AppleSessionIdentity(userID: "old-user", appleUserID: "old-apple").save(to: identity)
        try await store.login(email: "ana@mock.test", password: "fixture-password")
        XCTAssertNil(identity.get())
        await store.signOutLocally()
    }

    func testRevokedAndMissingCredentialsClearSessionAndAppleIdentity() async throws {
        for state: ASAuthorizationAppleIDProvider.CredentialState in [.revoked, .notFound] {
            let checker = FakeAppleCredentialChecker(), identity = MemorySecretStore(), secrets = MemorySecretStore()
            checker.credentialState = state
            let store = store(secrets: secrets, identity: identity, checker: checker)
            try await store.loginWithApple(authorizer: FakeAppleAuthorizer())
            await store.verifyAppleCredential()
            XCTAssertEqual(store.status, .anonymous)
            XCTAssertNil(store.me)
            XCTAssertNil(secrets.get())
            XCTAssertNil(identity.get())
            XCTAssertEqual(checker.checked, ["apple-subject"])
        }
    }

    func testTransientCredentialCheckFailureDoesNotSignOut() async throws {
        let checker = FakeAppleCredentialChecker(), identity = MemorySecretStore()
        checker.failure = URLError(.notConnectedToInternet)
        let store = store(identity: identity, checker: checker)
        try await store.loginWithApple(authorizer: FakeAppleAuthorizer())
        await store.verifyAppleCredential()
        XCTAssertEqual(store.status, .ready)
        XCTAssertNotNil(identity.get())
        await store.signOutLocally()
    }

    func testLateRevocationCannotSignOutNewPasswordSession() async throws {
        let checker = FakeAppleCredentialChecker(), identity = MemorySecretStore(), store = store(identity: identity, checker: checker)
        checker.credentialState = .revoked
        try await store.loginWithApple(authorizer: FakeAppleAuthorizer())
        checker.onCheck = { try? await store.login(email: "ana@mock.test", password: "fixture-password") }
        await store.verifyAppleCredential()
        XCTAssertEqual(store.status, .ready)
        XCTAssertNil(identity.get())
        await store.signOutLocally()
    }

    func testLateAuthorizationCannotReplaceChangedSession() async throws {
        let identity = MemorySecretStore(), store = store(identity: identity), authorizer = FakeAppleAuthorizer()
        authorizer.onAuthorize = { challenge in
            try await store.login(email: "ana@mock.test", password: "fixture-password")
            return AppleAuthorization(userID: "apple", state: challenge.challengeId, identityToken: "token", authorizationCode: "code", fullName: nil)
        }
        let completed = try await store.loginWithApple(authorizer: authorizer)
        XCTAssertFalse(completed)
        XCTAssertEqual(store.status, .ready)
        XCTAssertNil(identity.get())
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path.hasSuffix("/apple/complete") })
        await store.signOutLocally()
    }

    func testConcurrentAppleTapIsRejectedAndCancelledFlowResetsBusy() async throws {
        let store = store(), authorizer = FakeAppleAuthorizer()
        authorizer.onAuthorize = { _ in
            do { try await store.loginWithApple(authorizer: FakeAppleAuthorizer()); XCTFail("must not start twice") }
            catch { XCTAssertEqual(error as? AppleSignInError, .alreadyRunning) }
            throw AppleSignInError.cancelled
        }
        let completed = try await store.loginWithApple(authorizer: authorizer)
        XCTAssertFalse(completed)
        XCTAssertFalse(store.appleSignInBusy)
        XCTAssertEqual(authorizer.calls, 1)
    }
    func testFailedSecureIdentityWriteDoesNotLeaveLoggedInSession() async throws {
        final class UnavailableStore: SecretStore {
            func get() -> String? { nil }
            func set(_ value: String?) {}
        }
        let secrets = MemorySecretStore(), store = store(secrets: secrets, identity: UnavailableStore())
        do { try await store.loginWithApple(authorizer: FakeAppleAuthorizer()); XCTFail("must fail closed") }
        catch { XCTAssertEqual(error as? AppleSignInError, .storageUnavailable) }
        XCTAssertNil(secrets.get())
        XCTAssertNil(store.api.accessToken)
        XCTAssertEqual(store.status, .anonymous)
    }

    func testRevocationNotificationTriggersCredentialCheckAndLogout() async throws {
        let checker = FakeAppleCredentialChecker(), identity = MemorySecretStore(), store = store(identity: identity, checker: checker)
        checker.credentialState = .revoked
        try await store.loginWithApple(authorizer: FakeAppleAuthorizer())
        let checked = expectation(description: "Apple revocation is checked")
        checker.onCheck = { checked.fulfill() }
        NotificationCenter.default.post(name: ASAuthorizationAppleIDProvider.credentialRevokedNotification, object: nil)
        await fulfillment(of: [checked], timeout: 3)
        for _ in 0..<100 where store.status != .anonymous { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(store.status, .anonymous)
        XCTAssertEqual(checker.checked, ["apple-subject"])
        XCTAssertNil(identity.get())
    }

    func testColdStartRevocationClearsBeforeBootstrap() async throws {
        let checker = FakeAppleCredentialChecker(), identity = MemorySecretStore(), secrets = MemorySecretStore()
        secrets.set("old-refresh")
        try AppleSessionIdentity(userID: "u1", appleUserID: "apple-subject").save(to: identity)
        checker.credentialState = .notFound
        let store = store(secrets: secrets, identity: identity, checker: checker)
        await store.start()
        XCTAssertEqual(store.status, .anonymous)
        XCTAssertNil(secrets.get())
        XCTAssertNil(identity.get())
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path == "/api/v1/bootstrap" })
    }

    func testNativeCancellationIsRecognizedWithoutDisplayingFailure() {
        XCTAssertTrue(AppleSignInError.isCancellation(ASAuthorizationError(.canceled)))
        XCTAssertFalse(AppleSignInError.isCancellation(ASAuthorizationError(.failed)))
    }

    func testTaskCancellationDismissesNativeSheetAndStaysBusyUntilCallback() async throws {
        let controller = ControlledAppleController(authorizationRequests: [try AppleNativeAuthorizer.request(for: challenge)])
        let started = expectation(description: "native sheet started")
        let cancelled = expectation(description: "native sheet cancelled")
        controller.onStart = { started.fulfill() }
        controller.onCancel = { cancelled.fulfill() }
        let authorizer = AppleNativeAuthorizer(makeController: { _ in controller })
        let task = Task { try await authorizer.authorize(challenge: challenge) }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        await fulfillment(of: [cancelled], timeout: 2)
        XCTAssertNotNil(controller.delegate, "Keep the flow alive until the native sheet confirms cancellation")
        do { _ = try await authorizer.authorize(challenge: challenge); XCTFail("second sheet must not start") }
        catch { XCTAssertEqual(error as? AppleSignInError, .alreadyRunning) }
        controller.finishCancellation()
        do { _ = try await task.value; XCTFail("cancelled task must not return credentials") }
        catch { XCTAssertEqual(error as? AppleSignInError, .cancelled) }
        XCTAssertNil(controller.delegate)
    }

    func testStartupAwaitsAnAlreadyRunningCredentialCheck() async throws {
        let checker = FakeAppleCredentialChecker(), identity = MemorySecretStore(), secrets = MemorySecretStore()
        secrets.set("old-refresh")
        try AppleSessionIdentity(userID: "u1", appleUserID: "apple-subject").save(to: identity)
        checker.credentialState = .revoked
        checker.onCheck = { try? await Task.sleep(nanoseconds: 30_000_000) }
        let store = store(secrets: secrets, identity: identity, checker: checker)
        let foreground = Task { await store.verifyAppleCredential() }
        await Task.yield()
        await store.start()
        await foreground.value
        XCTAssertEqual(checker.checked, ["apple-subject"], "startup and foreground share one Apple check")
        XCTAssertEqual(store.status, .anonymous)
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path == "/api/v1/bootstrap" })
    }

    func testInvalidAppleLinkProofIsNotReplayedAndDoesNotSignOutChagguSession() async throws {
        let secrets = MemorySecretStore(), identity = MemorySecretStore(), store = store(secrets: secrets, identity: identity)
        try await store.login(email: "ana@mock.test", password: "fixture-password")
        let previousRefresh = secrets.get()
        MockURLProtocol.routes[AuthRoutes.base + "/apple/link/complete"] = (401, #"{"error":{"code":"apple_invalid_credential","message":"Apple proof expired"}}"#)
        do { try await store.loginWithApple(linking: true, authorizer: FakeAppleAuthorizer()); XCTFail("invalid proof") }
        catch let error as ApiRequestError { XCTAssertEqual(error.code, "apple_invalid_credential") }
        XCTAssertEqual(store.status, .ready)
        XCTAssertEqual(store.me?.id, "u1")
        XCTAssertEqual(store.api.accessToken, "acc-apple")
        XCTAssertEqual(secrets.get(), previousRefresh)
        XCTAssertNil(identity.get())
        XCTAssertEqual(MockURLProtocol.requests.filter { $0.path.hasSuffix("/apple/link/complete") }.count, 1)
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path == AuthRoutes.refresh })
        await store.signOutLocally()
    }

}
