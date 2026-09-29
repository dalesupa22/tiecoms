package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.Groups
import com.tiecoms.app.core.QuickSearch
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Edit
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.filled.Check
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.LinkPreviewDTO
import com.tiecoms.app.core.Links
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PersonDTO
import kotlinx.coroutines.launch

// ---------- Enlaces ----------
/** Abre una URL en Custom Tabs; si no hay navegador compatible, con un Intent VIEW. */
fun openUrl(ctx: Context, url: String) {
    val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
    try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(ctx, uri)
    } catch (_: Exception) {
        try { ctx.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: ActivityNotFoundException) {}
    }
}

/** Texto del mensaje con los enlaces tocables (Linkify de la web: la puntuación final queda fuera). */
@Composable
fun LinkifiedText(text: String, color: Color, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val parts = remember(text) { Links.split(text) }
    if (parts.none { it.url != null }) {
        Text(text, color = color, style = MaterialTheme.typography.bodyLarge, modifier = modifier)
        return
    }
    val styles = TextLinkStyles(SpanStyle(color = color, textDecoration = TextDecoration.Underline, fontWeight = FontWeight.Medium))
    val annotated = remember(parts, color) {
        buildAnnotatedString {
            parts.forEach { p ->
                val u = p.url
                if (u == null) append(p.text)
                else withLink(LinkAnnotation.Url(u, styles) { openUrl(ctx, u) }) { append(p.text) }
            }
        }
    }
    Text(annotated, color = color, style = MaterialTheme.typography.bodyLarge, modifier = modifier)
}

/** Tarjeta de vista previa bajo el texto: miniatura, sitio, título (2 líneas) y descripción (2 líneas). */
@Composable
fun LinkPreviewCard(p: LinkPreviewDTO, fg: Color, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val cd = stringResource(R.string.link_open, p.host)
    Surface(
        color = fg.copy(alpha = 0.08f), shape = RoundedCornerShape(10.dp),
        modifier = modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { openUrl(ctx, p.url) }
            .semantics(mergeDescendants = true) { contentDescription = listOfNotNull(cd, p.title).joinToString(". ") }.testTag("linkPreview"),
    ) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            p.imageUrl?.takeIf { it.isNotBlank() }?.let { img ->
                Surface(shape = RoundedCornerShape(8.dp), color = fg.copy(alpha = 0.1f), modifier = Modifier.size(64.dp)) {
                    RemoteImage(img, Modifier.size(64.dp), sizeHint = 64.dp)
                }
                Spacer(Modifier.width(10.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(p.host, style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = 0.75f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                p.title?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.titleSmall, color = fg, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                p.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = fg.copy(alpha = 0.85f), maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
        }
    }
}

// ---------- Personas agrupadas por empresa ----------
/** PeoplePicker de la web: buscador, chips con los elegidos y personas por empresa (Tu equipo, las demás, terceros). */
@Composable
fun PeoplePicker(data: BootstrapDTO, picked: List<String>, onToggle: (String) -> Unit, exclude: Set<String> = emptySet(), modifier: Modifier = Modifier, placeholder: String? = null) {
    var q by rememberSaveable { mutableStateOf("") }
    val groups = remember(data, q, exclude) { Names.peopleByOrg(data, q, exclude) }
    Column(modifier) {
        OutlinedTextField(
            q, { q = it }, placeholder = { Text(placeholder ?: stringResource(R.string.chat_search_people)) }, singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, null) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("peopleSearch"),
        )
        if (picked.isNotEmpty()) Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp)) { PickedChips(data, picked, onToggle) }
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = true).testTag("peopleList")) {
            if (groups.isEmpty()) item { EmptyNote(stringResource(R.string.chat_nobody)) }
            groups.forEach { g ->
                item(key = "g:" + g.key) { OrgHeader(g) }
                items(g.people, key = { it.id }) { p -> PersonPickRow(p, data, p.id in picked) { onToggle(p.id) } }
            }
        }
    }
}

/**
 * Persona con su foto, cargo o empresa. Con [on] (true/false) se elige con casilla; con null se abre de un toque
 * (búsqueda rápida y «Mensaje nuevo»: abre su directo) y lleva un globito.
 */
