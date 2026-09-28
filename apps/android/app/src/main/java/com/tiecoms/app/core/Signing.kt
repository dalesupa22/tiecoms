package com.tiecoms.app.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// ---------- Firmar PDFs: contrato (packages/contracts, «Firmar PDFs») ----------

/** Quién firmó con Chaggu, cuándo y las huellas SHA-256 (hex) del original y del firmado. */
@Serializable
data class AttachmentSigningDTO(
    val id: String = "",
    val signerId: String = "",
    val signerName: String = "",
    val signedAt: String = "",
    val originalSha256: String = "",
    val signedSha256: String = "",
) {
    /** Referencia corta impresa en el sello del PDF (signingRef de contracts). */
    val ref: String get() = Signing.ref(id)
}

/**
 * `signing` es opcional y nuevo: si llega con otra forma no debe romper el mensaje entero
 * (decodificación tolerante), queda en null.
 */
object LenientSigningSerializer : KSerializer<AttachmentSigningDTO?> {
    private val inner = AttachmentSigningDTO.serializer()
    override val descriptor = inner.nullable.descriptor
    override fun deserialize(decoder: Decoder): AttachmentSigningDTO? {
        val el = (decoder as? JsonDecoder)?.decodeJsonElement() ?: return runCatching { decoder.decodeSerializableValue(inner.nullable) }.getOrNull()
        return runCatching { TcJson.decodeFromJsonElement(inner, el) }.getOrNull()?.takeIf { it.id.isNotBlank() && it.signerName.isNotBlank() }
    }
    override fun serialize(encoder: Encoder, value: AttachmentSigningDTO?) = encoder.encodeSerializableValue(inner.nullable, value)
}

/** Firma guardada (PNG transparente). [url] es una ruta del API que exige Bearer y solo sirve a su dueño. */
@Serializable
data class SignatureDTO(
    val id: String = "",
    /** signature | initials */
    val kind: String = "signature",
    /** drawn | typed | uploaded */
    val source: String = "drawn",
    val width: Int = 0,
    val height: Int = 0,
    val url: String = "",
    val createdAt: String = "",
) {
    val isInitials: Boolean get() = kind == "initials"
}

@Serializable
data class SignaturesPage(val signatures: List<SignatureDTO> = emptyList())

@Serializable
data class SignInfoDTO(
    val attachmentId: String = "",
    val name: String = "",
    val sizeBytes: Long = 0,
    val hasDigitalSignature: Boolean = false,
    val encrypted: Boolean = false,
    @Serializable(with = LenientSigningSerializer::class) val signing: AttachmentSigningDTO? = null,
    val history: List<AttachmentSigningDTO> = emptyList(),
)

/** Una marca sobre la página, en proporciones 0–1 de la página tal como se ve (ya girada), origen arriba a la izquierda. */
@Serializable
data class SignPlacement(
    /** signature | text */
    val type: String,
    val signatureId: String? = null,
    val text: String? = null,
    val page: Int,
    val x: Float, val y: Float, val w: Float, val h: Float,
)

@Serializable
data class SignPdfInput(
    val clientMessageId: String,
    val body: String = "",
    val placements: List<SignPlacement>,
    val stamp: Boolean = true,
    val certificate: Boolean = false,
    val acceptBreakingSignatures: Boolean = false,
    val timeZone: String? = null,
)

@Serializable
data class SignPdfResult(
    val message: MessageDTO? = null,
    val attachment: AttachmentDTO? = null,
    @Serializable(with = LenientSigningSerializer::class) val signing: AttachmentSigningDTO? = null,
    val duplicate: Boolean = false,
)

/** Una fila de «Documentos que firmé» (GET /me/signings). */
@Serializable
data class SigningHistoryItemDTO(
    val id: String = "",
    val signerId: String = "",
    val signerName: String = "",
    val signedAt: String = "",
    val originalSha256: String = "",
    val signedSha256: String = "",
    val ref: String = "",
    val documentName: String = "",
    val conversationId: String = "",
    val conversationName: String? = null,
    val messageId: String? = null,
    val sourceAttachmentId: String = "",
    val resultAttachmentId: String = "",
    val requestedById: String? = null,
    val requestedByName: String? = null,
    val marks: Int = 0,
    val signatureMarks: Int = 0,
    val pagesMarked: Int = 0,
    val pages: Int = 0,
    val stamp: Boolean = true,
    val certificate: Boolean = false,
    /** El PDF firmado, si todavía lo puedo leer. */
    val attachment: AttachmentDTO? = null,
) {
    val shownRef: String get() = ref.ifBlank { Signing.ref(id) }
    /** Nombre para mostrar: el del registro o, si llegó vacío, el del PDF firmado. */
    val shownName: String get() = documentName.ifBlank { attachment?.name.orEmpty() }
}

