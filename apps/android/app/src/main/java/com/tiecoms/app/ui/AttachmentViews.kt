package com.tiecoms.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.TieComsClient
import kotlinx.coroutines.launch
import java.io.File

/** Imagen protegida de un adjunto (miniatura si hay; si no, la original), con Bearer y caché. */
@Composable
fun rememberAttachmentImage(a: AttachmentDTO, full: Boolean, px: Int): ImageBitmap? {
    val client = LocalClient.current
    val container = LocalContainer.current
    val path = if (full || a.thumbUrl == null) a.url else a.thumbUrl
    val url = remember(path) { client.mediaUrl(path) }
    val img by produceState(url?.let { container.images.cached(it, px) }, url, px) {
        if (url != null && value == null) value = container.images.load(url, px, client.bearer())
    }
    return img
}

/**
 * Adjuntos dentro de la burbuja: cuadrícula de fotos y videos (1–4 visibles y «+N» en la última) y chips de archivo
 * con ícono, nombre y tamaño. Tocar una foto o video abre el visor; un archivo, «Abrir con…».
 */
@Composable
fun AttachmentsBlock(list: List<AttachmentDTO>, fg: Color, onOpenMedia: (Int) -> Unit, onOpenFile: (AttachmentDTO) -> Unit,
                     mine: Boolean = false, onCreateIssue: ((String) -> Unit)? = {}) {
    if (list.isEmpty()) return
    val media = list.filter { it.isImage || it.isVideo }
    val voices = list.filter { it.isVoice }
    val files = list.filter { !it.isImage && !it.isVideo && !it.isVoice }
    Column(Modifier.padding(bottom = 4.dp).testTag("attachments"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        voices.forEach { VoiceBubble(it, fg, mine, onCreateIssue) }
        if (media.size == 1) {
            val a = media[0]
            val ratio = if ((a.width ?: 0) > 0 && (a.height ?: 0) > 0) (a.width!!.toFloat() / a.height!!).coerceIn(0.6f, 1.8f) else 4f / 3f
            MediaTile(a, Modifier.widthIn(max = 260.dp).fillMaxWidth().aspectRatio(ratio), null) { onOpenMedia(0) }
        } else if (media.size > 1) {
            val shown = media.take(4)
            val extra = media.size - shown.size
            shown.chunked(2).forEachIndexed { r, pair ->
                Row(Modifier.widthIn(max = 260.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    pair.forEachIndexed { c, a ->
                        val i = r * 2 + c
                        MediaTile(a, Modifier.weight(1f).aspectRatio(1f), if (i == shown.lastIndex && extra > 0) extra else null) { onOpenMedia(i) }
                    }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
        files.forEach { FileChip(it, fg) { onOpenFile(it) } }
    }
}

@Composable
private fun MediaTile(a: AttachmentDTO, modifier: Modifier, more: Int?, onClick: () -> Unit) {
    val img = rememberAttachmentImage(a, full = false, px = 480)
    val label = if (a.isVideo) stringResource(R.string.att_video) else stringResource(R.string.att_photo)
    Box(modifier.clip(RoundedCornerShape(12.dp)).background(Color(0x22000000)).clickable(onClick = onClick)
        .semantics { contentDescription = "$label ${a.name}" }.testTag("att-${a.id}"), contentAlignment = Alignment.Center) {
        if (img != null) Image(img, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else if (!a.isVideo) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        if (a.isVideo) Icon(Icons.Outlined.PlayCircle, null, tint = Color.White, modifier = Modifier.size(44.dp))
        if (more != null) Box(Modifier.fillMaxSize().background(Color(0x99000000)), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.att_more, more), color = Color.White, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun FileChip(a: AttachmentDTO, fg: Color, onClick: () -> Unit) {
    Surface(color = fg.copy(alpha = 0.10f), shape = RoundedCornerShape(12.dp),
        modifier = Modifier.widthIn(max = 280.dp).clickable(onClick = onClick).testTag("attFile-${a.id}")) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp).heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Description, null, tint = fg)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f, fill = false)) {
                Text(a.name, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(Attachments.size(a.sizeBytes), color = fg.copy(alpha = 0.75f), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

/** Descarga (con caché) y abre con otra app: visor de PDF, hoja de cálculo, galería… */
suspend fun openAttachment(ctx: Context, client: TieComsClient, a: AttachmentDTO) {
    val dir = File(ctx.cacheDir, "att/${a.id}").apply { mkdirs() }
    val f = File(dir, com.tiecoms.app.platform.ShareIntake.safeName(a.name, a.contentType, 0))
    try {
        if (!f.exists() || f.length() == 0L) {
            Toast.makeText(ctx, R.string.att_downloading, Toast.LENGTH_SHORT).show()
            client.downloadAttachment(a.url, f)
        }
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, a.contentType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ctx.startActivity(Intent.createChooser(view, ctx.getString(R.string.att_open_with)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(ctx, R.string.att_no_app, Toast.LENGTH_SHORT).show()
    } catch (e: ApiException) {
        Toast.makeText(ctx, if (e.status == 403) R.string.att_out_of_history else R.string.att_unavailable, Toast.LENGTH_SHORT).show()
    } catch (e: Exception) {
        Toast.makeText(ctx, errorText(ctx, e), Toast.LENGTH_SHORT).show()
    }
}

/** Visor a pantalla completa: deslizar entre fotos y videos, pellizcar o doble toque para acercar, video con Media3. */
@OptIn(UnstableApi::class)
@androidx.compose.runtime.Composable
fun MediaViewer(media: List<AttachmentDTO>, start: Int, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val pager = rememberPagerState(initialPage = start.coerceIn(0, (media.size - 1).coerceAtLeast(0))) { media.size }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).testTag("mediaViewer")) {
            HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 0) { i ->
                val a = media[i]
                if (a.isVideo) VideoPage(a, active = pager.currentPage == i) else ZoomImage(a)
            }
            Row(Modifier.fillMaxWidth().safeDrawingPadding().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose, modifier = Modifier.testTag("viewerClose")) { Icon(Icons.Filled.Close, stringResource(R.string.close), tint = Color.White) }
                Text(if (media.size > 1) stringResource(R.string.att_count, pager.currentPage + 1, media.size) else media.getOrNull(0)?.name ?: "",
                    color = Color.White, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).testTag("viewerCount"))
                IconButton(onClick = { media.getOrNull(pager.currentPage)?.let { a -> scope.launch { openAttachment(ctx, client, a) } } }) {
                    Icon(Icons.AutoMirrored.Outlined.OpenInNew, stringResource(R.string.att_open_with), tint = Color.White)
                }
            }
        }
    }
}

@Composable
private fun ZoomImage(a: AttachmentDTO) {
    val thumb = rememberAttachmentImage(a, full = false, px = 480)
    val full = rememberAttachmentImage(a, full = true, px = 2048)
    var zoom by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Box(Modifier.fillMaxSize()
        .pointerInput(a.id) { detectTapGestures(onDoubleTap = { if (zoom > 1f) { zoom = 1f; offset = Offset.Zero } else zoom = 2.5f }) }
        .pointerInput(a.id) {
            detectTransformGestures { _, pan, gz, _ ->
                zoom = (zoom * gz).coerceIn(1f, 5f)
                offset = if (zoom == 1f) Offset.Zero else offset + pan
            }
        }, contentAlignment = Alignment.Center) {
        val img = full ?: thumb
        if (img != null) Image(img, a.name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()
            .graphicsLayer { scaleX = zoom; scaleY = zoom; translationX = offset.x; translationY = offset.y }.testTag("viewerImage"))
        else CircularProgressIndicator(color = Color.White)
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun VideoPage(a: AttachmentDTO, active: Boolean) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val url = remember(a.url) { client.mediaUrl(a.url) } ?: return
    // Bearer en la cabecera y Range (206) para que el reproductor pueda buscar sin bajar todo el archivo.
    val token by produceState<String?>(null, a.id) { value = client.bearer() }
    val t = token ?: return Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Color.White) }
    val player = remember(a.id, t) {
        val http = OkHttpDataSource.Factory(container.okHttp).setDefaultRequestProperties(mapOf("authorization" to "Bearer $t"))
        ExoPlayer.Builder(ctx).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build().apply {
            setMediaItem(MediaItem.fromUri(url)); prepare()
        }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    androidx.compose.runtime.LaunchedEffect(active) { player.playWhenReady = active; if (!active) player.pause() }
    AndroidView(factory = { PlayerView(it).apply { this.player = player; useController = true } }, modifier = Modifier.fillMaxSize().testTag("viewerVideo"))
}


/** Clip del compositor: Fotos y videos (selector del sistema, hasta 10), Cámara o Archivos. */
@Composable
fun AttachPicker(open: Boolean, onDismiss: () -> Unit, onPicked: (List<android.net.Uri>) -> Unit) {
    val ctx = LocalContext.current
    var cameraUri by remember { mutableStateOf<android.net.Uri?>(null) }
    val media = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(Attachments.MAX_PER_MESSAGE)) { onPicked(it) }
    val camera = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.TakePicture()) { ok ->
        cameraUri?.takeIf { ok }?.let { onPicked(listOf(it)) }
    }
    val docs = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments()) { onPicked(it.take(Attachments.MAX_PER_MESSAGE)) }
    if (open) ActionSheet(stringResource(R.string.att_attach), listOf(
        SheetItem(ctx.getString(R.string.att_photos_pick), "🖼", tag = "attPhotos") {
            media.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageAndVideo))
        },
        SheetItem(ctx.getString(R.string.att_camera), "📷", tag = "attCamera") {
            val f = File(ctx.cacheDir, "photos/att-" + java.util.UUID.randomUUID().toString().take(8) + ".jpg").apply { parentFile?.mkdirs() }
            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
            cameraUri = uri
            runCatching { camera.launch(uri) }
        },
        SheetItem(ctx.getString(R.string.att_files_pick), "📎", tag = "attFiles") { docs.launch(arrayOf("*/*")) },
    ), onDismiss)
}