@Composable
internal fun PersonPickRow(p: PersonDTO, data: BootstrapDTO, on: Boolean?, tag: String = "person-${p.id}", onToggle: () -> Unit) {
    val org = Names.org(data, p.orgId)
    val line = Names.roleLine(p).ifEmpty { if (p.guest) stringResource(R.string.common_guest) else org?.name ?: "" }
    val opens = stringResource(R.string.search_opens_chat)
    val click = if (on != null) Modifier.toggleable(on, role = Role.Checkbox) { onToggle() } else Modifier.clickable(onClickLabel = opens, role = Role.Button, onClick = onToggle)
    Row(
        Modifier.fillMaxWidth().then(click).heightIn(min = 60.dp).padding(horizontal = if (on != null) 12.dp else 16.dp, vertical = 6.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (on != null) { Checkbox(on, null); Spacer(Modifier.width(6.dp)) }
        PersonAvatar(p, data, size = 40.dp, orgBadge = true)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(p.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (line.isNotBlank()) Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (on == null) { Spacer(Modifier.width(8.dp)); OpensChatIcon() }
    }
}

// ---------- Mensaje nuevo ----------
/**
 * «Mensaje nuevo» (1.6.10, como WhatsApp/Slack; web: Chats.tsx NewChatDialog). Tocar a una persona (lista o «Recientes»)
 * la marca y sale como chip en «Para:» (× la quita; borrar con el campo vacío quita la última). Al marcar desde una
 * búsqueda se limpia el texto para seguir eligiendo. Abajo: con 1, «Abrir chat con X» (su directo); con 2 o más, el nombre
 * opcional y «Crear chat (n+1)» (POST /chats); sin nadie, Cancelar y «Grupo en un espacio». El 💬 de cada fila (o
 * mantener presionado) abre el directo al instante; los grupos de la búsqueda se abren al tocar.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun NewChatScreen(onBack: () -> Unit, onOpened: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var query by rememberSaveable { mutableStateOf("") }
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var name by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var spaceGroup by remember { mutableStateOf(false) }
    val internalFallback = stringResource(R.string.internal_default)
    val convFallback = stringResource(R.string.conversation)
    val title: (com.tiecoms.app.core.ConversationDTO) -> String = { Names.conversationTitle(it, data, internalFallback, convFallback) }
    fun toggle(id: String) {
        picked = com.tiecoms.app.core.NewChat.toggle(picked, id)
        if (query.isNotBlank()) query = com.tiecoms.app.core.NewChat.queryAfterToggle(query)
    }
    /** Abre la conversación en el hilo principal (la respuesta puede volver en el hilo del cliente). */
    fun launchOpen(block: suspend () -> String) {
        if (busy) return
        busy = true
        scope.launch {
            try { val cid = block(); kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { onOpened(cid) } }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) { container.toast(errorText(ctx, e)) } finally { busy = false }
        }
    }
    /** El 💬 o mantener presionado: el directo con esa persona (el que ya existe o uno nuevo). */
    fun open(p: PersonDTO) = launchOpen { openDirect(client, data, p.id) }

    val searching = query.isNotBlank()
    val orgs = remember(data, query) { Names.peopleByOrg(data, query) }
    val groups = remember(data, query, picked.isEmpty()) { if (com.tiecoms.app.core.NewChat.showGroups(picked, query)) QuickSearch.groups(data, query, title) else emptyList() }
    val recents = remember(data) { QuickSearch.recentPeopleIds(data).take(8).mapNotNull { Names.person(data, it) } }
    SimpleScaffold(title = stringResource(R.string.dm_new), onBack = onBack) {
        ToField(data, picked, query, onQuery = { query = it }, onRemove = { toggle(it) },
            onBackspaceEmpty = { picked = com.tiecoms.app.core.NewChat.backspace(picked, query) })
        Box(Modifier.fillMaxWidth().weight(1f)) {
            LazyColumn(Modifier.fillMaxSize().testTag("peopleList")) {
                if (picked.isEmpty() && !searching) item(key = "tip") {
                    Text(stringResource(R.string.compose_tip), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp).testTag("compose.tip"))
                }
                if (!searching && recents.isNotEmpty()) item(key = "recents") {
                    Column {
                        QuickHeader(R.string.compose_recent)
                        LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("compose.recents")) {
                            items(recents, key = { it.id }) { p ->
                                val on = p.id in picked
                                Column(
                                    Modifier.width(68.dp).clip(RoundedCornerShape(12.dp))
                                        .combinedClickable(onClick = { toggle(p.id) }, onLongClick = { open(p) })
                                        .padding(vertical = 6.dp)
                                        .semantics(mergeDescendants = true) { contentDescription = p.name; selected = on }.testTag("compose.recent.${p.id}"),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    Box {
                                        PersonAvatar(p, data, size = 52.dp, orgBadge = true)
                                        if (on) SelectCircle(true, Modifier.align(Alignment.BottomEnd).offset(x = 2.dp, y = 2.dp))
                                    }
                                    Spacer(Modifier.heightIn(min = 4.dp))
                                    Text(p.name.substringBefore(' '), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
                if (groups.isNotEmpty()) {
                    item(key = "groupsHeader") { QuickHeader(R.string.search_groups) }
                    items(groups.take(6), key = { "cg:" + it.id }) { c ->
                        ComposeGroupRow(c, data, QuickSearch.issueLabel(data, c, title)) { onOpened(c.id) }
                    }
                }
                if (orgs.isEmpty() && groups.isEmpty()) item(key = "none") { EmptyNote(stringResource(R.string.chat_nobody)) }
                orgs.forEach { g ->
                    item(key = "g:" + g.key) { OrgHeader(g) }
                    items(g.people, key = { "p:" + it.id }) { p -> ComposePersonRow(p, data, p.id in picked, onToggle = { toggle(p.id) }, onOpen = { open(p) }) }
                }
                item(key = "end") { Spacer(Modifier.heightIn(min = 24.dp)) }
            }
            if (busy) androidx.compose.material3.CircularProgressIndicator(Modifier.align(Alignment.Center).testTag("compose.busy"))
        }
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when (com.tiecoms.app.core.NewChat.action(picked)) {
                com.tiecoms.app.core.NewChat.Action.NONE -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    androidx.compose.material3.OutlinedButton(onClick = onBack, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("newChat.cancel")) { Text(stringResource(R.string.cancel)) }
                    androidx.compose.material3.OutlinedButton(onClick = { spaceGroup = true }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("newChat.space")) {
                        Text(stringResource(R.string.chat_mode_space), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                com.tiecoms.app.core.NewChat.Action.DIRECT -> {
                    val first = Names.person(data, picked[0])?.name?.substringBefore(' ') ?: ""
                    Button(enabled = !busy, onClick = { val id = picked[0]; launchOpen { openDirect(client, data, id) } },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("newChat.create")) {
                        Text(stringResource(R.string.chat_open_with, first), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                com.tiecoms.app.core.NewChat.Action.GROUP -> {
                    OutlinedTextField(name, { name = it.take(120) }, placeholder = { Text(stringResource(R.string.chat_group_name_ph)) }, singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("newChat.name"))
                    Button(enabled = !busy, onClick = {
                        val ids = picked; val chatName = com.tiecoms.app.core.NewChat.chatName(name)
                        launchOpen { client.createChat(ids, chatName).id }
                    }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("newChat.create")) {
                        Text(stringResource(R.string.chat_create_n, com.tiecoms.app.core.NewChat.memberCount(picked)), fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
    if (spaceGroup) NewGroupSheet(NewGroupPreset(company = true), onClose = { spaceGroup = false }, onCreated = { r, _ -> spaceGroup = false; onOpened(r.conversationId) })
}

/** «Para:» con los chips elegidos (× quita) y el campo de búsqueda; borrar con el campo vacío quita el último. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ToField(data: BootstrapDTO, picked: List<String>, query: String, onQuery: (String) -> Unit, onRemove: (String) -> Unit, onBackspaceEmpty: () -> Unit) {
    val remove = stringResource(R.string.common_remove)
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).testTag("compose.to")) {
        androidx.compose.foundation.layout.FlowRow(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.compose_to), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.CenterVertically))
            picked.forEach { id ->
                val p = Names.person(data, id)
                InputChip(selected = true, onClick = { onRemove(id) }, label = { Text(p?.name?.substringBefore(' ') ?: "?") },
                    avatar = { PersonAvatar(p, data, size = 22.dp) }, trailingIcon = { Icon(Icons.Filled.Close, remove, Modifier.size(16.dp)) },
                    modifier = Modifier.testTag("picker.chip.$id"))
            }
            androidx.compose.foundation.text.BasicTextField(query, onQuery, singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier.widthIn(min = 120.dp).weight(1f).align(Alignment.CenterVertically).heightIn(min = 36.dp)
                    .onPreviewKeyEvent { e ->
                        if (e.key == androidx.compose.ui.input.key.Key.Backspace && e.type == androidx.compose.ui.input.key.KeyEventType.KeyDown && query.isEmpty() && picked.isNotEmpty()) { onBackspaceEmpty(); true } else false
                    }.testTag("compose.search"),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty()) Text(stringResource(if (picked.isEmpty()) R.string.compose_search else R.string.compose_add_more),
                            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        inner()
                    }
                })
        }
    }
}

/** Persona en «Mensaje nuevo»: círculo de selección, foto y nombre (tocar marca), y 💬 que abre su directo al instante. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ComposePersonRow(p: PersonDTO, data: BootstrapDTO, on: Boolean, onToggle: () -> Unit, onOpen: () -> Unit) {
    val org = Names.org(data, p.orgId)
    val line = Names.roleLine(p).ifEmpty { if (p.guest) stringResource(R.string.common_guest) else org?.name ?: "" }
    val openCd = stringResource(R.string.compose_open_direct, p.name)
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = onToggle, onLongClick = onOpen, onLongClickLabel = openCd, role = Role.Checkbox)
            .semantics { selected = on }.heightIn(min = 60.dp).padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp).testTag("picker.person.${p.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SelectCircle(on)
        Spacer(Modifier.width(10.dp))
        PersonAvatar(p, data, size = 40.dp, orgBadge = true)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(p.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (line.isNotBlank()) Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        androidx.compose.material3.IconButton(onClick = onOpen, modifier = Modifier.testTag("picker.open.${p.id}")) { Text("💬", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { contentDescription = openCd }) }
    }
}

/** Círculo de selección: vacío con borde, o relleno del acento con ✓. */
@Composable
private fun SelectCircle(on: Boolean, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Box(modifier.size(22.dp).clip(CircleShape).background(if (on) cs.primary else Color.Transparent)
        .then(if (on) Modifier.border(2.dp, cs.surface, CircleShape) else Modifier.border(2.dp, cs.outline, CircleShape)), contentAlignment = Alignment.Center) {
        if (on) Icon(Icons.Filled.Check, null, Modifier.size(15.dp), tint = cs.onPrimary)
    }
}

/** Cabecera de empresa en las listas de personas (con «Tu equipo» en la mía). */
@Composable
private fun OrgHeader(g: Names.OrgGroup) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically) {
        if (g.org != null) { OrgMark(g.org, size = 20.dp); Spacer(Modifier.width(8.dp)) }
        SectionHeader(g.org?.name ?: stringResource(R.string.common_guests), Modifier.weight(1f, fill = false))
        if (g.isMine) {
            Spacer(Modifier.width(8.dp))
            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(8.dp)) {
                Text(stringResource(R.string.chat_my_team), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).testTag("myTeamTag"))
            }
        }
    }
}

/** Chips de las personas elegidas (tocar = quitar). */
@Composable
private fun PickedChips(data: BootstrapDTO, picked: List<String>, onRemove: (String) -> Unit) {
    val remove = stringResource(R.string.common_remove)
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("pickedChips")) {
        items(picked, key = { it }) { id ->
            val p = Names.person(data, id)
            InputChip(
                selected = true, onClick = { onRemove(id) },
                label = { Text(p?.name?.substringBefore(' ') ?: "?") },
                avatar = { PersonAvatar(p, data, size = 22.dp) },
                trailingIcon = { Icon(Icons.Filled.Close, remove, Modifier.size(16.dp)) },
                modifier = Modifier.testTag("picker.chip.$id"),
            )
        }
    }
}

