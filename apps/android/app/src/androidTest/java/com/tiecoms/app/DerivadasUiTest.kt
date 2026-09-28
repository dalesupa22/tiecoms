package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
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
 * 1.6.4 (23), tareas derivadas contra el API de pruebas (docs/TAREAS.md; fixture con dos empresas):
 * «Tareas» en el detalle con «¿Quién la ve?» (por defecto solo mi empresa), la chapita ☑, las tareas bajo el
 * asunto en la lista del chat, «＋ Tarea derivada» y «💬 Hablar aparte» con la franja del sidechat.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class DerivadasUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[derivadas] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        compose.waitForIdle(); Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "derivadas-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun tareasDerivadas() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val conv = arg("conversationId"); val peer = arg("peerId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && conv.isNotBlank() && peer.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        app.container.settings.issueFilter = "open"
        app.container.settings.issueGroupBy = "group"
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            val client = app.container.client.value
            val me = client.state.value.data!!.me.id
            val parent = runBlocking { client.createIssue(conv, "Lanzar la campaña", me, null, null) }

            // Detalle → Tareas: «Revisar el copy» para mí, por defecto «Solo mi empresa».
            ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Issue(parent.id) }
            compose.waitUntilAtLeastOneExists(hasTestTag("tasksSection"),  15_000)
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("taskAddField"))
            compose.onNodeWithTag("taskAddField").performTextInput("Revisar el copy")
            compose.waitUntilAtLeastOneExists(hasTestTag("taskVis-org"),  5_000)
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("taskAddSubmit"))
            shot("01-alta-tarea")
            compose.onNodeWithTag("taskAddField").performImeAction()
            compose.waitUntil(10_000) { client.state.value.issues.values.any { it.parentIssueId == parent.id && it.title == "Revisar el copy" } }
            val t1 = client.state.value.issues.values.first { it.parentIssueId == parent.id && it.title == "Revisar el copy" }
            assertEquals("org", t1.visibility)
            // Otra para la persona de la otra empresa (queda para todo el chat si la elijo así).
            compose.onNodeWithTag("taskAddField").performTextInput("Aprobar el presupuesto")
            compose.waitUntilAtLeastOneExists(hasTestTag("taskOwner-$peer"),  5_000)
            compose.onNodeWithTag("taskOwner-$peer").performClick()
            compose.onNodeWithTag("taskVis-all").performClick()
            compose.onNodeWithTag("taskAddField").performImeAction()
            compose.waitUntil(10_000) { client.state.value.issues.values.any { it.parentIssueId == parent.id && it.ownerId == peer } }
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("tasksSection"))
            shot("02-detalle-con-tareas")
            log("Tareas en el detalle: por defecto solo mi empresa; otra para la empresa B, de todo el chat")

            // Detalle de la tarea: «↑ Parte de …» y ¿Quién la ve? (la creé yo).
            compose.onNodeWithTag("issue-${t1.id}").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issueParent"),  10_000)
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("taskVisibility"))
            shot("03-detalle-tarea")
            compose.onNodeWithTag("vis-private").performClick()
            compose.waitUntil(10_000) { client.state.value.issues[t1.id]?.visibility == "private" }
            compose.onNodeWithTag("back").performClick()
            compose.onNodeWithTag("back").performClick()
            log("Tarea: ↑ Parte de «Lanzar la campaña» y ¿Quién la ve? → Privada")

            // Lista del chat: el asunto con ☑ 0/2 y sus tareas debajo.
            compose.onNodeWithTag("tab-issues").performClick()
            compose.waitUntil(15_000) { exists("kids-${parent.id}") }
            assertTrue(exists("issue-${t1.id}"))
            shot("04-pestana-por-grupo")
            // Pulsación larga: «＋ Tarea derivada» y «💬 Hablar aparte».
            compose.onNodeWithTag("issue-${parent.id}").performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("issueActAddTask"),  5_000)
            assertTrue(exists("issueActSide"))
            shot("05-menu-asunto")
            compose.onNodeWithTag("issueActSide").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("sideFromIssue"),  5_000)
            compose.onNodeWithTag("sidePick-$peer").performClick()
            compose.onNodeWithTag("sideFirst").performTextInput("¿Lo vemos aparte?")
            shot("06-hablar-aparte")
            compose.onNodeWithTag("sideGo").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("sideIssueStrip"),  20_000)
            val side = client.state.value.data!!.conversations.first { it.sideIssueId == parent.id }
            shot("07-sidechat-franja")
            compose.onNodeWithTag("sideAddTask").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("tasksSheet"),  5_000)
            compose.onNodeWithTag("taskAddField").performTextInput("Mandar la cotización a B")
            compose.onNodeWithTag("taskAddField").performImeAction()
            compose.waitUntil(10_000) { client.state.value.issues.values.any { it.parentIssueId == parent.id && it.conversationId == side.id } }
            shot("08-tarea-en-sidechat")
            log("Hablar aparte: sidechat con la franja ◆ asunto · ☑ · ＋ Tarea, y una tarea creada ahí")
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
