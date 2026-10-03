package com.tiecoms.app.ui

import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.widget.Toast
import androidx.compose.foundation.Image
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.tiecoms.app.R
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.BootstrapDTO
import com.tiecoms.app.core.ConversationDTO
import com.tiecoms.app.core.HomeTree
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.platform.ShareIntake
import com.tiecoms.app.platform.ShareWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * Hoja «Compartir en chaggu» (1.7.15, como otras apps): primero una pantalla de acciones con la vista previa grande
 * (Enviar a un chat · Firmar · Analizar con gg · Crear tarea · Guardar en mis archivos) y, al elegir «Enviar», el
 * selector: buscador arriba, recientes en círculos, lista plana por actividad y abajo los elegidos con Enviar.
 * El envío corre en WorkManager: si se cierra la hoja, sigue en segundo plano.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareSheet(incoming: ShareIntake.Incoming?, onClose: () -> Unit, onOpenApp: () -> Unit, onOpenConversation: (String) -> Unit = { onOpenApp() }) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val state by client.state.collectAsStateWithLifecycle()
    // Copia a caché mientras la actividad conserva el permiso de lectura de los URIs.
    val plan by produceState<Attachments.Plan?>(null, incoming) {
        value = incoming?.let { inc ->
            val files = withContext(Dispatchers.IO) { ShareIntake.copyToCache(ctx.applicationContext, inc.uris, inc.mime) }
                .map { com.tiecoms.app.platform.ImageTools.prepareForUpload(ctx.applicationContext, it) }
            Attachments.plan(files, inc.text)
        } ?: Attachments.plan(emptyList(), "")
    }
    val preselected = incoming?.shortcutId
    var step by rememberSaveable { mutableStateOf(if (preselected != null) "pick" else "actions") }
    var selected by rememberSaveable { mutableStateOf(listOfNotNull(preselected)) }
    var query by rememberSaveable { mutableStateOf("") }
    var message by rememberSaveable { mutableStateOf("") }
    var notice by remember { mutableStateOf<String?>(null) }
    var workId by rememberSaveable { mutableStateOf<String?>(null) }
    val work by remember(workId) {
        workId?.let { WorkManager.getInstance(ctx).getWorkInfoByIdFlow(UUID.fromString(it)) } ?: flowOf(null)
    }.collectAsState(null)
    // «Enviar en un grupo» (1.7.13): mientras se crea el chat grupal, y si el envío fue a ese grupo (para el aviso).
    var creatingGroup by remember { mutableStateOf(false) }
    var sentToGroup by rememberSaveable { mutableStateOf(false) }
    // Acciones (1.7.15): cuál está trabajando, el chat de gg al que se mandó a analizar y el PDF listo para firmar.
    var busyAction by remember { mutableStateOf<String?>(null) }
    var analyzeIn by rememberSaveable { mutableStateOf<String?>(null) }
    var signDoc by remember { mutableStateOf<com.tiecoms.app.core.AttachmentDTO?>(null) }
    var taskSheet by remember { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val sending = creatingGroup || busyAction != null || (work != null && work?.state?.isFinished == false)

    LaunchedEffect(work?.state) {
        val w = work ?: return@LaunchedEffect
        when (w.state) {
            WorkInfo.State.SUCCEEDED -> {
                val gg = analyzeIn
                if (gg != null) { onOpenConversation(gg); return@LaunchedEffect }
                val n = selected.size
                Toast.makeText(ctx, when {
                    sentToGroup -> ctx.getString(R.string.share_sent_group)
                    n == 1 -> ctx.getString(R.string.share_sent_one)
                    else -> ctx.getString(R.string.share_sent, n)
                }, Toast.LENGTH_SHORT).show()
                onClose()
            }
            WorkInfo.State.FAILED, WorkInfo.State.CANCELLED -> {
                notice = w.outputData.getString(ShareWorker.KEY_ERROR) ?: ctx.getString(R.string.share_failed)
                workId = null; sentToGroup = false; analyzeIn = null; busyAction = null
            }
            else -> Unit
        }
    }

    fun act(name: String, block: suspend () -> Unit) {
        if (sending) return
        notice = null; busyAction = name
        scope.launch {
            try { block() } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                notice = errorText(ctx, e)
            } finally { if (name != "analyze" || workId == null) busyAction = null }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (step == "pick") R.string.sh_send else R.string.share_header), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                navigationIcon = {
                    if (step == "pick" && preselected == null) IconButton(onClick = { step = "actions"; notice = null }, enabled = !sending, modifier = Modifier.testTag("shareBack")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back))
                    } else IconButton(onClick = {
                        if (sending) Toast.makeText(ctx, R.string.share_bg, Toast.LENGTH_SHORT).show()
                        onClose()
                    }, modifier = Modifier.testTag("shareClose")) { Icon(Icons.Filled.Close, stringResource(R.string.close)) }
                },
            )
        },
        modifier = Modifier.testTag("shareSheet").then(
            if (com.tiecoms.app.BuildConfig.DEBUG) Modifier.semantics { testTagsAsResourceId = true } else Modifier),
    ) { pad ->
        val data = state.data
        when {
            state.status == SessionStatus.ANONYMOUS -> SignInCard(Modifier.padding(pad), onOpenApp)
            data == null || plan == null -> Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            plan!!.empty && plan!!.tooLarge.isEmpty() -> Box(Modifier.padding(pad).fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.share_nothing), style = MaterialTheme.typography.bodyLarge)
            }
            step == "actions" -> {
                val p = plan!!
                val pdf = p.files.singleOrNull()?.takeIf { Attachments.mime(it.contentType) == "application/pdf" }
                Column(Modifier.padding(pad).fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding().testTag("shareActions"),
                    verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    ShareBigPreview(p)
                    p.tooLarge.forEach { Text(stringResource(R.string.att_too_large, it.name), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    if (work != null) SharePreview(p, work)
                    notice?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("shareNotice")) }
                    Text(stringResource(R.string.sh_what), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 4.dp))
                    ShareActionRow("💬", stringResource(R.string.sh_send), stringResource(R.string.sh_send_sub), "shareActSend", enabled = !sending, busy = false, primary = true) { step = "pick" }
                    if (pdf != null) ShareActionRow("✍", stringResource(R.string.sh_sign), stringResource(R.string.sh_sign_sub), "shareActSign", enabled = !sending, busy = busyAction == "sign") {
                        act("sign") {
                            val cid = client.notesChatId()
                            val a = com.tiecoms.app.platform.AttachmentUpload.upload(ctx.applicationContext, client, cid, java.io.File(pdf.path), pdf.name, pdf.contentType)
                            val cm = client.send(cid, "", attachments = listOf(a)) ?: error(ctx.getString(R.string.share_failed))
                            // El firmador necesita el PDF ya enviado (el servidor firma sobre el mensaje).
                            val ok = withTimeoutOrNull(60_000) {
                                while (true) {
                                    val pend = client.state.value.pending.firstOrNull { it.clientMessageId == cm } ?: return@withTimeoutOrNull true
                                    if (pend.status == "failed") return@withTimeoutOrNull false
                                    delay(150)
                                }
                                @Suppress("UNREACHABLE_CODE") false
                            }
                            if (ok != true) error(ctx.getString(R.string.share_failed))
                            signDoc = a
                        }
                    }
                    ShareActionRow("✨", stringResource(R.string.sh_analyze), stringResource(R.string.sh_analyze_sub), "shareActAnalyze", enabled = !sending, busy = busyAction == "analyze") {
                        act("analyze") {
                            val cid = client.ggChatId()
                            analyzeIn = cid
                            val body = listOf(ctx.getString(R.string.sh_analyze_prompt), p.text).filter { it.isNotBlank() }.joinToString("\n\n")
                            workId = ShareWorker.enqueue(ctx.applicationContext, ShareWorker.Job(listOf(cid), p.files, body, incoming?.source ?: "other")).toString()
                        }
                    }
                    ShareActionRow("☑", stringResource(R.string.sh_task), stringResource(R.string.sh_task_sub), "shareActTask", enabled = !sending, busy = false) { taskSheet = true }
                    if (p.files.isNotEmpty()) ShareActionRow("📁", stringResource(R.string.sh_save), stringResource(R.string.sh_save_sub), "shareActSave", enabled = !sending, busy = busyAction == "save") {
                        act("save") {
                            p.files.forEach { f -> client.uploadDriveFile(null, null, f.name, f.contentType, withContext(Dispatchers.IO) { java.io.File(f.path).readBytes() }) }
                            Toast.makeText(ctx, R.string.sh_saved, Toast.LENGTH_SHORT).show()
                            onClose()
                        }
                    }
                    Spacer(Modifier.size(12.dp))
                }
            }
            else -> Column(Modifier.padding(pad).fillMaxSize().imePadding()) {
                val p = plan!!
                ShareSmallPreview(p)
                if (work != null) SharePreview(p, work)
                // Buscador fijo ARRIBA (antes flotaba abajo y tapaba filas).
                OutlinedTextField(query, { query = it }, singleLine = true, leadingIcon = { Icon(Icons.Filled.Search, null) },
                    placeholder = { Text(stringResource(R.string.sh_search)) }, shape = MaterialTheme.shapes.extraLarge,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).testTag("shareSearch"))
                SharePicker(data, query, selected, enabled = !sending, modifier = Modifier.weight(1f)) { id ->
                    notice = null
                    selected = when {
                        id in selected -> selected - id
                        selected.size >= Attachments.MAX_TARGETS -> { notice = ctx.getString(R.string.share_max_targets); selected }
                        else -> selected + id
                    }
                }
                notice?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp).testTag("shareNotice")) }
                // Abajo, como Instagram: los elegidos, el mensaje y un botón grande de enviar. Con 2+ directos con personas,
                // «Enviar por separado» o «Enviar en un grupo» (POST /chats sin nombre: retoma el que ya exista).
                val groupPeople = remember(selected, data) { com.tiecoms.app.core.ShareGroup.people(selected, data) }
                val canSend = selected.isNotEmpty() && !sending && (p.files.isNotEmpty() || p.text.isNotBlank() || message.isNotBlank())
                fun body() = listOf(message.trim(), p.text).filter { it.isNotBlank() }.joinToString("\n\n")
                fun sendSeparately() {
                    notice = null; sentToGroup = false; analyzeIn = null
                    workId = ShareWorker.enqueue(ctx.applicationContext, ShareWorker.Job(selected, p.files, body(), incoming?.source ?: "other")).toString()
                }
                fun sendInGroup(people: List<String>) {
                    notice = null; creatingGroup = true; analyzeIn = null
                    scope.launch {
                        try {
                            val cid = client.createChat(people, null).id
                            sentToGroup = true
                            workId = ShareWorker.enqueue(ctx.applicationContext, ShareWorker.Job(listOf(cid), p.files, body(), incoming?.source ?: "other")).toString()
                        } catch (e: Exception) {
                            if (e is kotlinx.coroutines.CancellationException) throw e
                            notice = errorText(ctx, e)
                        } finally { creatingGroup = false }
                    }
                }
                Surface(tonalElevation = 3.dp) {
                    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (selected.isEmpty()) Text(stringResource(R.string.sh_pick_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp).testTag("sharePickHint"))
                        else {
                            SelectedStrip(data, selected, enabled = !sending) { id -> selected = selected - id }
                            OutlinedTextField(message, { message = it.take(4000) }, placeholder = { Text(stringResource(R.string.share_add_message)) },
                                maxLines = 3, enabled = !sending, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth().testTag("shareMessage"))
                            if (groupPeople != null) {
                                ShareBigButton(stringResource(R.string.share_send_separately), stringResource(R.string.share_send_separately_sub, selected.size),
                                    enabled = canSend, busy = sending && !creatingGroup && !sentToGroup, primary = true, tag = "shareSend") { sendSeparately() }
                                ShareBigButton(stringResource(R.string.share_send_group), stringResource(R.string.share_send_group_sub, groupPeople.size),
                                    enabled = canSend, busy = creatingGroup || (sending && sentToGroup), primary = false, tag = "shareSendGroup") { sendInGroup(groupPeople) }
                            } else ShareBigButton(
                                if (selected.size > 1) stringResource(R.string.share_send_to, selected.size) else stringResource(R.string.share_send), null,
                                enabled = canSend, busy = sending, primary = true, tag = "shareSend") { sendSeparately() }
                        }
                    }
                }
            }
        }
    }
    // «Crear tarea»: la misma alta rápida de Tareas, con el archivo ya adjunto y eligiendo dónde.
    if (taskSheet) plan?.let { p ->
        val st = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = true)
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { taskSheet = false }, sheetState = st, modifier = Modifier.testTag("shareTaskSheet")) {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.sh_task), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                val title = p.files.firstOrNull()?.name?.substringBeforeLast('.')?.ifBlank { null } ?: p.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
                QuickAddIssue(null, autoFocus = true, initialTitle = title, initialFiles = p.files, onCreated = {
                    Toast.makeText(ctx, R.string.sh_task_created, Toast.LENGTH_SHORT).show()
                    taskSheet = false; onClose()
                })
            }
        }
    }
    // «Firmar»: el firmador de siempre con el PDF que quedó en «Tú».
    signDoc?.let { a -> PdfSheet(a, startSigning = true, onClose = { signDoc = null; onClose() }) }
}

