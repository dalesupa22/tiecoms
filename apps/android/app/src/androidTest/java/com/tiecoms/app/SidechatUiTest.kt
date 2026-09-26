package com.tiecoms.app

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.tiecoms.app.core.ConnectionStatus
import com.tiecoms.app.core.MemorySecretStore
import com.tiecoms.app.core.MemoryStorage
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.platform.TcMessagingService
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/**
 * SPEC-v4 §G Sidechats en el emulador contra 3043. B es un segundo cliente dentro de la prueba (pregunta y responde).
 * En pantalla ancha (≥ 840 dp: `adb shell wm size 2560x1600; wm density 320`) captura el split con el conector; en
 * teléfono, la hoja, la burbuja minimizada y la notificación TC_SIDE.
 *
 *   … -e apiUrl http://10.0.2.2:3043 -e email <A> -e password … -e conversationId <grupo> -e peerId <B> -e peerEmail <B> -e prefix v5-phone
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class SidechatUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[v5] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(ins)
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = runCatching { compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)
    private fun waitText(t: String, ms: Long = 20_000) = compose.waitUntil(ms) {
        runCatching { compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)
    }

    @Test
    fun sidechat() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val group = arg("conversationId")
        val peerId = arg("peerId"); val peerEmail = arg("peerEmail"); val prefix = arg("prefix").ifBlank { "v5" }
        assumeTrue("Faltan argumentos", listOf(apiUrl, email, password, group, peerId, peerEmail).all { it.isNotBlank() })
        val wide = ins.targetContext.resources.configuration.screenWidthDp >= 840
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(30_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        // B: segundo cliente real dentro de la prueba.
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
            runBlocking {
                b.login(peerEmail, password)
                kotlinx.coroutines.withTimeout(20_000) { b.state.first { it.connection == ConnectionStatus.ONLINE } }
                b.openConversation(group)
            }
            val tag = UUID.randomUUID().toString().take(4)
            val anchor = "¿Quién firma el anexo del contrato? $tag"
            b.send(group, anchor)
            ins.targetContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("chaggu://c/$group")).setPackage(ins.targetContext.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            compose.waitUntilExactlyOneExists(hasTestTag("composer"), 20_000)
            waitText(anchor)
            Thread.sleep(800)

            // 1. Iniciar: menú del mensaje → «Preguntar en un sidechat»; el autor sugerido, la pregunta con foco.
            compose.onNode(hasText(anchor), useUnmergedTree = true).performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("menuSide"), 10_000)
            compose.onNodeWithTag("menuSide").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("sideSheet"), 10_000)
            if (!exists("sidePicked")) compose.onNodeWithTag("sideSuggest-$peerId").performClick()
            compose.onNodeWithTag("sideQuestion").performTextInput("¿Tú lo firmas o lo firma Laura? $tag")
            Thread.sleep(600); shot("01-iniciar")
            compose.onNodeWithTag("sideStart").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("sideHeader"), 20_000)
            val sideId = a.state.value.data!!.conversations.first { it.isSide && it.parentId == group && it.memberIds.contains(peerId) && it.lastMessageAt != null && (it.name ?: "").contains(tag) }.id
            log("§G iniciar: sidechat $sideId (${if (wide) "pantalla ancha" else "teléfono"})")

            // 2. B responde; en A aparecen las respuestas rápidas.
            runBlocking { b.loadBootstrap(); b.openConversation(sideId) }
            b.send(sideId, "Lo firmo yo el jueves, Laura está de viaje $tag")
            waitText("Lo firmo yo el jueves", 20_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("sideQuick"), 10_000)
            Thread.sleep(1_000)
            if (wide) {
                compose.waitUntilAtLeastOneExists(hasTestTag("sideConnector"), 5_000)
                shot("02b")
                log("§G split: chat 60 % + sidechat 40 % con conector curvo desde el ancla (halo) al panel")
            } else {
                shot("02b")
                log("§G teléfono: hoja con tarjeta del ancla, avatares, «Privado · solo ustedes 2», respuestas rápidas")
            }
            // Una sola persona más en el sidechat: «Responde a Beto en privado…».
            val first = com.tiecoms.app.core.Names.person(a.state.value.data, peerId)!!.name.substringBefore(' ')
            val ph = ins.targetContext.getString(R.string.side_placeholder, first)
            waitText(ph, 10_000)
            log("§G placeholder con una persona: «$ph»")
            compose.onNodeWithTag("quickCheck").performClick()
            compose.waitUntil(15_000) { a.state.value.conversations[sideId]?.messages?.any { it.body == ins.targetContext.getString(R.string.side_quick_check) } == true }
            log("§G respuesta rápida «Déjame reviso» enviada")

            if (!wide) {
                // 3. Minimizar a burbuja flotante y volver a abrir.
                compose.onNodeWithTag("sideMinimize").performClick()
                compose.waitUntilAtLeastOneExists(hasTestTag("sideBubble"), 10_000)
                Thread.sleep(800); shot("03-burbuja")
                compose.onNodeWithTag("sideBubble").performClick()
                compose.waitUntilAtLeastOneExists(hasTestTag("sideHeader"), 10_000)
                log("§G minimizar a burbuja (avatares + no leídos) y reabrir")
            }

            // 4. «Llevar al hilo» con resumen sugerido.
            compose.onNodeWithTag("sideMore").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("sideReturn"), 5_000)
            compose.onNodeWithTag("sideReturn").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("returnSource"), 30_000)
            Thread.sleep(600); shot("04-llevar-al-hilo")
            compose.onNodeWithTag("returnSend").performScrollTo().performClick()
            compose.waitUntil(20_000) { a.state.value.conversations[group]?.messages?.any { it.mergedFrom == sideId && it.mergedKind == "side" } == true }
            compose.waitUntil(10_000) { !exists("sideHeader") }
            waitText(ins.targetContext.getString(R.string.side_from_sidechat), 10_000)
            Thread.sleep(1_000); shot("05-desde-sidechat-chip")
            log("§G «Llevar al hilo»: resumen sugerido, publicado con «Desde un sidechat»; chip ✓ bajo el ancla")

            if (!wide) {
                // 5. Notificación TC_SIDE (Responder en línea) que abre el origen con el sidechat desplegado.
                device.pressHome()
                compose.waitUntil(5_000) { !app.container.foreground }
                TcMessagingService.handle(ins.targetContext, mapOf(
                    "type" to "side", "category" to "TC_SIDE", "title" to "💬 Sidechat de Beto", "subtitle" to "Sobre: «${anchor.take(40)}»",
                    "body" to "¿Me confirmas la hora? $tag", "badge" to "1", "conversationId" to sideId, "messageId" to UUID.randomUUID().toString(),
                    "authorId" to peerId, "authorName" to "Beto", "sideOfConversationId" to group, "sideOfExcerpt" to anchor.take(60),
                ))
                device.openNotification()
                device.wait(Until.hasObject(By.textContains("Me confirmas la hora")), 8_000)
                Thread.sleep(1_200); shot("06-notificacion")
                val n = device.findObject(By.textContains("Me confirmas la hora"))
                assertTrue("notificación TC_SIDE visible", n != null)
                n!!.click()
                compose.waitUntilAtLeastOneExists(hasTestTag("sideHeader"), 30_000)
                Thread.sleep(1_500); shot("07-abierto-desde-notificacion")
                log("§G notificación TC_SIDE → abre el chat de origen con el sidechat desplegado")
            }
        } catch (t: Throwable) { shot("fallo"); throw t } finally {
            runCatching { runBlocking { b.logout() } }
            runCatching { scenario.close() }
        }
    }
}