@Serializable
data class SigningHistoryPage(
    val signings: List<SigningHistoryItemDTO> = emptyList(),
    val nextBefore: String? = null,
    val total: Int = 0,
)

// ---------- Marcas y geometría (sin Android: se prueba en la JVM) ----------

/** Tamaño de una página en puntos PDF, tal como se ve (ya aplicada /Rotate). */
data class PageSize(val w: Float, val h: Float)

/** Rectángulo en píxeles de pantalla (coordenadas de la raíz). */
data class PxRect(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
    fun contains(x: Float, y: Float) = x in left..right && y in top..bottom
}

@Serializable
enum class MarkKind(val wire: String) {
    SIGNATURE("signature"), INITIALS("initials"), DATE("date"), TEXT("text");
    val isImage: Boolean get() = this == SIGNATURE || this == INITIALS
    val isText: Boolean get() = !isImage
}

/** Marca puesta en el editor. x, y, w, h en proporciones de su página; [group] une las copias de «En todas». */
@Serializable
data class SignMark(
    val id: String,
    val kind: MarkKind,
    val page: Int,
    val x: Float, val y: Float, val w: Float, val h: Float,
    val signatureId: String? = null,
    val text: String? = null,
    val group: String? = null,
)

object Signing {
    /** Límites del servidor (contracts). */
    const val MAX_SAVED = 12
    const val MAX_PNG_BYTES = 512 * 1024
    const val MAX_PLACEMENTS = 300
    const val MIN_SIDE = 0.004f

    /** Tinta: azul rgb(23,42,138) y negra rgb(20,20,24), en ARGB. */
    const val INK_BLUE = 0xFF172A8A.toInt()
    const val INK_BLACK = 0xFF141418.toInt()

    /** Tamaños por defecto en puntos PDF. */
    const val SIG_W = 170f; const val SIG_MAX_H = 70f
    const val INI_W = 60f; const val INI_MAX_H = 50f
    const val TEXT_H = 18f

    fun ref(signingId: String): String = signingId.replace("-", "").take(8).uppercase()

    fun isPdf(a: AttachmentDTO): Boolean =
        !a.isVoice && (a.contentType.equals("application/pdf", ignoreCase = true) || a.name.endsWith(".pdf", ignoreCase = true))

    /** Iniciales de un nombre: primeras letras de hasta 3 palabras. */
    fun initialsOf(name: String): String =
        name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(3).joinToString("") { it.substring(0, 1).uppercase() }

    fun clamp(v: Float, lo: Float, hi: Float): Float = if (hi < lo) lo else min(hi, max(lo, v))

    /**
     * Tamaño de la página como se ve: /Rotate 90 o 270 cambia ancho por alto. (PdfRenderer ya entrega la página
     * así; esto sirve para las pruebas y para cualquier otra fuente de tamaños.)
     */
    fun displaySize(mediaW: Float, mediaH: Float, rotation: Int): PageSize {
        val r = ((rotation % 360) + 360) % 360
        return if (r == 90 || r == 270) PageSize(mediaH, mediaW) else PageSize(mediaW, mediaH)
    }

    /**
     * Espejo de displayToPdf del servidor: un punto de la página como se ve (puntos, origen arriba a la izquierda)
     * → espacio de usuario del PDF (origen abajo a la izquierda, sin girar). Solo para comprobar el contrato.
     */
    fun displayToPdf(boxW: Float, boxH: Float, rotation: Int, dx: Float, dy: Float): Pair<Float, Float> =
        when (((rotation % 360) + 360) % 360) {
            90 -> dy to dx
            180 -> (boxW - dx) to dy
            270 -> (boxW - dy) to (boxH - dx)
            else -> dx to (boxH - dy)
        }

