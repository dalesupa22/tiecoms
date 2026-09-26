package com.tiecoms.app.platform

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.tiecoms.app.BubbleActivity
import com.tiecoms.app.MainActivity
import com.tiecoms.app.R
import java.util.concurrent.ConcurrentHashMap

/**
 * Notificaciones de mensajes estilo conversación (SPEC-v3 §6): MessagingStyle con la persona y su foto,
 * shortcut de conversación con LocusId (Android 11+ la pone en «Conversaciones»), burbuja, acciones
 * Responder (RemoteInput) y Marcar como leído, canal «Mensajes» con tc_notify y badge.
 * La usan igual el socket (app viva) y FCM (app cerrada); [shown] evita duplicados por messageId.
 */
class Notifier(private val context: Context) {
    companion object {
        const val CHANNEL_ID = "messages"
        const val CHANNEL_REMINDERS = "reminders"
        const val CHANNEL_EVENTS = "events"
        const val CHANNEL_SOON = "event_soon"
        const val ACTION_REPLY = "com.tiecoms.app.REPLY"
        const val ACTION_MARK_READ = "com.tiecoms.app.MARK_READ"
        const val EXTRA_CONVERSATION = "conversationId"
        const val KEY_REPLY = "reply"
        private const val HISTORY = 6
    }

    private val soundUri: Uri = Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${context.packageName}/${R.raw.tc_notify}")
    /** Últimos mensajes por conversación para el historial del MessagingStyle. */
    private val history = ConcurrentHashMap<String, ArrayDeque<Line>>()
    private val shown = java.util.Collections.synchronizedSet(LinkedHashSet<String>())

    data class Line(val authorKey: String, val authorName: String, val text: String, val at: Long, val icon: Bitmap?)

    /** Canales: Mensajes (con burbujas), Recordatorios y Reuniones; todos con el sonido tc_notify. */
    fun ensureChannel() {
        val nm = context.getSystemService(NotificationManager::class.java)
        val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        fun channel(id: String, name: Int, desc: Int) = NotificationChannel(id, context.getString(name), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(desc)
            setSound(soundUri, attrs)
            enableVibration(true)
            setShowBadge(true)
        }
        nm.createNotificationChannels(listOf(
            channel(CHANNEL_ID, R.string.notif_channel_messages, R.string.notif_channel_messages_desc).apply { if (Build.VERSION.SDK_INT >= 29) setAllowBubbles(true) },
            channel(CHANNEL_REMINDERS, R.string.notif_channel_reminders, R.string.notif_channel_reminders_desc),
            channel(CHANNEL_EVENTS, R.string.notif_channel_events, R.string.notif_channel_events_desc),
            channel(CHANNEL_SOON, R.string.cal_channel_soon, R.string.cal_channel_soon_desc),
        ))
    }

    fun enabled(): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** true la primera vez que se ve este messageId (socket y FCM no duplican). */
    fun firstTime(messageId: String?): Boolean {
        if (messageId == null) return true
        synchronized(shown) {
            if (!shown.add(messageId)) return false
            while (shown.size > 300) shown.remove(shown.first())
        }
        return true
    }

