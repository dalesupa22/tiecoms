package com.tiecoms.app.ui

import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiecoms.app.R
import com.tiecoms.app.core.SplashChoreo
import com.tiecoms.app.core.SplashChoreo.Mode
import com.tiecoms.app.platform.Sound
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

private val OrangeRope = Color(0xFFFF5A36) // mandarina Chaggu
private val OrangeEdge = Color(0xFFC8401F)

/**
 * Splash animado «Un solo hilo» (SPEC-v2 §4), dibujado en un Canvas a 60 fps a partir de
 * la función pura [SplashChoreo.frame]. [ready] indica que la app ya puede mostrarse.
 */
@Composable
fun SplashOverlay(mode: Mode, ready: Boolean, onFinished: () -> Unit) {
    val ctx = LocalContext.current
    val container = LocalContainer.current
    val view = LocalView.current
    val dark = isSystemInDarkTheme()
    val reduce = remember {
        runCatching { Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }.getOrDefault(1f) == 0f
    }
    val effMode = if (reduce) Mode.REDUCED else mode
    val readyNow by rememberUpdatedState(ready)
    var t by remember { mutableFloatStateOf(if (effMode == Mode.SHORT) SplashChoreo.LOGO_START else 0f) }
    var waited by remember { mutableFloatStateOf(0f) }
    var skip by remember { mutableStateOf(false) }
    var readyLatched by remember { mutableStateOf(false) }

    LaunchedEffect(effMode) {
        var start = -1L
        var prev = -1L
        var virt = 0L // tiempo de coreografía en ns; cada fotograma avanza como máximo 50 ms (si el hilo se traba, no se salta fases)
        var soundDone = effMode != Mode.FULL
        var hapticDone = effMode != Mode.FULL
        var holdStart = -1L
        while (true) {
            val now = withFrameNanos { it }
            // El reloj arranca en el primer fotograma fluido: la composición inicial de la app (debajo)
            // suele trabar los primeros cuadros y no queremos que se coma el comienzo de la animación.
            if (start < 0) {
                val smooth = prev >= 0 && now - prev < 40_000_000L
                prev = now
                if (!smooth) continue
                start = now; container.splashStartedAt = android.os.SystemClock.uptimeMillis()
            }
            virt += minOf(now - prev, 50_000_000L); prev = now
            val real = virt / 1e9f
            // Pasados 6 s se sigue con lo que haya en caché.
            val ok = readyNow || real > SplashChoreo.MAX_WAIT
            readyLatched = ok
            var tl = if (skip) SplashChoreo.EXIT_START.coerceAtLeast(t) else SplashChoreo.timelineTime(real, effMode)
            if (effMode != Mode.REDUCED && !ok && tl >= SplashChoreo.EXIT_START) {
                if (holdStart < 0) holdStart = now
                waited = (now - holdStart) / 1e9f
                tl = SplashChoreo.EXIT_START
            } else if (effMode != Mode.REDUCED && holdStart >= 0 && ok) {
                // Al terminar de cargar, la salida arranca desde donde esperaba.
                tl = SplashChoreo.EXIT_START + (now - holdStart) / 1e9f - waited
            }
            if (skip && ok) { container.splashEndedAt = android.os.SystemClock.uptimeMillis(); onFinished(); return@LaunchedEffect }
            t = tl
            if (!soundDone && tl >= SplashChoreo.SOUND_AT) { soundDone = true; container.sounds.play(Sound.SPLASH) }
            if (!hapticDone && tl >= SplashChoreo.HAPTIC_AT) { hapticDone = true; view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK) }
            val f = SplashChoreo.frame(tl, ok, waited, effMode)
            if (f.phase == SplashChoreo.Phase.DONE || (effMode == Mode.REDUCED && ok && tl > SplashChoreo.duration(Mode.REDUCED))) {
                container.splashEndedAt = android.os.SystemClock.uptimeMillis(); onFinished(); return@LaunchedEffect
            }
        }
    }

    val frame = SplashChoreo.frame(t, readyLatched, waited, effMode)
    val bg = if (dark) Color(0xFF17161F) else Color(0xFFFDFAF7)
    val ink = ImageBitmap.imageResource(if (dark) R.drawable.splash_ink_light else R.drawable.splash_ink)
    val orange = ImageBitmap.imageResource(if (dark) R.drawable.splash_orange_dark else R.drawable.splash_orange)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val slogan = listOf(stringResource(R.string.splash_line1), stringResource(R.string.splash_line2), stringResource(R.string.splash_line3))
    val grey = if (dark) Color(0xFFA59D96) else Color(0xFF6B6560)
    val strong = if (dark) Color(0xFFF6F3EC) else Color(0xFF17161F)
    val a11y = stringResource(R.string.splash_a11y)

    Box(
        Modifier.fillMaxSize()
            .background(bg.copy(alpha = frame.exitAlpha))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { skip = true }
            .semantics { contentDescription = a11y }
            .testTag("splash"),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width; val h = size.height
            val center = Offset(w / 2, h / 2)
            val logoW = min(w * 0.78f, with(density) { 420.dp.toPx() })
            val logoH = logoW * SplashChoreo.LOGO_ASPECT
            // El logo queda centrado; el nudo (la burbuja mandarina de la «g») queda a la altura del centro.
            val logoTopLeft = Offset(center.x - logoW / 2f, center.y - logoH * SplashChoreo.KNOT_FY)
            val knot = Offset(logoTopLeft.x + logoW * SplashChoreo.KNOT_FX, center.y)
            scale(frame.exitScale, pivot = center) {
                drawPeople(frame, w, h, knot, measurer, density.density)
                drawBirth(frame, knot, logoW)
                drawLogo(frame, ink, orange, logoTopLeft, logoW, logoH, knot)
                drawSlogan(frame, slogan, measurer, logoTopLeft.y + logoH, w, grey, strong, density.density, density.fontScale)
            }
        }
    }
}

