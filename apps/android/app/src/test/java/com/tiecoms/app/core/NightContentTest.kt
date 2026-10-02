package com.tiecoms.app.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class NightContentTest {
    @Test fun `MIME parameters casing whitespace and bytes preserve animated originals`() {
        assertEquals("image/gif", Attachments.mime(" IMAGE/GIF ; charset=binary "))
        assertTrue(AttachmentDTO(contentType = " IMAGE/GIF ; version=89a").isGif)
        assertEquals("image/gif", Attachments.detectedMime("image/jpeg", "GIF89a!".toByteArray()))
        assertEquals("image/gif", Attachments.detectedMime("application/octet-stream", "GIF87a!".toByteArray()))
        assertFalse(Attachments.isGif("GIF89".toByteArray()))
    }
    @Test fun `AI bold legacy format and fenced code stay literal before links and mentions`() {
        assertEquals("AI bold and legacy", Fmt.render("**AI bold** and *legacy*").first)
        val source = "before\n```kotlin\n\tval s = \"@gg https://example.test/**literal**\"\r\n```\nafter"
        val b = Fmt.blocks(source).single()
        assertEquals("kotlin", b.language)
        assertEquals("\tval s = \"@gg https://example.test/**literal**\"\r\n", source.substring(b.contentStart, b.contentEnd))
        assertTrue(Fmt.inCode(source, source.indexOf("@gg")))
        assertFalse(Fmt.inCode(source, 0))
        assertTrue(Fmt.blocks("```kotlin\nunclosed").isEmpty())
        assertNull(Fmt.linkParts("`https://example.test/@gg`").single().url)
    }
    @Test fun `UTF8 artifact preserves CRLF tabs unicode and body limits`() {
        val source = "\t  😄\r\n" + "x".repeat(8001) + "\n  "
        assertEquals(source, LongContent.bytes(source).toString(Charsets.UTF_8))
        assertEquals(8000, LongContent.MAX_BODY)
        assertEquals(1_048_576, LongContent.bytes("x".repeat(LongContent.MAX_AUTO_BYTES)).size)
        assertThrows(IllegalArgumentException::class.java) { LongContent.bytes("😀".repeat(400_000)) }
    }
    @Test fun `credits are stripped only with exact server provenance`() {
        val a = AttachmentDTO(provenance = AttachmentProvenanceDTO(attribution = "GIF: exact · CC0"))
        assertEquals("", LongContent.visibleBody("GIF: exact · CC0", listOf(a)))
        assertEquals("GIF: My own comment", LongContent.visibleBody("GIF: My own comment", listOf(a)))
        assertEquals("caption", LongContent.visibleBody("caption\n\nGIF: exact · CC0", listOf(a)))
        assertEquals("GIF: exact · CC0", LongContent.visibleBody("GIF: exact · CC0", emptyList()))
    }
    @Test fun `silent status expires and unknown never means available`() {
        val now = Instant.parse("2026-10-01T12:00:00Z").toEpochMilli()
        assertTrue(AvailabilityDTO("focus", "2026-10-01T13:00:00Z", true).quiet(now))
        assertFalse(AvailabilityDTO("rest", "2026-10-01T11:00:00Z", true).quiet(now))
        assertFalse(AvailabilityDTO("busy", null, false).quiet(now))
        assertFalse(AvailabilityDTO("unknown", null, true).active(now))
    }
    @Test fun `multiple assignees scope status and grouping share a coherent count`() {
        val task = IssueDTO(id = "t", ownerId = "a", assigneeIds = listOf("a", "b", "c", "d"))
        assertTrue(IssueTasks.matches("mine", "active", task, "c"))
        assertFalse(IssueTasks.matches("mine", "active", task, "z"))
        assertEquals(1, IssueTasks.myOpenCount(listOf(task), "d"))
        assertTrue(IssueTasks.matches("mine", "completed", task.copy(status = "done"), "b"))
        assertFalse(IssueTasks.matches("mine", "active", task.copy(status = "done"), "b"))
        assertEquals(4, IssueTasks.sections(listOf(task), true, "a") { it }.size)
        val old = TcJson.decodeFromString(IssueDTO.serializer(), """{"id":"legacy","ownerId":"a"}""")
        assertTrue(old.assigneeIds.isEmpty()); assertTrue(IssueTasks.matches("mine", "active", old, "a"))
    }
    @Test fun `bounded 8000 unit parser corpus has a measured budget`() {
        val samples = listOf("*".repeat(8000), "`x` **bold** ".repeat(615).take(8000), "```\n" + "x".repeat(7989) + "\n```")
        repeat(20) { samples.forEach { Fmt.blocks(it); Fmt.spans(it) } }
        val times = (0 until 100).map { val start = System.nanoTime(); samples.forEach { Fmt.blocks(it); Fmt.spans(it) }; (System.nanoTime() - start) / 1_000_000.0 }.sorted()
        println("N15 parser corpus 3x8000 p50=${times[50]}ms p95=${times[95]}ms")
        assertTrue("p95 parser budget", times[95] < 50)
    }
}
