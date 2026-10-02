package com.tiecoms.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import com.tiecoms.app.R
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.CreativeMedia
import com.tiecoms.app.core.CreativeMediaDTO
import com.tiecoms.app.core.CreativeMediaPage
import com.tiecoms.app.platform.MemeRenderer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** The loader receives authenticated bytes, never provider URLs or tokens in a provider request. */
@Composable
fun AnimatedMediaImage(path: String, label: String?, modifier: Modifier = Modifier, fit: Boolean = false, private: Boolean = false, px: Int = 1024, active: Boolean = true) {
    val client = LocalClient.current
    val images = LocalContainer.current.images
    val context = LocalContext.current
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    var animated by remember(path) { mutableStateOf<android.graphics.drawable.Animatable?>(null) }
    DisposableEffect(lifecycleOwner, animated, active) {
        fun update() { if (active && lifecycleOwner.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) animated?.start() else animated?.stop() }
        val observer = androidx.lifecycle.LifecycleEventObserver { _, _ -> update() }; lifecycleOwner.lifecycle.addObserver(observer); update()
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer); animated?.stop() }
    }
    val url = remember(path, client) { client.mediaUrl(path) }
    // Catalogue assets are public. Conversation content and signed one-view URLs stay uncached.
    val uncached = private || !CreativeMedia.isProxy(path)
    var failed by remember(url) { mutableStateOf(false) }
    val bytes by produceState<ByteArray?>(null, url, uncached) {
        value = url?.let { withContext(Dispatchers.IO) {
            val target = it.toHttpUrlOrNull()
            val origin = client.mediaUrl("/")?.toHttpUrlOrNull()
            val token = if (target != null && origin != null && target.scheme == origin.scheme && target.host == origin.host && target.port == origin.port) client.bearer() else null
            images.loadBytes(it, token, uncached)
        } }
        failed = value == null
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        val data = bytes
        if (data != null) {
            val request = remember(data, px) { ImageRequest.Builder(context).data(data).size(px)
                .memoryCachePolicy(CachePolicy.DISABLED).diskCachePolicy(CachePolicy.DISABLED).build() }
            AsyncImage(request, label, imageLoader = images.animations,
                modifier = Modifier.fillMaxSize(), contentScale = if (fit) ContentScale.Fit else ContentScale.Crop,
                onSuccess = { animated = it.result.drawable as? android.graphics.drawable.Animatable }, onError = { failed = true })
        } else if (!failed) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        if (failed) Text(stringResource(R.string.att_unavailable), style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun Source(item: CreativeMediaDTO) {
    val links = LocalUriHandler.current
    val source = CreativeMedia.attribution(item).ifBlank { item.provider }
    Text(source, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().testTag("creativeSource").then(item.sourceUrl?.takeIf { it.startsWith("https://") }?.let { url -> Modifier.clickable { links.openUri(url) } } ?: Modifier))
}

/** Selection stages a draft attachment; this screen never sends a conversation message. */
@Composable
fun CreativeMediaPicker(onDismiss: () -> Unit, onGif: (CreativeMediaDTO) -> Unit, onMeme: (Attachments.Shared, String) -> Unit) {
    val client = LocalClient.current
    val images = LocalContainer.current.images
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val links = LocalUriHandler.current
    var memes by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var page by remember { mutableStateOf(CreativeMediaPage()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<CreativeMediaDTO?>(null) }
    var top by remember { mutableStateOf("") }
    var bottom by remember { mutableStateOf("") }
    var rendered by remember { mutableStateOf<Attachments.Shared?>(null) }
    var template by remember { mutableStateOf<ByteArray?>(null) }
    var rendering by remember { mutableStateOf(false) }
    var transferred by remember { mutableStateOf<String?>(null) }
    val language = CreativeMedia.language(Locale.getDefault().language)
    LaunchedEffect(memes, if (memes) "" else query) {
        loading = true; error = null
        if (!memes && query.isNotBlank()) delay(300)
        try { page = if (memes) client.memeTemplates() else client.creativeCatalogue(query, language) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { page = CreativeMediaPage(); error = errorText(context, e) }
        finally { loading = false }
    }
    LaunchedEffect(selected, memes) {
        template = null; top = ""; bottom = ""; rendered = null
        selected?.takeIf { memes }?.let { item ->
            if (!CreativeMedia.isProxy(item.url)) { error = context.getString(R.string.att_unavailable); return@LaunchedEffect }
            template = client.mediaUrl(item.url)?.let { url -> withContext(Dispatchers.IO) { images.loadBytes(url, client.bearer()) } }
            if (template == null) error = context.getString(R.string.att_unavailable)
        }
    }
    LaunchedEffect(template, top, bottom) {
        val bytes = template ?: return@LaunchedEffect
        rendering = true
        delay(180)
        try {
            val next = MemeRenderer.render(context.applicationContext, bytes, top, bottom)
            val old = rendered; rendered = next
            old?.let { File(it.path).delete() }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = errorText(context, e) }
        finally { rendering = false }
    }
    DisposableEffect(Unit) { onDispose { rendered?.takeIf { it.path != transferred }?.let { File(it.path).delete() } } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding().imePadding().testTag("creativePicker")) {
            Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.creative_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, stringResource(R.string.close)) }
                }
                if (selected != null) {
                    val item = selected!!
                    TextButton(onClick = { selected = null; rendered?.let { File(it.path).delete() }; rendered = null }) { Text(stringResource(R.string.creative_back)) }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(item.title, style = MaterialTheme.typography.titleMedium)
                        if (memes) {
                            OutlinedTextField(top, { top = it.take(120) }, label = { Text(stringResource(R.string.meme_top)) }, modifier = Modifier.fillMaxWidth().testTag("memeTop"))
                            OutlinedTextField(bottom, { bottom = it.take(120) }, label = { Text(stringResource(R.string.meme_bottom)) }, modifier = Modifier.fillMaxWidth().testTag("memeBottom"))
                            Text(stringResource(R.string.meme_local), style = MaterialTheme.typography.bodySmall)
                            val draft = rendered
                            if (draft != null) AsyncImage(File(draft.path), null, imageLoader = images.animations,
                                contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().height(260.dp).testTag("memePreview"))
                            else CircularProgressIndicator()
                        } else AnimatedMediaImage(item.url, item.title, Modifier.fillMaxWidth().height(260.dp).testTag("gifPreview"), fit = true)
                        Source(item)
                        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    }
                    Button(onClick = {
                        if (memes) rendered?.let { file -> transferred = file.path; onMeme(file, CreativeMedia.attribution(item)); onDismiss() }
                        else { onGif(item); onDismiss() }
                    }, enabled = !memes || (rendered != null && !rendering), modifier = Modifier.fillMaxWidth().testTag("creativeAdd")) { Text(stringResource(R.string.creative_add)) }
                } else {
                    Row {
                        TextButton(onClick = { memes = false; query = "" }, modifier = Modifier.testTag("gifTab")) { Text("GIFs", color = if (!memes) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface) }
                        TextButton(onClick = { memes = true; query = "" }, modifier = Modifier.testTag("memeTab")) { Text(stringResource(R.string.memes), color = if (memes) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface) }
                    }
                    OutlinedTextField(query, { query = it.take(100) }, singleLine = true, label = { Text(stringResource(R.string.creative_search)) }, modifier = Modifier.fillMaxWidth().testTag("creativeSearch"))
                    if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("creativeError")) }
                    val list = if (memes && query.isNotBlank()) page.items.filter { it.title.contains(query, ignoreCase = true) } else page.items
                    if (!loading && list.isEmpty()) Text(stringResource(R.string.creative_empty))
                    LazyVerticalGrid(GridCells.Fixed(2), Modifier.weight(1f).testTag("creativeGrid"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(list.filter { CreativeMedia.isProxy(it.url) && CreativeMedia.isProxy(it.previewUrl) }, key = { it.id }) { item ->
                            Surface(shape = MaterialTheme.shapes.medium, tonalElevation = 2.dp, modifier = Modifier.clickable { selected = item; error = null }.testTag("creative-${item.id}")) {
                                Column(Modifier.padding(6.dp)) {
                                    AnimatedMediaImage(item.previewUrl, item.title, Modifier.fillMaxWidth().height(120.dp))
                                    Text(item.title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium)
                                    Source(item)
                                }
                            }
                        }
                    }
                    if (!memes && page.next != null) TextButton(onClick = {
                        if (!loading) scope.launch {
                            loading = true
                            try { val next = client.creativeCatalogue(query, language, page.next); page = next.copy(items = (page.items + next.items).distinctBy { it.id }) }
                            catch (e: CancellationException) { throw e }
                            catch (e: Exception) { error = errorText(context, e) }
                            finally { loading = false }
                        }
                    }, enabled = !loading, modifier = Modifier.testTag("creativeMore")) { Text(stringResource(R.string.creative_more)) }
                    page.poweredBy?.let { provider -> Text(provider.label, style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.testTag("creativeProvider").then(if (provider.url.startsWith("https://")) Modifier.clickable { links.openUri(provider.url) } else Modifier)) }
                }
            }
        }
    }
}
