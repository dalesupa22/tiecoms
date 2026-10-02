package com.tiecoms.app.core

/** Original UTF-16 body stays authoritative. Automatic files preserve every UTF-8 byte. */
object LongContent {
    const val MAX_BODY = 8_000
    const val MAX_AUTO_BYTES = 1_048_576
    fun bytes(text: String): ByteArray {
        require(text.length <= MAX_AUTO_BYTES) { "Text exceeds automatic attachment limit" }
        return text.toByteArray(Charsets.UTF_8).also { require(it.size <= MAX_AUTO_BYTES) { "Text exceeds automatic attachment limit" } }
    }
    fun visibleBody(body: String, attachments: List<AttachmentDTO>): String {
        val credits = attachments.mapNotNull { it.provenance?.attribution?.takeIf(String::isNotBlank) }
        if (body in credits) return ""
        // Only remove an exact generated suffix. Ordinary GIF: comments remain untouched.
        val suffix = credits.distinct().joinToString("\n")
        return if (suffix.isNotBlank() && body.endsWith("\n\n$suffix")) body.dropLast(suffix.length + 2) else body
    }
    fun textFile(a: AttachmentDTO): Boolean = Attachments.mime(a.contentType) in setOf("text/plain", "text/markdown", "application/json") && !a.isVoice
}
