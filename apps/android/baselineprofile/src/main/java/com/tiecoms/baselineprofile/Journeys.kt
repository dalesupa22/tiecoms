package com.tiecoms.baselineprofile

import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.Until

const val PACKAGE = "com.chaggu.app"

private fun arg(name: String) = InstrumentationRegistry.getArguments().getString(name).orEmpty()

private val LIST = java.util.regex.Pattern.compile("conversationList|groupsEmpty|dmList")

/** El aviso propio «Activar notificaciones» (la primera vez): «Ahora no». */
fun MacrobenchmarkScope.dismissNotice() {
    (device.findObject(By.text("Not now")) ?: device.findObject(By.text("Ahora no")))?.click()
}

/** Si la app abre en el login, entra con la cuenta de prueba (argumentos email/password; API local). */
fun MacrobenchmarkScope.ensureSignedIn() {
    if (device.wait(Until.hasObject(By.res(LIST)), 8_000)) { dismissNotice(); return }
    val email = device.wait(Until.findObject(By.res("email")), 10_000) ?: error("Ni lista ni login en pantalla")
    check(arg("email").isNotBlank() && arg("password").isNotBlank()) { "Faltan los argumentos email/password de la cuenta de prueba" }
    email.click(); email.text = arg("email")
    device.findObject(By.res("password")).apply { click(); text = arg("password") }
    device.pressBack()
    device.findObject(By.res("login")).click()
    check(device.wait(Until.hasObject(By.res(LIST)), 30_000)) { "No apareció la lista tras entrar" }
    dismissNotice()
}

fun MacrobenchmarkScope.waitForList() {
    check(device.wait(Until.hasObject(By.res(LIST)), 15_000)) { "No apareció la lista" }
    dismissNotice()
}

/** Abre la conversación [index] de la pestaña DMs (los chats de la cuenta de prueba), espera los mensajes. */
fun MacrobenchmarkScope.openChat(index: Int = 0) {
    device.findObject(By.res("tab-dms"))?.let { it.click(); device.wait(Until.hasObject(By.res("dmList")), 5_000) }
    val rows = device.wait(Until.findObjects(By.res(java.util.regex.Pattern.compile("conv-.*"))), 10_000) ?: return
    val row = rows.getOrNull(index) ?: rows.firstOrNull() ?: return
    row.click()
    device.wait(Until.hasObject(By.res("messages")), 10_000)
    device.waitForIdle()
}

fun MacrobenchmarkScope.scrollList() {
    device.findObject(By.res("tab-dms"))?.let { it.click(); device.wait(Until.hasObject(By.res("dmList")), 5_000) }
    val list = device.findObject(By.res("dmList")) ?: return
    list.setGestureMargin(device.displayWidth / 5)
    list.fling(Direction.DOWN); device.waitForIdle()
    list.fling(Direction.UP); device.waitForIdle()
}
