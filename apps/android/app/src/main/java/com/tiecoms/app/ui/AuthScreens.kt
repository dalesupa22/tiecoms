package com.tiecoms.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.core.SsoProvider
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.tiecoms.app.BuildConfig
import com.tiecoms.app.R
import com.tiecoms.app.core.OrgInvitationPreviewDTO
import kotlinx.coroutines.launch

@Composable
fun AuthScaffold(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 460.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) { content() }
    }
}

@Composable
fun ErrorText(text: String?) {
    if (text == null) return
    Text(
        text,
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("error"),
    )
}

@Composable
fun PasswordField(value: String, onChange: (String) -> Unit, label: String, imeAction: ImeAction, onDone: () -> Unit, supporting: String? = null, tag: String = "password") {
    var visible by rememberSaveable { mutableStateOf(false) }
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = true,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = imeAction),
        keyboardActions = KeyboardActions(onDone = { onDone() }, onGo = { onDone() }),
        supportingText = supporting?.let { { Text(it) } },
        trailingIcon = {
            TextButton(onClick = { visible = !visible }) {
                Text(stringResource(if (visible) R.string.hide_password else R.string.show_password), style = MaterialTheme.typography.labelSmall)
            }
        },
        modifier = Modifier.fillMaxWidth().testTag(tag),
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LoginScreen(onSignup: () -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var serverDialog by rememberSaveable { mutableStateOf(false) }
    var pendingSso by remember { mutableStateOf<SsoProvider?>(null) }
    val container = LocalContainer.current
    val sso by container.sso.collectAsStateWithLifecycle()
    val exchanging = sso == com.tiecoms.app.AppContainer.SsoUi.Exchanging
    val ssoError = (sso as? com.tiecoms.app.AppContainer.SsoUi.Failed)?.message

    fun submit() {
        if (busy) return
        if (email.isBlank() || password.isEmpty()) { error = ctx.getString(R.string.fill_required); return }
        busy = true; error = null
        scope.launch {
            try { client.login(email, password) } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
        }
    }

    AuthScaffold {
        Spacer(Modifier.height(32.dp))
        // Mantener pulsado el logo abre la configuración del servidor (solo builds debug).
        Logo(
            Modifier.widthIn(max = 260.dp).fillMaxWidth(0.7f).combinedClickable(
                interactionSource = remember { MutableInteractionSource() }, indication = null,
                onClick = {}, onLongClick = { if (BuildConfig.DEBUG) serverDialog = true },
            ),
        )
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.tagline), style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(28.dp))
        // SSO arriba del formulario.
        SsoButton(stringResource(R.string.sso_google), "G", enabled = !busy && !exchanging, tag = "ssoGoogle") {
            error = null; pendingSso = SsoProvider.GOOGLE
        }
        Spacer(Modifier.height(10.dp))
        SsoButton(stringResource(R.string.sso_microsoft), "M", enabled = !busy && !exchanging, tag = "ssoMicrosoft") {
            error = null; pendingSso = SsoProvider.MICROSOFT
        }
        if (exchanging) {
            Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.sso_signing_in), style = MaterialTheme.typography.bodyMedium)
            }
        }
        ErrorText(ssoError)
        Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            HorizontalDivider(Modifier.weight(1f))
            Text(stringResource(R.string.auth_or_email), Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            HorizontalDivider(Modifier.weight(1f))
        }
        OutlinedTextField(
            value = email, onValueChange = { email = it }, label = { Text(stringResource(R.string.email)) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
            modifier = Modifier.fillMaxWidth().testTag("email"),
        )
        Spacer(Modifier.height(12.dp))
        PasswordField(password, { password = it }, stringResource(R.string.password), ImeAction.Go, ::submit)
        ErrorText(error)
        Spacer(Modifier.height(12.dp))
        Button(onClick = ::submit, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("login")) {
            if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.login), fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(28.dp))
        Text(stringResource(R.string.no_account), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        TextButton(onClick = onSignup, modifier = Modifier.testTag("goSignup")) { Text(stringResource(R.string.create_account), fontWeight = FontWeight.SemiBold) }
        LegalLinks()
        if (BuildConfig.DEBUG) {
            Text(client.baseUrl, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
        }
    }
    if (serverDialog) ServerDialog(onDismiss = { serverDialog = false })
    pendingSso?.let { provider ->
        AlertDialog(
            onDismissRequest = { pendingSso = null },
            title = { Text(stringResource(R.string.legal_terms)) },
            text = { Column { Text(stringResource(R.string.legal_accept)); LegalLinks() } },
            confirmButton = { TextButton(onClick = { pendingSso = null; container.startSso(ctx, provider) }, modifier = Modifier.testTag("acceptSsoTerms")) { Text(stringResource(R.string.legal_accept_continue)) } },
            dismissButton = { TextButton(onClick = { pendingSso = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
fun SsoButton(label: String, mark: String, enabled: Boolean, tag: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag(tag)) {
        // Marca simple (no el logotipo del proveedor): decorativa para lectores de pantalla.
        Text(mark, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, modifier = Modifier.clearAndSetSemantics {})
        Spacer(Modifier.width(12.dp))
        Text(label, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun ServerDialog(onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val client = LocalClient.current
    var url by rememberSaveable { mutableStateOf(client.baseUrl) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.debug_server)) },
        text = {
            Column {
                OutlinedTextField(url, { url = it }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("serverUrl"),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                Text(stringResource(R.string.debug_server_hint), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (url.startsWith("http://") || url.startsWith("https://")) container.setDebugApiUrl(url)
                onDismiss()
            }) { Text(stringResource(R.string.save)) }
        },
        dismissButton = {
            Row {
                TextButton(onClick = { container.setDebugApiUrl(null); onDismiss() }) { Text(stringResource(R.string.reset)) }
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
            }
        },
    )
}

@Composable
fun SignupScreen(orgToken: String?, onLogin: () -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var name by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var company by rememberSaveable { mutableStateOf("") }
    var title by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<OrgInvitationPreviewDTO?>(null) }
    var previewFailed by remember { mutableStateOf(false) }
    var acceptedTerms by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(orgToken) {
        if (orgToken == null) return@LaunchedEffect
        try {
            val p = client.previewOrgInvitation(orgToken)
            preview = p
            if (p.email != null && email.isBlank()) email = p.email
        } catch (e: Exception) { previewFailed = true }
    }
    val joining = orgToken != null && preview?.valid == true

    fun submit() {
        if (busy) return
        if (!acceptedTerms) { error = ctx.getString(R.string.legal_required); return }
        if (name.isBlank() || email.isBlank() || (!joining && company.isBlank())) { error = ctx.getString(R.string.fill_required); return }
        if (password.length < 10) { error = ctx.getString(R.string.password_short); return }
        busy = true; error = null
        scope.launch {
            try {
                client.signup(name, email, password, if (joining) null else company, if (joining) orgToken else null, title)
            } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = false }
        }
    }

    AuthScaffold {
        Spacer(Modifier.height(16.dp))
        Logo(Modifier.widthIn(max = 180.dp).fillMaxWidth(0.45f))
        Spacer(Modifier.height(20.dp))
        if (orgToken != null) {
            when {
                preview?.valid == true -> {
                    Text(stringResource(R.string.joining, preview!!.orgName), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
                    Text(stringResource(R.string.joining_by, preview!!.invitedByName), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                }
                preview != null || previewFailed -> ErrorText(stringResource(R.string.org_invite_invalid))
                else -> CircularProgressIndicator(Modifier.size(24.dp))
            }
            Spacer(Modifier.height(16.dp))
        }
        val fieldMod = Modifier.fillMaxWidth()
        val next = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) })
        // En las apps el SSO va por el navegador del sistema. Para crear empresa hace falta su nombre.
        val container = LocalContainer.current
        val sso by container.sso.collectAsStateWithLifecycle()
        fun ssoSignup(p: SsoProvider) {
            if (!acceptedTerms) { error = ctx.getString(R.string.legal_required); return }
            if (!joining && company.isBlank()) { error = ctx.getString(R.string.auth_sso_needs_company); return }
            error = null
            container.startSso(ctx, p, orgInviteToken = if (joining) orgToken else null, orgName = if (joining) null else company.trim())
        }
        if (!joining) {
            OutlinedTextField(company, { company = it }, label = { Text(stringResource(R.string.company)) }, singleLine = true, modifier = fieldMod.testTag("company"),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next), keyboardActions = next)
            Spacer(Modifier.height(10.dp))
        }
        LegalLinks()
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = acceptedTerms, onCheckedChange = { acceptedTerms = it }, modifier = Modifier.testTag("acceptTerms"))
            Text(stringResource(R.string.legal_accept), style = MaterialTheme.typography.bodySmall)
        }
        SsoButton(stringResource(R.string.sso_google), "G", enabled = !busy && acceptedTerms, tag = "ssoGoogleSignup") { ssoSignup(SsoProvider.GOOGLE) }
        Spacer(Modifier.height(8.dp))
        SsoButton(stringResource(R.string.sso_microsoft), "M", enabled = !busy && acceptedTerms, tag = "ssoMicrosoftSignup") { ssoSignup(SsoProvider.MICROSOFT) }
        ErrorText((sso as? com.tiecoms.app.AppContainer.SsoUi.Failed)?.message)
        Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            HorizontalDivider(Modifier.weight(1f))
            Text(stringResource(R.string.auth_or_email), Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            HorizontalDivider(Modifier.weight(1f))
        }
        OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.name)) }, singleLine = true, modifier = fieldMod.testTag("name"),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next), keyboardActions = next)
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(email, { email = it }, label = { Text(stringResource(R.string.email)) }, singleLine = true, modifier = fieldMod.testTag("email"),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next), keyboardActions = next)
        Spacer(Modifier.height(10.dp))
        PasswordField(password, { password = it }, stringResource(R.string.password), ImeAction.Next, { focus.moveFocus(FocusDirection.Down) }, stringResource(R.string.password_hint))
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(title, { title = it }, label = { Text(stringResource(R.string.role_title)) }, singleLine = true, modifier = fieldMod.testTag("title"),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }))
        ErrorText(error)
        Spacer(Modifier.height(12.dp))
        Button(onClick = ::submit, enabled = !busy && acceptedTerms, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("signup")) {
            if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            else Text(stringResource(if (joining) R.string.signup_join else R.string.signup), fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Text(stringResource(R.string.have_account), color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onLogin) { Text(stringResource(R.string.login), fontWeight = FontWeight.SemiBold) }
        }
    }
}
