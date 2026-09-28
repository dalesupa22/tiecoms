package com.tiecoms.app.core

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Firmar PDFs: geometría de las marcas (vista → proporciones de página, también girada), recorte y umbral de imagen. */
class SigningTest {
    private val eps = 1e-4f
    private val letter = PageSize(612f, 792f)
    private fun mark(id: String = "m1", page: Int = 1, x: Float = 0.1f, y: Float = 0.1f, w: Float = 0.2f, h: Float = 0.05f, kind: MarkKind = MarkKind.SIGNATURE, group: String? = null) =
        SignMark(id, kind, page, x, y, w, h, signatureId = "s1", group = group)

    // ---------- Geometría ----------
    @Test fun `pagina girada 90 intercambia ancho y alto`() {
        assertEquals(PageSize(792f, 612f), Signing.displaySize(612f, 792f, 90))
        assertEquals(PageSize(792f, 612f), Signing.displaySize(612f, 792f, 270))
        assertEquals(PageSize(792f, 612f), Signing.displaySize(612f, 792f, -90))
        assertEquals(PageSize(612f, 792f), Signing.displaySize(612f, 792f, 180))
        assertEquals(PageSize(612f, 792f), Signing.displaySize(612f, 792f, 0))
    }

    @Test fun `punto de pantalla a proporciones de la pagina`() {
        // Página de 1000×1294 px con la esquina en (12, 300) de la pantalla.
        val r = PxRect(12f, 300f, 1012f, 1594f)
        val (x, y) = Signing.viewToPage(512f, 947f, r)
        assertEquals(0.5f, x, eps); assertEquals(0.5f, y, eps)
        val (x0, y0) = Signing.viewToPage(12f, 300f, r)
        assertEquals(0f, x0, eps); assertEquals(0f, y0, eps)
    }

    @Test fun `en pagina girada la proporcion es la de la pagina como se ve y el servidor la lleva a su sitio`() {
        // Página 3 del contrato: MediaBox 612×792 con /Rotate 90 → se ve apaisada 792×612.
        val shown = Signing.displaySize(612f, 792f, 90)
        val screenW = 1000f; val screenH = screenW * shown.h / shown.w // 772,7 px de alto
        val r = PxRect(0f, 0f, screenW, screenH)
        // Firma arriba a la izquierda de lo que se ve, a 100 px y 50 px del borde.
        val (x, y) = Signing.viewToPage(100f, 50f, r)
        assertEquals(0.1f, x, eps); assertEquals(50f / screenH, y, eps)
        // El servidor multiplica por el tamaño que se ve y gira al espacio del PDF (displayToPdf).
        val dx = x * shown.w; val dy = y * shown.h
        val (px, py) = Signing.displayToPdf(612f, 792f, 90, dx, dy)
        // Arriba a la izquierda de la vista girada 90° = cerca del origen del PDF sin girar (abajo a la izquierda).
        assertEquals(dy, px, 0.01f); assertEquals(dx, py, 0.01f)
        assertTrue(px < 612f / 4 && py < 792f / 4)
        // Y sin girar, arriba a la izquierda es y alto en el PDF.
        val (qx, qy) = Signing.displayToPdf(612f, 792f, 0, 61.2f, 39.6f)
        assertEquals(61.2f, qx, 0.01f); assertEquals(792f - 39.6f, qy, 0.01f)
    }

    @Test fun `caja por defecto de firma e iniciales en puntos`() {
        // Firma 600×200 → 170 pt de ancho, 56,7 de alto (menos de 70).
        val (w, h) = Signing.signatureBox(false, 600, 200, letter)
        assertEquals(170f / 612f, w, eps); assertEquals(170f / 3f / 792f, h, eps)
        // Firma alta 200×200 → el alto se limita a 70 pt y el ancho sigue la proporción.
        val (w2, h2) = Signing.signatureBox(false, 200, 200, letter)
        assertEquals(70f / 792f, h2, eps); assertEquals(70f / 612f, w2, eps)
        // Iniciales 300×300 → 50×50 pt.
        val (w3, h3) = Signing.signatureBox(true, 300, 300, letter)
        assertEquals(50f / 612f, w3, eps); assertEquals(50f / 792f, h3, eps)
        // Proporción de la imagen conservada en puntos.
        assertEquals(3f, (w * letter.w) / (h * letter.h), 1e-3f)
    }

