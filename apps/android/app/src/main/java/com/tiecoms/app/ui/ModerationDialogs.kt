package com.tiecoms.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.Names
import kotlinx.coroutines.launch

@Composable
fun ReportDialog(userId: String?, messageId: String? = null, onClose: () -> Unit) {
    val client = LocalClient.current
    val container = LocalContainer.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var reason by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text(stringResource(R.string.safety_report)) },
        text = {
            Column {
                Text(stringResource(R.string.safety_report_hint))
                OutlinedTextField(reason, { reason = it.take(2000) }, enabled = !busy,
                    label = { Text(stringResource(R.string.safety_reason)) }, minLines = 3,
                    modifier = Modifier.fillMaxWidth().testTag("reportReason"))
                ErrorText(error)
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && reason.trim().length >= 5, modifier = Modifier.testTag("submitReport"), onClick = {
                busy = true; error = null
                scope.launch {
                    try {
                        client.reportContent(userId, messageId, reason)
                        container.toast(ctx.getString(R.string.safety_report_sent)); onClose()
                    } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
                }
            }) { Text(stringResource(R.string.safety_send_report)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onClose) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
fun BlockUserDialog(userId: String, name: String, blocked: Boolean, onClose: () -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text(stringResource(if (blocked) R.string.safety_unblock else R.string.safety_block, name)) },
        text = { Column { Text(stringResource(if (blocked) R.string.safety_unblock_hint else R.string.safety_block_hint)); ErrorText(error) } },
        confirmButton = {
            TextButton(enabled = !busy, modifier = Modifier.testTag("confirmBlock"), onClick = {
                busy = true
                scope.launch {
                    try { client.setUserBlocked(userId, !blocked); onClose() }
                    catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
                }
            }) { Text(stringResource(if (blocked) R.string.safety_unblock_action else R.string.safety_block_action)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onClose) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
fun LegalLinks() {
    val ctx = LocalContext.current
    val es = LocalConfiguration.current.locales[0].language == "es"
    TextButton(onClick = { openUrl(ctx, if (es) "${com.tiecoms.app.core.DeepLinks.WEB_URL}/terminos/" else "${com.tiecoms.app.core.DeepLinks.WEB_URL}/en/terms/") }) {
        Text(stringResource(R.string.legal_terms))
    }
    TextButton(onClick = { openUrl(ctx, if (es) "${com.tiecoms.app.core.DeepLinks.WEB_URL}/privacidad/" else "${com.tiecoms.app.core.DeepLinks.WEB_URL}/en/privacy/") }) {
        Text(stringResource(R.string.legal_privacy))
    }
}

@Composable
fun BlockedUsersScreen(onBack: () -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val state by client.state.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf<Pair<String, String>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        try { client.loadBlocks(); loaded = true } catch (e: Exception) { error = errorText(ctx, e) }
    }
    SimpleScaffold(stringResource(R.string.safety_blocked_users), onBack) {
        LazyColumn(Modifier.fillMaxWidth().padding(16.dp).testTag("blockedUsers")) {
            item { ErrorText(error) }
            if (loaded && state.blockedUserIds.isEmpty()) item { Text(stringResource(R.string.safety_none_blocked)) }
            items(state.blockedUserIds.toList().sorted(), key = { it }) { id ->
                val name = state.data?.let { Names.person(it, id)?.name } ?: stringResource(R.string.safety_unknown_user, id.take(8))
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(name)
                    TextButton(onClick = { selected = id to name }, modifier = Modifier.testTag("unblock-$id")) {
                        Text(stringResource(R.string.safety_unblock_action))
                    }
                }
            }
        }
    }
    selected?.let { (id, name) -> BlockUserDialog(id, name, blocked = true, onClose = { selected = null }) }
}
