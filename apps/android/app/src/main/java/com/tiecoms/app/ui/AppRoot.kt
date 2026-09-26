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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Groups
import androidx.compose.foundation.border
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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
        Surface(Modifier.fillMaxSize().then(rootMod).dismissKeyboardOnOutsideInteraction(), color = MaterialTheme.colorScheme.background) {
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
    // Logo completo con transparencia real (huecos incluidos): letras tinta en claro (drawable-nodpi)
    // y letras papel en oscuro (drawable-night-nodpi).
    Box(modifier.padding(4.dp)) {
        Image(painterResource(R.drawable.chaggu_logo), contentDescription = stringResource(R.string.cd_logo), modifier = Modifier.fillMaxWidth())
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

/** Barra inferior (docs/GRUPOS.md): Grupos · DMs · Asuntos · Calendario · Tú, siempre en este orden. */
private val TABS = listOf("home?ws={ws}", "dms", "issues", "agenda", "settings")

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

    // Permiso de notificaciones (Android 13+), una sola vez y con una explicación previa (SPEC-v3 §6).
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) container.retryPushRegistration()
    }
    var askPush by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && !container.settings.askedNotificationPermission &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) askPush = true
    }
    if (askPush) androidx.compose.material3.AlertDialog(
        onDismissRequest = { askPush = false; container.settings.askedNotificationPermission = true },
        title = { Text(stringResource(R.string.push_why_title)) },
        text = { Text(stringResource(R.string.push_why_body)) },
        confirmButton = { androidx.compose.material3.TextButton(onClick = {
            askPush = false; container.settings.askedNotificationPermission = true
            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }, modifier = Modifier.testTag("pushAllow")) { Text(stringResource(R.string.push_allow)) } },
        dismissButton = { androidx.compose.material3.TextButton(onClick = { askPush = false; container.settings.askedNotificationPermission = true }) { Text(stringResource(R.string.push_later)) } },
    )

    fun openConv(id: String, seq: Long? = null, side: String? = null) =
        nav.navigate("conv/$id?m=${seq ?: ""}&side=${side ?: ""}") { launchSingleTop = true }
    fun tab(r: String) = nav.navigate(r) { popUpTo(nav.graph.findStartDestination().id) { saveState = true }; launchSingleTop = true; restoreState = true }

    // El aviso se lanza en un scope propio: al consumir el enlace cambia la clave del efecto y lo cancelaría.
    LaunchedEffect(pending, state.data != null, backStack != null) {
        val p = pending ?: return@LaunchedEffect
        val data = state.data ?: return@LaunchedEffect
        // Cold notification taps can arrive before NavHost installs its graph.
        // Keep the link pending until the first destination is ready.
        if (backStack == null) return@LaunchedEffect
        container.pendingLink.value = null
        when (p) {
            is DeepLink.Conversation ->
                if (data.conversations.any { it.id == p.id }) { nav.popBackStack(nav.graph.findStartDestination().id, false); openConv(p.id, p.seq, p.side) }
                // Sidechat de un chat que no puedo leer (colega que no está en el grupo): el sidechat a pantalla completa.
                else if (p.side != null && data.conversations.any { it.id == p.side }) { nav.popBackStack(nav.graph.findStartDestination().id, false); openConv(p.side) }
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
                val data = state.data
                val now = System.currentTimeMillis()
                val groupsBadge = data?.let { com.tiecoms.app.core.GroupsTree.groupsUnread(it, now) } ?: 0
                val dmsBadge = data?.let { com.tiecoms.app.core.GroupsTree.dmsUnread(it, now) } ?: 0
                data class Tab(val route: String, val label: Int, val badge: Int, val icon: @Composable () -> Unit)
                val items = listOf(
                    Tab("home?ws={ws}", R.string.nav_groups, groupsBadge) { Icon(Icons.Filled.Groups, null) },
                    Tab("dms", R.string.nav_dms, dmsBadge) { Icon(Icons.Filled.Forum, null) },
                    Tab("issues", R.string.nav_issues, 0) { Icon(Icons.Filled.CheckCircle, null) },
                    Tab("agenda", R.string.nav_calendar, 0) { Icon(Icons.Filled.DateRange, null) },
                    // «Tú»: la foto de la persona como ícono (como el perfil de Instagram).
                    Tab("settings", R.string.nav_you, 0) {
                        val me = data?.me
                        val org = com.tiecoms.app.core.Names.org(data, me?.primaryOrgId)
                        Avatar(me?.name ?: "?", parseColor(org?.colorBg, com.tiecoms.app.ui.theme.Brand.Black), parseColor(org?.colorFg, androidx.compose.ui.graphics.Color.White),
                            size = 26.dp, photo = me?.avatarUrl,
                            modifier = if (route == "settings") Modifier.border(2.dp, MaterialTheme.colorScheme.onSurface, androidx.compose.foundation.shape.CircleShape) else Modifier)
                    },
                )
                items.forEach { t ->
                    NavigationBarItem(
                        selected = route == t.route, onClick = { tab(if (t.route.startsWith("home")) "home" else t.route) },
                        icon = {
                            if (t.badge > 0) BadgedBox(badge = { Badge { Text(if (t.badge > 99) "99+" else t.badge.toString()) } }) { t.icon() } else t.icon()
                        },
                        label = { Text(stringResource(t.label), maxLines = 1) },
                        modifier = Modifier.testTag("tab-" + t.route.substringBefore('?')),
                    )
                }
            }
        },
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { pad ->
        NavHost(nav, startDestination = "home?ws={ws}", modifier = Modifier.padding(pad)) {
            composable("home?ws={ws}", arguments = listOf(navArgument("ws") { type = NavType.StringType; nullable = true; defaultValue = null })) {
                GroupsScreen(
                    workspaceFilter = it.arguments?.getString("ws"),
                    onClearFilter = { nav.navigate("home") { popUpTo(0) { inclusive = true } } },
                    onOpen = { id -> openConv(id) },
                    onMentions = { nav.navigate("mentions") { launchSingleTop = true } },
                    onIssuesOf = { c -> nav.navigate("issues-of/$c") { launchSingleTop = true } },
                    onOpenIssue = { i -> nav.navigate("issue/$i") },
                    onDetails = { c -> nav.navigate("details/$c") { launchSingleTop = true } },
                    onJoinCode = { code -> nav.navigate("invite/$code") { launchSingleTop = true } },
                )
            }
            composable("dms") {
                DmsScreen(
                    onOpen = { id -> openConv(id) },
                    onNewMessage = { nav.navigate("newchat?person=1") { launchSingleTop = true } },
                    onDetails = { c -> nav.navigate("details/$c") { launchSingleTop = true } },
                    onMentions = { nav.navigate("mentions") { launchSingleTop = true } },
                )
            }
            composable("issues") { IssuesScreen(onOpen = { nav.navigate("issue/$it") }) }
            composable("issues-of/{conv}") {
                IssuesScreen(onOpen = { i -> nav.navigate("issue/$i") }, conversationFilter = it.arguments?.getString("conv"), onBack = { nav.popBackStack() })
            }
            composable("agenda") { AgendaScreen(onOpenEvent = { nav.navigate("event/$it") }) }
            composable("settings") { SettingsScreen(onNavigate = { r -> nav.navigate(r) { launchSingleTop = true } }) }
            composable("oversight/{org}") {
                OversightScreen(it.arguments?.getString("org") ?: "", onBack = { nav.popBackStack() }, onOpen = { c -> openConv(c) },
                    onReadOnly = { c, name -> nav.navigate("readonly/$c?name=" + android.net.Uri.encode(name)) { launchSingleTop = true } })
            }
            composable("readonly/{id}?name={name}", arguments = listOf(navArgument("name") { type = NavType.StringType; defaultValue = "" })) {
                ReadOnlyGroupScreen(it.arguments?.getString("id") ?: "", it.arguments?.getString("name") ?: "", onBack = { nav.popBackStack() })
            }
            composable("conv/{id}?m={m}&side={side}", arguments = listOf(
                navArgument("m") { type = NavType.StringType; nullable = true; defaultValue = null },
                navArgument("side") { type = NavType.StringType; nullable = true; defaultValue = null },
            )) {
                val id = it.arguments?.getString("id") ?: ""
                ConversationScreen(
                    id = id, jumpSeq = it.arguments?.getString("m")?.toLongOrNull(),
                    openSide = it.arguments?.getString("side")?.takeIf { s -> s.isNotBlank() },
                    onBack = { if (!nav.popBackStack()) tab("home") },
                    onDetails = { nav.navigate("details/$id") { launchSingleTop = true } },
                    onOpenConversation = { cid, seq -> openConv(cid, seq) },
                    onOpenIssue = { nav.navigate("issue/$it") },
                    onOpenEvent = { nav.navigate("event/$it") },
                    onTrazo = { nav.navigate("trazo") { launchSingleTop = true } },
                    onOpenWorkspace = { w -> nav.navigate("home?ws=$w") { launchSingleTop = true } },
                    onPrivateReply = { m ->
                        uiScope.launch {
                            try {
                                val author = client.state.value.data?.let { com.tiecoms.app.core.Names.person(it, m.authorId)?.name }
                                val r = client.createChat(listOf(m.authorId), null)
                                container.privateReply.value = com.tiecoms.app.AppContainer.PrivateReply(r.id, m, author)
                                openConv(r.id)
                            } catch (e: Exception) {
                                container.toast(if ((e as? com.tiecoms.app.core.ApiException)?.status in setOf(403, 404)) ctx.getString(R.string.reply_private_unreachable) else errorText(ctx, e))
                            }
                        }
                    },
                )
            }
            composable("details/{id}") {
                DetailsScreen(id = it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() },
                    onOpenIssue = { i -> nav.navigate("issue/$i") }, onOpenEvent = { e -> nav.navigate("event/$e") },
                    onOpenConversation = { c -> openConv(c) },
                    onAddMembers = { c -> nav.navigate("addmembers/$c") { launchSingleTop = true } },
                    onLeft = { nav.popBackStack(nav.graph.findStartDestination().id, false) })
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
            composable("mentions") { MentionsInboxScreen(onBack = { nav.popBackStack() }, onOpen = { c, seq -> openConv(c, seq) }) }
            composable("newchat?person={person}", arguments = listOf(navArgument("person") { type = NavType.StringType; defaultValue = "" })) {
                // Desde DMs («Mensaje nuevo»): solo persona o chat grupal (1 persona → directo, 2+ → chat grupal).
                NewChatScreen(onBack = { nav.popBackStack() }, onOpened = { c -> nav.popBackStack(); openConv(c) }, personOnly = it.arguments?.getString("person") == "1")
            }
            composable("addmembers/{id}") {
                AddMembersScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() })
            }
            composable("profile") { ProfileScreen(onBack = { nav.popBackStack() }) }
            composable("blocked-users") { BlockedUsersScreen(onBack = { nav.popBackStack() }) }
            composable("files") { FilesScreen(onBack = { nav.popBackStack() }) }
            composable("domains/{org}") { DomainsScreen(it.arguments?.getString("org") ?: "", onBack = { nav.popBackStack() }) }
            composable("delete-account") { DeleteAccountScreen(onBack = { nav.popBackStack() }) }
            composable("invite/{token}") {
                InviteScreen(
                    token = it.arguments?.getString("token") ?: "",
                    signedIn = true,
                    onBack = { if (!nav.popBackStack()) tab("home") },
                    onLogin = {}, onSignup = {},
                    onJoined = { ws, conv ->
                        // La vista previa sale de la pila: Atrás desde el grupo vuelve a donde estaba.
                        if (conv != null) { nav.popBackStack(); openConv(conv) }
                        else nav.navigate("home?ws=$ws") { popUpTo(0) { inclusive = true } }
                    },
                )
            }
        }
    }
}
