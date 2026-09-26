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
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.tiecoms.app.core.MessageDTO
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
 * 1.6.2 contra el API de pruebas: notas de voz (toque → manos libres, corta < 0,5 s, 3 s, 35 s y 3 min 10 s con su
 * duración real, reproducir y saltar, envío fallido sin red que queda para reintentar, y pasar a segundo plano sin
 * perder lo grabado) y fotos (cámara del emulador y selector con una foto de 4000×3000 empujada por adb).
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3047 -e email … -e password … -e conversationId … \
 *     [-e only voice|photos] -e class com.tiecoms.app.VozUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class VozUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val perms: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.RECORD_AUDIO)
        else GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[voz] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(ins)
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(600)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "voz-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun sh(cmd: String) = ins.uiAutomation.executeShellCommand(cmd).close()
    private lateinit var conv: String
    private val client get() = app.container.client.value
    private fun messages(): List<MessageDTO> = client.state.value.conversations[conv]?.messages.orEmpty()
    private fun lastVoice() = messages().lastOrNull { m -> m.attachments.any { it.isVoice } }

    @Test
    fun notasDeVozYFotos() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); conv = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && conv.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        var scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("newGroup"), 45_000)
            openChat()
            val only = arg("only")
            if (only != "photos") scenario = voice(scenario)
            if (only != "voice") photos()
        } catch (t: Throwable) { shot("fallo"); throw t } finally { runCatching { sh("cmd connectivity airplane-mode disable") }; runCatching { scenario.close() } }
    }

    private fun openChat() {
        compose.waitUntilAtLeastOneExists(hasTestTag("conv-$conv"), 15_000)
        compose.onNodeWithTag("conv-$conv").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("mic"), 15_000)
    }

    /** Toque al micrófono → grabación bloqueada; espera [ms] reales; Enviar; consentimiento; devuelve la nota enviada.
     *  La nota dura [ms] más lo que tarda la prueba entre el toque y Enviar (~0,5–1,5 s). */
    private fun record(ms: Long, name: String): MessageDTO? {
        val before = lastVoice()?.id
        compose.onNodeWithTag("mic").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("recordSend"), 5_000) // el toque dejó la grabación bloqueada
        Thread.sleep(ms)
        if (ms > 1_000) shot("$name-grabando")
        compose.onNodeWithTag("recordSend").performClick()
        if (ms < 500) return null
        compose.waitUntilAtLeastOneExists(hasTestTag("aiConsentDecline"), 5_000)
        compose.onNodeWithTag("aiConsentDecline").performClick()
        compose.waitUntil(60_000) { lastVoice()?.id.let { it != null && it != before } }
        return lastVoice()
    }

    private fun voice(start: ActivityScenario<MainActivity>): ActivityScenario<MainActivity> {
        var scenario = start
        // Menos de medio segundo de audio: «demasiado corta».
        record(150, "corta")
        compose.waitUntilAtLeastOneExists(hasTestTag("attError"), 5_000)
        log("Toque + enviar enseguida: «La nota es demasiado corta»")

        val short = record(3_000, "3s")!!.attachments.first { it.isVoice }
        log("Nota de 3 s: durationMs=${short.durationMs}")
        assertTrue("duración del archivo ≈ 3 s: ${short.durationMs}", (short.durationMs ?: 0) in 2_700..4_800)

        val mid = record(35_000, "35s")!!.attachments.first { it.isVoice }
        log("Nota de 35 s: durationMs=${mid.durationMs}, ${mid.sizeBytes} bytes")
        assertTrue("≈ 35 s: ${mid.durationMs}", (mid.durationMs ?: 0) in 34_700..36_800)

        // Reproducir la de 35 s y saltar al 80 %.
        compose.waitUntilAtLeastOneExists(hasTestTag("voicePlay-${mid.id}"), 10_000)
        compose.onNodeWithTag("voicePlay-${mid.id}", useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) { app.container.voice.state.value.let { it.currentId == mid.id && it.playing } }
        compose.onNodeWithTag("voiceWave-${mid.id}", useUnmergedTree = true).performTouchInput { click(androidx.compose.ui.geometry.Offset(width * 0.8f, height / 2f)) }
        Thread.sleep(1_500)
        val pos = app.container.voice.state.value.positionMs
        log("Reproducción con salto: posición $pos ms")
        assertTrue("saltó cerca del 80 %: $pos", pos in 26_000..33_000)
        shot("35s-reproduciendo")
        ins.runOnMainSync { app.container.voice.stop() }

        val long = record(190_000, "3min")!!.attachments.first { it.isVoice }
        log("Nota de 3 min 10 s: durationMs=${long.durationMs}, ${long.sizeBytes} bytes")
        assertTrue("≈ 190 s: ${long.durationMs}", (long.durationMs ?: 0) in 189_700..192_000)
        compose.onNodeWithTag("voicePlay-${long.id}", useUnmergedTree = true).performClick()
        compose.waitUntil(15_000) { app.container.voice.state.value.let { it.currentId == long.id && it.playing } }
        compose.onNodeWithTag("voiceWave-${long.id}", useUnmergedTree = true).performTouchInput { click(androidx.compose.ui.geometry.Offset(width * 0.95f, height / 2f)) }
        Thread.sleep(2_000)
        val lpos = app.container.voice.state.value.positionMs
        log("Nota larga: salto al 95 % → $lpos ms")
        assertTrue("salto en la nota larga: $lpos", lpos > 170_000)
        ins.runOnMainSync { app.container.voice.stop() }

        // Sin red: el envío falla, la nota queda con Reintentar; con red, se envía.
        sh("cmd connectivity airplane-mode enable"); Thread.sleep(2_500)
        val beforeFail = lastVoice()?.id
        compose.onNodeWithTag("mic").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("recordSend"), 5_000)
        Thread.sleep(2_000)
        compose.onNodeWithTag("recordSend").performClick()
        compose.onNodeWithTag("aiConsentDecline").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("voiceDraftError"), 60_000)
        shot("sin-red")
        log("Sin red: la nota queda «sin enviar» con el motivo y Reintentar")
        sh("cmd connectivity airplane-mode disable"); Thread.sleep(6_000)
        compose.onNodeWithTag("voiceDraftRetry").performClick()
        compose.waitUntil(60_000) { lastVoice()?.id.let { it != null && it != beforeFail } }
        compose.waitUntil(5_000) { !exists("voiceDraft") }
        log("Reintentar con red: enviada")

        // Pasar a segundo plano grabando: lo grabado queda como nota por enviar.
        compose.onNodeWithTag("mic").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("recordSend"), 5_000)
        Thread.sleep(4_000)
        device.pressHome(); Thread.sleep(2_000)
        scenario.close()
        scenario = ActivityScenario.launch(MainActivity::class.java)
        openChat()
        compose.waitUntilAtLeastOneExists(hasTestTag("voiceDraft"), 10_000)
        shot("segundo-plano")
        val beforeBg = lastVoice()?.id
        compose.onNodeWithTag("voiceDraftRetry").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("aiConsentDecline"), 5_000)
        compose.onNodeWithTag("aiConsentDecline").performClick()
        compose.waitUntil(60_000) { lastVoice()?.id.let { it != null && it != beforeBg } }
        val bg = lastVoice()!!.attachments.first { it.isVoice }
        log("Segundo plano: la grabación se guardó y se envió (${bg.durationMs} ms)")
        assertTrue((bg.durationMs ?: 0) >= 3_000)
        return scenario
    }

    private fun lastImage() = messages().lastOrNull { m -> m.attachments.any { it.isImage } }

    private fun photos() {
        // Cámara del emulador (escena virtual).
        val before = lastImage()?.id
        compose.onNodeWithTag("attach").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("attCamera"), 5_000)
        compose.onNodeWithTag("attCamera").performClick()
        device.wait(Until.hasObject(By.pkg(java.util.regex.Pattern.compile("com\\.android\\.camera.*|com\\.google\\.android\\.GoogleCamera.*"))), 15_000)
        Thread.sleep(3_000)
        shot("camara")
        val shutter = device.wait(Until.findObject(By.res(java.util.regex.Pattern.compile(".*shutter.*"))), 5_000)
        if (shutter != null) shutter.click() else device.pressKeyCode(android.view.KeyEvent.KEYCODE_CAMERA)
        Thread.sleep(3_000)
        val done = device.wait(Until.findObject(By.res(java.util.regex.Pattern.compile(".*(done|confirm|ok).*button.*"))), 8_000)
            ?: device.findObject(By.desc(java.util.regex.Pattern.compile("(?i)(done|ok|aceptar|listo).*")))
        done?.click()
        compose.waitUntilAtLeastOneExists(hasTestTag("pendingFiles"), 20_000)
        shot("camara-adjunta")
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(60_000) { lastImage()?.id.let { it != null && it != before } }
        val cam = lastImage()!!.attachments.first { it.isImage }
        log("Cámara: enviada ${cam.width}×${cam.height}, ${cam.sizeBytes} bytes, miniatura=${cam.thumbUrl != null}")

        // Selector de fotos con la de 4000×3000 empujada por adb (la más reciente de la galería).
        val before2 = lastImage()?.id
        compose.onNodeWithTag("attach").performClick()
        compose.waitUntilAtLeastOneExists(hasTestTag("attPhotos"), 5_000)
        compose.onNodeWithTag("attPhotos").performClick()
        Thread.sleep(4_000)
        shot("selector")
        val item = device.wait(Until.findObject(By.descStartsWith("Photo")), 10_000)
            ?: device.wait(Until.findObject(By.descStartsWith("Foto")), 3_000)
        requireNotNull(item) { "no se encontró la foto en el selector" }.click()
        Thread.sleep(1_000)
        device.wait(Until.findObject(By.text(java.util.regex.Pattern.compile("(?i)(add|agregar|añadir|done|listo).*"))), 5_000)?.click()
        compose.waitUntilAtLeastOneExists(hasTestTag("pendingFiles"), 30_000)
        shot("galeria-adjunta")
        compose.onNodeWithTag("send").performClick()
        compose.waitUntil(90_000) { lastImage()?.id.let { it != null && it != before2 } }
        val gal = lastImage()!!.attachments.first { it.isImage }
        log("Galería 4000×3000: enviada ${gal.width}×${gal.height}, ${gal.sizeBytes} bytes")
        assertTrue("reducida: ${gal.sizeBytes}", gal.sizeBytes < 2_500_000)
        compose.waitUntil(20_000) { messages().any { m -> m.attachments.any { it.id == gal.id && it.thumbUrl != null } } }
        Thread.sleep(2_000)
        shot("fotos-enviadas")
        log("Fotos: miniatura subida y mostrada")
        assertEquals(true, messages().any { m -> m.attachments.any { it.id == gal.id } })
    }
}
