package com.tiecoms.app

import android.app.Instrumentation
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tiecoms.app.platform.PhoneLog
import com.tiecoms.app.platform.PhoneLogService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * CH038: tocar una llamada de Chaggu en el historial del teléfono. El marcador pide a Telecom una llamada a
 * sip:«Nombre@chaggu» con la cuenta de Chaggu (sin los extras de la app); Chaggu la cancela y abre MainActivity con el
 * nombre para volver a llamar a ese chat. Usa Telecom de verdad.
 */
@RunWith(AndroidJUnit4::class)
class PhoneLogCallBackTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val ctx = inst.targetContext

    @Test fun rellamarDesdeElHistorialAbreChagguConElNombre() {
        assumeTrue(Build.VERSION.SDK_INT >= 30)
        assumeTrue(PhoneLog.supported(ctx))
        // Registra la cuenta (como al anotar cualquier llamada) y recuerda el chat de ese nombre.
        PhoneLog.outgoing(ctx, "ch038-reg", "CH038 Ana", video = false, conversationId = "conv-ch038")
        PhoneLog.ended("ch038-reg")
        assertEquals("conv-ch038", PhoneLog.remembered(ctx)["CH038 Ana"]?.conversationId)

        // Captura la actividad que abre Chaggu (sin abrirla de verdad).
        var opened: Intent? = null
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.hasExtra(PhoneLog.EXTRA_CALL_BACK)) { opened = intent; return Instrumentation.ActivityResult(0, null) }
                return null
            }
        }
        inst.addMonitor(monitor)
        try {
            Thread.sleep(1500)
            val tm = ctx.getSystemService(TelecomManager::class.java)
            val handle = PhoneAccountHandle(ComponentName(ctx, PhoneLogService::class.java), "chaggu")
            tm.placeCall(Uri.fromParts(PhoneAccount.SCHEME_SIP, "CH038 Ana@chaggu", null), Bundle().apply {
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            })
            repeat(40) { if (opened == null) Thread.sleep(250) }
        } finally { inst.removeMonitor(monitor) }
        val i = opened
        assertNotNull("Chaggu se abrió para volver a llamar", i)
        assertEquals("CH038 Ana", i!!.getStringExtra(PhoneLog.EXTRA_CALL_BACK))
        assertEquals(false, i.getBooleanExtra(PhoneLog.EXTRA_CALL_BACK_VIDEO, true))
    }
}
