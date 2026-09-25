package com.tiecoms.app.platform

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.IntentCompat
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.DeepLinks
import java.io.File
import java.util.UUID

/**
 * Lo que llega por «Compartir» (ACTION_SEND / ACTION_SEND_MULTIPLE): texto, enlaces y hasta 10 archivos.
 * Los URIs solo son legibles mientras vive la actividad que los recibió, así que se copian a caché antes de subir.
 */
object ShareIntake {
    data class Incoming(
        val uris: List<Uri>, val text: String, val mime: String?, val shortcutId: String?, val source: String,
    )

    fun read(intent: Intent, referrerPackage: String?): Incoming? {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
        val uris = LinkedHashSet<Uri>()
        if (intent.action == Intent.ACTION_SEND) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris += it }
        else IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris += it }
        // Algunas apps solo ponen los archivos en el ClipData.
        intent.clipData?.let { c -> for (i in 0 until c.itemCount) c.getItemAt(i).uri?.let { uris += it } }
        val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
            .map { it.trim() }.filter { it.isNotEmpty() }.distinct().joinToString("\n")
        val shortcut = intent.getStringExtra(androidx.core.content.pm.ShortcutManagerCompat.EXTRA_SHORTCUT_ID)
        return Incoming(uris.toList(), text, intent.type, shortcut, DeepLinks.sourceForPackage(referrerPackage))
    }

    /** Copia cada URI a caché/share/<lote>/ con su nombre, tipo y tamaño. Los que no se pueden leer se omiten. */
    fun copyToCache(ctx: Context, uris: List<Uri>, fallbackMime: String?): List<Attachments.Shared> {
        val dir = File(ctx.cacheDir, "share/" + UUID.randomUUID().toString().take(8)).apply { mkdirs() }
        val cr = ctx.contentResolver
        return uris.take(50).mapIndexedNotNull { i, uri ->
            runCatching {
                var name: String? = null; var size = -1L
                if (uri.scheme == "content") cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        name = c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { c.getString(it) }
                        size = c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { c.getLong(it) } ?: -1L
                    }
                }
                val type = cr.getType(uri) ?: fallbackMime?.takeIf { !it.contains('*') }
                    ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(uri.toString())) ?: "application/octet-stream"
                val clean = safeName(name ?: uri.lastPathSegment ?: "archivo", type, i)
                val out = File(dir, "$i-$clean")
                // Un archivo que ya sabemos que es muy grande no se copia (se informa con su tamaño).
                if (size > Attachments.MAX_BYTES) return@runCatching Attachments.Shared(clean, type, size, "")
                cr.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it) } } ?: return@runCatching null
                Attachments.Shared(clean, type, out.length(), out.absolutePath)
            }.getOrNull()
        }
    }

    fun safeName(raw: String, type: String, index: Int): String {
        var n = raw.substringAfterLast('/').replace(Regex("[\\\\:*?\"<>|\\u0000-\\u001f]"), "_").trim().take(120)
        if (n.isBlank()) n = "archivo-${index + 1}"
        if (!n.contains('.')) MimeTypeMap.getSingleton().getExtensionFromMimeType(type)?.let { n += ".$it" }
        return n
    }

}
