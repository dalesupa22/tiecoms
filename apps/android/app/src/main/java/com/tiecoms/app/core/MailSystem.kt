package com.tiecoms.app.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Mensajes de sistema del correo y de WhatsApp en el chat (docs/CORREO.md):
 * `mail.shared`, `mail.comments`, `mail.replied`, `mail.reply_failed` y `wa.shared`.
 * Son JSON `{"k": clave, ...}`; nunca deben verse crudos, ni siquiera con el correo apagado.
 */
object MailSystem {
    val KEYS = setOf("mail.shared", "mail.comments", "mail.replied", "mail.reply_failed", "wa.shared")

    data class Body(
        val key: String,
        /** Correo compartido (todos menos wa.shared). */
        val emailId: String?,
        val provider: String?,
        /** Asunto (mail.shared / replied / reply_failed) o título (mail.comments). */
        val subject: String,
        /** Remitente del correo (mail.shared). */
        val from: String?,
        /** Lo que escribió quien lo trajo (mail.shared y wa.shared). */
        val comment: String?,
        /** mail.replied: quién respondió. */
        val byName: String?,
        /** mail.reply_failed: por qué no salió. */
        val error: String?,
        /** mail.comments: comentarios agrupados. */
        val count: Int,
        val lastById: String?,
        val lastByName: String?,
        val lastExcerpt: String?,
        /** wa.shared: el mensaje de WhatsApp citado. */
        val wa: Wa?,
    )

    data class Wa(
        val accountId: String?, val jid: String?, val waMessageId: String?, val accountKind: String?,
        val chatName: String?, val isGroup: Boolean, val author: String?, val fromMe: Boolean, val text: String, val sentAt: String?,
    )

    fun parse(m: MessageDTO): Body? = if (m.kind != "system") null else parse(m.body)

    fun parse(body: String): Body? {
        if (!body.startsWith("{\"k\":\"mail.") && !body.startsWith("{\"k\":\"wa.")) return null
        val o = runCatching { TcJson.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
        return parse(o)
    }

    fun parse(o: JsonObject): Body? {
        fun s(k: String) = (o[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
        fun b(k: String) = (o[k] as? JsonPrimitive)?.booleanOrNull == true
        val k = s("k") ?: return null
        if (k !in KEYS) return null
        val wa = if (k == "wa.shared") Wa(s("accountId"), s("jid"), s("waMessageId"), s("accountKind"), s("chatName"), b("isGroup"),
            s("author"), b("fromMe"), (o["text"] as? JsonPrimitive)?.contentOrNull ?: "", s("sentAt")) else null
        return Body(
            key = k, emailId = s("emailId"), provider = s("provider"), subject = s("subject") ?: s("title") ?: "", from = s("from"),
            comment = s("comment"), byName = s("byName"), error = s("error"), count = (o["count"] as? JsonPrimitive)?.intOrNull ?: 1,
            lastById = s("lastById"), lastByName = s("lastByName"), lastExcerpt = s("lastExcerpt"), wa = wa,
        )
    }
}
