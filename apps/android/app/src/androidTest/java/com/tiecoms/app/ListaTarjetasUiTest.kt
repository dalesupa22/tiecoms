package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performScrollToNode
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Correo en el chat (docs/CORREO.md) contra el API LOCAL con Gmail y Outlook FALSOS (apps/api/test/fake-mail.mjs, un MOCK:
 * no prueba OAuth ni los permisos reales). Nunca producción.
 * El caso que congelaba la lista en iOS: volver de un chat a Grupos con otro chat cuyo último mensaje es una tarjeta
 * (mail.shared, mail.comments). La lista debe quedar quieta y responder en menos de 2 s, y la vista previa sin JSON. Fixture: scratchpad seed-correo-android.mjs (Danny con Gmail y Outlook conectados; en «Ventas Xertify», g1 compartido con
 * comentario y comentado por Laura, y g6 con historial citado).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class ListaTarjetasUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun str(id: Int, vararg a: Any) = app.getString(id, *a)
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shows(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(900)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "correo-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        Log.i("TieComsUiTest", "captura correo-$name")
    }

    private fun launchLoggedIn(): ActivityScenario<MainActivity> {
        assumeTrue("Faltan argumentos del fixture", arg("apiUrl").isNotBlank() && arg("email").isNotBlank() && arg("password").isNotBlank() && arg("sharedId").isNotBlank())
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
        // El API de pruebas limita los ingresos por IP (10 por minuto, compartidos con otras sesiones): si responde 429,
        // se vuelve a intentar en lugar de fallar la prueba por el entorno.
        for (attempt in 1..4) {
            if (runCatching { compose.waitUntil(20_000) { exists("quick.create") } }.isSuccess) break
            if (attempt == 4) throw AssertionError("No se pudo iniciar sesión en el API de pruebas")
            Log.i("TieComsUiTest", "reintento de ingreso $attempt")
            compose.onNodeWithTag("login").performScrollTo().performClick()
        }
        compose.waitUntil(10_000) { app.container.client.value.state.value.data?.mailEnabled == true }
        return scenario
    }
    private fun openChat(id: String) {
        ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(id) }
        compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 20_000)
    }

    /** waitForIdle en otro hilo: si la lista entra en un bucle de medida o recomposición, nunca queda quieta. */
    private fun idleWithin(ms: Long): Long {
        val t0 = System.nanoTime()
        var done = false
        val th = Thread { runCatching { compose.waitForIdle() }; done = true }
        th.start(); th.join(ms)
        val took = (System.nanoTime() - t0) / 1_000_000
        assertTrue("La interfaz no quedó quieta en $ms ms (¿bucle de layout?)", done)
        return took
    }

    @Test fun volverALaListaConTarjetaDeUltimo() {
        val scenario = launchLoggedIn()
        try {
            val mailGroup = arg("lastMailGroup"); val commentGroup = arg("lastCommentGroup"); val other = arg("topicsChat")
            val device = androidx.test.uiautomator.UiDevice.getInstance(ins)
            compose.waitUntilAtLeastOneExists(hasTestTag("conv-$mailGroup"), 20_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("conv-$commentGroup"), 20_000)
            // Vista previa: el texto del aviso, nunca JSON.
            shot("30-lista-con-tarjetas")
            // La fila prefiere el último mensaje de una persona («Antes del correo»); sin ninguno, el texto del aviso.
            assertTrue(shows("Antes del correo") || shows(str(R.string.web_sys_mail_shared, "50% en todo")))
            assertTrue("La fila del comentario muestra el texto del aviso (cortado a 140 en la vista previa)", shows("💬"))
            assertFalse(shows("{\"k\""))
            repeat(3) { round ->
                // Abrir otro chat y volver a la lista.
                ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(other) }
                compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 15_000)
                idleWithin(5_000)
                val t0 = System.nanoTime()
                device.pressBack()
                compose.waitUntil(2_000) { exists("conv-$mailGroup") }
                val idle = idleWithin(2_000)
                val back = (System.nanoTime() - t0) / 1_000_000
                Log.i("TieComsUiTest", "vuelta $round: lista en $back ms (quieta en $idle ms)")
                assertTrue("La lista tardó $back ms en volver", back < 2_000)
                // Responde: tocar el grupo cuyo último mensaje es la tarjeta abre el chat en menos de 2 s.
                val t1 = System.nanoTime()
                compose.onNodeWithTag("conv-$mailGroup").performClick()
                compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 2_000)
                val open = (System.nanoTime() - t1) / 1_000_000
                Log.i("TieComsUiTest", "vuelta $round: abrir el grupo con la tarjeta en $open ms")
                assertTrue("Abrir tardó $open ms", open < 2_000)
                idleWithin(5_000)
                if (round == 0) shot("31-grupo-con-tarjeta")
                device.pressBack()
                compose.waitUntil(2_000) { exists("conv-$mailGroup") }
                idleWithin(2_000)
            }
            shot("32-lista-despues")
        } finally { scenario.close() }
    }
}
