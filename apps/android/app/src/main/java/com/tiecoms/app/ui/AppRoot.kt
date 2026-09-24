package com.tiecoms.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.ui.platform.testTag
import com.tiecoms.app.core.DeepLinks
import com.tiecoms.app.R
import com.tiecoms.app.container
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.launch

val LocalSnackbar = staticCompositionLocalOf { SnackbarHostState() }

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
fun AppRoot() {
    val container = LocalContext.current.container
    val client by container.client.collectAsStateWithLifecycle()
    val state by client.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val splash by container.splashMode.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { container.toasts.collect { snackbar.showSnackbar(it) } }
    CompositionLocalProvider(LocalClient provides client, LocalContainer provides container, LocalSnackbar provides snackbar) {
        // En debug las etiquetas de prueba se exponen como resource-id (UiAutomator del test del splash).
        val rootMod = if (com.tiecoms.app.BuildConfig.DEBUG) Modifier.semantics { testTagsAsResourceId = true } else Modifier
        Surface(Modifier.fillMaxSize().then(rootMod), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.fillMaxSize()) {
                when (state.status) {
                    SessionStatus.LOADING -> Splash()
                    SessionStatus.UNREACHABLE -> Unreachable()
                    SessionStatus.ANONYMOUS -> AuthNav()
                    SessionStatus.READY -> MainNav()
                }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = 72.dp))
                // Splash animado sobre la app: la app carga debajo y aparece cuando el splash se aleja.
                splash?.let { mode ->
                    SplashOverlay(mode, ready = state.status != SessionStatus.LOADING) { container.splashMode.value = null }
                }
            }
        }
    }
}

@Composable
private fun Splash() {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Logo(Modifier.widthIn(max = 220.dp).fillMaxWidth(0.55f))
        Spacer(Modifier.height(24.dp))
        CircularProgressIndicator()
    }
}

@Composable
private fun Unreachable() {
    val client = LocalClient.current
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Logo(Modifier.widthIn(max = 200.dp).fillMaxWidth(0.5f))
        Spacer(Modifier.height(24.dp))
        Text(stringResource(R.string.unreachable), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(8.dp))
        Text(stringResource(R.string.unreachable_desc), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(24.dp))
        Button(onClick = { scope.launch { client.start() } }) { Text(stringResource(R.string.retry)) }
    }
}

@Composable
fun Logo(modifier: Modifier = Modifier) {
    // Wordmark transparente; en modo oscuro, la versión con tinta crema.
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    Box(modifier.padding(4.dp)) {
        Image(painterResource(if (dark) R.drawable.wordmark_light else R.drawable.wordmark), contentDescription = stringResource(R.string.cd_logo), modifier = Modifier.fillMaxWidth())
    }
}

/** Sin sesión: login, registro e invitaciones (vista previa). Guarda el destino pendiente. */
@Composable
private fun AuthNav() {
    val nav = rememberNavController()
    val container = LocalContainer.current
    val pending by container.pendingLink.collectAsStateWithLifecycle()
    LaunchedEffect(pending) {
        when (val p = pending) {
            is DeepLink.Signup -> { container.pendingLink.value = null; nav.navigate("signup?org=${p.orgToken ?: ""}") { launchSingleTop = true } }
            is DeepLink.Invite -> nav.navigate("invite/${p.token}") { launchSingleTop = true }
            else -> Unit // conversación / espacio: se abre después de entrar
        }
    }
    NavHost(nav, startDestination = "login") {
        composable("login") {
            LoginScreen(onSignup = { nav.navigate("signup?org=") { launchSingleTop = true } })
        }
        composable("signup?org={org}", arguments = listOf(navArgument("org") { type = NavType.StringType; defaultValue = "" })) {
            SignupScreen(orgToken = it.arguments?.getString("org")?.ifEmpty { null }, onLogin = { if (!nav.popBackStack("login", false)) nav.navigate("login") })
        }
        composable("invite/{token}") {
            InviteScreen(
                token = it.arguments?.getString("token") ?: "",
                signedIn = false,
                onBack = { container.pendingLink.value = null; nav.popBackStack() },
                onLogin = { nav.navigate("login") { popUpTo("login") { inclusive = true } } },
                onSignup = { nav.navigate("signup?org=") },
                onJoined = { _, _ -> },
            )
        }
    }
}

private val TABS = listOf("home?ws={ws}", "issues", "agenda", "settings")

