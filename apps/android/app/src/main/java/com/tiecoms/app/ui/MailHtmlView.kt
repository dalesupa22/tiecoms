package com.tiecoms.app.ui

import android.graphics.Color as AColor
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.viewinterop.AndroidView
import com.tiecoms.app.core.MailText

/*
 * El correo compartido con su diseño (como la web, commit 7b57ff9). El HTML llega limpio del API
 * (GET /mail/shared/:id/html: sin scripts, formularios ni on*); aquí además el WebView va sin JavaScript, sin acceso a
 * archivos, y todo enlace se abre en el navegador. Las imágenes son rutas relativas (/api/v1/mail/img/… firmadas) que
 * se resuelven contra el origen del API con loadDataWithBaseURL.
 */

/** Cache corta en memoria: al volver al correo no se pide otra vez. `null` = sin HTML (o falló): se queda el texto. */
internal object MailHtmlCache {
    private val map = object : LinkedHashMap<String, String?>(16, 0.75f, true) { override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String?>?) = size > 12 }
    @Synchronized fun has(id: String) = map.containsKey(id)
    @Synchronized fun get(id: String) = map[id]
    @Synchronized fun put(id: String, html: String?) { map[id] = html }
}

@Composable
fun MailHtmlView(html: String, baseUrl: String, modifier: Modifier = Modifier) {
    val page = remember(html) { MailText.htmlPage(html) }
    AndroidView(
        modifier = modifier.fillMaxWidth().testTag("mailHtml"),
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                setBackgroundColor(AColor.WHITE)
                isVerticalScrollBarEnabled = false
                settings.apply {
                    javaScriptEnabled = false
                    allowFileAccess = false
                    allowContentAccess = false
                    domStorageEnabled = false
                    setSupportMultipleWindows(false)
                    javaScriptCanOpenWindowsAutomatically = false
                    mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                    loadWithOverviewMode = true
                    useWideViewPort = true
                    builtInZoomControls = false
                    textZoom = 100
                }
                webViewClient = object : WebViewClient() {
                    // Ningún enlace navega dentro del WebView: se abre en el navegador.
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        openUrl(view.context, request.url.toString()); return true
                    }
                }
                tag = page
                loadDataWithBaseURL(baseUrl.trimEnd('/') + "/", page, "text/html", "utf-8", null)
            }
        },
        update = { w -> if (w.tag != page) { w.tag = page; w.loadDataWithBaseURL(baseUrl.trimEnd('/') + "/", page, "text/html", "utf-8", null) } },
        onRelease = { it.stopLoading(); it.destroy() },
    )
}

/** Cuerpo en texto: sin las direcciones de las imágenes y con los enlaces como «dominio ↗» (web: MailText). */
@Composable
fun MailBodyText(text: String, maxLines: Int, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val link = Color(0xFF2F6FDB)
    val annotated = remember(text) {
        buildAnnotatedString {
            MailText.parts(text).forEach { p ->
                when (p) {
                    is MailText.Plain -> append(p.text)
                    is MailText.Link -> withLink(LinkAnnotation.Url(p.href, TextLinkStyles(SpanStyle(color = link, fontWeight = FontWeight.SemiBold, background = link.copy(alpha = 0.08f)))) { openUrl(ctx, p.href) }) {
                        append(p.label + " ↗")
                    }
                }
            }
        }
    }
    Text(annotated, style = MaterialTheme.typography.bodyMedium, maxLines = maxLines, overflow = TextOverflow.Ellipsis, modifier = modifier)
}
