package com.tiecoms.app.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.tiecoms.app.container
import com.tiecoms.app.core.PushPayload
import com.tiecoms.app.core.PushRegistrationCoordinator
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlinx.coroutines.withTimeoutOrNull

/** ¿Hay Firebase configurado? (solo si el build incluyó google-services.json). */
object PushSetup {
    fun available(ctx: Context): Boolean = runCatching { FirebaseApp.getApps(ctx).isNotEmpty() || FirebaseApp.initializeApp(ctx) != null }.getOrDefault(false)

    private val registration = PushRegistrationCoordinator()

    /** Retry briefly; session restoration, foreground and network recovery trigger later attempts. */
    suspend fun register(ctx: Context) {
        val container = ctx.container
        if (!container.notifier.enabled() || container.client.value.state.value.status != SessionStatus.READY) return
        if (!available(ctx)) { Log.i("TieComs", "Push desactivado: falta google-services.json"); return }
        registration.synchronize(
            allowed = { container.notifier.enabled() && container.client.value.state.value.status == SessionStatus.READY },
            reportFailure = { Log.w("TieComs", "No se registró el token push; se reintentará") },
            attempt = {
                withTimeout(10_000) {
                    val token = suspendCancellableCoroutine<String> { continuation ->
                        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                            if (continuation.isActive) {
                                if (task.isSuccessful) continuation.resume(task.result)
                                else continuation.resumeWith(Result.failure(task.exception ?: IllegalStateException("FCM token unavailable")))
                            }
                        }
                    }
                    if (!container.notifier.enabled() || container.client.value.state.value.status != SessionStatus.READY) return@withTimeout
                    val lang = if (java.util.Locale.getDefault().language == "es") "es" else "en"
                    container.push.onToken(token)
                    container.client.value.registerPushToken(token, lang)
                }
            },
        )
    }
}

/** Recibe los mensajes de datos de FCM y arma la notificación con MessagingStyle (app cerrada o en segundo plano). */
class TcMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        container.push.onToken(token)
        container.retryPushRegistration()
    }

    override fun onMessageReceived(message: RemoteMessage) = handle(applicationContext, message.data)

    companion object {
        /** Punto de entrada probable desde pruebas: mismo camino que un push real. */
        fun handle(ctx: Context, data: Map<String, String>) {
            val msg = PushPayload.parse(data) ?: return
            ctx.container.showPush(msg)
        }
    }
}

/** Acciones de la notificación: Responder (RemoteInput) y Marcar como leído, sin abrir la app. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val conv = intent.getStringExtra(Notifier.EXTRA_CONVERSATION) ?: return
        val c = context.container
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.Default).launch {
            try {
                val client = c.client.value
                // Con la app cerrada, el cliente reanuda la sesión guardada antes de actuar.
                withTimeoutOrNull(10_000) { client.state.first { it.status == SessionStatus.READY } }
                when (intent.action) {
                    Notifier.ACTION_REPLY -> {
                        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()?.trim()
                        if (!text.isNullOrEmpty()) {
                            client.send(conv, text)
                            val meta = client.meta(conv)
                            c.notifier.appendMine(conv, c.conversationName(conv), meta != null && meta.kind != "direct", text)
                        }
                    }
                    Notifier.ACTION_MARK_READ -> { runCatching { client.markConversationRead(conv) }; c.notifier.cancel(conv) }
                }
            } finally { pending.finish() }
        }
    }
}
