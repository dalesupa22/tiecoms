package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SPEC-v4: adjuntos (contrato e68dbe8), compartir hacia Chaggu, pestañas de Inicio y contraste de badges. */
class ShareV4Test {
    private val labels = Attachments.Labels("📷 Foto", "📷 %d fotos", "🎬 Video", "🎬 %d videos", "🖼 %d fotos y videos", "📎 %s", "📎 %d archivos")
    private fun att(id: String, type: String, name: String = "$id.bin") = AttachmentDTO(id = id, name = name, contentType = type, url = "/api/v1/attachments/$id")

    // ---------- Contrato ----------
    @Test fun `decodifica adjuntos, lastHumanPreview y mensajes viejos`() {
        val m = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","body":"","attachments":[
            {"id":"a1","name":"foto.jpg","contentType":"image/jpeg","sizeBytes":1234,"width":4032,"height":3024,"url":"/api/v1/attachments/a1","thumbUrl":"/api/v1/attachments/a1/thumb"},
            {"id":"a2","name":"acta.pdf","contentType":"application/pdf","sizeBytes":99,"width":null,"height":null,"url":"/api/v1/attachments/a2","thumbUrl":null,"futuro":1}]}""")
        assertEquals(2, m.attachments.size); assertTrue(m.attachments[0].isImage); assertEquals(4032, m.attachments[0].width)
        assertNull(m.attachments[1].thumbUrl); assertFalse(m.attachments[1].isImage || m.attachments[1].isVideo)
        assertTrue(TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"old","body":"hola"}""").attachments.isEmpty())
        val c = TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c","lastMessagePreview":"{\"k\":\"issue.opened\"}",
            "lastHumanPreview":{"messageId":"m9","seq":9,"authorId":"u1","body":"","attachments":{"count":3,"images":3,"videos":0,"files":0,"firstName":"a.jpg"},"createdAt":"2026-09-25T10:00:00Z"}}""")
        assertEquals("u1", c.lastHumanPreview?.authorId); assertEquals(3, c.lastHumanPreview?.attachments?.images)
        assertNull(TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c","lastHumanPreview":null}""").lastHumanPreview)
    }

    @Test fun `el envio lleva attachmentIds y forwardAttachmentIds solo si hay`() {
        val with = TcJson.encodeToString(SendBody.serializer(), SendBody("cm", "", attachmentIds = listOf("a1", "a2"), forwardAttachmentIds = listOf("f1")))
        assertTrue(with.contains("\"attachmentIds\":[\"a1\",\"a2\"]")); assertTrue(with.contains("\"forwardAttachmentIds\":[\"f1\"]")); assertTrue(with.contains("\"body\":\"\""))
        val without = TcJson.encodeToString(SocketSendBody.serializer(), SocketSendBody("c", "cm", "hola"))
        assertFalse(without.contains("attachmentIds")); assertFalse(without.contains("forwardAttachmentIds"))
    }

    @Test fun `reenviar un mensaje con adjuntos los copia por referencia`() {
        val src = MessageDTO(id = "m", conversationId = "o", body = "", attachments = listOf(att("a1", "image/png")))
        val plan = Forwarding.plan(src, listOf("t1", "o", "t2"), "mira", "Ana")
        assertEquals(listOf("t1", "t1", "t2", "t2"), plan.map { it.conversationId })
        assertTrue(plan.filter { it.forwarded != null }.all { it.forwardAttachments.map { a -> a.id } == listOf("a1") })
        assertTrue(plan.filter { it.forwarded == null }.all { it.forwardAttachments.isEmpty() })
    }

    // ---------- Vista previa ----------
    @Test fun `vista previa como la web y el push`() {
        assertEquals("📷 Foto", Attachments.preview(listOf(att("a", "image/jpeg")), "", labels))
        assertEquals("📷 3 fotos · hola", Attachments.preview(List(3) { att("a$it", "image/png") }, " hola ", labels))
        assertEquals("🎬 Video", Attachments.preview(listOf(att("v", "video/mp4")), "", labels))
        assertEquals("🖼 2 fotos y videos", Attachments.preview(listOf(att("a", "image/png"), att("v", "video/mp4")), "", labels))
        assertEquals("📎 acta.pdf", Attachments.preview(listOf(att("p", "application/pdf", "acta.pdf")), "", labels))
        assertEquals("📎 2 archivos", Attachments.preview(listOf(att("p", "application/pdf"), att("i", "image/png")), "", labels))
        assertEquals("texto", Attachments.preview(emptyList(), "texto", labels))
        val voice = AttachmentDTO(id = "v", name = "nota.m4a", contentType = "audio/mp4", kind = "voice", durationMs = 42_000)
        assertEquals("🎤 Nota de voz (0:42)", Attachments.preview(listOf(voice), "", labels.copy(voice = "🎤 Nota de voz (%s)")))
        assertEquals("📷 2 fotos", Attachments.preview(AttachmentSummaryDTO(2, 2, 0, 0, "x.jpg"), "", labels))
        assertEquals("📎 plan.xlsx · ok", Attachments.preview(AttachmentSummaryDTO(1, 0, 0, 1, "plan.xlsx"), "ok", labels))
        assertEquals("solo texto", Attachments.preview(null as AttachmentSummaryDTO?, "solo texto", labels))
    }

    // ---------- §F Notas de voz ----------
    @Test fun `nota de voz - contrato, onda, cabeceras y gesto`() {
        val a = TcJson.decodeFromString(AttachmentDTO.serializer(), """{"id":"v","name":"nota.m4a","contentType":"audio/mp4","kind":"voice","durationMs":42000,
            "waveform":[0,0.5,1],"transcript":{"status":"done","text":"Hola equipo","language":"es","summary":null}}""")
        assertTrue(a.isVoice); assertFalse(a.isImage || a.isVideo); assertEquals(42_000L, a.durationMs); assertEquals("Hola equipo", a.transcript?.text)
        assertFalse(TcJson.decodeFromString(AttachmentDTO.serializer(), """{"id":"f","contentType":"audio/mpeg"}""").isVoice)
        val w = Waveform.downsample(List(640) { i -> if (i % 10 == 0) 0.8f else 0.2f } + List(10) { 0.4f })
        assertEquals(64, w.size); assertEquals(1f, w.max(), 0.001f); assertTrue(w.all { it in 0f..1f })
        assertEquals(listOf(0f, 0f), Waveform.downsample(listOf(0f, 0f)))
        assertEquals("0.00,0.50,1.00", Waveform.encode(listOf(0f, 0.5f, 1.2f)))
        val h = TieComsClient.Voice(42_000, listOf(0.1f, 0.9f)).headers()
        assertEquals("1", h["x-voice-note"]); assertEquals("42000", h["x-duration-ms"]); assertEquals("0.10,0.90", h["x-waveform"])
        assertEquals("0:42", Waveform.clock(42_999)); assertEquals("12:05", Waveform.clock(725_000))
        assertEquals(Waveform.Gesture.RECORDING, Waveform.gesture(-40f, -20f))
        assertEquals(Waveform.Gesture.CANCEL, Waveform.gesture(-120f, 0f))
        assertEquals(Waveform.Gesture.LOCK, Waveform.gesture(0f, -90f))
    }

    // ---------- Compartir ----------
    @Test fun `plan de compartir - maximo 10, mas de 25 MB fuera, tipos`() {
        val big = Attachments.Shared("video.mov", "video/quicktime", Attachments.MAX_BYTES + 1, "")
        val many = List(12) { Attachments.Shared("f$it.jpg", "image/jpeg", 1000, "/c/f$it") }
        val p = Attachments.plan(many + big, "  https://chaggu.com  ")
        assertEquals(10, p.files.size); assertEquals(2, p.dropped); assertEquals(listOf(big), p.tooLarge); assertEquals("https://chaggu.com", p.text)
        assertTrue(Attachments.plan(emptyList(), " ").empty)
        assertFalse(Attachments.plan(emptyList(), "hola").empty)
        assertEquals(Attachments.Kind.IMAGE, Attachments.kind("image/heic")); assertEquals(Attachments.Kind.VIDEO, Attachments.kind("video/mp4"))
        assertEquals(Attachments.Kind.FILE, Attachments.kind("application/pdf")); assertEquals(Attachments.Kind.FILE, Attachments.kind(null))
        assertEquals("820 B", Attachments.size(820)); assertEquals("12 KB", Attachments.size(12 * 1024)); assertEquals("3,4 MB", Attachments.size((3.4 * 1024 * 1024).toLong()))
        assertEquals(5, Attachments.MAX_TARGETS)
    }

    // ---------- §C Pestañas ----------
    private val d = TcJson.decodeFromString(BootstrapDTO.serializer(), """
        {"me":{"id":"me"},
         "organizations":[{"id":"mine","name":"Mía","myRole":"admin"},{"id":"acme","name":"Acme"}],
         "workspaces":[{"id":"w1","name":"Proyecto","owningOrgId":"mine","organizationIds":["mine","acme"]},
                       {"id":"w2","name":"Interno","owningOrgId":"mine","organizationIds":["mine"]}],
         "conversations":[
           {"id":"g1","workspaceId":"w1","kind":"group","name":"general","unread":3,"openIssues":2},
           {"id":"g2","workspaceId":"w1","kind":"group","name":"ventas","unread":2,"mutedUntil":"2999-01-01T00:00:00Z"},
           {"id":"s1","workspaceId":"w1","kind":"group","name":"consulta","parentId":"g1","parentMessageId":"m1","deriveKind":"side"},
           {"id":"i1","workspaceId":"w2","kind":"internal","name":"equipo"},
           {"id":"d1","kind":"direct","memberIds":["me","p1"],"unread":1},
           {"id":"m1","kind":"multi","name":"Almuerzo"}]}""")
    private fun keys(tab: HomeTree.Tab, collapsed: Set<String> = emptySet()) = HomeTree.build(d, "", null, collapsed, { it.name ?: it.id }, nowMs = 0, tab = tab).map { it.key }

    @Test fun `contadores de pestañas`() {
        val n = HomeTree.counts(d, 0)
        assertEquals(6, n[HomeTree.Tab.ALL]); assertEquals(2, n[HomeTree.Tab.UNREAD]) // g1 y d1 (g2 silenciado)
        assertEquals(1, n[HomeTree.Tab.ISSUES]); assertEquals(2, n[HomeTree.Tab.CHATS]); assertEquals(1, n[HomeTree.Tab.SIDES])
    }

    @Test fun `filtros mantienen la jerarquia y ocultan grupos vacios`() {
        assertEquals(listOf("s:COMPANIES", "o:acme", "w:w1", "c:g1", "s:CHATS", "c:d1"), keys(HomeTree.Tab.UNREAD))
        // Un filtro abre lo contraído: una empresa contraída no esconde un no leído.
        assertEquals(keys(HomeTree.Tab.UNREAD), keys(HomeTree.Tab.UNREAD, setOf("org:acme", "ws:w1")))
        assertEquals(listOf("s:COMPANIES", "o:acme", "w:w1", "c:g1"), keys(HomeTree.Tab.ISSUES))
        assertEquals(listOf("s:CHATS", "c:m1", "c:d1").sorted(), keys(HomeTree.Tab.CHATS).sorted())
        // Laterales: cuelgan de su origen (el origen se muestra como contexto).
        assertEquals(listOf("s:COMPANIES", "o:acme", "w:w1", "c:g1", "c:s1"), keys(HomeTree.Tab.SIDES))
        val all = keys(HomeTree.Tab.ALL)
        assertTrue(all.containsAll(listOf("c:g1", "c:s1", "c:g2", "c:i1", "c:d1", "c:m1")))
    }

    @Test fun `estado vacio amable cuando no hay nada`() {
        val clean = d.copy(conversations = d.conversations.map { it.copy(unread = 0) })
        val rows = HomeTree.build(clean, "", null, emptySet(), { it.id }, nowMs = 0, tab = HomeTree.Tab.UNREAD)
        assertEquals(listOf<HomeTree.Row>(HomeTree.Empty(HomeTree.Kind.FILTER)), rows)
    }

    // ---------- Badges ----------
    @Test fun `badge con el color de la empresa solo si pasa AA con blanco`() {
        assertTrue(Contrast.ratio(Contrast.SOBER_ORANGE, 0xFFFFFFFF) >= 4.5)
        assertEquals(0xFF1E3A8A, Contrast.badgeBackground("#1E3A8A"))          // azul oscuro: pasa
        assertEquals(Contrast.SOBER_ORANGE, Contrast.badgeBackground("#F9A8D4")) // rosa pálido: no pasa
        assertEquals(Contrast.SOBER_ORANGE, Contrast.badgeBackground("#FF7A00")) // naranja de marca: 2,6:1
        assertEquals(Contrast.SOBER_ORANGE, Contrast.badgeBackground(null)); assertEquals(Contrast.SOBER_ORANGE, Contrast.badgeBackground("rojo"))
        assertEquals(Contrast.SOBER_ORANGE, Contrast.badgeBackground("#000")) // como la web: solo #RRGGBB
        assertEquals(0xFF000000, Contrast.badgeBackground("000000"))
        assertEquals(21.0, Contrast.ratio(0xFF000000, 0xFFFFFFFF), 0.01)
    }

    // ---------- §D Orden por no leídos (compareConversations / sortHome de la web) ----------
    @Test fun `no leidos primero, luego fijadas, luego actividad, desempate por id`() {
        fun c(id: String, unread: Int = 0, pinned: Boolean = false, at: String = "2026-09-20T10:00:00Z", muted: Boolean = false, human: String? = null) =
            ConversationDTO(id = id, kind = "direct", unread = unread, pinnedAt = if (pinned) "2026-09-01T00:00:00Z" else null, lastMessageAt = at,
                mutedUntil = if (muted) "2999-01-01T00:00:00Z" else null, lastHumanPreview = human?.let { LastHumanPreviewDTO(createdAt = it) })
        val list = listOf(
            c("a", at = "2026-09-25T10:00:00Z"),
            c("b", unread = 2, at = "2026-09-20T10:00:00Z"),
            c("c", pinned = true, at = "2026-09-10T10:00:00Z"),
            c("d", unread = 5, muted = true, at = "2026-09-26T10:00:00Z"),        // silenciada con no leídos = leída
            c("e", unread = 1, pinned = true, at = "2026-09-01T10:00:00Z"),
            c("f", at = "2026-09-01T00:00:00Z", human = "2026-09-24T00:00:00Z"),  // actividad = último mensaje humano
            c("g", at = "2026-09-25T10:00:00Z"),                                   // empata con «a»: por id
        )
        assertEquals(listOf("e", "b", "c", "d", "a", "g", "f"), HomeTree.order(list, 0).map { it.id })
        assertEquals(HomeTree.order(list, 0), HomeTree.order(list.reversed(), 0)) // estable, sin depender del orden de llegada
        assertTrue(HomeTree.compareRank(HomeTree.Rank(1, ""), HomeTree.Rank(0, "2999")) < 0)
        assertTrue(HomeTree.compareRank(HomeTree.Rank(5, "2020"), HomeTree.Rank(2, "2026")) < 0)
        assertTrue(HomeTree.compareRank(HomeTree.Rank(0, "2026-09-25"), HomeTree.Rank(0, "2026-09-20")) < 0)
    }

    @Test fun `empresas y espacios con no leidos suben`() {
        val keys = HomeTree.build(d.copy(conversations = d.conversations.map { if (it.id == "i1") it.copy(unread = 9) else it }), "", null, emptySet(), { it.id }, nowMs = 0)
            .filter { it is HomeTree.Org || it is HomeTree.Ws }.map { it.key }
        // «mine» (i1 con 9) supera a «acme» (g1 con 3); dentro de acme el único espacio es w1.
        assertEquals(listOf("o:mine", "w:w2", "o:acme", "w:w1"), keys)
    }

    // ---------- §D Grupo en un espacio ----------
    @Test fun `grupo en un espacio - espacios sin tercero y personas del espacio`() {
        val b = TcJson.decodeFromString(BootstrapDTO.serializer(), """
            {"me":{"id":"me"},"organizations":[{"id":"mine","name":"Mía","myRole":"admin"},{"id":"acme","name":"Acme"}],
             "workspaces":[{"id":"w1","name":"Proyecto","owningOrgId":"mine","organizationIds":["mine","acme"],"memberIds":["me","p1","p2","bot"]},
                           {"id":"w2","name":"Invitado","owningOrgId":"acme","organizationIds":["acme"],"myRole":"guest","memberIds":["me","p2"]}],
             "people":[{"id":"p1","name":"Laura","orgId":"mine"},{"id":"p2","name":"Beto","orgId":"acme"},{"id":"bot","name":"Mateo","kind":"agent","orgId":"mine"}]}""")
        assertEquals(listOf("w1"), SpaceGroups.eligible(b).flatMap { it.second }.map { it.id })
        val w1 = b.workspaces[0]
        assertEquals(setOf("p1", "p2"), SpaceGroups.candidates(b, w1, internal = false))
        assertEquals(setOf("p1"), SpaceGroups.candidates(b, w1, internal = true))
        assertFalse(SpaceGroups.valid(" x ", w1)); assertTrue(SpaceGroups.valid("Pagos", w1)); assertFalse(SpaceGroups.valid("Pagos", null))
    }
}
