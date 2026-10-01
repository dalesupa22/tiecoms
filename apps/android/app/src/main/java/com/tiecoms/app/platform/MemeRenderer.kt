package com.tiecoms.app.platform

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import com.tiecoms.app.core.Attachments
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale
import java.util.UUID

/** Captions are rendered on-device. Only the finished JPEG can be uploaded after explicit Send. */
object MemeRenderer {
    suspend fun render(context: Context, original: ByteArray, top: String, bottom: String): Attachments.Shared = withContext(Dispatchers.IO) {
        require(original.size <= Attachments.MAX_BYTES)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(original, 0, original.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Invalid meme template" }
        val options = BitmapFactory.Options().apply {
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 1600) sample *= 2
            inSampleSize = sample
        }
        val source = requireNotNull(BitmapFactory.decodeByteArray(original, 0, original.size, options))
        val image = source.copy(Bitmap.Config.ARGB_8888, true)
        source.recycle()
        try {
            val canvas = Canvas(image)
            caption(canvas, image.width, image.height, top, false)
            caption(canvas, image.width, image.height, bottom, true)
            val directory = File(context.cacheDir, "share/memes").apply { mkdirs() }
            val file = File(directory, "meme-${UUID.randomUUID()}.jpg")
            file.outputStream().use { check(image.compress(Bitmap.CompressFormat.JPEG, 92, it)) }
            Attachments.Shared("meme.jpg", "image/jpeg", file.length(), file.absolutePath)
        } finally { image.recycle() }
    }

    private fun caption(canvas: Canvas, width: Int, height: Int, raw: String, bottom: Boolean) {
        val text = raw.trim().take(120).uppercase(Locale.ROOT)
        if (text.isBlank()) return
        val margin = (width * 0.04f).coerceAtLeast(4f)
        val available = (width - 2 * margin).toInt().coerceAtLeast(1)
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = android.graphics.Typeface.create("sans-serif-condensed", android.graphics.Typeface.BOLD)
            textSize = width * 0.085f
            color = Color.WHITE
        }
        fun layout() = StaticLayout.Builder.obtain(text, 0, text.length, paint, available)
            .setAlignment(Layout.Alignment.ALIGN_CENTER).setIncludePad(false).build()
        var lines = layout()
        while (lines.height > height * 0.35f && paint.textSize > width * 0.025f) {
            paint.textSize *= 0.9f; lines = layout()
        }
        canvas.save()
        canvas.translate(margin, if (bottom) height - margin - lines.height else margin)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = (paint.textSize * 0.10f).coerceAtLeast(1f); paint.color = Color.BLACK
        lines.draw(canvas)
        paint.style = Paint.Style.FILL; paint.color = Color.WHITE
        lines.draw(canvas)
        canvas.restore()
    }
}
