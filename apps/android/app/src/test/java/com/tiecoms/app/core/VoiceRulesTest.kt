package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** Notas de voz 1.6.2: toque → manos libres, «demasiado corta» solo con audio real < 0,5 s, duración del archivo y errores de subida. */
class VoiceRulesTest {
    @Test fun `un toque rapido bloquea en vez de descartar`() {
        assertEquals(VoiceRules.Release.LOCK, VoiceRules.onRelease(0))
        assertEquals(VoiceRules.Release.LOCK, VoiceRules.onRelease(180))
        assertEquals(VoiceRules.Release.LOCK, VoiceRules.onRelease(VoiceRules.TAP_MS - 1))
        assertEquals(VoiceRules.Release.SEND, VoiceRules.onRelease(VoiceRules.TAP_MS))
        assertEquals(VoiceRules.Release.SEND, VoiceRules.onRelease(45_000))
    }

    @Test fun `la duracion sale del archivo, el reloj es respaldo`() {
        // El reloj arrancó antes de que el micrófono capturara: 1,3 s en pantalla, 0,9 s de audio.
        assertEquals(900L, VoiceRules.duration(900, 1_300))
        assertEquals(1_300L, VoiceRules.duration(null, 1_300))
        assertEquals(1_300L, VoiceRules.duration(0, 1_300))
        assertEquals(0L, VoiceRules.duration(null, -5))
    }

    @Test fun `solo es corta con menos de medio segundo de audio real`() {
        assertEquals(VoiceRules.Finish.Ok(600), VoiceRules.finish(600, 900, 4_000, stopped = true))
        // Antes: 700 ms de reloj como mínimo; una nota de 0,6 s real que el reloj contaba 650 se descartaba.
        assertEquals(VoiceRules.Finish.Ok(650), VoiceRules.finish(null, 650, 4_000, stopped = true))
        assertEquals(VoiceRules.Finish.TooShort, VoiceRules.finish(420, 1_100, 3_000, stopped = true))
        assertEquals(VoiceRules.Finish.TooShort, VoiceRules.finish(5_000, 5_000, 0, stopped = true))
        assertEquals(VoiceRules.Finish.TooShort, VoiceRules.finish(null, 5_000, 2_000, stopped = false))
        // Notas medianas y largas: la del archivo, sin tope propio (el grabador corta a los 15 min).
        assertEquals(VoiceRules.Finish.Ok(47_320), VoiceRules.finish(47_320, 47_900, 190_000, stopped = true))
        assertEquals(VoiceRules.Finish.Ok(312_004), VoiceRules.finish(312_004, 312_500, 1_250_000, stopped = true))
    }

    @Test fun `errores de subida con su mensaje`() {
        assertEquals(VoiceRules.UploadError.TOO_LARGE, VoiceRules.uploadError(ApiException(413, "http_413", "HTTP 413")))
        assertEquals(VoiceRules.UploadError.TOO_LARGE, VoiceRules.uploadError(ApiException(400, "too_large", "x")))
        assertEquals(VoiceRules.UploadError.NETWORK, VoiceRules.uploadError(NetworkException(java.net.SocketTimeoutException("t"))))
        assertEquals(VoiceRules.UploadError.NETWORK, VoiceRules.uploadError(ApiException(502, "http_502", "HTTP 502")))
        assertEquals(VoiceRules.UploadError.OTHER, VoiceRules.uploadError(ApiException(403, "forbidden", "no")))
    }
}
