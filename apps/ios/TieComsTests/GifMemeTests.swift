import XCTest
import ImageIO
import UIKit
import UniformTypeIdentifiers
@testable import TieComs

@MainActor
final class GifMemeTests: XCTestCase {
    private let base = URL(string: "https://mock.chaggu.test")!
    private let itemJSON = #"{"id":"one","provider":"openverse","title":"Hello","previewUrl":"/api/v1/gifs/media?t=preview","url":"/api/v1/gifs/media?t=full","width":80,"height":60,"attribution":"Author · CC BY","sourceUrl":"https://commons.wikimedia.org/wiki/File:Hello.gif"}"#
    private func item() throws -> GifMediaItem { try JSONDecoder().decode(GifMediaItem.self, from: Data(itemJSON.utf8)) }
    private func picture(_ size: CGSize = CGSize(width: 80, height: 60), color: UIColor = .systemBlue) -> UIImage {
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = true
        return UIGraphicsImageRenderer(size: size, format: fmt).image { ctx in color.setFill(); ctx.fill(CGRect(origin: .zero, size: size)) }
    }
    private func gif(count: Int = 2, size: CGSize = CGSize(width: 80, height: 60)) throws -> Data {
        let data = NSMutableData()
        let out = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, count, nil))
        for i in 0..<count {
            let img = picture(size, color: i % 2 == 0 ? .red : .blue)
            CGImageDestinationAddImage(out, try XCTUnwrap(img.cgImage), [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: i % 2 == 0 ? 0.1 : 0.2]] as CFDictionary)
        }
        XCTAssertTrue(CGImageDestinationFinalize(out)); return data as Data
    }
    func testAnimatedGifKeepsFramesAndTiming() throws {
        let bytes = try gif()
        let decoded = try XCTUnwrap(GifAnimation.decode(bytes))
        XCTAssertEqual(decoded.frames.count, 2)
        XCTAssertEqual(decoded.delays, [0.1, 0.2])
        XCTAssertEqual(decoded.duration, 0.3, accuracy: 0.001)
        XCTAssertEqual(decoded.frames[0].size, CGSize(width: 80, height: 60))
        XCTAssertNotEqual(decoded.frames[0].pngData(), decoded.frames[1].pngData())
        XCTAssertEqual(ImagePrep.prepare(bytes, name: "hello.gif", contentType: "image/gif")?.data, bytes)
    }
    func testDecodeLimitsDimensionsAndRejectsStaticAndInvalidBytes() throws {
        let decoded = try XCTUnwrap(GifAnimation.decode(try gif(size: CGSize(width: 800, height: 600)), maxSide: 120))
        XCTAssertEqual(decoded.frames[0].size, CGSize(width: 120, height: 90))
        XCTAssertNil(GifAnimation.decode(try XCTUnwrap(picture().pngData())))
        XCTAssertNil(GifAnimation.decode(Data("invalid".utf8)))
        XCTAssertNil(GifAnimation.decode(try gif(count: 241, size: CGSize(width: 1, height: 1))))
    }
    func testMemeIsLocalJpegWithBoundedAspectAndProvenance() throws {
        let template = picture(CGSize(width: 1600, height: 800))
        let file = try XCTUnwrap(MemeRenderer.attachment(template: template, top: "PRIVATE TOP", bottom: "PRIVATE BOTTOM", item: item()))
        XCTAssertEqual(file.contentType, "image/jpeg"); XCTAssertEqual(file.name, "meme.jpg")
        XCTAssertEqual(file.attribution, "Author · CC BY")
        let image = try XCTUnwrap(UIImage(data: file.data))
        XCTAssertEqual(image.size, CGSize(width: 1280, height: 640))
        XCTAssertFalse(file.tooBig)
        XCTAssertEqual(Array(file.data.prefix(2)), [0xff, 0xd8])
        XCTAssertNotEqual(MemeRenderer.image(template: template, top: "", bottom: "")?.pngData(), MemeRenderer.image(template: template, top: "PRIVATE TOP", bottom: "PRIVATE BOTTOM")?.pngData())
    }
    func testMemeCapsCaptionWithoutChangingCanvas() throws {
        let template = picture(CGSize(width: 320, height: 240))
        let a = try XCTUnwrap(MemeRenderer.image(template: template, top: String(repeating: "A", count: 1000), bottom: ""))
        let b = try XCTUnwrap(MemeRenderer.image(template: template, top: String(repeating: "A", count: 280), bottom: ""))
        XCTAssertEqual(a.size, template.size); XCTAssertEqual(a.pngData(), b.pngData())
    }
    func testProxyOriginGuardAndEncodedQuery() {
        XCTAssertEqual(GifMediaRules.proxyPath("/api/v1/gifs/media?t=a%2Bb%2Fc", base: base), "/api/v1/gifs/media?t=a%2Bb%2Fc")
        XCTAssertEqual(GifMediaRules.proxyPath("https://mock.chaggu.test/api/v1/gifs/media?t=x", base: base), "/api/v1/gifs/media?t=x")
        XCTAssertNil(GifMediaRules.proxyPath("https://evil.test/api/v1/gifs/media?t=x", base: base))
        XCTAssertNil(GifMediaRules.proxyPath("//evil.test/api/v1/gifs/media?t=x", base: base))
        XCTAssertNil(GifMediaRules.proxyPath("/api/v1/gifs/media", base: base))
        XCTAssertNil(GifMediaRules.proxyPath("/api/v1/conversations", base: base))
    }
    func testCatalogQueryRoundTripsSpanishAndCursor() throws {
        let c = try XCTUnwrap(URLComponents(string: GifMediaRules.catalogPath(query: "sí + café &", language: "es", cursor: "a+/=")))
        let params = Dictionary(uniqueKeysWithValues: (c.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(c.path, "/gifs/search"); XCTAssertEqual(params["q"], "sí + café &"); XCTAssertEqual(params["cursor"], "a+/=")
        XCTAssertEqual(params["lang"], "es")
        XCTAssertEqual(URLComponents(string: GifMediaRules.catalogPath(query: "  ", language: "fr"))?.path, "/gifs/trending")
    }
    func testBodyKeepsCaptionOffsetsAndAllAttributionLinks() {
        let body = GifMediaRules.body("@Ana hello", attributions: ["Author · https://commons.wikimedia.org/file · https://creativecommons.org/licenses/by/4.0/", "", "Author · https://commons.wikimedia.org/file · https://creativecommons.org/licenses/by/4.0/"])
        XCTAssertTrue(body.hasPrefix("@Ana hello\n\n"))
        XCTAssertEqual(body.components(separatedBy: "https://commons.wikimedia.org/file").count, 2)
        XCTAssertTrue(body.contains("https://creativecommons.org/licenses/by/4.0/"))
    }
    func testCatalogAndImportUseContractWithoutSendingMessage() async throws {
        MockURLProtocol.routes = [
            "/api/v1/gifs/search": (200, "{\"provider\":\"openverse\",\"items\":[" + itemJSON + "],\"next\":\"next page\",\"poweredBy\":{\"label\":\"Openverse\",\"url\":\"https://openverse.org\"}}"),
            "/api/v1/memes/templates": (200, "{\"provider\":\"memegen\",\"items\":[" + itemJSON + "],\"next\":null,\"poweredBy\":null}"),
            "/api/v1/conversations/c/gifs": (200, #"{"attachment":{"id":"a","name":"hello.gif","contentType":"image/gif","sizeBytes":1024,"url":"/api/v1/attachments/a"},"attribution":"Author · CC BY · https://example.test/source"}"#)
        ]
        MockURLProtocol.requests = []; MockURLProtocol.httpRequests = []
        let api = APIClient(baseURL: base, secrets: MemorySecretStore(), session: MockURLProtocol.session())
        let catalog = try await api.gifCatalog(query: "hola")
        XCTAssertEqual(catalog.next, "next page"); XCTAssertEqual(catalog.items[0].sourceUrl, "https://commons.wikimedia.org/wiki/File:Hello.gif")
        _ = try await api.memeTemplates()
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path.contains("/conversations/") }, "Browsing must never import or send")
        let imported = try await api.importGif("c", item: catalog.items[0])
        XCTAssertEqual(imported.attachment.contentType, "image/gif"); XCTAssertTrue(imported.attribution?.contains("CC BY") == true)
        XCTAssertEqual(MockURLProtocol.requests.last?.body["url"] as? String, catalog.items[0].url)
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path.hasSuffix("/messages") })
    }
    func testViewOnceTransportUsesUncachedSessionAndNeverForwardsBearerToSignedHost() async throws {
        MockURLProtocol.routes = ["/signed.gif": (200, "bytes"), "/api/v1/attachments/a": (200, "private"),
                                  "/api/v1/auth/login": (200, #"{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"fixture"}}"#)]
        MockURLProtocol.httpRequests = []
        let api = APIClient(baseURL: base, secrets: MemorySecretStore(), session: MockURLProtocol.session(), uncachedSession: MockURLProtocol.session())
        _ = try await api.login(email: "fixture@qa.test", password: "fixture")
        let signed = try await api.uncachedDownload("https://signed.media.test/signed.gif")
        XCTAssertEqual(signed, Data("bytes".utf8))
        let request = try XCTUnwrap(MockURLProtocol.httpRequests.last)
        XCTAssertNil(request.value(forHTTPHeaderField: "authorization"))
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(request.value(forHTTPHeaderField: "cache-control"), "no-store")
        let relative = try await api.uncachedDownload("/api/v1/attachments/a")
        XCTAssertEqual(relative, Data("private".utf8))
        XCTAssertEqual(MockURLProtocol.httpRequests.last?.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(MockURLProtocol.httpRequests.last?.url?.host, base.host)
    }
    func testViewOnceGifsAndMemesRemainPhotoOnlyAndUncached() throws {
        let cfg = APIClient.uncachedConfiguration()
        XCTAssertNil(cfg.urlCache); XCTAssertEqual(cfg.requestCachePolicy, .reloadIgnoringLocalCacheData)
        let g = LocalAttachment(name: "a.gif", contentType: "image/gif", data: try gif())
        let m = try XCTUnwrap(MemeRenderer.attachment(template: picture(), top: "private", bottom: "", item: item()))
        XCTAssertTrue(ViewOnceRules.allowed([g, m]))
        XCTAssertFalse(ViewOnceRules.allowed([g, .init(name: "video.mov", contentType: "video/quicktime", data: Data())]))
    }
}
