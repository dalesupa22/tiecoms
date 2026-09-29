package com.tiecoms.app.ui

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.size

/*
 * Iconos de Gmail, Outlook y WhatsApp: los mismos trazos SVG de apps/web/src/screens/Mail.tsx.
 * Colores de marca fijos (no cambian con el tema oscuro).
 */

private fun ImageVector.Builder.fill(color: Long, d: String, alpha: Float = 1f) =
    addPath(addPathNodes(d), fill = SolidColor(Color(color)), fillAlpha = alpha)

private val GmailIcon: ImageVector by lazy {
    ImageVector.Builder("Gmail", 48.dp, 48.dp, 48f, 48f).apply {
        fill(0xFF4CAF50, "M45 16.2l-5 2.75-5 4.75V40h7a3 3 0 0 0 3-3V16.2z")
        fill(0xFF1E88E5, "M3 16.2l3.61 1.71L13 23.7V40H6a3 3 0 0 1-3-3V16.2z")
        fill(0xFFE53935, "M35 11.2L24 19.45 13 11.2l-1 5.8 1 6.7 11 8.25 11-8.25 1-6.7z")
        fill(0xFFC62828, "M3 12.3v3.9l10 7.5V11.2L9.88 8.86A4.14 4.14 0 0 0 3 12.3z")
        fill(0xFFFBC02D, "M45 12.3v3.9l-10 7.5V11.2l3.12-2.34A4.14 4.14 0 0 1 45 12.3z")
    }.build()
}

private val OutlookIcon: ImageVector by lazy {
    ImageVector.Builder("Outlook", 48.dp, 48.dp, 48f, 48f).apply {
        fill(0xFF1A73C9, "M18 10h24a2 2 0 0 1 2 2v24a2 2 0 0 1-2 2H18z")
        fill(0xFF50B4F0, "M44 16 30 25 18 17v-5h24a2 2 0 0 1 2 2z", alpha = 0.85f)
        // <rect x=4 y=12 w=24 h=24 rx=3>
        fill(0xFF0A5AA8, "M7 12h18a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z")
        // <ellipse cx=16 cy=24 rx=6.2 ry=7.4> con trazo blanco de 3.2
        path(stroke = SolidColor(Color.White), strokeLineWidth = 3.2f) {
            moveTo(9.8f, 24f)
            arcTo(6.2f, 7.4f, 0f, isMoreThanHalf = true, isPositiveArc = false, 22.2f, 24f)
            arcTo(6.2f, 7.4f, 0f, isMoreThanHalf = true, isPositiveArc = false, 9.8f, 24f)
            close()
        }
    }.build()
}

private val WhatsAppIcon: ImageVector by lazy {
    ImageVector.Builder("WhatsApp", 24.dp, 24.dp, 24f, 24f).apply {
        fill(0xFF25D366, "M1 12a11 11 0 1 0 22 0a11 11 0 1 0 -22 0z")
        fill(0xFFFFFFFF, "M16.9 14.3c-.3-.1-1.6-.8-1.8-.9-.3-.1-.4-.1-.6.1l-.8 1c-.2.2-.3.2-.6.1a6.6 6.6 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.5l-.8-2c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1.1 2.7.1.2 1.8 2.8 4.4 3.9 1.7.7 2.3.8 3.1.6.5-.1 1.6-.6 1.8-1.3.2-.6.2-1.1.2-1.3-.1 0-.2-.1-.5-.2z")
    }.build()
}

/** Icono de Gmail (google) u Outlook (microsoft). */
@Composable
fun ProviderIcon(provider: String, size: Dp = 18.dp, modifier: Modifier = Modifier) {
    val label = com.tiecoms.app.core.Mail.label(provider)
    Image(if (provider == "microsoft") OutlookIcon else GmailIcon, null, contentScale = ContentScale.Fit,
        modifier = modifier.size(size).semantics { contentDescription = label }.testTag("provIcon-$provider"))
}

@Composable
fun WaIcon(size: Dp = 18.dp, modifier: Modifier = Modifier) {
    Image(WhatsAppIcon, null, modifier = modifier.size(size).semantics { contentDescription = "WhatsApp" }.testTag("waIcon"))
}
