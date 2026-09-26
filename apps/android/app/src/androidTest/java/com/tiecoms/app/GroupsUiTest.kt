package com.tiecoms.app

import android.Manifest
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
import androidx.test.uiautomator.UiDevice
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

/**
 * Grupos, DMs, Nuevo grupo con enlace, Invitar a un grupo y Tú (docs/GRUPOS.md) contra el API de pruebas.
 * La persona debe tener al menos una relación con otra empresa y un sidechat (fixture de Grupos).
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3050 -e email … -e password … \
 *     -e class com.tiecoms.app.GroupsUiTest com.tiecoms.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class GroupsUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[grupos] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(ins)
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun gruposDmsYNuevoGrupo() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try { flow(email, password) } catch (t: Throwable) { shot("grupos-fallo"); throw t } finally { runCatching { scenario.close() } }
    }

    private fun flow(email: String, password: String) {
        compose.waitUntil(20_000) { exists("email") && !exists("splash") }
        compose.onNodeWithTag("email").performTextInput(email)
        compose.onNodeWithTag("password").performTextInput(password)
        compose.onNodeWithTag("login").performScrollTo().performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("newGroup"), 20_000)
        val client = app.container.client.value
        val data = client.state.value.data!!

        // Barra inferior: 5 pestañas fijas.
        listOf("tab-home", "tab-dms", "tab-issues", "tab-agenda", "tab-settings").forEach { assertTrue(it, exists(it)) }
        // Grupos: Relaciones y ningún sidechat, directo ni chat en el árbol.
        assertTrue("sección Relaciones", exists("section-RELATIONS"))
        data.conversations.filter { GroupsTree.isDm(data, it) }.forEach { assertFalse("DM fuera de Grupos: ${it.id}", exists("conv-${it.id}")) }
        Thread.sleep(600); shot("grupos-01-arbol")
        log("Grupos: secciones y sin DMs en el árbol")

        // DMs: los sidechats llevan su burbuja.
        compose.onNodeWithTag("tab-dms").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("dmList"), 10_000)
        data.conversations.firstOrNull { it.isSide }?.let { s -> compose.waitUntil(5_000) { exists("sideBadge-${s.id}") } }
        Thread.sleep(400); shot("grupos-02-dms")
        log("DMs: directos, chats y sidechats con «Sidechat»")

        // Nuevo grupo con otra empresa (relación existente) y enlace → pantalla de compartir → Listo abre el grupo.
        compose.onNodeWithTag("tab-home").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("newGroup"), 10_000)
        compose.onNodeWithTag("newGroup").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("forCompany"), 5_000)
        compose.onNodeWithTag("forCompany").performClick()
        val relation = GroupsTree.companyChoices(data).first { !it.pending }
        compose.onNodeWithTag("company-" + relation.id).performScrollTo().performClick()
        compose.onNodeWithTag("groupName").performScrollTo().performTextInput("Grupo de prueba UI")
        Thread.sleep(400); shot("grupos-03-nuevo-grupo")
        compose.onNodeWithTag("createGroup").performScrollTo().performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("inviteCode"), 15_000)
        Thread.sleep(400); shot("grupos-04-compartir")
        compose.onNodeWithTag("shareDone").performScrollTo().performClick()
        compose.waitUntilExactlyOneExists(hasTestTag("composer"), 15_000)
        // Dentro del chat: la barra de accesos (Fijados · Asuntos · Hilos · Agenda) y la lista de hilos.
        compose.waitUntilAtLeastOneExists(hasTestTag("chatBar"), 5_000)
        compose.onNodeWithTag("barThreads").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("barThreadsSheet"), 5_000)
        device.pressBack()
        compose.waitUntil(5_000) { !exists("barThreadsSheet") }
        val created = client.state.value.data!!.conversations.first { it.name == "Grupo de prueba UI" }
        assertEquals(relation.workspaces.first().id, created.workspaceId)
        log("Nuevo grupo en la relación con enlace: código, Listo abre el grupo")

        // Invitar a este grupo desde el menú de la fila → enlace y código.
        compose.onNodeWithTag("back").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("conv-${created.id}"), 10_000)
        compose.onNodeWithTag("conv-${created.id}").performTouchInput { longClick() }
        compose.waitUntilAtLeastOneExists(hasTestTag("menuInviteGroup"), 5_000)
        compose.onNodeWithTag("menuInviteGroup").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("inviteLink"), 5_000)
        compose.onNodeWithTag("inviteLink").performScrollTo().performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("inviteCode"), 15_000)
        compose.onNodeWithTag("shareDone").performScrollTo().performClick()
        log("Invitar a este grupo: enlace y código de varios usos")

        // Tú: Unirme con código.
        compose.onNodeWithTag("tab-settings").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("rowJoinCode"), 10_000)
        Thread.sleep(400); shot("grupos-05-tu")
        log("Tú: Unirme con código")
        device.pressBack()
    }
}