/** Una acción grande de la primera pantalla: ícono, título y explicación corta. */
@Composable
private fun ShareActionRow(icon: String, title: String, sub: String, tag: String, enabled: Boolean, busy: Boolean, primary: Boolean = false, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, shape = RoundedCornerShape(16.dp),
        color = if (primary) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = if (primary) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag(tag)) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(icon, style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(sub, style = MaterialTheme.typography.bodySmall, color = androidx.compose.material3.LocalContentColor.current.copy(alpha = 0.75f))
            }
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = androidx.compose.material3.LocalContentColor.current)
        }
    }
}

/** Vista previa grande: la imagen (o el primer archivo), nombre, tamaño y páginas si es PDF; o el texto compartido. */
@Composable
private fun ShareBigPreview(p: Attachments.Plan) {
    val files = p.files
    if (files.isEmpty()) {
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().padding(top = 4.dp).testTag("shareBigPreview")) {
            Column(Modifier.padding(14.dp)) {
                Text(stringResource(R.string.sh_text), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(p.text, maxLines = 6, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("shareText"))
            }
        }
        return
    }
    val first = files.first()
    Column(Modifier.fillMaxWidth().padding(top = 4.dp).testTag("shareBigPreview"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (files.size == 1 && first.kind != Attachments.Kind.FILE) SharedThumb(first, Modifier.fillMaxWidth().height(220.dp), px = 900)
        else if (files.size > 1) LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { items(files, key = { it.path }) { f -> SharedThumb(f, Modifier.size(96.dp)) } }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (files.size == 1 && first.kind == Attachments.Kind.FILE) {
                Box(Modifier.size(56.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Description, null, Modifier.size(28.dp))
                }
                Spacer(Modifier.width(12.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(if (files.size == 1) first.name else stringResource(R.string.share_items, files.size), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("shareFileName"))
                val pages by produceState<Int?>(null, first.path) {
                    value = if (files.size == 1 && Attachments.mime(first.contentType) == "application/pdf") withContext(Dispatchers.IO) {
                        runCatching { android.os.ParcelFileDescriptor.open(java.io.File(first.path), android.os.ParcelFileDescriptor.MODE_READ_ONLY).use { fd -> android.graphics.pdf.PdfRenderer(fd).use { it.pageCount } } }.getOrNull()
                    } else null
                }
                Text(listOfNotNull(Attachments.size(files.sumOf { it.sizeBytes }),
                    pages?.let { if (it == 1) stringResource(R.string.sh_pages_one) else stringResource(R.string.sh_pages, it) }).joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("shareFileMeta"))
            }
        }
        if (p.text.isNotBlank()) Text(p.text, maxLines = 3, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
    }
}

/** Vista previa pequeña del selector: miniatura, nombre y tamaño en una fila. */
@Composable
private fun ShareSmallPreview(p: Attachments.Plan) {
    val first = p.files.firstOrNull()
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("shareSmallPreview"), verticalAlignment = Alignment.CenterVertically) {
        if (first != null) SharedThumb(first, Modifier.size(44.dp), px = 120, compact = true)
        else Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) { Text("¶") }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(when { first == null -> p.text; p.files.size == 1 -> first.name; else -> stringResource(R.string.share_items, p.files.size) },
                maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            if (first != null) Text(Attachments.size(p.files.sumOf { it.sizeBytes }), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Botón grande de enviar (alto ≥ 52 dp, a todo lo ancho), con una línea de detalle opcional. */
@Composable
private fun ShareBigButton(label: String, sub: String?, enabled: Boolean, busy: Boolean, primary: Boolean, tag: String, onClick: () -> Unit) {
    val content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {
        if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = androidx.compose.material3.LocalContentColor.current)
        else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1)
            if (sub != null) Text(sub, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    val mod = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag(tag)
    if (primary) Button(onClick = onClick, enabled = enabled, shape = RoundedCornerShape(14.dp), modifier = mod, content = content)
    else androidx.compose.material3.FilledTonalButton(onClick = onClick, enabled = enabled, shape = RoundedCornerShape(14.dp), modifier = mod, content = content)
}

@Composable
private fun SignInCard(modifier: Modifier, onOpenApp: () -> Unit) {
    Column(modifier.fillMaxSize().padding(32.dp).testTag("shareSignIn"), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(R.string.share_sign_in), style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.size(16.dp))
        Button(onClick = onOpenApp, modifier = Modifier.heightIn(min = 48.dp).testTag("shareOpenApp")) { Text(stringResource(R.string.share_open_app)) }
    }
}

/** Miniaturas de hasta 10 fotos/videos/archivos (o el texto/enlace), con la barra de cada archivo al enviar. */
@Composable
private fun SharePreview(p: Attachments.Plan, work: WorkInfo?) {
    val prog = work?.progress
    val file = prog?.getInt(ShareWorker.KEY_FILE, -1) ?: -1
    val frac = prog?.getFloat(ShareWorker.KEY_FRACTION, 0f) ?: 0f
    val done = prog?.getInt(ShareWorker.KEY_DONE, 0) ?: 0
    val total = prog?.getInt(ShareWorker.KEY_TOTAL, 0) ?: 0
    if (p.files.isNotEmpty()) {
        Text(if (p.files.size == 1) stringResource(R.string.share_item) else stringResource(R.string.share_items, p.files.size),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 16.dp, top = 4.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp), modifier = Modifier.testTag("sharePreview")) {
            items(p.files.withIndex().toList(), key = { it.value.path }) { (i, f) ->
                Column(Modifier.width(84.dp)) {
                    SharedThumb(f)
                    if (work != null) LinearProgressIndicator(progress = { if (i < file) 1f else if (i == file) frac else 0f },
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp).testTag("shareProgress-$i"))
                }
            }
        }
    }
    if (p.text.isNotBlank()) Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        Text(p.text, maxLines = 4, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp).testTag("shareText"))
    }
    if (work != null && total > 0) Text(stringResource(R.string.share_progress, (done + 1).coerceAtMost(total), total),
        style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 16.dp).testTag("shareProgress"))
}

