package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.Sounds
import com.tiecoms.app.platform.SoundFiles
import kotlinx.coroutines.launch

/*
 * Sonidos (docs/SONIDOS.md): el de cada chat (Detalles › Sonido y el menú del chat), el predeterminado y el tono de llamada
 * (Ajustes). Todo se guarda en el servidor; al elegir suena una vista previa.
 */

private fun container(ctx: Context) = (ctx.applicationContext as com.tiecoms.app.TieComsApp).container

/** Opciones para un chat: Predeterminado (el mío) · Sin sonido · los 10 sonidos. El elegido lleva ●. */
fun chatSoundChoices(ctx: Context, current: String?, myDefault: String?, onPick: (String?) -> Unit): List<SheetItem> {
    val cur = Sounds.choice(current)
    fun mark(on: Boolean) = if (on) "● " else ""
    val def = Sounds.choice(myDefault) ?: Sounds.DEFAULT_SOUND
    return listOf(SheetItem(mark(cur == null) + ctx.getString(R.string.sound_default_named, SoundFiles.label(ctx, def)), tag = "sound-default") { onPick(null) }) +
        (Sounds.MESSAGE + Sounds.NONE).map { s -> SheetItem(mark(cur == s) + SoundFiles.label(ctx, s), tag = "sound-$s") { onPick(s) } }
}

/** Guarda el sonido de un chat (optimista) y suena la vista previa. */
fun setChatSound(ctx: Context, conv: ConversationDTO, sound: String?) {
    val c = container(ctx)
    val eff = Sounds.effective(sound, c.client.value.state.value.data?.me?.messageSound)
    c.sounds.playMessage(eff, force = true)
    c.scope.launch {
        runCatching { c.client.value.setConversationSound(conv.id, sound) }
            .onSuccess { c.toast(ctx.getString(R.string.sound_set, SoundFiles.label(ctx, eff))) }
            .onFailure { c.toast(errorText(ctx, it)) }
    }
}

/** «Sonido ›» del menú del chat (pulsación larga en la lista y ⋯ del encabezado). */
fun soundMenuItem(ctx: Context, conv: ConversationDTO): SheetItem {
    val mine = container(ctx).client.value.state.value.data?.me?.messageSound
    val eff = Sounds.effective(conv.sound, mine)
    return SheetItem(ctx.getString(R.string.sound_chat), "🔔", tag = "menuSound", subtitle = SoundFiles.label(ctx, eff),
        children = chatSoundChoices(ctx, conv.sound, mine) { setChatSound(ctx, conv, it) })
}

/** Fila «Sonido» de Detalles del chat. */
@Composable
fun ChatSoundRow(conv: ConversationDTO) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val mine = st.data?.me?.messageSound
    var open by remember { mutableStateOf(false) }
    SettingRow(stringResource(R.string.sound_chat),
        if (Sounds.choice(conv.sound) == null) stringResource(R.string.sound_default_named, SoundFiles.label(ctx, Sounds.effective(null, mine))) else SoundFiles.label(ctx, conv.sound!!),
        tag = "chatSoundRow") { open = true }
    if (open) ActionSheet(stringResource(R.string.sound_chat), chatSoundChoices(ctx, conv.sound, mine) { setChatSound(ctx, conv, it) }) { open = false }
}

/** Ajustes › Notificaciones: sonido predeterminado de los chats y tono de llamada. */
@Composable
fun SoundSettingsRows() {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val c = LocalContainer.current
    val st by client.state.collectAsStateWithLifecycle()
    val me = st.data?.me ?: return
    var pickSound by remember { mutableStateOf(false) }
    var pickRing by remember { mutableStateOf(false) }
    fun save(block: suspend () -> Unit) = c.scope.launch { runCatching { block() }.onFailure { c.toast(errorText(ctx, it)) } }
    val mySound = Sounds.choice(me.messageSound) ?: Sounds.DEFAULT_SOUND
    SettingRow(stringResource(R.string.sound_default_title), SoundFiles.label(ctx, mySound), hint = stringResource(R.string.sound_default_hint), tag = "defaultSoundRow") { pickSound = true }
    if (st.data?.callsEnabled == true) {
        val ring = Sounds.ringtone(me.ringtone)
        SettingRow(stringResource(R.string.ring_title), SoundFiles.ringLabel(ctx, ring), tag = "ringtoneRow") { pickRing = true }
    }
    if (pickSound) ActionSheet(stringResource(R.string.sound_default_title), (Sounds.MESSAGE + Sounds.NONE).map { s ->
        SheetItem((if (s == mySound) "● " else "") + SoundFiles.label(ctx, s), tag = "defSound-$s") {
            c.sounds.playMessage(s, force = true); save { client.setMySounds(messageSound = s) }
        }
    }) { pickSound = false }
    if (pickRing) ActionSheet(stringResource(R.string.ring_title), Sounds.RINGTONES.map { r ->
        SheetItem((if (r == Sounds.ringtone(me.ringtone)) "● " else "") + SoundFiles.ringLabel(ctx, r), tag = "ring-$r") {
            c.sounds.previewRingtone(r); save { client.setMySounds(ringtone = r) }
        }
    }) { pickRing = false }
}

@Composable
private fun SettingRow(title: String, value: String, hint: String? = null, tag: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 10.dp)
        .semantics(mergeDescendants = true) {}.testTag(tag), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 12.dp))
    }
}
