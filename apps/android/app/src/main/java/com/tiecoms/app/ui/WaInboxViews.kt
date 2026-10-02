package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.WaChatDTO
import com.tiecoms.app.core.WaInbox
import kotlinx.coroutines.launch

/*
 * WhatsApp en la bandeja (docs/CONTRATO-GG-CHAT-WA-INBOX.md, parte A): la fila mezclada en Grupos/DMs, su menú,
 * deslizar para fijar en TODAS las filas, y los accesos con logo (WhatsApp, Gmail/Outlook) al inicio de los chips.
 */

/** Verde de los contadores de WhatsApp (el de la marca, con texto blanco legible). */
private val WaCount = Color(0xFF1FA855)

/** Ejecuta un cambio de bandeja con aviso de error (y el texto claro si el servidor aún no tiene la 081). */
fun waInboxAct(ctx: Context, c: WaChatDTO, place: String? = null, placeSet: Boolean = false, pinned: Boolean? = null) {
    val container = (ctx.applicationContext as com.tiecoms.app.TieComsApp).container
    val client = container.client.value
    container.scope.launch {
        runCatching { client.waSetInbox(c, place, placeSet, pinned) }.onFailure { e ->
            container.toast(if (e is ApiException && e.code == "wa_inbox_unsupported") ctx.getString(R.string.wa_inbox_unsupported) else errorText(ctx, e))
        }
    }
}

/**
 * Menú de la fila de WhatsApp EN la bandeja (pulsación larga): abrir, los dos pines con su estado («Fijar en la
 * pantalla principal» y «Fijar en WhatsApp»), mover a la sección contraria y sacar de mi lista principal.
 */
fun waInboxRowMenu(ctx: Context, c: WaChatDTO, onOpen: () -> Unit): List<SheetItem?> {
    val pinned = c.inboxPinnedAt != null
    return listOf(
        SheetItem(ctx.getString(R.string.wa_open_chat), "↗", tag = "waMenuOpen", onClick = onOpen),
        SheetItem(ctx.getString(if (pinned) R.string.unpin_main else R.string.pin_main), "", tag = "waMenuPin") { waInboxAct(ctx, c, pinned = !pinned) },
        SheetItem(ctx.getString(if (c.pinned) R.string.unpin_wa else R.string.pin_wa), "", tag = "waMenuPinWa") { waPinInWhatsApp(ctx, c, !c.pinned) },
        if (c.inboxPlace == WaInbox.GROUPS) SheetItem(ctx.getString(R.string.wa_move_dms), "↪", tag = "waMenuToDms") { waInboxAct(ctx, c, WaInbox.DMS, placeSet = true) }
        else SheetItem(ctx.getString(R.string.wa_move_groups), "↪", tag = "waMenuToGroups") { waInboxAct(ctx, c, WaInbox.GROUPS, placeSet = true) },
        null,
        SheetItem(ctx.getString(R.string.wa_remove_from_inbox), "⎋", danger = true, tag = "waMenuRemove") { waInboxAct(ctx, c, null, placeSet = true) },
    )
}

/** «📌 Fijar en WhatsApp» desde la bandeja (PATCH { pinned }): arriba en la pantalla WhatsApp. */
fun waPinInWhatsApp(ctx: Context, c: WaChatDTO, on: Boolean) {
    val container = (ctx.applicationContext as com.tiecoms.app.TieComsApp).container
    val client = container.client.value
    container.scope.launch {
        runCatching { client.waPatchChat(c, kotlinx.serialization.json.buildJsonObject { put("pinned", kotlinx.serialization.json.JsonPrimitive(on)) }) }
            .onFailure { container.toast(errorText(ctx, it)) }
    }
}

/**
 * Deslizar a la derecha = Fijar / Quitar (en todas las filas de Grupos y DMs). La fila vuelve a su sitio: el cambio
 * se ve en el 📌 y en el orden.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SwipePin(pinned: Boolean, onToggle: () -> Unit, tag: String, content: @Composable () -> Unit) {
    val toggle by rememberUpdatedState(onToggle)
    val state = rememberSwipeToDismissBoxState()
    LaunchedEffect(state.currentValue) {
        if (state.currentValue == SwipeToDismissBoxValue.StartToEnd) { toggle(); state.snapTo(SwipeToDismissBoxValue.Settled) }
    }
    SwipeToDismissBox(
        state = state, enableDismissFromStartToEnd = true, enableDismissFromEndToStart = false,
        modifier = Modifier.testTag(tag),
        backgroundContent = {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.primaryContainer).padding(start = 20.dp), contentAlignment = Alignment.CenterStart) {
                Text("📌 " + stringResource(if (pinned) R.string.swipe_unpin else R.string.swipe_pin), style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onPrimaryContainer)
            }
        },
    ) { Box(Modifier.background(MaterialTheme.colorScheme.background)) { content() } }
}

/** Avatar del chat de WhatsApp con el logo verde pequeño en la esquina inferior derecha. */
@Composable
fun WaAvatar(c: WaChatDTO, size: Dp) {
    Box(Modifier.size(size)) {
        Avatar(c.name.ifBlank { "WA" }, MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant, size = size, square = c.isGroup)
        Box(Modifier.align(Alignment.BottomEnd).offset(x = 3.dp, y = 3.dp).background(MaterialTheme.colorScheme.background, CircleShape).padding(1.dp)) {
            WaIcon(size = (size.value * 0.42f).coerceAtLeast(14f).dp)
        }
    }
}

