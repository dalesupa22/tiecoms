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
    /** Aviso nuevo con la burbuja ya abierta (onNewIntent): salta a ese mensaje y a su tema. */
    private val jump = androidx.compose.runtime.mutableStateOf<Pair<Long?, String?>?>(null)
    private val jumpKey = androidx.compose.runtime.mutableIntStateOf(0)

    override fun attachBaseContext(newBase: android.content.Context) { super.attachBaseContext(com.tiecoms.app.platform.AppLocale.wrap(newBase)) }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        val link = DeepLinks.parse(intent.dataString) as? DeepLink.Conversation ?: return
        if (link.seq == null && link.messageId == null) return
        jump.value = link.seq to link.messageId
        jumpKey.intValue++
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val link = DeepLinks.parse(intent?.dataString) as? DeepLink.Conversation ?: run { finish(); return }
        val id = link.id
        setContent {
            TieComsTheme {
                val client by container.client.collectAsStateWithLifecycle()
                val state by client.state.collectAsStateWithLifecycle()
                CompositionLocalProvider(LocalClient provides client, LocalContainer provides container) {
                    Surface(Modifier.fillMaxSize().dismissKeyboardOnOutsideInteraction(), color = MaterialTheme.colorScheme.background) {
                        if (state.status == SessionStatus.READY) ConversationScreen(
                            id = id, onBack = { finish() }, onDetails = {}, onOpenConversation = { _, _ -> },
                            onOpenIssue = {}, onOpenEvent = {}, onTrazo = {}, embedded = true,
                            // 1.7.5: abre en el mensaje del aviso y en su tema (antes quedaba en «General», sin la fila de temas).
                            jumpSeq = link.seq, jumpMessageId = link.messageId, jumpTopicId = link.topicId, bubble = true,
                            bubbleJump = jump.value, bubbleJumpKey = jumpKey.intValue,
                        )
                    }
                }
            }
        }
    }
}
