package com.tiecoms.app

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.assert
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.CalendarGrid
import com.tiecoms.app.core.MemorySecretStore
import com.tiecoms.app.core.MemoryStorage
import com.tiecoms.app.core.ReadTree
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.TextSize
import com.tiecoms.app.core.TieComsClient
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.LocalDate
import java.time.YearMonth

/**
 * Tanda 1.6.6 contra el API LOCAL de la rama tanda-lectura-reuniones (puerto 3076, base propia) y, para reuniones,
 * el proveedor FALSO apps/api/test/fake-meetings.mjs (MOCK: no prueba OAuth ni la creación real en Google/Microsoft/Zoom).
 * Fixture: scratchpad fixture166.mjs (Ana y Beto, «General» leído con dos derivadas sin leer, reuniones del mes y un
 * asunto personal).
 *
 *   adb shell am instrument -w -e apiUrl http://10.0.2.2:3076 -e fakeUrl http://10.0.2.2:59376 -e email … -e peerEmail … -e password … \
 *     -e conversationId … -e derived "d1,d2" -e personalIssueId … -e class com.tiecoms.app.Tanda166UiTest com.chaggu.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class Tanda166UiTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val notifications: GrantPermissionRule =
        if (Build.VERSION.SDK_INT >= 33) GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS) else GrantPermissionRule.grant()

    private val args = InstrumentationRegistry.getArguments()
    private fun arg(k: String) = args.getString(k).orEmpty()
    private fun log(s: String) = Log.i("TieComsUiTest", s).also { println("[1.6.6] $s") }
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val app get() = ins.targetContext.applicationContext as TieComsApp
    private fun str(id: Int, vararg a: Any) = app.getString(id, *a)
    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun hasTextNow(t: String) = compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private val device get() = UiDevice.getInstance(ins)
    private fun shot(name: String) {
        Thread.sleep(900)
        val bmp = ins.uiAutomation.takeScreenshot() ?: return
        File(ins.targetContext.getExternalFilesDir(null), "t166-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private val http = OkHttpClient()
    /** Proveedor falso (MOCK): cambia su comportamiento o lee cuántas reuniones creó. */
    private fun fake(path: String, json: String? = null): String {
        val b = Request.Builder().url(arg("fakeUrl") + path)
        if (json != null) b.post(json.toRequestBody("application/json".toMediaType()))
        return http.newCall(b.build()).execute().use { it.body!!.string() }
    }

    private fun guard() {
        assumeTrue("Faltan argumentos del fixture", arg("apiUrl").isNotBlank() && arg("email").isNotBlank() && arg("password").isNotBlank())
        assertFalse("Nunca contra producción", arg("apiUrl").contains("tiecoms.com") || arg("apiUrl").contains("chaggu.com"))
    }

    /** Sesión nueva de Ana en la app. */
    private fun launchLoggedIn(): ActivityScenario<MainActivity> {
        ins.runOnMainSync { app.container.setDebugApiUrl(arg("apiUrl")) }
        val c0 = app.container.client.value
        runBlocking {
            kotlinx.coroutines.withTimeout(20_000) { c0.state.first { it.status != SessionStatus.LOADING } }
            if (c0.state.value.status != SessionStatus.ANONYMOUS) c0.logout()
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        compose.waitUntil(20_000) { exists("email") && !exists("splash") }
        compose.onNodeWithTag("email").performTextInput(arg("email"))
        compose.onNodeWithTag("password").performTextInput(arg("password"))
        compose.onNodeWithTag("login").performScrollTo().performClick()
        compose.waitUntil(20_000) { exists("quick.create") }
        return scenario
    }

    /** Otra sesión (otro dispositivo) de [email], fuera de la app. */
    private fun session(email: String): TieComsClient {
        val c = TieComsClient(arg("apiUrl"), "Otra sesión", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { c.login(email, arg("password")) }
        return c
    }

    // ---------- 1. Pendientes del árbol ----------
    @Test fun pendientesDelArbol() {
        guard()
        val conv = arg("conversationId"); val (d1, d2) = arg("derived").split(",")
        app.container.settings.groupsView = "list"; app.container.settings.homeTab = "ALL"; app.container.settings.collapsed = emptySet()
        var scenario = launchLoggedIn()
        val peer = session(arg("peerEmail"))
        try {
            val client = app.container.client.value
            val data = client.state.value.data!!
            val g = data.conversations.first { it.id == conv }
            assertEquals("General leído, como el caso de Danny", 0, g.unread)
            val tree = ReadTree.of(data, g)
            assertEquals(listOf(d1, d2).toSet(), tree.pendingChildren.map { it.c.id }.toSet())
            val total = tree.threads
            assertTrue(total >= 11)
            compose.waitUntil(10_000) { exists("threadUnread-$conv") }
            compose.onNodeWithTag("threadUnread-$conv", useUnmergedTree = true).assert(hasText("⑂ $total"))
            assertFalse("el chip viejo 💬 ya no está", hasTextNow("💬 $total"))
            assertTrue("sección Sin leer", exists("block-UNREAD"))
            shot("01-lista-chip-arbol")
            compose.onNodeWithTag("tab-UNREAD").performClick()
            compose.waitUntil(5_000) { exists("conv-$conv") }
            shot("02-filtro-no-leidos")
            compose.onNodeWithTag("tab-ALL").performClick()
            log("Pendientes del árbol: ⑂ $total, sección y filtro No leídos (antes 0)")

            // Menú de la fila: «Marcar como leído» (no «Marcar como no leído»).
            compose.onNodeWithTag("conv-$conv").performTouchInput { longClick() }
            compose.waitUntil(5_000) { exists("menuMarkRead") }
            assertFalse(exists("menuMarkUnread"))
            shot("03-menu-marcar-leido")
            device.pressBack()
            compose.waitUntil(5_000) { !exists("menuMarkRead") }

            // En el chat: la franja y la lista de derivadas; abrir una no marca la otra.
            compose.onNodeWithTag("conv-$conv").performClick()
            compose.waitUntil(15_000) { exists("treeStrip") }
            assertTrue(hasTextNow("$total"))
            shot("04-franja-chat")
            compose.onNodeWithTag("treeStrip").performClick()
            compose.waitUntil(5_000) { exists("treeItem-$d1") }
            assertTrue(exists("treeItem-$d2")); assertTrue(exists("treeMarkAll"))
            shot("05-lista-derivadas")
            val d2Before = client.meta(d2)!!.unread
            compose.onNodeWithTag("treeItem-$d1").performClick()
            compose.waitUntil(20_000) { client.meta(d1)?.unread == 0 }
            Thread.sleep(1500)
            assertEquals("abrir una derivada no marca la otra", d2Before, client.meta(d2)!!.unread)
            assertTrue("la mención antigua del hilo sigue", client.meta(d2)!!.unreadMentions > 0)
            shot("06-derivada-abierta")
            log("Franja «⑂ N sin leer en X conversaciones · Ver», lista y abrir una sin tocar la otra")
            device.pressBack(); Thread.sleep(500)
            if (!exists("quick.create")) { device.pressBack(); Thread.sleep(500) }
            if (!exists("quick.create")) compose.onNodeWithTag("back").performClick()
            compose.waitUntil(10_000) { exists("conv-$conv") }

            // Marcar como leído desde la fila: el grupo y la derivada pendiente.
            compose.onNodeWithTag("conv-$conv").performTouchInput { longClick() }
            compose.waitUntil(5_000) { exists("menuMarkRead") }
            compose.onNodeWithTag("menuMarkRead").performClick()
            compose.waitUntil(10_000) { client.meta(d2)?.unread == 0 && client.meta(d2)?.unreadMentions == 0 }
            compose.waitUntil(5_000) { !exists("threadUnread-$conv") }
            shot("07-marcado-leido")
            // Otro dispositivo de Ana lo ve igual (read.updated / persistencia en el servidor).
            val other = session(arg("email"))
            try {
                runBlocking { other.loadBootstrap() }
                listOf(conv, d1, d2).forEach { assertEquals("leído en el servidor: $it", 0, other.meta(it)!!.unread) }
            } finally { other.close() }
            // Menú ahora: «Marcar como no leído».
            compose.onNodeWithTag("conv-$conv").performTouchInput { longClick() }
            compose.waitUntil(5_000) { exists("menuMarkUnread") }
            device.pressBack()
            log("Marcar como leído: read-tree del grupo y sus derivadas; otra sesión lo ve leído; el menú vuelve a «no leído»")

            // Lo que llega después sigue sin leer.
            runBlocking { peer.loadBootstrap(); peer.send(d2, "Nuevo después de marcar") }
            compose.waitUntil(20_000) { client.meta(d2)?.unread == 1 }
            compose.waitUntil(10_000) { exists("threadUnread-$conv") }
            compose.onNodeWithTag("threadUnread-$conv", useUnmergedTree = true).assert(hasText("⑂ 1"))
            shot("08-nuevo-despues")
            // Persistencia al reabrir la app.
            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntil(20_000) { exists("threadUnread-$conv") }
            assertEquals(1, ReadTree.of(app.container.client.value.state.value.data!!, app.container.client.value.meta(conv)!!).threads)
            log("Mensaje nuevo después de marcar: ⑂ 1, también al reabrir")
        } catch (t: Throwable) { shot("fallo-arbol"); throw t } finally { peer.close(); runCatching { scenario.close() } }
    }

    // ---------- 2 y 3. Asuntos compactos y personales ----------
    @Test fun asuntosPersonales() {
        guard()
        val pid = arg("personalIssueId")
        app.container.settings.issueFilter = "open"; app.container.settings.issueGroupBy = "group"
        val scenario = launchLoggedIn()
        val peer = session(arg("peerEmail"))
        try {
            val client = app.container.client.value
            compose.onNodeWithTag("tab-issues").performClick()
            compose.waitUntil(15_000) { exists("issueSection-__personal") }
            assertFalse("sin el párrafo explicativo", hasTextNow("Lo que quedó pendiente") || hasTextNow("What was left pending"))
            assertTrue(exists("issue-$pid"))
            assertTrue("🔒 en la fila", hasTextNow("🔒 Renovar el pasaporte"))
            shot("09-asuntos-compacto-personal")
            // Alta con «¿Dónde?»: la primera opción es Personal.
            compose.onNodeWithTag("issueQuickAdd").performTextInput("Llamar al notario")
            compose.waitUntil(5_000) { exists("issueQuickWhere") }
            compose.onNodeWithTag("issueQuickWhere").performClick()
            compose.waitUntil(5_000) { hasTextNow(str(R.string.issue_personal_option)) }
            shot("10-donde-personal-primero")
            compose.onAllNodes(hasText(str(R.string.issue_personal_option)), useUnmergedTree = true).fetchSemanticsNodes().size.let { assertTrue(it >= 1) }
            compose.onNodeWithText(str(R.string.issue_personal_option), useUnmergedTree = true).performClick()
            compose.waitUntil(5_000) { !exists("issueQuickOwner") } // personal: no hay a quién asignarlo
            compose.onNodeWithTag("issueQuickSubmit").performClick()
            compose.waitUntil(10_000) { client.state.value.issues.values.any { it.title == "Llamar al notario" && it.personal } }
            val mine = client.state.value.issues.values.first { it.title == "Llamar al notario" }
            log("Alta personal desde «¿Dónde?» → POST /issues")
            // Detalle: sin «¿Quién lo hace?», sin tareas y sin sidechat.
            compose.onNodeWithTag("issues").performScrollToNode(hasTestTag("issue-$pid"))
            compose.onNodeWithTag("issue-$pid").performClick()
            compose.waitUntil(10_000) { exists("issuePersonal") }
            assertFalse(exists("issueQWho")); assertFalse(exists("tasksSection"))
            shot("11-detalle-personal")
            compose.onNodeWithTag("back").performClick()
            compose.onNodeWithTag("issues").performScrollToNode(hasTestTag("issue-$pid"))
            compose.onNodeWithTag("issue-$pid").performTouchInput { longClick() }
            compose.waitUntil(5_000) { exists("issueActDone") }
            assertFalse("sin tareas", exists("issueActAddTask")); assertFalse("sin sidechat", exists("issueActSide"))
            device.pressBack()
            // Privacidad impuesta por el servidor: Beto no los ve ni por lista ni por id.
            val peerIssues = runBlocking { peer.loadIssues() }
            assertFalse(peerIssues.any { it.id == pid || it.id == mine.id })
            for (id in listOf(pid, mine.id)) try { runBlocking { peer.issueDetail(id) }; fail("Beto no debe ver $id") } catch (e: ApiException) { assertEquals(404, e.status) }
            log("Privacidad: Beto no ve los personales (lista y 404 por id)")
            // Por responsable: el personal es mío, sección «Tú».
            compose.onNodeWithText(str(R.string.issue_by_person)).performClick()
            compose.waitUntil(5_000) { exists("issueSection-${client.myId}") }
            compose.onNodeWithText(str(R.string.issue_by_group)).performClick()
        } catch (t: Throwable) { shot("fallo-asuntos"); throw t } finally { peer.close(); runCatching { scenario.close() } }
    }

    /** Conecta [provider] con Custom Tabs (MOCK: el proveedor falso acepta solo) y vuelve por chaggu://meetings/connected. */
    private fun connectViaCustomTab(provider: String) {
        val client = app.container.client.value
        compose.onNodeWithTag("settingsScreen").performScrollToNode(hasTestTag("meetConnect-$provider"))
        compose.onNodeWithTag("meetConnect-$provider").performClick()
        // Chrome puede pedir su bienvenida la primera vez; se descarta sin cuenta.
        for (i in 0 until 3) {
            if (client.state.value.meetingConnections?.firstOrNull { it.provider == provider }?.status == "active") break
            device.wait(Until.findObject(By.textContains("Use without an account")), 3_000)?.click()
            device.wait(Until.findObject(By.textContains("No thanks")), 1_500)?.click()
            device.wait(Until.findObject(By.textContains("Open")), 1_000)?.takeIf { it.applicationPackage == "com.android.chrome" }?.click()
        }
        device.wait(Until.hasObject(By.pkg("com.chaggu.app").depth(0)), 30_000)
        compose.waitUntil(30_000) { client.state.value.meetingConnections?.firstOrNull { it.provider == provider }?.status == "active" }
    }

    // ---------- 4. Reuniones (MOCK) ----------
    @Test fun reunionesMock() {
        guard()
        assumeTrue("Falta fakeUrl (proveedor falso)", arg("fakeUrl").isNotBlank())
        val conv = arg("conversationId")
        fake("/control", """{"msNoTeams":false,"revokeAll":false,"failNext":null}""")
        val scenario = launchLoggedIn()
        try {
            val client = app.container.client.value
            // Empieza sin conexiones (una corrida anterior pudo dejarlas).
            runBlocking { client.disconnectMeeting("google"); client.disconnectMeeting("microsoft") }
            compose.onNodeWithTag("tab-settings").performClick()
            compose.waitUntil(10_000) { exists("meetingsSettings") }
            compose.onNodeWithTag("settingsScreen").performScrollToNode(hasTestTag("meetRow-zoom"))
            compose.waitUntil(10_000) { client.state.value.meetingConnections != null }
            val zoom = client.state.value.meetingConnections!!.first { it.provider == "zoom" }
            assertFalse("Zoom sin app OAuth en este servidor", zoom.available)
            assertFalse("sin botón que no funciona", exists("meetConnect-zoom"))
            shot("12-ajustes-reuniones")
            connectViaCustomTab("google")
            connectViaCustomTab("microsoft")
            compose.onNodeWithTag("settingsScreen").performScrollToNode(hasTestTag("meetRow-microsoft"))
            shot("13-ajustes-conectado-mock")
            log("MOCK: Conectar Google y Microsoft por Custom Tabs y vuelta por chaggu://meetings/connected")

            // Reunión ahora con Meet: un fallo del proveedor y el reintento con la misma llave (no duplica).
            compose.onNodeWithTag("tab-home").performClick()
            compose.waitUntil(10_000) { exists("conv-$conv") }
            compose.onNodeWithTag("conv-$conv").performClick()
            compose.waitUntil(15_000) { exists("attach") }
            compose.onNodeWithTag("attach").performClick()
            compose.waitUntil(5_000) { exists("plusMeetNow") }
            assertTrue(exists("plusMeetSchedule"))
            shot("14-menu-mas-reuniones")
            compose.onNodeWithTag("plusMeetNow").performClick()
            compose.waitUntil(10_000) { exists("meetProvider-google") }
            compose.waitUntil(10_000) { exists("meetCreate") }
            shot("15-dialogo-reunion-ahora")
            val before = fake("/stats")
            fake("/control", """{"failNext":"google"}""")
            compose.onNodeWithTag("meetingDialog").performScrollToNode(hasTestTag("meetCreate"))
            compose.onNodeWithTag("meetCreate").performClick()
            compose.waitUntil(15_000) { exists("meetProblem") }
            shot("16-fallo-proveedor")
            compose.onNodeWithTag("meetCreate").performClick()
            compose.waitUntil(20_000) { exists("meetCreated") }
            val url = client.state.value.conversations[conv]?.messages?.lastOrNull { it.body.contains("https://meet.google.com/mock-") }?.body
            compose.waitUntil(10_000) { client.state.value.conversations[conv]?.messages?.any { it.body.contains("https://meet.google.com/mock-") } == true }
            assertTrue(exists("meetOpen")); assertTrue(exists("meetCopy"))
            assertTrue(hasTextNow(str(R.string.meet_open_in, "Meet")))
            shot("17-reunion-creada-mock")
            val after = fake("/stats")
            log("MOCK: stats antes $before, después $after (una sola reunión de Google tras el fallo y el reintento); mensaje: ${url ?: "(llegó después)"}")
            assertEquals(Regex("\"google\":(\\d+)").find(before)!!.groupValues[1].toInt() + 1, Regex("\"google\":(\\d+)").find(after)!!.groupValues[1].toInt())
            compose.onNodeWithTag("meetDone").performClick()

            // Agendada con Teams: la cuenta sin Teams para empresas.
            fake("/control", """{"msNoTeams":true}""")
            compose.onNodeWithTag("attach").performClick()
            compose.waitUntil(5_000) { exists("plusMeetSchedule") }
            compose.onNodeWithTag("plusMeetSchedule").performClick()
            compose.waitUntil(10_000) { exists("meetProvider-microsoft") }
            compose.onNodeWithTag("meetProvider-microsoft").performClick()
            compose.onNodeWithTag("meetDur-45").performScrollTo().performClick()
            compose.onNodeWithTag("meetingDialog").performScrollToNode(hasTestTag("meetCreate"))
            compose.onNodeWithTag("meetCreate").performClick()
            compose.waitUntil(15_000) { exists("meetProblem") }
            assertTrue(hasTextNow(str(R.string.meet_err_no_teams)))
            shot("18-sin-teams")
            fake("/control", """{"msNoTeams":false}""")
            compose.onNodeWithTag("meetCreate").performClick()
            compose.waitUntil(20_000) { exists("meetCreated") }
            assertTrue(hasTextNow("https://teams.microsoft.com/l/meetup-join/mock-"))
            assertTrue(hasTextNow(str(R.string.meet_open_in, "Teams")))
            shot("19-teams-agendada-mock")
            compose.onNodeWithTag("meetDone").performClick()
            log("MOCK: Teams agendada; no_teams explicado y luego creada")

            // Permiso revocado: reconnect_required ofrece Reconectar.
            fake("/control", """{"revokeAll":true}""")
            runBlocking { client.loadMeetingConnections() }
            compose.onNodeWithTag("attach").performClick()
            compose.waitUntil(5_000) { exists("plusMeetNow") }
            compose.onNodeWithTag("plusMeetNow").performClick()
            compose.waitUntil(10_000) { exists("meetProvider-google") }
            compose.onNodeWithTag("meetProvider-google").performClick()
            compose.onNodeWithTag("meetingDialog").performScrollToNode(hasTestTag("meetCreate"))
            compose.onNodeWithTag("meetCreate").performClick()
            compose.waitUntil(20_000) { exists("meetProblem") }
            compose.waitUntil(10_000) { exists("meetProblemConnect") || exists("meetConnectSel") }
            shot("20-reconectar")
            fake("/control", """{"revokeAll":false}""")
            device.pressBack()
            log("MOCK: permiso revocado → «Reconectar»")
        } catch (t: Throwable) { shot("fallo-reuniones"); throw t } finally { runCatching { scenario.close() } }
    }

    // ---------- 5. Calendario ----------
    @Test fun calendario() {
        guard()
        app.getSharedPreferences("tiecoms_settings", android.content.Context.MODE_PRIVATE).edit().remove("calendarView").commit()
        app.container.settings.textScale = 1f
        var scenario = launchLoggedIn()
        try {
            compose.onNodeWithTag("tab-agenda").performClick()
            compose.waitUntil(10_000) { exists("calWeek") }
            assertEquals("Semana por defecto", "week", app.container.settings.calendarView)
            shot("21-semana")
            compose.onNodeWithTag("calView-month").performClick()
            compose.waitUntil(5_000) { exists("calMonth") }
            assertEquals("month", app.container.settings.calendarView)
            val today = LocalDate.now()
            fun cells() = compose.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("calCell") { n ->
                n.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.startsWith("calCell-") == true }, useUnmergedTree = true).fetchSemanticsNodes().size
            assertEquals(42, cells())
            val busy = LocalDate.of(today.year, today.month, 29).takeIf { YearMonth.from(today).lengthOfMonth() >= 29 }
            if (busy != null) {
                compose.onNodeWithTag("calMonth").performScrollToNode(hasTestTag("calCell-$busy"))
                assertTrue("«+N más» con 4 reuniones el día 29", exists("calMore-$busy"))
            }
            shot("22-mes")
            // Meses de 28 a 31 días (y el año bisiesto): siempre 6×7 desde lunes.
            var month = YearMonth.from(today)
            for (i in 1..17) {
                compose.onNodeWithTag("agenda.next").performClick()
                month = month.plusMonths(1)
                compose.waitUntil(5_000) { exists("calCell-${CalendarGrid.monthGrid(month).first()}") }
                assertEquals(42, cells())
                assertTrue(exists("calCell-${month.atEndOfMonth()}"))
                if (month == YearMonth.of(2028, 2)) shot("23-mes-febrero-bisiesto")
            }
            compose.onNodeWithTag("agenda.today").performClick()
            compose.waitUntil(5_000) { exists("calCell-$today") }
            // Tocar un día abre la vista Día.
            val day = busy ?: today
            compose.onNodeWithTag("calMonth").performScrollToNode(hasTestTag("calCell-$day"))
            compose.onNodeWithTag("calCell-$day").performClick()
            compose.waitUntil(5_000) { exists("calDay") }
            assertEquals("day", app.container.settings.calendarView)
            if (busy != null) assertTrue("📹 en la reunión con enlace de Meet", hasTextNow("📹 Llamada con el cliente"))
            shot("24-dia")
            // Crear desde un hueco.
            compose.onNodeWithTag("calHour-15").performScrollTo().performClick()
            compose.waitUntil(5_000) { exists("eventDialog") }
            shot("25-crear-desde-hueco")
            device.pressBack(); compose.waitUntil(5_000) { !exists("eventDialog") }
            // Recordado al reabrir.
            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntil(20_000) { exists("quick.create") }
            compose.onNodeWithTag("tab-agenda").performClick()
            compose.waitUntil(10_000) { exists("calDay") }
            log("Calendario: Semana por defecto, Mes 6×7 (17 meses de 28 a 31 días), tocar día → Día, crear desde el hueco y vista recordada")
            // Texto Máximo: títulos con elipsis, sin desbordar.
            app.container.settings.textScale = TextSize.STEPS.last()
            compose.onNodeWithTag("calView-month").performClick()
            compose.waitUntil(5_000) { exists("calMonth") }
            shot("26-mes-texto-maximo")
            compose.onNodeWithTag("calView-week").performClick()
            compose.waitUntil(5_000) { exists("calWeek") }
            shot("27-semana-texto-maximo")
            compose.onNodeWithTag("calView-day").performClick()
            compose.waitUntil(5_000) { exists("calDay") }
            shot("28-dia-texto-maximo")
        } catch (t: Throwable) { shot("fallo-calendario"); throw t } finally {
            app.container.settings.textScale = 1f; app.container.settings.calendarView = "week"
            runCatching { scenario.close() }
        }
    }
}
