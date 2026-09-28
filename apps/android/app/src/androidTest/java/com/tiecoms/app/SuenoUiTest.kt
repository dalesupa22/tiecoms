package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
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
import com.tiecoms.app.core.SleepMode
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
import java.time.Instant

/**
 * 1.6.4 (23), «No molestar todas las noches» contra el API de pruebas. Antes de correrla, la persona B
 * (peerId) debe tener una ventana de descanso que cubra la hora actual (la prepara el script de la prueba).
 * «Todas las noches» dentro de No molestar, el aviso en el directo con B y «🕒 Enviar a las …», y la lunita.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class SuenoUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[sueno] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        compose.waitForIdle(); Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "sueno-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun noMolestarTodasLasNoches() {
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
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            val client = app.container.client.value
            compose.waitUntil(10_000) { client.state.value.data?.me?.sleep != null }
            assertEquals("22:00", client.state.value.data!!.me.sleep!!.start)
            // La zona sigue la del teléfono mientras tzAuto (el fixture la deja en otra).
            compose.waitUntil(10_000) { client.state.value.data?.me?.sleep?.tz == java.time.ZoneId.systemDefault().id }

            // Tú → No molestar → Todas las noches.
            compose.onNodeWithTag("tab-settings").performClick()
            compose.onNodeWithTag("rowDnd").performScrollTo()
            assertTrue(exists("dndNightlySummary"))
            compose.onNodeWithTag("rowDnd").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("dndNightly"), 5_000)
            shot("01-dentro-de-no-molestar")
            compose.onNodeWithTag("dndNightly").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("sleepDialog"), 5_000)
            shot("02-todas-las-noches")
            compose.onNodeWithTag("sleepSwitch").performClick() // apagar
            compose.onNodeWithTag("sleepSave").performClick()
            compose.waitUntil(10_000) { client.state.value.data?.me?.sleep?.on == false }
            runBlocking { client.setSleep(on = true, start = "22:00", end = "07:00") }
            log("Todas las noches dentro de No molestar: apagar y volver a encender")

            // Directo con B, que está descansando: aviso siempre y «Enviar a las …» al escribir.
            val direct = runBlocking { client.openDirect(peer) }
            runBlocking { client.loadBootstrap() }
            val w = SleepMode.of(client.state.value.data!!.people.first { it.id == peer }.sleep)
            assertTrue("B descansa ahora", SleepMode.sleepingNow(w, Instant.now()))
            ins.runOnMainSync { app.container.pendingLink.value = com.tiecoms.app.core.DeepLink.Conversation(direct) }
            compose.waitUntilAtLeastOneExists(hasTestTag("sleepNotice"), 15_000)
            assertFalse("sin escribir no hay botón", exists("sleepScheduleWake"))
            compose.onNodeWithTag("composer").performTextInput("¿Me confirmas mañana?")
            compose.waitUntilAtLeastOneExists(hasTestTag("sleepScheduleWake"), 5_000)
            shot("03-aviso-directo")
            compose.onNodeWithTag("sleepScheduleWake").performClick()
            compose.waitUntil(10_000) { client.state.value.scheduled.any { it.conversationId == direct && it.body == "¿Me confirmas mañana?" } }
            val s = client.state.value.scheduled.first { it.conversationId == direct }
            assertEquals(SleepMode.wakeAt(w!!, Instant.now()).epochSecond / 60, Instant.parse(s.sendAt).epochSecond / 60)
            shot("04-programado-al-despertar")
            log("Aviso en el directo y «Enviar a las …» programa para cuando despierte")

            // Mi ventana ahora: la lunita del avatar se enciende.
            val now = java.time.LocalTime.now()
            runBlocking { client.setSleep(on = true, start = now.minusHours(1).withSecond(0).withNano(0).toString().take(5), end = now.plusHours(2).withSecond(0).withNano(0).toString().take(5)) }
            compose.waitUntilAtLeastOneExists(hasTestTag("dndMoon"), 10_000)
            assertTrue(client.dndActive())
            shot("05-lunita")
            runBlocking { client.setSleep(on = true, start = "22:00", end = "07:00") }
            log("Lunita encendida en mi ventana")
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { scenario.close() } }
    }
}
