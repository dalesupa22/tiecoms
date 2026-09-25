package com.tiecoms.app.platform

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.TieComsClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Sube un archivo como adjunto y, si es foto o video, su miniatura (el servidor no la genera):
 * JPEG de 480 px de lado mayor, ≤ 512 KB (SPEC-v4, contrato de mobile-feedback e68dbe8).
 */
object AttachmentUpload {
    const val THUMB_SIDE = 480

    suspend fun upload(ctx: Context, client: TieComsClient, conversationId: String, file: File, name: String, type: String,
                       onProgress: ((Long, Long) -> Unit)? = null): AttachmentDTO {
        val a = client.uploadAttachment(conversationId, file, name, type, onProgress = onProgress)
        val kind = Attachments.kind(a.contentType.ifBlank { type })
        if (kind == Attachments.Kind.FILE) return a
        val thumb = runCatching { thumbnail(ctx, file, kind) }.getOrNull() ?: return a
        return client.uploadThumb(a.id, thumb) ?: a
    }

    /** Miniatura JPEG ≤ 480 px y ≤ 512 KB; null si no se puede decodificar. */
    suspend fun thumbnail(ctx: Context, file: File, kind: Attachments.Kind): ByteArray? = withContext(Dispatchers.Default) {
        val bmp: Bitmap = when (kind) {
            Attachments.Kind.IMAGE -> ImageTools.loadForCrop(ctx, Uri.fromFile(file), THUMB_SIDE * 2)
            Attachments.Kind.VIDEO -> MediaMetadataRetriever().let { r ->
                try { r.setDataSource(file.absolutePath); r.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) } finally { runCatching { r.release() } }
            }
            else -> null
        } ?: return@withContext null
        val scale = THUMB_SIDE.toFloat() / maxOf(bmp.width, bmp.height)
        val out = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt().coerceAtLeast(1), (bmp.height * scale).toInt().coerceAtLeast(1), true) else bmp
        var q = 82
        var bytes: ByteArray
        do {
            bytes = ByteArrayOutputStream().use { s -> out.compress(Bitmap.CompressFormat.JPEG, q, s); s.toByteArray() }
            q -= 12
        } while (bytes.size > 512 * 1024 && q > 20)
        bytes.takeIf { it.size <= 512 * 1024 }
    }
}
