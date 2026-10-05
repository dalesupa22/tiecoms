package com.tiecoms.app.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** The same actions and permission gates as AttachPicker, presented as a compact native grid. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComposerActionSheet(title: String, actions: List<SheetItem?>, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val order = listOf("attPhotos", "attCamera", "attFiles", "plusWhatsApp", "plusMail", "plusMeetNow", "plusMeetSchedule", "plusEvent", "plusIssue", "plusTask", "plusGgReply", "plusWhatsAppShare")
    val displayed = actions.filterNotNull().sortedBy { action -> order.indexOf(action.tag).let { if (it < 0) order.size else it } }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, modifier = Modifier.testTag("actionSheet")) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp)) {
            Text(title, Modifier.padding(start = 22.dp, end = 22.dp, bottom = 16.dp).semantics { heading() },
                style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            LazyVerticalGrid(columns = GridCells.Fixed(4), modifier = Modifier.fillMaxWidth().heightIn(max = 440.dp).testTag("composerActionGrid"),
                contentPadding = PaddingValues(horizontal = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(displayed, key = { it.tag ?: it.label }) { action ->
                    val tag = action.tag.orEmpty()
                    val tint = when (tag) {
                        "plusWhatsApp", "plusWhatsAppShare" -> Color(0xFF159B59)
                        "attPhotos", "plusMail" -> Color(0xFF267ADE)
                        "attCamera" -> Color(0xFF655CD4)
                        "plusEvent", "plusMeetSchedule" -> Color(0xFFCF427A)
                        "plusGgReply" -> Color(0xFFE24B29)
                        "plusTask", "plusIssue" -> Color(0xFFB57812)
                        else -> Color(0xFF288A91)
                    }
                    val icon = when (tag) {
                        "attPhotos" -> Icons.Outlined.PhotoLibrary
                        "attCamera" -> Icons.Outlined.PhotoCamera
                        "attFiles" -> Icons.Outlined.Description
                        "plusMeetNow" -> Icons.Outlined.Videocam
                        "plusMeetSchedule", "plusEvent" -> Icons.Outlined.Event
                        "plusMail" -> Icons.Outlined.MailOutline
                        "plusTask", "plusIssue" -> Icons.Outlined.TaskAlt
                        "plusGgReply" -> Icons.Outlined.AutoAwesome
                        else -> Icons.AutoMirrored.Outlined.Chat
                    }
                    val interaction = remember { MutableInteractionSource() }
                    val pressed by interaction.collectIsPressedAsState()
                    val scale by animateFloatAsState(if (pressed) 0.92f else 1f, label = "composerActionPress")
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp))
                        .clickable(interactionSource = interaction, indication = null, enabled = action.enabled, role = Role.Button) { onDismiss(); action.onClick?.invoke() }
                        .padding(vertical = 5.dp, horizontal = 2.dp).testTag(tag), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.size(54.dp).graphicsLayer { scaleX = scale; scaleY = scale }
                            .background(tint.copy(alpha = 0.12f), CircleShape), contentAlignment = Alignment.Center) {
                            if (tag == "plusWhatsApp" || tag == "plusWhatsAppShare") WaIcon(29.dp) else Icon(icon, null, Modifier.size(27.dp), tint = tint)
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(action.label.removePrefix("📹 ").removePrefix("📅 "), textAlign = TextAlign.Center,
                            style = MaterialTheme.typography.labelMedium, maxLines = 3, modifier = Modifier.heightIn(min = 42.dp))
                    }
                }
            }
        }
    }
}
