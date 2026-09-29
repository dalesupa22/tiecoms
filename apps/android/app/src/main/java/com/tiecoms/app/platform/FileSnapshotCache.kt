package com.tiecoms.app.platform

import android.content.Context
import com.tiecoms.app.core.SnapshotCache
import java.io.File
import java.security.MessageDigest
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/**
 * Copia local de la sesión (velocidad, 1.7.0): un archivo gzip por usuario y servidor en noBackupFilesDir
 * (privado de la app, fuera de los respaldos). Escritura atómica: temporal + rename. Se borra al cerrar sesión.
 */
class FileSnapshotCache(context: Context, private val server: String) : SnapshotCache {
    private val dir = File(context.noBackupFilesDir, "snapshots")

    private fun file(userId: String): File {
        val h = MessageDigest.getInstance("SHA-256").digest("$server|$userId".toByteArray()).joinToString("") { "%02x".format(it) }.take(24)
        return File(dir, "$h.json.gz")
    }

    override fun read(userId: String): String? = file(userId).takeIf { it.isFile }?.let { f ->
        runCatching { GZIPInputStream(f.inputStream().buffered()).use { it.readBytes().toString(Charsets.UTF_8) } }.getOrNull()
    }

    override fun write(userId: String, json: String) {
        dir.mkdirs()
        val target = file(userId)
        val tmp = File(dir, target.name + ".tmp")
        GZIPOutputStream(tmp.outputStream().buffered()).use { it.write(json.toByteArray(Charsets.UTF_8)) }
        if (!tmp.renameTo(target)) { target.delete(); tmp.renameTo(target) }
    }

    override fun clear(userId: String?) {
        if (userId != null) file(userId).delete() else dir.listFiles()?.forEach { it.delete() }
    }
}