    /** Punto de pantalla → proporciones de la página cuyo rectángulo en pantalla es [page]. */
    fun viewToPage(px: Float, py: Float, page: PxRect): Pair<Float, Float> =
        (if (page.width > 0) (px - page.left) / page.width else 0f) to (if (page.height > 0) (py - page.top) / page.height else 0f)

    /** Caja por defecto de una firma (o iniciales) en proporciones de la página, conservando la proporción de la imagen. */
    fun signatureBox(initials: Boolean, imgW: Int, imgH: Int, page: PageSize): Pair<Float, Float> {
        val iw = max(1, imgW).toFloat(); val ih = max(1, imgH).toFloat()
        var wPt = if (initials) INI_W else SIG_W
        var hPt = wPt * ih / iw
        val maxH = if (initials) INI_MAX_H else SIG_MAX_H
        if (hPt > maxH) { hPt = maxH; wPt = hPt * iw / ih }
        // Si hay que achicarla para que quepa, las dos medidas a la vez (misma proporción).
        val k = min(1f, min(0.9f * page.w / wPt, 0.9f * page.h / hPt))
        return (wPt * k / page.w) to (hPt * k / page.h)
    }

    /** Caja por defecto de un texto: alto 18 pt y el ancho que pide la letra. [width1] = ancho del texto a 1 pt. */
    fun textBox(width1: Float, page: PageSize): Pair<Float, Float> {
        val wPt = max(30f, width1 * TEXT_H * 0.78f * 1.06f)
        return min(0.95f, wPt / page.w) to min(0.5f, TEXT_H / page.h)
    }

    /** Tamaño de letra de un texto dentro de su caja (igual que el servidor: min(h·0,78, w/ancho a 1)). */
    fun fontSize(width1: Float, boxW: Float, boxH: Float, minSize: Float = 4f): Float = max(minSize, min(boxH * 0.78f, boxW / max(1e-6f, width1)))

    /** Marca centrada en (cx, cy) sin salirse de la página. */
    fun centered(cx: Float, cy: Float, w: Float, h: Float): Pair<Float, Float> =
        clamp(cx - w / 2, 0f, 1 - w) to clamp(cy - h / 2, 0f, 1 - h)

    fun clampMark(m: SignMark): SignMark {
        val w = clamp(m.w, MIN_SIDE, 1f); val h = clamp(m.h, MIN_SIDE, 1f)
        return m.copy(w = w, h = h, x = clamp(m.x, 0f, 1 - w), y = clamp(m.y, 0f, 1 - h))
    }

    /** Aplica [f] a la marca y a sus copias de «En todas» (se mueven y se agrandan juntas). */
    fun updateGroup(marks: List<SignMark>, id: String, f: (SignMark) -> SignMark): List<SignMark> {
        val group = marks.firstOrNull { it.id == id }?.group
        return marks.map { if (it.id == id || (group != null && it.group == group)) clampMark(f(it)) else it }
    }

    /**
     * Se soltó la marca con su esquina superior izquierda en (left, top) de pantalla, sobre la página [to] (1…n)
     * cuyo rectángulo es [rect]. Misma página: se mueve (con su grupo). Otra página: pasa a ella conservando su
     * tamaño en puntos y sale del grupo.
     */
    fun drop(marks: List<SignMark>, id: String, to: Int, left: Float, top: Float, rect: PxRect, sizes: List<PageSize>): List<SignMark> {
        val m = marks.firstOrNull { it.id == id } ?: return marks
        val (x, y) = viewToPage(left, top, rect)
        if (to == m.page) {
            val dx = clamp(x, 0f, 1 - m.w) - m.x; val dy = clamp(y, 0f, 1 - m.h) - m.y
            return updateGroup(marks, id) { it.copy(x = it.x + dx, y = it.y + dy) }
        }
        val from = sizes.getOrNull(m.page - 1) ?: return marks
        val dest = sizes.getOrNull(to - 1) ?: return marks
        val w = min(0.95f, m.w * from.w / dest.w); val h = min(0.95f, m.h * from.h / dest.h)
        return marks.map { if (it.id == id) clampMark(it.copy(page = to, group = null, w = w, h = h, x = x, y = y)) else it }
    }

