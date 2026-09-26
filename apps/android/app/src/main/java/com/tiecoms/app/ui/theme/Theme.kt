package com.tiecoms.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Marca Chaggu: mandarina #FF5A36, tinta #17161F, papel #F6F3EC.
 * Contraste WCAG AA: la mandarina (#FF5A36) queda para lo decorativo (marca, íconos, rayitas) y para
 * textos/enlaces en tema oscuro (≈5.8:1 sobre tinta; los rellenos mandarina llevan texto tinta). En tema
 * claro los textos, enlaces y botones rellenos de acento usan [OrangeText] #C73A1A (5.2:1 con blanco).
 */
object Brand {
    val Orange = Color(0xFFFF5A36)
    val OrangeText = Color(0xFFC73A1A)
    val Black = Color(0xFF17161F)
    val Cream = Color(0xFFFDFAF7)
    val Paper = Color(0xFFF6F3EC)
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
    ChatColors(Brand.OrangeText, Color.White, Color(0xFFEFEBE7), Brand.Black, Color(0xFF6B6560), Color(0xFFC62828))
}

private val Light = lightColorScheme(
    primary = Brand.OrangeText,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDDD4),
    onPrimaryContainer = Color(0xFF4A1203),
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
    primary = Brand.Orange,
    onPrimary = Brand.Black,
    primaryContainer = Color(0xFF5A1E0E),
    onPrimaryContainer = Color(0xFFFFDAD0),
    secondary = Color(0xFFE8E2DC),
    onSecondary = Brand.Black,
    background = Color(0xFF17161F),
    onBackground = Color(0xFFEDE7E1),
    surface = Color(0xFF17161F),
    onSurface = Color(0xFFEDE7E1),
    surfaceVariant = Color(0xFF2A2933),
    onSurfaceVariant = Color(0xFFBDB5AE),
    surfaceContainer = Color(0xFF1F1E28),
    surfaceContainerHigh = Color(0xFF282733),
    surfaceContainerLow = Color(0xFF1B1A23),
    outline = Color(0xFF7A726B),
    outlineVariant = Color(0xFF3A3944),
    error = Color(0xFFFF8A80),
)

@Composable
fun TieComsTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val chat = if (dark) {
        ChatColors(Color(0xFFC8431F), Color.White, Color(0xFF2B2A34), Color(0xFFEDE7E1), Color(0xFFA59D96), Color(0xFFFF8A80))
    } else {
        ChatColors(Brand.OrangeText, Color.White, Color(0xFFEFEBE7), Brand.Black, Color(0xFF6B6560), Color(0xFFC62828))
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalChatColors provides chat) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
    }
}
