package com.tiecoms.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.*
import kotlinx.coroutines.launch

/**
 * «✉ Redactar correo» con gg (2-oct-2026, «siempre pidiendo confirmación»). gg redacta con el chat (POST /gg/mail-draft);
 * la persona revisa y edita; «Enviar» pide confirmar a quién y desde qué cuenta, y solo entonces POST /gg/mail-send.
 * La clave de envío es la misma mientras el correo no cambie: un doble toque o un reintento no lo manda dos veces.
 * Destinatarios: gg solo propone correos escritos en el chat (chaggu no revela el correo de nadie).
 */
@Composable
fun GgMailSheet(source: String, messageIds: List<String>, instruction: String? = null, onConsent: ((suspend () -> Unit) -> Unit)? = null, onClose: () -> Unit) {
    val client = LocalClient.current; val ctx = LocalContext.current; val scope = rememberCoroutineScope()
    /** null = redactando; false = sin borrador; true = listo (o falta conectar). */
    var drafted by remember { mutableStateOf<Boolean?>(null) }
    var draft by remember { mutableStateOf<GgMailDraft?>(null) }
    var to by remember { mutableStateOf("") }
    var cc by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var sent by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    val key = remember { GgMail.Key() }

    suspend fun load() {
        drafted = null; error = null
        val d = client.ggMailDraft(source, messageIds, instruction)
        draft = d; drafted = true
        to = d.to.joinToString(", "); cc = d.cc.joinToString(", "); subject = d.subject.take(300); body = d.body.take(20000)
    }
    LaunchedEffect(reload) {
        try { load() }
        catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            drafted = false
            if (e is ApiException && e.status == 403 && e.code == "ai_consent_required" && onConsent != null) onConsent { load() } else error = errorText(ctx, e)
        }
    }
    val toList = GgMail.parse(to); val ccList = GgMail.parse(cc).filterNot { it in toList }
    val bad = GgMail.invalid(toList + ccList)
    val d = draft
    val fromLabel = d?.from ?: when (d?.provider) { "google" -> "Gmail"; "microsoft" -> "Outlook"; else -> stringResource(R.string.ggmail_your_mailbox) }
    val checkText = stringResource(R.string.ggmail_check, bad.joinToString(", "))
    val incomplete = stringResource(R.string.ggmail_incomplete)

    FormSheet(stringResource(R.string.ggmail_title), onClose, tag = "ggMailSheet") {
        when {
            drafted == null -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("ggMailPreparing")) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.ggmail_preparing), style = MaterialTheme.typography.bodySmall)
            }
            drafted == false -> {
                if (error == null) Text(stringResource(R.string.ggmail_failed), color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = { reload++ }, modifier = Modifier.testTag("ggMailRetry")) { Text(stringResource(R.string.ggmail_retry)) }
            }
            d != null && !d.ready -> Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.testTag("ggMailNeedsConnect")) {
                Text(stringResource(R.string.ggmail_needs_connect))
                // Las mismas tarjetas de Tú › Correo (conectar Gmail/Outlook); luego «Redactar de nuevo».
                val (connections, connError) = rememberMailConnections()
                connections?.let { MailConnectCards(it) }
                ErrorText(connError)
                OutlinedButton(onClick = { reload++ }, modifier = Modifier.testTag("ggMailRetry")) { Text(stringResource(R.string.ggmail_retry)) }
            }
            d != null && sent -> Text(stringResource(R.string.ggmail_sent), style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("ggMailSent"))
            d != null -> {
                Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().testTag("ggMailNote")) {
                    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(stringResource(R.string.ggmail_note), style = MaterialTheme.typography.bodySmall)
                        if (d.missingPeople.isNotEmpty()) Text(stringResource(R.string.ggmail_missing, d.missingPeople.joinToString(", ")), style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("ggMailMissing"))
                    }
                }
                Text(stringResource(R.string.ggmail_from, fromLabel), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("ggMailFrom"))
                OutlinedTextField(to, { to = it.take(2000) }, label = { Text(stringResource(R.string.ggmail_to)) }, placeholder = { Text("correo@empresa.com") },
                    isError = GgMail.invalid(toList).isNotEmpty(), modifier = Modifier.fillMaxWidth().testTag("ggMailTo"))
                OutlinedTextField(cc, { cc = it.take(2000) }, label = { Text(stringResource(R.string.ggmail_cc)) },
                    isError = GgMail.invalid(ccList).isNotEmpty(), modifier = Modifier.fillMaxWidth().testTag("ggMailCc"))
                OutlinedTextField(subject, { subject = it.take(300) }, label = { Text(stringResource(R.string.ggmail_subject)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("ggMailSubject"))
                OutlinedTextField(body, { body = it.take(20000) }, label = { Text(stringResource(R.string.ggmail_body)) }, minLines = 6, modifier = Modifier.fillMaxWidth().testTag("ggMailBody"))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onClose) { Text(stringResource(R.string.cancel)) }
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = {
                        error = when {
                            bad.isNotEmpty() -> checkText
                            toList.isEmpty() || toList.size > 20 || ccList.size > 20 || subject.isBlank() || body.isBlank() -> incomplete
                            else -> null
                        }
                        if (error == null) confirming = true
                    }, enabled = !busy && toList.isNotEmpty(), modifier = Modifier.testTag("ggMailSend")) {
                        Text(stringResource(if (busy) R.string.ggmail_sending else R.string.ggmail_send))
                    }
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
        ErrorText(error)
    }

    if (confirming && d != null) {
        val provider = d.provider
        val recipients = toList.joinToString(", ") + if (ccList.isNotEmpty()) " " + stringResource(R.string.ggmail_confirm_cc, ccList.joinToString(", ")) else ""
        AlertDialog(onDismissRequest = { confirming = false }, modifier = Modifier.testTag("ggMailConfirm"),
            title = { Text(stringResource(R.string.ggmail_confirm_title)) },
            text = { Text(stringResource(R.string.ggmail_confirm_text, fromLabel, recipients)) },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    if (provider == null || busy || sent) return@TextButton
                    // Si el correo cambió desde el último intento, es otro envío: otra clave.
                    val k = key.forContent(toList, ccList, subject, body)
                    scope.launch { busy = true; error = null
                        try { client.ggMailSend(source, provider, k, toList, ccList, subject, body); sent = true }
                        catch (e: Exception) {
                            if (e is kotlinx.coroutines.CancellationException) throw e
                            // Rechazado por el servidor (no salió): el próximo intento lleva otra clave. Sin red: la misma.
                            if (e is ApiException && e.code != "mail_send_busy") key.reset()
                            // El buzón se desconectó mientras tanto: se muestra «Conecta tu correo».
                            if (e is ApiException && e.code == "mail_connect_required") draft = d.copy(status = "needs_connect")
                            error = errorText(ctx, e)
                        }
                        finally { busy = false }
                    }
                }, modifier = Modifier.testTag("ggMailConfirmSend")) { Text(stringResource(R.string.ggmail_send)) }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text(stringResource(R.string.cancel)) } })
    }
}
