package com.tiecoms.app.core

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Error del API con su código (`unauthorized`, `forbidden`, `not_found`…). */
class ApiException(val status: Int, val code: String, message: String, val details: JsonElement? = null) : Exception(message) {
    /** No se arregla reintentando (permiso, validación, conflicto). */
    val permanent: Boolean get() = status in 400..499 && status != 401 && status != 408 && status != 429
}

/** Sin red o el servidor no respondió. */
class NetworkException(cause: Throwable) : IOException(cause.message, cause)

data class HttpResult(val code: Int, val body: String) {
    val ok get() = code in 200..299
}

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(NetworkException(e)) }
        override fun onResponse(call: Call, response: Response) { cont.resume(response) }
    })
}

/** Capa HTTP mínima: agrega los encabezados del contrato y devuelve código + cuerpo. */
class HttpApi(val baseUrl: String, private val client: OkHttpClient) {
    init {
        require(baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) { "URL inválida" }
        baseUrl.toHttpUrl()
    }

    /** Rutas relativas a /api/v1, salvo las que ya empiezan por /api/ (p. ej. [AUTH_BASE_PATH]). */
    fun url(path: String) = baseUrl.trimEnd('/') + (if (path.startsWith("/api/")) path else "/api/v1$path")

    fun socketUrl(): String {
        val base = baseUrl.trimEnd('/')
        val ws = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            else -> "ws://" + base.removePrefix("http://")
        }
        return "$ws/api/socket.io/?EIO=4&transport=websocket"
    }

    /** Cliente para subidas (fotos y archivos de hasta 25 MB): más margen que las peticiones normales. */
    private val uploadClient: OkHttpClient by lazy {
        client.newBuilder().writeTimeout(java.time.Duration.ofMinutes(3)).readTimeout(java.time.Duration.ofMinutes(3)).build()
    }

    /**
     * Cuerpo crudo (foto de perfil, archivos) en vez de JSON. Con [file] se transmite desde disco sin cargarlo en
     * memoria y [onProgress] recibe (enviados, total) mientras sube.
     */
    class RawBody(
        val bytes: ByteArray, val contentType: String, val headers: Map<String, String> = emptyMap(),
        val file: java.io.File? = null, val onProgress: ((Long, Long) -> Unit)? = null,
    )

    private class FileBody(private val file: java.io.File, private val type: String, private val onProgress: ((Long, Long) -> Unit)?) : okhttp3.RequestBody() {
        override fun contentType() = type.toMediaType()
        override fun contentLength() = file.length()
        override fun writeTo(sink: okio.BufferedSink) {
            val total = file.length(); var sent = 0L
            file.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf); if (n < 0) break
                    sink.write(buf, 0, n); sent += n; onProgress?.invoke(sent, total)
                }
            }
        }
    }

    /** Descarga autenticada a [dest] (adjuntos). Devuelve el código HTTP; el archivo solo queda si fue 2xx. */
    suspend fun download(path: String, token: String?, dest: java.io.File, onProgress: ((Long, Long) -> Unit)? = null): Int {
        val b = Request.Builder().url(url(path)).header("x-tiecoms-client", PLATFORM).header("x-tiecoms-contract", CONTRACT_VERSION)
        if (token != null) b.header("authorization", "Bearer $token")
        uploadClient.newCall(b.get().build()).await().use { res ->
            if (!res.isSuccessful) return res.code
            val body = res.body ?: return res.code
            val total = body.contentLength()
            val tmp = java.io.File(dest.parentFile, dest.name + ".part")
            try {
                body.byteStream().use { input -> tmp.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024); var got = 0L
                    while (true) { val n = input.read(buf); if (n < 0) break; out.write(buf, 0, n); got += n; onProgress?.invoke(got, total) }
                } }
            } catch (e: IOException) { tmp.delete(); throw NetworkException(e) }
            if (!tmp.renameTo(dest)) { tmp.copyTo(dest, overwrite = true); tmp.delete() }
            return res.code
        }
    }

    suspend fun exec(method: String, path: String, json: String? = null, token: String? = null, raw: RawBody? = null): HttpResult {
        val b = Request.Builder().url(url(path))
            .header("x-tiecoms-client", PLATFORM)
            .header("x-tiecoms-contract", CONTRACT_VERSION)
            .header("accept", "application/json")
        if (token != null) b.header("authorization", "Bearer $token")
        raw?.headers?.forEach { (k, v) -> b.header(k, v) }
        val body = when {
            raw?.file != null -> FileBody(raw.file, raw.contentType, raw.onProgress)
            raw != null -> raw.bytes.toRequestBody(raw.contentType.toMediaType())
            json != null -> json.toRequestBody(JSON_MEDIA)
            method == "POST" -> "{}".toRequestBody(JSON_MEDIA)
            else -> null
        }
        b.method(method, body)
        (if (raw != null) uploadClient else client).newCall(b.build()).await().use { res ->
            val text = try { res.body?.string() ?: "" } catch (e: IOException) { throw NetworkException(e) }
            return HttpResult(res.code, text)
        }
    }

    companion object {
        fun parseError(r: HttpResult): ApiException {
            val body = runCatching { TcJson.decodeFromString(ApiErrorBody.serializer(), r.body) }.getOrNull()?.error
            return ApiException(r.code, body?.code?.ifEmpty { null } ?: "http_${r.code}", body?.message?.ifEmpty { null } ?: "HTTP ${r.code}", body?.details)
        }
    }
}
