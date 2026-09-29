package com.tiecoms.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.MailSystem
import com.tiecoms.app.core.MessageDTO
import com.tiecoms.app.core.Names
import com.tiecoms.app.ui.theme.LocalChatColors

/**
 * Aviso de sistema del correo o de WhatsApp como texto (sys.mail.*, sys.wa.shared), nunca como JSON.
 * Se usa cuando el correo está apagado en el servidor o la tarjeta no se puede cargar.
 * Lleva el comentario de quien lo trajo y, si se puede abrir el correo, «Abrir».
 */
@Composable
internal fun MailSystemText(m: MessageDTO, b: MailSystem.Body, data: BootstrapDTO, onOpen: ((String) -> Unit)? = null) {
    val ctx = LocalContext.current
    val chat = LocalChatColors.current
    val who = Names.person(data, m.authorId)?.name
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("mailSys-${b.key}"), horizontalAlignment = Alignment.CenterHorizontally) {
        val text = mailSystemText(ctx, b)
        val line = if (b.key == "mail.shared" || b.key == "wa.shared") listOfNotNull(who?.takeIf { it.isNotBlank() }, text).joinToString(" · ") else text
        Text(line, style = MaterialTheme.typography.bodySmall, color = chat.system, textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 24.dp).testTag("system"))
        b.comment?.let { c ->
            Text("«$c»", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, maxLines = 6, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 2.dp).testTag("mailSysComment"))
        }
        b.wa?.text?.takeIf { it.isNotBlank() }?.let { t ->
            Text(listOfNotNull(b.wa.author, b.wa.chatName).joinToString(" · ") + ": " + t, style = MaterialTheme.typography.bodySmall, color = chat.system,
                textAlign = TextAlign.Center, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 24.dp))
        }
        val id = b.emailId
        if (onOpen != null && id != null) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { onOpen(id) }, modifier = Modifier.testTag("mailSysOpen")) { Text(stringResource(R.string.web_lin_open)) }
        }
    }
}
