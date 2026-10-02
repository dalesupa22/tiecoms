package com.tiecoms.app.platform

import android.content.Context
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.CreativeMediaDTO
import com.tiecoms.app.core.LongContent
import com.tiecoms.app.core.TcJson
import kotlinx.serialization.Serializable
import java.io.File
import java.security.MessageDigest

/** Private local draft ledger: scoped by account/chat, never uploads while pasting. */
object ComposerDrafts {
    private val revision = java.util.concurrent.atomic.AtomicLong()
    private val savedRevisions = linkedMapOf<String, Long>()
    fun nextRevision() = revision.incrementAndGet()
    @Serializable data class Draft(val body: String = "", val files: List<Attachments.Shared> = emptyList(), val gif: CreativeMediaDTO? = null, val sources: Map<String, String> = emptyMap(), val viewOnce: Boolean = false, val mentions: List<com.tiecoms.app.core.MentionDTO> = emptyList())
    private fun ledger(ctx: Context, owner: String, chat: String): File {
        val key = MessageDigest.getInstance("SHA-256").digest("$owner:$chat".toByteArray()).joinToString("") { "%02x".format(it) }
        return File(ctx.filesDir, "composer/$key.json").apply { parentFile?.mkdirs() }
    }
    fun load(ctx: Context, owner: String, chat: String): Draft = runCatching {
        TcJson.decodeFromString(Draft.serializer(), ledger(ctx, owner, chat).readText()).let { d -> d.copy(files = d.files.filter { File(it.path).isFile }) }
    }.getOrDefault(Draft())
    @Synchronized fun save(ctx: Context, owner: String, chat: String, draft: Draft, revision: Long = nextRevision()) {
        if (draft.body.length > LongContent.MAX_AUTO_BYTES || draft.body.toByteArray(Charsets.UTF_8).size > LongContent.MAX_AUTO_BYTES) return // over-limit original remains in the current editor
        val f = ledger(ctx, owner, chat)
        if (revision < (savedRevisions[f.path] ?: 0L)) return
        val tmp = File(f.path + ".tmp")
        tmp.writeText(TcJson.encodeToString(Draft.serializer(), draft)); check(tmp.renameTo(f))
        savedRevisions[f.path] = revision
        if (savedRevisions.size > 128) savedRevisions.remove(savedRevisions.keys.first())
    }
    fun text(ctx: Context, original: String): Attachments.Shared {
        val bytes = LongContent.bytes(original)
        val f = File(ctx.filesDir, "composer/text-${java.util.UUID.randomUUID()}.txt").apply { parentFile?.mkdirs() }
        f.writeBytes(bytes)
        return Attachments.Shared("message.txt", "text/plain; charset=utf-8", bytes.size.toLong(), f.path)
    }
}
