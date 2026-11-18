package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** CH035 (tanda 2): la porción del estado de un chat no cambia con lo que pasa en otros chats. */
class ChatSliceTest {
    private fun conv(id: String, parent: String? = null, seq: Long = 1, unread: Int = 0) =
        ConversationDTO(id = id, name = id, parentId = parent, parentMessageId = parent?.let { "m1" }, lastMessageSeq = seq, unread = unread)
    private val data = BootstrapDTO(me = UserDTO(id = "me"), people = listOf(PersonDTO(id = "me", name = "Yo"), PersonDTO(id = "ana", name = "Ana")),
        conversations = listOf(conv("abierto"), conv("hilo", parent = "abierto"), conv("ajeno"), conv("ajeno-hilo", parent = "ajeno")))
    private fun patch(d: BootstrapDTO, id: String, f: ConversationDTO.() -> ConversationDTO) = d.copy(conversations = d.conversations.map { if (it.id == id) it.f() else it })
    private val base = ClientState(status = SessionStatus.READY, data = data,
        conversations = mapOf("abierto" to ConversationState(messages = listOf(MessageDTO(id = "a1", conversationId = "abierto", seq = 1)), loaded = true),
            "ajeno" to ConversationState(loaded = true)))

    @Test fun typingAndLoadingInAnotherChatKeepTheSameSlice() {
        val slice = ChatSlice.next(null, base, "abierto")
        val typing = base.copy(typing = mapOf("ajeno" to listOf(TypingEntry("ana", 10))))
        assertSame(slice, ChatSlice.next(slice, typing, "abierto"))
        val loading = typing.copy(conversations = typing.conversations + ("ajeno" to ConversationState(loading = true)))
        assertSame(slice, ChatSlice.next(slice, loading, "abierto"))
        val pending = loading.copy(pending = listOf(PendingMessage(clientMessageId = "c1", conversationId = "ajeno", body = "x", createdAt = "")))
        assertSame(slice, ChatSlice.next(slice, pending, "abierto"))
    }

    @Test fun messageInAnotherChatKeepsTheSameSliceAndData() {
        val slice = ChatSlice.next(null, base, "abierto")
        // Como bumpMeta: cambia la fila del otro chat y se reordena la lista.
        val bumped = patch(data, "ajeno") { copy(lastMessageSeq = 2, lastMessageAt = "2026-11-18T10:00:00Z", lastMessagePreview = "hola", unread = 1, unreadMentions = 1) }
        val resorted = bumped.copy(conversations = bumped.conversations.sortedByDescending { it.lastMessageAt ?: "" }, serverTime = "otra")
        val next = ChatSlice.next(slice, base.copy(data = resorted), "abierto")
        assertSame(slice, next)
        assertSame(data, next.data)
        // El hilo de otro chat tampoco.
        assertSame(slice, ChatSlice.next(slice, base.copy(data = patch(data, "ajeno-hilo") { copy(unread = 3, lastMessageSeq = 9) }), "abierto"))
    }

    @Test fun ownChatAndItsThreadsDoChangeTheSlice() {
        val slice = ChatSlice.next(null, base, "abierto")
        val own = base.copy(data = patch(data, "abierto") { copy(lastMessageSeq = 2, unread = 1) })
        assertNotSame(slice, ChatSlice.next(slice, own, "abierto"))
        assertEquals(2, ChatSlice.next(slice, own, "abierto").data!!.conversations.first { it.id == "abierto" }.lastMessageSeq)
        // Los no leídos de un hilo propio se ven en el chat (chips y franja del árbol).
        val thread = base.copy(data = patch(data, "hilo") { copy(unread = 2) })
        assertNotSame(slice, ChatSlice.next(slice, thread, "abierto"))
        // Desde el hilo, lo que le pasa al padre también cuenta.
        val fromThread = ChatSlice.next(null, base, "hilo")
        assertNotSame(fromThread, ChatSlice.next(fromThread, own, "hilo"))
        // «Escribiendo…», mensajes y pendientes de este chat.
        assertNotSame(slice, ChatSlice.next(slice, base.copy(typing = mapOf("abierto" to listOf(TypingEntry("ana", 10)))), "abierto"))
        assertNotSame(slice, ChatSlice.next(slice, base.copy(conversations = base.conversations + ("abierto" to ConversationState(loaded = true))), "abierto"))
        assertNotSame(slice, ChatSlice.next(slice, base.copy(pending = listOf(PendingMessage(clientMessageId = "c1", conversationId = "abierto", body = "x", createdAt = ""))), "abierto"))
        assertNotSame(slice, ChatSlice.next(slice, base.copy(connection = ConnectionStatus.ONLINE), "abierto"))
    }

    @Test fun whatIsNotVolatileInOtherChatsStillReachesTheChat() {
        // Nombre, miembros, silencio o permisos de otro chat sí cambian `data` (títulos, reenviar, menciones).
        assertFalse(ChatSlice.sameForChat(data, patch(data, "ajeno") { copy(name = "Otro nombre") }, "abierto"))
        assertFalse(ChatSlice.sameForChat(data, patch(data, "ajeno") { copy(memberIds = listOf("me")) }, "abierto"))
        assertFalse(ChatSlice.sameForChat(data, patch(data, "ajeno") { copy(parentId = "abierto") }, "abierto"))
        assertFalse(ChatSlice.sameForChat(data, data.copy(conversations = data.conversations + conv("nuevo")), "abierto"))
        assertFalse(ChatSlice.sameForChat(data, data.copy(people = data.people + PersonDTO(id = "luis", name = "Luis")), "abierto"))
        assertFalse(ChatSlice.sameForChat(data, data.copy(missedCalls = 1), "abierto"))
        assertTrue(ChatSlice.sameForChat(data, data.copy(serverTime = "otra"), "abierto"))
    }

    @Test fun rowsIgnoreVolatileFieldsOfEveryChatButNotNames() {
        assertTrue(ChatSlice.sameForRows(data, patch(data, "abierto") { copy(lastMessageSeq = 5, unread = 2, lastReadSeq = 3) }))
        assertTrue(ChatSlice.sameForRows(data, patch(data, "hilo") { copy(unread = 2) }))
        assertFalse(ChatSlice.sameForRows(data, patch(data, "hilo") { copy(name = "Renombrado") }))
        assertFalse(ChatSlice.sameForRows(data, data.copy(people = listOf(PersonDTO(id = "me", name = "Yo")))))
    }

    @Test fun listsSliceIgnoresTypingAndLoadedMessages() {
        val slice = ChatSlice.lists(null, base)
        assertSame(slice, ChatSlice.lists(slice, base.copy(typing = mapOf("ajeno" to listOf(TypingEntry("ana", 10))))))
        assertSame(slice, ChatSlice.lists(slice, base.copy(conversations = emptyMap(), pins = mapOf("x" to listOf("m")))))
        // Un mensaje en cualquier chat sí cambia las listas (orden, vista previa, no leídos).
        assertNotSame(slice, ChatSlice.lists(slice, base.copy(data = patch(data, "ajeno") { copy(unread = 1) })))
        assertNotSame(slice, ChatSlice.lists(slice, base.copy(connection = ConnectionStatus.ONLINE)))
    }
}
