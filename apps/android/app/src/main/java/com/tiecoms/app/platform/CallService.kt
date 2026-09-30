package com.tiecoms.app.platform

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.tiecoms.app.MainActivity
import com.tiecoms.app.R
import com.tiecoms.app.container
import com.tiecoms.app.core.CallDTO
import kotlinx.coroutines.launch

/**
 * Servicio en primer plano mientras hay una llamada (docs/LLAMADAS.md): tipo micrófono (y cámara si hay permiso),
 * con su notificación «Llamada en curso» y el botón Colgar. Así la llamada sigue con la app en segundo plano.
 */
class CallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_HANG_UP) {
            val c = applicationContext.container
            c.scope.launch { runCatching { c.calls.hangUp() } }
            return START_NOT_STICKY
        }
        val view = applicationContext.container.calls.view.value
        if (view == null) { stopSelf(); return START_NOT_STICKY }
        ensureChannel(this)
        val title = applicationContext.container.conversationName(view.call.conversationId).ifBlank { getString(R.string.call_title) }
        // 1.7.4: como invitado no hay chat: tocar la notificación vuelve a la pantalla de la llamada por enlace.
        val openUri = view.guest?.let { "chaggu://llamada/${Uri.encode(it.token)}" } ?: "chaggu://c/${view.call.conversationId}"
        val hangUp = PendingIntent.getService(this, 1, Intent(this, CallService::class.java).setAction(ACTION_HANG_UP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val open = PendingIntent.getActivity(this, 2, Intent(Intent.ACTION_VIEW, Uri.parse(openUri), this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val person = Person.Builder().setName(title).setImportant(true).build()
        val n = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_chaggu).setColor(0xFFFF5A36.toInt())
            .setContentTitle(getString(R.string.call_notif_ongoing)).setContentText(getString(R.string.call_notif_tap))
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setUsesChronometer(true).setWhen(runCatching { java.time.Instant.parse(view.call.startedAt).toEpochMilli() }.getOrDefault(System.currentTimeMillis()))
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUp))
            .build()
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        // 1.7.1: tipo cámara solo mientras mi cámara está prendida (se vuelve a llamar al prenderla o apagarla).
        if (view.camera && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        val ok = runCatching {
            ServiceCompat.startForeground(this, NOTIF_ID, n, if (Build.VERSION.SDK_INT >= 30) types else 0)
        }
        // Sin permiso del micrófono (o desde segundo plano) Android no deja: la llamada sigue mientras la app esté abierta.
        if (ok.isFailure) stopSelf()
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Deslizar la app fuera de recientes cuelga (si no, el servidor la saca al dejar de latir, 75 s).
        val c = applicationContext.container
        c.scope.launch { runCatching { c.calls.hangUp() } }
        super.onTaskRemoved(rootIntent)
    }

    companion object {
        const val CHANNEL = "calls"
        const val EXTRA_RINGING = "ringing"
        const val EXTRA_CALL = "callId"
        private const val NOTIF_ID = 7301
        private const val ACTION_HANG_UP = "com.tiecoms.app.CALL_HANG_UP"

        fun ensureChannel(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.call_notif_channel), NotificationManager.IMPORTANCE_HIGH).apply {
                description = ctx.getString(R.string.call_notif_channel_desc)
            })
        }

        fun start(ctx: Context) {
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
            runCatching { ContextCompat.startForegroundService(ctx, Intent(ctx, CallService::class.java)) }
        }

        fun stop(ctx: Context) { runCatching { ctx.stopService(Intent(ctx, CallService::class.java)) } }

        /** Canal del aviso de llamada con MI tono (Android fija el sonido por canal): calls_ring_<tono>. */
        private fun ringChannel(ctx: Context, ringtone: String): String {
            val id = "calls_ring_" + com.tiecoms.app.core.Sounds.ringtone(ringtone)
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(id) == null) {
                val attrs = android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
                runCatching { nm.createNotificationChannel(NotificationChannel(id, ctx.getString(R.string.call_notif_incoming_channel, SoundFiles.ringLabel(ctx, com.tiecoms.app.core.Sounds.ringtone(ringtone))), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = ctx.getString(R.string.call_notif_channel_desc)
                    setSound(SoundFiles.uri(ctx, SoundFiles.ring(ringtone)), attrs)
                    enableVibration(true); vibrationPattern = longArrayOf(0, 800, 600, 800)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }) }
            }
            return id
        }

        /**
         * Te llaman con la app en segundo plano o cerrada (push TC_CALL o `call.ringing` con el socket vivo):
         * alta prioridad con Contestar / Ahora no, pantalla completa si está permitido y mi tono repetido (FLAG_INSISTENT).
         */
        fun notifyIncoming(ctx: Context, call: CallDTO, callerName: String, title: String?) {
            ensureChannel(ctx)
            val ringtone = runCatching { ctx.container.client.value.state.value.data?.me?.ringtone }.getOrNull()
            fun activity(code: Int, uri: String, extra: Boolean = false) = PendingIntent.getActivity(ctx, code,
                Intent(Intent.ACTION_VIEW, Uri.parse(uri), ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .apply { if (extra) putExtra(EXTRA_RINGING, true) },
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val answer = activity(call.id.hashCode() + 1, "chaggu://call/${call.id}")
            val open = activity(call.id.hashCode(), "chaggu://c/${call.conversationId}", extra = true)
            val decline = PendingIntent.getBroadcast(ctx, call.id.hashCode() + 2, Intent(ctx, CallDeclineReceiver::class.java).putExtra(EXTRA_CALL, call.id),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val nm = ctx.getSystemService(NotificationManager::class.java)
            val fullScreen = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent()
            val person = Person.Builder().setName(callerName.ifBlank { ctx.getString(R.string.call_title) }).setImportant(true).build()
            val n = NotificationCompat.Builder(ctx, ringChannel(ctx, ringtone ?: ""))
                .setSmallIcon(R.drawable.ic_stat_chaggu).setColor(0xFFFF5A36.toInt())
                .setContentTitle((if (call.isVideo) "🎥 " else "📞 ") + ctx.getString(R.string.call_notif_incoming, callerName))
                .setContentText(title?.let { ctx.getString(R.string.call_incoming_in, it) } ?: ctx.getString(R.string.call_incoming))
                .setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true).setOngoing(true).setContentIntent(open).setTimeoutAfter(com.tiecoms.app.core.Calls.RING_MS)
                .addAction(R.drawable.ic_stat_chaggu, ctx.getString(R.string.call_decline), decline)
                .addAction(R.drawable.ic_stat_chaggu, ctx.getString(R.string.call_answer), answer)
                .apply { if (fullScreen) setFullScreenIntent(open, true) }
                .addPerson(person)
                .build()
            n.flags = n.flags or android.app.Notification.FLAG_INSISTENT
            runCatching { NotificationManagerCompat.from(ctx).notify("call:" + call.id, 1, n) }
        }

        fun cancelIncoming(ctx: Context, callId: String) { runCatching { NotificationManagerCompat.from(ctx).cancel("call:$callId", 1) } }
    }
}

/** «Ahora no» del aviso de llamada: deja de sonar sin abrir la app. */
class CallDeclineReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(CallService.EXTRA_CALL) ?: return
        // 1.7.1: POST /calls/:id/decline — mis otros dispositivos también dejan de sonar.
        context.container.calls.decline(id)
    }
}
