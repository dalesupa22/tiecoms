package com.tiecoms.app.platform

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import com.tiecoms.app.core.MAX_AVATAR_BYTES
import com.tiecoms.app.core.Media
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** Fotos y archivos elegidos en el teléfono. */
object ImageTools {
    const val AVATAR_SIDE = 512

    /**
     * Foto de perfil: decodifica reducida, respeta la orientación EXIF, recorta el cuadrado del centro,
     * la lleva a 512×512 y la comprime en JPEG (bajando la calidad si hiciera falta para no pasar de 3 MB).
     * Devuelve null si el archivo no es una imagen.
     */
    suspend fun avatarJpeg(ctx: Context, uri: Uri): ByteArray? = withContext(Dispatchers.IO) {
        val cr = ctx.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
        val opts = BitmapFactory.Options().apply { inSampleSize = Media.sampleSize(bounds.outWidth, bounds.outHeight, AVATAR_SIDE) }
        val decoded = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return@withContext null
        val orientation = runCatching { cr.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } }
            .getOrNull() ?: ExifInterface.ORIENTATION_NORMAL
        val upright = rotate(decoded, orientation)
        val (x, y, side) = Media.centerSquare(upright.width, upright.height)
        val square = Bitmap.createBitmap(upright, x, y, side, side)
        val out = Bitmap.createScaledBitmap(square, AVATAR_SIDE, AVATAR_SIDE, true)
        var quality = 88
        var bytes: ByteArray
        do {
            bytes = ByteArrayOutputStream().use { s -> out.compress(Bitmap.CompressFormat.JPEG, quality, s); s.toByteArray() }
            quality -= 12
        } while (bytes.size > MAX_AVATAR_BYTES && quality > 20)
        bytes
    }

    private fun rotate(b: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
            else -> return b
        }
        return Bitmap.createBitmap(b, 0, 0, b.width, b.height, m, true)
    }

    /** Archivo elegido para subir: nombre visible, tamaño declarado (o -1) y tipo MIME. */
    data class Picked(val uri: Uri, val name: String, val size: Long, val type: String?)

    fun describe(ctx: Context, uri: Uri): Picked {
        var name = uri.lastPathSegment ?: "archivo"
        var size = -1L
        runCatching {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { i -> c.getString(i)?.let { name = it } }
                    c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
                }
            }
        }
        return Picked(uri, name, size, ctx.contentResolver.getType(uri))
    }

    /** Lee el archivo entero si no pasa de [max] bytes; null si es más grande. */
    suspend fun readUpTo(ctx: Context, uri: Uri, max: Int): ByteArray? = withContext(Dispatchers.IO) {
        ctx.contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            var total = 0
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                total += n
                if (total > max) return@withContext null
                out.write(buf, 0, n)
            }
            out.toByteArray()
        }
    }
}
