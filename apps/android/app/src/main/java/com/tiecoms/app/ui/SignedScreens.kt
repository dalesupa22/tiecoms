package com.tiecoms.app.ui

import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiecoms.app.R
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.SigningHistoryItemDTO
import com.tiecoms.app.core.Signing
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * «Documentos que firmé» (Tú): trazabilidad de todo lo que firmé con Chaggu. Buscador, lista por día con sello y
 * referencia (la misma impresa en el PDF), detalle con huellas SHA-256 y «Mis firmas guardadas».
 */
@Composable
fun SignedDocsScreen(onBack: () -> Unit, onOpenMessage: (conversationId: String, messageId: String?) -> Unit) {
    val client = LocalClient.current
    val ctx = LocalContext.current
    var q by rememberSaveable { mutableStateOf("") }
    var items by remember { mutableStateOf(listOf<SigningHistoryItemDTO>()) }
    var next by remember { mutableStateOf<String?>(null) }
    var total by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf<SigningHistoryItemDTO?>(null) }
    var viewPdf by remember { mutableStateOf<AttachmentDTO?>(null) }
    var create by remember { mutableStateOf<String?>(null) }
    val sigs by SavedSignatures.list.collectAsState()
    val list = rememberLazyListState()

    LaunchedEffect(Unit) { SavedSignatures.ensure(client) }
    // Búsqueda con una pausa corta; cada cambio reinicia la lista.
    LaunchedEffect(q) {
        if (loaded) delay(300)
        loading = true; error = null
        try {
            val page = client.signings(q = q)
            items = page.signings; next = page.nextBefore; total = page.total
        } catch (e: CancellationException) { throw e
        } catch (e: Exception) { error = errorText(ctx, e) }
        loading = false; loaded = true
    }
    // Paginación: al llegar al final se pide lo anterior a nextBefore.
    val atEnd by remember { derivedStateOf { val li = list.layoutInfo; (li.visibleItemsInfo.lastOrNull()?.index ?: 0) >= li.totalItemsCount - 3 } }
    LaunchedEffect(atEnd, next, loading) {
        val before = next
        if (!atEnd || before == null || loading || !loaded) return@LaunchedEffect
        loading = true
        try {
            val page = client.signings(before = before, q = q)
            items = (items + page.signings).distinctBy { it.id }; next = page.nextBefore
        } catch (e: CancellationException) { throw e
        } catch (e: Exception) { error = errorText(ctx, e); next = null }
        loading = false
    }

    SimpleScaffold(title = stringResource(R.string.signed_title), onBack = onBack) {
        LazyColumn(state = list, modifier = Modifier.fillMaxSize().testTag("signedScreen"), contentPadding = PaddingValues(bottom = 32.dp)) {
            item(key = "search") {
                OutlinedTextField(q, { q = it.take(120) }, singleLine = true, placeholder = { Text(stringResource(R.string.signed_search), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("signedSearch"))
            }
            item(key = "saved") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionHeader(stringResource(R.string.signed_saved_title), Modifier.semantics { heading() })
                    val saved = sigs ?: emptyList()
                    if (sigs != null && saved.isEmpty()) Text(stringResource(R.string.signed_saved_empty), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    SavedSignaturesGrid(saved, onPick = null, newLabel = null, canCreate = saved.size < Signing.MAX_SAVED, onNew = {})
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                        val can = saved.size < Signing.MAX_SAVED
                        OutlinedButton(onClick = { create = "signature" }, enabled = can, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("signedNewSig")) { Text("＋ " + stringResource(R.string.sig_new_signature), maxLines = 1) }
                        OutlinedButton(onClick = { create = "initials" }, enabled = can, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("signedNewIni")) { Text("＋ " + stringResource(R.string.sig_new_initials), maxLines = 1) }
                    }
                    if (!(saved.size < Signing.MAX_SAVED)) Text(stringResource(R.string.sig_too_many, Signing.MAX_SAVED), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                HorizontalDivider(Modifier.padding(top = 8.dp))
            }
            if (loaded && total > 0 && q.isBlank()) item(key = "total") {
                Text(stringResource(R.string.signed_total, total), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            }
            // Agrupado por día.
            items.groupBy { localDate(it.signedAt) }.forEach { (day, rows) ->
                item(key = "day-$day") {
                    Text(day?.let { dayText(ctx, it) } ?: "", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() })
                }
                items(rows, key = { it.id }) { s -> SigningRow(s) { detail = s } }
            }
            item(key = "foot") {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    when {
                        loading -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                        error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                        loaded && items.isEmpty() -> Text(if (q.isBlank()) stringResource(R.string.signed_empty) else stringResource(R.string.signed_none_found, q.trim()),
                            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.testTag("signedEmpty"))
                    }
                }
            }
        }
    }

    detail?.let { s ->
        SigningDetailSheet(s, onDismiss = { detail = null },
            onViewPdf = s.attachment?.let { a -> { detail = null; viewPdf = a } },
            onGoMessage = { detail = null; onOpenMessage(s.conversationId, s.messageId) })
    }
    viewPdf?.let { a -> PdfSheet(a, startSigning = false, onClose = { viewPdf = null }) }
    // Crear desde aquí solo la guarda (queda en «Mis firmas guardadas»).
    create?.let { k -> CreateSignatureDialog(k, onDismiss = { create = null }, onSaved = { create = null }) }
}

