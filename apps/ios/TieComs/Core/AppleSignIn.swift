import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

struct AppleChallenge: Decodable, Equatable {
    let challengeId: String
    let nonce: String
    let expiresAt: String

    func validate(now: Date = Date()) throws {
        guard !challengeId.isEmpty, !nonce.isEmpty,
              let expiry = ISODate.parse(expiresAt), expiry > now else { throw AppleSignInError.expiredChallenge }
    }
}

struct AppleAuthorization: Equatable {
    let userID: String
    let state: String?
    let identityToken: String
    let authorizationCode: String
    let fullName: String?

    func validate(for challenge: AppleChallenge, now: Date = Date()) throws {
        try challenge.validate(now: now)
        guard state == challenge.challengeId, !userID.isEmpty,
              !identityToken.isEmpty, !authorizationCode.isEmpty else { throw AppleSignInError.invalidResponse }
    }

    func completionBody(challenge: AppleChallenge, proof: PKCE, device: [String: Any]) -> [String: Any] {
        var body: [String: Any] = ["challengeId": challenge.challengeId, "codeVerifier": proof.verifier,
            "identityToken": identityToken, "authorizationCode": authorizationCode, "device": device]
        if let name = fullName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            body["fullName"] = String(name.prefix(120))
        }
        return body
    }
}

enum AppleSignInError: Error, Equatable, LocalizedError {
    case cancelled, alreadyRunning, randomUnavailable, expiredChallenge, invalidResponse, unavailable, storageUnavailable
    var errorDescription: String? { L("err.apple_signin_failed") }

    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError || (error as? AppleSignInError) == .cancelled { return true }
        return (error as? ASAuthorizationError)?.code == .canceled
    }
}

enum AppleProof {
    static func generate() throws -> PKCE {
        var bytes = [UInt8](repeating: 0, count: 48)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw AppleSignInError.randomUnavailable
        }
        return PKCE(verifier: PKCE.base64url(Data(bytes)))
    }
}

@MainActor
protocol AppleAuthorizing: AnyObject {
    func authorize(challenge: AppleChallenge) async throws -> AppleAuthorization
}

/// Apple's native sheet; only name and email are requested. Neither credential is logged or persisted.
@MainActor
final class AppleNativeAuthorizer: NSObject, AppleAuthorizing, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<AppleAuthorization, Error>?
    private var controller: ASAuthorizationController?
    private var flowID: UUID?
    private let makeController: ([ASAuthorizationRequest]) -> ASAuthorizationController

    init(makeController: @escaping ([ASAuthorizationRequest]) -> ASAuthorizationController = { ASAuthorizationController(authorizationRequests: $0) }) {
        self.makeController = makeController
        super.init()
    }

    static func request(for challenge: AppleChallenge) throws -> ASAuthorizationAppleIDRequest {
        try challenge.validate()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.state = challenge.challengeId
        request.nonce = challenge.nonce
        return request
    }

    func authorize(challenge: AppleChallenge) async throws -> AppleAuthorization {
        guard continuation == nil else { throw AppleSignInError.alreadyRunning }
        let request = try Self.request(for: challenge)
        let flowID = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                self.flowID = flowID
                let controller = makeController([request])
                self.controller = controller
                controller.delegate = self
                controller.presentationContextProvider = self
                controller.performRequests()
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard self?.flowID == flowID else { return }
                // Keep the in-flight continuation and busy state until Apple's cancellation callback.
                self?.controller?.cancel()
            }
        }
    }

    private func finish(_ result: Result<AppleAuthorization, Error>) {
        let current = continuation
        continuation = nil
        flowID = nil
        controller?.delegate = nil
        controller = nil
        current?.resume(with: result)
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard controller === self.controller else { return }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let token = credential.identityToken.flatMap({ String(data: $0, encoding: .utf8) }),
              let code = credential.authorizationCode.flatMap({ String(data: $0, encoding: .utf8) }) else {
            finish(.failure(AppleSignInError.invalidResponse)); return
        }
        let name = credential.fullName.map { PersonNameComponentsFormatter().string(from: $0) }
        finish(.success(AppleAuthorization(userID: credential.user, state: credential.state,
            identityToken: token, authorizationCode: code, fullName: name)))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard controller === self.controller else { return }
        finish(.failure(AppleSignInError.isCancellation(error) ? AppleSignInError.cancelled : AppleSignInError.unavailable))
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

struct AppleSessionIdentity: Codable, Equatable {
    let userID: String
    let appleUserID: String

    static func read(from store: SecretStore) -> AppleSessionIdentity? {
        guard let value = store.get(), let data = value.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
    func save(to store: SecretStore) throws {
        guard let value = String(data: try JSONEncoder().encode(self), encoding: .utf8) else { throw AppleSignInError.storageUnavailable }
        store.set(value)
        guard Self.read(from: store) == self else { throw AppleSignInError.storageUnavailable }
    }
}

/// Separate app-only Keychain entry, device-bound, with no plaintext debug fallback or extension sharing.
final class AppleIdentitySecretStore: SecretStore {
    private let account: String
    init(apiURL: URL) { account = KeychainSecretStore.account(for: apiURL) }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.chaggu.app.apple-identity",
         kSecAttrAccount as String: account]
    }
    func get() -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    func set(_ value: String?) {
        SecItemDelete(query as CFDictionary)
        guard let data = value?.data(using: .utf8) else { return }
        var query = query
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        _ = SecItemAdd(query as CFDictionary, nil)
    }
}

@MainActor
protocol AppleCredentialChecking {
    func state(for userID: String) async throws -> ASAuthorizationAppleIDProvider.CredentialState
}

struct AppleCredentialChecker: AppleCredentialChecking {
    func state(for userID: String) async throws -> ASAuthorizationAppleIDProvider.CredentialState {
        try await withCheckedThrowingContinuation { continuation in
            ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userID) { state, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: state) }
            }
        }
    }
}

/// Retains one observer per store and releases it with the store.
final class AppleCredentialObserver {
    private let token: NSObjectProtocol
    init(onRevoked: @escaping @MainActor () -> Void) {
        token = NotificationCenter.default.addObserver(forName: ASAuthorizationAppleIDProvider.credentialRevokedNotification,
            object: nil, queue: .main) { _ in Task { @MainActor in onRevoked() } }
    }
    deinit { NotificationCenter.default.removeObserver(token) }
}
