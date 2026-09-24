package com.tiecoms.app

import android.Manifest
import android.app.LocaleManager
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.LocaleList
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
import androidx.test.filters.SdkSuppress
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

/** Actual app screenshots using synthetic accounts on a local API only. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 33)
class StoreScreenshotsTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications = GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun shot(name: String) {
        Thread.sleep(800)
        val bmp = requireNotNull(ins.uiAutomation.takeScreenshot())
        File(ins.targetContext.getExternalFilesDir(null), "store-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun open(uri: String) {
        ins.targetContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(ins.targetContext.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    @Test fun captureDemoScreens() {
        val api = arg("apiUrl")
        assumeTrue("Store capture fixture is opt-in", api.isNotBlank() && arg("email").isNotBlank() && arg("password").isNotBlank() && arg("otherId").isNotBlank())
        assertTrue("Only a local test API", api.startsWith("http://10.0.2.2:"))
        val app = ins.targetContext.applicationContext as TieComsApp
        ins.runOnMainSync {
            ins.targetContext.getSystemService(LocaleManager::class.java).applicationLocales = LocaleList.forLanguageTags("es")
            app.container.setDebugApiUrl(api)
        }
        runBlocking {
            val client = app.container.client.value
            kotlinx.coroutines.withTimeout(20000) { client.state.first { it.status != SessionStatus.LOADING } }
            if (client.state.value.status != SessionStatus.ANONYMOUS) client.logout()
        }
        val activity = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20000) { compose.onAllNodes(hasTestTag("email")).fetchSemanticsNodes().isNotEmpty() && compose.onAllNodes(hasTestTag("splash")).fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithTag("email").performTextInput(arg("email"))
            compose.onNodeWithTag("password").performTextInput(arg("password"))
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("conv-${arg("conversationId")}"),20000)
            shot("01-inicio")
            compose.onNodeWithTag("conv-${arg("conversationId")}").performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("composer"),10000)
            shot("02-conversacion")
            open("tiecoms://asuntos")
            compose.waitUntilExactlyOneExists(hasTestTag("issues"),10000)
            shot("03-asuntos")
            open("tiecoms://agenda")
            compose.waitUntilExactlyOneExists(hasTestTag("agenda"),10000)
            shot("04-agenda")
            open("tiecoms://c/${arg("directId")}")
            compose.waitUntilExactlyOneExists(hasTestTag("composer"),10000)
            compose.onNodeWithTag("details").performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("participants"),10000)
            shot("05-participantes")
            // Exercise moderation against the isolated demo API, then restore
            // the demo state so later screenshots remain representative.
            compose.onNodeWithTag("report-user-${arg("otherId")}").performScrollTo().performClick()
            compose.onNodeWithTag("reportReason").performTextInput("Reporte de demostración para validar la revisión de contenido")
            compose.onNodeWithTag("submitReport").performClick()
            compose.waitUntilDoesNotExist(hasTestTag("submitReport"),10000)
            compose.onNodeWithTag("block-user-${arg("otherId")}").performScrollTo().performClick()
            compose.onNodeWithTag("confirmBlock").performClick()
            compose.waitUntilDoesNotExist(hasTestTag("confirmBlock"),10000)
            assertTrue(arg("otherId") in app.container.client.value.state.value.blockedUserIds)
            compose.onNodeWithTag("back").performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("blockedChat"),10000)
            shot("qa-bloqueo")
            compose.onNodeWithTag("details").performClick()
            compose.onNodeWithTag("block-user-${arg("otherId")}").performScrollTo().performClick()
            compose.onNodeWithTag("confirmBlock").performClick()
            compose.waitUntilDoesNotExist(hasTestTag("confirmBlock"),10000)
            assertFalse(arg("otherId") in app.container.client.value.state.value.blockedUserIds)
        } finally { activity.close() }
    }
}
