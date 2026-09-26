package com.tiecoms.app

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import android.view.KeyEvent
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.UiDevice
import com.tiecoms.app.core.ConnectionStatus
import com.tiecoms.app.core.MemorySecretStore
import com.tiecoms.app.core.MemoryStorage
import com.tiecoms.app.core.Mentions
import com.tiecoms.app.core.Names
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.TieComsClient
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** SPEC-v4 §H en el emulador contra 3043: buscador al teclear @, token (se borra entero), resaltado, badge @, bandeja. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class MentionsUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[v6] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(ins)
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = runCatching { compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)
    private fun composerText() = compose.onNodeWithTag("composer").fetchSemanticsNode().config.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.EditableText) { null }?.text ?: ""

    @Test
    fun menciones() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val group = arg("conversationId")
        val peerId = arg("peerId"); val peerEmail = arg("peerEmail"); val prefix = arg("prefix").ifBlank { "v6" }
        assumeTrue("Faltan argumentos", listOf(apiUrl, email, password, group, peerId, peerEmail).all { it.isNotBlank() })
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(30_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val b = TieComsClient(apiUrl, "Emulador B", MemoryStorage(), MemorySecretStore(), app.container.okHttp)
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        fun shot(n: String) = com.tiecoms.app.shot("$prefix-$n")
        try {
            compose.waitUntil(30_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntil(30_000) { app.container.client.value.state.value.data != null }
            val a = app.container.client.value
            runBlocking { b.login(peerEmail, password); kotlinx.coroutines.withTimeout(20_000) { b.state.first { it.connection == ConnectionStatus.ONLINE } }; b.openConversation(group) }
            val peerName = Names.person(a.state.value.data, peerId)!!.name
            val tag = UUID.randomUUID().toString().take(4)

            // B menciona a A (con emoji): en Inicio aparece el badge @ y la pestaña Menciones cuenta.
            val aName = a.state.value.data!!.me.name
            val (bt, bm, _) = Mentions.insert("🙌 @", emptyList(), 3, 4, aName, a.myId!!)
            b.send(group, bt + "¿me ayudas con el anexo? $tag", mentions = bm)
            compose.waitUntil(20_000) { (a.meta(group)?.unreadMentions ?: 0) > 0 }
            compose.waitUntil(15_000) { exists("mentionBadge-$group") }
            Thread.sleep(800); shot("01-inicio-badge")
            log("§H Inicio: badge «@» (unreadMentions=${a.meta(group)?.unreadMentions}) y pestaña Menciones")

            // Bandeja.
            compose.onNodeWithTag("tab-MENTIONS").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mentionsInbox"), 10_000)
            compose.waitUntil(15_000) { runCatching { compose.onAllNodes(hasText("¿me ayudas con el anexo? $tag", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false) }
            Thread.sleep(600); shot("02-bandeja")
            log("§H bandeja «Menciones» con la nueva sin leer")

            // Abrir el mensaje: resaltado con fondo naranja y barra de acento (me mencionan a mí).
            val item = a.state.value.conversations[group]?.messages?.lastOrNull { it.body.contains(tag) }?.id
            if (item != null && exists("mentionItem-$item")) compose.onNodeWithTag("mentionItem-$item").performClick()
            else compose.onNode(hasText("¿me ayudas con el anexo? $tag", substring = true)).performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("composer"), 15_000)
            compose.waitUntil(10_000) { runCatching { compose.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("m") { n -> n.config.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.TestTag) { null }?.startsWith("mentionedMe-") == true }, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false) }
            Thread.sleep(800); shot("03-burbuja-me-mencionan")
            log("§H burbuja: mención en negrita con fondo naranja y barra de acento")

            // Escribir «@be» → buscador → elegir → token resaltado.
            compose.onNodeWithTag("composer").performTextInput("Claro, le digo a @" + peerName.take(2).lowercase())
            compose.waitUntilAtLeastOneExists(hasTestTag("mentionPicker"), 10_000)
            Thread.sleep(500); shot("04-buscador")
            compose.onNodeWithTag("mention-$peerId").performClick()
            compose.waitUntil(5_000) { composerText().contains("@$peerName ") }
            Thread.sleep(400); shot("05-token")
            // Un retroceso borra el espacio; el siguiente, el token entero.
            device.pressKeyCode(KeyEvent.KEYCODE_DEL); device.pressKeyCode(KeyEvent.KEYCODE_DEL)
            compose.waitUntil(5_000) { !composerText().contains("@") }
            assertEquals("Claro, le digo a ", composerText())
            log("§H un retroceso dentro del token lo borra entero")
            // Volver a mencionar y enviar.
            compose.onNodeWithTag("composer").performTextInput("@" + peerName.take(2).lowercase())
            compose.waitUntilAtLeastOneExists(hasTestTag("mention-$peerId"), 10_000)
            compose.onNodeWithTag("mention-$peerId").performClick()
            compose.onNodeWithTag("composer").performTextInput("gracias $tag")
            compose.onNodeWithTag("send").performClick()
            compose.waitUntil(15_000) { b.state.value.conversations[group]?.messages?.any { it.body.contains("gracias $tag") && it.mentions.any { m -> m.userId == peerId } } == true }
            Thread.sleep(800); shot("06-enviada")
            log("§H enviado con la mención: B la recibe con mentions=[B]")
            assertTrue(true)
        } catch (t: Throwable) { shot("fallo"); throw t } finally {
            runCatching { runBlocking { b.logout() } }; runCatching { scenario.close() }
        }
    }
}
