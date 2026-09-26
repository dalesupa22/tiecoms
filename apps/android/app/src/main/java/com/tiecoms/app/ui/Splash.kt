package com.tiecoms.app.ui

import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiecoms.app.R
import com.tiecoms.app.core.SplashChoreo
import com.tiecoms.app.core.SplashChoreo.Mode
import com.tiecoms.app.platform.Sound

private val Ink = Color(0xFF17161F)
private val Paper = Color(0xFFF6F3EC)

/**
 * Splash animado de «ignición» sobre la app, siempre en tinta. Empieza con el mismo símbolo, tamaño
 * y posición que el splash del sistema (lienzo de [SplashChoreo.CANVAS_DP] centrado en la pantalla)
 * y lo dibuja a partir de la función pura [SplashChoreo.frame]. [ready] indica que la app ya puede mostrarse.
 */
@Composable
fun SplashOverlay(mode: Mode, ready: Boolean, onFinished: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val view = LocalView.current
    val reduce = remember {
        runCatching { Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }.getOrDefault(1f) == 0f
    }
    val effMode = if (reduce && mode == Mode.FULL) Mode.REDUCED else mode
    val readyNow by rememberUpdatedState(ready)
    // Solo depuración: fotograma congelado (`am start … --ef splashFreeze 0.45`).
    val freeze = container.splashFreezeAt
    var t by remember { mutableFloatStateOf(freeze ?: SplashChoreo.startTime(effMode)) }
    var skip by remember { mutableStateOf(false) }

    LaunchedEffect(effMode) {
        var start = -1L
        var prev = -1L
        while (true) {
            val now = withFrameNanos { it }
            if (freeze != null) {
                if (skip) { onFinished(); return@LaunchedEffect }
                continue
            }
            // El reloj arranca en el primer fotograma fluido: la composición inicial de la app (debajo)
            // suele trabar los primeros cuadros y no queremos que se coma el comienzo de la animación.
            if (start < 0) {
                val smooth = prev >= 0 && now - prev < 40_000_000L
                prev = now
                if (!smooth) continue
                start = now; container.splashStartedAt = android.os.SystemClock.uptimeMillis()
            }
            // Cada fotograma avanza como máximo 50 ms: si el hilo se traba, no se salta fases.
            val dt = minOf(now - prev, 50_000_000L) / 1e9f; prev = now
            val real = (now - start) / 1e9f
            val before = t
            val next = SplashChoreo.step(before, dt, SplashChoreo.canExit(readyNow, real), skip)
            skip = false
            if (SplashChoreo.crossed(before, next, SplashChoreo.FEEDBACK_AT)) {
                container.sounds.play(Sound.SPLASH)
                view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
            }
            t = next
            if (SplashChoreo.frame(next, effMode).phase == SplashChoreo.Phase.DONE) {
                container.splashEndedAt = android.os.SystemClock.uptimeMillis(); onFinished(); return@LaunchedEffect
            }
        }
    }

    val frame = SplashChoreo.frame(t, effMode)
    val paper = ImageBitmap.imageResource(R.drawable.splash_layer_paper)
    val orange = ImageBitmap.imageResource(R.drawable.splash_layer_orange)
    val sparks = ImageBitmap.imageResource(R.drawable.splash_layer_sparks)
    val slogan = stringResource(R.string.splash_slogan)
    val a11y = stringResource(R.string.splash_a11y)

    BoxWithConstraints(
        Modifier.fillMaxSize()
            .graphicsLayer { alpha = frame.exitAlpha }
            .background(Ink)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { skip = true }
            .semantics { contentDescription = a11y }
            .testTag("splash"),
    ) {
        val side = SplashChoreo.CANVAS_DP.dp
        Canvas(Modifier.size(side).align(Alignment.Center).graphicsLayer { scaleX = frame.exitScale; scaleY = frame.exitScale }) {
            drawLayer(paper)
            scale(frame.orangeScale, pivot = Offset(size.width * SplashChoreo.POP_PIVOT_X, size.height * SplashChoreo.POP_PIVOT_Y)) {
                drawLayer(orange)
            }
            if (frame.sparksAlpha > 0f) {
                scale(frame.sparksScale, pivot = Offset(size.width * SplashChoreo.SPARKS_PIVOT_X, size.height * SplashChoreo.SPARKS_PIVOT_Y)) {
                    drawLayer(sparks, frame.sparksAlpha)
                }
            }
        }
        // Eslogan debajo del símbolo (el borde inferior del lienzo queda ~38 dp bajo las burbujas).
        Text(
            slogan,
            color = Paper.copy(alpha = frame.sloganAlpha),
            fontSize = 17.sp,
            lineHeight = 22.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.align(Alignment.TopCenter).fillMaxWidth().padding(horizontal = 32.dp)
                .offset(y = maxHeight / 2 + side / 2 + frame.sloganOffsetDp.dp),
        )
    }
}

private fun DrawScope.drawLayer(img: ImageBitmap, alpha: Float = 1f) {
    drawImage(
        img, srcOffset = IntOffset.Zero, srcSize = IntSize(img.width, img.height),
        dstOffset = IntOffset.Zero, dstSize = IntSize(size.width.toInt(), size.height.toInt()),
        alpha = alpha, filterQuality = FilterQuality.High,
    )
}
