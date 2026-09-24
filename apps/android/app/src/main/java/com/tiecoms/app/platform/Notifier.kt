package com.tiecoms.app.platform

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.tiecoms.app.MainActivity
import com.tiecoms.app.R

/** Notificaciones locales de mensajes (canal "Mensajes" con el sonido tc_notify). */
class Notifier(private val context: Context) {
    companion object {
        const val CHANNEL_ID = "messages"
    }

    private val soundUri: Uri = Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${context.packageName}/${R.raw.tc_notify}")

    fun ensureChannel() {
        val nm = context.getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(CHANNEL_ID, context.getString(R.string.notif_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.notif_channel_desc)
            setSound(
                soundUri,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
        }
        nm.createNotificationChannel(ch)
    }

    fun enabled(): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** [silent]: con la app abierta el sonido lo pone SoundPool (o está desactivado en Ajustes). */
    fun showMessage(conversationId: String, title: String, text: String, silent: Boolean) {
        if (!enabled()) return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("tiecoms://c/$conversationId"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(context, conversationId.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_tiecoms)
            .setColor(0xFFFF7A00.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setSilent(silent)
            .setContentIntent(pi)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(conversationId.hashCode(), n)
        } catch (e: SecurityException) {
            Log.w("TieComs", "Sin permiso de notificaciones")
        }
    }

    fun cancel(conversationId: String) = NotificationManagerCompat.from(context).cancel(conversationId.hashCode())
}

/**
 * Punto de extensión para push remoto (FCM). El backend aún no tiene endpoint de
 * registro de dispositivos: esta implementación solo conserva el token localmente.
 * Cuando exista (p. ej. POST /api/v1/devices/push {token, platform:"android"}),
 * se implementa [register] y se agrega la dependencia de Firebase Messaging.
 */
interface PushRegistrar {
    fun onToken(token: String)
    suspend fun register() {}
}

class NoopPushRegistrar : PushRegistrar {
    @Volatile var lastToken: String? = null
        private set
    override fun onToken(token: String) { lastToken = token }
}
