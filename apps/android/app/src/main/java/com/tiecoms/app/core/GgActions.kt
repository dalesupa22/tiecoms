package com.tiecoms.app.core

import kotlinx.serialization.Serializable

/**
 * gg propone, la persona confirma (2-oct-2026, contrato en apps/api/src/modules/gg-actions.ts).
 * POST /gg/meeting-draft no agenda nada; POST /gg/mail-draft no envía nada. El envío es POST /gg/mail-send, solo tras confirmar.
 */
@Serializable data class GgInviteeDTO(val id: String = "", val name: String = "")

@Serializable data class GgMeetingDraft(
    val title: String = "", val durationMin: Int = 30, val attendeeEmails: List<String> = emptyList(),
    val invitees: List<GgInviteeDTO> = emptyList(), val missingPeople: List<String> = emptyList(),
    val links: List<String> = emptyList(), val description: String = "",
)

@Serializable data class GgMailDraft(
    val provider: String? = null, val from: String? = null, val status: String = "needs_connect",
    val to: List<String> = emptyList(), val cc: List<String> = emptyList(), val missingPeople: List<String> = emptyList(),
    val subject: String = "", val body: String = "",
) { val ready: Boolean get() = status == "ready" && (provider == "google" || provider == "microsoft") }

@Serializable data class GgMailSendResult(val ok: Boolean = false, val already: Boolean = false)

/** Reglas del correo de gg (puras, probadas en JVM). */
object GgMail {
    private val EMAIL = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")
    /** «a@x.co, b@y.co; c@z.co» → lista sin repetidos y en minúscula (como la web). */
    fun parse(text: String): List<String> = text.split(',', ';', ' ', '\n', '\t').map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
    fun valid(email: String): Boolean = email.length <= 254 && EMAIL.matches(email)
    fun invalid(list: List<String>): List<String> = list.filterNot(::valid)
    /** Duración del borrador ajustada a las opciones del formulario (15 a 240). */
    fun duration(min: Int): Int = min.coerceIn(15, 240)

    /**
     * Clave de idempotencia de un envío: la misma mientras el correo no cambie (un doble toque o un reintento no lo manda dos
     * veces); si se edita algo es otro correo y lleva otra clave.
     */
    class Key(private val newKey: () -> String = { java.util.UUID.randomUUID().toString() }) {
        private var fingerprint: String? = null
        private var key: String = newKey()
        fun forContent(to: List<String>, cc: List<String>, subject: String, body: String): String {
            val f = listOf(to.joinToString(","), cc.joinToString(","), subject.trim(), body.trim()).joinToString("\u0000")
            if (fingerprint != null && fingerprint != f) key = newKey()
            fingerprint = f
            return key
        }
        /** El servidor rechazó el envío (no salió): el siguiente intento es otro envío. */
        fun reset() { fingerprint = null; key = newKey() }
    }
}
