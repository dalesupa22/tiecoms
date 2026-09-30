package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Correo en la tarjeta: sin direcciones de imágenes y con los enlaces cortos (apps/web/test/mail-text.test.ts, 30-sep-2026). */
class MailTextTest {
    private val banco = "header-logo [http://bancolombia-email-wsuite.s3.amazonaws.com/templates/6071/img/header.png]\n\nHola DANNY,\n\nRealizaste un pago de \$120.000.\nVer detalle [https://www.bancolombia.com/personas/alertas?id=1].\n\nfooter_img [https://x.com/a.gif]\nAyuda en https://bancolombia.com/ayuda."

    @Test fun `quita las imagenes y su alt`() {
        val text = MailText.parts(banco).joinToString("") { if (it is MailText.Link) "[${it.label}]" else (it as MailText.Plain).text }
        assertEquals("Hola DANNY,\n\nRealizaste un pago de \$120.000.\nVer detalle [bancolombia.com].\n\nAyuda en [bancolombia.com].", text)
    }

    @Test fun `conserva la direccion completa del enlace`() {
        assertEquals(listOf("https://www.bancolombia.com/personas/alertas?id=1", "https://bancolombia.com/ayuda"),
            MailText.parts(banco).filterIsInstance<MailText.Link>().map { it.href })
    }

    @Test fun `resumen en una linea`() {
        assertEquals("Hola DANNY, Realizaste un pago de \$120.000. Ver detalle. Ayuda en.", MailText.snippet(banco))
        assertEquals("Hola, te envío la propuesta", MailText.snippet("Hola, te envío la propuesta"))
        assertEquals("", MailText.snippet(""))
        assertEquals("Mira", MailText.snippet("Mira <https://example.com/a>"))
    }

    @Test fun `pagina del webview ajustada al ancho`() {
        val page = MailText.htmlPage("<p>Hola</p>")
        assertTrue(page.contains("width=device-width"))
        assertTrue(page.contains("img{max-width:100%"))
        assertTrue(page.contains("<body><p>Hola</p></body>"))
        assertTrue(!page.contains("<script"))
    }
}
