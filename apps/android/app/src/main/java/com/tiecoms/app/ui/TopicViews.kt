package com.tiecoms.app.ui

import android.content.Context
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.GenericShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.TopicDTO
import com.tiecoms.app.core.Topics
import kotlinx.coroutines.launch

/**
 * Temas del chat (docs/TEMAS.md; web: apps/web/src/screens/Topics.tsx).
 * Una fila de banderitas con scroll horizontal debajo de la barra de accesos. Tocar una filtra el chat y lo que
 * escribas sale con ese tema; «Todo» o tocar la misma otra vez quita el filtro. Mantener presionada abre
 * Renombrar · Cambiar color · Archivar · Quitar tema. No hay límite práctico (Topics.LIMIT es un tope técnico).
 */

/** Colores pastel de cada tema: fondo y tinta (los mismos de apps/web/src/styles.css). */
internal fun topicColors(color: String): Pair<Color, Color> = when (color) {
    "green" -> Color(0xFFDCEFD6) to Color(0xFF2F6B2A)
    "orange" -> Color(0xFFFBE2CF) to Color(0xFF9A4A14)
    "violet" -> Color(0xFFE6E1F8) to Color(0xFF4D3A9E)
    "magenta" -> Color(0xFFF7DBE9) to Color(0xFF8E2A5E)
    "aqua" -> Color(0xFFD5F0EC) to Color(0xFF17665D)
    "red" -> Color(0xFFF9DCD6) to Color(0xFF9A2E1C)
    "yellow" -> Color(0xFFF8EDC5) to Color(0xFF7A5A06)
    else -> Color(0xFFDBE8F8) to Color(0xFF1D4F8C)
}

private fun colorName(ctx: Context, c: String): String = ctx.getString(when (c) {
    "green" -> R.string.topic_color_green; "orange" -> R.string.topic_color_orange; "violet" -> R.string.topic_color_violet
    "magenta" -> R.string.topic_color_magenta; "aqua" -> R.string.topic_color_aqua; "red" -> R.string.topic_color_red
    "yellow" -> R.string.topic_color_yellow; else -> R.string.topic_color_blue
})

