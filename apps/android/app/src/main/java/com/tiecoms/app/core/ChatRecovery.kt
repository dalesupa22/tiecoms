package com.tiecoms.app.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Recuperación de la carga de un chat ante fallos transitorios (incidencia 28-sep-2026: un 502 del proxy
 * mientras se reemplazaba el API dejaba «bad gateway» en pantalla hasta que la persona salía y volvía).
 *
 * Reintenta con espera 1, 2, 4, 8 y 15 s (≈30 s en total) ante red o 5xx, y antes si el socket vuelve a
 * estar en línea. Un error permanente (403, 404…) no se reintenta: la pantalla muestra su mensaje.
 */
object ChatRecovery {
    val BACKOFF_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000)

    enum class Kind {
        /** Sin red, tiempo agotado, 401 sin poder renovar, 408 o 429: «Reconectando…». */
        NETWORK,
        /** 5xx (502/503/504 durante un despliegue): «chaggu se está actualizando, reintentando…». */
        UPDATING,
        /** 403, 404, validación: se muestra el mensaje del servidor. */
        PERMANENT,
    }

    fun kind(e: Throwable): Kind = when {
        e is NetworkException -> Kind.NETWORK
        e is ApiException && e.status >= 500 -> Kind.UPDATING
        // 401: la renovación del token también pudo chocar con el despliegue; si la sesión de verdad
        // terminó, el cliente cierra sesión y esta pantalla desaparece.
        e is ApiException && (e.status == 401 || e.status == 408 || e.status == 429) -> Kind.NETWORK
        else -> Kind.PERMANENT
    }

    fun transient(e: Throwable): Boolean = kind(e) != Kind.PERMANENT

    /**
     * Ejecuta [attempt]; ante un error transitorio avisa [onRetrying] (tipo y número de reintento, desde 0),
     * espera con [wait] y repite. Tras agotar [BACKOFF_MS], o ante un error permanente, lanza el error.
     */
    suspend fun <T> withRetry(
        attempt: suspend () -> T,
        onRetrying: (Kind, Int) -> Unit = { _, _ -> },
        wait: suspend (Long) -> Unit,
    ): T {
        var i = 0
        while (true) {
            try {
                return attempt()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                val k = kind(e)
                if (k == Kind.PERMANENT || i >= BACKOFF_MS.size) throw e
                onRetrying(k, i)
                wait(BACKOFF_MS[i])
                i++
            }
        }
    }

    /**
     * Espera [ms], o menos si el socket pasa a en línea: al volver la conexión (el API ya respondió al
     * handshake) se reintenta enseguida. Si ya está en línea, solo cuenta el tiempo.
     */
    suspend fun waitOrOnline(ms: Long, state: StateFlow<ClientState>) {
        withTimeoutOrNull(ms) {
            if (state.value.connection == ConnectionStatus.ONLINE) awaitCancellation()
            state.first { it.connection == ConnectionStatus.ONLINE }
        }
    }
}
