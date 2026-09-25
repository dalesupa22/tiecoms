package com.tiecoms.app.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.material.icons.filled.Edit
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.core.DriveFileDTO
import com.tiecoms.app.core.DriveFolderDTO
import com.tiecoms.app.core.DriveTreeDTO
import com.tiecoms.app.core.MAX_DRIVE_FILE_BYTES
import com.tiecoms.app.core.Media
import com.tiecoms.app.core.Names
import com.tiecoms.app.platform.ImageTools
import com.tiecoms.app.ui.theme.Brand
import kotlinx.coroutines.launch

// ---------- Perfil ----------
/** Editar perfil: foto (Photo Picker del sistema, recorte 512×512 JPEG), nombre, cargo y área. */
@Composable
fun ProfileScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val data = client.state.collectAsStateWithLifecycle().value.data ?: return
    val me = data.me
    val org = Names.org(data, me.primaryOrgId)
    var name by rememberSaveable { mutableStateOf(me.name) }
    var title by rememberSaveable { mutableStateOf(me.title ?: "") }
    var area by rememberSaveable { mutableStateOf(me.area ?: "") }
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    var photoFlow by rememberSaveable { mutableStateOf(false) }
    var confirmRemove by rememberSaveable { mutableStateOf(false) }
    PhotoFlow(photoFlow, onDismiss = { photoFlow = false }, upload = { client.uploadAvatar(it) }, onSaved = { container.toast(ctx.getString(R.string.photo_saved)) })
    if (confirmRemove) RemovePhotoDialog(onConfirm = {
        busy = "photo"; error = null
        scope.launch { try { client.removeAvatar() } catch (e: Exception) { error = errorText(ctx, e) } finally { busy = null } }
    }, onDismiss = { confirmRemove = false })
    // Guardar solo se habilita si algo cambió (SPEC-v3 §2).
    val changed = name.trim() != me.name || title.trim() != (me.title ?: "") || area.trim() != (me.area ?: "")

    SimpleScaffold(title = stringResource(R.string.profile_title), onBack = onBack) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(20.dp).testTag("profileScreen"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.clickable(enabled = busy == null, onClickLabel = stringResource(R.string.photo_choose)) { photoFlow = true }) {
                    Avatar(me.name, parseColor(org?.colorBg, Brand.Black), parseColor(org?.colorFg, Color.White), size = 88.dp, photo = me.avatarUrl, modifier = Modifier.testTag("profileAvatar"))
                    Box(Modifier.align(Alignment.BottomEnd).size(28.dp).background(MaterialTheme.colorScheme.primary, androidx.compose.foundation.shape.CircleShape), contentAlignment = Alignment.Center) {
                        Icon(androidx.compose.material.icons.Icons.Filled.Edit, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onPrimary)
                    }
                }
                Spacer(Modifier.width(16.dp))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    OutlinedButton(onClick = { photoFlow = true }, enabled = busy == null,
                        modifier = Modifier.testTag("pickPhoto")) {
                        Text(stringResource(if (me.avatarUrl != null) R.string.profile_change_photo else R.string.profile_add_photo))
                    }
                    if (me.avatarUrl != null) TextButton(onClick = { confirmRemove = true }, enabled = busy == null, modifier = Modifier.testTag("removePhoto")) { Text(stringResource(R.string.profile_remove_photo), color = MaterialTheme.colorScheme.error) }
                    Text(stringResource(R.string.profile_photo_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (busy == "photo") LinearProgressIndicator(Modifier.fillMaxWidth())
            OutlinedTextField(name, { name = it.take(120) }, label = { Text(stringResource(R.string.auth_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("profileName"))
            OutlinedTextField(title, { title = it.take(120) }, label = { Text(stringResource(R.string.profile_job_title)) }, placeholder = { Text(stringResource(R.string.profile_job_title_ph)) },
                singleLine = true, modifier = Modifier.fillMaxWidth().testTag("profileTitle"))
            OutlinedTextField(area, { area = it.take(120) }, label = { Text(stringResource(R.string.profile_area)) }, placeholder = { Text(stringResource(R.string.profile_area_ph)) },
                singleLine = true, modifier = Modifier.fillMaxWidth().testTag("profileArea"))
            ErrorText(error)
            Button(
                enabled = busy == null && name.trim().length >= 2 && changed,
                onClick = {
                    busy = "save"; error = null
                    scope.launch {
                        try { client.updateProfile(name, title, area); container.toast(ctx.getString(R.string.profile_saved)) }
                        catch (e: Exception) { error = errorText(ctx, e) } finally { busy = null }
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("profileSave"),
            ) { Text(stringResource(R.string.profile_save), fontWeight = FontWeight.SemiBold) }
        }
    }
}

// ---------- Archivos ----------
/** Ámbito de archivos: «Mis archivos» ([ME]) o el id de un espacio. */
private const val ME = "me"

/**
 * Archivos: «Mis archivos» y una raíz por espacio. Dentro se navega por carpetas, se busca en todo el árbol,
 * se crea carpeta, se sube (hasta 25 MB) y se abre con el enlace firmado. `drive.updated` recarga.
 */
@Composable
fun FilesScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    val client = LocalClient.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val st by client.state.collectAsStateWithLifecycle()
    val data = st.data ?: return
    var area by rememberSaveable { mutableStateOf<String?>(null) }
    var folderId by rememberSaveable { mutableStateOf<String?>(null) }
    var q by rememberSaveable { mutableStateOf("") }
    var tree by remember { mutableStateOf<DriveTreeDTO?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var newFolder by rememberSaveable { mutableStateOf(false) }
    var uploading by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    val wsId = area?.takeIf { it != ME }

    suspend fun reload() {
        val a = area ?: return
        try { tree = client.driveTree(a.takeIf { it != ME }); loadError = null } catch (e: Exception) { loadError = errorText(ctx, e) }
    }
    LaunchedEffect(area, st.driveRevision) { if (area != null) reload() }
    // Si la carpeta abierta se borró, vuelve a la raíz del ámbito.
    LaunchedEffect(tree) { val t = tree; if (t != null && folderId != null && t.folders.none { it.id == folderId }) folderId = null }

    BackHandler(enabled = area != null) {
        when {
            q.isNotEmpty() -> q = ""
            folderId != null -> folderId = tree?.folders?.firstOrNull { it.id == folderId }?.parentId
            else -> { area = null; tree = null }
        }
    }

    val uploader = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty() || area == null) return@rememberLauncherForActivityResult
        val targetWs = wsId; val targetFolder = folderId
        scope.launch {
            val picked = uris.map { ImageTools.describe(ctx, it) }
            val ok = picked.filter { it.size <= MAX_DRIVE_FILE_BYTES }
            if (ok.size < picked.size) container.toast(ctx.getString(R.string.files_too_big))
            var done = 0; var sent = 0
            uploading = 0 to ok.size
            for (f in ok) {
                try {
                    val bytes = ImageTools.readUpTo(ctx, f.uri, MAX_DRIVE_FILE_BYTES)
                    if (bytes == null) container.toast(ctx.getString(R.string.files_too_big))
                    else { client.uploadDriveFile(targetWs, targetFolder, f.name, f.type, bytes); sent++ }
                } catch (e: Exception) { container.toast("${f.name}: ${errorText(ctx, e)}") }
                done++; uploading = done to ok.size
            }
            uploading = null
            if (sent > 0) container.toast(ctx.getString(R.string.files_uploaded, sent))
            reload()
        }
    }

    fun open(f: DriveFileDTO) = scope.launch {
        try { openUrl(ctx, client.driveFileLink(f.id)) } catch (e: Exception) { container.toast(errorText(ctx, e)) }
    }

    val areaName = when (area) { null -> null; ME -> stringResource(R.string.files_mine); else -> data.workspaces.firstOrNull { it.id == area }?.name ?: "" }
    SimpleScaffold(
        title = stringResource(R.string.files_title),
        onBack = { if (area != null) { area = null; folderId = null; tree = null; q = "" } else onBack() },
        actions = {
            if (area != null) {
                IconButton(onClick = { newFolder = true }, modifier = Modifier.testTag("newFolder")) { Text("📁＋") }
                IconButton(onClick = { uploader.launch(arrayOf("*/*")) }, enabled = uploading == null, modifier = Modifier.testTag("uploadFiles")) {
                    Icon(Icons.Filled.Add, stringResource(R.string.files_upload))
                }
            }
        },
    ) {
        if (area == null) {
            // Raíces: «Mis archivos» y las carpetas de cada espacio.
            LazyColumn(Modifier.fillMaxSize().testTag("filesRoots")) {
                item { Text(stringResource(R.string.files_intro), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
                item { RootRow("🗂", stringResource(R.string.files_mine), "root-me") { area = ME; folderId = null } }
                if (data.workspaces.isNotEmpty()) item { SectionHeader(stringResource(R.string.files_tree), Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() }) }
                items(data.workspaces, key = { it.id }) { ws -> RootRow(ws.glyph?.takeIf { it.isNotBlank() } ?: "📁", ws.name, "root-${ws.id}") { area = ws.id; folderId = null } }
            }
            return@SimpleScaffold
        }
        val t = tree
        // Migas: ámbito › carpeta › subcarpeta
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { folderId = null; q = "" }) { Text(areaName ?: "", fontWeight = if (folderId == null) FontWeight.Bold else null, maxLines = 1) }
            t?.pathTo(folderId)?.forEach { f ->
                Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { folderId = f.id; q = "" }) { Text(f.name, fontWeight = if (f.id == folderId) FontWeight.Bold else null, maxLines = 1) }
            }
        }
        OutlinedTextField(q, { q = it }, placeholder = { Text(stringResource(R.string.files_search)) }, singleLine = true, leadingIcon = { Icon(Icons.Filled.Search, null) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("filesSearch"))
        uploading?.let { (d, n) ->
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                Text(stringResource(R.string.files_uploading, d, n), style = MaterialTheme.typography.labelMedium)
                LinearProgressIndicator(progress = { if (n == 0) 0f else d.toFloat() / n }, modifier = Modifier.fillMaxWidth())
            }
        }
        when {
            t == null && loadError != null -> Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(loadError!!); Spacer(Modifier.height(8.dp)); Button(onClick = { scope.launch { reload() } }) { Text(stringResource(R.string.retry)) }
            }
            t == null -> Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) { CircularProgressIndicator() }
            else -> {
                val (folders, files) = if (q.isNotBlank()) t.search(q) else t.foldersIn(folderId) to t.filesIn(folderId)
                LazyColumn(Modifier.fillMaxSize().testTag("filesList")) {
                    if (folders.isEmpty() && files.isEmpty()) item {
                        if (q.isNotBlank()) EmptyNote(stringResource(R.string.files_no_results))
                        else Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.files_empty), fontWeight = FontWeight.SemiBold)
                            Text(stringResource(R.string.files_empty_hint_native), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    items(folders, key = { "f:" + it.id }) { f -> FolderRow(f, t) { folderId = f.id; q = "" } }
                    items(files, key = { "a:" + it.id }) { f -> FileRow(f, data) { open(f) } }
                }
            }
        }
    }

    if (newFolder) {
        var name by rememberSaveable { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { newFolder = false },
            title = { Text(stringResource(R.string.files_new_folder)) },
            text = { OutlinedTextField(name, { name = it.take(120) }, label = { Text(stringResource(R.string.files_folder_name)) }, singleLine = true, modifier = Modifier.testTag("folderName")) },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = {
                    newFolder = false
                    val n = name.trim()
                    scope.launch {
                        try { val f = client.createDriveFolder(wsId, folderId, n); reload(); folderId = f.id }
                        catch (e: Exception) { container.toast(errorText(ctx, e)) }
                    }
                }, modifier = Modifier.testTag("createFolder")) { Text(stringResource(R.string.files_new_folder)) }
            },
            dismissButton = { TextButton(onClick = { newFolder = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun RootRow(glyph: String, name: String, tag: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 10.dp).testTag(tag), verticalAlignment = Alignment.CenterVertically) {
        Text(glyph, style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.width(14.dp))
        Text(name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("›", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    HorizontalDivider(Modifier.padding(start = 52.dp))
}

@Composable
private fun FolderRow(f: DriveFolderDTO, t: DriveTreeDTO, onClick: () -> Unit) {
    val n = t.folders.count { it.parentId == f.id } + t.files.count { it.folderId == f.id }
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp).testTag("folder-${f.id}"), verticalAlignment = Alignment.CenterVertically) {
        Text("📁", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.width(14.dp))
        Text(f.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (n > 0) Text("$n", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 8.dp))
        Text("›", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun FileRow(f: DriveFileDTO, data: com.tiecoms.app.core.BootstrapDTO, onOpen: () -> Unit) {
    val who = f.createdBy?.let { Names.person(data, it)?.name }
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).heightIn(min = 60.dp).padding(horizontal = 16.dp, vertical = 8.dp).testTag("file-${f.id}"), verticalAlignment = Alignment.CenterVertically) {
        Text(Media.fileIcon(f.contentType, f.name), style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(f.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(Media.sizeText(f.size), dateText(f.createdAt).takeIf { f.createdAt.isNotBlank() }, who).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        TextButton(onClick = onOpen) { Text(stringResource(R.string.files_open)) }
    }
}
