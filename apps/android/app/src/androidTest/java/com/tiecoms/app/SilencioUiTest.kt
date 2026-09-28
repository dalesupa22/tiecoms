package com.tiecoms.app

import android.Manifest
import android.app.NotificationManager
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import android.view.KeyEvent
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.printToLog
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.AppLanguage
import com.tiecoms.app.core.MemorySecretStore
import com.tiecoms.app.core.MemoryStorage
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.Silence
import com.tiecoms.app.core.TieComsClient
import com.tiecoms.app.platform.AppLocale
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * SPEC-silencio (1.6.4 build 20) contra el API de pruebas (fixture de scripts/mobile-fixture.mjs):
 * silenciar desde la pulsación larga, el encabezado y Detalles; 🔕 y globo gris; «No molestar» en «Tú»
 * con la lunita y la franja; sin notificación local mientras está activo; `me.dnd` desde otra sesión.
 * Con `expectLocal=1` (API sin PUT /me/dnd, p. ej. 3050) comprueba el camino del 404: solo en el dispositivo.
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3063 -e email … -e password … -e conversationId … \
 *     -e peerEmail … -e class com.tiecoms.app.SilencioUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class SilencioUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val prefix by lazy { arg("shotPrefix").ifBlank { "silencio" } }
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[silencio] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun hasLabel(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(800)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "$prefix-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    /** Espera una etiqueta también dentro de filas con semántica fusionada (🔕, lunita). */
    private fun waitTag(tag: String, ms: Long) = compose.waitUntil(ms) { exists(tag) }
    private fun back() { ins.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); Thread.sleep(500) }

    /** ¿Hay una notificación de la app con este texto? */
    private fun notified(text: String): Boolean {
        val nm = app.getSystemService(NotificationManager::class.java)
        return nm.activeNotifications.any { sb ->
            val n = sb.notification
            n.extras.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString()?.contains(text) == true ||
                NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)?.messages?.any { it.text?.toString()?.contains(text) == true } == true
        }
    }

    private fun other(email: String, password: String): TieComsClient {
        val c = TieComsClient(arg("apiUrl"), "Otra sesión", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { c.login(email, password) }
        return c
    }

    @Test
    fun silenciarChatsYNoMolestar() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val conv = arg("conversationId"); val peer = arg("peerEmail")
        val expectLocal = arg("expectLocal") == "1"
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && conv.isNotBlank() && peer.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        val langBefore = AppLocale.current(app)
        ins.runOnMainSync { AppLocale.set(app, AppLanguage.ES); app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        app.container.settings.groupsView = "list"
        app.container.settings.homeTab = "ALL"
        app.container.settings.soundsEnabled = false
        var scenario = ActivityScenario.launch(MainActivity::class.java)
        val beto = other(peer, password)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            waitTag("quick.create", 30_000)
            val client = app.container.client.value
            runBlocking { runCatching { client.setConversationPrefs(conv, mutedUntil = null) }; runCatching { client.setDnd(null) } }
            // Un no leído de Beto para ver el globo.
            beto.send(conv, "Hola Ana, ¿revisas el pedido?")
            compose.waitUntil(15_000) { (client.meta(conv)?.unread ?: 0) > 0 }
            waitTag("conv-$conv", 10_000)

            // 1) Pulsación larga en la fila › Silenciar › 8 horas.
            compose.onNodeWithTag("conv-$conv").performTouchInput { longClick(androidx.compose.ui.geometry.Offset(width * 0.3f, height * 0.3f)) }
            waitTag("menuMute", 5_000)
            compose.onNodeWithTag("menuMute").performClick()
            waitTag("mute8h", 5_000)
            assertTrue(exists("mute1h") && exists("muteWeek") && exists("muteForever"))
            shot("01-fila-menu-silenciar")
            compose.onNodeWithTag("mute8h").performClick()
            compose.waitUntil(10_000) { client.meta(conv)?.mutedAt(System.currentTimeMillis()) == true }
            waitTag("muted-$conv", 5_000)
            shot("02-fila-silenciada-globo-gris")
            log("Pulsación larga › Silenciar › 8 horas: 🔕 y globo gris")

            // 2) Encabezado del chat: 🔕 junto al título y «Reactivar notificaciones» en «…».
            compose.onNodeWithTag("conv-$conv").performTouchInput { click(androidx.compose.ui.geometry.Offset(width * 0.3f, height * 0.3f)) }
            waitTag("composer", 15_000)
            waitTag("chatMuted", 5_000)
            compose.onNodeWithTag("convMenu").performClick()
            waitTag("menuUnmute", 5_000)
            assertTrue("con el tiempo restante", hasLabel("Silenciado hasta"))
            shot("03-encabezado-reactivar")
            back()

            // 3) Detalles: interruptor con el tiempo restante; apagar y volver a encender «hasta que lo reactive».
            compose.onNodeWithTag("details").performClick()
            waitTag("muteSwitchRow", 10_000)
            compose.onNodeWithTag("muteSwitchRow").performScrollTo()
            assertTrue(hasLabel("Silenciado hasta"))
            shot("04-detalles-silenciado-hasta")
            compose.onNodeWithTag("muteSwitchRow").performClick()
            compose.waitUntil(10_000) { client.meta(conv)?.mutedAt(System.currentTimeMillis()) == false }
            compose.waitUntil(5_000) { hasLabel("Notificaciones activas") }
            compose.onNodeWithTag("muteSwitchRow").performClick()
            waitTag("muteForever", 5_000)
            shot("05-detalles-opciones")
            compose.onNodeWithTag("muteForever").performClick()
            compose.waitUntil(10_000) { client.meta(conv)?.mutedUntil == Silence.FOREVER }
            compose.waitUntil(5_000) { !exists("actionSheet") && !hasLabel("Silenciado hasta") }
            shot("06-detalles-silenciado")
            log("Detalles: interruptor, tiempo restante y «Hasta que lo reactive» (9999-12-31)")
            // Para probar «No molestar» el chat vuelve a sonar.
            compose.onNodeWithTag("muteSwitchRow").performClick()
            compose.waitUntil(10_000) { client.meta(conv)?.mutedAt(System.currentTimeMillis()) == false }
            back(); back()

            // 4) «Tú» › No molestar › 8 horas: estado, lunita y franja.
            compose.onNodeWithTag("tab-settings").performClick()
            waitTag("rowDnd", 10_000)
            compose.onNodeWithTag("rowDnd").performScrollTo().performClick()
            waitTag("dndTomorrow", 5_000)
            assertTrue(exists("dnd1h") && exists("dnd8h") && exists("dndForever"))
            shot("07-tu-no-molestar-opciones")
            compose.onNodeWithTag("dnd8h").performClick()
            compose.waitUntil(10_000) { client.dndActive() }
            waitTag("dndMoon", 5_000)
            compose.waitUntil(5_000) { hasLabel("Activo hasta las") || hasLabel("Activo hasta el") }
            if (expectLocal) { waitTag("dndLocalOnly", 5_000); assertTrue(client.state.value.dndLocalOnly) }
            else assertFalse("quedó en el servidor", client.state.value.dndLocalOnly)
            compose.onNodeWithTag("rowDnd").performScrollTo()
            shot("08-tu-no-molestar-activo")
            log("No molestar 8 h: ${client.state.value.dndUntil} (soloDispositivo=${client.state.value.dndLocalOnly})")

            compose.onNodeWithTag("tab-home").performClick()
            waitTag("dndBanner", 5_000)
            shot("09-grupos-franja")
            compose.onNodeWithTag("tab-dms").performClick()
            waitTag("dndBanner", 5_000)

            // 5) Sin notificación local mientras «No molestar» está activo (app en primer plano, en otra pestaña).
            val quiet = "Mensaje en no molestar ${System.currentTimeMillis() % 100000}"
            beto.send(conv, quiet)
            compose.waitUntil(15_000) { client.meta(conv)?.lastMessagePreview?.contains(quiet) == true }
            Thread.sleep(2_500)
            assertFalse("no hay notificación local con «No molestar»", notified(quiet))
            shot("10-dms-franja-sin-aviso")
            log("Con «No molestar» llegó el mensaje (no leído) sin notificación local")

            // 6) «Reactivar» en la franja: vuelve a avisar.
            compose.onNodeWithTag("dndBannerOff", useUnmergedTree = true).performClick()
            compose.waitUntil(10_000) { !client.dndActive() && !exists("dndBanner") }
            assertFalse(exists("dndMoon"))
            val loud = "Mensaje sin no molestar ${System.currentTimeMillis() % 100000}"
            beto.send(conv, loud)
            compose.waitUntil(20_000) { notified(loud) }
            shot("11-reactivado-con-aviso")
            log("Reactivar desde la franja: vuelve la notificación local")

            // 7) Chat silenciado 1 h: sin aviso, salvo la mención.
            runBlocking { client.setConversationPrefs(conv, mutedUntil = Silence.muteUntil(Silence.MuteOption.HOUR_1, System.currentTimeMillis())) }
            val muted = "Silenciado sin mención ${System.currentTimeMillis() % 100000}"
            beto.send(conv, muted)
            compose.waitUntil(15_000) { client.meta(conv)?.lastMessagePreview?.contains(muted) == true }
            Thread.sleep(2_500)
            assertFalse("chat silenciado: sin notificación", notified(muted))
            val me = client.myId!!
            val name = client.state.value.data!!.me.name
            val mention = "@$name mira esto ${System.currentTimeMillis() % 100000}"
            beto.send(conv, mention, mentions = listOf(com.tiecoms.app.core.MentionDTO(me, 0, name.length + 1)))
            compose.waitUntil(20_000) { notified("mira esto") }
            log("Chat silenciado: sin aviso; la mención sí avisa")
            runBlocking { client.setConversationPrefs(conv, mutedUntil = null) }

            // 8) `me.dnd` desde otra sesión (solo con un API que conoce la ruta).
            if (!expectLocal) {
                val otra = other(email, password)
                try {
                    runBlocking { assertTrue(otra.setDnd(Silence.FOREVER)) }
                    compose.waitUntil(15_000) { client.state.value.dndUntil?.startsWith("9999") == true }
                    waitTag("dndBanner", 5_000)
                    shot("12-sincronizado-otra-sesion")
                    runBlocking { otra.setDnd(null) }
                    compose.waitUntil(15_000) { client.state.value.dndUntil == null && !exists("dndBanner") }
                    log("me.dnd desde otra sesión: se enciende y se apaga en vivo")
                } finally { otra.close() }
            }

            // 9) En inglés: Tú, franja y Detalles.
            runBlocking {
                client.setDnd(Silence.dndUntil(Silence.DndOption.HOUR_1, System.currentTimeMillis()))
                client.setConversationPrefs(conv, mutedUntil = Silence.muteUntil(Silence.MuteOption.WEEK, System.currentTimeMillis()))
            }
            ins.runOnMainSync { AppLocale.set(app, AppLanguage.EN) }
            Thread.sleep(2_000)
            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            waitTag("quick.create", 30_000)
            waitTag("dndBanner", 10_000)
            compose.waitUntil(5_000) { hasLabel("Do not disturb until") }
            compose.onNodeWithTag("conversationList").performScrollToIndex(0)
            shot("13-en-grupos-franja")
            compose.onNodeWithTag("tab-settings").performClick()
            waitTag("rowDnd", 10_000)
            compose.onNodeWithTag("rowDnd").performScrollTo()
            compose.waitUntil(5_000) { hasLabel("On until") }
            shot("14-en-tu")
            compose.onNodeWithTag("tab-home").performClick()
            waitTag("conv-$conv", 10_000)
            compose.onNodeWithTag("conv-$conv").performTouchInput { longClick(androidx.compose.ui.geometry.Offset(width * 0.3f, height * 0.3f)) }
            waitTag("menuUnmute", 5_000)
            shot("15-en-fila-menu")
            back()
            compose.onNodeWithTag("conv-$conv").performTouchInput { click(androidx.compose.ui.geometry.Offset(width * 0.3f, height * 0.3f)) }
            waitTag("details", 15_000)
            compose.onNodeWithTag("details").performClick()
            waitTag("muteSwitchRow", 10_000)
            compose.onNodeWithTag("muteSwitchRow").performScrollTo()
            compose.waitUntil(5_000) { hasLabel("Muted until") }
            shot("16-en-detalles")
            log("Inglés: Do not disturb until…, On until…, Muted until…")
            runBlocking { client.setDnd(null); client.setConversationPrefs(conv, mutedUntil = null) }
        } catch (t: Throwable) {
            shot("fallo")
            runCatching { compose.onAllNodes(androidx.compose.ui.test.isRoot(), useUnmergedTree = true).fetchSemanticsNodes().forEachIndexed { i, _ ->
                compose.onAllNodes(androidx.compose.ui.test.isRoot(), useUnmergedTree = true)[i].printToLog("SILTREE", maxDepth = 40) } }
            throw t
        } finally {
            runCatching { beto.close() }
            runCatching { scenario.close() }
            ins.runOnMainSync { AppLocale.set(app, langBefore) }
        }
    }
}
