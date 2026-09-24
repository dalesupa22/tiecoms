package com.tiecoms.app.ui

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
fun PeoplePicker(data: BootstrapDTO, picked: List<String>, onToggle: (String) -> Unit, exclude: Set<String> = emptySet(), modifier: Modifier = Modifier) {
    var q by rememberSaveable { mutableStateOf("") }
    val groups = remember(data, q, exclude) { Names.peopleByOrg(data, q, exclude) }
    Column(modifier) {
        OutlinedTextField(
            q, { q = it }, placeholder = { Text(stringResource(R.string.chat_search_people)) }, singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, null) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("peopleSearch"),
        )
        if (picked.isNotEmpty()) {
            val remove = stringResource(R.string.common_remove)
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 6.dp).testTag("pickedChips")) {
                items(picked, key = { it }) { id ->
                    val p = Names.person(data, id)
                    InputChip(
                        selected = true, onClick = { onToggle(id) },
                        label = { Text(p?.name?.substringBefore(' ') ?: "?") },
                        avatar = { PersonAvatar(p, data, size = 22.dp) },
                        trailingIcon = { Icon(Icons.Filled.Close, remove, Modifier.size(16.dp)) },
                    )
                }
            }
        }
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = true).testTag("peopleList")) {
            if (groups.isEmpty()) item { EmptyNote(stringResource(R.string.chat_nobody)) }
            groups.forEach { g ->
                item(key = "g:" + g.key) {
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
                items(g.people, key = { it.id }) { p -> PersonPickRow(p, data, p.id in picked) { onToggle(p.id) } }
            }
        }
    }
}

@Composable
private fun PersonPickRow(p: PersonDTO, data: BootstrapDTO, on: Boolean, onToggle: () -> Unit) {
    val org = Names.org(data, p.orgId)
    val line = Names.roleLine(p).ifEmpty { if (p.guest) stringResource(R.string.common_guest) else org?.name ?: "" }
    Row(
        Modifier.fillMaxWidth().toggleable(on, role = Role.Checkbox) { onToggle() }.heightIn(min = 60.dp).padding(horizontal = 12.dp, vertical = 6.dp).testTag("person-${p.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(on, null)
        Spacer(Modifier.width(6.dp))
        PersonAvatar(p, data, size = 40.dp, orgBadge = true)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(p.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (line.isNotBlank()) Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// ---------- Nuevo chat ----------
/** Nuevo chat: una persona abre su directo; varias crean un chat grupal (pueden ser de empresas distintas). */
@Composable
fun NewChatScreen(onBack: () -> Unit, onOpened: (String) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var name by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    SimpleScaffold(title = stringResource(R.string.chat_new), onBack = onBack) {
        Text(stringResource(R.string.chat_new_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        PeoplePicker(data, picked, { id -> picked = if (id in picked) picked - id else picked + id }, modifier = Modifier.weight(1f))
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (picked.size > 1) {
                val orgs = Names.chatOrgs(data, picked)
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("chatOrgs")) {
                    orgs.take(6).forEach { OrgMark(it, size = 20.dp, modifier = Modifier.padding(end = 4.dp)) }
                    Spacer(Modifier.width(4.dp))
                    Text(if (orgs.size > 1) stringResource(R.string.chat_cross_company, orgs.size) else stringResource(R.string.chat_same_company),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                OutlinedTextField(name, { name = it.take(120) }, placeholder = { Text(stringResource(R.string.chat_group_name_ph)) }, singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("chatName"))
            }
            Button(
                enabled = picked.isNotEmpty() && !busy,
                onClick = {
                    busy = true
                    scope.launch {
                        try { onOpened(client.createChat(picked, name).id) }
                        catch (e: Exception) { container.toast(errorText(ctx, e)) } finally { busy = false }
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("createChat"),
            ) { Text(if (picked.size > 1) stringResource(R.string.chat_create_group, picked.size + 1) else stringResource(R.string.chat_open_direct), fontWeight = FontWeight.SemiBold) }
        }
    }
}

/** Sumar personas a un chat grupal: ven desde ahora (history 'now'). */
@Composable
fun AddMembersScreen(conversationId: String, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val meta = data.conversations.firstOrNull { it.id == conversationId }
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    SimpleScaffold(title = stringResource(R.string.dlg_add_to_group), onBack = onBack) {
        if (meta == null) { EmptyNote(stringResource(R.string.chat_not_found)); return@SimpleScaffold }
        PeoplePicker(data, picked, { id -> picked = if (id in picked) picked - id else picked + id }, exclude = meta.memberIds.toSet(), modifier = Modifier.weight(1f))
        Button(
            enabled = picked.isNotEmpty() && !busy,
            onClick = {
                busy = true
                scope.launch {
                    try { client.addMembers(conversationId, picked); onBack() }
                    catch (e: Exception) { container.toast(errorText(ctx, e)) } finally { busy = false }
                }
            },
            modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp).heightIn(min = 52.dp).testTag("addMembersConfirm"),
        ) { Text(stringResource(R.string.dlg_add_to_group) + if (picked.isNotEmpty()) " · ${picked.size}" else "", fontWeight = FontWeight.SemiBold) }
    }
}
