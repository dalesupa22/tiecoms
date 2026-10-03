package com.tiecoms.app.ui

import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.widget.Toast
import androidx.compose.foundation.Image
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
 * Hoja «Compartir en Chaggu» (SPEC-v4 §B, mismo diseño que la extensión de iOS): vista previa de lo compartido,
 * buscador, conversaciones (recientes y luego agrupadas como Inicio), hasta 5 destinos, «Añadir un mensaje…» y Enviar
 * con progreso por archivo. El envío corre en WorkManager: si se cierra la hoja, sigue en segundo plano.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareSheet(incoming: ShareIntake.Incoming?, onClose: () -> Unit, onOpenApp: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val state by client.state.collectAsStateWithLifecycle()
    // Copia a caché mientras la actividad conserva el permiso de lectura de los URIs.
    val plan by produceState<Attachments.Plan?>(null, incoming) {
        value = incoming?.let { inc ->
            val files = withContext(Dispatchers.IO) { ShareIntake.copyToCache(ctx.applicationContext, inc.uris, inc.mime) }
                .map { com.tiecoms.app.platform.ImageTools.prepareForUpload(ctx.applicationContext, it) }
            Attachments.plan(files, inc.text)
        } ?: Attachments.plan(emptyList(), "")
    }
    var selected by rememberSaveable { mutableStateOf(listOfNotNull(incoming?.shortcutId)) }
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
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val sending = creatingGroup || (work != null && work?.state?.isFinished == false)

    LaunchedEffect(work?.state) {
        val w = work ?: return@LaunchedEffect
        when (w.state) {
            WorkInfo.State.SUCCEEDED -> {
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
                workId = null; sentToGroup = false
            }
            else -> Unit
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.share_header), fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() }) },
                navigationIcon = {
                    IconButton(onClick = {
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
            else -> Column(Modifier.padding(pad).fillMaxSize().imePadding()) {
                val p = plan!!
                SharePreview(p, work)
                p.tooLarge.forEach { Text(stringResource(R.string.att_too_large, it.name), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp).testTag("shareTooLarge")) }
                if (p.dropped > 0) Text(stringResource(R.string.share_dropped, p.dropped), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp))
                OutlinedTextField(query, { query = it }, singleLine = true, leadingIcon = { Icon(Icons.Filled.Search, null) },
                    placeholder = { Text(stringResource(R.string.search)) }, shape = MaterialTheme.shapes.extraLarge,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).testTag("shareSearch"))
                Text(stringResource(R.string.share_pick), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
                ShareTargets(data, query, selected, enabled = !sending, modifier = Modifier.weight(1f)) { id ->
                    notice = null
                    selected = when {
                        id in selected -> selected - id
                        selected.size >= Attachments.MAX_TARGETS -> { notice = ctx.getString(R.string.share_max_targets); selected }
                        else -> selected + id
                    }
                }
                notice?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp).testTag("shareNotice")) }
                // Abajo, como Instagram (1.7.13): el mensaje y un botón grande de enviar a todo lo ancho. Con 2+ directos
                // con personas, «Enviar por separado» (un mensaje a cada uno) o «Enviar en un grupo» (un chat grupal con
                // ellas, el mismo POST /chats de «Nuevo chat»: sin nombre, retoma el que ya exista con esa misma gente).
                val groupPeople = remember(selected, data) { com.tiecoms.app.core.ShareGroup.people(selected, data) }
                val canSend = selected.isNotEmpty() && !sending && (p.files.isNotEmpty() || p.text.isNotBlank() || message.isNotBlank())
                fun body() = listOf(message.trim(), p.text).filter { it.isNotBlank() }.joinToString("\n\n")
                fun sendSeparately() {
                    notice = null; sentToGroup = false
                    workId = ShareWorker.enqueue(ctx.applicationContext, ShareWorker.Job(selected, p.files, body(), incoming?.source ?: "other")).toString()
                }
                fun sendInGroup(people: List<String>) {
                    notice = null; creatingGroup = true
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
internal fun SharedThumb(f: Attachments.Shared) {
    val img by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, f.path) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                when (f.kind) {
                    Attachments.Kind.IMAGE -> {
                        val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeFile(f.path, b)
                        BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = com.tiecoms.app.core.Media.sampleSize(b.outWidth, b.outHeight, 200) })?.asImageBitmap()
                    }
                    Attachments.Kind.VIDEO -> MediaMetadataRetriever().let { r -> try { r.setDataSource(f.path); r.getFrameAtTime(0)?.asImageBitmap() } finally { r.release() } }
                    else -> null
                }
            }.getOrNull()
        }
    }
    Box(Modifier.size(84.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
        val i = img
        if (i != null) Image(i, f.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        if (f.kind == Attachments.Kind.VIDEO) Icon(Icons.Outlined.PlayCircle, null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(32.dp))
        if (f.kind == Attachments.Kind.FILE) Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(6.dp)) {
            Icon(Icons.Outlined.Description, null)
            Text(f.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
            Text(Attachments.size(f.sizeBytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Recientes primero y luego la jerarquía de Inicio (empresa → espacio → conversación), con casilla. */
@Composable
private fun ShareTargets(data: BootstrapDTO, query: String, selected: List<String>, enabled: Boolean, modifier: Modifier, onToggle: (String) -> Unit) {
    val ctx = LocalContext.current
    val internal = stringResource(R.string.internal_default); val conv = stringResource(R.string.conversation)
    val title = { c: ConversationDTO -> Names.conversationTitle(c, data, internal, conv) }
    val recent = remember(data, query) {
        if (query.isNotBlank()) emptyList() else data.conversations.filter { !it.isSide && it.canPost }.sortedByDescending { it.lastMessageAt ?: "" }.take(5)
    }
    val rows = remember(data, query) { HomeTree.build(data, query, null, emptySet(), title).filter { it !is HomeTree.Empty && !(it is HomeTree.Section && it.kind == HomeTree.Kind.PINNED) && !(it is HomeTree.Conv && it.pinnedSection) && !(it is HomeTree.Ws && it.key.startsWith("pw:")) } }
    LazyColumn(modifier.fillMaxWidth().testTag("shareTargets")) {
        if (recent.isNotEmpty()) {
            item(key = "h:recent") { SectionHeader(stringResource(R.string.share_recent), Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp)) }
            items(recent, key = { "r:" + it.id }) { c -> TargetRow(c, data, title(c), 0, c.id in selected, enabled, "shareRecent-${c.id}") { onToggle(c.id) } }
        }
        items(rows, key = { it.key }) { row ->
            when (row) {
                is HomeTree.Section -> SectionHeader(stringResource(if (row.kind == HomeTree.Kind.COMPANIES) R.string.side_companies else R.string.side_chats), Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp))
                is HomeTree.Org -> Row(Modifier.padding(start = 16.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OrgMark(row.org, size = 20.dp); Spacer(Modifier.width(8.dp))
                    Text(row.org?.name ?: stringResource(R.string.common_no_company), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
                }
                is HomeTree.Ws -> Text(row.ws.name, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(start = 30.dp, top = 6.dp))
                is HomeTree.Conv -> TargetRow(row.c, data, title(row.c), row.depth + if (row.c.workspaceId != null) 1 else 0, row.c.id in selected, enabled && row.c.canPost, "shareTarget-${row.c.id}") { onToggle(row.c.id) }
                is HomeTree.Empty -> Unit
            }
        }
    }
}

@Composable
private fun TargetRow(c: ConversationDTO, data: BootstrapDTO, title: String, depth: Int, on: Boolean, enabled: Boolean, tag: String, onToggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(on, enabled = enabled, role = Role.Checkbox) { onToggle() }.heightIn(min = 56.dp)
            .padding(start = 12.dp + (depth * 14).dp, end = 12.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConversationIcon(c, data, 36.dp)
        Spacer(Modifier.width(12.dp))
        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Checkbox(on, null, enabled = enabled)
    }
}

