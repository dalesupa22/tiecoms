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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.Group
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import com.tiecoms.app.container
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first
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
        // Las etiquetas de prueba se exponen como resource-id (UiAutomator del splash y Macrobenchmark/Baseline Profile).
        val rootMod = Modifier.semantics { testTagsAsResourceId = true }
        Surface(Modifier.fillMaxSize().then(rootMod).dismissKeyboardOnOutsideInteraction(), color = MaterialTheme.colorScheme.background) {
            // Actualización disponible (GET /app-version): franja fija arriba que empuja la app, o pantalla que bloquea.
            val latest by container.appVersion.collectAsStateWithLifecycle()
            val update = com.tiecoms.app.core.AppUpdate.evaluate(com.tiecoms.app.BuildConfig.VERSION_CODE, latest)
            Box(Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize()) {
                    if (update is com.tiecoms.app.core.AppUpdate.Status.Available) UpdateBanner(update)
                    // 1.7.1: «📞 En llamada en tu …» (estoy en la llamada desde otro dispositivo), fija arriba.
                    val elsewhere = if (state.status == SessionStatus.READY) rememberElsewhereCall() else null
                    if (elsewhere != null) ElsewhereBanner(elsewhere, if (update is com.tiecoms.app.core.AppUpdate.Status.Available) Modifier else Modifier.windowInsetsPadding(WindowInsets.statusBars))
                    // Con la franja, la barra de estado ya está ocupada: las pantallas no vuelven a sumarla.
                    Box(Modifier.weight(1f).fillMaxWidth().then(if (update is com.tiecoms.app.core.AppUpdate.Status.Available || elsewhere != null)
                        Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)) {
                        when (state.status) {
                            SessionStatus.LOADING -> Splash()
                            SessionStatus.UNREACHABLE -> Unreachable()
                            SessionStatus.ANONYMOUS -> AuthNav()
                            SessionStatus.READY -> {
                                // Velocidad (1.7.0): lo no crítico del arranque espera a este primer fotograma.
                                androidx.compose.runtime.LaunchedEffect(client) { androidx.compose.runtime.withFrameNanos { }; client.firstFrameDrawn() }
                                TaskDialogsHost { MainNav() }
                            }
                        }
                    }
                }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = 72.dp))
                // Splash animado sobre la app: la app carga debajo y aparece cuando el splash se aleja.
                splash?.let { mode ->
                    SplashOverlay(mode, ready = state.status != SessionStatus.LOADING) { container.splashMode.value = null }
                }
                if (update is com.tiecoms.app.core.AppUpdate.Status.Required) UpdateRequiredScreen(update)
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
                onSignup = { org -> nav.navigate("signup?org=" + (org?.let { t -> java.net.URLEncoder.encode(t, "UTF-8") } ?: "")) },
                onJoined = { _, _ -> },
            )
        }
    }
}

/**
 * Barra inferior (docs/GRUPOS.md): Grupos · DMs · Asuntos · Calendario · Tú, siempre en este orden.
 * Con `features.calls` va «Llamadas» entre Calendario y Tú (docs/LLAMADAS.md).
 */
private val TABS = listOf("home?ws={ws}", "dms", "issues", "agenda", "calls", "settings")

/**
 * Una pestaña: [outlined] en reposo y [filled] (Material Symbols Rounded) seleccionada; [custom] dibuja el ícono a mano
 * («Tú» con el avatar) y recibe si está seleccionada.
 */
private class BottomTab(
    val route: String, val label: Int, val badge: Int,
    val outlined: androidx.compose.ui.graphics.vector.ImageVector? = null, val filled: androidx.compose.ui.graphics.vector.ImageVector? = null,
    /** Llamadas perdidas: globo e ícono en rojo ([MissedRed]) en lugar del acento. */
    val alert: Boolean = false,
    /** Nombre para lectores de pantalla cuando hay globo (p. ej. «2 llamadas perdidas»); null = nombre · número. */
    val badgeLabel: String? = null,
    val custom: (@Composable (Boolean) -> Unit)? = null,
)

/**
 * Barra inferior flotante (1.6.9, pedido de Danny; referentes Telegram/Instagram/WhatsApp): solo íconos, sin texto.
 * - Superficie elevada surfaceContainer con leve transparencia, esquinas de 28 dp, borde sutil, ~60 dp de alto y 16 dp de margen.
 * - Íconos Rounded de 24 dp en onSurfaceVariant; el seleccionado va relleno en el acento, con una píldora del acento
 *   al 12 % (56×32 dp) solo detrás del ícono.
 * - Globos pequeños (mín. 16 dp, 10 sp, acento, borde 1,5 dp del fondo) arriba a la derecha, dentro de su celda.
 * - Cada pestaña dice su nombre completo a los lectores de pantalla; al tocar, un háptico ligero.
 */
