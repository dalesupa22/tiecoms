package com.tiecoms.app.ui

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.tiecoms.app.R
import com.tiecoms.app.core.AttachmentDTO
import kotlinx.coroutines.launch

/** Shared WA copies use destination-owned attachments. No provider or source inbox credentials. */
@Composable
fun CanonicalAttachments(list: List<AttachmentDTO>, status: String? = null) {
    val ctx = LocalContext.current; val client = LocalClient.current; val scope = rememberCoroutineScope()
    var page by remember { mutableStateOf<Int?>(null) }
    val media = list.filter { it.isImage || it.isVideo }
    if (list.isNotEmpty()) AttachmentsBlock(list, MaterialTheme.colorScheme.onSurface, { page = it }, { a -> scope.launch { openAttachment(ctx, client, a) } })
    else if (status != null && status != "ready") Text(stringResource(if (status == "pending") R.string.media_pending else R.string.att_unavailable), style = MaterialTheme.typography.labelSmall)
    page?.let { MediaViewer(media, it) { page = null } }
}