    @Test fun `caja de texto alto 18 pt`() {
        val (w, h) = Signing.textBox(Helvetica.width1("27/09/2026"), letter)
        assertEquals(18f / 792f, h, eps)
        assertTrue(w * 612f >= 30f)
        // El tamaño de letra que usa el servidor cabe en la caja.
        val size = Signing.fontSize(Helvetica.width1("27/09/2026"), w * 612f, h * 792f)
        assertTrue(size <= 18f * 0.78f + eps)
    }

    @Test fun `anchos de Helvetica`() {
        assertEquals(0.556f * 8 + 0.278f * 2, Helvetica.width1("27/09/2026"), eps)
        assertEquals(Helvetica.width1("Suarez"), Helvetica.width1("Suárez"), eps)
        assertEquals(0f, Helvetica.width1(""), eps)
    }

    @Test fun `marca nueva centrada sin salirse`() {
        val (x, y) = Signing.centered(0.5f, 0.5f, 0.2f, 0.1f)
        assertEquals(0.4f, x, eps); assertEquals(0.45f, y, eps)
        val (x2, y2) = Signing.centered(0.98f, 0.02f, 0.2f, 0.1f)
        assertEquals(0.8f, x2, eps); assertEquals(0f, y2, eps)
        assertEquals(0.1f, Signing.visibleCenter(itemOffset = 900, itemSize = 1000, viewportStart = 0, viewportEnd = 1000), eps)
        assertEquals(0.5f, Signing.visibleCenter(itemOffset = 0, itemSize = 1000, viewportStart = 0, viewportEnd = 1000), eps)
        assertEquals(0.75f, Signing.visibleCenter(itemOffset = -500, itemSize = 1000, viewportStart = 0, viewportEnd = 500), eps)
    }

    @Test fun `soltar en la misma pagina mueve y queda dentro`() {
        val r = PxRect(0f, 100f, 1000f, 1394f)
        val marks = listOf(mark())
        val out = Signing.drop(marks, "m1", 1, left = 500f, top = 100f + 1294f * 0.5f, rect = r, sizes = listOf(letter))
        assertEquals(0.5f, out[0].x, eps); assertEquals(0.5f, out[0].y, eps)
        // Fuera del borde derecho: se pega al borde.
        val out2 = Signing.drop(marks, "m1", 1, left = 2000f, top = 100f, rect = r, sizes = listOf(letter))
        assertEquals(0.8f, out2[0].x, eps); assertEquals(0f, out2[0].y, eps)
    }

    @Test fun `soltar en otra pagina cambia de pagina conservando el tamano en puntos`() {
        val sizes = listOf(letter, PageSize(792f, 612f)) // la 2 apaisada
        val m = mark(w = 170f / 612f, h = 50f / 792f, group = "g")
        val r2 = PxRect(0f, 1400f, 1000f, 1400f + 1000f * 612f / 792f)
        val out = Signing.drop(listOf(m), "m1", 2, left = 250f, top = 1400f + 100f, rect = r2, sizes = sizes)[0]
        assertEquals(2, out.page)
        assertNull(out.group) // sale del grupo de «En todas»
        assertEquals(170f, out.w * 792f, 0.01f); assertEquals(50f, out.h * 612f, 0.01f)
        assertEquals(0.25f, out.x, eps); assertEquals(100f / (1000f * 612f / 792f), out.y, eps)
    }

    @Test fun `pagina bajo el dedo`() {
        val rects = mapOf(1 to PxRect(0f, 0f, 100f, 100f), 2 to PxRect(0f, 110f, 100f, 210f))
        assertEquals(1, Signing.pageAt(50f, rects))
        assertEquals(2, Signing.pageAt(150f, rects))
        assertEquals(2, Signing.pageAt(107f, rects)) // entre las dos: la más cercana
        assertEquals(2, Signing.pageAt(900f, rects))
        assertNull(Signing.pageAt(10f, emptyMap()))
    }

