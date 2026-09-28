package com.tiecoms.app

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiecoms.app.core.*
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
import java.util.concurrent.CopyOnWriteArrayList

/** Real participants UI with an in-process synthetic server. No production account or external message. */
@RunWith(AndroidJUnit4::class)
class GroupAdminsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private lateinit var client: TieComsClient
    private val mutations = CopyOnWriteArrayList<String>()
    @Volatile private var promoted = false
    @Volatile private var authSequence = 0
    @After fun close() { if (::client.isInitialized) client.close(); server.shutdown() }

    @Test fun confirmationRoleBadgesAndAccountReplacement() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.requestUrl!!.encodedPath
                val me = if (r.getHeader("authorization") == "Bearer b") "b" else "me"
                val body = when {
                    path == "$AUTH_BASE_PATH/login" -> {
                        val u = if (r.body.readUtf8().contains("b@example.test")) "b" else "me"
                        """{"accessToken":"$u","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"local","sessionId":"local-${++authSequence}","user":{"id":"$u","name":"QA"}}"""
                    }
                    path == "$AUTH_BASE_PATH/logout" -> "{}"
                    path == "/api/v1/bootstrap" -> """{"me":{"id":"$me","name":"QA"},"people":[{"id":"creator","name":"A Creator"},{"id":"member","name":"B Member"},{"id":"bot","name":"C Demo Bot","kind":"agent"},{"id":"me","name":"D QA"},{"id":"b","name":"E Other QA"}],"conversations":[{"id":"admins-qa","kind":"group","name":"Synthetic Admins","memberIds":["creator","member","bot","$me"],"canManage":true,"adminIds":["creator","$me"${if (promoted) ",\"member\"" else ""}],"createdBy":"creator"}]}"""
                    path == "/api/v1/conversations/admins-qa/members/member/admin" -> {
                        mutations += r.body.readUtf8(); promoted = true
                        """{"adminIds":["creator","me","member"]}"""
                    }
                    path == "/api/v1/blocks" -> """{"userIds":[]}"""
                    path == "/api/v1/reminders" -> """{"reminders":[]}"""
                    path == "/api/v1/scheduled" -> """{"scheduled":[]}"""
                    path == "/api/v1/issues" -> """{"issues":[]}"""
                    path == "/api/v1/calendar/events" -> """{"events":[]}"""
                    else -> return MockResponse().setResponseCode(404).setBody("{}")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Local admins UI", MemoryStorage(), MemorySecretStore(), OkHttpClient.Builder().retryOnConnectionFailure(false).build())
        runBlocking { client.login("a@example.test", "synthetic") }
        compose.setContent {
            CompositionLocalProvider(LocalClient provides client, LocalContainer provides compose.activity.container) {
                TieComsTheme { DetailsScreen("admins-qa", onBack = {}, onOpenIssue = {}, onOpenEvent = {}, onOpenConversation = {}) }
            }
        }
        fun person(id: String) = compose.onNodeWithTag("person-$id").also { compose.onNodeWithTag("participants").performScrollToNode(hasTestTag("person-$id")) }
        person("creator"); compose.onNodeWithTag("adminTag-creator", useUnmergedTree = true).assertIsDisplayed()
        person("bot"); compose.onNodeWithTag("botTag-bot", useUnmergedTree = true).assertIsDisplayed()
        person("member").performTouchInput { longClick() }
        compose.onNodeWithTag("adminAction-MAKE_ADMIN").performClick()
        compose.onNodeWithTag("confirmAdminAction").assertIsDisplayed()
        assertTrue(mutations.isEmpty())
        compose.onNodeWithText(compose.activity.getString(R.string.cancel)).performClick()
        assertTrue(mutations.isEmpty())
        person("member").performClick()
        compose.onNodeWithTag("adminAction-MAKE_ADMIN").performClick()
        compose.onNodeWithTag("confirmAdminAction").performClick()
        compose.waitUntil(10_000) { client.meta("admins-qa")!!.adminIds?.contains("member") == true }
        compose.waitForIdle()
        person("member"); compose.onNodeWithTag("adminTag-member", useUnmergedTree = true).assertIsDisplayed()
        assertEquals(listOf("{\"admin\":true}"), mutations.toList())
        person("member").performClick()
        compose.onNodeWithTag("adminAction-REMOVE_ADMIN").performClick()
        compose.onNodeWithTag("confirmAdminAction").assertIsDisplayed()
        runBlocking { client.logout(); client.login("b@example.test", "synthetic") }
        compose.waitForIdle()
        compose.onNodeWithTag("confirmAdminAction").assertDoesNotExist()
        assertEquals("b", client.myId)
        assertEquals(1, mutations.size)
    }
}