private fun DrawScope.drawPeople(f: SplashChoreo.Frame, w: Float, h: Float, knot: Offset, tm: androidx.compose.ui.text.TextMeasurer, dp: Float) {
    if (f.nodeAlpha.all { it <= 0f } && f.rope <= 0f) return
    val base = f.nodeAlpha.maxOrNull() ?: 0f
    val pts = SplashChoreo.PEOPLE.map { p ->
        val home = Offset(w / 2 + p.fx * w, h / 2 + p.fy * h)
        home + (knot - home) * f.gather
    }
    rotate(f.rotationDeg, pivot = knot) {
        // Hilo: Catmull-Rom por las cinco personas, recortado con PathMeasure.
        if (f.rope > 0f) {
            val path = catmullRom(pts)
            val pm = PathMeasure().apply { setPath(path, false) }
            val seg = Path()
            pm.getSegment(0f, pm.length * f.rope, seg, true)
            val a = f.ropeAlpha
            drawPath(seg, OrangeEdge.copy(alpha = a), style = Stroke(width = 7 * dp, cap = StrokeCap.Round, join = StrokeJoin.Round))
            drawPath(seg, OrangeRope.copy(alpha = a), style = Stroke(width = 5 * dp, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        val r = 22 * dp
        SplashChoreo.PEOPLE.forEachIndexed { i, p ->
            val alpha = f.nodeAlpha[i]
            val s = f.nodeScale[i] * (1f - 0.35f * f.gather)
            if (alpha <= 0f || s <= 0f) return@forEachIndexed
            val c = pts[i]
            // Sombra suave.
            drawCircle(Color.Black.copy(alpha = 0.10f * alpha), radius = r * s * 1.08f, center = c + Offset(0f, 2.5f * dp))
            if (f.ringScale[i] > 0f) {
                drawCircle(OrangeRope.copy(alpha = alpha), radius = (r + 4 * dp) * s * f.ringScale[i], center = c, style = Stroke(width = 3 * dp))
            }
            drawCircle(Color(p.color).copy(alpha = alpha), radius = r * s, center = c)
            val label = tm.measure(p.initials, TextStyle(color = Color.White.copy(alpha = alpha), fontSize = (15 * s).coerceAtLeast(1f).sp, fontWeight = FontWeight.Bold))
            drawText(label, topLeft = c - Offset(label.size.width / 2f, label.size.height / 2f))
            val company = tm.measure(p.company, TextStyle(color = Color(0xFF8A827B).copy(alpha = alpha * (1f - f.gather)), fontSize = 11.sp))
            drawText(company, topLeft = c + Offset(-company.size.width / 2f, r * s + 5 * dp))
        }
    }
    if (base <= 0f) return
}

private fun catmullRom(p: List<Offset>): Path {
    val path = Path()
    if (p.isEmpty()) return path
    path.moveTo(p[0].x, p[0].y)
    for (i in 0 until p.size - 1) {
        val p0 = p[maxOf(0, i - 1)]; val p1 = p[i]; val p2 = p[i + 1]; val p3 = p[minOf(p.size - 1, i + 2)]
        val c1 = p1 + (p2 - p0) / 6f
        val c2 = p2 - (p3 - p1) / 6f
        path.cubicTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y)
    }
    return path
}

private fun DrawScope.drawBirth(f: SplashChoreo.Frame, knot: Offset, logoW: Float) {
    if (f.pulseAlpha > 0f) {
        drawCircle(OrangeRope.copy(alpha = f.pulseAlpha), radius = logoW * 0.28f * f.pulseRadius, center = knot)
    }
    if (f.sparks > 0f) {
        for (k in 0 until SplashChoreo.SPARKS) {
            val (angle, speed, delay) = SplashChoreo.spark(k)
            val p = ((f.sparks - delay) / (1f - delay)).coerceIn(0f, 1f)
            if (p <= 0f) continue
            val dist = logoW * 0.32f * speed * p
            val fall = logoW * 0.18f * p * p // gravedad: caen después de salir en abanico
            val pos = knot + Offset(cos(angle) * dist, sin(angle) * dist + fall)
            drawCircle(OrangeRope.copy(alpha = (1f - p)), radius = logoW * 0.011f * (1f - 0.5f * p), center = pos)
        }
    }
}

private fun DrawScope.drawLogo(f: SplashChoreo.Frame, ink: ImageBitmap, orange: ImageBitmap, topLeft: Offset, w: Float, h: Float, knot: Offset) {
    val dst = IntSize(w.toInt(), h.toInt())
    val at = IntOffset(topLeft.x.toInt(), topLeft.y.toInt())
    if (f.inkReveal > 0f) {
        // La tinta se «escribe» de izquierda a derecha.
        clipRect(left = topLeft.x, top = topLeft.y - h, right = topLeft.x + w * f.inkReveal, bottom = topLeft.y + h * 2) {
            drawImage(ink, srcOffset = IntOffset.Zero, srcSize = IntSize(ink.width, ink.height), dstOffset = at, dstSize = dst)
        }
    }
    if (f.orangeAlpha > 0f) {
        scale(f.orangeScale, pivot = knot) {
            drawImage(orange, srcOffset = IntOffset.Zero, srcSize = IntSize(orange.width, orange.height), dstOffset = at, dstSize = dst, alpha = f.orangeAlpha)
        }
    }
}

private fun DrawScope.drawSlogan(
    f: SplashChoreo.Frame, lines: List<String>, tm: androidx.compose.ui.text.TextMeasurer, logoBottom: Float, w: Float,
    grey: Color, strong: Color, dp: Float, fontScale: Float,
) {
    // Tamaños fijos en pt/dp (como iOS), independientes de la escala de fuente del sistema.
    val styles = listOf(
        TextStyle(color = grey, fontSize = (15f / fontScale).sp, textAlign = TextAlign.Center),
        TextStyle(color = strong, fontSize = (22f / fontScale).sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center),
        TextStyle(color = OrangeRope, fontSize = (22f / fontScale).sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center),
    )
    var y = logoBottom + 22 * dp
    lines.forEachIndexed { i, text ->
        val a = f.sloganAlpha[i]
        val layout = tm.measure(text, styles[i].copy(color = styles[i].color.copy(alpha = a)))
        if (a > 0f) drawText(layout, topLeft = Offset((w - layout.size.width) / 2f, y + f.sloganOffset[i] * dp))
        y += layout.size.height + (if (i == 0) 10 else 2) * dp
    }
    if (f.waitingDot > 0f) {
        drawCircle(OrangeRope.copy(alpha = 0.35f + 0.65f * f.waitingDot), radius = (4 + 2 * f.waitingDot) * dp, center = Offset(w / 2, y + 18 * dp))
    }
}
