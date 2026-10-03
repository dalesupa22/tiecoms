package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** 1.7.14: adjuntos de una tarea (lo que se manda en attachmentIds), sin servidor. */
class Android1714Test {
    private val t = IssueDTO(id = "t", title = "x", attachments = listOf(AttachmentDTO(id = "a"), AttachmentDTO(id = "b")))

    @Test fun `sumar conserva los que tenia, en orden y sin repetir`() {
        assertEquals(listOf("a", "b", "c"), IssueTasks.attachmentIds(t, listOf("c", "a")))
    }

    @Test fun `quitar deja los demas`() {
        assertEquals(listOf("b"), IssueTasks.attachmentIds(t, removed = "a"))
    }

    @Test fun `la tarea decodifica sus adjuntos y los viejos llegan vacios`() {
        val i = TcJson.decodeFromString(IssueDTO.serializer(), """{"id":"t","attachments":[{"id":"f","name":"acta.pdf","contentType":"application/pdf","sizeBytes":9,"url":"/api/v1/attachments/f"}]}""")
        assertEquals("acta.pdf", i.attachments.single().name)
        assertEquals(0, TcJson.decodeFromString(IssueDTO.serializer(), """{"id":"t"}""").attachments.size)
    }
}
