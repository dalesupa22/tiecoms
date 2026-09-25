package com.tiecoms.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.platform.ShareIntake
import com.tiecoms.app.ui.LocalClient
import com.tiecoms.app.ui.LocalContainer
import com.tiecoms.app.ui.ShareSheet
import com.tiecoms.app.ui.theme.TieComsTheme

/**
 * Destino de «Compartir» del sistema (SPEC-v4 §B): ACTION_SEND / ACTION_SEND_MULTIPLE de fotos, videos, archivos y
 * texto, y los atajos de Direct Share (EXTRA_SHORTCUT_ID = conversación preseleccionada).
 */
class ShareActivity : ComponentActivity() {
    private var incoming by mutableStateOf<ShareIntake.Incoming?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        incoming = ShareIntake.read(intent, referrer?.host)
        setContent {
            TieComsTheme {
                val client by container.client.collectAsStateWithLifecycle()
                CompositionLocalProvider(LocalClient provides client, LocalContainer provides container) {
                    ShareSheet(incoming, onClose = { finish() }, onOpenApp = {
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        finish()
                    })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        incoming = ShareIntake.read(intent, referrer?.host)
    }
}
