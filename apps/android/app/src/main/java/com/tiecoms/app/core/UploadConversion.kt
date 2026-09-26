package com.tiecoms.app.core

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Conversión segura de un adjunto antes de subirlo (fotos reducidas, 1.6.2). Sin Android para probarla en la JVM.
 *  - Cada conversión escribe en su propio temporal único (File.createTempFile) y, si sale bien, lo mueve de forma
 *    atómica a otro nombre único: dos fotos del mismo lote con el mismo nombre visible (o foo.png y foo.jpg) nunca
 *    comparten archivo ni se pisan.
 *  - Si la conversión falla o no conviene (vacía o no más liviana), se borra solo el temporal propio y ese adjunto
 *    sigue con su original; nada más del lote se toca.
 *  - El nombre visible (cabecera x-file-name) es aparte: «foo.jpg».
 */
object UploadConversion {
    /**
     * [encode] escribe la versión nueva en el archivo que recibe y devuelve false si no pudo.
     * Devuelve el adjunto convertido, o [f] tal cual si no hubo conversión.
     */
    fun convert(f: Attachments.Shared, visibleName: String, contentType: String, encode: (File) -> Boolean): Attachments.Shared {
        val src = File(f.path)
        val dir = src.parentFile ?: return f
        val tmp = runCatching { File.createTempFile("up-", ".part", dir) }.getOrNull() ?: return f
        val ok = runCatching { encode(tmp) }.getOrDefault(false)
        if (!ok || tmp.length() <= 0L || tmp.length() >= src.length()) { tmp.delete(); return f }
        val dest = runCatching { File.createTempFile("up-", ".jpg", dir) }.getOrNull() ?: run { tmp.delete(); return f }
        val moved = runCatching { Files.move(tmp.toPath(), dest.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING) }.isSuccess ||
            runCatching { Files.move(tmp.toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING) }.isSuccess
        if (!moved) { tmp.delete(); dest.delete(); return f }
        // El original de este adjunto (nuestra copia en caché) ya no hace falta; solo el suyo.
        src.delete()
        return Attachments.Shared(visibleName, contentType, dest.length(), dest.absolutePath)
    }

    /** «IMG 01.PNG» → «IMG 01.jpg»; sin nombre → «foto.jpg». */
    fun jpgName(name: String): String = name.substringBeforeLast('.').ifBlank { "foto" } + ".jpg"
}
