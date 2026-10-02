package com.tiecoms.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.tiecoms.app.R
import com.tiecoms.app.core.*

/** A separate bounded reader makes the final paragraph reachable regardless of chat item height or IME. */
@Composable
fun LongMessageReader(body: String, mentions: List<MentionDTO>, data: BootstrapDTO, onPerson: (String) -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding().imePadding().testTag("longMessageReader")) {
            Column(Modifier.fillMaxSize().padding(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = onClose, modifier = Modifier.testTag("longReaderClose")) { Text(stringResource(R.string.close)) }
                    TextButton(onClick = { copyToClipboard(ctx, body) }, modifier = Modifier.testTag("longReaderCopy")) { Text(stringResource(R.string.copy_content)) }
                }
                // Old oversized bodies use a literal chunked fallback; the original remains intact for copy.
                val chunks = remember(body) { if (body.length <= LongContent.MAX_BODY) listOf(body) else body.chunked(4096) }
                LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("longReaderScroll"), contentPadding = PaddingValues(bottom = 48.dp)) {
                    itemsIndexed(chunks) { index, text ->
                        if (body.length <= LongContent.MAX_BODY) MessageText(text, mentions, MaterialTheme.colorScheme.onSurface, data, onPerson, Modifier.testTag("longReaderPart-$index"))
                        else Text(text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("longReaderPart-$index"))
                    }
                }
            }
        }
    }
}
