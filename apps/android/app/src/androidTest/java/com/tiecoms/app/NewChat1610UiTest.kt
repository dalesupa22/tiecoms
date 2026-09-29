package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 1.6.10 (29): «Mensaje nuevo» como WhatsApp/Slack. Marcar a dos personas (salen como chips), ponerle nombre y
 * «Crear chat (3)»; luego el 💬 de una fila abre su directo sin más pasos. Argumentos: apiUrl, email, password,
 * peerId y peer2Id (dos personas de mi lista).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class NewChat1610UiTest {
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
        File(ins.targetContext.getExternalFilesDir(null), "nuevo-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun marcarDosCrearChatYAbrirDirectoConElGlobo() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val peer = arg("peerId"); val peer2 = arg("peer2Id")
        assumeTrue("Faltan argumentos del fixture", listOf(apiUrl, email, password, peer, peer2).all { it.isNotBlank() })
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
            compose.waitForIdle(); Thread.sleep(500)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("tabs"), 20_000)
            val client = app.container.client.value
            compose.onNodeWithTag("tab-dms").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.compose"), 10_000)
            compose.onNodeWithTag("quick.compose").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("compose.tip"), 10_000)
            assertFalse("Ya no hay «Chat con varias personas»", exists("compose.multi"))
            assertTrue("Sin nadie: Cancelar y Grupo en un espacio", exists("newChat.cancel") && exists("newChat.space"))
            shot("01-mensaje-nuevo")

            // Marcar dos: chips arriba, nombre opcional y «Crear chat (3)».
            compose.onNodeWithTag("picker.person.$peer").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("picker.chip.$peer"), 5_000)
            shot("02-una-persona")
            compose.onNodeWithTag("picker.person.$peer2").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("picker.chip.$peer2"), 5_000)
            val name = "Equipo QA ${System.currentTimeMillis() % 10000}"
            compose.onNodeWithTag("newChat.name").performTextInput(name)
            shot("03-dos-personas")
            compose.onNodeWithTag("newChat.create").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
            compose.waitUntil(10_000) { client.state.value.data?.conversations?.any { it.name == name } == true }
            val created = client.state.value.data!!.conversations.first { it.name == name }
            assertEquals(setOf(peer, peer2), created.memberIds.toSet() - client.state.value.data!!.me.id)
            shot("04-chat-creado")

            // El 💬 abre el directo al instante.
            compose.onNodeWithTag("back").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.compose"), 10_000)
            compose.onNodeWithTag("quick.compose").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("picker.open.$peer"), 10_000)
            compose.onNodeWithTag("picker.open.$peer").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
            val direct = client.state.value.data!!.conversations.first { it.kind == "direct" && peer in it.memberIds }
            assertTrue(direct.memberIds.size == 2)
            shot("05-directo-con-globo")
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
