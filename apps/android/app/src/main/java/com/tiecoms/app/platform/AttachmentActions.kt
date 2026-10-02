package com.tiecoms.app.platform

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.core.content.FileProvider
import com.tiecoms.app.core.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

object AttachmentActions {
    /** Authenticated original only; provider/authenticated URLs never enter the clipboard. */
    suspend fun original(ctx: Context, client: TieComsClient, a: AttachmentDTO, max: Long = Attachments.MAX_BYTES): File {
        require(a.sizeBytes in 1..max) { "Attachment exceeds copy limit" }
        val owner = client.myId
        val generation = client.sessionGeneration
        val f = File(ctx.cacheDir, "clipboard/${java.util.UUID.randomUUID()}/${ShareIntake.safeName(a.name, a.contentType, 0)}").apply { parentFile?.mkdirs() }
        try {
            client.downloadAttachment(a.url, f) { sent, _ -> require(sent <= max) { "Attachment exceeds copy limit" } }
            check(f.length() in 1..max && client.myId == owner && client.sessionGeneration == generation) { "Attachment unavailable" }
            return f
        } catch (e: Exception) { f.delete(); throw e }
    }
    suspend fun copyImage(ctx: Context, client: TieComsClient, a: AttachmentDTO) {
        require(a.isImage)
        var f = original(ctx, client, a)
        val gif = f.inputStream().use { Attachments.isGif(it.readNBytes(6)) }
        if (gif && !f.name.endsWith(".gif", true)) { val renamed = File(f.parentFile, "original.gif"); check(f.renameTo(renamed)); f = renamed }
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
        withContext(Dispatchers.Main) { ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newUri(ctx.contentResolver, a.name, uri)) }
    }
    suspend fun copyText(ctx: Context, client: TieComsClient, a: AttachmentDTO) {
        require(LongContent.textFile(a))
        val f = original(ctx, client, a, LongContent.MAX_AUTO_BYTES.toLong())
        try {
            val original = withContext(Dispatchers.IO) {
                // Strict UTF-8: binary or broken text must never masquerade as a successful copy.
                Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(f.readBytes())).toString()
            }
            check(original.isNotEmpty())
            withContext(Dispatchers.Main) { ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(a.name, original)) }
        } finally { f.delete() }
    }
}
