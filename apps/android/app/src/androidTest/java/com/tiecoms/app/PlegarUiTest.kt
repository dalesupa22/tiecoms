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
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.GroupsTree
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
import java.time.LocalDate

/**
 * 1.6.1 contra el API de pruebas (fixture de scripts/mobile-fixture.mjs): asuntos plegados por defecto bajo el
 * grupo, el chip los despliega sin abrir el chat y se recuerda al volver a abrir la app; completar con pulsación
 * larga los saca al instante; Plegar todo / Expandir todo / todos los asuntos; y reacciones en el chat.
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3047 -e email … -e password … -e conversationId … \
 *     -e class com.tiecoms.app.PlegarUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class PlegarUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[plegar] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(700)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "plegar-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun asuntosPlegablesCompletarYReacciones() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val conv = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && conv.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        // Empieza sin preferencias de plegado de otra corrida.
        app.container.settings.collapsed = emptySet()
        var scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("newGroup"), 20_000)
            val client = app.container.client.value

            // Cinco asuntos en el grupo, uno vencido.
            val yesterday = LocalDate.now().minusDays(1).toString()
            val created = runBlocking {
                (1..5).map { n -> client.createIssue(conv, "Asunto UI $n", null, if (n == 1) yesterday else null, null) }
            }
            runBlocking { client.loadOpenIssues() }
            compose.waitUntilAtLeastOneExists(hasTestTag("issuesFold-$conv"), 10_000)
            assertTrue("vencidos en rojo", exists("issuesOverdue-$conv"))
            // Plegados por defecto: ninguna línea de asunto.
            created.forEach { assertFalse("plegado: ${it.id}", exists("groupIssue-${it.id}")) }
            shot("01-plegado")
            log("Asuntos plegados por defecto, chip ◆ 5 · 1!")

            // El chip despliega sin abrir el chat.
            compose.onNodeWithTag("issuesFold-$conv", useUnmergedTree = true).performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("moreIssues-$conv"), 5_000)
            assertFalse("no abrió el chat", exists("composer"))
            assertTrue(GroupsTree.issuesKey(conv) in app.container.settings.collapsed)
            shot("02-desplegado")
            log("El chip despliega hasta 3 y «+N asuntos» sin entrar al chat")

            // Se recuerda al volver a abrir la app.
            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntilAtLeastOneExists(hasTestTag("moreIssues-$conv"), 20_000)
            log("Desplegado persiste tras reabrir")

            // Completar con pulsación larga: sale al instante y baja el conteo.
            val first = GroupsTree.openIssues(client.state.value.issues.values, conv).first()
            compose.onNodeWithTag("groupIssue-${first.id}", useUnmergedTree = true).performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("issueActDone"), 5_000)
            shot("03-menu-asunto")
            compose.onNodeWithTag("issueActDone").performClick()
            compose.waitUntil(5_000) { !exists("groupIssue-${first.id}") }
            compose.waitUntil(10_000) { client.state.value.issues[first.id]?.status == "done" }
            assertEquals(4, GroupsTree.openIssues(client.state.value.issues.values, conv).size)
            shot("04-completado")
            log("Completar con pulsación larga: sale de Grupos y baja el conteo")

            // Menú ⋮: contraer todos los asuntos, plegar todo, expandir todo.
            compose.onNodeWithTag("groupsMenu").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("menuHideAllIssues"), 5_000)
            shot("05-menu-grupos")
            compose.onNodeWithTag("menuHideAllIssues").performClick()
            compose.waitUntil(5_000) { !exists("moreIssues-$conv") }
            compose.onNodeWithTag("groupsMenu").performClick()
            compose.onNodeWithTag("menuFoldAll").performClick()
            compose.waitUntil(5_000) { !exists("conv-$conv") }
            compose.onNodeWithTag("groupsMenu").performClick()
            compose.onNodeWithTag("menuExpandAll").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("moreIssues-$conv"), 5_000)
            log("Plegar todo / Expandir todo / Contraer todos los asuntos")

            // Reacciones: barra rápida al mantener el mensaje, chip, quitar y selector completo.
            compose.onNodeWithTag("conv-$conv").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
            compose.waitUntil(10_000) { client.state.value.conversations[conv]?.messages?.any { it.kind == "text" } == true }
            val m = client.state.value.conversations[conv]!!.messages.last { it.kind == "text" }
            compose.onNodeWithTag("msg-${m.seq}", useUnmergedTree = true).performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("quickReactions"), 5_000)
            assertTrue("👀 marcado con acción", exists("quickAction-👀"))
            shot("06-barra-rapida")
            compose.onNodeWithTag("quick-👍").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("reaction-${m.seq}-👍"), 5_000)
            compose.waitUntil(10_000) { client.state.value.conversations[conv]!!.messages.first { it.id == m.id }.reactions.any { it.emoji == "👍" && client.myId in it.userIds } }
            shot("07-chip")
            compose.onNodeWithTag("reaction-${m.seq}-👍", useUnmergedTree = true).performClick()
            compose.waitUntil(10_000) { !exists("reaction-${m.seq}-👍") }
            compose.onNodeWithTag("msg-${m.seq}", useUnmergedTree = true).performTouchInput { longClick() }
            compose.onNodeWithTag("quickMore").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("emojiPicker"), 5_000)
            shot("08-selector")
            compose.onNodeWithTag("pick-🎉").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("reaction-${m.seq}-🎉"), 10_000)
            shot("09-reaccion-selector")
            log("Reacciones: barra rápida, chip, quitar y selector")
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
