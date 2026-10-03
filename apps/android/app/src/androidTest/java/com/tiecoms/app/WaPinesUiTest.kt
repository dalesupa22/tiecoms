package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 2-oct-2026: tocar un chat de WhatsApp abre los mensajes, cabecera compacta, «💼 Solo trabajo» y los dos pines
 * (pantalla principal y WhatsApp) más los del correo, con su efecto visible. Fixture: tools/fixtures/wa-pins-fixture.mts.
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3099 -e email … -e password … -e personal <id> \
 *     -e class com.tiecoms.app.WaPinesUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class WaPinesUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()
    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun waitTag(tag: String, ms: Long = 20_000) = compose.waitUntil(ms) { exists(tag) }
    private fun tap(tag: String) { waitTag(tag); compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).onFirst().performClick() }
    private fun shot(name: String) {
        Thread.sleep(900)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "wapines-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun top(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).getBoundsInRoot().top

    @Test fun abrirCabeceraYPines() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        val work = "120363001@g.us"; val family = "120363002@g.us"
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl); app.container.settings.waWorkOnly = false; com.tiecoms.app.ui.WaWorkOnly.value = false }
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
            waitTag("quick.create")

            // 1) Cabecera compacta: buscador, «● 2 cuentas conectadas ›», categorías y Grupos/Todos; sin textos ni tarjetas.
            ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Screen(com.tiecoms.app.core.DeepLinks.SCREEN_WHATSAPP) }
            waitTag("waAccountsLine"); waitTag("waChat-$work")
            assertTrue(exists("waSearch")); assertTrue(exists("waCats")); assertTrue(exists("waWorkOnly"))
            assertFalse("sin explicación con cuentas", exists("waIntro"))
            assertFalse("sin tarjetas de cuenta arriba", exists("waAccountsSheet"))
            assertTrue("punto de color con 2 cuentas", exists("waAccDot-$work"))
            assertTrue("el buscador va arriba", top("waSearch") < top("waAccountsLine") && top("waAccountsLine") < top("waChat-$work"))
            shot("1-cabecera")
            tap("waAccountsLine"); waitTag("waAccountsSheet"); shot("2-cuentas")
            ins.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); Thread.sleep(800)

            // 2) Tocar un chat abre la conversación con su compositor (no un menú ni una hoja de ajustes).
            tap("waChat-$work")
            waitTag("waMessages")
            compose.waitUntilAtLeastOneExists(hasText("Hola equipo, ¿revisamos el lanzamiento?"), 10_000)
            assertFalse("sin menú ni hoja", exists("contextMenu") || exists("waChatSheet"))
            waitTag("waReadOnly"); tap("waEnableReply"); waitTag("waComposer")
            compose.onNodeWithTag("waComposer").performTextInput("Listo, voy")
            shot("3-conversacion")

            // 3) ⋯ de la conversación: «📌 Fijar en la pantalla principal».
            tap("waConvMenu"); waitTag("waPinMain"); shot("4-menu-conversacion"); tap("waPinMain")
            Thread.sleep(1500)
            tap("back")

            // 4) Pulsación larga en Familia › «📌 Fijar en WhatsApp»: sube arriba con 📌.
            waitTag("waChat-$family")
            compose.onNodeWithTag("waChat-$family", useUnmergedTree = true).performTouchInput { longClick() }
            waitTag("waPinWa"); shot("5-menu-fila"); tap("waPinWa")
            waitTag("waPinned-$family", 10_000)
            compose.waitUntil(10_000) { top("waChat-$family") < top("waChat-$work") }
            shot("6-fijado-whatsapp")

            // 5) «💼 Solo trabajo»: Familia desaparece, Equipo queda.
            tap("waWorkOnly")
            compose.waitUntil(10_000) { !exists("waChat-$family") }
            assertTrue(exists("waChat-$work")); assertTrue(app.container.settings.waWorkOnly)
            shot("7-solo-trabajo")
            tap("waWorkOnly"); waitTag("waChat-$family")
            tap("back")

            // 6) Pantalla principal: Equipo de producto fijado (📌) en Grupos; tocarlo abre los mensajes.
            waitTag("waRow-$work"); waitTag("waPinMark-$work")
            shot("8-principal-wa")
            tap("waRow-$work"); waitTag("waMessages"); assertFalse(exists("contextMenu")); tap("back")

            // 7) Correo: fijar g1 en la pantalla principal (pulsación larga) y g6 en Correo (correo abierto).
            tap("access-mail"); waitTag("mailRow-g1")
            compose.onNodeWithTag("mailRow-g1", useUnmergedTree = true).performTouchInput { longClick() }
            waitTag("mailPinMain"); shot("9-menu-correo"); tap("mailPinMain")
            tap("mailRow-g6"); waitTag("mailPinMailBtn"); shot("10-correo-abierto"); tap("mailPinMailBtn")
            Thread.sleep(800)
            ins.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); Thread.sleep(800)
            waitTag("mailPinnedRow-g6"); assertTrue(exists("block-PINNED"))
            shot("11-correo-fijados")
            tap("back")
            waitTag("mailPin-t1"); shot("12-principal-correo")
            tap("mailPin-t1"); waitTag("mailPreview"); shot("13-abre-correo")
            ins.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); Thread.sleep(800)

            // 8) Nombre largo (1.7.13): gg ya no está en la cabecera sino abajo, en la píldora; el nombre gana espacio.
            val longGroup = arg("longGroup"); val personal = arg("personal")
            if (longGroup.isNotBlank()) {
                ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(longGroup) }
                waitTag("composer"); waitTag("ggPillOpen", 10_000)
                assertTrue("sin gg en la cabecera", compose.onAllNodes(androidx.compose.ui.test.hasTestTag("ggSideButton"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
                shot("14-nombre-largo-chat"); tap("back"); Thread.sleep(800)
            }
            if (personal.isNotBlank()) {
                ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(com.tiecoms.app.core.WaInbox.key(personal, "120363009@g.us")) }
                waitTag("waMessages"); waitTag("ggPillOpen", 10_000)
                shot("15-nombre-largo-whatsapp")
            }
        } catch (e: Throwable) { shot("fallo"); throw e } finally { scenario.close() }
    }
}
