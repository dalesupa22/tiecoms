package com.tiecoms.app

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiecoms.app.core.*
import com.tiecoms.app.platform.VoiceDrafts
import com.tiecoms.app.platform.VoiceRecorder
import com.tiecoms.app.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Deterministic controls and original audio fixtures. No accounts, network or production tasks. */
@RunWith(AndroidJUnit4::class)
class NightControlsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private fun proof(name: String) {
        compose.waitForIdle()
        val bitmap = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: error("Fixture screenshot unavailable")
        File(compose.activity.getExternalFilesDir(null), "night-$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun fourAssigneesRemainCheckedWhenReopened() {
        var chosen: List<String> = emptyList()
        compose.setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) {
            var selected by remember { mutableStateOf(emptyList<String>()) }
            Column { AssigneesPicker((1..4).map { PersonDTO(id = "p$it", name = "QA participant $it") }, selected) { selected = it; chosen = it } }
        } } }
        compose.onNodeWithTag("assigneesPick").performClick()
        (1..4).forEach { compose.onNodeWithTag("assignee-p$it").performClick() }
        proof("four-assignees")
        compose.onNodeWithTag("assigneesSave").performClick()
        assertEquals(listOf("p1", "p2", "p3", "p4"), chosen)
        compose.onNodeWithTag("assigneesPick").performClick()
        (1..4).forEach { compose.onNodeWithTag("assignee-p$it").assertIsOn() }
    }
    @Test fun publicRestBadgeHasNoScheduleAndUnknownStateIsHidden() {
        compose.setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) { Column {
            AvailabilityBadge(AvailabilityDTO("rest", "2099-01-01T00:00:00Z", true, 4))
            AvailabilityBadge(AvailabilityDTO("future-provider-mode", null, true, 5))
            GgButton(99, {})
        } } } }
        compose.onNodeWithTag("availability-rest").assertExists()
        compose.onNodeWithTag("availability-future-provider-mode").assertDoesNotExist()
        compose.onNodeWithText("99", substring = true, useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("ggSideButton").assertExists()
        proof("availability-gg")
    }
    @Test fun recordedOriginalCanPreviewWithoutSendingThenNeedsExplicitSend() {
        val audio = File(compose.activity.cacheDir, "qa-preview-original.wav")
        compose.activity.resources.openRawResource(R.raw.victory).use { input -> audio.outputStream().use { input.copyTo(it) } }
        var sends = 0
        var deletes = 0
        compose.setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) { Column {
            VoiceDraftBar(VoiceDrafts.Draft(VoiceRecorder.Result(audio, 590, listOf(.2f, .8f))), false, { sends++ }, { deletes++ })
        } } } }
        compose.onNodeWithTag("voiceDraftPlay").assertIsEnabled().performClick()
        assertEquals(0, sends); assertEquals(0, deletes)
        proof("voice-local-preview")
        compose.onNodeWithTag("voiceDraftRetry").performClick()
        assertEquals(1, sends)
    }
}
