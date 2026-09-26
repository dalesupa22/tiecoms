package com.tiecoms.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.DeepLinks
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.ui.ConversationScreen
import com.tiecoms.app.ui.LocalClient
import com.tiecoms.app.ui.LocalContainer
import com.tiecoms.app.ui.dismissKeyboardOnOutsideInteraction
import com.tiecoms.app.ui.theme.TieComsTheme

/** Burbuja de conversación (Android 11+): el chat flotante que abre la notificación. */
class BubbleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = (DeepLinks.parse(intent?.dataString) as? DeepLink.Conversation)?.id ?: run { finish(); return }
        setContent {
            TieComsTheme {
                val client by container.client.collectAsStateWithLifecycle()
                val state by client.state.collectAsStateWithLifecycle()
                CompositionLocalProvider(LocalClient provides client, LocalContainer provides container) {
                    Surface(Modifier.fillMaxSize().dismissKeyboardOnOutsideInteraction(), color = MaterialTheme.colorScheme.background) {
                        if (state.status == SessionStatus.READY) ConversationScreen(
                            id = id, onBack = { finish() }, onDetails = {}, onOpenConversation = { _, _ -> },
                            onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}, embedded = true,
                        )
                    }
                }
            }
        }
    }
}