    /**
     * Cambia el ancho a [newWpx] conservando la proporción que se ve (firma y texto), sin pasar el borde de la
     * página. [pageWpx]/[pageHpx]: tamaño de la página en pantalla; [minWpx]: ancho mínimo tocable.
     */
    fun resized(m: SignMark, newWpx: Float, pageWpx: Float, pageHpx: Float, minWpx: Float): SignMark {
        val ratio = (m.h * pageHpx) / max(1e-6f, m.w * pageWpx)
        val maxW = min((1 - m.x) * pageWpx, (1 - m.y) * pageHpx / ratio)
        val w = clamp(newWpx, min(minWpx, maxW), maxW)
        return m.copy(w = w / pageWpx, h = w * ratio / pageHpx)
    }

    /** Pellizco: escala alrededor del centro, conservando la proporción y dentro de la página. */
    fun scaled(m: SignMark, factor: Float, pageWpx: Float, pageHpx: Float, minWpx: Float): SignMark {
        val cx = m.x + m.w / 2; val cy = m.y + m.h / 2
        val ratio = (m.h * pageHpx) / max(1e-6f, m.w * pageWpx)
        val maxW = min(pageWpx, pageHpx / ratio)
        val wPx = clamp(m.w * pageWpx * factor, min(minWpx, maxW), maxW)
        val w = wPx / pageWpx; val h = wPx * ratio / pageHpx
        return m.copy(w = w, h = h, x = clamp(cx - w / 2, 0f, 1 - w), y = clamp(cy - h / 2, 0f, 1 - h))
    }

    /** «En todas»: copia la marca en la misma posición relativa en las demás páginas. Devuelve la lista y cuántas copias. */
    fun toAllPages(marks: List<SignMark>, id: String, sizes: List<PageSize>, newId: () -> String): Pair<List<SignMark>, Int> {
        val base = marks.firstOrNull { it.id == id } ?: return marks to 0
        val from = sizes.getOrNull(base.page - 1) ?: return marks to 0
        val group = base.group ?: newId()
        val copies = ArrayList<SignMark>()
        for (p in 1..sizes.size) {
            if (p == base.page || marks.any { it.group == group && it.page == p }) continue
            val to = sizes[p - 1]
            val w = min(0.95f, base.w * from.w / to.w); val h = min(0.95f, base.h * from.h / to.h)
            copies += clampMark(base.copy(id = newId(), group = group, page = p, w = w, h = h))
        }
        return (marks.map { if (it.id == id) it.copy(group = group) else it } + copies) to copies.size
    }

    /**
     * «Duplicar»: otra marca igual un poco más abajo en la misma página (pólizas con varias firmas);
     * si no cabe abajo va arriba y, si tampoco, corrida en diagonal.
     */
    fun duplicate(marks: List<SignMark>, id: String, newId: String): List<SignMark> {
        val m = marks.firstOrNull { it.id == id } ?: return marks
        val gap = max(0.01f, m.h * 0.35f)
        val y = when {
            m.y + m.h * 2 + gap <= 1f -> m.y + m.h + gap
            m.y - m.h - gap >= 0f -> m.y - m.h - gap
            else -> m.y + 0.03f
        }
        val x = if (abs(y - m.y) < m.h) m.x + 0.03f else m.x
        return marks + clampMark(m.copy(id = newId, group = null, x = x, y = y))
    }

    /**
     * Una marca nueva no cae exactamente encima de otra de la misma página (dos toques seguidos en «Firma»): se corre
     * hacia abajo lo necesario y, si no cabe, hacia arriba.
     */
    fun avoidOverlap(marks: List<SignMark>, m: SignMark): SignMark {
        fun hits(a: SignMark) = marks.any { o -> o.page == a.page && a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h }
        var c = m
        var tries = 0
        while (hits(c) && tries++ < 8) {
            val below = marks.filter { o -> o.page == c.page && c.x < o.x + o.w && o.x < c.x + c.w && c.y < o.y + o.h && o.y < c.y + c.h }.maxOf { it.y + it.h }
            c = if (below + 0.01f + c.h <= 1f) c.copy(y = below + 0.01f) else return clampMark(m.copy(y = clamp(m.y - m.h - 0.02f, 0f, 1 - m.h)))
        }
        return c
    }

