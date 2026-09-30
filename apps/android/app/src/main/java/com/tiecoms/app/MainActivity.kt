package com.tiecoms.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.DeepLinks
import com.tiecoms.app.core.SplashChoreo
import com.tiecoms.app.core.Sso
import com.tiecoms.app.ui.AppRoot
import com.tiecoms.app.ui.theme.TieComsTheme

class MainActivity : ComponentActivity() {
    private var pausedForMeeting = false
    private var pausedForMail = false
    override fun onPause() {
        if (container.meetingConnecting != null) pausedForMeeting = true
        if (container.mailConnecting != null) pausedForMail = true
        super.onPause()
    }
    override fun onResume() {
        super.onResume()
        // A callback is handled by onNewIntent/onCreate before this. A plain Back from Custom Tabs cancels.
        if (pausedForMeeting && container.meetingConnecting != null) container.cancelMeetingConnect()
        pausedForMeeting = false
        // Igual con el correo: volver con Atrás sin terminar descarta la prueba.
        if (pausedForMail && container.mailConnecting != null) { container.client.value.cancelMailConnect(); container.mailConnecting = null }
        pausedForMail = false
    }
    override fun attachBaseContext(newBase: android.content.Context) { super.attachBaseContext(com.tiecoms.app.platform.AppLocale.wrap(newBase)) }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Splash del sistema (símbolo sin rayitas sobre tinta) → splash animado de ignición en Compose,
        // que arranca con el mismo símbolo en el mismo sitio; el del sistema se quita con un fundido rápido.
        val system = installSplashScreen()
        super.onCreate(savedInstanceState)
        // Solo depuración (capturas): `--ez holdSystemSplash true` deja el splash del sistema en pantalla;
        // `--ef splashFreeze 0.45` congela el splash animado en ese segundo (tocar lo cierra).
        if (BuildConfig.DEBUG && savedInstanceState == null) {
            container.holdSystemSplash = intent?.getBooleanExtra("holdSystemSplash", false) == true
            container.splashFreezeAt = intent?.takeIf { it.hasExtra("splashFreeze") }?.getFloatExtra("splashFreeze", 0f)
            if (container.holdSystemSplash) system.setKeepOnScreenCondition { container.holdSystemSplash }
        }
        system.setOnExitAnimationListener { v ->
            v.view.animate().alpha(0f).setDuration(150).withEndAction { v.remove() }.start()
        }
        enableEdgeToEdge()
        // Arranque en frío: primera actividad del proceso. Con un enlace se muestra la versión corta.
        if (savedInstanceState == null && container.splashPending) {
            container.splashPending = false
            val linked = intent?.action == Intent.ACTION_VIEW
            container.splashMode.value = if (linked) SplashChoreo.Mode.SHORT else SplashChoreo.Mode.FULL
        }
        // Tras una rotación el intent es el mismo: no se vuelve a abrir el enlace.
        if (savedInstanceState == null) handleIntent(intent)
        setContent { TieComsTheme { AppRoot() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        // Aviso de llamada a pantalla completa: se muestra sobre la pantalla bloqueada y la enciende.
        if (intent.getBooleanExtra(com.tiecoms.app.platform.CallService.EXTRA_RINGING, false) && android.os.Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true); setTurnScreenOn(true)
        }
        // Solo debug: `adb shell am start -n com.chaggu.app/com.tiecoms.app.MainActivity -e apiUrl http://10.0.2.2:3021`
        if (BuildConfig.DEBUG) intent.getStringExtra("apiUrl")?.let { container.setDebugApiUrl(it) }
        // Solo debug: simula el push TC_CALL a los 4 s (para ver el aviso con la app en segundo plano):
        // `am start -n com.chaggu.app/com.tiecoms.app.MainActivity --es debugPushCall <callId> --es debugConv <conversationId>`
        if (BuildConfig.DEBUG) intent.getStringExtra("debugPushCall")?.let { callId ->
            val conv = intent.getStringExtra("debugConv") ?: return@let
            android.os.Handler(mainLooper).postDelayed({
                com.tiecoms.app.platform.TcMessagingService.handle(applicationContext, mapOf("type" to "call", "callId" to callId, "conversationId" to conv,
                    "kind" to "audio", "title" to "Beto Prueba", "subtitle" to "Equipo comercial", "category" to "TC_CALL"))
            }, 4_000)
        }
        // «Compartir» desde otras apps llega a ShareActivity (SPEC-v4 §B), no aquí.
        if (intent.action == Intent.ACTION_VIEW) {
            val data = intent.dataString
            // chaggu://auth/callback es el retorno del SSO, no un destino de navegación.
            Sso.parseCallback(data)?.let { container.handleSsoCallback(it); return }
            // chaggu://meetings/connected: vuelta de «Conectar» Meet, Teams o Zoom (no es un destino de navegación).
            com.tiecoms.app.core.Meetings.parseReturn(data)?.let {
                intent.data = null // Do not retain the short-lived receipt in the activity Intent.
                container.handleMeetingReturn(it); return
            }
            // chaggu://mail/connected: vuelta de «Conectar» Gmail u Outlook (docs/CORREO.md).
            com.tiecoms.app.core.Mail.parseReturn(data)?.let {
                intent.data = null
                container.handleMailReturn(it); return
            }
            when (val link = DeepLinks.parse(data)) {
                null -> Unit
                // 1.7.4: enlace de invitado a una llamada: se abre encima de todo, con o sin sesión (en frío y en caliente).
                is DeepLink.GuestCall -> container.openGuestCall(link.token)
                else -> container.pendingLink.value = link
            }
        }
    }
}
