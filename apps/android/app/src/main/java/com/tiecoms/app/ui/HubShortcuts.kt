package com.tiecoms.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.MailOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R

/**
 * Pestaña «Todo» / «Hub» (variante 2 del mockup aprobado, 30-sep-2026): el ícono es una cuadrícula de 3 cuadros
 * con un chulito en el cuarto (abajo a la derecha), para que se siga leyendo como tareas.
 * [filled] es la versión seleccionada: los tres cuadros rellenos.
 */
object TodoIcons {
    val outlined: ImageVector by lazy { build(filled = false) }
    val filled: ImageVector by lazy { build(filled = true) }

    private fun build(filled: Boolean) = ImageVector.Builder(
        name = if (filled) "TodoGridFilled" else "TodoGridOutlined",
        defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
    ).apply {
        // Un cuadro redondeado (radio 1,8) de 6,5 × 6,5 en (x, y).
        fun square(x: Float, y: Float) = path(
            fill = if (filled) SolidColor(Color.Black) else null,
            stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f,
            strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeLineJoinRound,
        ) {
            val s = 6.5f; val r = 1.8f
            moveTo(x + r, y); lineTo(x + s - r, y); arcTo(r, r, 0f, false, true, x + s, y + r)
            lineTo(x + s, y + s - r); arcTo(r, r, 0f, false, true, x + s - r, y + s)
            lineTo(x + r, y + s); arcTo(r, r, 0f, false, true, x, y + s - r)
            lineTo(x, y + r); arcTo(r, r, 0f, false, true, x + r, y); close()
        }
        square(4f, 4f); square(13.5f, 4f); square(4f, 13.5f)
        path(stroke = SolidColor(Color.Black), strokeLineWidth = 2.1f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeLineJoinRound) {
            moveTo(13.9f, 16.9f); lineTo(16.1f, 19.1f); lineTo(20.1f, 14.9f)
        }
    }.build()

    private val StrokeLineJoinRound = StrokeJoin.Round
}

/** Colores de marca de cada atajo (como en el mockup): Correo azul, WhatsApp verde, Archivos ámbar, Trazo morado. */
private val HubMailBlue = Color(0xFF3B73D9)
private val HubWaGreen = Color(0xFF25A35A)
private val HubFilesAmber = Color(0xFFB27A12)
private val HubTraceViolet = Color(0xFF7D4BC2)

private data class HubShortcut(val route: String, val label: Int, val icon: ImageVector, val color: Color, val count: Int, val tag: String)

/**
 * Fila compacta y deslizable de atajos arriba de Tareas: Correo (solo con el correo prendido en el servidor, con GET /mail/unread), WhatsApp
 * (con sus no leídos, que ya da GET /whatsapp/chats), Archivos y Trazo. Pastillas pequeñas y discretas: el protagonista
 * sigue siendo la lista de Tareas. Cada una abre la misma pantalla que su fila de «Tú».
 */
@Composable
fun HubShortcuts(onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val client = LocalClient.current
    val st by client.state.collectAsStateWithLifecycle()
    val mailOn = st.data?.mailEnabled == true
    var waUnread by remember { mutableIntStateOf(0) }
    // Los no leídos de WhatsApp: los mismos contadores por categoría que usa la pantalla de WhatsApp.
    LaunchedEffect(st.waRevision) {
        runCatching { client.waChats(null, null, null, false, null) }
            .onSuccess { p -> waUnread = p.categories.values.sumOf { it.unread } }
            .onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
    }
    // Correo: GET /mail/unread al abrir Todo; si falla, la pastilla va sin número.
    var mailUnread by remember { mutableIntStateOf(0) }
    LaunchedEffect(mailOn) {
        if (mailOn) runCatching { client.mailUnread() }
            .onSuccess { mailUnread = it }
            .onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; mailUnread = 0 }
    }
    val items = listOfNotNull(
        HubShortcut("mailbox?conv=", R.string.web_mail_title, Icons.Outlined.MailOutline, HubMailBlue, mailUnread, "hubMail").takeIf { mailOn },
        HubShortcut("whatsapp", R.string.nav_whatsapp, Icons.AutoMirrored.Outlined.Chat, HubWaGreen, waUnread, "hubWhatsApp"),
        HubShortcut("files", R.string.nav_files, Icons.Outlined.Folder, HubFilesAmber, 0, "hubFiles"),
        HubShortcut("trazo", R.string.nav_trazo, Icons.Outlined.AccountTree, HubTraceViolet, 0, "hubTrazo"),
    )
    val cs = MaterialTheme.colorScheme
    LazyRow(
        modifier.testTag("hubShortcuts"),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = PaddingValues(vertical = 2.dp),
    ) {
        items(items, key = { it.route }) { s ->
            val name = stringResource(s.label)
            val cd = if (s.count > 0) name + " · " + stringResource(R.string.hub_unread, s.count) else name
            Surface(
                onClick = { onOpen(s.route) },
                shape = RoundedCornerShape(50), color = cs.surfaceContainerLow,
                border = BorderStroke(1.dp, cs.outlineVariant.copy(alpha = 0.7f)),
                modifier = Modifier.heightIn(min = 32.dp).semantics(mergeDescendants = true) { contentDescription = cd }.testTag(s.tag),
            ) {
                Row(Modifier.padding(start = 8.dp, end = 10.dp, top = 5.dp, bottom = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(s.icon, null, Modifier.size(15.dp), tint = s.color)
                    Spacer(Modifier.width(5.dp))
                    Text(name, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurfaceVariant, maxLines = 1)
                    if (s.count > 0) {
                        Spacer(Modifier.width(5.dp))
                        Text(if (s.count > 99) "99+" else s.count.toString(), fontSize = 10.5.sp, fontWeight = FontWeight.Bold, color = cs.primary, maxLines = 1)
                    }
                }
            }
        }
    }
}
