package com.tiecoms.app

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiecoms.app.core.*
import com.tiecoms.app.platform.ComposerDrafts
import com.tiecoms.app.ui.*
import com.tiecoms.app.ui.theme.TieComsTheme
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** Native shell, local synthetic data only. Does not touch a real session or send/call. */
@RunWith(AndroidJUnit4::class)
class MotionFiltersUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val notifications: androidx.test.rule.GrantPermissionRule = androidx.test.rule.GrantPermissionRule.grant(android.Manifest.permission.POST_NOTIFICATIONS)
    private val server = MockWebServer()
    private lateinit var client: TieComsClient
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val tasks = listOf(
        IssueDTO(id = "mine-open", conversationId = "motion-qa", title = "My pending fixture", ownerId = "me"),
        IssueDTO(id = "mine-done", conversationId = "motion-qa", title = "My completed fixture", ownerId = "me", status = "done"),
        IssueDTO(id = "parent", conversationId = "motion-qa", title = "Parent context fixture", ownerId = "other"),
        IssueDTO(id = "lorena-done", conversationId = "motion-qa", title = "Lorena completed fixture", ownerId = "lorena", status = "done", parentIssueId = "parent"),
        IssueDTO(id = "lorena-open", conversationId = "motion-qa", title = "Lorena pending sibling", ownerId = "lorena", parentIssueId = "parent"),
        IssueDTO(id = "lorena-cancelled", conversationId = "motion-qa", title = "Lorena cancelled fixture", ownerId = "lorena", status = "cancelled"),
        IssueDTO(id = "other-done", conversationId = "motion-qa", title = "Other completed sibling", ownerId = "other", status = "done", parentIssueId = "parent"))
    private fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                requests += r
                val path = r.requestUrl!!.encodedPath
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> """{"accessToken":"local","accessExpiresAt":"2099-01-01T00:00:00Z","sessionId":"local","user":{"id":"me","name":"QA"}}"""
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"me","name":"QA","primaryOrgId":"qa-org"},"organizations":[{"id":"qa-org","name":"QA local"}],"workspaces":[{"id":"qa-workspace","name":"Equipo local","owningOrgId":"qa-org","organizationIds":["qa-org"],"myRole":"admin"}],"features":{"calls":true,"mail":true},"people":[{"id":"me","name":"QA"},{"id":"lorena","name":"Lorena"},{"id":"other","name":"Ana"}],"conversations":[{"id":"motion-qa","workspaceId":"qa-workspace","kind":"group","name":"Fluidez QA local","memberIds":["me","lorena","other"],"lastMessageSeq":1,"lastReadSeq":1,"canPost":true},{"id":"dm-qa","kind":"direct","name":"Ana local","memberIds":["me","other"]}]}"""
                    path == "/api/v1/conversations/motion-qa/messages" -> """{"messages":[{"id":"m1","conversationId":"motion-qa","seq":1,"authorId":"other","body":"Probemos el menú y los filtros sin enviar nada.","createdAt":"2026-10-05T01:00:00Z"}],"hasMore":false}"""
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path == "/api/v1/gg/side/pending" -> """{"c:motion-qa":3}"""
                    path == "/api/v1/gg/side" -> """{"messages":[{"id":"g1","role":"user","body":"Historial local"},{"id":"g2","role":"gg","body":"Aquí están tus pendientes locales."}],"pending":3}"""
                    path == "/api/v1/issues" -> if (r.requestUrl!!.queryParameter("limit") != null) {
                        if (r.requestUrl!!.queryParameter("offset") == "0") TcJson.encodeToString(IssuesPage.serializer(), IssuesPage(tasks.take(3), 200))
                        else TcJson.encodeToString(IssuesPage.serializer(), IssuesPage(tasks.drop(3)))
                    } else TcJson.encodeToString(IssuesPage.serializer(), IssuesPage(tasks))
                    path.endsWith("/pins") -> """{"messageIds":[]}"""
                    path.endsWith("/topics") -> """{"topics":[]}"""
                    path == "/api/v1/calendar/events" -> """{"events":[]}"""
                    path == "/api/v1/scheduled" -> """{"scheduled":[]}"""
                    path == "/api/v1/calls" -> """{"calls":[]}"""
                    path == "/api/v1/calls/seen" -> "{}"
                    path == "/api/v1/mail/accounts" || path == "/api/v1/whatsapp/accounts" -> """{"accounts":[]}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Motion local QA", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { client.login("qa@example.test", "synthetic"); client.loadIssues() }
        ComposerDrafts.save(compose.activity, client.baseUrl + ":me", "motion-qa", ComposerDrafts.Draft("Borrador local conservado"))
        compose.setContent { CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) { TieComsTheme { TaskDialogsHost { MainNav() } } } }
        waitTag("tab-home")
    }
    private fun waitTag(tag: String) = compose.waitUntil(15_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun shot(name: String) {
        compose.waitForIdle()
        val bmp = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()!!
        File(compose.activity.getExternalFilesDir(null), "motion-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun click(tag: String) {
        waitTag(tag)
        // The row contains a separate tasks chip near its centre; tap the chat title area.
        if (tag.startsWith("conv-")) compose.onNodeWithTag(tag).performTouchInput { click(androidx.compose.ui.geometry.Offset(width / 3f, height / 4f)) }
        else compose.onNodeWithTag(tag).performClick()
    }
    private fun back() { androidx.test.uiautomator.UiDevice.getInstance(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()).pressBack(); compose.waitForIdle() }
    @After fun finish() { if (::client.isInitialized) { runCatching { shot("last-state") }; client.close() }; server.shutdown() }
    @Test fun fullShellChatBackDraftGridAndLazyGgRemainWorking() {
        start()
        for (tab in listOf("home", "dms", "issues", "agenda", "calls", "settings")) compose.onNodeWithTag("tab-$tab").assertExists()
        for (tab in listOf("dms", "agenda", "calls", "settings", "home")) { click("tab-$tab"); compose.waitForIdle() }
        shot("full-shell")
        click("conv-motion-qa"); waitTag("composer")
        compose.onNodeWithTag("composer").assertTextContains("Borrador local conservado")
        assertFalse(requests.any { it.requestUrl!!.encodedPath == "/api/v1/gg/side" })
        waitTag("ggPillCount"); shot("conversation")
        click("attach"); waitTag("composerActionGrid")
        listOf("attPhotos", "attCamera", "attFiles", "plusMeetNow", "plusMeetSchedule", "plusMail", "plusWhatsApp", "plusWhatsAppShare", "plusEvent", "plusIssue", "plusGgReply").forEach {
            compose.onNodeWithTag("composerActionGrid").performScrollToNode(hasTestTag(it)); compose.onNodeWithTag(it).assertExists()
        }
        compose.onNodeWithTag("composerActionGrid").performScrollToIndex(0); shot("actions")
        compose.onNodeWithTag("composerActionGrid").performScrollToNode(hasTestTag("plusEvent")); click("plusEvent"); waitTag("eventDialog")
        back(); waitTag("composer")
        compose.onNodeWithTag("composer").assertTextContains("Borrador local conservado")
        click("ggPillOpen"); waitTag("ggSideSheet")
        compose.waitUntil(10_000) { requests.any { it.requestUrl!!.encodedPath == "/api/v1/gg/side" } }
        shot("gg"); back()
        compose.onNodeWithTag("composer").performTextInput(" · editado")
        back(); click("back"); waitTag("conv-motion-qa")
        click("conv-motion-qa"); waitTag("composer")
        compose.onNodeWithTag("composer").assertTextContains("editado", substring = true)
        compose.onNodeWithTag("creativeButton").assertExists(); compose.onNodeWithTag("viewOnce").assertExists()
        assertFalse(requests.any { it.method == "POST" && (it.requestUrl!!.encodedPath.endsWith("/messages") || it.requestUrl!!.encodedPath.endsWith("/join")) })
    }
    @Test fun todoPersonAndStatusIntersectIncludingChildrenFromSecondPage() {
        start(); click("tab-issues"); waitTag("taskFilterPeople")
        compose.onNodeWithTag("issue-mine-open").assertExists(); compose.onNodeWithTag("issue-mine-done").assertDoesNotExist()
        click("taskFilterStatus"); click("taskStatus-pending"); click("taskStatus-done"); click("taskFilterApply")
        waitTag("issue-mine-done"); compose.onNodeWithTag("issue-mine-open").assertDoesNotExist(); shot("my-completed")
        click("taskFilterPeople"); click("taskPerson-me"); click("taskPerson-lorena"); click("taskFilterApply")
        waitTag("taskContext-parent"); waitTag("issue-lorena-done")
        listOf("lorena-open", "other-done", "lorena-cancelled", "mine-done").forEach { compose.onNodeWithTag("issue-$it").assertDoesNotExist() }
        shot("lorena-completed")
        click("taskFilterStatus"); click("taskStatus-cancelled"); click("taskFilterApply"); waitTag("issue-lorena-cancelled")
        assertTrue(requests.any { it.requestUrl!!.queryParameter("offset") == "200" })
    }
}
