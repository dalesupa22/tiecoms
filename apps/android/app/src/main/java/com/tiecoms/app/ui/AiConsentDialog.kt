package com.tiecoms.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.tiecoms.app.R

/** Consent applies only to the requested note or summary, never to future content. */
@Composable
fun AiConsentDialog(voice: Boolean, onAllow: () -> Unit, onWithoutAi: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.ai_consent_title)) },
        text = { Text(stringResource(if (voice) R.string.ai_consent_voice else R.string.ai_consent_side)) },
        confirmButton = {
            TextButton(onClick = onAllow, modifier = Modifier.testTag("aiConsentAllow")) { Text(stringResource(R.string.ai_consent_allow)) }
        },
        dismissButton = {
            Column {
                TextButton(onClick = onWithoutAi, modifier = Modifier.testTag("aiConsentDecline")) { Text(stringResource(R.string.ai_consent_without)) }
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
            }
        },
        modifier = Modifier.testTag("aiConsentDialog"),
    )
}
