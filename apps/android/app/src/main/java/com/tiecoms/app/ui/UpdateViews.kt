package com.tiecoms.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.AppUpdate

/** «Actualizar»: la ficha de Play en la app (sirve también a testers internos); si no hay Play, la web. */
fun openStore(ctx: Context, url: String?) {
    val pkg = ctx.packageName
    val market = Intent(Intent.ACTION_VIEW, Uri.parse(AppUpdate.marketUri(pkg))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { ctx.startActivity(market) } catch (_: ActivityNotFoundException) {
        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(AppUpdate.webUrl(pkg, url))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}

/**
 * Franja fija de «✨ Actualización disponible · chaggu X», sin cerrar, arriba de todo. Ocupa la barra de estado
 * (statusBarsPadding) y empuja el contenido: quien la usa consume ese inset para que la app no lo sume dos veces.
 */
@Composable
fun UpdateBanner(s: AppUpdate.Status.Available) {
    val ctx = LocalContext.current
    Surface(color = MaterialTheme.colorScheme.inverseSurface, contentColor = MaterialTheme.colorScheme.inverseOnSurface, modifier = Modifier.fillMaxWidth().testTag("updateBanner")) {
        Row(Modifier.statusBarsPadding().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }) {
                Text("✨ " + stringResource(R.string.update_available) + " · chaggu " + s.version, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                    maxLines = 2, overflow = TextOverflow.Ellipsis)
                s.notes?.let { Text(it, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("updateNotes")) }
            }
            Button(onClick = { openStore(ctx, s.url) }, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFF5A36), contentColor = Color.White),
                modifier = Modifier.padding(start = 8.dp).heightIn(min = 40.dp).testTag("updateAction")) { Text(stringResource(R.string.update_action)) }
        }
    }
}

/** versionCode < minBuild: pantalla completa que bloquea la app hasta actualizar. */
@Composable
fun UpdateRequiredScreen(s: AppUpdate.Status.Required) {
    val ctx = LocalContext.current
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize().testTag("updateRequired")) {
        Column(Modifier.fillMaxSize().systemBarsPadding().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Logo(Modifier.widthIn(max = 200.dp).fillMaxWidth(0.5f))
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.update_required), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            Spacer(Modifier.height(20.dp))
            Button(onClick = { openStore(ctx, s.url) }, modifier = Modifier.heightIn(min = 48.dp).testTag("updateAction")) { Text(stringResource(R.string.update_action)) }
        }
    }
}