    @Test fun `el asa y el pellizco conservan la proporcion y no pasan el borde`() {
        val m = mark(x = 0.5f, y = 0.5f, w = 0.2f, h = 0.05f)
        val pw = 1000f; val ph = 1294f
        val ratio0 = (m.h * ph) / (m.w * pw)
        val big = Signing.resized(m, newWpx = 400f, pageWpx = pw, pageHpx = ph, minWpx = 20f)
        assertEquals(0.4f, big.w, eps); assertEquals(ratio0, (big.h * ph) / (big.w * pw), 1e-4f)
        val huge = Signing.resized(m, newWpx = 5000f, pageWpx = pw, pageHpx = ph, minWpx = 20f)
        assertTrue(huge.x + huge.w <= 1f + eps && huge.y + huge.h <= 1f + eps)
        val tiny = Signing.resized(m, newWpx = 1f, pageWpx = pw, pageHpx = ph, minWpx = 20f)
        assertEquals(20f / pw, tiny.w, eps)
        val pinch = Signing.scaled(m, 2f, pw, ph, 20f)
        assertEquals(0.4f, pinch.w, eps)
        assertEquals(m.x + m.w / 2, pinch.x + pinch.w / 2, eps) // alrededor del centro
        assertEquals(ratio0, (pinch.h * ph) / (pinch.w * pw), 1e-4f)
    }

    @Test fun `en todas copia en cada pagina y el grupo se mueve junto`() {
        var n = 0
        val sizes = listOf(letter, letter, PageSize(792f, 612f))
        val (out, copies) = Signing.toAllPages(listOf(mark()), "m1", sizes) { "id${n++}" }
        assertEquals(2, copies)
        assertEquals(listOf(1, 2, 3), out.map { it.page }.sorted())
        assertEquals(1, out.map { it.group }.toSet().size)
        // Otra vez: no duplica las que ya están.
        val (again, more) = Signing.toAllPages(out, "m1", sizes) { "id${n++}" }
        assertEquals(0, more); assertEquals(3, again.size)
        // Mover una mueve todas.
        val moved = Signing.updateGroup(out, out[1].id) { it.copy(x = it.x + 0.1f) }
        assertTrue(moved.all { kotlin.math.abs(it.x - 0.2f) < eps })
        // En la apaisada conserva los puntos.
        val p3 = out.first { it.page == 3 }
        assertEquals(0.2f * 612f, p3.w * 792f, 0.01f)
    }

    @Test fun `duplicar deja otra igual mas abajo en la misma pagina`() {
        val out = Signing.duplicate(listOf(mark(y = 0.3f, h = 0.05f, group = "g")), "m1", "m2")
        assertEquals(2, out.size)
        val d = out[1]
        assertEquals("m2", d.id); assertEquals(1, d.page); assertNull(d.group)
        assertEquals(0.2f, d.w, eps); assertEquals(0.05f, d.h, eps)
        assertTrue(d.y > 0.3f + 0.05f)
        // Al pie de la página va arriba.
        val low = Signing.duplicate(listOf(mark(y = 0.94f, h = 0.05f)), "m1", "m2")[1]
        assertTrue(low.y < 0.94f && low.y + low.h <= 1f)
    }

    @Test fun `una marca nueva no cae encima de otra`() {
        val a = mark(x = 0.4f, y = 0.45f, w = 0.2f, h = 0.05f)
        val b = Signing.avoidOverlap(listOf(a), a.copy(id = "m2"))
        assertTrue(b.y >= a.y + a.h)
        assertEquals(a.x, b.x, eps)
        // En otra página no se mueve.
        val other = Signing.avoidOverlap(listOf(a), a.copy(id = "m3", page = 2))
        assertEquals(a.y, other.y, eps)
        // Al pie: va arriba.
        val low = mark(y = 0.95f, h = 0.05f)
        val up = Signing.avoidOverlap(listOf(low), low.copy(id = "m4"))
        assertTrue(up.y + up.h <= low.y + eps)
    }

