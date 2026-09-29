package com.tiecoms.app.ui

import android.graphics.Bitmap
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.LocalPinnableContainer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.tiecoms.app.R
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.InkPoint
import com.tiecoms.app.core.MarkKind
import com.tiecoms.app.core.NetworkException
import com.tiecoms.app.core.PageSize
import com.tiecoms.app.core.PxRect
import com.tiecoms.app.core.SignImage
import com.tiecoms.app.core.SignInfoDTO
import com.tiecoms.app.core.SignMark
import com.tiecoms.app.core.SignPdfInput
import com.tiecoms.app.core.SignatureDTO
import com.tiecoms.app.core.Signing
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.platform.PdfPages
import com.tiecoms.app.platform.ShareIntake
import com.tiecoms.app.platform.SignatureArt
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlin.math.hypot
import kotlin.math.roundToInt

/*
 * Ver y firmar un PDF del chat (FIRMAR-NATIVO-SPEC). Ver: páginas a lo ancho, dibujadas con PdfRenderer al
 * acercarse. Firmar: marcas (firma, iniciales, fecha, texto) que se arrastran con el dedo a cualquier parte, también
 * a otra página, y se agrandan con el asa o con pellizco. Sus coordenadas son proporciones de la página tal como se ve,
 * igual que las espera el servidor, que estampa el PDF y responde en el hilo con el firmado.
 */

// ---------- Firmas guardadas (caché del proceso, como savedCache de la web) ----------
object SavedSignatures {
    val list = MutableStateFlow<List<SignatureDTO>?>(null)
    private var owner: String? = null

    suspend fun ensure(client: TieComsClient, force: Boolean = false) {
        if (owner != client.myId) { owner = client.myId; list.value = null }
        if (list.value != null && !force) return
        list.value = try { client.listSignatures() } catch (e: CancellationException) { throw e } catch (_: Exception) { list.value ?: emptyList() }
    }
    fun add(s: SignatureDTO) { list.value = listOf(s) + (list.value ?: emptyList()).filter { it.id != s.id } }
    fun remove(id: String) { list.value = (list.value ?: emptyList()).filter { it.id != id } }
}

/** PNG de una firma guardada (ruta del API con Bearer), con la caché de imágenes de la app. */
@Composable
fun rememberSignatureImage(s: SignatureDTO?): ImageBitmap? {
    val client = LocalClient.current
    val images = LocalContainer.current.images
    val url = remember(s?.url) { s?.url?.let { client.mediaUrl(it) } }
    val img by produceState(url?.let { images.cached(it, 800) }, url) {
        if (url != null && value == null) value = images.load(url, 800, client.bearer())
    }
    return img
}

private fun uid() = UUID.randomUUID().toString()
private val MarksSaver = androidx.compose.runtime.saveable.Saver<List<SignMark>, String>(
    save = { com.tiecoms.app.core.TcJson.encodeToString(kotlinx.serialization.builtins.ListSerializer(SignMark.serializer()), it) },
    restore = { runCatching { com.tiecoms.app.core.TcJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(SignMark.serializer()), it) }.getOrNull() ?: emptyList() },
)
private fun todayText(): String = LocalDate.now().format(DateTimeFormatter.ofPattern(if (isSpanish()) "dd/MM/yyyy" else "MM/dd/yyyy"))
/** Color del texto estampado (rgb(0.06, 0.07, 0.12) en el servidor). */
private val STAMP_INK = Color(0xFF0F1220)
private val MARK_ACCENT = Color(0xFFFF5A36)

private sealed interface SignSheet {
    data class Pick(val kind: String) : SignSheet
    data class Create(val kind: String) : SignSheet
    data class TextEdit(val markId: String?) : SignSheet
    data object Confirm : SignSheet
}

/** Arrastre en curso: la marca se dibuja como «fantasma» bajo el dedo, libre por encima de todas las páginas. */
@Stable
private class MarkDrag(val id: String, val grab: Offset, val wPx: Float, val hPx: Float, start: Offset) {
    var finger by mutableStateOf(start)
}