/** Vista previa de lo adjuntado, antes de enviar: miniaturas con «Quitar» y la barra de subida de cada archivo. */
@Composable
fun PendingFiles(files: List<Attachments.Shared>, uploading: Pair<Int, Float>?, onRemove: (Attachments.Shared) -> Unit) {
    val removeLabel = stringResource(R.string.att_remove)
    androidx.compose.foundation.lazy.LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 6.dp),
        modifier = Modifier.testTag("pendingFiles"),
    ) {
        items(files.size) { i ->
            val f = files[i]
            Column(Modifier.width(84.dp)) {
                Box {
                    SharedThumb(f)
                    if (uploading == null) Surface(shape = androidx.compose.foundation.shape.CircleShape, color = Color(0xCC000000),
                        modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(26.dp).clickable { onRemove(f) }
                            .semantics { contentDescription = "$removeLabel ${f.name}" }.testTag("attRemove-$i")) {
                        Icon(Icons.Filled.Close, null, tint = Color.White, modifier = Modifier.padding(4.dp))
                    }
                }
                if (uploading != null) androidx.compose.material3.LinearProgressIndicator(
                    progress = { if (i < uploading.first) 1f else if (i == uploading.first) uploading.second else 0f },
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp).testTag("attProgress-$i"))
            }
        }
    }
}
