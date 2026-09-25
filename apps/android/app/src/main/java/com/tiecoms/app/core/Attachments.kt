package com.tiecoms.app.core

/** Reglas de adjuntos y de lo que llega desde «Compartir» (SPEC-v4), en Kotlin puro. */
object Attachments {
    const val MAX_BYTES = 25L * 1024 * 1024
    const val MAX_PER_MESSAGE = 10
    /** Conversaciones destino a la vez desde la hoja de compartir. */
    const val MAX_TARGETS = 5

    enum class Kind { IMAGE, VIDEO, FILE }

    fun kind(contentType: String?): Kind = when {
        contentType == null -> Kind.FILE
        contentType.startsWith("image/") -> Kind.IMAGE
        contentType.startsWith("video/") -> Kind.VIDEO
        else -> Kind.FILE
    }

    /**
     * Etiquetas de la web (att.*), ya con su emoji: «📷 Foto», «📷 %d fotos», «🎬 Video», «🎬 %d videos»,
     * «🖼 %d fotos y videos», «📎 %s», «📎 %d archivos».
     */
    data class Labels(val photo: String, val photos: String, val video: String, val videos: String, val media: String, val file: String, val files: String,
                      val voice: String = "🎤 %s")

    private fun head(count: Int, images: Int, videos: Int, firstName: String?, l: Labels): String = when {
        count <= 0 -> ""
        images == count -> if (count == 1) l.photo else l.photos.format(count)
        videos == count -> if (count == 1) l.video else l.videos.format(count)
        images + videos == count -> l.media.format(count)
        count == 1 -> l.file.format(firstName ?: "")
        else -> l.files.format(count)
    }

    private fun join(head: String, body: String): String {
        val text = body.trim()
        return when { head.isEmpty() -> text; text.isEmpty() -> head; else -> "$head · $text" }
    }

    /** Vista previa de un mensaje con adjuntos (+ el texto si lo hay), como las listas y el push del servidor. */
    fun preview(list: List<AttachmentDTO>, body: String, l: Labels): String {
        // Nota de voz: «🎤 Nota de voz (0:42)».
        list.singleOrNull()?.takeIf { it.isVoice }?.let { return join(l.voice.format(Waveform.clock(it.durationMs ?: 0)), body) }
        return join(head(list.size, list.count { it.isImage }, list.count { it.isVideo }, list.firstOrNull()?.name, l), body)
    }

    /** Igual, desde el resumen de /bootstrap (lastHumanPreview.attachments). */
    fun preview(sum: AttachmentSummaryDTO?, body: String, l: Labels): String {
        if (sum != null && sum.count == 1 && sum.voices == 1) return join(l.voice.format(Waveform.clock(sum.voiceDurationMs ?: 0)), body)
        return join(if (sum == null) "" else head(sum.count, sum.images, sum.videos, sum.firstName, l), body)
    }

    /** Tamaño legible: 820 B, 12 KB, 3,4 MB. */
    fun size(bytes: Long, decimalComma: Boolean = true): String {
        val s = when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> "${bytes / 1024} KB"
            else -> String.format(java.util.Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
        }
        return if (decimalComma) s.replace('.', ',') else s
    }

    /** Un elemento compartido ya copiado a caché. */
    @kotlinx.serialization.Serializable
    data class Shared(val name: String, val contentType: String, val sizeBytes: Long, val path: String) {
        val kind: Kind get() = kind(contentType)
        val tooLarge: Boolean get() = sizeBytes > MAX_BYTES
    }

    /**
     * Qué se puede enviar desde la hoja de compartir: hasta [MAX_PER_MESSAGE] archivos (los demás se descartan y se avisa),
     * los de más de 25 MB se rechazan con su nombre.
     */
    data class Plan(val files: List<Shared>, val tooLarge: List<Shared>, val dropped: Int, val text: String) {
        val empty: Boolean get() = files.isEmpty() && text.isBlank()
    }

    fun plan(items: List<Shared>, text: String?): Plan {
        val big = items.filter { it.tooLarge }
        val ok = items.filter { !it.tooLarge }
        return Plan(ok.take(MAX_PER_MESSAGE), big, (ok.size - MAX_PER_MESSAGE).coerceAtLeast(0), text?.trim().orEmpty())
    }
}