@Composable
private fun MainNav() {
    val nav = rememberNavController()
    val container = LocalContainer.current
    val client = LocalClient.current
    val ctx = LocalContext.current
    val pending by container.pendingLink.collectAsStateWithLifecycle()
    val state by client.state.collectAsStateWithLifecycle()
    val backStack by nav.currentBackStackEntryAsState()
    val route = backStack?.destination?.route
    val uiScope = rememberCoroutineScope()

    // Permiso de notificaciones (Android 13+), una sola vez.
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && !container.settings.askedNotificationPermission &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            container.settings.askedNotificationPermission = true
            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    fun openConv(id: String, seq: Long? = null) = nav.navigate("conv/$id" + (seq?.let { "?m=$it" } ?: "")) { launchSingleTop = true }
    fun tab(r: String) = nav.navigate(r) { popUpTo(nav.graph.findStartDestination().id) { saveState = true }; launchSingleTop = true; restoreState = true }

    // El aviso se lanza en un scope propio: al consumir el enlace cambia la clave del efecto y lo cancelaría.
    LaunchedEffect(pending, state.data != null) {
        val p = pending ?: return@LaunchedEffect
        val data = state.data ?: return@LaunchedEffect
        container.pendingLink.value = null
        when (p) {
            is DeepLink.Conversation ->
                if (data.conversations.any { it.id == p.id }) { nav.popBackStack(nav.graph.findStartDestination().id, false); openConv(p.id, p.seq) }
                else uiScope.launch { container.toast(ctx.getString(R.string.no_access)) }
            is DeepLink.Workspace ->
                if (data.workspaces.any { it.id == p.id }) nav.navigate("home?ws=${p.id}") { popUpTo(0) { inclusive = true } }
                else uiScope.launch { container.toast(ctx.getString(R.string.err_not_found)) }
            is DeepLink.Invite -> nav.navigate("invite/${p.token}") { launchSingleTop = true }
            is DeepLink.Screen -> when (p.name) {
                DeepLinks.SCREEN_ISSUES -> tab("issues")
                DeepLinks.SCREEN_AGENDA -> tab("agenda")
                DeepLinks.SCREEN_SETTINGS -> tab("settings")
                DeepLinks.SCREEN_TRAZO -> nav.navigate("trazo") { launchSingleTop = true }
                DeepLinks.SCREEN_WHATSAPP -> nav.navigate("whatsapp") { launchSingleTop = true }
            }
            is DeepLink.Share -> { container.shareDraft = p; nav.navigate("share") { launchSingleTop = true } }
            is DeepLink.Signup -> Unit
        }
    }

    Scaffold(
        bottomBar = {
            if (route in TABS) NavigationBar(modifier = Modifier.testTag("tabs")) {
                val items = listOf(
                    Triple("home?ws={ws}", R.string.nav_home, Icons.Filled.Home),
                    Triple("issues", R.string.nav_issues, Icons.Filled.CheckCircle),
                    Triple("agenda", R.string.nav_agenda, Icons.Filled.DateRange),
                    Triple("settings", R.string.nav_settings, Icons.Filled.Settings),
                )
                items.forEach { (r, label, icon) ->
                    NavigationBarItem(
                        selected = route == r, onClick = { tab(if (r.startsWith("home")) "home" else r) },
                        icon = { Icon(icon, null) }, label = { Text(stringResource(label)) },
                        modifier = Modifier.testTag("tab-" + r.substringBefore('?')),
                    )
                }
            }
        },
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { pad ->
        NavHost(nav, startDestination = "home?ws={ws}", modifier = Modifier.padding(pad)) {
            composable("home?ws={ws}", arguments = listOf(navArgument("ws") { type = NavType.StringType; nullable = true; defaultValue = null })) {
                HomeScreen(
                    workspaceFilter = it.arguments?.getString("ws"),
                    onClearFilter = { nav.navigate("home") { popUpTo(0) { inclusive = true } } },
                    onOpen = { id -> openConv(id) },
                    onShortcut = { r -> nav.navigate(r) { launchSingleTop = true } },
                )
            }
            composable("issues") { IssuesScreen(onOpen = { nav.navigate("issue/$it") }) }
            composable("agenda") { AgendaScreen(onOpenEvent = { nav.navigate("event/$it") }) }
            composable("settings") { SettingsScreen(onNavigate = { r -> nav.navigate(r) { launchSingleTop = true } }) }
            composable("conv/{id}?m={m}", arguments = listOf(navArgument("m") { type = NavType.StringType; nullable = true; defaultValue = null })) {
                val id = it.arguments?.getString("id") ?: ""
                ConversationScreen(
                    id = id, jumpSeq = it.arguments?.getString("m")?.toLongOrNull(),
                    onBack = { if (!nav.popBackStack()) tab("home") },
                    onDetails = { nav.navigate("details/$id") { launchSingleTop = true } },
                    onOpenConversation = { cid, seq -> openConv(cid, seq) },
                    onOpenIssue = { nav.navigate("issue/$it") },
                    onOpenEvent = { nav.navigate("event/$it") },
                    onTrazo = { nav.navigate("trazo") { launchSingleTop = true } },
                )
            }
            composable("details/{id}") {
                DetailsScreen(id = it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() },
                    onOpenIssue = { i -> nav.navigate("issue/$i") }, onOpenEvent = { e -> nav.navigate("event/$e") },
                    onOpenConversation = { c -> openConv(c) })
            }
            composable("issue/{id}") {
                IssueDetailScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() }, onOpenOrigin = { c, seq -> openConv(c, seq) })
            }
            composable("event/{id}") {
                EventDetailScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() }, onOpenChat = { c -> openConv(c) })
            }
            composable("reminders") { RemindersScreen(onBack = { nav.popBackStack() }, onOpen = { c, seq -> openConv(c, seq) }) }
            composable("trazo") { TrazoScreen(onBack = { nav.popBackStack() }, onOpen = { c -> openConv(c) }) }
            composable("whatsapp") { WhatsAppScreen(onBack = { nav.popBackStack() }, onOpenConversation = { c -> openConv(c) }) }
            composable("share") {
                val draft = container.shareDraft
                ShareScreen(draft?.text ?: "", draft?.source ?: "other", onBack = { container.shareDraft = null; if (!nav.popBackStack()) tab("home") },
                    onDone = { c -> container.shareDraft = null; nav.popBackStack(); openConv(c) })
            }
            composable("domains/{org}") { DomainsScreen(it.arguments?.getString("org") ?: "", onBack = { nav.popBackStack() }) }
            composable("delete-account") { DeleteAccountScreen(onBack = { nav.popBackStack() }) }
            composable("invite/{token}") {
                InviteScreen(
                    token = it.arguments?.getString("token") ?: "",
                    signedIn = true,
                    onBack = { if (!nav.popBackStack()) tab("home") },
                    onLogin = {}, onSignup = {},
                    onJoined = { ws, conv ->
                        if (conv != null) openConv(conv)
                        else nav.navigate("home?ws=$ws") { popUpTo(0) { inclusive = true } }
                    },
                )
            }
        }
    }
}