@Composable
internal fun SharedThumb(f: Attachments.Shared, modifier: Modifier = Modifier.size(84.dp), px: Int = 200, compact: Boolean = false) {
    val img by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, f.path) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                when (f.kind) {
                    Attachments.Kind.IMAGE -> {
                        val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeFile(f.path, b)
                        BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = com.tiecoms.app.core.Media.sampleSize(b.outWidth, b.outHeight, px) })?.asImageBitmap()
                    }
                    Attachments.Kind.VIDEO -> MediaMetadataRetriever().let { r -> try { r.setDataSource(f.path); r.getFrameAtTime(0)?.asImageBitmap() } finally { r.release() } }
                    else -> null
                }
            }.getOrNull()
        }
    }
    Box(modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
        val i = img
        if (i != null) Image(i, f.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        if (f.kind == Attachments.Kind.VIDEO) Icon(Icons.Outlined.PlayCircle, null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(32.dp))
        if (f.kind == Attachments.Kind.FILE && compact) Icon(Icons.Outlined.Description, null)
        else if (f.kind == Attachments.Kind.FILE) Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(6.dp)) {
            Icon(Icons.Outlined.Description, null)
            Text(f.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
            Text(Attachments.size(f.sizeBytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * Selector (1.7.15): «Recientes» en círculos (como Instagram o WhatsApp) y luego todos los chats y grupos en una lista
 * plana por actividad, con la empresa y el espacio como subtítulo gris (sin encabezados por empresa repetidos).
 */
@Composable
private fun SharePicker(data: BootstrapDTO, query: String, selected: List<String>, enabled: Boolean, modifier: Modifier, onToggle: (String) -> Unit) {
    val internal = stringResource(R.string.internal_default); val conv = stringResource(R.string.conversation)
    val rows = remember(data, query) { com.tiecoms.app.core.ShareList.rows(data, query) { c -> Names.conversationTitle(c, data, internal, conv) } }
    val recent = remember(data) { com.tiecoms.app.core.ShareList.rows(data, "") { c -> Names.conversationTitle(c, data, internal, conv) }.take(8) }
    LazyColumn(modifier.fillMaxWidth().testTag("shareTargets")) {
        if (query.isBlank() && recent.isNotEmpty()) {
            item(key = "h:recent") { SectionHeader(stringResource(R.string.sh_recent), Modifier.padding(start = 16.dp, top = 8.dp, bottom = 4.dp)) }
            item(key = "recent") {
                LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.testTag("shareRecentRow")) {
                    items(recent, key = { "r:" + it.c.id }) { r -> RecentBubble(r, data, r.c.id in selected, enabled) { onToggle(r.c.id) } }
                }
            }
            item(key = "h:all") { SectionHeader(stringResource(R.string.sh_all), Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp)) }
        }
        if (rows.isEmpty()) item(key = "empty") {
            Text(stringResource(R.string.sh_no_results, query.trim()), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(24.dp).testTag("shareNoResults"))
        }
        items(rows, key = { "c:" + it.c.id }) { r -> TargetRow(r, data, r.c.id in selected, enabled) { onToggle(r.c.id) } }
    }
}

/** Círculo de un reciente con su nombre debajo; elegido = aro de color y ✓. */
@Composable
private fun RecentBubble(r: com.tiecoms.app.core.ShareList.Row, data: BootstrapDTO, on: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Column(Modifier.width(72.dp).clip(RoundedCornerShape(12.dp)).toggleable(on, enabled = enabled, role = Role.Checkbox) { onToggle() }.padding(vertical = 6.dp)
        .testTag("shareRecent-${r.c.id}"), horizontalAlignment = Alignment.CenterHorizontally) {
        Box {
            Box(Modifier.size(56.dp).clip(androidx.compose.foundation.shape.CircleShape)
                .then(if (on) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, androidx.compose.foundation.shape.CircleShape) else Modifier), contentAlignment = Alignment.Center) {
                ConversationIcon(r.c, data, 56.dp)
            }
            if (on) Box(Modifier.align(Alignment.BottomEnd).size(20.dp).background(MaterialTheme.colorScheme.primary, androidx.compose.foundation.shape.CircleShape)
                .border(2.dp, MaterialTheme.colorScheme.surface, androidx.compose.foundation.shape.CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Check, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onPrimary)
            }
        }
        Text(r.title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.padding(top = 4.dp, start = 2.dp, end = 2.dp))
    }
}

@Composable
private fun TargetRow(r: com.tiecoms.app.core.ShareList.Row, data: BootstrapDTO, on: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(on, enabled = enabled, role = Role.Checkbox) { onToggle() }.heightIn(min = 60.dp)
            .padding(horizontal = 16.dp).testTag("shareTarget-${r.c.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).clip(androidx.compose.foundation.shape.CircleShape)) { ConversationIcon(r.c, data, 40.dp) }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(r.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
            r.subtitle?.let { Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Checkbox(on, null, enabled = enabled)
    }
}

/** Los elegidos, en círculos pequeños con ✕ (tocar quita). */
@Composable
private fun SelectedStrip(data: BootstrapDTO, selected: List<String>, enabled: Boolean, onRemove: (String) -> Unit) {
    val internal = stringResource(R.string.internal_default); val conv = stringResource(R.string.conversation)
    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth().testTag("shareSelected")) {
        items(selected, key = { it }) { id ->
            val c = data.conversations.firstOrNull { it.id == id } ?: return@items
            val name = Names.conversationTitle(c, data, internal, conv)
            val cd = stringResource(R.string.sh_remove, name)
            Column(Modifier.width(56.dp).clickable(enabled = enabled, onClickLabel = cd) { onRemove(id) }.testTag("shareSelected-$id"), horizontalAlignment = Alignment.CenterHorizontally) {
                Box {
                    Box(Modifier.size(40.dp).clip(androidx.compose.foundation.shape.CircleShape)) { ConversationIcon(c, data, 40.dp) }
                    Box(Modifier.align(Alignment.TopEnd).size(16.dp).background(MaterialTheme.colorScheme.onSurfaceVariant, androidx.compose.foundation.shape.CircleShape), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Close, null, Modifier.size(10.dp), tint = MaterialTheme.colorScheme.surface)
                    }
                }
                Text(name.substringBefore(' '), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}
