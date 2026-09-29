package com.tiecoms.app.platform

import android.app.Activity
import android.os.Process
import android.os.SystemClock
import android.os.Trace
import android.util.Log

/**
 * Marcas de velocidad (fase 2 de 1.7.0): «lista a la vista» en frío (reportFullyDrawn, que mide
 * Macrobenchmark como timeToFullDisplay) y «tocar un chat → mensajes». Se leen en logcat con la
 * etiqueta TcPerf y como secciones de traza (Perfetto / TraceSectionMetric). Cuestan un Log por evento.
 */
object Perf {
    const val TAG = "TcPerf"
    @Volatile private var listReported = false
    @Volatile var chatTapAt = 0L

    fun sinceProcessStart(): Long = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()

    /** Primer fotograma con la lista de conversaciones (una vez por proceso). */
    fun listDrawn(activity: Activity?, fromCache: Boolean) {
        if (listReported) return
        listReported = true
        activity?.reportFullyDrawn()
        Log.i(TAG, "list ${sinceProcessStart()} ms cache=$fromCache")
    }

    fun chatTapped() {
        chatTapAt = SystemClock.uptimeMillis()
        Trace.beginAsyncSection("tcOpenChat", 1)
    }

    /** Primer fotograma con mensajes del chat abierto. */
    fun chatDrawn(conversationId: String, enteredAt: Long, fromMemory: Boolean) {
        val now = SystemClock.uptimeMillis()
        val tap = chatTapAt.takeIf { it in 1..enteredAt }?.let { now - it }
        chatTapAt = 0L
        Trace.endAsyncSection("tcOpenChat", 1)
        Log.i(TAG, "chat ${conversationId.take(8)} tap=${tap ?: -1} ms screen=${now - enteredAt} ms memory=$fromMemory")
    }
}
