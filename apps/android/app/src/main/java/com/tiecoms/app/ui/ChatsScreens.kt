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
 * «Mensaje nuevo» (✏️, docs/GRUPOS.md › Barra de arriba; igual que iOS): tocar a una persona abre el chat de una vez
 * (su directo; si no existe, se crea). Arriba, «Recientes» con quienes hablé hace poco y «Chat con varias personas»,
 * que cambia a selección múltiple (1 → directo, 2+ → chat grupal de una o varias empresas). Al buscar también salen
 * los grupos que coinciden, para entrar sin pasar por su empresa. El buscador va fijo arriba, fuera de la lista.
 */
@Composable
fun NewChatScreen(onBack: () -> Unit, onOpened: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var query by rememberSaveable { mutableStateOf("") }
    var multi by rememberSaveable { mutableStateOf(false) }
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var name by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val internalFallback = stringResource(R.string.internal_default)
    val convFallback = stringResource(R.string.conversation)
    val title: (com.tiecoms.app.core.ConversationDTO) -> String = { Names.conversationTitle(it, data, internalFallback, convFallback) }
    fun exitMulti() { multi = false; picked = emptyList(); name = "" }
    // Atrás en selección múltiple vuelve a «Mensaje nuevo» (no cierra la pantalla).
    androidx.activity.compose.BackHandler(enabled = multi) { exitMulti() }
    // Al elegir o pasar a varias personas se baja el teclado: la lista queda a la vista (iOS lo baja al desplazar).
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    fun toggle(id: String) { focus.clearFocus(); picked = if (id in picked) picked - id else picked + id }
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
    /** Un toque: el directo con esa persona (el que ya existe o uno nuevo). */
    fun open(p: PersonDTO) = launchOpen { openDirect(client, data, p.id) }

    val searching = query.isNotBlank()
    val orgs = remember(data, query) { Names.peopleByOrg(data, query) }
    val groups = remember(data, query, multi) { if (multi) emptyList() else QuickSearch.groups(data, query, title) }
    val recents = remember(data) { QuickSearch.recentPeopleIds(data).take(8).mapNotNull { Names.person(data, it) } }
    SimpleScaffold(title = stringResource(if (multi) R.string.compose_multi else R.string.dm_new), onBack = { if (multi) exitMulti() else onBack() }) {
        SearchField(query, placeholder = stringResource(R.string.compose_search), tag = "compose.search") { query = it }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            LazyColumn(Modifier.fillMaxSize().testTag("peopleList")) {
                if (multi) {
                    item(key = "multiHint") {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.compose_multi_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (picked.isNotEmpty()) PickedChips(data, picked) { toggle(it) }
                            if (picked.size > 1) OutlinedTextField(name, { name = it.take(120) }, placeholder = { Text(stringResource(R.string.chat_group_name_ph)) }, singleLine = true,
                                modifier = Modifier.fillMaxWidth().testTag("newChat.name"))
                        }
                    }
                } else if (!searching) {
                    item(key = "multi") {
                        Row(Modifier.fillMaxWidth().clickable { focus.clearFocus(); multi = true }.heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 6.dp).testTag("compose.multi"),
                            verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.primary, CircleShape), contentAlignment = Alignment.Center) {
                                Icon(Icons.Filled.Groups, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onPrimary)
                            }
                            Spacer(Modifier.width(12.dp))
                            Text(stringResource(R.string.compose_multi), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (recents.isNotEmpty()) item(key = "recents") {
                        Column {
                            QuickHeader(R.string.compose_recent)
                            val opens = stringResource(R.string.search_opens_chat)
                            LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("compose.recents")) {
                                items(recents, key = { it.id }) { p ->
                                    Column(
                                        Modifier.width(68.dp).clip(RoundedCornerShape(12.dp)).clickable(onClickLabel = opens) { open(p) }.padding(vertical = 6.dp)
                                            .semantics(mergeDescendants = true) { contentDescription = p.name }.testTag("compose.recent.${p.id}"),
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                    ) {
                                        PersonAvatar(p, data, size = 52.dp, orgBadge = true)
                                        Spacer(Modifier.heightIn(min = 4.dp))
                                        Text(p.name.substringBefore(' '), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
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
                    items(g.people, key = { "p:" + it.id }) { p ->
                        PersonPickRow(p, data, on = if (multi) p.id in picked else null, tag = "picker.person.${p.id}") { if (multi) toggle(p.id) else open(p) }
                    }
                }
                item(key = "end") { Spacer(Modifier.heightIn(min = 24.dp)) }
            }
            if (busy && !multi) androidx.compose.material3.CircularProgressIndicator(Modifier.align(Alignment.Center).testTag("compose.busy"))
        }
        if (multi) Button(
            enabled = picked.isNotEmpty() && !busy,
            onClick = {
                val ids = picked; val chatName = name
                launchOpen { if (ids.size == 1) openDirect(client, data, ids[0]) else client.createChat(ids, chatName).id }
            },
            modifier = Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(16.dp).heightIn(min = 52.dp).testTag("newChat.create"),
        ) { Text(if (picked.size > 1) stringResource(R.string.chat_create_group, picked.size + 1) else stringResource(R.string.chat_open_direct), fontWeight = FontWeight.SemiBold) }
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