/** Visor de PDF a pantalla completa; [startSigning] abre directo en modo firma. */
@Composable
fun PdfSheet(a: AttachmentDTO, startSigning: Boolean, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current

    var pages by remember { mutableStateOf<PdfPages?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<SignInfoDTO?>(null) }
    var signing by rememberSaveable { mutableStateOf(startSigning) }
    // Las marcas sobreviven a girar el teléfono (son proporciones: sirven con cualquier ancho).
    var marks by rememberSaveable(stateSaver = MarksSaver) { mutableStateOf(listOf<SignMark>()) }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var sheet by remember { mutableStateOf<SignSheet?>(null) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var drag by remember { mutableStateOf<MarkDrag?>(null) }
    val sigs by SavedSignatures.list.collectAsState()

    // Descargar (o reusar la copia de «Abrir con…») y abrir el PDF; en paralelo, lo que sabe el servidor de él.
    LaunchedEffect(a.id) {
        try {
            val dir = File(ctx.cacheDir, "att/${a.id}").apply { mkdirs() }
            val f = File(dir, ShareIntake.safeName(a.name, a.contentType, 0))
            if (!f.exists() || f.length() == 0L) client.downloadAttachment(a.url, f)
            pages = PdfPages.open(f)
        } catch (e: CancellationException) { throw e
        } catch (_: SecurityException) { loadError = ctx.getString(R.string.sig_encrypted)
        } catch (e: ApiException) { loadError = if (e.status == 403) ctx.getString(R.string.att_out_of_history) else errorText(ctx, e)
        } catch (e: NetworkException) { loadError = errorText(ctx, e)
        } catch (_: Exception) { loadError = ctx.getString(R.string.sig_cant_open) }
    }
    LaunchedEffect(a.id) {
        info = try { client.signInfo(a.id) } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }
    LaunchedEffect(Unit) { SavedSignatures.ensure(client) }
    DisposableEffect(pages) { val p = pages; onDispose { p?.close() } }

    val sizes = pages?.sizes ?: emptyList()
    val encrypted = info?.encrypted == true
    val signed = a.signing ?: info?.signing
    val sel = marks.firstOrNull { it.id == selected }
    val sigCount = Signing.signatureCount(marks)
    fun toast(text: String) = Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show()

    fun requestClose() { if (marks.isNotEmpty()) confirmDiscard = true else onClose() }

    // ----- Hoja de páginas -----
    val listState = rememberLazyListState()
    val pageRects = remember { HashMap<Int, PxRect>() }
    var stageRect by remember { mutableStateOf(PxRect(0f, 0f, 0f, 0f)) }
    val visiblePage by remember {
        derivedStateOf {
            val li = listState.layoutInfo
            val mid = (li.viewportStartOffset + li.viewportEndOffset) / 2
            li.visibleItemsInfo.minByOrNull { if (mid < it.offset) it.offset - mid else if (mid > it.offset + it.size) mid - it.offset - it.size else 0 }?.index?.plus(1) ?: 1
        }
    }
    /** Centro (vertical) de lo que se ve de la página: ahí caen las marcas nuevas. */
    fun viewCenterY(page: Int): Float {
        val li = listState.layoutInfo
        val item = li.visibleItemsInfo.firstOrNull { it.index == page - 1 } ?: return 0.5f
        return Signing.visibleCenter(item.offset, item.size, li.viewportStartOffset, li.viewportEndOffset)
    }
    fun add(m: SignMark) { val placed = Signing.avoidOverlap(marks, Signing.clampMark(m)); marks = marks + placed; selected = placed.id }
    fun placeSignature(s: SignatureDTO) {
        val page = visiblePage.coerceIn(1, sizes.size.coerceAtLeast(1))
        val size = sizes.getOrNull(page - 1) ?: return
        val (w, h) = Signing.signatureBox(s.isInitials, s.width, s.height, size)
        val (x, y) = Signing.centered(0.5f, viewCenterY(page), w, h)
        add(SignMark(uid(), if (s.isInitials) MarkKind.INITIALS else MarkKind.SIGNATURE, page, x, y, w, h, signatureId = s.id))
    }
    fun placeText(kind: MarkKind, text: String, replace: String? = null) {
        val t = text.trim().take(300)
        if (t.isEmpty()) return
        val old = replace?.let { id -> marks.firstOrNull { it.id == id } }
        val page = old?.page ?: visiblePage
        val size = sizes.getOrNull(page - 1) ?: return
        val (w, h) = Signing.textBox(SignatureArt.textWidth1(t), size)
        if (old != null) {
            // Mismo alto que tenía; el ancho según el texto nuevo.
            marks = marks.map { if (it.id == old.id) Signing.clampMark(it.copy(text = t, w = minOf(1 - it.x, w * (it.h / h)))) else it }
            return
        }
        val (x, y) = Signing.centered(0.5f, viewCenterY(page), w, h)
        add(SignMark(uid(), kind, page, x, y, w, h, text = t))
    }
    fun startSig(kind: String) {
        val have = (sigs ?: emptyList()).any { it.kind == kind }
        sheet = if (have) SignSheet.Pick(kind) else SignSheet.Create(kind)
    }
    fun removeMark(id: String) { marks = marks.filter { it.id != id }; if (selected == id) selected = null }

    // Desplazamiento automático mientras se arrastra cerca del borde de arriba o de abajo.
    val edgePx = with(density) { 64.dp.toPx() }
    val stepPx = with(density) { 18.dp.toPx() }
    LaunchedEffect(drag) {
        val d = drag ?: return@LaunchedEffect
        while (isActive) {
            val y = d.finger.y
            val dy = when {
                y > stageRect.bottom - edgePx -> ((y - (stageRect.bottom - edgePx)) / edgePx).coerceIn(0.15f, 1f) * stepPx
                y < stageRect.top + edgePx -> -((stageRect.top + edgePx - y) / edgePx).coerceIn(0.15f, 1f) * stepPx
                else -> 0f
            }
            if (dy != 0f) listState.scrollBy(dy)
            withFrameNanos { }
        }
    }

    val minMarkPx = with(density) { 20.dp.toPx() }
    val curSelected by rememberUpdatedState(selected)
    val curSigning by rememberUpdatedState(signing)

    Dialog(onDismissRequest = { requestClose() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        DialogSystemBars()
        Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize().testTag("pdfSheet")) {
            Column(Modifier.fillMaxSize()) {
                // Barra: cerrar, nombre, «Página i de n», descargar/compartir y «Firmar».
                Row(Modifier.fillMaxWidth().statusBarsPadding().displayCutoutPadding().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { requestClose() }, modifier = Modifier.testTag("pdfClose")) { Icon(Icons.Filled.Close, stringResource(R.string.close)) }
                    Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                        Text(a.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (sizes.isNotEmpty()) stringResource(R.string.sig_page_of, visiblePage, sizes.size) else stringResource(R.string.sig_loading),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("pdfPageOf"))
                    }
                    IconButton(onClick = { scope.launch { openAttachment(ctx, client, a) } }) { Icon(Icons.AutoMirrored.Outlined.OpenInNew, stringResource(R.string.sig_open_with)) }
                    if (!signing) Button(onClick = { signing = true }, enabled = pages != null && !encrypted, modifier = Modifier.padding(end = 4.dp).heightIn(min = 44.dp).testTag("pdfStartSign")) {
                        Text(stringResource(R.string.att_sign_btn))
                    }
                }
                if (signed != null && !signing) Banner(Color(0xFFE3F4E8), Color(0xFF14532D), "✓ " + stringResource(R.string.sig_signed_by, signed.signerName, shortDateTime(signed.signedAt)) + " · " + signed.signedSha256.take(12), "pdfSignedBanner")
                if (signing && info?.hasDigitalSignature == true) Banner(Color(0xFFFFF3D6), Color(0xFF6B4A00), "⚠️ " + stringResource(R.string.sig_has_digital), "pdfDigitalBanner")
                if (encrypted) Banner(Color(0xFFFFF3D6), Color(0xFF6B4A00), stringResource(R.string.sig_encrypted), "pdfEncrypted")
                if (signing && marks.isEmpty() && pages != null) Banner(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant, stringResource(R.string.sig_hint), "pdfHint")

                Box(
                    Modifier.weight(1f).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant)
                        .onGloballyPositioned { c -> val p = c.positionInRoot(); stageRect = PxRect(p.x, p.y, p.x + c.size.width, p.y + c.size.height) }
                        // Fuera de una marca: el dedo hace scroll y, al soltar, suelta la selección. Dos dedos con una
                        // marca elegida: pellizco que la agranda o achica (sin mover la hoja).
                        .pointerInput(Unit) {
                            awaitEachGesture {
                                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                                val onMark = awaitPointerEvent(PointerEventPass.Final).changes.any { it.isConsumed }
                                var pinched = false
                                while (true) {
                                    val e = awaitPointerEvent(PointerEventPass.Initial)
                                    if (e.changes.none { it.pressed }) break
                                    val id = curSelected
                                    if (curSigning && id != null && e.changes.count { it.pressed } >= 2) {
                                        pinched = true
                                        val z = e.calculateZoom()
                                        val m = marks.firstOrNull { it.id == id }
                                        val r = m?.let { pageRects[it.page] }
                                        if (m != null && r != null && z.isFinite() && z != 1f) {
                                            marks = Signing.updateGroup(marks, id) { Signing.scaled(it, z, r.width, r.height, minMarkPx) }
                                        }
                                        e.changes.forEach { it.consume() }
                                    }
                                }
                                if (!onMark && !pinched) selected = null
                            }
                        },
                ) {
                    val p = pages
                    when {
                        loadError != null -> Text(loadError!!, Modifier.align(Alignment.Center).padding(24.dp).testTag("pdfError"), textAlign = TextAlign.Center)
                        p == null -> Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp); Spacer(Modifier.width(10.dp)); Text(stringResource(R.string.sig_loading))
                        }
                        // El contenido del diálogo puede recomponerse antes que PdfSheet: todo lo de páginas sale de p.
                        else -> LazyColumn(
                            state = listState, modifier = Modifier.fillMaxSize().testTag("pdfPages"),
                            contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(p.count, key = { it }) { i ->
                                val pageNo = i + 1
                                val here = marks.filter { it.page == pageNo }
                                PageView(p, i, p.sizes[i], pageRects, pinned = drag?.let { d -> here.any { it.id == d.id } } == true) { wPx, hPx ->
                                    here.forEach { m ->
                                        key(m.id) {
                                            MarkView(
                                                m, wPx, hPx, sig = m.signatureId?.let { sid -> sigs?.firstOrNull { it.id == sid } },
                                                selected = m.id == selected, editable = signing, hidden = drag?.id == m.id, minPx = minMarkPx,
                                                onSelect = { selected = m.id },
                                                onTap = { if (m.kind.isText) sheet = SignSheet.TextEdit(m.id) },
                                                onDragStart = { grab, finger -> drag = MarkDrag(m.id, grab, m.w * wPx, m.h * hPx, finger) },
                                                onDrag = { finger -> drag?.finger = finger },
                                                onDragEnd = { finger ->
                                                    val d = drag
                                                    drag = null
                                                    if (d != null) {
                                                        val target = Signing.pageAt(finger.y, pageRects) ?: m.page
                                                        pageRects[target]?.let { r -> marks = Signing.drop(marks, m.id, target, finger.x - d.grab.x, finger.y - d.grab.y, r, p.sizes) }
                                                    }
                                                },
                                                onDragCancel = { drag = null },
                                                onResize = { r -> marks = Signing.updateGroup(marks, m.id) { it.copy(w = r.w, h = r.h) } },
                                                onRemove = { removeMark(m.id) },
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Fantasma de la marca que se arrastra: libre sobre todas las páginas, pegado al dedo.
                    drag?.let { d ->
                        val m = marks.firstOrNull { it.id == d.id }
                        if (m != null) Box(
                            Modifier.offset { IntOffset((d.finger.x - d.grab.x - stageRect.left).roundToInt(), (d.finger.y - d.grab.y - stageRect.top).roundToInt()) }
                                .size(with(density) { d.wPx.toDp() }, with(density) { d.hPx.toDp() })
                                .shadow(6.dp, RoundedCornerShape(2.dp)).background(Color.White.copy(alpha = 0.55f))
                                .border(1.5.dp, MARK_ACCENT, RoundedCornerShape(2.dp)).testTag("markGhost"),
                        ) { MarkContent(m, d.wPx, d.hPx, m.signatureId?.let { sid -> sigs?.firstOrNull { it.id == sid } }) }
                    }
                }

                if (signing) {
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 4.dp, vertical = 4.dp).heightIn(min = 60.dp).testTag("pdfTools"),
                        verticalAlignment = Alignment.CenterVertically) {
                        if (sel != null) {
                            Tool("🗑", stringResource(R.string.sig_remove), "toolRemove") { removeMark(sel.id) }
                            if (sel.kind.isImage) Tool("⧉", stringResource(R.string.sig_duplicate), "toolDuplicate") {
                                val id = uid(); marks = Signing.duplicate(marks, sel.id, id); selected = id
                            }
                            if (sizes.size > 1) Tool("❏", stringResource(R.string.sig_all_pages), "toolAllPages") {
                                val (next, n) = Signing.toAllPages(marks, sel.id, sizes, ::uid)
                                marks = next; toast(ctx.getString(R.string.sig_copied, n))
                            }
                            if (sel.kind.isText) Tool("✎", stringResource(R.string.sig_edit_text), "toolEdit") { sheet = SignSheet.TextEdit(sel.id) }
                            Tool("✓", stringResource(R.string.sig_done), "toolDone") { selected = null }
                        } else {
                            Tool("✍️", stringResource(R.string.sig_signature), "toolSignature", enabled = pages != null) { startSig("signature") }
                            Tool("AB", stringResource(R.string.sig_initials), "toolInitials", enabled = pages != null) { startSig("initials") }
                            Tool("📅", stringResource(R.string.sig_date), "toolDate", enabled = pages != null) { placeText(MarkKind.DATE, todayText()) }
                            Tool("Aa", stringResource(R.string.sig_text), "toolText", enabled = pages != null) { sheet = SignSheet.TextEdit(null) }
                            Button(onClick = { sheet = SignSheet.Confirm }, enabled = sigCount > 0 && !encrypted,
                                modifier = Modifier.padding(horizontal = 4.dp).heightIn(min = 48.dp).testTag("toolFinish"),
                                contentPadding = PaddingValues(horizontal = 14.dp)) {
                                Text(if (sigCount > 0) stringResource(R.string.sig_finish_n, sigCount) else stringResource(R.string.sig_finish), maxLines = 1)
                            }
                        }
                    }
                } else Spacer(Modifier.navigationBarsPadding())
            }
        }

        when (val s = sheet) {
            is SignSheet.Pick -> PickSignatureSheet(
                s.kind, (sigs ?: emptyList()).filter { it.kind == s.kind }, total = sigs?.size ?: 0,
                onDismiss = { sheet = null }, onPick = { sheet = null; placeSignature(it) }, onNew = { sheet = SignSheet.Create(s.kind) },
            )
            is SignSheet.Create -> CreateSignatureDialog(s.kind, onDismiss = { sheet = null }, onSaved = { sheet = null; placeSignature(it) })
            is SignSheet.TextEdit -> TextMarkDialog(initial = s.markId?.let { id -> marks.firstOrNull { it.id == id }?.text } ?: "",
                onDismiss = { sheet = null }, onDone = { t -> sheet = null; if (s.markId != null) placeText(MarkKind.TEXT, t, s.markId) else placeText(MarkKind.TEXT, t) })
            SignSheet.Confirm -> ConfirmSignSheet(a, info, marks, sizes.size, onDismiss = { sheet = null }, onSigned = {
                sheet = null; marks = emptyList(); container.toast(ctx.getString(R.string.sig_signed_ok)); onClose()
            })
            null -> Unit
        }
        if (confirmDiscard) AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            text = { Text(stringResource(R.string.sig_discard)) },
            confirmButton = { TextButton(onClick = { confirmDiscard = false; marks = emptyList(); onClose() }, modifier = Modifier.testTag("discardOk")) { Text(stringResource(R.string.sig_discard_ok), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/**
 * Los diálogos a pantalla completa dibujan bajo las barras del sistema: los íconos de la barra de estado y de
 * navegación siguen el tema (oscuros sobre fondo claro), como en el resto de la app.
 */
@Composable
private fun DialogSystemBars() {
    val view = androidx.compose.ui.platform.LocalView.current
    val light = MaterialTheme.colorScheme.background.luminance() > 0.5f
    androidx.compose.runtime.SideEffect {
        val w = (view.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window ?: return@SideEffect
        androidx.core.view.WindowCompat.getInsetsController(w, view).apply { isAppearanceLightStatusBars = light; isAppearanceLightNavigationBars = light }
    }
}

@Composable
private fun Banner(bg: Color, fg: Color, text: String, tag: String) {
    Surface(color = bg, modifier = Modifier.fillMaxWidth().testTag(tag)) {
        Text(text, color = fg, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    }
}

@Composable
private fun RowScope.Tool(glyph: String, label: String, tag: String, enabled: Boolean = true, onClick: () -> Unit) {
    Column(
        Modifier.weight(1f).heightIn(min = 56.dp).clip(RoundedCornerShape(10.dp)).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(vertical = 4.dp).testTag(tag),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        val c = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline
        Text(glyph, color = c, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 1)
        Text(label, color = c, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Una página: el bitmap a lo ancho (se dibuja al acercarse) y sus marcas encima. */
@Composable
private fun PageView(pdf: PdfPages, index: Int, size: PageSize, rects: HashMap<Int, PxRect>, pinned: Boolean, marks: @Composable (Float, Float) -> Unit) {
    // Mientras se arrastra una marca de esta página, la página no se descarta aunque salga de la vista
    // (el gesto vive en ella).
    val pinnable = LocalPinnableContainer.current
    DisposableEffect(pinned) {
        val handle = if (pinned) pinnable?.pin() else null
        onDispose { handle?.release() }
    }
    DisposableEffect(index) { onDispose { rects.remove(index + 1) } }
    val label = stringResource(R.string.sig_page_of, index + 1, pdf.count)
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val wPx = constraints.maxWidth.toFloat()
        val hPx = wPx * size.h / size.w
        val density = LocalDensity.current
        var bmp by remember(index, wPx) { mutableStateOf(pdf.cached(index, wPx.roundToInt())) }
        LaunchedEffect(index, wPx) {
            if (bmp == null) { delay(40); bmp = pdf.render(index, wPx.roundToInt()) }
        }
        Box(
            Modifier.fillMaxWidth().height(with(density) { hPx.toDp() }).shadow(1.dp).background(Color.White)
                .onGloballyPositioned { c -> val p = c.positionInRoot(); rects[index + 1] = PxRect(p.x, p.y, p.x + c.size.width, p.y + c.size.height) }
                .semantics { contentDescription = label }.testTag("pdfPage-${index + 1}"),
        ) {
            val b = bmp
            if (b != null) {
                val img = remember(b) { b.asImageBitmap() }
                Image(img, null, Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds)
            } else CircularProgressIndicator(Modifier.align(Alignment.Center).size(24.dp), strokeWidth = 2.dp)
            marks(wPx, hPx)
        }
    }
}

/** Contenido de una marca: la imagen de la firma o el texto con la letra ajustada a la caja. */
@Composable
private fun MarkContent(m: SignMark, wPx: Float, hPx: Float, sig: SignatureDTO?) {
    val density = LocalDensity.current
    if (m.kind.isText) {
        val t = m.text.orEmpty()
        val fontPx = Signing.fontSize(SignatureArt.textWidth1(t), wPx, hPx, minSize = 4f)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterStart) {
            Text(t, color = STAMP_INK, fontFamily = FontFamily.SansSerif, fontSize = with(density) { fontPx.toSp() }, lineHeight = with(density) { (fontPx * 1.1f).toSp() },
                maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
        }
    } else {
        val img = rememberSignatureImage(sig)
        if (img != null) Image(img, null, Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds)
        else Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) }
    }
}

private enum class Zone { MOVE, REMOVE, RESIZE }

/**
 * Una marca sobre su página. El marco tiene un margen de 22 dp alrededor para que la × (arriba a la izquierda) y el
 * asa (abajo a la derecha) sean zonas de toque de 44 dp y para que marcas pequeñas (una fecha) se agarren fácil.
 * El gesto consume el dedo desde que baja: arrastrar la marca nunca hace scroll de la hoja.
 */
@Composable
private fun MarkView(
    m: SignMark, pageW: Float, pageH: Float, sig: SignatureDTO?, selected: Boolean, editable: Boolean, hidden: Boolean, minPx: Float,
    onSelect: () -> Unit, onTap: () -> Unit,
    onDragStart: (grab: Offset, finger: Offset) -> Unit, onDrag: (Offset) -> Unit, onDragEnd: (Offset) -> Unit, onDragCancel: () -> Unit,
    onResize: (SignMark) -> Unit, onRemove: () -> Unit,
) {
    val ctx = LocalContext.current
    val density = LocalDensity.current
    val pad = with(density) { 22.dp.toPx() }
    val slack = with(density) { 10.dp.toPx() }
    val wPx = m.w * pageW; val hPx = m.h * pageH
    val cur by rememberUpdatedState(m)
    val curSelected by rememberUpdatedState(selected)
    val cb by rememberUpdatedState(listOf(onSelect, onTap))
    val dragCb by rememberUpdatedState(Triple(onDragStart, onDrag, onDragEnd))
    val cancelCb by rememberUpdatedState(onDragCancel)
    val resizeCb by rememberUpdatedState(onResize)
    val removeCb by rememberUpdatedState(onRemove)
    val coords = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val desc = if (m.kind.isText) stringResource(R.string.sig_mark_text, m.text.orEmpty(), m.page) else stringResource(R.string.sig_mark_signature, m.page)

    Box(
        Modifier
            .offset { IntOffset((m.x * pageW - pad).roundToInt(), (m.y * pageH - pad).roundToInt()) }
            .size(with(density) { (wPx + pad * 2).toDp() }, with(density) { (hPx + pad * 2).toDp() })
            .onGloballyPositioned { coords[0] = it }
            .semantics { contentDescription = desc; this.selected = selected }
            .testTag("mark-${m.kind.wire}")
            .pointerInput(m.id, editable) {
                if (!editable) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = true)
                    val mk = cur
                    val sel = curSelected
                    val w = mk.w * pageW; val h = mk.h * pageH
                    val p = down.position
                    val zone = when {
                        sel && hypot(p.x - pad, p.y - pad) <= pad -> Zone.REMOVE
                        sel && hypot(p.x - pad - w, p.y - pad - h) <= pad -> Zone.RESIZE
                        p.x >= pad - (if (sel) pad else slack) && p.x <= pad + w + (if (sel) pad else slack) &&
                            p.y >= pad - (if (sel) pad else slack) && p.y <= pad + h + (if (sel) pad else slack) -> Zone.MOVE
                        else -> null
                    } ?: return@awaitEachGesture // fuera de la marca: el dedo es de la hoja (scroll)
                    down.consume()
                    if (!sel) cb[0]()
                    var mode = zone
                    var moved = false
                    fun root(pos: Offset): Offset = coords[0]?.takeIf { it.isAttached }?.localToRoot(pos) ?: pos
                    while (true) {
                        val ev = awaitPointerEvent()
                        val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                        if (ch.isConsumed) { if (moved && mode == Zone.MOVE) cancelCb(); break } // otro gesto (pellizco) lo tomó
                        if (!ch.pressed) {
                            ch.consume()
                            when (mode) {
                                Zone.MOVE -> if (moved) dragCb.third(root(ch.position)) else if (sel) cb[1]()
                                Zone.REMOVE -> if (!moved) removeCb()
                                Zone.RESIZE -> Unit
                            }
                            break
                        }
                        val total = ch.position - down.position
                        if (!moved && total.getDistance() > viewConfiguration.touchSlop) {
                            moved = true
                            // Arrastrar desde la × también mueve la marca (en marcas pequeñas la × tapa una esquina).
                            if (mode == Zone.REMOVE) mode = Zone.MOVE
                            if (mode == Zone.MOVE) dragCb.first(down.position - Offset(pad, pad), root(ch.position))
                        }
                        if (moved) when (mode) {
                            Zone.MOVE -> dragCb.second(root(ch.position))
                            Zone.RESIZE -> resizeCb(Signing.resized(mk, w + total.x, pageW, pageH, minPx))
                            Zone.REMOVE -> Unit
                        }
                        ch.consume()
                    }
                }
            },
    ) {
        Box(
            Modifier.padding(with(density) { pad.toDp() }).fillMaxSize()
                .then(if (hidden) Modifier.background(MARK_ACCENT.copy(alpha = 0.08f)).border(1.dp, MARK_ACCENT.copy(alpha = 0.5f)) else Modifier)
                .then(if (selected && editable && !hidden) Modifier.border(1.5.dp, MARK_ACCENT, RoundedCornerShape(2.dp))
                    else if (editable && !hidden) Modifier.border(1.dp, MARK_ACCENT.copy(alpha = 0.35f)) else Modifier),
        ) { if (!hidden) MarkContent(m, wPx, hPx, sig) }
        if (editable && selected && !hidden) {
            // × arriba a la izquierda (quitar) y asa redonda abajo a la derecha (tamaño); el gesto de arriba las atiende.
            val removeLabel = stringResource(R.string.sig_remove)
            Box(Modifier.align(Alignment.TopStart).padding(with(density) { (pad - with(density) { 13.dp.toPx() }).toDp() }).size(26.dp)
                .background(Brand.Black, CircleShape).border(1.5.dp, Color.White, CircleShape)
                .semantics { contentDescription = removeLabel; role = Role.Button; onClick { removeCb(); true } }.testTag("markRemove"),
                contentAlignment = Alignment.Center) { Icon(Icons.Filled.Close, null, tint = Color.White, modifier = Modifier.size(16.dp)) }
            Box(Modifier.align(Alignment.BottomEnd).padding(with(density) { (pad - with(density) { 12.dp.toPx() }).toDp() }).size(24.dp)
                .background(MARK_ACCENT, CircleShape).border(2.dp, Color.White, CircleShape)
                .semantics { contentDescription = ctx.getString(R.string.sig_resize) }.testTag("markHandle"))
        }
    }
}

// ---------- Elegir una firma guardada ----------
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun PickSignatureSheet(kind: String, list: List<SignatureDTO>, total: Int, onDismiss: () -> Unit, onPick: (SignatureDTO) -> Unit, onNew: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), modifier = Modifier.testTag("pickSignature")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(if (kind == "initials") R.string.sig_my_initials else R.string.sig_my_signatures), style = MaterialTheme.typography.titleLarge)
            SavedSignaturesGrid(list, onPick = onPick, newLabel = stringResource(if (kind == "initials") R.string.sig_new_initials else R.string.sig_new_signature),
                canCreate = total < Signing.MAX_SAVED, onNew = onNew)
            if (total >= Signing.MAX_SAVED) Text(stringResource(R.string.sig_too_many, Signing.MAX_SAVED), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Mosaicos de firmas guardadas con «Borrar» (con confirmación) y el mosaico «＋ Nueva». */
@Composable
fun SavedSignaturesGrid(list: List<SignatureDTO>, onPick: ((SignatureDTO) -> Unit)?, newLabel: String?, canCreate: Boolean, onNew: () -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf<SignatureDTO?>(null) }
    // Mosaicos de a dos por fila (el último «＋ Nueva» ocupa su casilla).
    val tiles: List<SignatureDTO?> = list + (if (newLabel != null) listOf(null) else emptyList())
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        tiles.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { s ->
                    if (s == null) Box(Modifier.weight(1f).aspectRatio(2.4f).clip(RoundedCornerShape(12.dp))
                        .border(BorderStroke(1.dp, MaterialTheme.colorScheme.outline), RoundedCornerShape(12.dp))
                        .clickable(enabled = canCreate, role = Role.Button, onClick = onNew).testTag("newSig"), contentAlignment = Alignment.Center) {
                        Text("＋ ${newLabel.orEmpty()}", color = if (canCreate) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                            fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 8.dp))
                    } else {
                        val img = rememberSignatureImage(s)
                        Box(Modifier.weight(1f).aspectRatio(2.4f).clip(RoundedCornerShape(12.dp)).background(Color.White)
                            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))
                            .then(if (onPick != null) Modifier.clickable(role = Role.Button, onClickLabel = ctx.getString(R.string.sig_use)) { onPick(s) } else Modifier)
                            .testTag("savedSig-${s.id}")) {
                            if (img != null) Image(img, stringResource(R.string.sig_use), Modifier.fillMaxSize().padding(start = 10.dp, end = 44.dp, top = 8.dp, bottom = 8.dp), contentScale = ContentScale.Fit)
                            else CircularProgressIndicator(Modifier.align(Alignment.Center).size(18.dp), strokeWidth = 2.dp)
                            IconButton(onClick = { confirm = s }, modifier = Modifier.align(Alignment.TopEnd).testTag("deleteSig-${s.id}")) {
                                Text("🗑", modifier = Modifier.semantics { contentDescription = ctx.getString(R.string.sig_delete) })
                            }
                        }
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
    confirm?.let { s ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            text = { Text(stringResource(R.string.sig_delete_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    scope.launch {
                        try { client.deleteSignature(s.id); SavedSignatures.remove(s.id) }
                        catch (e: CancellationException) { throw e } catch (e: Exception) { Toast.makeText(ctx, errorText(ctx, e), Toast.LENGTH_SHORT).show() }
                    }
                }, modifier = Modifier.testTag("deleteSigOk")) { Text(stringResource(R.string.sig_delete_ok), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

// ---------- Crear una firma ----------
private const val TAB_DRAWN = "drawn"
private const val TAB_TYPED = "typed"
private const val TAB_UPLOADED = "uploaded"

/** Pantalla completa para crear una firma: Dibujar · Escribir · Foto, tinta azul o negra, «Guardar y usar». */
@Composable
fun CreateSignatureDialog(kind: String, onDismiss: () -> Unit, onSaved: (SignatureDTO) -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val me = client.state.collectAsState().value.data?.me
    val initials = kind == "initials"
    var tab by rememberSaveable { mutableStateOf(TAB_DRAWN) }
    var ink by rememberSaveable { mutableStateOf(Signing.INK_BLUE) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Dibujar
    val strokes = remember { mutableStateListOf<List<InkPoint>>() }
    var padSize by remember { mutableStateOf(0 to 0) }
    // Escribir
    var typed by rememberSaveable { mutableStateOf(if (initials) Signing.initialsOf(me?.name.orEmpty()) else me?.name.orEmpty()) }
    var font by rememberSaveable { mutableStateOf(0) }
    // Foto
    var photo by remember { mutableStateOf<SignatureArt.Photo?>(null) }
    var threshold by remember { mutableStateOf<Int?>(null) }
    var keepColor by remember { mutableStateOf(false) }
    var photoInk by remember { mutableStateOf<Bitmap?>(null) }

    val empty = when (tab) {
        TAB_DRAWN -> strokes.isEmpty()
        TAB_TYPED -> typed.isBlank()
        else -> photoInk == null
    }

    fun save() = scope.launch {
        busy = true; error = null
        try {
            val bmp = when (tab) {
                TAB_DRAWN -> SignatureArt.drawnBitmap(strokes.toList(), padSize.first, padSize.second, ink, density.density)
                TAB_TYPED -> SignatureArt.typedBitmap(ctx, typed, font, ink)
                else -> photoInk
            }
            val png = bmp?.let { SignatureArt.trimmedPng(it, if (initials) 600 else 1200, 600) }
            if (png == null) { error = ctx.getString(R.string.sig_empty); return@launch }
            val s = client.createSignature(png.bytes, kind, tab)
            SavedSignatures.add(s)
            onSaved(s)
        } catch (e: CancellationException) { throw e
        } catch (e: Exception) { error = errorText(ctx, e)
        } finally { busy = false }
    }

    Dialog(onDismissRequest = { if (!busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        DialogSystemBars()
        Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize().testTag("createSignature")) {
            Column(Modifier.fillMaxSize().systemBarsPadding().displayCutoutPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onDismiss, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.cancel)) }
                    Text(stringResource(if (initials) R.string.sig_new_initials else R.string.sig_new_signature), style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Button(onClick = { save() }, enabled = !busy && !empty, modifier = Modifier.padding(end = 4.dp).heightIn(min = 44.dp).testTag("saveSignature")) {
                        Text(stringResource(if (busy) R.string.sig_saving else R.string.sig_save_use))
                    }
                }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp).widthIn(max = 640.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Segmented(listOf(TAB_DRAWN to stringResource(R.string.sig_tab_drawn), TAB_TYPED to stringResource(R.string.sig_tab_typed), TAB_UPLOADED to stringResource(R.string.sig_tab_uploaded)),
                        tab, { tab = it; error = null }, Modifier.testTag("sigTabs"))
                    when (tab) {
                        TAB_DRAWN -> DrawPad(initials, strokes, ink, onSize = { padSize = it })
                        TAB_TYPED -> TypePad(typed, { typed = it.take(60) }, font, { font = it }, ink)
                        else -> PhotoPad(photo, threshold, keepColor, ink, photoInk,
                            onPhoto = { photo = it; threshold = it?.let { p -> SignImage.photoThreshold(p.auto) }; photoInk = null; if (it == null) error = ctx.getString(R.string.sig_photo_error) },
                            onThreshold = { threshold = it }, onKeepColor = { keepColor = it }, onInk = { photoInk = it })
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.sig_ink), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        listOf(Signing.INK_BLUE to R.string.sig_ink_blue, Signing.INK_BLACK to R.string.sig_ink_black).forEach { (c, label) ->
                            val name = stringResource(label)
                            Box(Modifier.size(48.dp).clip(CircleShape).clickable(role = Role.RadioButton) { ink = c }
                                .semantics { contentDescription = name; selected = ink == c }.testTag("ink-$c"), contentAlignment = Alignment.Center) {
                                Box(Modifier.size(30.dp).background(Color(c), CircleShape)
                                    .then(if (ink == c) Modifier.border(3.dp, MaterialTheme.colorScheme.primary, CircleShape) else Modifier))
                            }
                        }
                    }
                    Text(stringResource(R.string.sig_privacy), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("sigError")) }
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

/** Lienzo para firmar con el dedo: 5:2 (iniciales 2:1), línea guía y «Firma aquí». */
@Composable
private fun DrawPad(initials: Boolean, strokes: MutableList<List<InkPoint>>, ink: Int, onSize: (Pair<Int, Int>) -> Unit) {
    val density = LocalDensity.current
    val current = remember { mutableStateListOf<InkPoint>() }
    val guide = MaterialTheme.colorScheme.outline
    val paint = remember { SignatureArt.strokePaint() }
    val hint = stringResource(R.string.sig_draw_here)
    Box(Modifier.fillMaxWidth().aspectRatio(if (initials) 2f else 2.5f).clip(RoundedCornerShape(12.dp)).background(Color.White)
        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))) {
        Canvas(
            Modifier.fillMaxSize().onSizeChanged { onSize(it.width to it.height) }
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        down.consume()
                        current.clear()
                        current.add(InkPoint(down.position.x, down.position.y, down.uptimeMillis))
                        while (true) {
                            val e = awaitPointerEvent()
                            val c = e.changes.firstOrNull { it.id == down.id } ?: break
                            c.historical.forEach { h -> current.add(InkPoint(h.position.x, h.position.y, h.uptimeMillis)) }
                            current.add(InkPoint(c.position.x, c.position.y, c.uptimeMillis))
                            c.consume()
                            if (!c.pressed) break
                        }
                        strokes.add(current.toList()); current.clear()
                    }
                }
                .semantics { contentDescription = hint }.testTag("sigPad"),
        ) {
            val y = size.height * 0.72f
            drawLine(guide, Offset(size.width * 0.08f, y), Offset(size.width * 0.92f, y), strokeWidth = density.density)
            drawIntoCanvas { c ->
                val all = if (current.isEmpty()) strokes.toList() else strokes.toList() + listOf(current.toList())
                SignatureArt.drawStrokes(c.nativeCanvas, all, ink, density.density, paint)
            }
        }
        if (strokes.isEmpty() && current.isEmpty()) Text(hint, color = Color(0xFF9A948E), style = MaterialTheme.typography.titleMedium, modifier = Modifier.align(Alignment.Center))
        TextButton(onClick = { strokes.clear(); current.clear() }, modifier = Modifier.align(Alignment.TopEnd).heightIn(min = 44.dp).testTag("sigClear")) {
            Text(stringResource(R.string.sig_clear), color = Color(0xFF5E5852))
        }
    }
}

/** Escribir el nombre (o las iniciales) y elegir una de las 3 letras cursivas. */
@Composable
private fun TypePad(text: String, onText: (String) -> Unit, font: Int, onFont: (Int) -> Unit, ink: Int) {
    val ctx = LocalContext.current
    OutlinedTextField(text, onText, singleLine = true, placeholder = { Text(stringResource(R.string.sig_type_ph)) },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), modifier = Modifier.fillMaxWidth().testTag("sigTyped"))
    val families = remember { SignatureArt.FONTS.indices.map { FontFamily(SignatureArt.typeface(ctx, it)) } }
    families.forEachIndexed { i, fam ->
        val on = font == i
        Surface(
            color = Color.White, shape = RoundedCornerShape(12.dp),
            border = BorderStroke(if (on) 2.dp else 1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
            modifier = Modifier.fillMaxWidth().heightIn(min = 68.dp).clip(RoundedCornerShape(12.dp)).clickable(role = Role.RadioButton) { onFont(i) }
                .semantics { this.selected = on }.testTag("sigFont-$i"),
        ) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), contentAlignment = Alignment.CenterStart) {
                Text(text.trim().ifEmpty { stringResource(R.string.sig_type_ph) }, fontFamily = fam, fontSize = 34.sp, color = Color(ink), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** Foto de una firma en papel: cámara o galería, fondo fuera (Otsu), control «Limpiar el fondo» y «Conservar el color». */
@Composable
private fun PhotoPad(
    photo: SignatureArt.Photo?, threshold: Int?, keepColor: Boolean, ink: Int, preview: Bitmap?,
    onPhoto: (SignatureArt.Photo?) -> Unit, onThreshold: (Int) -> Unit, onKeepColor: (Boolean) -> Unit, onInk: (Bitmap?) -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var cameraUri by rememberSaveable { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    fun load(uri: Uri?) { if (uri == null) return; scope.launch { loading = true; onPhoto(SignatureArt.loadPhoto(ctx, uri)); loading = false } }
    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { load(it) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) load(cameraUri?.let(Uri::parse)) }
    val cameraGate = rememberCameraGate()
    // Se recalcula al mover el control o cambiar la tinta (con una pausa corta para no hacerlo en cada cuadro).
    LaunchedEffect(photo, threshold, keepColor, ink) {
        val p = photo ?: return@LaunchedEffect
        delay(40)
        onInk(SignatureArt.inkPhoto(p, threshold ?: SignImage.photoThreshold(p.auto), if (keepColor) null else ink))
    }
    Box(Modifier.fillMaxWidth().heightIn(min = 150.dp).clip(RoundedCornerShape(12.dp)).background(Color.White)
        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp)).padding(8.dp).testTag("sigPhoto"), contentAlignment = Alignment.Center) {
        when {
            loading -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            preview != null -> { val img = remember(preview) { preview.asImageBitmap() }; Image(img, null, Modifier.fillMaxWidth().heightIn(max = 220.dp), contentScale = ContentScale.Fit) }
            else -> Text(stringResource(R.string.sig_photo_hint), color = Color(0xFF5E5852), textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium)
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { cameraGate {
            val f = File(ctx.cacheDir, "photos/sig-${System.currentTimeMillis()}.jpg").apply { parentFile?.mkdirs() }
            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
            cameraUri = uri.toString()
            runCatching { camera.launch(uri) }.onFailure { Toast.makeText(ctx, R.string.att_camera_unavailable, Toast.LENGTH_SHORT).show() }
        } }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("sigCamera")) { Text("📷 " + stringResource(R.string.sig_take_photo), maxLines = 1) }
        OutlinedButton(onClick = { gallery.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("sigGallery")) { Text("🖼 " + stringResource(R.string.sig_pick_image), maxLines = 1) }
    }
    if (photo != null) {
        CheckRow(keepColor, onKeepColor, stringResource(R.string.sig_keep_color), null, "sigKeepColor")
        val range = SignImage.sliderRange(photo.auto)
        Column {
            Text(stringResource(R.string.sig_clean_bg), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Slider(value = (threshold ?: SignImage.photoThreshold(photo.auto)).toFloat(), onValueChange = { onThreshold(it.roundToInt()) },
                valueRange = range.first.toFloat()..range.last.toFloat(), modifier = Modifier.testTag("sigThreshold"))
        }
    }
}

@Composable
private fun CheckRow(checked: Boolean, onChange: (Boolean) -> Unit, title: String, help: String?, tag: String, bg: Color = Color.Transparent) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(bg).clickable(role = Role.Checkbox) { onChange(!checked) }
        .heightIn(min = 48.dp).padding(vertical = 4.dp, horizontal = 4.dp).semantics(mergeDescendants = true) {}.testTag(tag), verticalAlignment = Alignment.Top) {
        Checkbox(checked = checked, onCheckedChange = null, modifier = Modifier.padding(top = 2.dp, end = 10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = if (help != null) FontWeight.SemiBold else FontWeight.Normal)
            help?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

// ---------- Texto libre ----------
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TextMarkDialog(initial: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    val me = LocalClient.current.state.collectAsState().value.data?.me
    var text by remember { mutableStateOf(initial) }
    val quick = listOfNotNull(me?.name, me?.title, todayText()).filter { it.isNotBlank() }.distinct()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sig_text_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(text, { text = it.take(300) }, singleLine = true, placeholder = { Text(stringResource(R.string.sig_text_ph)) },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { if (text.isNotBlank()) onDone(text.trim()) }),
                    modifier = Modifier.fillMaxWidth().testTag("markText"))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    quick.forEach { q -> SuggestionChip(onClick = { text = q }, label = { Text(q, maxLines = 1) }, modifier = Modifier.heightIn(min = 44.dp)) }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onDone(text.trim()) }, enabled = text.isNotBlank(), modifier = Modifier.testTag("markTextOk")) { Text(stringResource(R.string.sig_done)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

// ---------- Confirmar y enviar ----------
@Composable
private fun ConfirmSignSheet(a: AttachmentDTO, info: SignInfoDTO?, marks: List<SignMark>, pages: Int, onDismiss: () -> Unit, onSigned: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    var body by remember { mutableStateOf("") }
    var stamp by remember { mutableStateOf(true) }
    var certificate by remember { mutableStateOf(false) }
    var accept by remember { mutableStateOf(false) }
    var needsAccept by remember { mutableStateOf(info?.hasDigitalSignature == true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    /** Un clientMessageId fijo por intento: reintentar no firma dos veces. */
    val clientMessageId = remember { uid() }
    // Un doble toque en «Firmar» no debe firmar sin leer: el botón se activa un instante después.
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { delay(600); armed = true }

    fun go() = scope.launch {
        busy = true; error = null
        try {
            client.signPdf(a.id, SignPdfInput(
                clientMessageId = clientMessageId, body = body.trim(), placements = Signing.placements(marks).take(Signing.MAX_PLACEMENTS),
                stamp = stamp, certificate = certificate, acceptBreakingSignatures = accept, timeZone = ZoneId.systemDefault().id,
            ))
            onSigned()
        } catch (e: CancellationException) { throw e
        } catch (e: ApiException) {
            if (e.code == "has_digital_signature") { needsAccept = true; error = ctx.getString(R.string.sig_has_digital) }
            else if (e.code == "encrypted_pdf") error = ctx.getString(R.string.sig_encrypted)
            else error = errorText(ctx, e)
        } catch (e: Exception) { error = errorText(ctx, e)
        } finally { busy = false }
    }

    FormSheet(stringResource(R.string.sig_confirm_title), onDismiss = { if (!busy) onDismiss() }, tag = "confirmSign") {
        Text(stringResource(R.string.sig_summary, a.name, Signing.signatureCount(marks), Signing.pagesUsed(marks), pages), style = MaterialTheme.typography.bodyLarge)
        OutlinedTextField(body, { body = it.take(2000) }, minLines = 2, placeholder = { Text(stringResource(R.string.sig_body_ph)) }, modifier = Modifier.fillMaxWidth().testTag("signBody"))
        CheckRow(stamp, { stamp = it }, stringResource(R.string.sig_stamp), stringResource(R.string.sig_stamp_help), "signStamp")
        CheckRow(certificate, { certificate = it }, stringResource(R.string.sig_certificate), stringResource(R.string.sig_certificate_help), "signCertificate")
        if (needsAccept) CheckRow(accept, { accept = it }, stringResource(R.string.sig_accept_break), null, "signAccept", bg = Color(0xFFFFF3D6))
        Text(stringResource(R.string.sig_legal), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("signError")) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onDismiss, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.sig_back)) }
            Spacer(Modifier.width(8.dp))
            Button(onClick = { go() }, enabled = armed && !busy && (!needsAccept || accept),
                colors = ButtonDefaults.buttonColors(), modifier = Modifier.heightIn(min = 48.dp).testTag("signSend")) {
                Text(stringResource(if (busy) R.string.sig_signing else R.string.sig_sign_send))
            }
        }
    }
}

// ---------- Ficha de PDF en la burbuja ----------
/** Ficha de un PDF: tocar abre el visor; «✍️ Firmar» abre directo en modo firma; «✓ Firmado por …» si ya lo está. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun PdfChip(a: AttachmentDTO, fg: Color, onLongPress: (() -> Unit)?, onOpen: (Boolean) -> Unit) {
    Surface(color = fg.copy(alpha = 0.10f), shape = RoundedCornerShape(12.dp),
        modifier = Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(12.dp)).testTag("attPdf-${a.id}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f, fill = false).combinedClickable(onClick = { onOpen(false) }, onLongClick = onLongPress)
                .padding(start = 10.dp, top = 8.dp, bottom = 8.dp, end = 6.dp).heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("📄", fontSize = 20.sp)
                Spacer(Modifier.width(8.dp))
                Column {
                    Text(a.name, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    val size = com.tiecoms.app.core.Attachments.size(a.sizeBytes)
                    Text(a.signing?.let { stringResource(R.string.att_signed_by, it.signerName) + " · " + size } ?: size,
                        color = fg.copy(alpha = 0.8f), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = if (a.signing != null) Modifier.testTag("attSignedBy-${a.id}") else Modifier)
                }
            }
            Surface(color = fg.copy(alpha = 0.16f), shape = RoundedCornerShape(10.dp),
                modifier = Modifier.padding(end = 6.dp).heightIn(min = 44.dp).clip(RoundedCornerShape(10.dp))
                    .clickable(role = Role.Button) { onOpen(true) }.testTag("attSign-${a.id}")) {
                Box(Modifier.heightIn(min = 44.dp).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text(stringResource(R.string.att_sign_btn), color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
            }
        }
    }
}
