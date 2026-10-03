package com.tiecoms.app.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.IssueDTO
import com.tiecoms.app.core.IssueTasks
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.platform.ShareIntake
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/*
 * 1.7.14: archivos en las tareas (POST /issues/:id/attachments + PATCH attachmentIds, como la web) y acciones desde un
 * archivo abierto en la app (visor de fotos y PDF): «Preguntar a gg», «Crear tarea» con el archivo y «Compartir».
 */

/** Subidas en curso por tarea: (archivo actual 1-based, total, fracción). Vive fuera de la pantalla: sigue si se sale. */
object TaskUploads {
    val progress = MutableStateFlow<Map<String, Triple<Int, Int, Float>>>(emptyMap())

    /**
     * Sube [files] a la tarea y los deja adjuntos (los que ya tenía se conservan). Un archivo que falla se avisa y no
     * frena a los demás. Devuelve cuántos quedaron.
     */
    suspend fun attach(ctx: Context, client: TieComsClient, issueId: String, files: List<Attachments.Shared>, onError: (String) -> Unit): Int {
        val ok = mutableListOf<String>()
        try {
            files.forEachIndexed { n, f ->
                progress.value = progress.value + (issueId to Triple(n + 1, files.size, 0f))
                try {
                    if (f.tooLarge) throw com.tiecoms.app.core.ApiException(413, "too_large", ctx.getString(R.string.att_too_large, f.name))
                    val a = client.uploadIssueAttachment(issueId, File(f.path), f.name, f.contentType) { sent, size ->
                        progress.value = progress.value + (issueId to Triple(n + 1, files.size, if (size > 0) sent.toFloat() / size else 0f))
                    }
                    ok += a.id
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    onError(ctx.getString(R.string.tf_failed, f.name, errorText(ctx, e)))
                }
            }
            if (ok.isNotEmpty()) {
                val cur = client.state.value.issues[issueId] ?: client.issueDetail(issueId).issue
                client.setIssueAttachments(issueId, IssueTasks.attachmentIds(cur, ok))
            }
        } finally { progress.value = progress.value - issueId }
        return ok.size
    }

    /** Copia local de un adjunto ya enviado en un mensaje (el servidor no deja reusar el mismo: se sube una copia). */
    suspend fun localCopy(ctx: Context, client: TieComsClient, a: AttachmentDTO): Attachments.Shared = withContext(Dispatchers.IO) {
        val dir = File(ctx.cacheDir, "att/${a.id}").apply { mkdirs() }
        val f = File(dir, ShareIntake.safeName(a.name, a.contentType, 0))
        if (!f.exists() || f.length() == 0L) client.downloadAttachment(a.url, f)
        Attachments.Shared(a.name, a.contentType, f.length(), f.absolutePath)
    }
}