    @Test fun `placements dentro de la pagina y solo marcas validas`() {
        val marks = listOf(
            mark(x = 0.95f, y = 0.99f, w = 0.2f, h = 0.05f),
            SignMark("t", MarkKind.DATE, 2, 0.1f, 0.1f, 0.2f, 0.02f, text = " 27/09/2026 "),
            SignMark("vacio", MarkKind.TEXT, 1, 0.1f, 0.1f, 0.2f, 0.02f, text = "  "),
        )
        val p = Signing.placements(marks)
        assertEquals(2, p.size)
        p.forEach { assertTrue(it.x + it.w <= 1.001f && it.y + it.h <= 1.001f && it.w >= Signing.MIN_SIDE && it.h >= Signing.MIN_SIDE) }
        assertEquals("signature", p[0].type); assertEquals("s1", p[0].signatureId)
        assertEquals("text", p[1].type); assertEquals("27/09/2026", p[1].text); assertEquals(2, p[1].page)
        assertEquals(1, Signing.signatureCount(marks)); assertEquals(2, Signing.pagesUsed(marks))
        // JSON como lo espera el API: sin campos nulos.
        val json = TcJson.encodeToString(SignPdfInput.serializer(), SignPdfInput("cmid-12345", placements = p, timeZone = "America/Bogota"))
        val o = TcJson.parseToJsonElement(json).jsonObject
        val first = o["placements"]!!.jsonArray[0].jsonObject
        assertFalse(first.containsKey("text"))
        assertEquals("true", o["stamp"]!!.jsonPrimitive.content)
        assertEquals("false", o["acceptBreakingSignatures"]!!.jsonPrimitive.content)
    }

    @Test fun `iniciales y pdf`() {
        assertEquals("DS", Signing.initialsOf("Danny Suárez"))
        assertEquals("ÁBC", Signing.initialsOf("  ángel  bruno carlos david "))
        assertEquals("3F9A21C0", Signing.ref("3f9a21c0-1111-2222-3333-444455556666"))
        assertTrue(Signing.isPdf(AttachmentDTO(name = "x.PDF", contentType = "application/octet-stream")))
        assertTrue(Signing.isPdf(AttachmentDTO(name = "x", contentType = "application/pdf")))
        assertFalse(Signing.isPdf(AttachmentDTO(name = "x.png", contentType = "image/png")))
    }

    @Test fun `grosor del trazo segun la velocidad`() {
        val slow = List(10) { InkPoint(it * 1f, 0f, it * 20L) }
        val fast = List(10) { InkPoint(it * 40f, 0f, it * 2L) }
        val ws = InkStroke.widths(slow, 1.2f, 3.6f); val wf = InkStroke.widths(fast, 1.2f, 3.6f)
        assertTrue(ws.last() > wf.last())
        (ws + wf).forEach { assertTrue(it in 1.2f..3.6f) }
    }

    // ---------- Imagen ----------
    private fun img(w: Int, h: Int, f: (Int, Int) -> Int) = IntArray(w * h) { f(it % w, it / w) }
    private val clear = 0x00000000
    private val ink = 0xFF172A8A.toInt()

    @Test fun `recorte al trazo con margen`() {
        val px = img(100, 50) { x, y -> if (x in 30..59 && y in 10..19) ink else clear }
        val b = SignImage.inkBounds(px, 100, 50)!!
        assertEquals(SignImage.Bounds(30, 10, 30, 10), b)
        assertEquals(SignImage.Bounds(22, 2, 46, 26), SignImage.trimRect(b, 100, 50, 8))
        // Pegado al borde: el margen no se sale.
        val edge = SignImage.trimRect(SignImage.Bounds(0, 0, 10, 10), 100, 50, 8)!!
        assertEquals(0, edge.x); assertEquals(26, edge.w) // el margen de la izquierda no cabe; el de la derecha sí
        assertNull(SignImage.inkBounds(IntArray(100), 10, 10))
        assertNull(SignImage.trimRect(SignImage.Bounds(0, 0, 3, 3), 10, 10))
        // Un alfa casi transparente no cuenta como trazo.
        assertNull(SignImage.inkBounds(img(10, 10) { _, _ -> 0x0A000000 }, 10, 10))
    }

    @Test fun `reducir sin agrandar`() {
        assertEquals(1200 to 300, SignImage.fit(2400, 600, 1200, 600))
        assertEquals(600 to 600, SignImage.fit(1000, 1000, 600, 600))
        assertEquals(100 to 40, SignImage.fit(100, 40, 1200, 600))
        assertEquals(1200 to 8, SignImage.fit(3000, 10, 1200, 600)) // mínimo 8 px
    }

