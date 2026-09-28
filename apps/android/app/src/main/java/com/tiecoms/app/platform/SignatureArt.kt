package com.tiecoms.app.platform

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.net.Uri
import com.tiecoms.app.R
import com.tiecoms.app.core.InkPoint
import com.tiecoms.app.core.InkStroke
import com.tiecoms.app.core.SignImage
import com.tiecoms.app.core.Signing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.ceil
import kotlin.math.min
import kotlin.math.roundToInt

/** Firmas como imágenes: dibujar trazos, escribir con letra cursiva, limpiar fotos y sacar el PNG recortado. */
object SignatureArt {
    /** Grosor del trazo en dp (como signature_pad en la web: 1,2–3,6). */
    const val MIN_W_DP = 1.2f
    const val MAX_W_DP = 3.6f

    /**
     * Dibuja los trazos con curvas cuadráticas entre puntos medios y grosor según la velocidad.
     * Cada segmento lleva su propio grosor; los extremos redondos los unen sin costuras.
     */
    fun drawStrokes(canvas: Canvas, strokes: List<List<InkPoint>>, color: Int, density: Float, paint: Paint = strokePaint()) {
        paint.color = color
        val path = Path()
        for (s in strokes) {
            if (s.isEmpty()) continue
            val widths = InkStroke.widths(s, MIN_W_DP * density, MAX_W_DP * density, density)
            if (s.size == 1) {
                paint.style = Paint.Style.FILL
                canvas.drawCircle(s[0].x, s[0].y, widths[0] * 0.7f, paint)
                paint.style = Paint.Style.STROKE
                continue
            }
            var prevMidX = s[0].x; var prevMidY = s[0].y
            for (i in 1 until s.size) {
                val a = s[i - 1]; val b = s[i]
                val midX = (a.x + b.x) / 2; val midY = (a.y + b.y) / 2
                path.reset()
                path.moveTo(prevMidX, prevMidY)
                path.quadTo(a.x, a.y, midX, midY)
                if (i == s.size - 1) path.lineTo(b.x, b.y)
                paint.strokeWidth = widths[i]
                canvas.drawPath(path, paint)
                prevMidX = midX; prevMidY = midY
            }
        }
    }

