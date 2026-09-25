package com.tiecoms.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

object Brand {
    val Orange = Color(0xFFFF7A00)
    val OrangeLight = Color(0xFFFF8A1F)
    val Black = Color(0xFF1F1F1F)
    val Cream = Color(0xFFFDFAF7)
}

@Immutable
data class ChatColors(
    val mineBubble: Color,
    val onMine: Color,
    val otherBubble: Color,
    val onOther: Color,
    val system: Color,
    val failed: Color,
)

val LocalChatColors = staticCompositionLocalOf {
    ChatColors(Color(0xFFE8710A), Color.White, Color(0xFFEFEBE7), Brand.Black, Color(0xFF6B6560), Color(0xFFC62828))
}

private val Light = lightColorScheme(
    primary = Brand.Orange,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFE3CC),
    onPrimaryContainer = Color(0xFF4A2300),
    secondary = Brand.Black,
    onSecondary = Color.White,
    background = Brand.Cream,
    onBackground = Brand.Black,
    surface = Brand.Cream,
    onSurface = Brand.Black,
    surfaceVariant = Color(0xFFF1ECE6),
    onSurfaceVariant = Color(0xFF5E5852),
    surfaceContainer = Color(0xFFF6F1EC),
    surfaceContainerHigh = Color(0xFFF0EAE4),
    surfaceContainerLow = Color(0xFFFAF6F2),
    outline = Color(0xFFB8AFA7),
    outlineVariant = Color(0xFFE2DAD2),
    error = Color(0xFFC62828),
)

private val Dark = darkColorScheme(
    primary = Brand.OrangeLight,
    onPrimary = Color(0xFF1F1F1F),
    primaryContainer = Color(0xFF5A2B00),
    onPrimaryContainer = Color(0xFFFFDCC2),
    secondary = Color(0xFFE8E2DC),
    onSecondary = Brand.Black,
    background = Color(0xFF151413),
    onBackground = Color(0xFFEDE7E1),
    surface = Color(0xFF151413),
    onSurface = Color(0xFFEDE7E1),
    surfaceVariant = Color(0xFF2A2725),
    onSurfaceVariant = Color(0xFFBDB5AE),
    surfaceContainer = Color(0xFF1F1D1B),
    surfaceContainerHigh = Color(0xFF282523),
    surfaceContainerLow = Color(0xFF1A1817),
    outline = Color(0xFF7A726B),
    outlineVariant = Color(0xFF3A3633),
    error = Color(0xFFFF8A80),
)

@Composable
fun TieComsTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val chat = if (dark) {
        ChatColors(Color(0xFFC75F08), Color.White, Color(0xFF2B2826), Color(0xFFEDE7E1), Color(0xFFA59D96), Color(0xFFFF8A80))
    } else {
        ChatColors(Color(0xFFE8710A), Color.White, Color(0xFFEFEBE7), Brand.Black, Color(0xFF6B6560), Color(0xFFC62828))
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalChatColors provides chat) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
    }
}
