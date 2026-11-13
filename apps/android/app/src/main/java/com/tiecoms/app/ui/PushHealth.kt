package com.tiecoms.app.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.R
import com.tiecoms.app.platform.PushSetup

/**
 * CH034: por qué podrían no llegar los avisos en este teléfono, dicho en la lista en vez de fallar en silencio.
 * Una sola franja, por prioridad: notificaciones apagadas → teléfono sin registrar en FCM → ahorro de batería del
 * fabricante (descartable). No pide REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (Play lo restringe para apps con FCM):
 * lleva a los ajustes de la app con los pasos de la marca.
 */
object PushHealth {
    enum class Issue { OFF, FAILED, BATTERY }

    fun issue(notificationsOn: Boolean, health: PushSetup.Health, batteryExempt: Boolean, batteryDismissed: Boolean): Issue? = when {
        !notificationsOn -> Issue.OFF
        health == PushSetup.Health.FAILED -> Issue.FAILED
        !batteryExempt && !batteryDismissed -> Issue.BATTERY
        else -> null
    }

    /** Pasos propios de la marca (además del paso general de batería), o null. */
    fun brandSteps(manufacturer: String): Int? = when (manufacturer.trim().lowercase()) {
        "xiaomi", "redmi", "poco" -> R.string.ph_battery_xiaomi
        "oppo", "realme", "oneplus", "vivo" -> R.string.ph_battery_oppo
        "tecno", "infinix", "itel", "tecno mobile limited", "infinix mobility limited" -> R.string.ph_battery_transsion
        "huawei", "honor" -> R.string.ph_battery_huawei
        "samsung" -> R.string.ph_battery_samsung
        else -> null
    }

    /** Solo se avisa en marcas con ahorro agresivo conocido: en las demás, «Optimizada» no frena a FCM. */
    fun batteryExempt(ctx: Context): Boolean = brandSteps(Build.MANUFACTURER ?: "") == null ||
        runCatching { (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(ctx.packageName) }.getOrDefault(true)

    fun openAppSettings(ctx: Context) {
        val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
        runCatching { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    fun openNotificationSettings(ctx: Context) {
        val i = if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
        runCatching { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}

@Composable
fun PushHealthBanner() {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val health by PushSetup.health.collectAsStateWithLifecycle()
    var notificationsOn by remember { mutableStateOf(container.notifier.enabled()) }
    var batteryExempt by remember { mutableStateOf(PushHealth.batteryExempt(ctx)) }
    var batteryDismissed by remember { mutableStateOf(container.settings.batteryHintDismissed) }
    var guide by remember { mutableStateOf(false) }

    // Al volver de los ajustes del sistema se refleja el estado real.
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) {
                val on = container.notifier.enabled()
                if (on && !notificationsOn) container.retryPushRegistration()
                notificationsOn = on
                batteryExempt = PushHealth.batteryExempt(ctx)
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notificationsOn = container.notifier.enabled()
        if (granted) container.retryPushRegistration() else PushHealth.openNotificationSettings(ctx)
    }

    val issue = PushHealth.issue(notificationsOn, health, batteryExempt, batteryDismissed)
    if (issue != null) {
        val (text, action) = when (issue) {
            PushHealth.Issue.OFF -> R.string.ph_off to R.string.ph_off_action
            PushHealth.Issue.FAILED -> R.string.ph_failed to R.string.ph_failed_action
            PushHealth.Issue.BATTERY -> R.string.ph_battery to R.string.ph_battery_action
        }
        val urgent = issue != PushHealth.Issue.BATTERY
        Surface(
            color = if (urgent) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.fillMaxWidth().testTag("pushHealth-" + issue.name),
        ) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(text), style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    color = if (urgent) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    stringResource(action), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clip(CircleShape).clickable(role = Role.Button) {
                        when (issue) {
                            PushHealth.Issue.OFF -> {
                                // El sistema solo muestra su diálogo mientras no se haya negado dos veces; después, a los ajustes.
                                val activity = ctx as? Activity
                                val canAsk = Build.VERSION.SDK_INT >= 33 && androidx.core.content.ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED &&
                                    (!container.settings.askedNotificationPermission || (activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)))
                                container.settings.askedNotificationPermission = true
                                if (canAsk) permission.launch(Manifest.permission.POST_NOTIFICATIONS) else PushHealth.openNotificationSettings(ctx)
                            }
                            PushHealth.Issue.FAILED -> { PushSetup.health.value = PushSetup.Health.UNKNOWN; container.retryPushRegistration() }
                            PushHealth.Issue.BATTERY -> guide = true
                        }
                    }.heightIn(min = 32.dp).padding(horizontal = 6.dp, vertical = 6.dp).testTag("pushHealthAction"),
                )
            }
        }
    }
    if (guide) AlertDialog(
        onDismissRequest = { guide = false },
        title = { Text(stringResource(R.string.ph_battery_title)) },
        text = {
            val brand = PushHealth.brandSteps(Build.MANUFACTURER ?: "")
            Text(stringResource(R.string.ph_battery_body) + "\n\n" + stringResource(brand ?: R.string.ph_battery_generic) +
                if (brand != null && brand != R.string.ph_battery_samsung && brand != R.string.ph_battery_transsion) "\n" + stringResource(R.string.ph_battery_generic) else "")
        },
        confirmButton = { TextButton(onClick = { guide = false; PushHealth.openAppSettings(ctx) }, modifier = Modifier.testTag("pushHealthOpen")) { Text(stringResource(R.string.ph_battery_open)) } },
        dismissButton = { TextButton(onClick = { guide = false; container.settings.batteryHintDismissed = true; batteryDismissed = true }, modifier = Modifier.testTag("pushHealthDone")) { Text(stringResource(R.string.ph_battery_done)) } },
    )
}
