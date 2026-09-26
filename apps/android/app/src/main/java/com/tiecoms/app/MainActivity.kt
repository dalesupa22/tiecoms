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
        // Solo debug: `adb shell am start -n com.chaggu.app/com.tiecoms.app.MainActivity -e apiUrl http://10.0.2.2:3021`
        if (BuildConfig.DEBUG) intent.getStringExtra("apiUrl")?.let { container.setDebugApiUrl(it) }
        // «Compartir» desde otras apps llega a ShareActivity (SPEC-v4 §B), no aquí.
        if (intent.action == Intent.ACTION_VIEW) {
            val data = intent.dataString
            // chaggu://auth/callback es el retorno del SSO, no un destino de navegación.
            Sso.parseCallback(data)?.let { container.handleSsoCallback(it); return }
            DeepLinks.parse(data)?.let { container.pendingLink.value = it }
        }
    }
}
