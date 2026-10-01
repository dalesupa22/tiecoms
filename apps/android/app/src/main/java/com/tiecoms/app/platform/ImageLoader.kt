package com.tiecoms.app.platform

import android.content.Context
import android.graphics.BitmapFactory
import android.os.Build
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.tiecoms.app.core.Media
import com.tiecoms.app.core.await
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import okhttp3.Cache
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Cargador liviano de imágenes públicas (fotos de perfil /api/v1/avatars/…, miniaturas /api/v1/previews/…):
 * caché en memoria (LRU por bytes), caché HTTP en disco de OkHttp (respeta las cabeceras del API),
 * una sola descarga por URL a la vez y reducción al decodificar. Sin dependencias nuevas.
 */
class ImageLoader(context: Context, base: OkHttpClient) {
    /** Byte-array requests only; no private images are retained by Coil after leaving a viewer. */
    val animations = coil.ImageLoader.Builder(context)
        .components {
            if (Build.VERSION.SDK_INT >= 28) add(coil.decode.ImageDecoderDecoder.Factory())
            else add(coil.decode.GifDecoder.Factory())
        }.memoryCache(null).diskCache(null).build()
    private val uncachedHttp = base.newBuilder().cache(null).build()
    private val http = base.newBuilder().cache(Cache(File(context.cacheDir, "images"), 40L * 1024 * 1024))
        // Velocidad (1.7.0): las fotos de perfil (/avatars/<uuid>) son inmutables (una foto nueva = una URL nueva):
        // se guardan en disco un año y se sirven sin red, aunque el servidor no mande cabeceras de caché.
        .addNetworkInterceptor { chain ->
            val r = chain.proceed(chain.request())
            if (r.isSuccessful && isAvatar(chain.request().url.encodedPath))
                r.newBuilder().removeHeader("pragma").header("cache-control", "public, max-age=31536000, immutable").build()
            else r
        }
        .build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val memory = object : LruCache<String, ImageBitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }
    private val inFlight = ConcurrentHashMap<String, Deferred<ImageBitmap?>>()
    /** URLs que fallaron hace poco: no se reintentan en cada recomposición. */
    private val failedAt = ConcurrentHashMap<String, Long>()

    private fun key(url: String, px: Int) = "$url#$px"

    companion object {
        fun isAvatar(path: String) = path.contains("/avatars/")
    }

    fun cached(url: String, px: Int): ImageBitmap? = memory.get(key(url, px))

    /** Bounded authenticated bytes; once-only signed URLs bypass every disk/memory cache. */
    suspend fun loadBytes(url: String, bearer: String?, private: Boolean = false): ByteArray? {
        val transport = if (private) uncachedHttp else http
        return try {
            transport.newCall(Request.Builder().url(url).apply {
                if (bearer != null) header("authorization", "Bearer $bearer")
                if (private) header("cache-control", "no-store")
            }.build()).await().use { response ->
                if (!response.isSuccessful) return@use null
                val body = response.body ?: return@use null
                val max = com.tiecoms.app.core.Attachments.MAX_BYTES
                if (body.contentLength() > max) return@use null
                body.byteStream().use { input ->
                    val out = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (out.size().toLong() + read > max) return@use null
                        out.write(buffer, 0, read)
                    }
                    out.toByteArray()
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { null }
    }

    /** [bearer]: para imágenes protegidas (adjuntos y sus miniaturas). */
    suspend fun load(url: String, px: Int, bearer: String? = null): ImageBitmap? {
        val k = key(url, px)
        memory.get(k)?.let { return it }
        failedAt[k]?.let { if (System.currentTimeMillis() - it < 60_000) return null }
        val fresh = scope.async(start = CoroutineStart.LAZY) {
                try {
                    val bytes = http.newCall(Request.Builder().url(url).apply { if (bearer != null) header("authorization", "Bearer $bearer") }.build()).await().use { r -> if (r.isSuccessful) r.body?.bytes() else null }
                    val img = bytes?.let { decode(it, px) }
                    if (img != null) { memory.put(k, img); failedAt.remove(k) } else failedAt[k] = System.currentTimeMillis()
                    img
                } catch (_: Exception) {
                    failedAt[k] = System.currentTimeMillis(); null
                } finally { inFlight.remove(k) }
        }
        val job = inFlight.putIfAbsent(k, fresh) ?: fresh.also { it.start() }
        if (job !== fresh) fresh.cancel()
        return job.await()
    }

    private fun decode(bytes: ByteArray, px: Int): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = Media.sampleSize(bounds.outWidth, bounds.outHeight, px.coerceAtLeast(1)) }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
    }
}
