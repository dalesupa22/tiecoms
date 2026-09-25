package com.tiecoms.app.ui

import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.tiecoms.app.R
import com.tiecoms.app.core.CropMath
import com.tiecoms.app.platform.ImageTools
import kotlinx.coroutines.launch
import java.io.File

/**
 * Flujo de foto (perfil y grupo, SPEC-v3 §2): elegir (galería, cámara o archivos) → editor de recorte
 * circular (mover y acercar) → vista previa con Cancelar / Guardar → barra de progreso mientras sube.
 * [upload] recibe el JPEG 512×512 y hace la subida; si falla, el error queda en el editor.
 */
@Composable
fun PhotoFlow(open: Boolean, onDismiss: () -> Unit, upload: suspend (ByteArray) -> Unit, onSaved: () -> Unit, group: Boolean = false) {
    val ctx = LocalContext.current
    var picked by remember { mutableStateOf<Uri?>(null) }
    var cameraUri by rememberSaveable { mutableStateOf<String?>(null) }
    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> onDismiss(); picked = uri }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> onDismiss(); picked = uri }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> onDismiss(); if (ok) picked = cameraUri?.let { Uri.parse(it) } }
    if (open) ActionSheet(stringResource(R.string.photo_choose), listOf(
        SheetItem(ctx.getString(R.string.photo_gallery), "🖼", tag = "photoGallery") { gallery.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
        SheetItem(ctx.getString(R.string.photo_camera), "📷", tag = "photoCamera") {
            val dir = File(ctx.cacheDir, "photos").apply { mkdirs() }
            val f = File(dir, "camera-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
            cameraUri = uri.toString(); camera.launch(uri)
        },
        SheetItem(ctx.getString(R.string.photo_files), "📁", tag = "photoFiles") { files.launch(arrayOf("image/png", "image/jpeg", "image/webp", "image/*")) },
    ), onDismiss)
    picked?.let { uri -> CropEditor(uri, onCancel = { picked = null }, upload = upload, onSaved = { picked = null; onSaved() }, group = group) }
}

@Composable
fun CropEditor(uri: Uri, onCancel: () -> Unit, upload: suspend (ByteArray) -> Unit, onSaved: () -> Unit, group: Boolean = false) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var failed by remember { mutableStateOf(false) }
    var zoom by remember { mutableFloatStateOf(1f) }
    var dx by remember { mutableFloatStateOf(0f) }
    var dy by remember { mutableFloatStateOf(0f) }
    var viewport by remember { mutableFloatStateOf(1f) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(uri) { bitmap = ImageTools.loadForCrop(ctx, uri); failed = bitmap == null }
    Dialog(onDismissRequest = { if (!saving) onCancel() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(color = Color(0xFF111010), modifier = Modifier.fillMaxSize().testTag("cropEditor")) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(stringResource(if (group) R.string.photo_crop_group_title else R.string.photo_crop_title), color = Color.White, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
                Text(stringResource(R.string.photo_crop_hint), color = Color(0xFFBDB5AE), style = MaterialTheme.typography.bodySmall)
                val bmp = bitmap
                Box(Modifier.widthIn(max = 480.dp).fillMaxWidth().aspectRatio(1f), contentAlignment = Alignment.Center) {
                    if (failed) Text(stringResource(R.string.photo_invalid), color = Color.White)
                    else if (bmp != null) {
                        val img = remember(bmp) { bmp.asImageBitmap() }
                        Canvas(
                            Modifier.fillMaxSize()
                                .clipToBounds()
                                .pointerInput(bmp) {
                                    detectTransformGestures { _, pan, gz, _ ->
                                        zoom = (zoom * gz).coerceIn(1f, CropMath.MAX_ZOOM)
                                        val (cx, cy) = CropMath.clampOffset(bmp.width, bmp.height, viewport, zoom, dx + pan.x, dy + pan.y)
                                        dx = cx; dy = cy
                                    }
                                }
                                .semantics { contentDescription = ctx.getString(R.string.photo_crop_hint) }
                                .testTag("cropArea"),
                        ) {
                            viewport = size.minDimension
                            val s = CropMath.baseScale(bmp.width, bmp.height, viewport) * zoom
                            val w = bmp.width * s; val h = bmp.height * s
                            drawImage(img, srcOffset = IntOffset.Zero, srcSize = IntSize(bmp.width, bmp.height),
                                dstOffset = IntOffset((size.width / 2 + dx - w / 2).toInt(), (size.height / 2 + dy - h / 2).toInt()), dstSize = IntSize(w.toInt(), h.toInt()))
                            // Oscurece fuera del círculo y marca el borde (lo que quedará en la foto).
                            // (Recorte por diferencia: un BlendMode.Clear en la misma capa borraría también la foto.)
                            val hole = androidx.compose.ui.graphics.Path().apply { addOval(androidx.compose.ui.geometry.Rect(center, viewport / 2)) }
                            clipPath(hole, clipOp = androidx.compose.ui.graphics.ClipOp.Difference) { drawRect(Color.Black.copy(alpha = 0.55f)) }
                            drawCircle(Color.White.copy(alpha = 0.9f), radius = viewport / 2 - 1, center = center, style = Stroke(width = 2.dp.toPx()))
                        }
                    }
                }
                if (saving) {
                    LinearProgressIndicator(Modifier.widthIn(max = 480.dp).fillMaxWidth())
                    Text(stringResource(R.string.photo_saving), color = Color.White, style = MaterialTheme.typography.bodySmall)
                }
                error?.let { Text(it, color = Color(0xFFFF8A80), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("cropError")) }
                Spacer(Modifier.weight(1f))
                Row(Modifier.widthIn(max = 480.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton(onClick = onCancel, enabled = !saving, modifier = Modifier.weight(1f).heightIn(min = 52.dp).testTag("cropCancel")) {
                        Text(stringResource(R.string.cancel), color = Color.White)
                    }
                    Button(
                        onClick = {
                            val b = bmp ?: return@Button
                            saving = true; error = null
                            scope.launch {
                                try {
                                    val sq = CropMath.cropSquare(b.width, b.height, viewport, zoom, dx, dy)
                                    upload(ImageTools.cropJpeg(b, sq.left, sq.top, sq.side))
                                    onSaved()
                                } catch (e: Exception) {
                                    error = if ((e as? com.tiecoms.app.core.ApiException)?.code == "too_large") ctx.getString(R.string.profile_too_big) else errorText(ctx, e)
                                } finally { saving = false }
                            }
                        },
                        enabled = bmp != null && !saving, modifier = Modifier.weight(1f).heightIn(min = 52.dp).testTag("cropSave"),
                    ) { Text(stringResource(R.string.common_save), fontWeight = FontWeight.SemiBold) }
                }
            }
        }
    }
}

/** Confirmación para quitar una foto (perfil o grupo). */
@Composable
fun RemovePhotoDialog(onConfirm: () -> Unit, onDismiss: () -> Unit, group: Boolean = false) {
    AlertDialog(
        onDismissRequest = onDismiss, text = { Text(stringResource(if (group) R.string.group_remove_confirm else R.string.photo_remove_confirm)) },
        confirmButton = { TextButton(onClick = { onDismiss(); onConfirm() }, modifier = Modifier.testTag("confirmRemovePhoto")) { Text(stringResource(R.string.profile_remove_photo), color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

