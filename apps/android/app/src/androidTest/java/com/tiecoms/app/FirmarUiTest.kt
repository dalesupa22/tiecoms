package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.MemorySecretStore
import com.tiecoms.app.core.MemoryStorage
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.TieComsClient
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Firmar PDFs en el teléfono contra el API de pruebas (3056, rama firmar-pdf): el otro manda un PDF de 3 páginas
 * (la 3 girada 90°) al grupo; «✍️ Firmar» en la burbuja → crear firma dibujada → arrastrarla dentro de la página y a
 * otra página, agrandarla con el asa, duplicarla, fecha llevada con desplazamiento automático hasta la página girada,
 * confirmar y enviar; el adjunto firmado vuelve con «✓ Firmado por» y aparece en «Documentos que firmé».
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3056 -e email … -e peerEmail … -e password … -e conversationId … \
 *     -e class com.tiecoms.app.FirmarUiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class FirmarUiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[firmar] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private val outDir get() = ins.targetContext.getExternalFilesDir(null)!!
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun count(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().size
    private fun bounds(tag: String, i: Int = 0): Rect = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes()[i].boundsInRoot
    private fun descs(tag: String): List<String> = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes()
        .mapNotNull { n -> if (n.config.contains(SemanticsProperties.ContentDescription)) n.config[SemanticsProperties.ContentDescription].firstOrNull() else null }
    private fun shot(name: String) {
        Thread.sleep(700)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(outDir, "firmar-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /**
     * El reloj de Compose en pruebas solo avanza cuando la prueba lo pide: con eventos inyectados a mano hay que
     * darle un cuadro después de cada uno (recomposición y withFrameNanos), como pasaría en el teléfono.
     */
    private fun frame() { Thread.sleep(8); compose.mainClock.advanceTimeByFrame() }

    /**
     * Arrastre con eventos reales del sistema (tiempo real, como un dedo): baja en [from], va a [to] en [moveMs] y se
     * queda [holdMs] ahí (con movimientos mínimos, como un dedo de verdad) antes de soltar. Coordenadas de pantalla.
     */
    private fun fingerDrag(from: Offset, to: Offset, moveMs: Long = 500, holdMs: Long = 0) {
        val ui = ins.uiAutomation
        val t0 = SystemClock.uptimeMillis()
        fun ev(action: Int, p: Offset, t: Long) = MotionEvent.obtain(t0, t, action, p.x, p.y, 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
        ui.injectInputEvent(ev(MotionEvent.ACTION_DOWN, from, t0), true)
        frame()
        val steps = (moveMs / 16).toInt().coerceAtLeast(4)
        for (i in 1..steps) {
            frame()
            val k = i / steps.toFloat()
            ui.injectInputEvent(ev(MotionEvent.ACTION_MOVE, from + (to - from) * k, SystemClock.uptimeMillis()), true)
        }
        var held = 0L
        var wiggle = 1f
        while (held < holdMs) { frame(); held += 16; wiggle = -wiggle; ui.injectInputEvent(ev(MotionEvent.ACTION_MOVE, to + Offset(wiggle, 0f), SystemClock.uptimeMillis()), true) }
        ui.injectInputEvent(ev(MotionEvent.ACTION_UP, to, SystemClock.uptimeMillis()), true)
        frame(); compose.waitForIdle()
        Thread.sleep(300)
    }

    /** Pellizco con dos dedos reales alrededor de [c]: la distancia entre dedos pasa de [from] a [to] px en horizontal. */
    private fun fingerPinch(c: Offset, from: Float, to: Float, moveMs: Long = 600) {
        val ui = ins.uiAutomation
        val t0 = SystemClock.uptimeMillis()
        fun ev(action: Int, d: Float, n: Int): MotionEvent {
            val props = Array(n) { i -> MotionEvent.PointerProperties().apply { id = i; toolType = MotionEvent.TOOL_TYPE_FINGER } }
            val coords = Array(n) { i -> MotionEvent.PointerCoords().apply { x = c.x + (if (i == 0) -d / 2 else d / 2); y = c.y; pressure = 1f; size = 1f } }
            return MotionEvent.obtain(t0, SystemClock.uptimeMillis(), action, n, props, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
        }
        ui.injectInputEvent(ev(MotionEvent.ACTION_DOWN, from, 1), true); frame()
        ui.injectInputEvent(ev(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), from, 2), true); frame()
        val steps = (moveMs / 16).toInt().coerceAtLeast(4)
        for (i in 1..steps) { frame(); ui.injectInputEvent(ev(MotionEvent.ACTION_MOVE, from + (to - from) * i / steps, 2), true) }
        ui.injectInputEvent(ev(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), to, 2), true); frame()
        ui.injectInputEvent(ev(MotionEvent.ACTION_UP, to, 1), true)
        frame(); compose.waitForIdle(); Thread.sleep(300)
    }

    /** Raíz de Compose (el diálogo del visor) → pantalla: el diálogo va a pantalla completa, así que coinciden. */
    private fun center(r: Rect) = r.center

    @Test
    fun firmarUnPdfConElDedo() {
        val apiUrl = arg("apiUrl"); val email = arg("email"); val peerEmail = arg("peerEmail"); val password = arg("password"); val conv = arg("conversationId")
        assumeTrue("Faltan argumentos del fixture", apiUrl.isNotBlank() && email.isNotBlank() && peerEmail.isNotBlank() && password.isNotBlank() && conv.isNotBlank())
        assertFalse("Nunca contra producción", apiUrl.contains("app.tiecoms.com") || apiUrl.contains("app.chaggu.com"))
        ins.runOnMainSync { app.container.setDebugApiUrl(apiUrl) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val peer = TieComsClient(apiUrl, "Peer", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            compose.waitUntil(20_000) { exists("email") && !exists("splash") }
            compose.onNodeWithTag("email").performTextInput(email)
            compose.onNodeWithTag("password").performTextInput(password)
            compose.onNodeWithTag("login").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("quick.create"), 20_000)
            val client = app.container.client.value
            // Las firmas que ya tenga la cuenta no se tocan (otras pruebas pueden usarla); al final se borran solo las nuevas.
            val savedBefore = runBlocking { com.tiecoms.app.ui.SavedSignatures.ensure(client, force = true); client.listSignatures().map { it.id }.toSet() }

            // El otro manda la póliza de 3 páginas (la 3 girada).
            runBlocking { peer.login(peerEmail, password); peer.openConversation(conv) }
            val pdfFile = PdfFixture.write(File(ins.targetContext.cacheDir, "Poliza UI.pdf"), listOf(0, 0, 90))
            val att: AttachmentDTO = runBlocking {
                val a = peer.uploadAttachment(conv, pdfFile, "Póliza UI ${System.currentTimeMillis() % 10000}.pdf", "application/pdf")
                peer.send(conv, "Por favor firma", attachments = listOf(a))
                a
            }
            log("PDF enviado por el otro: ${att.id}")

            compose.waitUntilAtLeastOneExists(hasTestTag("conv-$conv"), 15_000)
            compose.onNodeWithTag("conv-$conv").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("attSign-${att.id}"), 20_000)
            shot("01-burbuja")
            compose.onNodeWithTag("attSign-${att.id}", useUnmergedTree = true).performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("pdfPage-1"), 20_000)
            compose.waitUntilAtLeastOneExists(hasTestTag("toolSignature"), 5_000)
            Thread.sleep(800)
            shot("02-visor-firma")
            log("Visor en modo firma con ${count("pdfPage-1") + count("pdfPage-2")} páginas visibles")

            // Dejar el borde entre la página 1 y la 2 a ~70 % de la hoja, arrastrando despacio el papel (no una marca).
            val stage = bounds("pdfPages")
            val p1 = bounds("pdfPage-1")
            val target = stage.top + stage.height * 0.7f
            val need = p1.bottom - target
            fingerDrag(Offset(stage.left + 30f, stage.bottom - 60f), Offset(stage.left + 30f, stage.bottom - 60f - need), moveMs = 900, holdMs = 300)
            Thread.sleep(500)
            log("Borde de la página 1 en ${bounds("pdfPage-1").bottom} (objetivo $target)")

            // Firma nueva: Crear → dibujar con el dedo → Guardar y usar.
            // Sin firmas guardadas «Firma» abre directo «Crear»; con firmas, «Mis firmas» › «＋ Nueva firma».
            compose.onNodeWithTag("toolSignature").performClick()
            compose.waitUntil(10_000) { exists("sigPad") || exists("newSig") }
            if (!exists("sigPad")) { shot("03a-mis-firmas"); compose.onNodeWithTag("newSig", useUnmergedTree = true).performClick() }
            compose.waitUntilAtLeastOneExists(hasTestTag("sigPad"), 10_000)
            val pad = bounds("sigPad")
            fingerDrag(Offset(pad.left + pad.width * 0.12f, pad.top + pad.height * 0.65f), Offset(pad.left + pad.width * 0.45f, pad.top + pad.height * 0.25f), moveMs = 350)
            fingerDrag(Offset(pad.left + pad.width * 0.45f, pad.top + pad.height * 0.25f), Offset(pad.left + pad.width * 0.6f, pad.top + pad.height * 0.7f), moveMs = 250)
            fingerDrag(Offset(pad.left + pad.width * 0.6f, pad.top + pad.height * 0.7f), Offset(pad.left + pad.width * 0.88f, pad.top + pad.height * 0.3f), moveMs = 300)
            shot("03-crear-firma")
            compose.onNodeWithTag("saveSignature").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mark-signature"), 15_000)
            Thread.sleep(600)
            shot("04-marca-nueva")
            assertTrue(descs("mark-signature").single().endsWith(" 1"))
            log("Firma creada y puesta: ${descs("mark-signature")}")

            // Arrastrar dentro de la página: se mueve con el dedo y la hoja no se desplaza.
            val m0 = bounds("mark-signature"); val pagesBefore = bounds("pdfPage-1")
            fingerDrag(center(m0), center(m0) + Offset(-150f, -120f), moveMs = 500)
            val m1 = bounds("mark-signature")
            assertEquals("la hoja no se movió", pagesBefore.top, bounds("pdfPage-1").top, 2f)
            assertEquals(-150f, m1.left - m0.left, 12f); assertEquals(-120f, m1.top - m0.top, 12f)
            log("Arrastre dentro de la página: Δ=(${m1.left - m0.left}, ${m1.top - m0.top}) sin scroll")

            // Soltar sobre la página 2 (debajo del borde): pasa a la 2.
            val p2 = bounds("pdfPage-2")
            fingerDrag(center(m1), Offset(center(m1).x, p2.top + 160f), moveMs = 700)
            compose.waitUntil(5_000) { descs("mark-signature").any { it.endsWith(" 2") } }
            shot("05-en-pagina-2")
            log("Arrastrada a otra página: ${descs("mark-signature")}")

            // Asa de la esquina: más grande, misma proporción.
            val before = bounds("mark-signature")
            fingerDrag(center(bounds("markHandle")), center(bounds("markHandle")) + Offset(160f, 0f), moveMs = 500)
            val after = bounds("mark-signature")
            assertTrue("creció", after.width > before.width + 100f)
            assertEquals("misma proporción", (before.height - 0) / before.width.coerceAtLeast(1f), after.height / after.width, 0.08f)
            log("Asa: ${before.width}→${after.width} px")

            // Pellizco sobre la marca elegida (un dedo puede caer fuera de ella): la achica sin mover la hoja.
            val pageTop = bounds("pdfPage-2").top
            fingerPinch(center(after), from = 500f, to = 300f)
            val pinched = bounds("mark-signature")
            assertTrue("el pellizco la achicó (${after.width}→${pinched.width})", pinched.width < after.width * 0.8f)
            assertEquals("la hoja no se movió con el pellizco", pageTop, bounds("pdfPage-2").top, 2f)
            log("Pellizco: ${after.width}→${pinched.width} px")

            // Duplicar (pólizas con varias firmas): otra igual, más abajo en la misma página.
            compose.onNodeWithTag("toolDuplicate").performClick()
            compose.waitUntil(5_000) { count("mark-signature") == 2 }
            shot("06-duplicada")
            log("Duplicar: ${descs("mark-signature")}")

            // Fecha, y llevarla con el desplazamiento automático hasta la página 3 (girada).
            compose.onNodeWithTag("toolDone").performClick()
            compose.onNodeWithTag("toolDate").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("mark-date"), 5_000)
            val d0 = bounds("mark-date")
            val st = bounds("pdfPages")
            fingerDrag(center(d0), Offset(st.center.x, st.bottom - 12f), moveMs = 600, holdMs = 2600)
            log("Tras soltar la fecha: ${descs("mark-date")} fantasma=${exists("markGhost")}")
            shot("07a-tras-soltar")
            compose.waitUntil(5_000) { descs("mark-date").any { it.endsWith(" 3") } }
            Thread.sleep(500)
            shot("07-fecha-pagina-3")
            log("Desplazamiento automático: ${descs("mark-date")}")

            // Confirmar y enviar.
            compose.onNodeWithTag("toolDone").performClick()
            compose.onNodeWithTag("toolFinish").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("signSend"), 5_000)
            shot("08-confirmar")
            // El botón se activa 0,6 s después de abrir la hoja (evita el doble toque).
            compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("signSend") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("signSend").performClick()
            compose.waitUntil(30_000) { !exists("pdfSheet") }
            val signed = runBlocking {
                kotlinx.coroutines.withTimeout(20_000) {
                    client.state.first { s -> s.conversations[conv]?.messages?.any { m -> m.attachments.any { it.signing != null && it.name.startsWith(att.name.removeSuffix(".pdf")) } } == true }
                }
                client.state.value.conversations[conv]!!.messages.flatMap { it.attachments }.last { it.signing != null && it.name.startsWith(att.name.removeSuffix(".pdf")) }
            }
            assertNotNull(signed.signing)
            compose.waitUntil(15_000) { exists("attSignedBy-${signed.id}") }
            shot("09-firmado-en-el-chat")
            log("Firmado: ${signed.name} ref=${signed.signing!!.ref}")
            // El PDF firmado, para mirarlo afuera.
            runBlocking { client.downloadAttachment(signed.url, File(outDir, "firmar-resultado.pdf")) }

            // «Documentos que firmé» en Tú.
            androidx.test.uiautomator.UiDevice.getInstance(ins).pressBack()
            compose.waitUntilAtLeastOneExists(hasTestTag("tab-settings"), 10_000)
            compose.onNodeWithTag("tab-settings").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("rowSigned"), 10_000)
            compose.onNodeWithTag("rowSigned").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("signedRow-${signed.signing!!.ref}"), 15_000)
            shot("10-documentos-que-firme")
            compose.onNodeWithTag("signedRow-${signed.signing!!.ref}").performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("signedDetail"), 5_000)
            shot("11-constancia")
            assertTrue(exists("signedViewPdf"))
            compose.onNodeWithTag("signedViewPdf").performScrollTo().performClick()
            compose.waitUntilAtLeastOneExists(hasTestTag("pdfSignedBanner"), 20_000)
            Thread.sleep(800)
            shot("12-ver-firmado")
            log("Historial y visor del firmado OK")
            compose.onNodeWithTag("pdfClose").performClick()
            runBlocking { client.listSignatures().filter { it.id !in savedBefore }.forEach { client.deleteSignature(it.id) } }
        } finally {
            scenario.close()
            peer.close()
        }
    }
}
