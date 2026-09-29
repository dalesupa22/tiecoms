package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
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
import com.tiecoms.app.core.DeepLink
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Temas con tres vistas (docs/TEMAS.md, web bae3d7f), contra el API LOCAL (nunca producción).
 * Fixture: scratchpad seed-correo-android.mjs (chat «Temas Xertify» con el tema «Ventas», un mensaje sin tema y uno de Ventas).
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3097 -e email … -e password … -e topicsChat … -e topicId … \
 *     -e class com.tiecoms.app.TemasGeneralUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class TemasGeneralUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shows(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(900)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "temas-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        Log.i("TieComsUiTest", "captura temas-$name")
    }

    private fun launchLoggedIn(): ActivityScenario<MainActivity> {
        assumeTrue("Faltan argumentos del fixture", arg("apiUrl").isNotBlank() && arg("email").isNotBlank() && arg("password").isNotBlank())
        assertFalse("Nunca contra producción", arg("apiUrl").contains("tiecoms.com") || arg("apiUrl").contains("chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(arg("apiUrl")) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        compose.waitUntil(20_000) { exists("email") && !exists("splash") }
        compose.onNodeWithTag("email").performTextInput(arg("email"))
        compose.onNodeWithTag("password").performTextInput(arg("password"))
        compose.onNodeWithTag("login").performScrollTo().performClick()
        compose.waitUntil(20_000) { exists("quick.create") }
        return scenario
    }

    @Test fun generalTodoYUnTema() {
        val scenario = launchLoggedIn()
        try {
            val conv = arg("topicsChat"); val topicId = arg("topicId")
            val client = app.container.client.value
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(conv) }
            compose.waitUntilAtLeastOneExists(hasTestTag("topicGeneral"), 20_000)
            compose.waitUntil(15_000) { shows("Mensaje sin tema de Laura") }
            // 1) Abre en «💬 General» (los no leídos están repartidos): solo lo sin tema.
            compose.onNodeWithTag("topicGeneral", useUnmergedTree = true).assertIsSelected()
            assertFalse("General no muestra lo de Ventas", shows("Mensaje de ventas de Laura"))
            shot("01-general")

            // 2) «☰ Todo»: todo, con su etiqueta.
            compose.onNodeWithTag("topicAll", useUnmergedTree = true).performClick()
            compose.waitUntil(5_000) { shows("Mensaje de ventas de Laura") }
            assertTrue(shows("Mensaje sin tema de Laura"))
            shot("02-todo")

            // 4) Lo escrito en Todo va sin tema.
            val inAll = "Escrito en Todo ${System.currentTimeMillis() % 100000}"
            compose.onNodeWithTag("composer").performTextInput(inAll)
            compose.onNodeWithTag("send").performClick()
            compose.waitUntil(15_000) { client.state.value.conversations[conv]?.messages?.any { it.body == inAll } == true }
            assertNull(client.state.value.conversations[conv]!!.messages.first { it.body == inAll }.topicId)

            // 3) Un tema: solo lo suyo; lo escrito ahí lleva ese tema («Mensaje en Ventas»).
            compose.onNodeWithTag("topic-Ventas", useUnmergedTree = true).performClick()
            compose.waitUntil(5_000) { !shows("Mensaje sin tema de Laura") }
            assertTrue(shows("Mensaje de ventas de Laura"))
            assertTrue("El campo dice «Mensaje en Ventas»", shows("Ventas"))
            val inTopic = "Escrito en Ventas ${System.currentTimeMillis() % 100000}"
            compose.onNodeWithTag("composer").performTextInput(inTopic)
            compose.onNodeWithTag("send").performClick()
            compose.waitUntil(15_000) { client.state.value.conversations[conv]?.messages?.any { it.body == inTopic } == true }
            assertEquals(topicId, client.state.value.conversations[conv]!!.messages.first { it.body == inTopic }.topicId)
            shot("03-ventas")

            // Tocar la misma banderita vuelve a General; lo escrito en General va sin tema.
            compose.onNodeWithTag("topic-Ventas", useUnmergedTree = true).performClick()
            compose.waitUntil(5_000) { shows("Mensaje sin tema de Laura") }
            compose.onNodeWithTag("topicGeneral", useUnmergedTree = true).assertIsSelected()
            assertFalse(shows(inTopic))
            val inGeneral = "Escrito en General ${System.currentTimeMillis() % 100000}"
            compose.onNodeWithTag("composer").performTextInput(inGeneral)
            compose.onNodeWithTag("send").performClick()
            compose.waitUntil(15_000) { client.state.value.conversations[conv]?.messages?.any { it.body == inGeneral } == true }
            assertNull(client.state.value.conversations[conv]!!.messages.first { it.body == inGeneral }.topicId)

            // 5) Saltar a un mensaje de Ventas (enlace ?m=) desde General cambia el filtro a Ventas…
            val ventasSeq = client.state.value.conversations[conv]!!.messages.first { it.body == "Mensaje de ventas de Laura" }.seq
            val plainSeq = client.state.value.conversations[conv]!!.messages.first { it.body == "Mensaje sin tema de Laura" }.seq
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(conv, ventasSeq) }
            compose.waitUntil(10_000) { runCatching { compose.onNodeWithTag("topic-Ventas", useUnmergedTree = true).assertIsSelected() }.isSuccess }
            compose.onNodeWithTag("topicGeneral", useUnmergedTree = true).assertIsNotSelected()
            shot("04-salto-a-ventas")
            // …y a uno sin tema, a General.
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(conv, plainSeq) }
            compose.waitUntil(10_000) { runCatching { compose.onNodeWithTag("topicGeneral", useUnmergedTree = true).assertIsSelected() }.isSuccess }
            // En Todo, saltar no cambia el filtro.
            compose.onNodeWithTag("topicAll", useUnmergedTree = true).performClick()
            compose.waitForIdle()
            ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(conv, ventasSeq) }
            Thread.sleep(2500); compose.waitForIdle()
            compose.onNodeWithTag("topicAll", useUnmergedTree = true).assertIsSelected()
            shot("05-salto-en-todo")
        } finally { scenario.close() }
    }
}
