package com.tiecoms.app

import android.graphics.Bitmap
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.tiecoms.app.core.SessionStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.concurrent.thread

/**
 * Splash de ignición en frío con reloj real (sin la regla de Compose, que usa un reloj virtual):
 * termina y aparece el login en ≤ 3 s y guarda 3 fotogramas (≈0,15 s, 0,45 s y 1,0 s).
 * Correr como primera prueba del proceso:
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3041 -e class com.tiecoms.app.SplashUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@RunWith(AndroidJUnit4::class)
class SplashUiTest {
    private val ins = InstrumentationRegistry.getInstrumentation()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[ui] $s") }

    private fun screenshot(name: String) {
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        val f = File(ins.targetContext.getExternalFilesDir(null), "$name.png")
        f.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        log("captura: ${f.absolutePath}")
    }

    @Test
    fun splashEnFrio() {
        val apiUrl = InstrumentationRegistry.getArguments().getString("apiUrl").orEmpty()
        assumeTrue("Falta apiUrl", apiUrl.isNotBlank())
        val app = ins.targetContext.applicationContext as TieComsApp
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        assumeTrue("El splash ya se mostró en este proceso", app.container.splashPending)
        val device = UiDevice.getInstance(ins)
        val launchAt = android.os.SystemClock.uptimeMillis()
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            // Los fotogramas se toman respecto al primer fotograma del splash (no al lanzamiento del proceso).
            while (app.container.splashStartedAt == 0L && android.os.SystemClock.uptimeMillis() - launchAt < 8_000) Thread.sleep(5)
            val start = app.container.splashStartedAt
            assertTrue("Se mostró el splash", start > 0)
            val shots = thread {
                for ((ms, name) in listOf(150L to "splash-1-0150ms", 450L to "splash-2-0450ms", 1000L to "splash-3-1000ms")) {
                    val wait = start + ms - android.os.SystemClock.uptimeMillis()
                    if (wait > 0) Thread.sleep(wait)
                    screenshot(name)
                }
            }
            val login = device.wait(Until.findObject(By.res("email")), 8_000)
            shots.join()
            val end = app.container.splashEndedAt
            val loginAt = android.os.SystemClock.uptimeMillis()
            log("proceso→primer fotograma del splash: ${start - launchAt} ms · splash→fin: ${end - start} ms · splash→login visible (UiAutomator): ${loginAt - start} ms")
            assertNotNull("Aparece el login", login)
            assertTrue("El splash termina en ≤ 3 s (fue ${end - start} ms)", end > 0 && end - start <= 3_000)
            screenshot("splash-4-login")
        } finally { runCatching { scenario.close() } }
    }
}
