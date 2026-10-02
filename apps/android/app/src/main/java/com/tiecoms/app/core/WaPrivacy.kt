package com.tiecoms.app.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Revocation epochs also reject responses started before a lock, even after a later unlock. */
data class WaPrivacy(
    val revision: Long = 0,
    val knownAccounts: Set<String> = emptySet(),
    val accounts: Set<String> = emptySet(),
    val sources: Set<String> = emptySet(),
    private val accountEpoch: Map<String, Long> = emptyMap(),
    private val sourceEpoch: Map<String, Long> = emptyMap(),
) {
    fun allows(source: String): Boolean = WaInbox.parse(source)?.let { it.first !in accounts && source !in sources } ?: true
    fun token(source: String): Long = (WaInbox.parse(source)?.first?.let(accountEpoch::get) ?: 0) + (sourceEpoch[source] ?: 0)
    fun revoke(account: String, jids: List<String>, reset: Boolean): WaPrivacy {
        if (account.isBlank() || (!reset && jids.isEmpty())) return this
        val epoch = revision + 1
        val keys = jids.filter(String::isNotBlank).map { WaInbox.key(account, it) }
        return copy(revision = epoch, knownAccounts = knownAccounts + account, accounts = if (reset) accounts + account else accounts, sources = sources + keys,
            accountEpoch = if (reset) accountEpoch + (account to epoch) else accountEpoch,
            sourceEpoch = sourceEpoch + keys.associateWith { epoch })
    }
    fun observe(account: String) = if (account in knownAccounts) this else copy(knownAccounts = knownAccounts + account)
    fun ready(account: String) = copy(knownAccounts = knownAccounts + account, accounts = accounts - account)
    fun accept(chats: List<WaChatDTO>) = copy(knownAccounts = knownAccounts + chats.map { it.accountId }, sources = sources - chats.filter { it.accountId !in accounts }.map(WaInbox::key).toSet())

    companion object {
        fun source(path: String, body: String? = null): String? {
            val json = body?.let { runCatching { TcJson.parseToJsonElement(it) as? JsonObject }.getOrNull() }
            json?.get("source")?.jsonPrimitive?.contentOrNull?.takeIf(WaInbox::isWa)?.let { return it }
            val url = (if (path.startsWith("http")) path else "https://local.invalid/${path.trimStart('/')}").toHttpUrlOrNull() ?: return null
            url.queryParameter("source")?.takeIf(WaInbox::isWa)?.let { return it }
            val p = url.pathSegments; val w = p.indexOf("whatsapp")
            if (w >= 0 && p.size > w + 3 && p[w + 1] in setOf("chats", "media")) return WaInbox.key(p[w + 2], p[w + 3])
            if (w >= 0 && p.getOrNull(w + 1) == "share") {
                val account = json?.get("accountId")?.jsonPrimitive?.contentOrNull
                val jid = json?.get("jid")?.jsonPrimitive?.contentOrNull
                if (account != null && jid != null) return WaInbox.key(account, jid)
            }
            return null
        }
    }
}
