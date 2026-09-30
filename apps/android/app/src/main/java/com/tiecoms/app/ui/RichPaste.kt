package com.tiecoms.app.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ContentResolver
import android.net.Uri
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.platform.PlatformTextInputSession
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat

/**
 * Pegar imágenes en el compositor (1.7.1). El campo de texto de Compose (TextFieldValue) solo pega texto, así que:
 *  - Menú «Pegar»: si el portapapeles tiene una imagen (y no texto), el campo ve un marcador invisible como texto;
 *    el compositor lo quita y adjunta la imagen del portapapeles como si viniera de la galería.
 *  - Teclado (Gboard: imágenes del portapapeles, stickers, GIF): el campo anuncia los tipos de imagen en el EditorInfo y
 *    recibe el contenido por commitContent.
 * Menciones, temas, borradores y el tamaño del compositor no cambian: el texto sigue siendo el mismo estado.
 */
object PasteImages {
    /** Carácter de uso privado: nunca queda en el texto ni se envía. */
    const val MARKER = ""
    val MIME_TYPES = arrayOf("image/png", "image/jpeg", "image/webp", "image/gif", "image/*")

    /** URIs de imagen del clip (por el tipo del clip o, si es genérico, el del proveedor). */
    fun imageUris(clip: ClipData?, resolver: ContentResolver?): List<Uri> {
        if (clip == null) return emptyList()
        val desc = clip.description
        val declared = (0 until desc.mimeTypeCount).any { desc.getMimeType(it).startsWith("image/") }
        return (0 until clip.itemCount).mapNotNull { i ->
            val u = clip.getItemAt(i).uri ?: return@mapNotNull null
            val type = runCatching { resolver?.getType(u) }.getOrNull()
            if (type?.startsWith("image/") == true || (type == null && declared)) u else null
        }
    }

    /** El clip trae una imagen y ningún texto: el menú debe ofrecer «Pegar» y pegar la imagen. */
    fun isImageOnly(clip: ClipData?, resolver: ContentResolver?): Boolean {
        if (clip == null || clip.itemCount == 0) return false
        val hasText = (0 until clip.itemCount).any { !clip.getItemAt(it).text.isNullOrEmpty() } ||
            clip.description.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) && clip.getItemAt(0).uri == null
        return !hasText && imageUris(clip, resolver).isNotEmpty()
    }

    /** Quita los marcadores del texto nuevo; devuelve el texto limpio, la selección corregida y si había alguno. */
    fun strip(text: String, cursor: Int): Triple<String, Int, Boolean> {
        if (!text.contains(MARKER)) return Triple(text, cursor, false)
        val before = text.substring(0, cursor.coerceIn(0, text.length)).count { it.toString() == MARKER }
        return Triple(text.replace(MARKER, ""), (cursor - before).coerceAtLeast(0), true)
    }
}

/**
 * Envuelve el campo del compositor: [onImages] recibe las imágenes pegadas (menú o teclado) y [done] se llama
 * cuando ya se copiaron (suelta el permiso temporal del teclado).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun RichPasteScope(enabled: Boolean, onImages: (List<Uri>, done: () -> Unit) -> Unit, content: @Composable () -> Unit) {
    // Siempre la misma estructura (cambiar de rama recrearía el campo y perdería el foco); [enabled] se lee al pegar.
    val on by rememberUpdatedState(enabled)
    val resolver = LocalContext.current.contentResolver
    val real = LocalClipboard.current
    val latest by rememberUpdatedState(onImages)
    val clipboard = remember(real, resolver) {
        object : Clipboard {
            override suspend fun getClipEntry(): ClipEntry? {
                val e = real.getClipEntry()
                val clip = e?.clipData
                return if (on && PasteImages.isImageOnly(clip, resolver)) ClipEntry(ClipData.newPlainText("image", PasteImages.MARKER)) else e
            }
            override suspend fun setClipEntry(clipEntry: ClipEntry?) = real.setClipEntry(clipEntry)
            override val nativeClipboard get() = real.nativeClipboard
        }
    }
    val interceptor = remember {
        object : PlatformTextInputInterceptor {
            override suspend fun interceptStartInputMethod(request: PlatformTextInputMethodRequest, nextHandler: PlatformTextInputSession): Nothing =
                nextHandler.startInputMethod(object : PlatformTextInputMethodRequest {
                    override fun createInputConnection(outAttributes: EditorInfo): InputConnection {
                        val ic = request.createInputConnection(outAttributes)
                        EditorInfoCompat.setContentMimeTypes(outAttributes, PasteImages.MIME_TYPES)
                        return InputConnectionCompat.createWrapper(ic, outAttributes) { info, flags, _ ->
                            if (!on) return@createWrapper false
                            val grant = flags and InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0
                            if (grant && runCatching { info.requestPermission() }.isFailure) return@createWrapper false
                            val type = (0 until info.description.mimeTypeCount).map { info.description.getMimeType(it) }
                            if (type.none { it.startsWith("image/") }) { if (grant) info.releasePermission(); return@createWrapper false }
                            latest(listOf(info.contentUri)) { if (grant) runCatching { info.releasePermission() } }
                            true
                        }
                    }
                })
        }
    }
    CompositionLocalProvider(LocalClipboard provides clipboard) {
        InterceptPlatformTextInput(interceptor) { content() }
    }
}
