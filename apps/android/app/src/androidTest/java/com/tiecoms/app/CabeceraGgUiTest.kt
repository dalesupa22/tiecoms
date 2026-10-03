package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
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
import com.tiecoms.app.core.DeepLink
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
 * 2-oct-2026: gg en todos los chats y la cabecera sin cortes: gg · 📞 (voz o video) · 🔎 · ⋯, y el nombre con «…».
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3097 -e email … -e password … -e chats id1,id2 \
 *     -e class com.tiecoms.app.CabeceraGgUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class CabeceraGgUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()
    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun shot(name: String) {
        Thread.sleep(700)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "cabecera-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun ggEnTodosLosChatsYNombreCompleto() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val password = arg("password"); val chats = arg("chats").split(',').filter { it.isNotBlank() }
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && password.isNotBlank() && chats.isNotEmpty())
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
            chats.forEachIndexed { i, id ->
                ins.runOnMainSync { app.container.pendingLink.value = DeepLink.Conversation(id) }
                compose.waitUntilAtLeastOneExists(hasTestTag("composer"), 20_000)
                compose.waitUntilAtLeastOneExists(hasTestTag("ggPillOpen"), 10_000)
                assertTrue("🔎", exists("chatSearch")); assertTrue("⋯", exists("convMenu")); assertTrue("📞", exists("callStart"))
                assertFalse("sin ⓘ aparte", compose.onAllNodes(hasTestTag("details")).fetchSemanticsNodes().size > 1)
                shot("$i")
                compose.onNodeWithTag("back").performClick()
                Thread.sleep(800)
            }
        } finally { scenario.close() }
    }
}
