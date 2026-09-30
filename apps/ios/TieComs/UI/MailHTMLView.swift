import SwiftUI
import UIKit
import WebKit

/// El correo con su diseño (web 7b57ff9: MailHtml). El API ya quitó scripts y on*; aquí además:
/// JavaScript del correo apagado, sin cookies ni caché persistentes, enlaces a Safari y ancho ajustado
/// (los boletines de 600 px se encogen al ancho de la pantalla). Las rutas relativas (/api/v1/mail/img/…)
/// se resuelven contra el origen del API con `baseURL`.
enum MailHTML {
    static let head = #"<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:"><style>html,body{margin:0;background:#fff;color:#1f1f1f;font:15px/1.45 -apple-system,system-ui,sans-serif;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}body{padding:12px}img{max-width:100%!important;height:auto!important}a{color:#1a5fd6}</style>"#

    static func document(_ html: String) -> String {
        "<!doctype html><html><head>\(head)</head><body>\(html)</body></html>"
    }

    /// Mide el alto y encoge lo que no cabe a lo ancho (lo corre la app en su propio mundo, no el correo).
    static let fitScript = """
    (function(){var r=document.documentElement;r.style.zoom='';var w=window.innerWidth||r.clientWidth;var sw=r.scrollWidth;\
    var z=sw>w+2?w/sw:1;if(z!==1){r.style.zoom=String(z);}var h=document.body?document.body.offsetHeight:r.scrollHeight;\
    return Math.ceil(h*z)+2;})()
    """

    private static let cache = NSCache<NSString, NSString>()
    /// nil = aún no se sabe; "" = el correo no tiene HTML (o falló).
    static func cached(_ id: String) -> String? { cache.object(forKey: id as NSString) as String? }
    static func store(_ id: String, _ html: String?) { cache.setObject((html ?? "") as NSString, forKey: id as NSString) }
}

struct MailHTMLView: UIViewRepresentable {
    let html: String
    var baseURL: URL = MediaURL.base
    @Binding var height: CGFloat

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = false
        cfg.dataDetectorTypes = []
        cfg.allowsInlineMediaPlayback = false
        cfg.mediaTypesRequiringUserActionForPlayback = .all
        let v = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 1), configuration: cfg)
        v.navigationDelegate = context.coordinator
        v.isOpaque = false
        v.backgroundColor = .white
        v.scrollView.isScrollEnabled = false
        v.scrollView.bounces = false
        v.allowsLinkPreview = false
        v.accessibilityIdentifier = "mail.html"
        context.coordinator.load(v, html: html, baseURL: baseURL)
        return v
    }

    func updateUIView(_ v: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.loaded != html { context.coordinator.load(v, html: html, baseURL: baseURL) }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: MailHTMLView
        var loaded: String?
        /// La próxima navegación del marco principal es la del propio correo.
        private var pendingLoad = false
        private var lastWidth: CGFloat = 0
        private var sizeObs: NSKeyValueObservation?
        init(_ p: MailHTMLView) { parent = p }

        func load(_ v: WKWebView, html: String, baseURL: URL) {
            loaded = html
            pendingLoad = true
            v.loadHTMLString(MailHTML.document(html), baseURL: baseURL)
            // Al girar o cambiar el ancho se vuelve a ajustar.
            sizeObs = v.observe(\.frame, options: [.new]) { [weak self] v, _ in
                DispatchQueue.main.async {
                    guard let self, abs(v.frame.width - self.lastWidth) > 1 else { return }
                    self.fit(v)
                }
            }
        }

        func fit(_ v: WKWebView) {
            lastWidth = v.frame.width
            v.evaluateJavaScript(MailHTML.fitScript, in: nil, in: .defaultClient) { [weak self] r in
                guard let self else { return }
                let h: CGFloat
                if case .success(let any) = r, let n = any as? NSNumber { h = CGFloat(truncating: n) }
                else { h = v.scrollView.contentSize.height }
                guard h > 0, abs(h - self.parent.height) > 1 else { return }
                self.parent.height = h
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { fit(webView) }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            // Solo la carga del propio correo (loadHTMLString). Un enlace tocado se abre en Safari; cualquier otra
            // navegación (redirección, marco interno) se corta.
            if action.navigationType == .other, action.targetFrame?.isMainFrame == true, pendingLoad {
                pendingLoad = false
                decisionHandler(.allow); return
            }
            if action.navigationType == .linkActivated, let u = action.request.url,
               ["http", "https", "mailto", "tel"].contains(u.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(u)
            }
            decisionHandler(.cancel)
        }
    }
}
