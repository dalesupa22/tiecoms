import XCTest
import WebKit
@testable import TieComs

/// Correo en la tarjeta: sin direcciones de imágenes y con los enlaces cortos (web 7b57ff9: test/mail-text.test.ts).
final class MailBodyTextTests: XCTestCase {
    private let banco = "header-logo [http://bancolombia-email-wsuite.s3.amazonaws.com/templates/6071/img/header.png]\n\nHola DANNY,\n\nRealizaste un pago de $120.000.\nVer detalle [https://www.bancolombia.com/personas/alertas?id=1].\n\nfooter_img [https://x.com/a.gif]\nAyuda en https://bancolombia.com/ayuda."

    private func flat(_ parts: [MailBodyText.Part]) -> String {
        parts.map { p -> String in
            switch p { case .text(let t): return t; case .link(_, let label): return "[\(label)]" }
        }.joined()
    }

    func testRemovesImagesAndAlt() {
        XCTAssertEqual(flat(MailBodyText.parts(banco)), "Hola DANNY,\n\nRealizaste un pago de $120.000.\nVer detalle [bancolombia.com].\n\nAyuda en [bancolombia.com].")
    }

    func testKeepsFullHref() {
        let hrefs = MailBodyText.parts(banco).compactMap { p -> String? in if case .link(let h, _) = p { return h }; return nil }
        XCTAssertEqual(hrefs, ["https://www.bancolombia.com/personas/alertas?id=1", "https://bancolombia.com/ayuda"])
    }

    func testSnippet() {
        XCTAssertEqual(MailBodyText.snippet(banco), "Hola DANNY, Realizaste un pago de $120.000. Ver detalle. Ayuda en.")
        XCTAssertEqual(MailBodyText.snippet("Hola, te envío la propuesta"), "Hola, te envío la propuesta")
        XCTAssertEqual(MailBodyText.snippet(""), "")
        XCTAssertEqual(MailBodyText.snippet("logo [https://a.com/logo.png] Pedido <https://tienda.co/p/1> listo"), "logo Pedido listo")
    }

    func testAttributedLinks() {
        let a = MailBodyText.attributed("Ver https://www.tienda.co/pedido/123?x=1 ya")
        XCTAssertEqual(String(a.characters), "Ver tienda.co ↗ ya")
        XCTAssertEqual(a.runs.compactMap(\.link).first?.absoluteString, "https://www.tienda.co/pedido/123?x=1")
    }

    func testHtmlDocument() {
        let doc = MailHTML.document("<p>Hola</p>")
        XCTAssertTrue(doc.contains(#"name="viewport" content="width=device-width"#))
        XCTAssertTrue(doc.contains("img{max-width:100%"))
        XCTAssertTrue(doc.contains("<body><p>Hola</p></body>"))
    }

    /// En el WKWebView: el JavaScript del correo no corre, pero el ajuste de la app sí (mundo .defaultClient) y encoge
    /// un boletín de 600 px al ancho.
    @MainActor
    func testWebViewNoContentScriptsAndFit() async throws {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = false
        let v = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 10), configuration: cfg)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 600))
        window.addSubview(v)
        final class Nav: NSObject, WKNavigationDelegate {
            var done: CheckedContinuation<Void, Never>?
            func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done?.resume(); done = nil }
        }
        let nav = Nav()
        v.navigationDelegate = nav
        await withCheckedContinuation { c in
            nav.done = c
            v.loadHTMLString(MailHTML.document(#"<table width="600" style="width:600px"><tr><td>Hola</td></tr></table><script>document.title='corrió'</script>"#),
                             baseURL: URL(string: "https://app.chaggu.com")!)
        }
        let title = try await v.evaluateJavaScript("document.title", in: nil, contentWorld: .defaultClient) as? String
        XCTAssertNotEqual(title, "corrió")
        let h = try await v.evaluateJavaScript(MailHTML.fitScript, in: nil, contentWorld: .defaultClient) as? NSNumber
        XCTAssertGreaterThan(h?.doubleValue ?? 0, 0)
        let zoom = try await v.evaluateJavaScript("document.documentElement.style.zoom", in: nil, contentWorld: .defaultClient) as? String
        XCTAssertFalse((zoom ?? "").isEmpty, "el boletín ancho debe encogerse")
        withExtendedLifetime(window) {}
    }
}
