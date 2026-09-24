package com.tiecoms.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.tiecoms.app.core.DeepLinks
import com.tiecoms.app.core.Sso
import com.tiecoms.app.ui.AppRoot
import com.tiecoms.app.ui.theme.TieComsTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
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
        // Solo debug: `adb shell am start -n com.tiecoms.app/.MainActivity -e apiUrl http://10.0.2.2:3021`
        if (BuildConfig.DEBUG) intent.getStringExtra("apiUrl")?.let { container.setDebugApiUrl(it) }
        if (intent.action == Intent.ACTION_VIEW) {
            val data = intent.dataString
            // tiecoms://auth/callback es el retorno del SSO, no un destino de navegación.
            Sso.parseCallback(data)?.let { container.handleSsoCallback(it); return }
            DeepLinks.parse(data)?.let { container.pendingLink.value = it }
        }
    }
}
