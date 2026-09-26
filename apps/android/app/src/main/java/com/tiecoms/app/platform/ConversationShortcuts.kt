package com.tiecoms.app.platform

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.net.Uri
import androidx.core.app.Person
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.tiecoms.app.MainActivity
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.Contrast
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PersonColors

/**
 * Atajos de conversación (SPEC-v4 §B): los mismos que usan las notificaciones y burbujas, con la categoría de
 * `res/xml/shortcuts.xml` (`<share-target>`) para que las conversaciones recientes salgan en la fila de Direct Share
 * de la hoja de compartir. Al tocar uno, ShareActivity recibe EXTRA_SHORTCUT_ID = id de la conversación.
 */
object ConversationShortcuts {
    const val SHARE_CATEGORY = "com.tiecoms.app.SHARE_TARGET"
    const val CONVERSATION_CATEGORY = "com.tiecoms.app.category.CONVERSATION"
    val CATEGORIES = setOf(SHARE_CATEGORY, CONVERSATION_CATEGORY)
    /** Cuántas conversaciones recientes se publican (el sistema muestra unas 4–8 en la fila de arriba). */
    const val RECENT = 8
    private const val ICON_PX = 216

    /** Orden de Direct Share: recientes primero, sin silenciadas ni laterales (hay que buscarlas dentro). */
    fun recent(d: BootstrapDTO, nowMs: Long = System.currentTimeMillis()): List<ConversationDTO> =
        d.conversations.filter { !it.isSide && !it.mutedAt(nowMs) && it.canPost }
            .sortedByDescending { it.lastMessageAt ?: "" }.take(RECENT)

    fun shortcut(ctx: Context, c: ConversationDTO, d: BootstrapDTO, title: String, photo: Bitmap?, rank: Int): ShortcutInfoCompat {
        val direct = c.kind == "direct"
        val otherId = if (direct) c.memberIds.firstOrNull { it != d.me.id } else null
        val icon = IconCompat.createWithAdaptiveBitmap(photo?.let { square(it) } ?: initials(title, if (otherId != null) PersonColors.light(otherId) else Contrast.SOBER_ORANGE, if (direct) null else "#"))
        return ShortcutInfoCompat.Builder(ctx, c.id)
            .setShortLabel(title.take(40)).setLongLabel(title.take(80))
            .setIcon(icon).setLongLived(true).setRank(rank)
            .setLocusId(LocusIdCompat(c.id))
            .setCategories(CATEGORIES)
            .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse("chaggu://c/${c.id}"), ctx, MainActivity::class.java))
            .apply {
                if (otherId != null) setPerson(Person.Builder().setName(Names.person(d, otherId)?.name ?: title).setKey(otherId).setIcon(icon).build())
                else setIsConversation()
            }
            .build()
    }

    /** Publica las recientes (con su foto si hay) y retira las que dejaron de serlo. */
    suspend fun publish(ctx: Context, d: BootstrapDTO, title: (ConversationDTO) -> String, photoOf: suspend (ConversationDTO) -> Bitmap?) {
        val list = recent(d)
        val keep = list.map { it.id }.toSet()
        val old = runCatching { ShortcutManagerCompat.getDynamicShortcuts(ctx).map { it.id } }.getOrDefault(emptyList())
        val gone = old.filter { it !in keep && d.conversations.none { c -> c.id == it } }
        if (gone.isNotEmpty()) runCatching { ShortcutManagerCompat.removeLongLivedShortcuts(ctx, gone) }
        list.forEachIndexed { i, c -> runCatching { ShortcutManagerCompat.pushDynamicShortcut(ctx, shortcut(ctx, c, d, title(c), photoOf(c), i)) } }
    }

    /** Al cerrar sesión o eliminar la cuenta: ni sugerencias ni burbujas de la sesión anterior. */
    fun clear(ctx: Context) {
        runCatching {
            val ids = ShortcutManagerCompat.getDynamicShortcuts(ctx).map { it.id } + ShortcutManagerCompat.getShortcuts(ctx, ShortcutManagerCompat.FLAG_MATCH_CACHED).map { it.id }
            ShortcutManagerCompat.removeAllDynamicShortcuts(ctx)
            if (ids.isNotEmpty()) ShortcutManagerCompat.removeLongLivedShortcuts(ctx, ids.distinct())
        }
    }

    /** Foto a cuadrado de 216 px (el ícono adaptable recorta el borde exterior). */
    private fun square(src: Bitmap): Bitmap {
        val side = minOf(src.width, src.height)
        val sq = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
        return Bitmap.createScaledBitmap(sq, ICON_PX, ICON_PX, true)
    }

    /** Iniciales blancas sobre el color estable de la persona (o naranja sobrio con # para grupos). */
    fun initials(name: String, argb: Long, glyph: String? = null): Bitmap {
        val b = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888)
        val cv = Canvas(b)
        cv.drawColor(argb.toInt())
        val text = glyph ?: name.split(' ', '·').filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "?" }
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textSize = ICON_PX * 0.30f; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); textAlign = Paint.Align.CENTER }
        cv.drawText(text, ICON_PX / 2f, ICON_PX / 2f - (p.descent() + p.ascent()) / 2, p)
        return b
    }

}
