package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.click
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.IssueTasks
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
 * 1.6.4 (22), asuntos como tareas contra el API de pruebas (fixture de scripts/mobile-fixture.mjs, dos empresas):
 * pestaña con filtros y «Por responsable», alta rápida con la acción del teclado, círculo con «Deshacer», menú de
 * pulsación larga, detalle «a prueba de tontos» (¿quién?, ¿para cuándo?, ¿cómo va?, título, novedades, hecho,
 * reabrir y descartar), lista del chat con «Completados · N» y el círculo en el Árbol de Grupos.
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3047 -e email … -e password … -e conversationId … \
 *     -e class com.tiecoms.app.TareasUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class TareasUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[tareas] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun str(id: Int, vararg a: Any) = app.getString(id, *a)
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun hasTextNow(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "tareas-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun asuntosComoTareas() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val conv = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && conv.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        app.container.settings.issueFilter = "mine"
        app.container.settings.issueGroupBy = "group"
        app.container.settings.groupsView = "tree"
        app.container.settings.collapsed = emptySet()
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            val client = app.container.client.value
            val data = client.state.value.data!!
            val me = data.me.id
            val peer = data.conversations.first { it.id == conv }.memberIds.first { it != me }
            val peerOrg = data.people.first { it.id == peer }.orgId!!
            val today = IssueTasks.localToday()

            val overdue = runBlocking { client.createIssue(conv, "Enviar la cotización", me, today.minusDays(2).toString(), null) }
            val forPeer = runBlocking { client.createIssue(conv, "Revisar el contrato", peer, null, null) }
            val done = runBlocking { client.createIssue(conv, "Agendar la demo", me, null, null) }
            runBlocking { client.setIssueStatus(done.id, "done") }

            // Pestaña Asuntos: Míos, alta rápida con la acción del teclado.
            compose.onNodeWithTag("tab-issues").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issue-${overdue.id}"), 15_000)
            assertFalse("Míos no trae lo de otro", exists("issue-${forPeer.id}"))
            assertFalse("Míos no trae completados", exists("issue-${done.id}"))
            compose.onNodeWithTag("issueQuickAdd").performTextInput("Llamar al proveedor")
            compose.waitUntilAtLeastOneExists(hasTestTag("issueQuickOwner"), 5_000)
            assertTrue("fecha al escribir", exists("issueQuickDue"))
            shot("01-alta-rapida")
            compose.onNodeWithTag("issueQuickAdd").performImeAction()
            compose.waitUntil(10_000) { client.state.value.issues.values.any { it.title == "Llamar al proveedor" && it.ownerId == me } }
            compose.waitUntil(5_000) { !exists("issueQuickOwner") } // el campo quedó vacío y listo
            shot("01b-listo-para-el-siguiente")
            androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack() // cierra el teclado
            log("Alta rápida: Enter crea con Yo como responsable y el campo queda vacío")

            // Círculo: completa con «Deshacer».
            compose.onNodeWithTag("issueCheck-${overdue.id}", useUnmergedTree = true).performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.status == "done" }
            compose.waitUntil(5_000) { hasTextNow(str(R.string.issue_completed)) }
            shot("02-completado-deshacer")
            compose.onNodeWithText(str(R.string.undo)).performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.status == "open" }
            log("Círculo: completar y Deshacer")

            // Por responsable: yo primero.
            compose.onNodeWithText(str(R.string.issue_all_open), substring = true).performClick()
            compose.onNodeWithText(str(R.string.issue_by_person)).performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issueSection-$me"), 5_000)
            compose.onNodeWithTag("issues").performScrollToNode(hasTestTag("issueSection-$peer"))
            assertEquals("person", app.container.settings.issueGroupBy)
            compose.onNodeWithTag("issues").performScrollToNode(hasTestTag("issueSection-$me"))
            shot("03-por-responsable")
            log("Abiertos por responsable, recordado en preferencias")

            // Pulsación larga: Marcar en curso.
            compose.onNodeWithTag("issues").performScrollToNode(hasTestTag("issue-${forPeer.id}"))
            compose.onNodeWithTag("issue-${forPeer.id}").performTouchInput { longClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("issueActInProgress"), 5_000)
            assertTrue(exists("issueActMarkOpen").not())
            compose.onNodeWithTag("issueActInProgress").performClick()
            compose.waitUntil(8_000) { client.state.value.issues[forPeer.id]?.status == "in_progress" }
            log("Menú: Marcar en curso")

            // Detalle: aviso de vencido, preguntas de un toque.
            compose.onNodeWithTag("issues").performScrollToNode(hasTestTag("issue-${overdue.id}"))
            compose.onNodeWithTag("issue-${overdue.id}").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issueMarkDone"), 10_000)
            assertTrue("aviso de vencido", exists("issueAlert"))
            shot("04-detalle-abierto")
            compose.onNodeWithTag("owner-$peer").performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.ownerId == peer }
            compose.onNodeWithTag("due-TOMORROW").performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.dueDate == today.plusDays(1).toString() }
            compose.waitUntil(5_000) { !exists("issueAlert") }
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("how-waiting"))
            compose.onNodeWithTag("how-waiting").performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.status == "waiting" }
            compose.waitUntilAtLeastOneExists(hasTestTag("waitOn-$peerOrg"), 5_000)
            compose.onNodeWithTag("waitOn-$peerOrg").performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.waitingOnOrgId == peerOrg }
            shot("05-detalle-esperando")
            log("Detalle: ¿quién?, ¿para cuándo? (Mañana) y ¿cómo va? (Esperando a la empresa B)")

            // Título editable y novedades.
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("issueTitleEdit"))
            compose.onNodeWithTag("issueTitleEdit").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issueTitleField"), 5_000)
            compose.onNodeWithTag("issueTitleField").performTextClearance()
            compose.onNodeWithTag("issueTitleField").performTextInput("Enviar la cotización firmada")
            compose.onNodeWithTag("issueTitleField").performImeAction()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.title == "Enviar la cotización firmada" }
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("issueComment"))
            compose.onNodeWithTag("issueComment").performTextInput("La mando mañana temprano")
            compose.onNodeWithTag("issueCommentSend").performClick()
            compose.waitUntil(10_000) { client.state.value.issues[overdue.id]?.commentCount == 1 }
            compose.waitUntil(8_000) { hasTextNow("La mando mañana temprano") }
            log("Título editado con ✎ y comentario en Novedades")

            // Marcar como hecho → banner y Reabrir.
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("issueMarkDone"))
            compose.onNodeWithTag("issueMarkDone").performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.status == "done" }
            compose.waitUntilAtLeastOneExists(hasTestTag("issueDoneBanner"), 5_000)
            shot("06-detalle-hecho")
            compose.onNodeWithTag("issueReopen").performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.status == "open" }
            // Descartar con Deshacer (antes se espera a que el aviso «Asunto reabierto» deje libre el pie).
            compose.waitUntil(10_000) { !hasTextNow(str(R.string.issue_reopened_toast)) }
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("issueDrop"))
            compose.onNodeWithTag("issueDrop").performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.status == "cancelled" }
            compose.waitUntil(5_000) { hasTextNow(str(R.string.issue_dropped_toast)) }
            compose.onNodeWithText(str(R.string.undo)).performClick()
            compose.waitUntil(8_000) { client.state.value.issues[overdue.id]?.status == "open" }
            compose.onNodeWithTag("issueDetail").performScrollToNode(hasTestTag("issueHistoryToggle"))
            compose.onNodeWithTag("issueHistoryToggle").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issueEvent-status"), 5_000)
            shot("07-detalle-cambios")
            log("Hecho → banner → Reabrir; Descartar con Deshacer; Ver cambios")
            compose.onNodeWithTag("back").performClick()

            // Árbol de Grupos: círculo y primer nombre del responsable si no soy yo.
            compose.onNodeWithTag("tab-home").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issuesFold-$conv"), 15_000)
            compose.onNodeWithTag("issuesFold-$conv", useUnmergedTree = true).performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("groupIssue-${forPeer.id}"), 5_000)
            assertTrue("círculo en el árbol", exists("issueCheck-${forPeer.id}"))
            assertTrue("primer nombre del responsable", exists("groupIssueOwner-${forPeer.id}"))
            val mineNew = client.state.value.issues.values.first { it.title == "Llamar al proveedor" }
            assertTrue(exists("groupIssue-${mineNew.id}"))
            assertFalse("no se muestra mi nombre", exists("groupIssueOwner-${mineNew.id}"))
            shot("08-arbol")
            log("Árbol: círculo y primer nombre del responsable")

            // Lista del chat: activos por urgencia y «Completados · N».
            compose.onNodeWithTag("conv-$conv").performTouchInput { click(androidx.compose.ui.geometry.Offset(width * 0.3f, height * 0.3f)) }
            compose.waitUntilAtLeastOneExists(hasTestTag("barIssues"), 15_000)
            compose.onNodeWithTag("barIssues").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("conversationIssues"), 5_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("issuesDoneToggle"), 10_000)
            assertFalse("completados plegados", exists("issue-${done.id}"))
            compose.onNodeWithTag("issuesDoneToggle").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("issue-${done.id}"), 5_000)
            shot("09-lista-chat")
            // Alta rápida dentro del chat y círculo con Deshacer dentro de la hoja.
            compose.onNodeWithTag("issueQuickAdd").performTextInput("Pedir la factura")
            compose.onNodeWithTag("issueQuickAdd").performImeAction()
            compose.waitUntil(10_000) { client.state.value.issues.values.any { it.title == "Pedir la factura" && it.conversationId == conv } }
            compose.onNodeWithTag("issueCheck-${done.id}", useUnmergedTree = true).performClick()
            compose.waitUntil(8_000) { client.state.value.issues[done.id]?.status == "open" }
            compose.waitUntil(5_000) { hasTextNow(str(R.string.issue_reopened_toast)) }
            shot("10-lista-chat-reabierto")
            log("Lista del chat: alta rápida, Completados plegables y reabrir con aviso en la hoja")
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
