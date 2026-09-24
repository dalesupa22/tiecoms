package com.tiecoms.app.ui

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.BuildConfig
import com.tiecoms.app.R
import com.tiecoms.app.core.InvitationPreviewDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.launch

// ---------- Detalles de conversación ----------
@Composable
fun DetailsScreen(id: String, onBack: () -> Unit) {
    val client = LocalClient.current
    val state by client.state.collectAsStateWithLifecycle()
    val data = state.data
    val meta = data?.conversations?.firstOrNull { it.id == id }
    val title = meta?.let { Names.conversationTitle(it, data, stringResource(R.string.internal_default), stringResource(R.string.conversation)) } ?: stringResource(R.string.details)
    SimpleScaffold(title = title, onBack = onBack) {
        if (meta == null || data == null) {
            Text(stringResource(R.string.chat_not_found), Modifier.padding(24.dp))
            return@SimpleScaffold
        }
        val ws = data.workspaces.firstOrNull { it.id == meta.workspaceId }
        val people = meta.memberIds.mapNotNull { Names.person(data, it) }
            .sortedWith(compareBy({ it.guest }, { it.orgId != data.me.primaryOrgId }, { it.name }))
        val (members, guests) = people.partition { !it.guest }
        LazyColumn(Modifier.fillMaxWidth().testTag("participants")) {
            item {
                Column(Modifier.padding(16.dp)) {
                    if (ws != null) {
                        SectionHeader(stringResource(R.string.space))
                        Text(ws.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
                    }
                    SectionHeader(stringResource(R.string.scope))
                    Text(
                        when (meta.kind) {
                            "internal" -> stringResource(R.string.scope_internal, Names.org(data, meta.internalOrgId)?.name ?: "")
                            "direct" -> stringResource(R.string.scope_direct)
                            else -> stringResource(R.string.scope_group)
                        },
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            item { SectionHeader("${stringResource(R.string.participants)} · ${members.size}", Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() }) }
            items(members, key = { it.id }) { PersonRow(it, data) }
            if (guests.isNotEmpty()) {
                item { SectionHeader("${stringResource(R.string.guests)} · ${guests.size}", Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() }) }
                items(guests, key = { it.id }) { PersonRow(it, data) }
            }
        }
    }
}

@Composable
private fun PersonRow(p: com.tiecoms.app.core.PersonDTO, data: com.tiecoms.app.core.BootstrapDTO) {
    val org = Names.org(data, p.orgId)
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 8.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
        Avatar(p.name, parseColor(org?.colorBg, Brand.Black), parseColor(org?.colorFg, Color.White), size = 40.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(p.name + if (p.id == data.me.id) " " + stringResource(R.string.you) else "", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(
                listOfNotNull(org?.name ?: stringResource(R.string.no_company), p.title?.takeIf { it.isNotBlank() }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (p.guest) {
                Text(
                    if (p.guestUntil != null) stringResource(R.string.guest_until, dateText(p.guestUntil)) else stringResource(R.string.guest),
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.testTag("guest-${p.id}"),
                )
            }
        }
    }
}

// ---------- Ajustes ----------
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val client = LocalClient.current
    val container = LocalContainer.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by client.state.collectAsStateWithLifecycle()
    val data = state.data
    var sounds by remember { mutableStateOf(container.settings.soundsEnabled) }
    var notifOn by remember { mutableStateOf(container.notifier.enabled()) }
    var confirmLogout by rememberSaveable { mutableStateOf(false) }

    // Al volver de los ajustes del sistema se refleja el estado real del permiso.
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) notifOn = container.notifier.enabled() }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    SimpleScaffold(title = stringResource(R.string.settings), onBack = onBack) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            SettingsSection(stringResource(R.string.account)) {
                val me = data?.me
                val org = Names.org(data, me?.primaryOrgId)
                Text(me?.name ?: "", style = MaterialTheme.typography.titleMedium)
                me?.email?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                org?.let { Text(it.name, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            HorizontalDivider()
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Switch) { sounds = !sounds; container.settings.soundsEnabled = sounds }
                    .padding(16.dp).semantics(mergeDescendants = true) {}.testTag("soundsRow"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.sounds), style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.sounds_desc), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.width(12.dp))
                Switch(checked = sounds, onCheckedChange = null)
            }
            HorizontalDivider()
            Column(
                Modifier.fillMaxWidth().clickable {
                    val i = if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                    else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    runCatching { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }.padding(16.dp).semantics(mergeDescendants = true) {},
            ) {
                Text(stringResource(R.string.notifications), style = MaterialTheme.typography.titleMedium)
                Text(
                    stringResource(if (notifOn) R.string.notif_on else R.string.notif_off), style = MaterialTheme.typography.bodySmall,
                    color = if (notifOn) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
                )
            }
            HorizontalDivider()
            SettingsSection(stringResource(R.string.language)) {
                Text(stringResource(R.string.language_desc), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (BuildConfig.DEBUG) {
                HorizontalDivider()
                SettingsSection(stringResource(R.string.server)) {
                    Text(client.baseUrl, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            HorizontalDivider()
            Spacer(Modifier.height(16.dp))
            OutlinedButton(onClick = { confirmLogout = true }, modifier = Modifier.padding(horizontal = 16.dp).fillMaxWidth().heightIn(min = 48.dp).testTag("logout")) {
                Text(stringResource(R.string.logout), color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(24.dp))
            Text(
                stringResource(R.string.version, BuildConfig.VERSION_NAME) + " (${BuildConfig.VERSION_CODE})",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center,
            )
        }
    }
    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            text = { Text(stringResource(R.string.logout_confirm)) },
            confirmButton = { TextButton(onClick = { confirmLogout = false; scope.launch { client.logout() } }, modifier = Modifier.testTag("confirmLogout")) { Text(stringResource(R.string.logout)) } },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun SettingsSection(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        SectionHeader(title, Modifier.padding(bottom = 6.dp).semantics { heading() })
        content()
    }
}

// ---------- Invitación a un espacio ----------
@Composable
fun InviteScreen(token: String, signedIn: Boolean, onBack: () -> Unit, onLogin: () -> Unit, onSignup: () -> Unit, onJoined: (workspaceId: String, conversationId: String?) -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var preview by remember { mutableStateOf<InvitationPreviewDTO?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(token, reload) {
        error = null
        try { preview = client.previewInvitation(token) } catch (e: Exception) { error = errorText(ctx, e) }
    }

    SimpleScaffold(title = stringResource(R.string.invite_title), onBack = onBack) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Logo(Modifier.widthIn(max = 180.dp).fillMaxWidth(0.45f))
            Spacer(Modifier.height(24.dp))
            val p = preview
            when {
                p == null && error == null -> CircularProgressIndicator()
                p == null -> {
                    ErrorText(error)
                    Button(onClick = { reload++ }) { Text(stringResource(R.string.retry)) }
                }
                !p.valid -> Text(stringResource(R.string.invite_invalid), textAlign = TextAlign.Center, modifier = Modifier.testTag("inviteInvalid"))
                else -> {
                    Text(p.workspaceName, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
                    Spacer(Modifier.height(8.dp))
                    Text(
                        stringResource(R.string.invite_by, p.invitedByName, if (p.invitedByOrg.isNotBlank()) " (${p.invitedByOrg})" else "", roleText(ctx, p.role)),
                        textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    p.email?.let { Text(stringResource(R.string.invite_for, it), textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
                    Spacer(Modifier.height(24.dp))
                    if (signedIn) {
                        ErrorText(error)
                        Button(
                            enabled = !busy,
                            onClick = {
                                busy = true; error = null
                                scope.launch {
                                    try {
                                        val r = client.acceptInvitation(token)
                                        onJoined(r.workspaceId, r.conversationIds.firstOrNull())
                                    } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
                                }
                            },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("join"),
                        ) { Text(stringResource(if (busy) R.string.invite_joining else R.string.invite_join), fontWeight = FontWeight.SemiBold) }
                    } else {
                        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium) {
                            Text(stringResource(R.string.invite_login_first), Modifier.padding(12.dp), textAlign = TextAlign.Center)
                        }
                        Spacer(Modifier.height(16.dp))
                        Button(onClick = onLogin, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(stringResource(R.string.login)) }
                        Spacer(Modifier.height(8.dp))
                        OutlinedButton(onClick = onSignup, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(stringResource(R.string.create_account)) }
                    }
                }
            }
        }
    }
}