/** Sello circular de firma: doble anillo, ✓ y la referencia debajo, un poco inclinado como un sello de tinta. */
@Composable
fun SignSeal(ref: String, size: Dp, modifier: Modifier = Modifier) {
    val ink = if (androidx.compose.foundation.isSystemInDarkTheme()) Brand.Orange else Brand.OrangeText
    val label = stringResource(R.string.signed_seal, ref)
    Box(modifier.size(size).rotate(-10f).semantics { contentDescription = label }.testTag("seal"), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val r = this.size.minDimension / 2
            drawCircle(ink, r - r * 0.05f, style = Stroke(width = r * 0.08f))
            drawCircle(ink, r * 0.78f, style = Stroke(width = r * 0.03f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(r * 0.08f, r * 0.06f))))
            drawCircle(ink.copy(alpha = 0.08f), r * 0.74f, center = Offset(this.size.width / 2, this.size.height / 2))
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.clearAndSetSemantics { }) {
            Text("✓", color = ink, fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.Bold, lineHeight = (size.value * 0.38f).sp)
            Text(ref, color = ink, fontSize = (size.value * 0.13f).sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, maxLines = 1, lineHeight = (size.value * 0.15f).sp)
        }
    }
}

@Composable
private fun SigningRow(s: SigningHistoryItemDTO, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 10.dp)
        .testTag("signedRow-${s.shownRef}"), verticalAlignment = Alignment.CenterVertically) {
        SignSeal(s.shownRef, 56.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(s.shownName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val by = listOfNotNull(s.requestedByName?.let { stringResource(R.string.signed_requested_by, it) }, s.conversationName).joinToString(" · ")
            if (by.isNotEmpty()) Text(by, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(timeText(s.signedAt) + " · " + stringResource(R.string.signed_marks, s.signatureMarks, s.pagesMarked, s.pages),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("›", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SigningDetailSheet(s: SigningHistoryItemDTO, onDismiss: () -> Unit, onViewPdf: (() -> Unit)?, onGoMessage: () -> Unit) {
    val ctx = LocalContext.current
    val full = remember(s.signedAt) {
        parseInstant(s.signedAt)?.atZone(java.time.ZoneId.systemDefault())?.format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.FULL, FormatStyle.MEDIUM)) ?: s.signedAt
    }
    fun copy(v: String) { copyToClipboard(ctx, v); Toast.makeText(ctx, R.string.signed_copied, Toast.LENGTH_SHORT).show() }
    FormSheet(stringResource(R.string.signed_detail_title), onDismiss = onDismiss, tag = "signedDetail") {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SignSeal(s.shownRef, 120.dp)
            Text(s.shownName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
            Text(stringResource(R.string.signed_ref, s.shownRef), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { copy(s.shownRef) }.padding(horizontal = 10.dp, vertical = 6.dp).testTag("signedRef"))
        }
        Info(stringResource(R.string.signed_when), full)
        Info(stringResource(R.string.signed_requested), s.requestedByName ?: stringResource(R.string.signed_requested_me))
        s.conversationName?.let { Info(stringResource(R.string.signed_where), "# $it", onClick = onGoMessage) }
        Info(stringResource(R.string.signed_marks_label), stringResource(R.string.signed_marks_detail, s.marks, s.signatureMarks, s.pagesMarked, s.pages) + "\n" +
            stringResource(R.string.signed_options, stringResource(if (s.stamp) R.string.signed_yes else R.string.signed_no), stringResource(if (s.certificate) R.string.signed_yes else R.string.signed_no)))
        Info(stringResource(R.string.signed_hash_original), s.originalSha256, mono = true, onClick = { copy(s.originalSha256) }, tag = "hashOriginal")
        Info(stringResource(R.string.signed_hash_signed), s.signedSha256, mono = true, onClick = { copy(s.signedSha256) }, tag = "hashSigned")
        Text(stringResource(R.string.signed_copy_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (onViewPdf == null) Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.signed_no_access), modifier = Modifier.padding(12.dp).testTag("signedNoAccess"), style = MaterialTheme.typography.bodyMedium)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = onGoMessage, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("signedGoMessage")) { Text(stringResource(R.string.signed_go_message), maxLines = 1) }
            if (onViewPdf != null) Button(onClick = onViewPdf, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("signedViewPdf")) { Text(stringResource(R.string.signed_view_pdf), maxLines = 1) }
        }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(stringResource(R.string.close)) }
        Spacer(Modifier.navigationBarsPadding())
    }
}

@Composable
private fun Info(label: String, value: String, mono: Boolean = false, onClick: (() -> Unit)? = null, tag: String? = null) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
        .padding(vertical = 6.dp, horizontal = 2.dp).then(if (tag != null) Modifier.testTag(tag) else Modifier)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = if (mono) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyLarge,
            fontFamily = if (mono) FontFamily.Monospace else null, color = if (onClick != null && !mono) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
    }
}