    @Test fun `umbral de Otsu separa tinta de papel`() {
        // Papel gris claro (230) con tinta gris oscura (40): el umbral cae entre las dos medias.
        val gray = { v: Int -> (0xFF shl 24) or (v shl 16) or (v shl 8) or v }
        val px = img(40, 40) { x, _ -> if (x < 8) gray(40) else gray(230) }
        val t = SignImage.otsuThreshold(px)
        assertEquals(135, t) // (40 + 230) / 2
        val out = SignImage.inkify(px, t, Signing.INK_BLUE)
        // Papel → transparente; tinta → azul opaco.
        assertEquals(0, out[39] ushr 24)
        assertEquals(255, out[0] ushr 24)
        assertEquals(Signing.INK_BLUE and 0xFFFFFF, out[0] and 0xFFFFFF)
        // Conservar el color original.
        val keep = SignImage.inkify(px, t, null)
        assertEquals(gray(40) and 0xFFFFFF, keep[0] and 0xFFFFFF)
        // Borde suave: un gris cercano al umbral queda semitransparente.
        val mid = SignImage.inkify(intArrayOf(gray(125)), t, null)[0] ushr 24
        assertTrue(mid in 1..254)
        assertEquals(145, SignImage.photoThreshold(135))
        assertEquals(65..205, SignImage.sliderRange(135))
    }

    // ---------- Decodificación tolerante ----------
    @Test fun `signing opcional y tolerante en el adjunto`() {
        val ok = TcJson.decodeFromString(AttachmentDTO.serializer(),
            """{"id":"a1","name":"x.pdf","contentType":"application/pdf","signing":{"id":"3f9a21c0-0000","signerId":"u1","signerName":"Ana","signedAt":"2026-09-27T10:00:00Z","originalSha256":"aa","signedSha256":"bb","nuevo":1}}""")
        assertEquals("Ana", ok.signing?.signerName); assertEquals("3F9A21C0", ok.signing?.ref)
        assertNull(TcJson.decodeFromString(AttachmentDTO.serializer(), """{"id":"a1","name":"x.pdf"}""").signing)
        assertNull(TcJson.decodeFromString(AttachmentDTO.serializer(), """{"id":"a1","signing":null}""").signing)
        // Forma inesperada: el adjunto se lee igual.
        val odd = TcJson.decodeFromString(AttachmentDTO.serializer(), """{"id":"a1","name":"x.pdf","signing":"sí","sizeBytes":5}""")
        assertNull(odd.signing); assertEquals(5L, odd.sizeBytes)
        val odd2 = TcJson.decodeFromString(AttachmentDTO.serializer(), """{"id":"a1","signing":{"signedAt":12}}""")
        assertNull(odd2.signing)
        // Y dentro de un mensaje.
        val m = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m1","seq":1,"body":"","attachments":[{"id":"a1","name":"x.pdf","signing":[1,2]}]}""")
        assertNull(m.attachments[0].signing)
        // Ida y vuelta (la cola persistente guarda adjuntos).
        val again = TcJson.decodeFromString(AttachmentDTO.serializer(), TcJson.encodeToString(AttachmentDTO.serializer(), ok))
        assertEquals(ok.signing, again.signing)
    }

    @Test fun `historial de firmas`() {
        val page = TcJson.decodeFromString(SigningHistoryPage.serializer(), """
            {"signings":[{"id":"7e46eae8-ee6f-4403-95bc-86a698ab980b","signerId":"u","signerName":"Danny","signedAt":"2026-09-28T03:17:14.554Z",
              "originalSha256":"60","signedSha256":"58","ref":"7E46EAE8","documentName":"","conversationId":"c1","conversationName":"General",
              "messageId":"m1","sourceAttachmentId":"a0","resultAttachmentId":"a1","requestedById":null,"requestedByName":null,
              "marks":3,"signatureMarks":2,"pagesMarked":2,"pages":3,"stamp":true,"certificate":false,
              "attachment":{"id":"a1","name":"Contrato (firmado).pdf","contentType":"application/pdf"},"futuro":true}],
             "nextBefore":"2026-09-28T03:17:14.554Z","total":1}""")
        val s = page.signings.single()
        assertEquals("7E46EAE8", s.shownRef)
        assertEquals("Contrato (firmado).pdf", s.shownName) // documentName vacío → nombre del archivo
        assertEquals(2, s.signatureMarks)
        assertNotNull(page.nextBefore)
        assertEquals("ABCDEF12", SigningHistoryItemDTO(id = "abcdef12-3456").shownRef)
    }
}
