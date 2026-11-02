package com.tiecoms.app

import android.os.Build
import android.provider.CallLog
import android.telecom.DisconnectCause
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.platform.PhoneLog
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * CH028: las llamadas de Chaggu quedan en el historial del teléfono (Telecom «self-managed»). Usa Telecom de verdad
 * (sin servidor ni Chime: solo los estados que le pasa CallManager) y lee el historial con el shell (READ_CALL_LOG).
 */
@RunWith(AndroidJUnit4::class)
class PhoneLogTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val ctx = inst.targetContext
    private val tag = "CH028-" + System.currentTimeMillis() % 100000

    private fun callLog(): String {
        val fd = inst.uiAutomation.executeShellCommand("content query --uri content://call_log/calls --projection number:type:duration:phone_account_address:subscription_component_name")
        return android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().readText()
    }

    /** La fila del historial con ese nombre (Telecom la escribe al terminar, en segundo plano). */
    private fun row(name: String): String? {
        repeat(40) {
            callLog().lines().firstOrNull { it.contains("number=$name@chaggu,") }?.let { return it }
            Thread.sleep(250)
        }
        return null
    }

    @Test fun lasLlamadasSalenEnElHistorialDelTelefono() {
        assumeTrue("Telecom solo anota llamadas self-managed desde Android 11", Build.VERSION.SDK_INT >= 30)
        assumeTrue(PhoneLog.supported(ctx))

        // Saliente contestada: dura lo que estuvo activa.
        val out = "$tag Grupo"
        PhoneLog.outgoing(ctx, "$tag-out", out, video = false)
        Thread.sleep(800); PhoneLog.live("$tag-out"); Thread.sleep(2500); PhoneLog.ended("$tag-out")
        val o = row(out)
        assertTrue("saliente: $o\n${callLog()}", o != null && o.contains("type=${CallLog.Calls.OUTGOING_TYPE},"))
        assertTrue("con duración: $o", Regex("duration=(\\d+)").find(o!!)!!.groupValues[1].toInt() >= 1)
        assertTrue("de Chaggu: $o", o.contains("PhoneLogService"))

        // Entrante contestada aquí.
        val inc = "$tag Ana"
        PhoneLog.incoming(ctx, "$tag-in", inc, video = true)
        Thread.sleep(800); PhoneLog.answered("$tag-in"); PhoneLog.live("$tag-in"); Thread.sleep(2000); PhoneLog.ended("$tag-in")
        val i = row(inc)
        assertTrue("entrante: $i", i != null && i.contains("type=${CallLog.Calls.INCOMING_TYPE},"))

        // Nadie contestó: perdida (aunque termine antes de que Telecom cree la conexión).
        val miss = "$tag Bob"
        PhoneLog.incoming(ctx, "$tag-miss", miss, video = false)
        PhoneLog.notAnswered("$tag-miss", DisconnectCause.MISSED)
        val m = row(miss)
        assertTrue("perdida: $m", m != null && m.contains("type=${CallLog.Calls.MISSED_TYPE},"))

        // «Ahora no»: rechazada.
        val rej = "$tag Carla"
        PhoneLog.incoming(ctx, "$tag-rej", rej, video = false)
        Thread.sleep(800); PhoneLog.notAnswered("$tag-rej", DisconnectCause.REJECTED)
        val r = row(rej)
        assertTrue("rechazada: $r", r != null && r.contains("type=${CallLog.Calls.REJECTED_TYPE},"))

        // El mismo timbre por push y por socket sale una sola vez.
        PhoneLog.incoming(ctx, "$tag-rej", rej, video = false)
        Thread.sleep(1500)
        assertTrue("sin duplicados", callLog().lines().count { it.contains("number=$rej@chaggu,") } == 1)
    }
}
