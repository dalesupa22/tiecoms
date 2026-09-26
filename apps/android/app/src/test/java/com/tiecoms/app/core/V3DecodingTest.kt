package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v3: vista previa de enlaces, chats `multi`, fotos de perfil y árbol de archivos (decodificación tolerante),
 * más títulos, agrupación por empresa, armado del reenvío, enlaces del texto y utilidades de fotos.
 */
class V3DecodingTest {
    private fun ev(json: String) = decodeConversationEvent(TcJson.parseToJsonElement(json))
    private fun acc(json: String) = decodeAccountEvent(TcJson.parseToJsonElement(json))

    // ---------- Decodificación ----------
    @Test fun `vista previa de enlace completa, parcial, nula y ausente`() {
        val full = TcJson.decodeFromString(MessageDTO.serializer(), """
            {"id":"m","seq":3,"body":"mira https://www.example.com/a","linkPreview":{"url":"https://www.example.com/a","title":"Ejemplo","description":"Desc",
             "siteName":null,"imageUrl":"/api/v1/previews/0b1c","video":"nuevo"}}""")
        val p = full.linkPreview!!
        assertEquals("Ejemplo", p.title); assertEquals("/api/v1/previews/0b1c", p.imageUrl)
        assertEquals("example.com", p.host)
        assertTrue(p.usable)
        assertEquals("Sitio", p.copy(siteName = "Sitio").host)
        val partial = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","body":"x","linkPreview":{"url":"https://a.co"}}""").linkPreview!!
        assertNull(partial.title); assertNull(partial.imageUrl); assertEquals("a.co", partial.host)
        assertNull(TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","body":"x","linkPreview":null}""").linkPreview)
        assertNull(TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","body":"x"}""").linkPreview)
        // Sin url usable no se pinta la tarjeta.
        assertFalse(TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m","body":"x","linkPreview":{"title":"t"}}""").linkPreview!!.usable)
        assertFalse(LinkPreviewDTO(url = "javascript:alert(1)").usable)
    }

    @Test fun `message updated con linkPreview reemplaza el mensaje`() {
        val created = ev("""{"type":"message.created","conversationId":"c","eventSeq":5,"message":{"id":"m1","conversationId":"c","seq":2,"body":"https://a.co"}}""")
            as ConversationEvent.MessageCreated
        val updated = ev("""{"type":"message.updated","conversationId":"c","eventSeq":6,"message":{"id":"m1","seq":2,"body":"https://a.co",
            "linkPreview":{"url":"https://a.co","title":"A","imageUrl":"/api/v1/previews/x"}}}""") as ConversationEvent.MessageUpdated
        val before = upsertMessage(listOf(MessageDTO(id = "m0", seq = 1)), created.message)
        assertNull(before.last().linkPreview)
        val after = upsertMessage(before, updated.message)
        assertEquals(2, after.size)
        assertEquals("A", after.last().linkPreview!!.title)
        assertEquals("c", updated.message.conversationId)
    }

    @Test fun `conversacion multi y tipos desconocidos`() {
        val c = TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c","kind":"multi","workspaceId":null,"name":null,"memberIds":["u1","u2","u3"]}""")
        assertEquals("multi", c.kind); assertNull(c.workspaceId); assertTrue(c.isChat)
        assertTrue(c.copy(kind = "direct").isChat)
        assertFalse(c.copy(kind = "group").isChat)
        val future = TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"c","kind":"broadcast","memberIds":[]}""")
        assertFalse(future.isChat)
        assertEquals("Equipo", Names.conversationTitle(future.copy(name = "Equipo"), null, "Interno", "Conversación"))
        val r = TcJson.decodeFromString(CreateChatResult.serializer(), """{"id":"x","kind":"direct","created":false}""")
        assertEquals("direct", r.kind)
        assertEquals("multi", TcJson.decodeFromString(CreateChatResult.serializer(), """{"id":"x"}""").kind)
    }

    @Test fun `avatarUrl en persona y usuario`() {
        val b = TcJson.decodeFromString(BootstrapDTO.serializer(), """
            {"me":{"id":"u1","name":"Ana","avatarUrl":"/api/v1/avatars/aaa"},
             "people":[{"id":"u2","name":"Mateo","avatarUrl":"/api/v1/avatars/bbb"},{"id":"u3","name":"Laura","avatarUrl":null},{"id":"u4","name":"Sin"}]}""")
        assertEquals("/api/v1/avatars/aaa", b.me.avatarUrl)
        assertEquals("/api/v1/avatars/bbb", b.people[0].avatarUrl)
        assertNull(b.people[1].avatarUrl); assertNull(b.people[2].avatarUrl)
        assertEquals("https://app.chaggu.com/api/v1/avatars/bbb", Media.absolute(b.people[0].avatarUrl, "https://app.chaggu.com/"))
        assertEquals("http://10.0.2.2:3041/api/v1/previews/p", Media.absolute("api/v1/previews/p", "http://10.0.2.2:3041"))
        assertEquals("https://cdn.x/y.jpg", Media.absolute("https://cdn.x/y.jpg", "https://app.chaggu.com"))
        assertNull(Media.absolute(null, "https://app.chaggu.com")); assertNull(Media.absolute("", "https://app.chaggu.com"))
    }

    @Test fun `arbol de archivos con campos extra y nulos`() {
        val t = TcJson.decodeFromString(DriveTreeDTO.serializer(), """
            {"workspaceId":null,"canManageAll":true,"quota":1,
             "folders":[{"id":"f1","parentId":null,"name":"Contratos","createdBy":"u1","createdAt":"2026-09-24T10:00:00Z"},
                        {"id":"f2","parentId":"f1","name":"2026","createdBy":"u1","createdAt":"x"},
                        {"id":"f0","parentId":null,"name":"actas"}],
             "files":[{"id":"a1","folderId":"f1","name":"b.pdf","contentType":"application/pdf","size":2048,"createdBy":"u1","createdAt":"2026-09-24T10:00:00Z","updatedAt":"x"},
                      {"id":"a2","folderId":null,"name":"A.png","contentType":null,"size":10},
                      {"id":"a3","folderId":"f1","name":"a.txt","size":"12"}]}""")
        assertTrue(t.canManageAll); assertNull(t.workspaceId)
        assertEquals(listOf("actas", "Contratos"), t.foldersIn(null).map { it.name })
        assertEquals(listOf("2026"), t.foldersIn("f1").map { it.name })
        assertEquals(listOf("a.txt", "b.pdf"), t.filesIn("f1").map { it.name })
        assertEquals("application/octet-stream", t.filesIn(null)[0].contentType)
        assertEquals(12L, t.files.first { it.id == "a3" }.size)
        assertEquals(listOf("Contratos", "2026"), t.pathTo("f2").map { it.name })
        assertTrue(t.pathTo(null).isEmpty())
        val (fs, as_) = t.search("CONT")
        assertEquals(listOf("f1"), fs.map { it.id }); assertTrue(as_.isEmpty())
        assertEquals(listOf("a2"), t.search("png").second.map { it.id })
        assertTrue(t.search("  ").first.isEmpty())
        val empty = TcJson.decodeFromString(DriveTreeDTO.serializer(), "{}")
        assertTrue(empty.folders.isEmpty() && empty.files.isEmpty() && !empty.canManageAll)
        assertEquals("https://s3/x?sig=1", TcJson.decodeFromString(LinkResult.serializer(), """{"url":"https://s3/x?sig=1","expiresIn":300}""").url)
    }

    @Test fun `evento de cuenta drive updated`() {
        assertEquals(AccountEvent.DriveUpdated(null), acc("""{"type":"drive.updated","workspaceId":null}"""))
        assertEquals(AccountEvent.DriveUpdated("w1"), acc("""{"type":"drive.updated","workspaceId":"w1"}"""))
        assertTrue(acc("""{"type":"drive.moved"}""") is AccountEvent.Unknown)
    }

    // ---------- Títulos y agrupación ----------
    private val data = TcJson.decodeFromString(BootstrapDTO.serializer(), """
        {"me":{"id":"me","name":"Ana Ruiz","primaryOrgId":"o1"},
         "organizations":[{"id":"o1","name":"Zeta Obras","mark":"ZO"},{"id":"o2","name":"Beta","mark":"B"},{"id":"o3","name":"Álamo","mark":"Á"}],
         "people":[
           {"id":"me","name":"Ana Ruiz","orgId":"o1"},
           {"id":"p1","name":"Mateo Gil","orgId":"o2","title":"Gerente","area":"Compras"},
           {"id":"p2","name":"laura Díaz","orgId":"o1","title":"Diseñadora"},
           {"id":"p3","name":"Óscar Peña","orgId":"o3","area":"Operaciones"},
           {"id":"p4","name":"Pedro Tercero","orgId":null,"guest":true},
           {"id":"p5","name":"Bot Agenda","orgId":"o1","kind":"agent"},
           {"id":"p6","name":"Inés Vega","orgId":"o-desconocida"},
           {"id":"p7","name":"Carla Mora","orgId":"o2"}
         ]}""")

    @Test fun `titulo de un multi sin nombre`() {
        val l = Names.Labels("Chat grupal", "y %1${'$'}d más")
        fun multi(vararg ids: String, name: String? = null) = ConversationDTO(id = "c", kind = "multi", name = name, memberIds = listOf("me", *ids))
        assertEquals("Mateo, laura", Names.conversationTitle(multi("p1", "p2"), data, "I", "C", l))
        assertEquals("Mateo, laura, Óscar", Names.conversationTitle(multi("p1", "p2", "p3"), data, "I", "C", l))
        assertEquals("Mateo, laura, Óscar y 2 más", Names.conversationTitle(multi("p1", "p2", "p3", "p4", "p7"), data, "I", "C", l))
        assertEquals("Obra 12", Names.conversationTitle(multi("p1", "p2", name = "Obra 12"), data, "I", "C", l))
        assertEquals("Mateo, laura", Names.conversationTitle(multi("p1", "p2", name = "  "), data, "I", "C", l))
        assertEquals("Chat grupal", Names.conversationTitle(multi(), data, "I", "C", l))
        assertEquals("Group chat", Names.conversationTitle(multi("zz"), data, "I", "C", Names.Labels("Group chat", "and %1${'$'}d more")))
        assertEquals("Mateo, laura, Óscar and 1 more", Names.multiTitle(multi("p1", "p2", "p3", "p7"), data, Names.Labels("Group chat", "and %1${'$'}d more")))
        assertEquals("Chat grupal · Zeta Obras, Beta", Names.multiSubtitle(multi("p1", "p2"), data, l))
        assertEquals(listOf("p1", "p2"), Names.others(multi("p1", "p2"), data).map { it.id })
    }

    @Test fun `personas agrupadas por empresa`() {
        val g = Names.peopleByOrg(data, "")
        // Primero mi empresa (Tu equipo), luego las demás por nombre (Álamo antes que Beta), al final terceros.
        assertEquals(listOf("o1", "o3", "o2", Names.GUESTS), g.map { it.key })
        assertTrue(g[0].isMine); assertFalse(g[1].isMine)
        // Sin mí ni agentes; ordenados por nombre sin importar mayúsculas.
        assertEquals(listOf("p2"), g[0].people.map { it.id })
        assertEquals(listOf("p7", "p1"), g[2].people.map { it.id })
        // Persona de una empresa que no está en el snapshot → terceros.
        assertEquals(listOf("p6", "p4"), g[3].people.map { it.id })
        assertNull(g[3].org)
        // Buscador por nombre, cargo, área o empresa, sin tildes.
        assertEquals(listOf("p1"), Names.peopleByOrg(data, "gerente").flatMap { it.people }.map { it.id })
        assertEquals(listOf("p3"), Names.peopleByOrg(data, "operaciones").flatMap { it.people }.map { it.id })
        assertEquals(listOf("p3"), Names.peopleByOrg(data, "alamo").flatMap { it.people }.map { it.id })
        assertEquals(listOf("p2"), Names.peopleByOrg(data, "DIAZ").flatMap { it.people }.map { it.id })
        assertEquals(listOf("p7", "p1"), Names.peopleByOrg(data, "beta").flatMap { it.people }.map { it.id })
        assertTrue(Names.peopleByOrg(data, "nadie así").isEmpty())
        // Excluir a quienes ya están (sumar personas).
        assertEquals(listOf("p7"), Names.peopleByOrg(data, "beta", exclude = setOf("p1")).flatMap { it.people }.map { it.id })
        assertEquals("Gerente · Compras", Names.roleLine(data.people.first { it.id == "p1" }))
        assertEquals("Operaciones", Names.roleLine(data.people.first { it.id == "p3" }))
        assertEquals("", Names.roleLine(data.people.first { it.id == "p4" }))
        assertEquals(listOf("o1", "o2", "o3"), Names.chatOrgs(data, listOf("p1", "p2", "p3", "p7")).map { it.id })
        assertEquals(listOf("o1"), Names.chatOrgs(data, listOf("p2")).map { it.id })
    }

    // ---------- Reenvío ----------
    @Test fun `armado del reenvio a varios chats`() {
        val src = MessageDTO(id = "m", conversationId = "orig", seq = 9, authorId = "p1", body = "Texto original", createdAt = "2026-09-24T10:00:00Z")
        val plan = Forwarding.plan(src, listOf("c1", "c2"), "  Miren esto  ", "Mateo Gil")
        assertEquals(4, plan.size)
        assertEquals(Outgoing("c1", "Miren esto"), plan[0])
        assertEquals("c1", plan[1].conversationId); assertEquals("Texto original", plan[1].body)
        assertEquals(ForwardedInfo("tiecoms", "Mateo Gil", "2026-09-24T10:00:00Z", "orig"), plan[1].forwarded)
        assertEquals(listOf("c2", "c2"), plan.drop(2).map { it.conversationId })
        assertNull(plan[2].forwarded)
        // Sin comentario: solo el original. Sin repetir, sin el chat de origen y hasta 10 destinos.
        val many = Forwarding.plan(src, listOf("orig", "c1", "c1") + (2..14).map { "c$it" }, "   ", null)
        assertEquals(MAX_FORWARD_TARGETS, many.size)
        assertEquals((1..10).map { "c$it" }, many.map { it.conversationId })
        assertTrue(many.all { it.forwarded?.author == null && it.forwarded?.source == "tiecoms" })
        assertTrue(Forwarding.plan(src, emptyList(), "x", null).isEmpty())
    }

    // ---------- Enlaces del texto y fotos ----------
    @Test fun `enlaces del texto sin la puntuacion final`() {
        val parts = Links.split("Mira https://a.co/x?y=1, y (http://b.co). Listo")
        assertEquals(listOf("https://a.co/x?y=1", "http://b.co"), parts.mapNotNull { it.url })
        assertEquals("Mira https://a.co/x?y=1, y (http://b.co). Listo", parts.joinToString("") { it.text })
        assertTrue(Links.split("sin enlaces").none { it.url != null })
        assertEquals(listOf("HTTPS://X.CO"), Links.split("HTTPS://X.CO").mapNotNull { it.url })
        assertEquals(listOf("https://a.co/ñ"), Links.split("«https://a.co/ñ»").mapNotNull { it.url })
        assertTrue(Links.split("").isEmpty())
    }

    @Test fun `recorte al centro y utilidades de archivos`() {
        assertEquals(Triple(420, 0, 1080), Media.centerSquare(1920, 1080))
        assertEquals(Triple(0, 100, 600), Media.centerSquare(600, 800))
        assertEquals(Triple(0, 0, 512), Media.centerSquare(512, 512))
        assertEquals(4, Media.sampleSize(4000, 3000, 512))
        assertEquals(1, Media.sampleSize(800, 600, 512))
        assertEquals(1, Media.sampleSize(100, 100, 512))
        assertEquals("512 B", Media.sizeText(512)); assertEquals("2 KB", Media.sizeText(2048)); assertEquals("1.5 MB", Media.sizeText(1_572_864))
        assertEquals("25 MB", Media.sizeText(25L * 1024 * 1024))
        assertEquals("📕", Media.fileIcon("application/pdf", "x")); assertEquals("🖼", Media.fileIcon("image/png", "x"))
        assertEquals("📊", Media.fileIcon("application/octet-stream", "Plan.XLSX")); assertEquals("📎", Media.fileIcon("", "x.bin"))
    }
}