@Composable
private fun BottomTabs(items: List<BottomTab>, selected: String?, onSelect: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val view = androidx.compose.ui.platform.LocalView.current
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp)
    Box(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 10.dp)) {
        Surface(
            shape = shape, color = cs.surfaceContainer.copy(alpha = 0.94f), shadowElevation = 8.dp, tonalElevation = 2.dp,
            border = androidx.compose.foundation.BorderStroke(1.dp, cs.outlineVariant.copy(alpha = 0.55f)),
            modifier = Modifier.fillMaxWidth().height(60.dp).testTag("tabs"),
        ) {
            androidx.compose.foundation.layout.Row(Modifier.fillMaxSize().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                items.forEach { t ->
                    val on = selected == t.route
                    val name = stringResource(t.label)
                    val badgeCd = if (t.badge > 0) " · " + (t.badgeLabel ?: t.badge.toString()) else ""
                    Box(
                        Modifier.weight(1f).fillMaxHeight()
                            .androidx_selectable(on, name + badgeCd) {
                                view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP)
                                onSelect(t.route)
                            }
                            .testTag("tab-" + t.route.substringBefore('?')),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.clearAndSetSemantics {}.size(width = 56.dp, height = 32.dp)
                            .background(if (on && t.custom == null) cs.primary.copy(alpha = 0.12f) else androidx.compose.ui.graphics.Color.Transparent, androidx.compose.foundation.shape.RoundedCornerShape(50)),
                            contentAlignment = Alignment.Center) {
                            Box {
                                if (t.custom != null) t.custom.invoke(on)
                                else Icon(if (on) (t.filled ?: t.outlined!!) else t.outlined!!, null, Modifier.size(24.dp), tint = if (t.alert && t.badge > 0) MissedRed else if (on) cs.primary else cs.onSurfaceVariant)
                                if (t.badge > 0) TabBadge(t.badge, Modifier.align(Alignment.TopEnd).offset(x = 9.dp, y = (-5).dp), if (t.alert) MissedRed else null)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Globo de no leídos: mín. 16 dp, 10 sp, acento, con borde de 1,5 dp del color de la barra. */
@Composable
private fun TabBadge(n: Int, modifier: Modifier, color: androidx.compose.ui.graphics.Color? = null) {
    val cs = MaterialTheme.colorScheme
    Box(modifier.height(16.dp).widthIn(min = 16.dp)
        .border(1.5.dp, cs.surfaceContainer, androidx.compose.foundation.shape.RoundedCornerShape(50))
        .padding(1.5.dp).background(color ?: cs.primary, androidx.compose.foundation.shape.RoundedCornerShape(50)).padding(horizontal = 3.dp).testTag(if (color != null) "tabBadgeMissed" else "tabBadge"),
        contentAlignment = Alignment.Center) {
        val d = androidx.compose.ui.platform.LocalDensity.current
        androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(d.density, 1f)) {
            Text(if (n > 99) "99+" else n.toString(), color = if (color != null) androidx.compose.ui.graphics.Color.White else cs.onPrimary, fontSize = 10.sp, lineHeight = 10.sp, maxLines = 1,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        }
    }
}

private fun Modifier.androidx_selectable(selected: Boolean, label: String, onClick: () -> Unit): Modifier =
    this.selectable(selected = selected, role = androidx.compose.ui.semantics.Role.Tab, onClick = onClick)
        .semantics { contentDescription = label }

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

    /** El mismo chat ya está abierto y se pide un mensaje: salta ahí mismo (conserva el filtro de temas «Todo»). */
    fun jumpHere(id: String, seq: Long?, side: String?, messageId: String?): Boolean {
        if (seq == null || seq <= 0 || side != null || messageId != null || container.openConversationId != id) return false
        val top = nav.currentBackStackEntry ?: return false
        if (top.destination.route?.startsWith("conv/") != true || top.arguments?.getString("id") != id) return false
        container.chatJump.value = id to seq
        return true
    }
    fun openConv(id: String, seq: Long? = null, side: String? = null, messageId: String? = null) {
        if (jumpHere(id, seq, side, messageId)) return
        com.tiecoms.app.platform.Perf.chatTapped().let { nav.navigate("conv/$id?m=${seq ?: ""}&side=${side ?: ""}&mid=${messageId ?: ""}") { launchSingleTop = true } }
    }
    fun tab(r: String) = nav.navigate(r) { popUpTo(nav.graph.findStartDestination().id) { saveState = true }; launchSingleTop = true; restoreState = true }
    // ✏️ y «＋ Crear» de Grupos, DMs, Asuntos y Calendario (docs/GRUPOS.md › Barra de arriba).
    val quick = QuickNav(
        onCompose = { nav.navigate("newchat") { launchSingleTop = true } },
        onOpen = { id -> openConv(id) },
        onOpenIssue = { i -> nav.navigate("issue/$i") },
        onJoinCode = { code -> nav.navigate("invite/$code") { launchSingleTop = true } },
    )

    val callLauncher = rememberCallLauncher()
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
                if (data.conversations.any { it.id == p.id }) {
                    if (!jumpHere(p.id, p.seq, p.side, p.messageId)) { nav.popBackStack(nav.graph.findStartDestination().id, false); openConv(p.id, p.seq, p.side, p.messageId) }
                }
                // Sidechat de un chat que no puedo leer (colega que no está en el grupo): el sidechat a pantalla completa.
                else if (p.side != null && data.conversations.any { it.id == p.side }) { nav.popBackStack(nav.graph.findStartDestination().id, false); openConv(p.side) }
                else uiScope.launch { container.toast(ctx.getString(R.string.no_access)) }
            is DeepLink.Issue -> {
                // Push «te asignó una tarea»: si está en un chat que leo (inChat), primero el chat y encima el asunto.
                if (p.conversationId != null && data.conversations.any { it.id == p.conversationId }) { nav.popBackStack(nav.graph.findStartDestination().id, false); openConv(p.conversationId) }
                nav.navigate("issue/${p.id}") { launchSingleTop = true }
            }
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
                DeepLinks.SCREEN_SCHEDULED -> nav.navigate("scheduled") { launchSingleTop = true }
            }
            is DeepLink.Share -> { container.shareDraft = p; nav.navigate("share") { launchSingleTop = true } }
            is DeepLink.CallDetail -> nav.navigate("call/${p.id}") { launchSingleTop = true }
            // «Contestar» del aviso de llamada (push TC_CALL): pide el micrófono y entra con /calls/:id/join.
            is DeepLink.CallJoin -> {
                com.tiecoms.app.platform.CallService.cancelIncoming(ctx, p.id)
                if (container.calls.ringing.value?.call?.id == p.id) container.calls.dismissRing()
                callLauncher.launch(p.camera) { cam -> container.calls.join(p.id, cam) }
            }
            is DeepLink.Signup -> Unit
        }
    }

    // gg (docs/ASISTENTE.md): burbuja solo en las 5 listas; el panel cubre también la barra de pestañas.
    val gg = rememberAssistant(client)
    Box(Modifier.fillMaxSize()) {
    Scaffold(
        bottomBar = {
            if (route in TABS) {
                val data = state.data
                val now = System.currentTimeMillis()
                val groupsBadge = data?.let { com.tiecoms.app.core.GroupsTree.groupsUnread(it, now) } ?: 0
                val dmsBadge = data?.let { com.tiecoms.app.core.GroupsTree.dmsUnread(it, now) } ?: 0
                // Solo íconos de línea, sin texto (pedido de Danny, 29-sep-2026): [label] es el nombre completo para lectores de pantalla.
                val items = listOfNotNull(
                    BottomTab("home?ws={ws}", R.string.nav_groups, groupsBadge, Icons.Outlined.Group, Icons.Rounded.Group),
                    BottomTab("dms", R.string.nav_dms, dmsBadge, Icons.Outlined.Forum, Icons.Rounded.Forum),
                    // «Todo» / «Hub» (30-sep-2026): Tareas con atajos a Correo, WhatsApp, Archivos y Trazo; el número sigue siendo solo de tareas.
                    BottomTab("issues", R.string.nav_hub, 0, TodoIcons.outlined, TodoIcons.filled),
                    BottomTab("agenda", R.string.nav_agenda, 0, Icons.Outlined.CalendarMonth, Icons.Rounded.CalendarMonth),
                    // Llamadas (docs/LLAMADAS.md): sexto ícono, solo si el servidor las tiene prendidas.
                    // Perdidas sin ver: número en pastilla roja e ícono rojo; se quita al abrir la pestaña (POST /calls/seen).
                    (data?.missedCalls ?: 0).let { n ->
                        BottomTab("calls", R.string.nav_calls, n, Icons.Outlined.Call, Icons.Rounded.Call, alert = true,
                            badgeLabel = if (n > 0) stringResource(R.string.nav_calls_missed, n) else null)
                    }.takeIf { data?.callsEnabled == true },
                    // «Tú»: la foto de la persona (26 dp) con anillo del acento si está seleccionada.
                    BottomTab("settings", R.string.nav_you, 0) { on ->
                        val me = data?.me
                        val org = com.tiecoms.app.core.Names.org(data, me?.primaryOrgId)
                        // «No molestar» activo: la lunita sobre la foto (SPEC-silencio §3).
                        val dndNow = rememberSilenceNow(state.dndUntil)
                        DndMoonBadge(com.tiecoms.app.core.Silence.active(state.dndUntil, dndNow) || mySleepingNow()) {
                        Avatar(me?.name ?: "?", parseColor(org?.colorBg, com.tiecoms.app.ui.theme.Brand.Black), parseColor(org?.colorFg, androidx.compose.ui.graphics.Color.White),
                            size = 26.dp, photo = me?.avatarUrl,
                            modifier = if (on) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, androidx.compose.foundation.shape.CircleShape) else Modifier)
                        }
                    },
                )
                BottomTabs(items, selected = route) { r -> tab(if (r.startsWith("home")) "home" else r) }
            }
        },
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
        // Correo en el chat (docs/CORREO.md): a dónde van los botones de las tarjetas.
        val mailNav = remember(nav) {
            MailNav(
                openMail = { id, mode -> nav.navigate("mail/$id?mode=$mode") { launchSingleTop = true } },
                openList = { c -> nav.navigate("mailbox?conv=${c ?: ""}") { launchSingleTop = true } },
                openWhatsApp = { nav.navigate("whatsapp") { launchSingleTop = true } },
            )
        }
        CompositionLocalProvider(LocalMailNav provides mailNav) {
        NavHost(nav, startDestination = "home?ws={ws}", modifier = Modifier.fillMaxSize()) {
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
                    onReminders = { nav.navigate("reminders") { launchSingleTop = true } },
                    quick = quick,
                )
            }
            composable("dms") {
                DmsScreen(
                    onOpen = { id -> openConv(id) },
                    onNewMessage = quick.onCompose,
                    onDetails = { c -> nav.navigate("details/$c") { launchSingleTop = true } },
                    onMentions = { nav.navigate("mentions") { launchSingleTop = true } },
                    quick = quick,
                )
            }
            composable("issues") { IssuesScreen(onOpen = { nav.navigate("issue/$it") }, quick = quick, hub = { r -> nav.navigate(r) { launchSingleTop = true } }) }
            composable("issues-of/{conv}") {
                IssuesScreen(onOpen = { i -> nav.navigate("issue/$i") }, conversationFilter = it.arguments?.getString("conv"), onBack = { nav.popBackStack() })
            }
            composable("agenda") { AgendaScreen(onOpenEvent = { nav.navigate("event/$it") }, quick = quick) }
            composable("calls") { CallsScreen(onOpenDetail = { c -> nav.navigate("call/$c") { launchSingleTop = true } }, onOpenConversation = { c -> openConv(c) }) }
            composable("call/{id}") {
                CallDetailScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() }, onOpenConversation = { c -> openConv(c) })
            }
            composable("settings") { SettingsScreen(onNavigate = { r -> nav.navigate(r) { launchSingleTop = true } }) }
            composable("oversight/{org}") {
                OversightScreen(it.arguments?.getString("org") ?: "", onBack = { nav.popBackStack() }, onOpen = { c -> openConv(c) },
                    onReadOnly = { c, name -> nav.navigate("readonly/$c?name=" + android.net.Uri.encode(name)) { launchSingleTop = true } })
            }
            composable("readonly/{id}?name={name}", arguments = listOf(navArgument("name") { type = NavType.StringType; defaultValue = "" })) {
                ReadOnlyGroupScreen(it.arguments?.getString("id") ?: "", it.arguments?.getString("name") ?: "", onBack = { nav.popBackStack() })
            }
            composable("conv/{id}?m={m}&side={side}&mid={mid}", arguments = listOf(
                navArgument("m") { type = NavType.StringType; nullable = true; defaultValue = null },
                navArgument("side") { type = NavType.StringType; nullable = true; defaultValue = null },
                navArgument("mid") { type = NavType.StringType; nullable = true; defaultValue = null },
            )) {
                val id = it.arguments?.getString("id") ?: ""
                ConversationScreen(
                    id = id, jumpSeq = it.arguments?.getString("m")?.toLongOrNull(),
                    jumpMessageId = it.arguments?.getString("mid")?.takeIf { s -> s.isNotBlank() },
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
                                // Navegar siempre en el hilo principal (tras la red, la corrutina puede volver en otro hilo).
                                withContext(Dispatchers.Main) { openConv(r.id) }
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
                IssueDetailScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() }, onOpenOrigin = { c, seq -> openConv(c, seq) },
                    onOpenIssue = { i -> nav.navigate("issue/$i") })
            }
            composable("event/{id}") {
                EventDetailScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() }, onOpenChat = { c -> openConv(c) })
            }
            composable("scheduled") { ScheduledScreen(onBack = { nav.popBackStack() }, onOpenConversation = { c -> openConv(c) }) }
            composable("reminders") { RemindersScreen(onBack = { nav.popBackStack() }, onOpen = { c, seq -> openConv(c, seq) }) }
            composable("trazo") { TrazoScreen(onBack = { nav.popBackStack() }, onOpen = { c -> openConv(c) }) }
            composable("whatsapp") { WhatsAppScreen(onBack = { nav.popBackStack() }, onOpenConversation = { c -> openConv(c) }) }
            // Correo: la lista (con ?conv= el destino ya viene elegido) y el correo abierto (mode: read | comments | reply).
            composable("mailbox?conv={conv}", arguments = listOf(navArgument("conv") { type = NavType.StringType; defaultValue = "" })) {
                val conv = it.arguments?.getString("conv")?.takeIf { c -> c.isNotBlank() }
                MailListScreen(conv, onBack = { nav.popBackStack() }, onShared = { c, mid ->
                    if (c == conv) nav.popBackStack() else { nav.popBackStack(); openConv(c) }
                    // En el chat, salta a la tarjeta recién compartida (cuando llega su mensaje).
                    if (mid != null) uiScope.launch {
                        val seq = kotlinx.coroutines.withTimeoutOrNull(8_000) {
                            client.state.first { st -> st.conversations[c]?.messages?.any { m -> m.id == mid } == true }.conversations[c]!!.messages.first { m -> m.id == mid }.seq
                        }
                        if (seq != null) container.chatJump.value = c to seq
                    }
                })
            }
            composable("mail/{id}?mode={mode}", arguments = listOf(navArgument("mode") { type = NavType.StringType; defaultValue = "read" })) {
                MailDetailScreen(it.arguments?.getString("id") ?: "", it.arguments?.getString("mode") ?: "read", onBack = { nav.popBackStack() },
                    onOpenIssue = { i -> nav.navigate("issue/$i") })
            }
            composable("share") {
                val draft = container.shareDraft
                ShareScreen(draft?.text ?: "", draft?.source ?: "other", onBack = { container.shareDraft = null; if (!nav.popBackStack()) tab("home") },
                    onDone = { c -> container.shareDraft = null; nav.popBackStack(); openConv(c) })
            }
            composable("mentions") { MentionsInboxScreen(onBack = { nav.popBackStack() }, onOpen = { c, seq -> openConv(c, seq) }) }
            composable("newchat") {
                // «Mensaje nuevo» (✏️): un toque abre el directo; «Chat con varias personas» arma un chat grupal.
                NewChatScreen(onBack = { nav.popBackStack() }, onOpened = { c -> nav.popBackStack(); openConv(c) })
            }
            composable("addmembers/{id}") {
                AddMembersScreen(it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() })
            }
            composable("profile") { ProfileScreen(onBack = { nav.popBackStack() }) }
            composable("blocked-users") { BlockedUsersScreen(onBack = { nav.popBackStack() }) }
            composable("files") { FilesScreen(onBack = { nav.popBackStack() }) }
            composable("signed") { SignedDocsScreen(onBack = { nav.popBackStack() }, onOpenMessage = { c, mid -> openConv(c, messageId = mid) }) }
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
                        else if (ws.isBlank()) { if (!nav.popBackStack()) tab("home") } // a la empresa, sin grupos
                        else nav.navigate("home?ws=$ws") { popUpTo(0) { inclusive = true } }
                    },
                )
            }
        }
        }
        AssistantBubble(gg, visible = route in TABS && !gg.open, modifier = Modifier.align(Alignment.BottomEnd))
        }
    }
    // Llamada en curso y llamada entrante (docs/LLAMADAS.md): encima de todo, también de la barra de pestañas.
    CallOverlayHost(onOpenConversation = { c -> openConv(c) })
    AssistantPanel(gg, myName = state.data?.me?.name ?: "") { target ->
        gg.close()
        when (target) {
            is com.tiecoms.app.core.Assistant.Target.Conversation ->
                if (state.data?.conversations?.any { it.id == target.id } == true) openConv(target.id)
                else uiScope.launch { runCatching { client.loadBootstrap() }; openConv(target.id) }
            is com.tiecoms.app.core.Assistant.Target.Screen -> tab(target.name)
        }
    }
    }
}