    private fun openIntent(uri: String, code: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun actionIntent(action: String, conversationId: String, mutable: Boolean): PendingIntent {
        val i = Intent(context, NotificationActionReceiver::class.java).setAction(action).putExtra(EXTRA_CONVERSATION, conversationId)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (mutable && Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, (action + conversationId).hashCode(), i, flags)
    }

    private fun icon(b: Bitmap?, name: String): IconCompat = b?.let { IconCompat.createWithAdaptiveBitmap(circleSafe(it)) } ?: IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
    private fun circleSafe(b: Bitmap): Bitmap = if (b.width == b.height) b else Bitmap.createScaledBitmap(b, minOf(b.width, b.height), minOf(b.width, b.height), true)

    /**
     * Mensaje de una conversación. [title]: nombre del chat (grupos) o de la persona (directos);
     * [isGroup]: usa título de conversación en el MessagingStyle; [author]: quien escribió.
     */
    fun showConversation(
        conversationId: String, title: String, isGroup: Boolean, authorKey: String, authorName: String, text: String,
        authorIcon: Bitmap?, silent: Boolean, badge: Int, messageId: String? = null, seq: Long? = null,
        /** Al tocar: otro destino (sidechat → su conversación de origen con el sidechat desplegado). */
        openUri: String? = null,
    ) {
        if (!enabled()) return
        val lines = history.getOrPut(conversationId) { ArrayDeque() }
        synchronized(lines) {
            lines.addLast(Line(authorKey, authorName, text, System.currentTimeMillis(), authorIcon))
            while (lines.size > HISTORY) lines.removeFirst()
        }
        val me = Person.Builder().setName(context.getString(R.string.notif_you)).setKey("me").build()
        val style = NotificationCompat.MessagingStyle(me).setGroupConversation(isGroup)
        if (isGroup) style.setConversationTitle(title)
        synchronized(lines) {
            lines.forEach { l ->
                val p = if (l.authorKey == "me") null else Person.Builder().setName(l.authorName).setKey(l.authorKey).setIcon(icon(l.icon, l.authorName)).build()
                style.addMessage(NotificationCompat.MessagingStyle.Message(l.text, l.at, p))
            }
        }
        val shortcutIcon = if (isGroup) IconCompat.createWithResource(context, R.mipmap.ic_launcher_round) else icon(authorIcon, authorName)
        val deep = "chaggu://c/$conversationId"
        val shortcut = ShortcutInfoCompat.Builder(context, conversationId)
            .setShortLabel(title.take(40)).setLongLived(true).setLocusId(LocusIdCompat(conversationId))
            .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(deep), context, MainActivity::class.java))
            .setIcon(shortcutIcon)
            .apply { if (!isGroup) setPerson(Person.Builder().setName(authorName).setKey(authorKey).setIcon(icon(authorIcon, authorName)).build()) }
            .setCategories(ConversationShortcuts.CATEGORIES)
            .build()
        runCatching { ShortcutManagerCompat.pushDynamicShortcut(context, shortcut) }
        val bubbleIntent = PendingIntent.getActivity(context, ("bubble$conversationId").hashCode(),
            Intent(context, BubbleActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse(deep)),
            PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val bubble = NotificationCompat.BubbleMetadata.Builder(bubbleIntent, shortcutIcon).setDesiredHeight(640).setSuppressNotification(false).build()
        val reply = NotificationCompat.Action.Builder(R.drawable.ic_stat_chaggu, context.getString(R.string.notif_reply), actionIntent(ACTION_REPLY, conversationId, mutable = true))
            .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel(context.getString(R.string.notif_reply_hint)).build())
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).setAllowGeneratedReplies(true).build()
        val read = NotificationCompat.Action.Builder(R.drawable.ic_stat_chaggu, context.getString(R.string.notif_mark_read), actionIntent(ACTION_MARK_READ, conversationId, mutable = false))
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ).setShowsUserInterface(false).build()
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_chaggu)
            .setColor(0xFFFF5A36.toInt())
            .setStyle(style)
            .setContentTitle(title).setContentText(text)
            .setShortcutId(conversationId).setLocusId(LocusIdCompat(conversationId))
            .setBubbleMetadata(bubble)
            .addAction(reply).addAction(read)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setNumber(badge)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setSilent(silent)
            .setContentIntent(openIntent(openUri ?: (deep + (seq?.let { "?m=$it" } ?: "")), conversationId.hashCode()))
            .build()
        notify(conversationId.hashCode(), n)
    }

    /** Recordatorios y reuniones: notificación simple con el mismo canal. */
    fun showMessage(conversationId: String, title: String, text: String, silent: Boolean, tag: String = conversationId, seq: Long? = null, openUri: String? = null) {
        if (!enabled()) return
        val uri = openUri ?: ("chaggu://c/$conversationId" + (seq?.let { "?m=$it" } ?: ""))
        val channel = when {
            tag.startsWith("event:soon:") -> CHANNEL_SOON
            tag.startsWith("rem:") || tag.startsWith("reminder:") -> CHANNEL_REMINDERS
            tag.startsWith("cal:") || tag.startsWith("event:") -> CHANNEL_EVENTS
            else -> CHANNEL_ID
        }
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_chaggu).setColor(0xFFFF5A36.toInt())
            .setContentTitle(title).setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_REMINDER).setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true).setSilent(silent).setContentIntent(openIntent(uri, tag.hashCode()))
            .build()
        notify(tag.hashCode(), n)
    }

    /** Tras responder desde la notificación: se agrega «Tú: …» y se vuelve a publicar en silencio. */
    fun appendMine(conversationId: String, title: String, isGroup: Boolean, text: String) {
        val lines = history[conversationId] ?: return
        val last = synchronized(lines) { lines.lastOrNull { it.authorKey != "me" } } ?: return
        synchronized(lines) { lines.addLast(Line("me", context.getString(R.string.notif_you), text, System.currentTimeMillis(), null)) }
        showConversation(conversationId, title, isGroup, last.authorKey, last.authorName, last.text, last.icon, silent = true, badge = 0)
        synchronized(lines) { lines.removeLast() } // showConversation lo volvió a agregar
    }

    private fun notify(id: Int, n: android.app.Notification) {
        try { NotificationManagerCompat.from(context).notify(id, n) } catch (e: SecurityException) { Log.w("TieComs", "Sin permiso de notificaciones") }
    }

    fun cancel(conversationId: String) {
        NotificationManagerCompat.from(context).cancel(conversationId.hashCode())
        history.remove(conversationId)
    }

    fun cancelAll() { NotificationManagerCompat.from(context).cancelAll(); history.clear() }
}

/**
 * Push remoto (FCM). El token se registra con PUT /api/v1/push/token al tener sesión; al cerrar sesión
 * el servidor lo borra. Sin google-services.json no hay Firebase y esto no hace nada.
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

