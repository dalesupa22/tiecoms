import XCTest
@testable import TieComs

/// Respuestas simuladas por ruta (el endpoint SSO aún no existe en el API de pruebas).
final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var routes: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var requests: [(path: String, body: [String: Any])] = []
    nonisolated(unsafe) static var httpRequests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        var bodyData = request.httpBody
        if bodyData == nil, let stream = request.httpBodyStream {
            stream.open()
            var d = Data()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            stream.close()
            bodyData = d
        }
        let body = bodyData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        MockURLProtocol.requests.append((path, body))
        MockURLProtocol.httpRequests.append(request)
        let (status, json) = MockURLProtocol.routes[path] ?? (404, #"{"error":{"code":"not_found","message":"no"}}"#)
        let res = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: cfg)
    }
}

@MainActor
final class SSOTests: XCTestCase {
    let base = URL(string: "https://mock.tiecoms.test")!

    override func setUp() {
        MockURLProtocol.routes = [:]
        MockURLProtocol.requests = []
    }

    func testPKCERFC7636Vector() {
        let p = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testPKCEGeneratedVerifier() {
        let a = PKCE.generate(), b = PKCE.generate()
        XCTAssertEqual(a.verifier.count, 64)
        XCTAssertNotEqual(a.verifier, b.verifier)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        XCTAssertTrue(a.verifier.unicodeScalars.allSatisfy(allowed.contains))
        XCTAssertFalse(a.challenge.contains("="))
        XCTAssertEqual(a.challenge.count, 43)
    }

    func testStartURL() throws {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let u = SSOAuthenticator.startURL(base: base, provider: .microsoft, deviceId: "dev-1", pkce: pkce)
        let c = try XCTUnwrap(URLComponents(url: u, resolvingAgainstBaseURL: false))
        XCTAssertEqual(c.path, "\(AuthRoutes.base)/microsoft/start")
        XCTAssertEqual(c.path, "/api/v1/auth/microsoft/start")
        let q = Dictionary(uniqueKeysWithValues: (c.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(q, ["platform": "ios", "device_id": "dev-1", "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "code_challenge_method": "S256", "redirect_scheme": "chaggu"])
        XCTAssertTrue(SSOAuthenticator.startURL(base: base, provider: .google, deviceId: "d", pkce: pkce).path.hasSuffix("/auth/google/start"))
    }

    func testCallbackParsing() {
        XCTAssertEqual(SSOCallback.scheme, "chaggu")
        XCTAssertEqual(SSOCallback.parse(URL(string: "chaggu://auth/callback?code=abc123")!), .code("abc123"))
        XCTAssertEqual(SSOCallback.parse(URL(string: "chaggu://auth/callback?error=access_denied&message=Cuenta%20no%20permitida")!),
                       .error(code: "access_denied", message: "Cuenta no permitida"))
        XCTAssertEqual(SSOCallback.parse(URL(string: "chaggu://auth/callback?error=x")!), .error(code: "x", message: nil))
        XCTAssertEqual(SSOCallback.parse(URL(string: "chaggu://auth/callback")!), nil)
        XCTAssertNil(SSOCallback.parse(URL(string: "chaggu://c/abc")!))
        XCTAssertNil(SSOCallback.parse(URL(string: "https://app.chaggu.com/auth/callback?code=x")!))
        XCTAssertNil(SSOCallback.parse(URL(string: "otra://auth/callback?code=x")!))
        // El esquema anterior se sigue entendiendo por si el backend no recibe redirect_scheme.
        XCTAssertEqual(SSOCallback.parse(URL(string: "tiecoms://auth/callback?code=abc123")!), .code("abc123"))
    }

    func testDeepLinkRouterIgnoresAuthHost() {
        for scheme in ["chaggu", "tiecoms"] {
            XCTAssertNil(DeepLink.parse(URL(string: "\(scheme)://auth/callback?code=abc")!))
            XCTAssertNil(DeepLink.parse(URL(string: "\(scheme)://auth/c/abc")!))
            XCTAssertTrue(SSOCallback.isReserved(URL(string: "\(scheme)://auth/whatever")!))
            XCTAssertFalse(SSOCallback.isReserved(URL(string: "\(scheme)://c/abc")!))
        }
        XCTAssertFalse(SSOCallback.isReserved(URL(string: "otra://auth/x")!))
    }

    private let authJSON = #"{"accessToken":"acc","accessExpiresAt":"2099-01-01T00:00:00.000Z","refreshToken":"ref-sso","sessionId":"s1","user":{"id":"u1","name":"Ana","kind":"human","primaryOrgId":null}}"#
    private let bootstrapJSON = #"{"contract":"2026-09-23","serverTime":"","me":{"id":"u1","name":"Ana","kind":"human","primaryOrgId":null},"organizations":[],"workspaces":[],"conversations":[],"people":[]}"#

    func testExchangeSendsCodeVerifierAndDevice() async throws {
        MockURLProtocol.routes["/api/v1/auth/sso/exchange"] = (200, authJSON)
        let secrets = MemorySecretStore()
        let api = APIClient(baseURL: base, secrets: secrets, session: MockURLProtocol.session())
        let r = try await api.ssoExchange(code: "one-time", verifier: "v".padding(toLength: 64, withPad: "v", startingAt: 0))
        XCTAssertEqual(r.user.id, "u1")
        XCTAssertEqual(secrets.get(), "ref-sso", "el refresh del SSO se guarda igual que en login")
        XCTAssertEqual(api.accessToken, "acc")
        let req = try XCTUnwrap(MockURLProtocol.requests.last)
        XCTAssertEqual(req.path, AuthRoutes.ssoExchange)
        XCTAssertEqual(req.body["code"] as? String, "one-time")
        XCTAssertEqual((req.body["code_verifier"] as? String)?.count, 64)
        let device = try XCTUnwrap(req.body["device"] as? [String: Any])
        XCTAssertEqual(device["platform"] as? String, "ios")
        XCTAssertEqual(device["contract"] as? String, Contract.version)
        XCTAssertNotNil(device["deviceId"] as? String)
        XCTAssertNotNil(device["name"] as? String)
    }

    func testExchangeErrorIsReadable() async {
        MockURLProtocol.routes["/api/v1/auth/sso/exchange"] = (400, #"{"error":{"code":"bad_request","message":"Código vencido"}}"#)
        let api = APIClient(baseURL: base, secrets: MemorySecretStore(), session: MockURLProtocol.session())
        do {
            _ = try await api.ssoExchange(code: "viejo", verifier: "x")
            XCTFail("debería fallar")
        } catch let e as ApiRequestError {
            XCTAssertEqual(e.status, 400)
            XCTAssertEqual(e.message, "Código vencido")
        } catch { XCTFail("\(error)") }
    }

    func testCompleteSSOLeavesStoreReady() async throws {
        MockURLProtocol.routes["/api/v1/auth/sso/exchange"] = (200, authJSON)
        MockURLProtocol.routes["/api/v1/bootstrap"] = (200, bootstrapJSON)
        MockURLProtocol.routes["/api/v1/blocks"] = (200, #"{"userIds":[]}"#)
        let store = AppStore(baseURL: base, secrets: MemorySecretStore(), outbox: OutboxStore(directory: tempDir()), feedback: nil,
                             session: MockURLProtocol.session())
        try await store.completeSSO(code: "c", verifier: "v")
        XCTAssertEqual(store.status, .ready)
        XCTAssertEqual(store.me?.id, "u1")
        store.socket.disconnect()
    }
}
