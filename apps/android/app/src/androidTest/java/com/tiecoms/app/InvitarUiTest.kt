package com.tiecoms.app

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import android.view.KeyEvent
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.core.AppLanguage
import com.tiecoms.app.core.InviteLinkCache
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.platform.AppLocale
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
 * SPEC-invitar (1.6.4 build 21) contra un API de pruebas con el fixture de invitar (Ana y su colega Carla de Acme,
 * Beto de Beta en la relación, el grupo «Pedidos» con Dora como tercera): «Agregar al grupo» con buscador, fila
 * «Invitar a {correo}», tipos de persona, «Copiar enlace» (reutilizado), pendientes con Anular, sumar con
 * historial, en inglés y, como Dora, «Solo los miembros pueden invitar».
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3073 -e email … -e password … -e conversationId … \
 *     -e betoId … -e carlaId … -e guestEmail … -e tag … -e class com.tiecoms.app.InvitarUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class InvitarUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[invitar] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun hasLabel(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun waitTag(tag: String, ms: Long = 10_000) = compose.waitUntil(ms) { exists(tag) }
    private fun back() { ins.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); Thread.sleep(500) }
    private fun hideKeyboard() { ins.uiAutomation.executeShellCommand("input keyevent 111").close(); Thread.sleep(400) }
    private fun shot(name: String) {
        Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "invitar-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun clip(): String {
        var s = ""
        ins.runOnMainSync { s = (app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString().orEmpty() }
        return s
    }
    /** Baja la lista hasta una etiqueta. */
    private fun scrollTo(tag: String) { compose.onNodeWithTag("addList").performScrollToNode(hasTestTag(tag)); Thread.sleep(300) }

    private fun login(email: String, password: String, lang: AppLanguage): ActivityScenario<MainActivity> {
        ins.runOnMainSync { AppLocale.set(app, lang); app.container.setDebugApiUrl(arg("apiUrl")) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        app.container.settings.groupsView = "list"
        app.container.settings.homeTab = "ALL"
        app.container.settings.soundsEnabled = false
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        compose.waitUntil(20_000) { exists("email") && !exists("splash") }
        compose.onNodeWithTag("email").performTextInput(email)
        compose.onNodeWithTag("password").performTextInput(password)
        compose.onNodeWithTag("login").performScrollTo().performClick()
        waitTag("quick.create", 30_000)
        return scenario
    }

    /** Del inicio al grupo › Detalles › «＋ Agregar al grupo». */
    private fun openAdd(conv: String) {
        waitTag("conv-$conv", 15_000)
        compose.onNodeWithTag("conv-$conv").performClick()
        waitTag("details", 15_000)
        compose.onNodeWithTag("details").performClick()
        waitTag("addPeople", 10_000)
        compose.onNodeWithTag("addPeople").performScrollTo().performClick()
        waitTag("addSearch", 10_000)
    }

    @Test
    fun agregarEInvitar() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val conv = arg("conversationId")
        val beto = arg("betoId"); val carla = arg("carlaId"); val tag = arg("tag")
        assumeTrue("Faltan argumentos del fixture", listOf(apiUrl, email, password, conv, beto, carla, tag).all { it.isNotBlank() })
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        val langBefore = AppLocale.current(app)
        InviteLinkCache.clear()
        var scenario = login(email, password, AppLanguage.ES)
        try {
            val client = app.container.client.value
            openAdd(conv)
            // 1) Candidatos: Beto (de la relación) y Carla (colega que aún no está en el espacio); tipo por defecto, la contraparte.
            waitTag("person-$beto"); waitTag("person-$carla")
            assertTrue(hasLabel("Beta Logística $tag") && hasLabel("Acme $tag"))
            scrollTo("inviteNew")
            assertTrue(exists("inviteKind.mine:${client.state.value.data!!.me.primaryOrgId}") && exists("inviteKind.guest"))
            assertTrue("Relación: por defecto «De Beta»", hasLabel("Entra a este grupo como persona de Beta Logística $tag"))
            shot("01-agregar-al-grupo")
            log("Candidatos y «Invitar a alguien nuevo» con la contraparte por defecto")

            // 2) Buscador sin tildes ni mayúsculas.
            compose.onNodeWithTag("addSearch").performTextInput("BETO pena")
            compose.waitUntil(5_000) { exists("person-$beto") && !exists("person-$carla") }
            hideKeyboard()
            shot("02-buscador")

            // 3) Correo que no es de nadie: fila «✉ Invitar a …», Enviar invitación → Pendiente.
            val nuevo = "nuevo.$tag@qa.chaggu.test"
            compose.onNodeWithTag("addSearch").performTextClearance()
            compose.onNodeWithTag("addSearch").performTextInput(nuevo)
            waitTag("emailInviteRow", 5_000)
            assertTrue(hasLabel("Invitar a $nuevo"))
            hideKeyboard()
            shot("03-fila-invitar-correo")
            compose.onNodeWithTag("emailInviteSend").performClick()
            waitTag("emailInviteSent", 15_000)
            assertTrue(exists("pendingTag"))
            shot("04-invitacion-enviada-pendiente")
            log("Invitación por correo a $nuevo: Pendiente")

            // 4) Copiar enlace como tercero: «Enlace copiado · vence el …», código y texto de compartir; se reutiliza.
            compose.onNodeWithTag("addSearch").performTextClearance()
            hideKeyboard()
            scrollTo("inviteNew")
            compose.onNodeWithTag("inviteKind.guest").performClick()
            compose.onNodeWithTag("inviteCopyLink").performClick()
            waitTag("linkCopied", 15_000)
            val first = clip()
            assertTrue(first, first.startsWith("Te invito a Pedidos $tag en Chaggu: ") && Regex("\\(código [A-Z0-9]{4}-[A-Z0-9]{4}\\)$").containsMatchIn(first))
            assertTrue(hasLabel("Enlace copiado · vence el"))
            scrollTo("linkCopied")
            hideKeyboard(); shot("05-enlace-copiado")
            compose.onNodeWithTag("inviteKind.guest").performClick() // mismo tipo: sigue el mismo enlace
            compose.onNodeWithTag("inviteCopyLink").performClick()
            waitTag("linkCopied", 10_000)
            assertEquals("reutiliza el enlace vigente", first, clip())
            log("Copiar enlace (tercero): $first")

            // 5) «De mi empresa»: enlace de la empresa que además lleva al grupo.
            val mine = "mine:${client.state.value.data!!.me.primaryOrgId}"
            scrollTo("inviteKind")
            compose.onNodeWithTag("inviteKind.$mine", useUnmergedTree = true).performClick()
            try { compose.waitUntil(5_000) { hasLabel("Entra a Acme $tag y a este grupo.") } } catch (e: Throwable) { shot("fallo-mi-empresa"); throw e }
            compose.onNodeWithTag("inviteCopyLink").performClick()
            waitTag("linkCopied", 15_000)
            val org = clip()
            assertTrue(org, org.startsWith("Te invito a Pedidos $tag en Chaggu: ") && org != first)
            scrollTo("linkCopied")
            hideKeyboard(); shot("06-enlace-de-mi-empresa")
            log("Copiar enlace (De mi empresa): $org")

            // 6) Pendientes: plegadas; al abrir, el correo con Reenviar y Anular. Anular lo quita.
            scrollTo("pendingToggle")
            assertTrue(hasLabel("Invitaciones pendientes (1)"))
            compose.onNodeWithTag("pendingToggle").performClick()
            compose.waitUntil(5_000) { hasLabel(nuevo) }
            scrollTo("pendingSection")
            hideKeyboard(); shot("07-pendientes")
            val pend = runBlocking { client.pendingInvitations("workspaces", client.meta(conv)!!.workspaceId!!) }.first { it.email == nuevo }
            assertEquals(listOf(conv), pend.conversationIds)
            compose.onNodeWithTag("pendingRevoke-${pend.id}").performClick()
            compose.waitUntil(10_000) { !exists("pending-${pend.id}") }
            log("Pendiente de $nuevo anulada")

            // 7) Sumar a Beto y Carla con historial.
            scrollTo("person-$beto"); compose.onNodeWithTag("person-$beto").performClick()
            scrollTo("person-$carla"); compose.onNodeWithTag("person-$carla").performClick()
            compose.onNodeWithTag("historyAll").performClick()
            assertTrue(hasLabel("Agregar (2)"))
            shot("08-agregar-dos-con-historial")
            compose.onNodeWithTag("addMembersConfirm").performClick()
            compose.waitUntil(15_000) { client.meta(conv)?.memberIds?.containsAll(listOf(beto, carla)) == true }
            log("Beto y Carla sumados (Carla entra al espacio como gente de Acme)")
            back(); back()

            // 8) En inglés: ya no hay candidatos; directo a invitar.
            ins.runOnMainSync { AppLocale.set(app, AppLanguage.EN) }
            Thread.sleep(1_500)
            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            waitTag("quick.create", 30_000)
            openAdd(conv)
            waitTag("inviteNew")
            assertFalse(exists("addMembersConfirm"))
            assertTrue(hasLabel("Invite someone new") && hasLabel("Copy link") && hasLabel("Invite by email") && hasLabel("Guest (advisor, mentor, client…)"))
            compose.onNodeWithTag("addSearch").performTextInput("someone.$tag@qa.chaggu.test")
            waitTag("emailInviteRow", 5_000)
            hideKeyboard()
            shot("09-en-sin-candidatos")
            log("En inglés, sin candidatos: directo a invitar")
        } finally {
            scenario.close()
            ins.runOnMainSync { AppLocale.set(app, langBefore) }
        }
    }

    /** Dora es tercera en la relación: ve a quién sumar, pero no invita. */
    @Test
    fun terceroNoInvita() {
        val apiUrl = arg("apiUrl"); val guest = arg("guestEmail"); val password = arg("password"); val conv = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", listOf(apiUrl, guest, password, conv).all { it.isNotBlank() })
        assertFalse(apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        val langBefore = AppLocale.current(app)
        val scenario = login(guest, password, AppLanguage.ES)
        try {
            val meta = app.container.client.value.meta(conv)
            // Un tercero puede no tener «Agregar» (solo quien puede publicar): entonces no hay nada que probar aquí.
            waitTag("conv-$conv", 15_000)
            compose.onNodeWithTag("conv-$conv").performClick()
            waitTag("details", 15_000)
            compose.onNodeWithTag("details").performClick()
            Thread.sleep(1_000)
            assumeTrue("El tercero no ve «Agregar» (canPost=${meta?.canPost})", exists("addPeople"))
            compose.onNodeWithTag("addPeople").performScrollTo().performClick()
            waitTag("addSearch")
            scrollTo("inviteNew")
            waitTag("membersOnly")
            assertTrue(hasLabel("Solo los miembros pueden invitar"))
            assertFalse(exists("inviteCopyLink") || exists("inviteByEmail"))
            shot("10-tercero-solo-miembros")
            log("Tercero: «Solo los miembros pueden invitar»")
        } finally {
            scenario.close()
            ins.runOnMainSync { AppLocale.set(app, langBefore) }
        }
    }
}