/** «Compartir…» con la hoja del sistema (descarga y comparte el archivo, no el enlace protegido). */
suspend fun shareAttachment(ctx: Context, client: TieComsClient, a: AttachmentDTO) {
    try {
        val f = TaskUploads.localCopy(ctx, client, a)
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", File(f.path))
        val send = Intent(Intent.ACTION_SEND).setType(a.contentType.ifBlank { "application/octet-stream" }).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        withContext(Dispatchers.Main) { ctx.startActivity(Intent.createChooser(send, ctx.getString(R.string.fa_share)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        withContext(Dispatchers.Main) { android.widget.Toast.makeText(ctx, errorText(ctx, e), android.widget.Toast.LENGTH_SHORT).show() }
    }
}

/** De dónde viene el archivo abierto: el chat lo pone para que el visor ofrezca gg, tarea y reenviar. null = solo compartir. */
class FileOrigin(val askGg: ((AttachmentDTO) -> Unit)?, val createTask: ((AttachmentDTO) -> Unit)?, val forward: ((AttachmentDTO) -> Unit)?)

val LocalFileOrigin = staticCompositionLocalOf<FileOrigin?> { null }

/** «⋯» del visor: Preguntar a gg · Crear tarea · Compartir… · Reenviar en chaggu. [onCloseViewer] cierra antes de saltar. */
@Composable
fun FileActionsButton(a: AttachmentDTO?, tint: Color, onCloseViewer: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val origin = LocalFileOrigin.current
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, enabled = a != null, modifier = Modifier.testTag("fileActions")) { Icon(Icons.Filled.MoreVert, stringResource(R.string.fa_menu), tint = tint) }
        if (a != null) AnchoredMenu(open, if (!open) emptyList() else listOfNotNull(
            origin?.askGg?.let { f -> SheetItem(stringResource(R.string.fa_ask_gg), "✨", tag = "faAskGg") { onCloseViewer(); f(a) } },
            origin?.createTask?.let { f -> SheetItem(stringResource(R.string.fa_create_task), "☑", tag = "faCreateTask") { onCloseViewer(); f(a) } },
            SheetItem(stringResource(R.string.fa_share), "⤴", tag = "faShare") { container.scope.launch { shareAttachment(ctx, client, a) } },
            origin?.forward?.let { f -> SheetItem(stringResource(R.string.fa_forward), "↪", tag = "faForward") { onCloseViewer(); f(a) } },
        ), { open = false })
    }
}

/**
 * Sección «Archivos» del detalle de la tarea: miniaturas y documentos (tocar abre el visor o la app que corresponda),
 * «Adjuntar» con fotos, cámara o archivos, barra de progreso y error claro.
 */
@Composable
fun TaskFilesSection(i: IssueDTO, canEdit: Boolean) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val uploads by TaskUploads.progress.collectAsStateWithLifecycle()
    val up = uploads[i.id]
    var picker by remember { mutableStateOf(false) }
    var viewer by remember { mutableStateOf<Pair<List<AttachmentDTO>, Int>?>(null) }
    var pdf by remember { mutableStateOf<AttachmentDTO?>(null) }
    var removing by remember { mutableStateOf<AttachmentDTO?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val files = i.attachments
    val media = files.filter { it.isImage || it.isVideo }
    Column(Modifier.fillMaxWidth().testTag("taskFiles"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (files.isEmpty()) stringResource(R.string.tf_title) else stringResource(R.string.tf_title_n, files.size), style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f).semantics { heading() })
            if (canEdit) OutlinedButton(onClick = { error = null; picker = true }, enabled = up == null, modifier = Modifier.heightIn(min = 40.dp).testTag("taskAttach")) {
                Icon(Icons.Outlined.AttachFile, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.tf_attach))
            }
        }
        if (up != null) Column(Modifier.fillMaxWidth().testTag("taskUploading")) {
            Text(stringResource(R.string.tf_uploading, up.first, up.second), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            LinearProgressIndicator(progress = { ((up.first - 1) + up.third) / up.second }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("taskFilesError")) }
        if (files.isEmpty() && up == null) Text(stringResource(R.string.tf_none), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        files.forEach { a ->
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {
                    when {
                        a.isImage || a.isVideo -> viewer = media to media.indexOf(a).coerceAtLeast(0)
                        Attachments.mime(a.contentType) == "application/pdf" -> pdf = a
                        else -> container.scope.launch { openAttachment(ctx, client, a) }
                    }
                }.testTag("taskFile-${a.id}")) {
                Row(Modifier.padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                        val img = if (a.isImage) rememberAttachmentImage(a, full = false, px = 160) else null
                        if (img != null) Image(img, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        else Icon(Icons.Outlined.Description, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(a.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(Attachments.size(a.sizeBytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (canEdit) IconButton(onClick = { removing = a }, modifier = Modifier.testTag("taskFileRemove-${a.id}")) {
                        Icon(Icons.Filled.Close, stringResource(R.string.tf_remove), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
    AttachPicker(picker, onDismiss = { picker = false }, onPicked = { uris ->
        picker = false
        if (uris.isEmpty()) return@AttachPicker
        container.scope.launch {
            val list = withContext(Dispatchers.IO) { ShareIntake.copyToCache(ctx.applicationContext, uris, null) }
            val n = TaskUploads.attach(ctx, client, i.id, list) { msg -> error = msg }
            if (n > 0) container.toast(ctx.getString(R.string.tf_uploaded))
        }
    })
    removing?.let { a ->
        AlertDialog(onDismissRequest = { removing = null }, text = { Text(stringResource(R.string.tf_remove_q, a.name)) },
            confirmButton = { TextButton(onClick = {
                removing = null
                container.scope.launch {
                    runCatching { client.setIssueAttachments(i.id, IssueTasks.attachmentIds(i, removed = a.id)) }.onFailure { error = errorText(ctx, it) }
                }
            }, modifier = Modifier.testTag("taskFileRemoveOk")) { Text(stringResource(R.string.tf_remove_ok)) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.cancel)) } })
    }
    // El visor de una tarea solo ofrece «Compartir»: no hay mensaje del que salga.
    androidx.compose.runtime.CompositionLocalProvider(LocalFileOrigin provides null) {
        viewer?.let { (list, n) -> MediaViewer(list, n) { viewer = null } }
        pdf?.let { a -> PdfSheet(a, startSigning = false, onClose = { pdf = null }) }
    }
}

