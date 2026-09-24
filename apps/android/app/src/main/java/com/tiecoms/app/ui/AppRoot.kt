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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.tiecoms.app.R
import com.tiecoms.app.container
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.launch

val LocalSnackbar = staticCompositionLocalOf { SnackbarHostState() }

@Composable
fun AppRoot() {
    val container = LocalContext.current.container
    val client by container.client.collectAsStateWithLifecycle()
    val state by client.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    CompositionLocalProvider(LocalClient provides client, LocalContainer provides container, LocalSnackbar provides snackbar) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.fillMaxSize()) {
                when (state.status) {
                    SessionStatus.LOADING -> Splash()
                    SessionStatus.UNREACHABLE -> Unreachable()
                    SessionStatus.ANONYMOUS -> AuthNav()
                    SessionStatus.READY -> MainNav()
                }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = 72.dp))
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
    // El logo trae fondo crema: en modo oscuro va sobre una tarjeta crema redondeada.
    Box(modifier.background(com.tiecoms.app.ui.theme.Brand.Cream, androidx.compose.foundation.shape.RoundedCornerShape(20.dp)).padding(8.dp)) {
        Image(painterResource(R.drawable.logo_wide), contentDescription = stringResource(R.string.cd_logo), modifier = Modifier.fillMaxWidth())
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

@Composable
private fun MainNav() {
    val nav = rememberNavController()
    val container = LocalContainer.current
    val client = LocalClient.current
    val ctx = LocalContext.current
    val snackbar = LocalSnackbar.current
    val pending by container.pendingLink.collectAsStateWithLifecycle()
    val state by client.state.collectAsStateWithLifecycle()

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

    // El aviso se lanza en un scope propio: al consumir el enlace cambia la clave del efecto y
    // lo cancelaría (el snackbar se cerraría al instante).
    val uiScope = rememberCoroutineScope()
    LaunchedEffect(pending, state.data != null) {
        val p = pending ?: return@LaunchedEffect
        val data = state.data ?: return@LaunchedEffect
        container.pendingLink.value = null
        when (p) {
            is DeepLink.Conversation ->
                if (data.conversations.any { it.id == p.id }) nav.navigate("conv/${p.id}") { launchSingleTop = true; popUpTo(nav.graph.startDestinationId) }
                else uiScope.launch { snackbar.showSnackbar(ctx.getString(R.string.no_access)) }
            is DeepLink.Workspace ->
                if (data.workspaces.any { it.id == p.id }) nav.navigate("home?ws=${p.id}") { popUpTo(0) { inclusive = true } }
                else uiScope.launch { snackbar.showSnackbar(ctx.getString(R.string.err_not_found)) }
            is DeepLink.Invite -> nav.navigate("invite/${p.token}") { launchSingleTop = true }
            is DeepLink.Signup -> Unit
        }
    }

    NavHost(nav, startDestination = "home?ws={ws}") {
        composable("home?ws={ws}", arguments = listOf(navArgument("ws") { type = NavType.StringType; nullable = true; defaultValue = null })) {
            HomeScreen(
                workspaceFilter = it.arguments?.getString("ws"),
                onClearFilter = { nav.navigate("home") { popUpTo(0) { inclusive = true } } },
                onOpen = { id -> nav.navigate("conv/$id") { launchSingleTop = true } },
                onSettings = { nav.navigate("settings") { launchSingleTop = true } },
            )
        }
        composable("conv/{id}") {
            val id = it.arguments?.getString("id") ?: ""
            ConversationScreen(id = id, onBack = { if (!nav.popBackStack()) nav.navigate("home") }, onDetails = { nav.navigate("details/$id") { launchSingleTop = true } })
        }
        composable("details/{id}") {
            DetailsScreen(id = it.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() })
        }
        composable("settings") { SettingsScreen(onBack = { nav.popBackStack() }) }
        composable("invite/{token}") {
            InviteScreen(
                token = it.arguments?.getString("token") ?: "",
                signedIn = true,
                onBack = { if (!nav.popBackStack()) nav.navigate("home") },
                onLogin = {}, onSignup = {},
                onJoined = { ws, conv ->
                    if (conv != null) nav.navigate("conv/$conv") { popUpTo(nav.graph.startDestinationId) }
                    else nav.navigate("home?ws=$ws") { popUpTo(0) { inclusive = true } }
                },
            )
        }
    }
}
