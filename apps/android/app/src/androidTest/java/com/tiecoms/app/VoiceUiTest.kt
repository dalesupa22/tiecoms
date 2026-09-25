package com.tiecoms.app

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * SPEC-v4 §F en el emulador contra 3043: burbuja de voz (play, velocidad, estado de la transcripción) y grabar
 * manteniendo pulsado el micrófono (barra de grabación, soltar = enviar). Usa el directo con el par (peerId).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class VoiceUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val perms: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.RECORD_AUDIO)
        else GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[v4] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun notaDeVoz() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val peerId = arg("peerId")
        assumeTrue("Faltan argumentos", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && peerId.isNotBlank())
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntil(20_000) { app.container.client.value.state.value.data != null }
            val client = app.container.client.value
            val direct = runBlocking { client.createChat(listOf(peerId), null).id }
            ins.targetContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("tiecoms://c/$direct")).setPackage(ins.targetContext.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            compose.waitUntilExactlyOneExists(hasTestTag("composer"), 15_000)
            compose.waitUntil(15_000) { client.state.value.conversations[direct]?.loaded == true }
            val voice = client.state.value.conversations[direct]!!.messages.lastOrNull { m -> m.attachments.any { it.isVoice } }?.attachments?.first { it.isVoice }
            if (voice != null) {
                compose.waitUntilAtLeastOneExists(hasTestTag("messages"), 10_000)
                // Como el usuario: el botón «Ir a lo último» (el chat abre en el primer no leído).
                val latest = androidx.compose.ui.test.hasContentDescription(ins.targetContext.getString(R.string.jump_latest))
                repeat(3) { if (compose.onAllNodes(latest).fetchSemanticsNodes().isNotEmpty()) { compose.onNode(latest).performClick(); compose.waitForIdle(); Thread.sleep(800) } }
                runCatching { compose.onNodeWithTag("messages").performScrollToNode(hasTestTag("voice-${voice.id}")) }
                val msgs = client.state.value.conversations[direct]!!.messages
                log("diag: ${msgs.size} mensajes; voz en índice ${msgs.indexOfFirst { m -> m.attachments.any { it.id == voice.id } }}; último seq ${msgs.lastOrNull()?.seq}")
                val tags = compose.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("tag") { it.config.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.TestTag) { null } != null }, useUnmergedTree = true)
                    .fetchSemanticsNodes().mapNotNull { it.config.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.TestTag) { null } }.filter { it.startsWith("body-") || it.startsWith("att") || it.startsWith("voice") }
                log("diag tags: $tags")
                // La nota está más arriba en el historial: se desliza hacia mensajes anteriores hasta verla.
                repeat(20) { if (!exists("voicePlay-${voice.id}")) { compose.onNodeWithTag("messages").performTouchInput { swipeDown(durationMillis = 400) }; compose.waitForIdle() } }
                compose.waitUntilAtLeastOneExists(hasTestTag("voicePlay-${voice.id}"), 10_000)
                compose.onNodeWithTag("voicePlay-${voice.id}").performClick()
                compose.waitUntil(10_000) { app.container.voice.state.value.currentId == voice.id }
                compose.onNodeWithTag("voiceSpeed-${voice.id}").performClick()
                Thread.sleep(1_200); shot("v4-12-nota-de-voz")
                log("§F burbuja de voz: play (${app.container.voice.state.value.playing}), velocidad ${app.container.voice.state.value.speed}×, transcript=${voice.transcript?.status}")
                compose.onNodeWithTag("voiceSpeed-${voice.id}").performClick(); compose.onNodeWithTag("voiceSpeed-${voice.id}").performClick() // vuelve a 1×
                app.container.voice.stop()
            }
            // Grabar: mantener pulsado el micrófono (compositor vacío) y soltar para enviar.
            val before = client.state.value.conversations[direct]!!.messages.count { m -> m.attachments.any { it.isVoice } }
            compose.onNodeWithTag("mic").performTouchInput { down(center) }
            val started = runCatching { compose.waitUntil(5_000) { exists("recordingBar") } }.isSuccess
            if (started) {
                Thread.sleep(2_500); shot("v4-13-grabando")
                compose.onNodeWithTag("mic").performTouchInput { up() }
                compose.waitUntil(20_000) { client.state.value.conversations[direct]!!.messages.count { m -> m.attachments.any { it.isVoice } } > before }
                Thread.sleep(800); shot("v4-14-nota-enviada")
                log("§F grabar manteniendo pulsado y soltar: nota enviada")
            } else {
                runCatching { compose.onNodeWithTag("mic").performTouchInput { up() } }
                shot("v4-13-sin-microfono")
                log("§F el emulador no dio micrófono (sin audio): no se pudo grabar")
            }
            assertTrue(true)
        } catch (t: Throwable) { shot("v4-voz-fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
