package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.SleepMode
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/**
 * 1.6.9 (28): en iOS 1.6.8 la barra de pestañas quedó dentro del chat y tapaba el campo de escribir (Danny no pudo
 * escribirle a Alicia, que descansaba). Aquí: la barra solo existe en las 5–6 pestañas, nunca dentro de una conversación
 * ni en pantallas empujadas, y el aviso de descanso del destinatario es informativo: se escribe y se envía igual.
 * Argumentos: apiUrl, email, password y peerId (la persona que descansa ahora).
 * 1.7.0: además, con el aviso visible, la barra de búsqueda abierta y el teclado arriba, el campo y Enviar se ven y
 * se tocan; también con alguien en «No molestar» (peerDndId) y en un chat grupal (groupId).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class Barra169UiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        compose.waitForIdle(); Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "barra-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /**
     * Con la búsqueda abierta y el teclado arriba: el campo y ➤ se ven, quedan por encima del teclado y se envía.
     * Devuelve el texto enviado.
     */
    private fun composerUsable(conversationId: String, label: String): String {
        val client = app.container.client.value
        compose.onNodeWithTag("chatSearch").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("chatSearchBar"), 5_000)
        compose.onNodeWithTag("composer").performClick() // enfoca: sube el teclado
        compose.waitForIdle(); Thread.sleep(1200)
        val text = "$label ${System.currentTimeMillis() % 100000}"
        compose.onNodeWithTag("composer").performTextInput(text)
        compose.onNodeWithTag("composer").assertIsDisplayed()
        compose.onNodeWithTag("send").assertIsDisplayed()
        // Por encima del teclado: el borde inferior de ➤ no pasa del alto de la ventana menos el teclado.
        // Se espera hasta 5 s a que termine la animación del teclado (el inset llega antes que el nuevo tamaño).
        fun measure(): Triple<Float, Int, Int> {
            var imeBottom = 0; var rootH = 0
            ins.runOnMainSync {
                val root = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).first().window.decorView
                val insets = androidx.core.view.ViewCompat.getRootWindowInsets(root)
                imeBottom = insets?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())?.bottom ?: 0
                rootH = root.height
            }
            val density = ins.targetContext.resources.displayMetrics.density
            return Triple(compose.onNodeWithTag("send").getBoundsInRoot().bottom.value * density, rootH, imeBottom)
        }
        var m = measure()
        val until = System.currentTimeMillis() + 5_000
        while (m.first > m.second - m.third + 2 && System.currentTimeMillis() < until) { Thread.sleep(200); compose.waitForIdle(); m = measure() }
        val (sendBottomPx, rootH, imeBottom) = m
        assertTrue("➤ por encima del teclado (send=$sendBottomPx, alto=$rootH, teclado=$imeBottom)", sendBottomPx <= rootH - imeBottom + 2)
        shot("$label-teclado")
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(15_000) { client.state.value.conversations[conversationId]?.messages?.any { it.body == text } == true }
        compose.onNodeWithTag("chatSearchClose").performClick()
        return text
    }

    @Test
    fun barraFueraDelChatYEscribirAQuienDescansa() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val peer = arg("peerId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && peer.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
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
            compose.waitUntilAtLeastOneExists(hasTestTag("tabs"), 20_000)
            val client = app.container.client.value
            // En las pestañas sí hay barra, con las 5–6 pestañas.
            assertTrue(exists("tab-home")); assertTrue(exists("tab-dms")); assertTrue(exists("tab-settings"))
            shot("01-pestanas")

            // Directo con la persona que descansa: aviso informativo, sin barra, y se escribe y se envía.
            val direct = runBlocking { client.openDirect(peer) }
            runBlocking { client.loadBootstrap() }
            val w = SleepMode.of(client.state.value.data!!.people.first { it.id == peer }.sleep)
            assertTrue("La otra persona descansa ahora (el fixture lo prepara)", SleepMode.sleepingNow(w, Instant.now()))
            ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(direct) }
            compose.waitUntilAtLeastOneExists(hasTestTag("sleepNotice"), 15_000)
            compose.waitUntil(5_000) { !exists("tabs") }
            assertFalse("La barra de pestañas no va dentro del chat", exists("tabs"))
            val text = "Hola, te dejo esto para mañana ${System.currentTimeMillis() % 100000}"
            compose.onNodeWithTag("composer").performTextInput(text)
            shot("02-chat-descansa")
            compose.onNodeWithTag("send").performClick()
            compose.waitUntil(15_000) { client.state.value.conversations[direct]?.messages?.any { it.body == text } == true }
            // El eco en vivo puede llegar antes que la confirmación: se espera a que salga de la cola.
            compose.waitUntil(5_000) { client.state.value.pending.none { it.body == text } }
            assertTrue("Se envió aunque la otra persona descanse", client.state.value.pending.none { it.body == text })
            shot("03-enviado")

            // 1.7.0: aviso de descanso + búsqueda abierta + teclado: se ve y se toca el campo y ➤.
            composerUsable(direct, "descansa")

            // Alguien en «No molestar» (no solo sueño): mismo resultado.
            val dnd = arg("peerDndId")
            if (dnd.isNotBlank()) {
                val d2 = runBlocking { client.openDirect(dnd) }
                ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(d2) }
                compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
                compose.waitUntil(5_000) { !exists("tabs") }
                composerUsable(d2, "nomolestar")
            }
            // Un chat grupal (con alguien que descansa dentro).
            val group = arg("groupId")
            if (group.isNotBlank()) {
                ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(group) }
                compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
                compose.waitUntil(5_000) { !exists("tabs") }
                composerUsable(group, "grupo")
            }
            ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(direct) }
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)

            // Pantallas empujadas: detalles del chat, sin barra.
            compose.onNodeWithTag("details").performClick()
            compose.waitForIdle(); Thread.sleep(800)
            assertFalse("Sin barra en Detalles", exists("tabs"))
            compose.onNodeWithTag("back").performClick()
            compose.waitForIdle()
            // Un hilo / tarea / detalle de llamada son rutas empujadas: también sin barra.
            ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.CallDetail("00000000-0000-0000-0000-000000000000") }
            compose.waitForIdle(); Thread.sleep(1500)
            assertFalse("Sin barra en el detalle de una llamada", exists("tabs"))
            ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Issue("00000000-0000-0000-0000-000000000000") }
            compose.waitForIdle(); Thread.sleep(1500)
            assertFalse("Sin barra en una tarea", exists("tabs"))
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