    fun strokePaint() = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }

    /** Lienzo dibujado → bitmap transparente del mismo tamaño. */
    fun drawnBitmap(strokes: List<List<InkPoint>>, widthPx: Int, heightPx: Int, color: Int, density: Float): Bitmap? {
        if (strokes.none { it.isNotEmpty() } || widthPx <= 0 || heightPx <= 0) return null
        val bmp = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
        drawStrokes(Canvas(bmp), strokes, color, density)
        return bmp
    }

    // ---------- Letras cursivas (OFL, en res/font; licencias en assets/licenses) ----------
    val FONTS = listOf(R.font.sig_dancing_script to "Dancing Script", R.font.sig_great_vibes to "Great Vibes", R.font.sig_caveat to "Caveat")
    private val typefaces = HashMap<Int, Typeface>()

    /**
     * La letra [index] con peso 600 cuando la fuente es variable (Dancing Script y Caveat), como en la web.
     * Se copia una vez a caché porque Typeface.Builder necesita un archivo para aplicar la variación.
     */
    fun typeface(ctx: Context, index: Int): Typeface = synchronized(typefaces) {
        typefaces.getOrPut(index) {
            val (res, name) = FONTS[index.coerceIn(0, FONTS.lastIndex)]
            runCatching {
                val f = File(ctx.cacheDir, "fonts/${name.replace(' ', '_')}.ttf")
                if (!f.exists() || f.length() == 0L) {
                    f.parentFile?.mkdirs()
                    ctx.resources.openRawResource(res).use { input -> f.outputStream().use { input.copyTo(it) } }
                }
                Typeface.Builder(f).setFontVariationSettings("'wght' 600").build()
            }.getOrNull() ?: runCatching { androidx.core.content.res.ResourcesCompat.getFont(ctx, res) }.getOrNull() ?: Typeface.SERIF
        }
    }

    /**
     * Texto en cursiva → bitmap transparente listo para recortar (letra de 140 px, como la web). El lienzo se mide
     * con la caja real de los trazos (getTextBounds), no con el avance: las colas de Great Vibes y Dancing Script
     * sobresalen y se cortarían.
     */
    fun typedBitmap(ctx: Context, text: String, fontIndex: Int, color: Int): Bitmap? {
        val t = text.trim()
        if (t.isEmpty()) return null
        val size = 140f
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = typeface(ctx, fontIndex); textSize = size; this.color = color }
        val ink = android.graphics.Rect()
        paint.getTextBounds(t, 0, t.length, ink)
        val pad = (size * 0.35f).roundToInt()
        val left = minOf(0, ink.left)
        val right = maxOf(ceil(paint.measureText(t)).toInt(), ink.right)
        val width = min(2400, right - left + pad * 2)
        val height = (ink.height() + pad * 2).coerceAtLeast((size * 1.2f).roundToInt())
        val bmp = Bitmap.createBitmap(width.coerceAtLeast(8), height, Bitmap.Config.ARGB_8888)
        Canvas(bmp).drawText(t, (pad - left).toFloat(), (pad - ink.top).toFloat() + (height - ink.height() - pad * 2) / 2f, paint)
        return bmp
    }

    // ---------- Foto de una firma en papel ----------
    data class Photo(val width: Int, val height: Int, val pixels: IntArray, val auto: Int)

    /** Carga la foto (derecha según EXIF, ≤ 1600 px) y calcula el umbral automático. null si no es una imagen. */
    suspend fun loadPhoto(ctx: Context, uri: Uri): Photo? {
        val bmp = ImageTools.loadForCrop(ctx, uri, 1600) ?: return null
        return withContext(Dispatchers.Default) {
            val k = min(1f, 1600f / maxOf(bmp.width, bmp.height))
            val src = if (k < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * k).roundToInt(), (bmp.height * k).roundToInt(), true) else bmp
            val px = IntArray(src.width * src.height)
            src.getPixels(px, 0, src.width, 0, 0, src.width, src.height)
            Photo(src.width, src.height, px, SignImage.otsuThreshold(px))
        }
    }

    /** Foto → tinta sobre transparente con [threshold]; [color] null conserva el color original. */
    suspend fun inkPhoto(p: Photo, threshold: Int, color: Int?): Bitmap = withContext(Dispatchers.Default) {
        val out = SignImage.inkify(p.pixels, threshold, color)
        Bitmap.createBitmap(out, p.width, p.height, Bitmap.Config.ARGB_8888)
    }

    // ---------- PNG final ----------
    data class Png(val bytes: ByteArray, val width: Int, val height: Int)

    /**
     * Recorta al trazo (margen [pad]), reduce a ≤ [maxW]×[maxH] y comprime en PNG; si pasara de 512 KB (una foto con
     * su color) se sigue reduciendo. null si no hay trazo.
     */
    suspend fun trimmedPng(src: Bitmap, maxW: Int, maxH: Int, pad: Int = 8): Png? = withContext(Dispatchers.Default) {
        val px = IntArray(src.width * src.height)
        src.getPixels(px, 0, src.width, 0, 0, src.width, src.height)
        val r = SignImage.trimRect(SignImage.inkBounds(px, src.width, src.height), src.width, src.height, pad) ?: return@withContext null
        val cropped = Bitmap.createBitmap(src, r.x, r.y, r.w, r.h)
        var (w, h) = SignImage.fit(r.w, r.h, maxW, maxH)
        while (true) {
            val scaled = if (w == cropped.width && h == cropped.height) cropped else Bitmap.createScaledBitmap(cropped, w, h, true)
            val bytes = ByteArrayOutputStream().use { s -> scaled.compress(Bitmap.CompressFormat.PNG, 100, s); s.toByteArray() }
            if (bytes.size <= Signing.MAX_PNG_BYTES || w <= 64) return@withContext Png(bytes, w, h)
            w = (w * 0.8f).roundToInt(); h = (h * 0.8f).roundToInt().coerceAtLeast(8)
        }
        @Suppress("UNREACHABLE_CODE") null
    }

    /** Ancho de un texto a 1 pt en la letra del servidor (Helvetica). */
    fun textWidth1(text: String): Float = com.tiecoms.app.core.Helvetica.width1(text)
}