/** 409 del servidor (nombre repetido o tope técnico): se muestra su mensaje tal cual. */
fun topicError(ctx: Context, e: Throwable): String =
    if (e is ApiException && e.status == 409 && !e.message.isNullOrBlank()) e.message!! else errorText(ctx, e)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TopicFlag(
    text: String, bg: Color, ink: Color, selected: Boolean, tag: String,
    onClick: () -> Unit, onLongClick: (() -> Unit)? = null, stripe: Color = ink.copy(alpha = 0.22f), bold: Boolean = true,
    /** Sin leer en esta banderita (pastilla de acento); 0 = sin número. */
    unread: Int = 0,
    /** Qué muestra la banderita («Solo los mensajes sin tema»), para TalkBack (en la web es el title). */
    hint: String? = null,
    /** 1.7.4: banderita compacta (solo el ícono): TalkBack lee este nombre completo, con el sin leer y la pista. */
    a11y: String? = null,
) {
    val density = androidx.compose.ui.platform.LocalDensity.current
    val tailPx = with(density) { 9.dp.toPx() }
    val shape = remember(tailPx) {
        GenericShape { size, _ ->
            moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width - tailPx, size.height / 2f); lineTo(size.width, size.height); lineTo(0f, size.height); close()
        }
    }
    // Cinta con cola en V a la derecha (muesca de 9 dp). La banderita activa es más alta (cuelga más).
    val h by animateDpAsState(if (selected) 36.dp else 28.dp, label = "flag")
    val menuLabel = stringResource(R.string.menu_more)
    Box(
        Modifier.height(h).background(bg, shape)
            .drawBehind { drawRect(stripe, size = androidx.compose.ui.geometry.Size(with(density) { 5.dp.toPx() }, size.height)) }
            .combinedClickable(role = Role.Tab, onClick = onClick, onLongClick = onLongClick, onLongClickLabel = if (onLongClick != null) menuLabel else null)
            .testTag(tag)
            .then(if (a11y != null) Modifier.clearAndSetSemantics { this.selected = selected; role = Role.Tab; contentDescription = a11y }
                else Modifier.semantics { this.selected = selected; if (hint != null) contentDescription = hint })
            .padding(start = 11.dp, end = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.CenterVertically) {
            Text(text, color = ink, fontSize = 12.5.sp, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
            if (unread > 0) {
                val cd = stringResource(R.string.topic_unread_n, unread)
                Box(Modifier.padding(start = 6.dp).height(18.dp).widthIn(min = 18.dp)
                    .background(Color(com.tiecoms.app.core.Contrast.SOBER_ORANGE), androidx.compose.foundation.shape.RoundedCornerShape(50))
                    .padding(horizontal = 5.dp).semantics { contentDescription = cd }.testTag("$tag-unread"), contentAlignment = Alignment.Center) {
                    Text(if (unread > 99) "99+" else unread.toString(), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                }
            }
        }
    }
}

/**
 * Fila de banderitas: «💬 Todo», los temas activos (ícono, nombre y sin leer), «＋ Nuevo» y, al final, «🗄 Archivados N».
 * [filter] es la banderita elegida (null = Todo); [counts], cuántos mensajes cargados tiene cada tema (para «Quitar»); [unread], lo sin leer de cada tema (clave "" = sin tema, va en «Todo»).
 * Sin pendientes, no sale número (docs/TEMAS.md › «Todo»).
 */
@Composable
fun TopicDock(conv: ConversationDTO, topics: List<TopicDTO>, filter: String?, counts: Map<String, Int>, unread: Map<String, Int>, onFilter: (String?) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    // Orden de llegada: el más antiguo primero (position sigue el orden de creación; estable si empatan).
    val active = remember(topics) { Topics.active(topics).sortedBy { it.position } }
    val archived = Topics.archived(topics)
    val canEdit = conv.canPost
    var menuFor by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<TopicDTO?>(null) }
    var showArchived by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<TopicDTO?>(null) }
    if (active.isEmpty() && archived.isEmpty() && !canEdit) return

    fun archive(t: TopicDTO) {
        if (filter == t.id) onFilter(null)
        container.scope.launch {
            try {
                client.updateTopic(t, archived = true)
                val r = snackbar.showSnackbar(ctx.getString(R.string.topic_archived, t.name), actionLabel = ctx.getString(R.string.undo), duration = SnackbarDuration.Short)
                if (r == SnackbarResult.ActionPerformed) client.updateTopic(t, archived = false)
            } catch (e: Exception) { snackbar.showSnackbar(topicError(ctx, e)) }
        }
    }
    fun menu(t: TopicDTO): List<SheetItem?> = listOf(
        SheetItem(ctx.getString(R.string.topic_rename), "✎", tag = "topicRename") { editing = t },
        SheetItem(ctx.getString(R.string.topic_color), "🎨", tag = "topicColor", children = Topics.COLORS.map { c ->
            SheetItem((if (c == t.color) "● " else "") + colorName(ctx, c), tag = "topicColor-$c") {
                container.scope.launch { runCatching { client.updateTopic(t, color = c) }.onFailure { snackbar.showSnackbar(topicError(ctx, it)) } }
            }
        }),
        null,
        SheetItem(ctx.getString(R.string.topic_archive), "🗄", tag = "topicArchive", subtitle = ctx.getString(R.string.topic_archive_hint)) { archive(t) },
        SheetItem(ctx.getString(R.string.topic_remove), "⌫", danger = true, tag = "topicRemove") { removing = t },
    )

    val cd = stringResource(R.string.topic_bar)
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().testTag("topicDock")) {
        LazyRow(
            Modifier.fillMaxWidth().height(40.dp).semantics { contentDescription = cd },
            contentPadding = PaddingValues(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Top,
        ) {
            // «💬 General» (solo lo sin tema; así abre el chat) y «☰ Todo» (todo, con su etiqueta). Sin temas activos son lo
            // mismo: una sola banderita «Todo» (docs/TEMAS.md).
            // 1.7.4: compactas, solo el ícono; el nombre sale únicamente en la elegida (TalkBack siempre lo lee).
            item(key = "general") {
                val name = stringResource(if (active.isNotEmpty()) R.string.topic_general else R.string.topic_all)
                val n = if (active.isNotEmpty()) unread[""] ?: 0 else 0
                val hint = if (active.isNotEmpty()) stringResource(R.string.topic_general_hint) else null
                val a11y = listOfNotNull(name, if (n > 0) stringResource(R.string.topic_unread_n, n) else null, hint).joinToString(", ")
                TopicFlag(if (filter == null) "💬 $name" else "💬", MaterialTheme.colorScheme.surface,
                    MaterialTheme.colorScheme.onSurfaceVariant, selected = filter == null, tag = if (active.isNotEmpty()) "topicGeneral" else "topicAll", onClick = { onFilter(null) },
                    stripe = MaterialTheme.colorScheme.outlineVariant, unread = n, hint = hint, a11y = a11y)
            }
            if (active.isNotEmpty()) item(key = "all") {
                val name = stringResource(R.string.topic_all)
                val a11y = name + ", " + stringResource(R.string.topic_all_hint)
                TopicFlag(if (filter == Topics.ALL) "☰ $name" else "☰", MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.onSurfaceVariant,
                    selected = filter == Topics.ALL, tag = "topicAll", onClick = { onFilter(if (filter == Topics.ALL) null else Topics.ALL) },
                    stripe = MaterialTheme.colorScheme.outlineVariant, hint = stringResource(R.string.topic_all_hint), a11y = a11y)
            }
            items(active, key = { it.id }) { t ->
                val (bg, ink) = topicColors(t.color)
                Box {
                    TopicFlag("${t.icon} ${t.name}", bg, ink, selected = filter == t.id, tag = "topic-${t.name}",
                        onClick = { onFilter(if (filter == t.id) null else t.id) }, onLongClick = if (canEdit) ({ menuFor = t.id }) else null, unread = unread[t.id] ?: 0)
                    AnchoredMenu(menuFor == t.id, if (menuFor == t.id) menu(t) else emptyList(), onDismiss = { menuFor = null })
                }
            }
            if (canEdit) item(key = "new") {
                TopicFlag("＋ " + stringResource(R.string.topic_new), MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.onSurfaceVariant,
                    selected = false, tag = "topicNew", onClick = { creating = true }, stripe = MaterialTheme.colorScheme.outlineVariant, bold = false)
            }
            if (archived.isNotEmpty()) item(key = "archived") {
                TopicFlag("🗄 " + stringResource(R.string.topic_archived_n, archived.size), MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant,
                    selected = false, tag = "topicArchived", onClick = { showArchived = true })
            }
        }
    }
    if (creating) TopicSheet(conv.id, topics, edit = null, onClose = { creating = false }, onSaved = { t -> onFilter(t.id) })
    editing?.let { t -> TopicSheet(conv.id, topics, edit = t, onClose = { editing = null }) }
    if (showArchived) ArchivedTopicsSheet(topics, canEdit, onClose = { showArchived = false })
    removing?.let { t ->
        AlertDialog(
            onDismissRequest = { removing = null },
            text = { Text(stringResource(R.string.topic_remove_confirm, t.name, counts[t.id] ?: 0)) },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    if (filter == t.id) onFilter(null)
                    container.scope.launch {
                        try { client.deleteTopic(t); snackbar.showSnackbar(ctx.getString(R.string.topic_removed, t.name)) }
                        catch (e: Exception) { snackbar.showSnackbar(topicError(ctx, e)) }
                    }
                }, modifier = Modifier.testTag("topicRemoveConfirm")) { Text(stringResource(R.string.topic_remove), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/** Hoja «Nuevo tema» (o «Renombrar tema» con [edit]): nombre, ícono, color y una vista previa de la banderita. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TopicSheet(conversationId: String, topics: List<TopicDTO>, edit: TopicDTO?, onClose: () -> Unit, onSaved: (TopicDTO) -> Unit = {}) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    var name by remember { mutableStateOf(edit?.name ?: "") }
    var icon by remember { mutableStateOf(edit?.icon ?: Topics.nextIcon(topics)) }
    var color by remember { mutableStateOf(edit?.color ?: Topics.nextColor(topics)) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun save() {
        val n = name.trim()
        if (n.isEmpty() || busy) return
        busy = true; error = null
        container.scope.launch {
            try {
                val t = if (edit != null) { client.updateTopic(edit, name = n, icon = icon, color = color); edit.copy(name = n, icon = icon, color = color) }
                    else client.createTopic(conversationId, n, color, icon)
                onClose(); onSaved(t)
            } catch (e: Exception) { error = topicError(ctx, e); busy = false }
        }
    }
    FormSheet(stringResource(if (edit != null) R.string.topic_rename_title else R.string.topic_new_title), onClose, tag = "topicSheet") {
        OutlinedTextField(name, { name = it.take(40) }, singleLine = true, placeholder = { Text(stringResource(R.string.topic_name_ph)) },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { save() }),
            modifier = Modifier.fillMaxWidth().testTag("topicName"))
        Text(stringResource(R.string.topic_icon), style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Topics.ICONS.forEach { i ->
                val on = i == icon
                Box(Modifier.size(44.dp).background(if (on) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(10.dp))
                    .border(if (on) 2.dp else 1.dp, if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
                    .clickable(role = Role.RadioButton) { icon = i }.semantics { selected = on; contentDescription = i }.testTag("topicIcon-$i"),
                    contentAlignment = Alignment.Center) { Text(i, fontSize = 20.sp) }
            }
        }
        Text(stringResource(R.string.topic_color_label), style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Topics.COLORS.forEach { c ->
                val (bg, ink) = topicColors(c)
                val on = c == color
                val label = colorName(ctx, c)
                Box(Modifier.size(40.dp).border(2.dp, if (on) MaterialTheme.colorScheme.onSurface else Color.Transparent, CircleShape).padding(4.dp)
                    .background(bg, CircleShape).clickable(role = Role.RadioButton) { color = c }.semantics { selected = on; contentDescription = label }.testTag("topicSwatch-$c"),
                    contentAlignment = Alignment.Center) { Box(Modifier.size(14.dp).background(ink, CircleShape)) }
            }
        }
        // Vista previa de la banderita.
        val (bg, ink) = topicColors(color)
        Row { TopicFlag("$icon " + name.trim().ifEmpty { stringResource(R.string.topic_name_ph) }, bg, ink, selected = true, tag = "topicPreview", onClick = {}) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("topicError")) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = onClose, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text(stringResource(R.string.cancel)) }
            Button(onClick = { save() }, enabled = name.isNotBlank() && !busy, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("topicSave")) {
                Text(stringResource(if (edit != null) R.string.save else R.string.topic_create))
            }
        }
    }
}

/** «Temas archivados» con Restaurar (restaurar también respeta el tope técnico: el 409 se muestra). */
@Composable
private fun ArchivedTopicsSheet(topics: List<TopicDTO>, canEdit: Boolean, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val sheetSnackbar = remember { SnackbarHostState() }
    // La lista viva: al restaurar, el tema sale de aquí.
    val st by client.state.collectAsStateWithLifecycle()
    val list = Topics.archived(st.topics[topics.firstOrNull()?.conversationId ?: ""] ?: topics)
    FormSheet(stringResource(R.string.topic_archived_title), onClose, tag = "topicArchivedSheet", snackbar = sheetSnackbar) {
        Text(stringResource(R.string.topic_archive_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        list.forEach { t ->
            Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("archivedTopic-${t.name}"), verticalAlignment = Alignment.CenterVertically) {
                Text(t.icon, fontSize = 18.sp, modifier = Modifier.padding(end = 10.dp))
                Text(t.name, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (canEdit) TextButton(onClick = {
                    container.scope.launch {
                        try { client.updateTopic(t, archived = false); sheetSnackbar.showSnackbar(ctx.getString(R.string.topic_restored, t.name)) }
                        catch (e: Exception) { sheetSnackbar.showSnackbar(topicError(ctx, e)) }
                    }
                }, modifier = Modifier.testTag("topicRestore-${t.name}")) { Text(stringResource(R.string.topic_restore)) }
            }
        }
        if (list.isEmpty()) LaunchedEffectClose(onClose)
    }
}

@Composable
private fun LaunchedEffectClose(onClose: () -> Unit) { androidx.compose.runtime.LaunchedEffect(Unit) { onClose() } }

/** Etiqueta pequeña del tema en un mensaje; archivado: gris con 🗄. [by]: «tema puesto por X» cuando no fue el autor. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TopicTag(topic: TopicDTO, by: String?, modifier: Modifier = Modifier) {
    val (bg, ink) = if (topic.archived) MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant else topicColors(topic.color)
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text((if (topic.archived) "🗄" else topic.icon) + " " + topic.name, color = ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.background(bg, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 1.dp).testTag("topicTag"))
        by?.let { Text(" · " + stringResource(R.string.topic_by, it), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag("topicBy")) }
    }
}

/**
 * «🏷 Tema» del menú del mensaje: los temas activos (✓ el actual), «Sin tema» si ya tiene uno y «＋ Nuevo tema».
 * Cualquiera del chat etiqueta cualquier mensaje; avisa con «Deshacer».
 */
fun topicMenuItem(ctx: Context, container: com.tiecoms.app.AppContainer, snackbar: SnackbarHostState, m: MessageDTO, topics: List<TopicDTO>, onNew: () -> Unit): SheetItem {
    val client = container.client.value
    fun set(topicId: String?) {
        val prev = m.topicId
        container.scope.launch {
            try {
                client.setMessageTopic(m, topicId)
                val name = topics.firstOrNull { it.id == topicId }?.name
                val r = snackbar.showSnackbar(if (name != null) ctx.getString(R.string.topic_tagged, name) else ctx.getString(R.string.topic_untagged),
                    actionLabel = ctx.getString(R.string.undo), duration = SnackbarDuration.Short)
                if (r == SnackbarResult.ActionPerformed) runCatching { client.setMessageTopic(m, prev) }
            } catch (e: Exception) { snackbar.showSnackbar(topicError(ctx, e)) }
        }
    }
    val children = buildList {
        Topics.active(topics).forEach { t -> add(SheetItem("${t.icon} ${t.name}", hint = if (m.topicId == t.id) "✓" else null, tag = "setTopic-${t.name}") { if (m.topicId != t.id) set(t.id) }) }
        if (m.topicId != null) add(SheetItem(ctx.getString(R.string.topic_none), "⌫", tag = "setTopicNone") { set(null) })
        add(SheetItem(ctx.getString(R.string.topic_new_title), "＋", tag = "setTopicNew", onClick = onNew))
    }
    return SheetItem(ctx.getString(R.string.topic_set), "🏷", tag = "menuTopic", children = children)
}

/** Etiqueta [m] con un tema recién creado desde su menú. */
fun tagWithNewTopic(ctx: Context, container: com.tiecoms.app.AppContainer, snackbar: SnackbarHostState, m: MessageDTO, t: TopicDTO) {
    container.scope.launch {
        try { container.client.value.setMessageTopic(m, t.id); snackbar.showSnackbar(ctx.getString(R.string.topic_tagged, t.name)) }
        catch (e: Exception) { snackbar.showSnackbar(topicError(ctx, e)) }
    }
}
