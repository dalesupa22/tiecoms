package com.tiecoms.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.PersonDTO
import com.tiecoms.app.core.QuickSearch
import com.tiecoms.app.core.TieComsClient

// ---------- Barra de arriba: ✏️ Mensaje nuevo · ＋ Crear ----------

/** A dónde llevan la barra de arriba y la búsqueda rápida (lo pone AppRoot). */
data class QuickNav(
    val onCompose: () -> Unit,
    val onOpen: (String) -> Unit,
    val onOpenIssue: (String) -> Unit,
    val onJoinCode: (String) -> Unit,
)

/** Lo que se abre desde «＋ Crear» (igual en Grupos, DMs, Asuntos y Calendario). */
private sealed interface QuickSheet {
    data object Group : QuickSheet
    data class Share(val groupName: String, val url: String, val code: String?, val conversationId: String) : QuickSheet
    data object Issue : QuickSheet
    data object Event : QuickSheet
    data object Join : QuickSheet
}

/**
 * ✏️ siempre a mano para escribirle a alguien, y «＋» solo para crear: grupo, asunto o reunión (o entrar con código).
 * Todo lo demás (Archivos, Recordatorios, Trazo, WhatsApp) vive en «Tú» (docs/GRUPOS.md › Barra de arriba).
 * Va en las `actions` del TopAppBar.
 */
@Composable
fun QuickActions(nav: QuickNav) {
    val ctx = LocalContext.current
    val data = LocalClient.current.state.collectAsStateWithLifecycle().value.data
    var menu by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf<QuickSheet?>(null) }
    // Siempre se puede: al menos un asunto personal (1.6.6).
    val canCreateIssue = data != null
    Box {
        IconButton(onClick = { menu = true }, modifier = Modifier.testTag("quick.create")) { Icon(Icons.Filled.Add, stringResource(R.string.quick_create)) }
        AnchoredMenu(menu, if (menu) listOf(
            SheetItem(ctx.getString(R.string.grp_new), "#", tag = "create.group") { sheet = QuickSheet.Group },
            SheetItem(ctx.getString(R.string.menu_new_issue), "◆", enabled = canCreateIssue, tag = "create.issue") { sheet = QuickSheet.Issue },
            SheetItem(ctx.getString(R.string.cal_new_title), "📅", tag = "create.event") { sheet = QuickSheet.Event },
            null,
            SheetItem(ctx.getString(R.string.join_title), "🎟", tag = "create.join") { sheet = QuickSheet.Join },
        ) else emptyList(), { menu = false })
    }
    IconButton(onClick = nav.onCompose, modifier = Modifier.testTag("quick.compose")) { Icon(Icons.Filled.Edit, stringResource(R.string.dm_new)) }

    when (val s = sheet) {
        null -> Unit
        QuickSheet.Group -> NewGroupSheet(NewGroupPreset(company = false), onClose = { sheet = null }, onCreated = { r, name ->
            val url = r.inviteUrl
            sheet = if (url != null) QuickSheet.Share(name, url, r.inviteCode, r.conversationId) else null
            if (url == null) nav.onOpen(r.conversationId)
        })
        is QuickSheet.Share -> ShareInviteSheet(s.groupName, s.url, s.code, null, onDone = { sheet = null; nav.onOpen(s.conversationId) })
        QuickSheet.Issue -> NewIssueDialog(null, null, "", onClose = { sheet = null }, onCreated = nav.onOpenIssue)
        QuickSheet.Event -> EventDialog(null, onClose = { sheet = null })
        QuickSheet.Join -> JoinCodeDialog(onClose = { sheet = null }, onGo = { code -> sheet = null; nav.onJoinCode(code) })
    }
}

/**
 * Toque en una persona (búsqueda, «Recientes», «Mensaje nuevo»): su directo; si no existe, se crea
 * (POST /chats {userIds:[id]}, idempotente con una persona). Devuelve el id de la conversación.
 */
suspend fun openDirect(client: TieComsClient, data: BootstrapDTO, personId: String): String =
    QuickSearch.direct(data, personId)?.id ?: client.createChat(listOf(personId), null).id

// ---------- Resultados de búsqueda en las pestañas ----------

/**
 * Al buscar en Grupos o DMs también salen personas (tocar = abrir su directo), grupos y chats.
 * Quien ya tiene su directo entre los chats encontrados (o en [hidePeople]) sale una sola vez.
 */
fun LazyListScope.quickSearchSections(
    data: BootstrapDTO, results: QuickSearch.Results, hidePeople: Set<String>,
    internalFallback: String, convFallback: String, onPerson: (PersonDTO) -> Unit, onConv: (String) -> Unit,
) {
    val people = results.people.filter { it.id !in hidePeople && it.id !in QuickSearch.directPeople(results.chats) }.take(8)
    if (people.isNotEmpty()) {
        item(key = "qs:people") { QuickHeader(R.string.search_people) }
        items(people, key = { "qs:p:" + it.id }) { p -> PersonPickRow(p, data, on = null, tag = "search.person.${p.id}") { onPerson(p) } }
    }
    if (results.groups.isNotEmpty()) {
        item(key = "qs:groups") { QuickHeader(R.string.search_groups) }
        items(results.groups.take(8), key = { "qs:g:" + it.id }) { c -> SearchConvRow(c, data, internalFallback, convFallback) { onConv(c.id) } }
    }
    if (results.chats.isNotEmpty()) {
        item(key = "qs:chats") { QuickHeader(R.string.search_chats) }
        items(results.chats.take(8), key = { "qs:c:" + it.id }) { c -> SearchConvRow(c, data, internalFallback, convFallback) { onConv(c.id) } }
    }
}

@Composable
internal fun QuickHeader(label: Int) {
    SectionHeader(stringResource(label), Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() })
}

/** Grupo o chat encontrado: con la empresa de la otra parte bajo el título (sin menú de pulsación larga). */
@Composable
private fun SearchConvRow(c: ConversationDTO, data: BootstrapDTO, internalFallback: String, convFallback: String, onClick: () -> Unit) {
    Box(Modifier.testTag("search.conv.${c.id}")) {
        ConversationRow(c, data, internalFallback, convFallback, indent = 16.dp, iconSize = 40.dp,
            menuOpen = false, menuItems = { emptyList() }, onDismissMenu = {}, onLongPress = {}, onIssues = {}, showIssuesChip = false,
            tagLine = Names.companyOf(c, data), onClick = onClick)
    }
}

/** Grupo encontrado en «Mensaje nuevo»: su ícono y «Grupo · Empresa». */
@Composable
internal fun ComposeGroupRow(c: ConversationDTO, data: BootstrapDTO, label: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 6.dp).testTag("compose.group.${c.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConversationIcon(c, data, 40.dp)
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

/** Globito junto a una persona que se abre de un toque (no se elige). */
@Composable
internal fun OpensChatIcon() {
    Icon(Icons.AutoMirrored.Outlined.Chat, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
}

