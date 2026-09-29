package com.tiecoms.app

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiecoms.app.core.*
import com.tiecoms.app.ui.ConversationRow
import com.tiecoms.app.ui.theme.SideDark
import com.tiecoms.app.ui.theme.SideLight
import com.tiecoms.app.ui.theme.TieComsTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 1.7.1: en las filas, arriba solo el grupo o la persona y abajo, pequeña y gris, la empresa (sin repetirla);
 * la píldora «Sidechat» es verde azulado (#1F7A74 sobre #E0F2EF; oscuro #7FD3CA sobre #16312E).
 */
@RunWith(AndroidJUnit4::class)
class NamesSideUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val data = BootstrapDTO(
        me = UserDTO(id = "me", name = "Yo", primaryOrgId = "o-me"),
        organizations = listOf(OrganizationDTO(id = "o-me", name = "Xertify", myRole = "owner"), OrganizationDTO(id = "o-acme", name = "Acme")),
        workspaces = listOf(WorkspaceDTO(id = "w-rel", name = "Acme", owningOrgId = "o-me", organizationIds = listOf("o-me", "o-acme")),
            WorkspaceDTO(id = "w-home", name = "Xertify", owningOrgId = "o-me", organizationIds = listOf("o-me"), isOrgHome = true)),
        people = listOf(PersonDTO(id = "me", name = "Yo", orgId = "o-me"), PersonDTO(id = "ana", name = "Ana Acme", orgId = "o-acme")),
        conversations = listOf(
            ConversationDTO(id = "g1", workspaceId = "w-rel", kind = "group", name = "Mentorías", memberIds = listOf("me", "ana")),
            ConversationDTO(id = "g2", workspaceId = "w-home", kind = "group", name = "Xertify - Xertiflow", memberIds = listOf("me")),
            ConversationDTO(id = "d1", kind = "direct", memberIds = listOf("me", "ana")),
            ConversationDTO(id = "s1", kind = "multi", name = "Sidechat · Duda", parentId = "g1", deriveKind = "side", memberIds = listOf("me", "ana")),
        ),
    )

    private fun rows(dark: Boolean) {
        compose.setContent {
            TieComsTheme(dark = dark) {
                Column {
                    data.conversations.forEach { c ->
                        ConversationRow(c, data, "Interno", "Chat", indent = 16.dp, iconSize = 44.dp, menuOpen = false, menuItems = { emptyList() },
                            onDismissMenu = {}, onLongPress = {}, onIssues = {},
                            companyLine = Names.rowCompany(c, data, "Interno", "Chat"), badge = if (c.isSide) "Sidechat" else null) {}
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    @Test fun companyGoesBelowTheNameAndSidechatIsTeal() {
        rows(dark = false)
        compose.onNodeWithTag("company-g1", useUnmergedTree = true).assertTextEquals("Acme")
        compose.onNodeWithText("Mentorías", useUnmergedTree = true).assertExists()
        assertTrue("Sin «Empresa · Grupo» en la línea principal", compose.onAllNodesWithText("·", substring = true, useUnmergedTree = true)
            .fetchSemanticsNodes().none { n -> n.config.toString().contains("Mentorías") })
        compose.onNodeWithTag("company-g2", useUnmergedTree = true).assertDoesNotExist()    // el nombre ya lleva «Xertify»
        compose.onNodeWithTag("company-d1", useUnmergedTree = true).assertTextEquals("Acme") // 1:1 → empresa de la otra persona
        compose.onNodeWithTag("company-s1", useUnmergedTree = true).assertDoesNotExist()
        assertBadge(SideLight.bg.toArgb())
    }

    @Test fun sidechatBadgeDark() {
        rows(dark = true)
        assertBadge(SideDark.bg.toArgb())
    }

    private fun assertBadge(expected: Int) {
        val img = compose.onNodeWithTag("sideBadge-s1", useUnmergedTree = true).onParent().captureToImage()
        val px = img.asAndroidBitmap().getPixel(2, img.height / 2)
        assertEquals("Fondo de la píldora %08X".format(px), expected, px)
    }
}