/** Fila de WhatsApp mezclada en Grupos o DMs: logo, nombre, «WhatsApp · cuenta» o la vista previa, contador verde y 📌. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WaInboxRow(c: WaChatDTO, indent: Dp, iconSize: Dp, menuOpen: Boolean, menuItems: () -> List<SheetItem?>, onDismissMenu: () -> Unit, onLongPress: () -> Unit, onClick: () -> Unit) {
    val ctx = LocalContext.current
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val off = WaInbox.disconnected(c)
    val line = if (off) stringResource(R.string.wa_disconnected) else stringResource(R.string.wa_row_line, c.accountLabel.ifBlank { "WhatsApp" })
    val preview = c.lastPreview?.takeIf { it.isNotBlank() }
    val time = relativeTime(ctx, c.lastMessageAt)
    val unreadText = if (c.unread > 0) pluralStringResource(R.plurals.unread_count, c.unread, c.unread) else null
    val a11y = listOfNotNull(c.name, line, preview, time.ifEmpty { null }, unreadText).joinToString(". ")
    Box {
        Row(
            Modifier.fillMaxWidth().background(if (menuOpen) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                .combinedClickable(onClick = onClick, onLongClick = { haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); onLongPress() },
                    onLongClickLabel = stringResource(R.string.menu_more))
                .heightIn(min = 56.dp).padding(start = indent, end = 16.dp, top = 6.dp, bottom = 6.dp)
                .alpha(if (off) 0.55f else 1f)
                .semantics(mergeDescendants = true) { contentDescription = a11y }.testTag("waRow-${c.jid}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WaAvatar(c, iconSize)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(c.name, style = if (iconSize >= 40.dp) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        fontWeight = if (c.unread > 0) FontWeight.Bold else FontWeight.Medium, modifier = Modifier.weight(1f, fill = false))
                    if (c.inboxPinnedAt != null) Text(" 📌", style = MaterialTheme.typography.labelSmall, modifier = Modifier.testTag("waPinMark-${c.jid}"))
                }
                Text(line, style = MaterialTheme.typography.labelSmall, color = if (off) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (preview != null) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(preview, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false))
                    if (time.isNotEmpty()) Text(" · $time", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
            }
            Spacer(Modifier.width(8.dp))
            if (c.unread > 0) Box(Modifier.widthIn(min = 22.dp).background(WaCount, CircleShape).padding(horizontal = 6.dp, vertical = 2.dp).testTag("waUnread-${c.jid}"), contentAlignment = Alignment.Center) {
                Text(if (c.unread > 99) "99+" else c.unread.toString(), color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            }
        }
        AnchoredMenu(menuOpen, if (menuOpen) menuItems() else emptyList(), onDismissMenu)
    }
}

/** Fila de Grupos/DMs que es de WhatsApp (id sintético `wa:…`): su chat, o null si ya no está en la bandeja. */
fun waChatOf(data: com.tiecoms.app.core.BootstrapDTO, c: ConversationDTO): WaChatDTO? = if (WaInbox.isWa(c.id)) WaInbox.chat(data, c.id) else null

/**
 * Accesos con logo al INICIO de la fila de chips (solo lo conectado): [logo WhatsApp N] abre la lista de WhatsApp;
 * [logo Gmail|Outlook N] abre la bandeja de correo (la última usada; pulsación larga elige la cuenta).
 * Contadores: GET /whatsapp/chats?limit=1 y GET /mail/unread (caché de 60 s).
 */
class AccessCounts(val wa: Int?, val mail: Int?, val providers: List<String>)

@Composable
fun rememberAccessCounts(): AccessCounts {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val mailOn = st.data?.mailEnabled == true
    var wa by remember { mutableStateOf<Int?>(null) }
    var mail by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(st.waRevision) {
        wa = null
        runCatching { client.waUnreadTotal() }.onSuccess { wa = it }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
    }
    LaunchedEffect(mailOn) {
        if (!mailOn) return@LaunchedEffect
        if (st.mailConnections == null) runCatching { client.loadMailConnections() }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
        runCatching { client.mailUnreadCached() }.onSuccess { mail = it }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
    }
    val providers = if (mailOn) st.mailConnections.orEmpty().filter { it.status == "active" }.map { it.provider } else emptyList()
    return AccessCounts(wa, if (providers.isEmpty()) null else (mail ?: 0), providers)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AccessChip(tag: String, cd: String, count: Int, onClick: () -> Unit, onLongClick: (() -> Unit)? = null, logo: @Composable () -> Unit) {
    Surface(
        shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.heightIn(min = 44.dp).semantics(mergeDescendants = true) { contentDescription = cd }.testTag(tag),
    ) {
        Row(Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            logo()
            if (count > 0) {
                Spacer(Modifier.width(6.dp))
                Text(if (count > 99) "99+" else count.toString(), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
            }
        }
    }
}