    /** Página (1…n) bajo el punto y de pantalla: la que lo contiene o, si cae entre dos, la más cercana. */
    fun pageAt(y: Float, rects: Map<Int, PxRect>): Int? {
        if (rects.isEmpty()) return null
        rects.entries.firstOrNull { y >= it.value.top && y <= it.value.bottom }?.let { return it.key }
        return rects.minByOrNull { (_, r) -> if (y < r.top) r.top - y else y - r.bottom }?.key
    }

    /** Proporción vertical (0,1–0,9) de la página [itemOffset, itemOffset+itemSize) que queda en el centro de lo visible. */
    fun visibleCenter(itemOffset: Int, itemSize: Int, viewportStart: Int, viewportEnd: Int): Float {
        if (itemSize <= 0) return 0.5f
        val mid = (viewportStart + viewportEnd) / 2f
        return clamp((mid - itemOffset) / itemSize, 0.1f, 0.9f)
    }

    /** Marcas → placements del API, siempre dentro de la página. */
    fun placements(marks: List<SignMark>): List<SignPlacement> = marks.mapNotNull { m0 ->
        val m = clampMark(m0)
        val w = clamp(m.w, MIN_SIDE, 1 - m.x); val h = clamp(m.h, MIN_SIDE, 1 - m.y)
        val x = min(m.x, 1 - w); val y = min(m.y, 1 - h)
        when {
            m.kind.isImage && m.signatureId != null -> SignPlacement("signature", signatureId = m.signatureId, page = m.page, x = x, y = y, w = w, h = h)
            m.kind.isText && !m.text.isNullOrBlank() -> SignPlacement("text", text = m.text.trim().take(300), page = m.page, x = x, y = y, w = w, h = h)
            else -> null
        }
    }

    /** Firmas + iniciales (lo que cuenta el botón «Firmar (n)»). */
    fun signatureCount(marks: List<SignMark>): Int = marks.count { it.kind.isImage }
    fun pagesUsed(marks: List<SignMark>): Int = marks.map { it.page }.toSet().size
}

// ---------- Trazo a mano (grosor según velocidad, como signature_pad) ----------

/** Un punto del trazo: posición en px del lienzo y tiempo en ms. */
data class InkPoint(val x: Float, val y: Float, val t: Long)

object InkStroke {
    /**
     * Grosor en cada punto: lento = grueso, rápido = delgado. Velocidad en px/ms filtrada ([filter] del valor
     * anterior), grosor = max(maxW / (v + 1), minW). [pxPerDp] lleva la velocidad a dp para que no dependa de la pantalla.
     */
    fun widths(points: List<InkPoint>, minW: Float, maxW: Float, pxPerDp: Float = 1f, filter: Float = 0.6f): FloatArray {
        val out = FloatArray(points.size)
        if (points.isEmpty()) return out
        var v = 0f
        out[0] = (minW + maxW) / 2
        for (i in 1 until points.size) {
            val a = points[i - 1]; val b = points[i]
            val dist = kotlin.math.hypot(b.x - a.x, b.y - a.y) / max(1e-3f, pxPerDp)
            val dt = max(1L, b.t - a.t).toFloat()
            v = filter * (dist / dt) + (1 - filter) * v
            val w = max(maxW / (v + 1), minW)
            // Suaviza también el grosor para que no salte entre segmentos.
            out[i] = out[i - 1] * 0.5f + w * 0.5f
        }
        return out
    }
}

/**
 * Anchos de Helvetica (la letra con que el servidor escribe los textos), en milésimas del tamaño, para ASCII 32–126.
 * Con esto la caja que se ve en el teléfono es la misma que estampa el servidor.
 */
object Helvetica {
    private val ASCII = intArrayOf(
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // espacio … /
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0 … ?
        1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ … O
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P … _
        333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` … o
        556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,      // p … ~
    )

    /** Ancho del texto a tamaño 1 (las tildes cuentan como su letra base; lo desconocido como una «n»). */
    fun width1(text: String): Float {
        var sum = 0
        for (ch in java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFD)) {
            val c = ch.code
            if (Character.getType(ch) == Character.NON_SPACING_MARK.toInt()) continue
            sum += if (c in 32..126) ASCII[c - 32] else 556
        }
        return sum / 1000f
    }
}
