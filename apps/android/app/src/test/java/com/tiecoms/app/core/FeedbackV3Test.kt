package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SPEC-v3 (feedback de TestFlight): colores por persona, rachas, jerarquía de Inicio, recorte, push y laterales. */
class FeedbackV3Test {
    // ---------- §5 Quién escribió qué ----------
    @Test fun `color por persona estable, de la paleta y nunca naranja`() {
        val ids = (1..200).map { "user-$it" }
        ids.forEach { assertEquals(PersonColors.light(it), PersonColors.light(it)); assertEquals(PersonColors.index(it), PersonColors.index(it)) }
        assertTrue("usa toda la paleta", ids.map { PersonColors.index(it) }.toSet().size == 8)
        // Vectores de la web (apps/web/src/ui.tsx personColor).
        assertEquals(1, PersonColors.index("00000000-0000-0000-0000-000000000000")); assertEquals(0xFF1A7F51, PersonColors.light("00000000-0000-0000-0000-000000000000"))
        assertEquals(3, PersonColors.index("3f2b8c1e-9a4d-4e21-8b7a-1c2d3e4f5a6b")); assertEquals(0xFF0A7C87, PersonColors.light("3f2b8c1e-9a4d-4e21-8b7a-1c2d3e4f5a6b"))
        assertEquals(1, PersonColors.index("ffffffff-ffff-ffff-ffff-ffffffffffff"))
        assertEquals("sin distinguir mayúsculas", PersonColors.index("3f2b8c1e-9a4d-4e21-8b7a-1c2d3e4f5a6b"), PersonColors.index("3F2B8C1E-9A4D-4E21-8B7A-1C2D3E4F5A6B"))
        (PersonColors.LIGHT + PersonColors.DARK).forEach { argb ->
            val r = (argb shr 16) and 0xFF; val g = (argb shr 8) and 0xFF; val b = argb and 0xFF
            assertFalse("naranja de marca reservado a mis burbujas: ${argb.toString(16)}", r > 200 && g in 80..170 && b < 80)
        }
    }

    @Test fun `rachas de 5 minutos del mismo autor`() {
        val t = 1_000_000L
        assertTrue(Runs.startsRun(null, null, null, "a", "human", t, false, false))
        assertFalse(Runs.startsRun("a", "human", t, "a", "human", t + 60_000, false, false))
        assertTrue(Runs.startsRun("a", "human", t, "a", "human", t + Runs.WINDOW_MS, false, false))
        assertTrue(Runs.startsRun("a", "human", t, "b", "human", t + 1, false, false))
        assertTrue(Runs.startsRun("a", "system", t, "a", "human", t + 1, false, false))
        assertTrue("una respuesta rompe la racha", Runs.startsRun("a", "human", t, "a", "human", t + 1, true, false))
        assertFalse("los mensajes de sistema no llevan avatar", Runs.startsRun(null, null, null, "a", "system", t, false, false))
    }

    // ---------- §9 Jerarquía ----------
    private val data = TcJson.decodeFromString(BootstrapDTO.serializer(), """
        {"me":{"id":"me"},
         "organizations":[{"id":"mine","name":"Mía","myRole":"admin"},{"id":"acme","name":"Acme"},{"id":"beta","name":"Beta"}],
         "workspaces":[{"id":"w1","name":"Proyecto Acme","owningOrgId":"mine","organizationIds":["mine","acme"]},
                       {"id":"w2","name":"Interno","owningOrgId":"mine","organizationIds":["mine"]},
                       {"id":"w3","name":"Soporte Acme","owningOrgId":"acme","organizationIds":["acme","mine"]}],
         "conversations":[
           {"id":"g1","workspaceId":"w1","kind":"group","name":"general","unread":3,"lastMessageAt":"2026-09-20T10:00:00Z"},
           {"id":"g2","workspaceId":"w1","kind":"group","name":"ventas","unread":2,"mutedUntil":"2999-01-01T00:00:00Z"},
           {"id":"s1","workspaceId":"w1","kind":"group","name":"consulta","parentId":"g1","parentMessageId":"m1","deriveKind":"side","unread":1},
           {"id":"i1","workspaceId":"w2","kind":"internal","name":"equipo"},
           {"id":"g3","workspaceId":"w3","kind":"group","name":"tickets"},
           {"id":"d1","kind":"direct","memberIds":["me","p1"],"lastMessageAt":"2026-09-21T10:00:00Z"},
           {"id":"m1","kind":"multi","name":"Almuerzo","lastMessageAt":"2026-09-22T10:00:00Z"}],
         "people":[{"id":"p1","name":"Paula","kind":"human","orgId":"acme"}]}""")

    private fun build(q: String = "", ws: String? = null, collapsed: Set<String> = emptySet()) =
        HomeTree.build(data, q, ws, collapsed, { it.name ?: it.id }, nowMs = 0)

    @Test fun `espacios bajo la empresa contraparte y laterales bajo su origen`() {
        assertEquals("acme", HomeTree.counterpartOrg(data, data.workspaces[0])?.id)
        assertEquals("mine", HomeTree.counterpartOrg(data, data.workspaces[1])?.id)
        assertEquals(listOf("acme" to listOf("w1", "w3"), "mine" to listOf("w2")),
            HomeTree.groupWorkspaces(data).map { (o, l) -> o?.id to l.map { it.id } })
        val rows = build()
        val keys = rows.map { it.key }
        assertEquals(listOf("s:COMPANIES", "o:acme", "w:w1", "c:g1", "c:s1", "c:g2", "w:w3", "c:g3", "o:mine", "w:w2", "c:i1",
            "s:CHATS", "c:m1", "c:d1"), keys)
        val side = rows.first { it.key == "c:s1" } as HomeTree.Conv
        assertEquals(1, side.depth)
        // No leídos agregados sin silenciados: g1 3 + lateral 1 (g2 silenciado).
        assertEquals(4, (rows.first { it.key == "o:acme" } as HomeTree.Org).unread)
    }

    @Test fun `colapsar empresa y espacio, busqueda y filtro por espacio`() {
        val c = build(collapsed = setOf("org:acme")).map { it.key }
        assertTrue("o:acme" in c); assertFalse("w:w1" in c); assertFalse("c:g1" in c)
        assertTrue((build(collapsed = setOf("org:acme")).first { it.key == "o:acme" } as HomeTree.Org).collapsed)
        val w = build(collapsed = setOf("ws:w1")).map { it.key }
        assertTrue("w:w1" in w); assertFalse("c:g1" in w); assertTrue("c:g3" in w)
        // Buscar ignora el colapso y muestra solo lo que coincide.
        val s = build(q = "consulta", collapsed = setOf("org:acme")).map { it.key }
        assertTrue("c:s1" in s); assertTrue("c:g1" in s); assertFalse("c:g3" in s); assertFalse("c:i1" in s)
        val f = build(ws = "w2").map { it.key }
        assertEquals(listOf("s:COMPANIES", "o:mine", "w:w2", "c:i1"), f)
    }

    // ---------- §2 Recorte ----------
    @Test fun `recorte cuadrado centrado, con zoom y desplazamiento acotado`() {
        assertEquals(CropMath.Square(250, 0, 500), CropMath.cropSquare(1000, 500, 300f, 1f, 0f, 0f))
        val z = CropMath.cropSquare(1000, 1000, 300f, 2f, 0f, 0f)
        assertEquals(500, z.side); assertEquals(250, z.left); assertEquals(250, z.top)
        // Arrastrar mucho a la derecha muestra el borde izquierdo, sin salirse.
        assertEquals(0, CropMath.cropSquare(1000, 500, 300f, 1f, 10_000f, 0f).left)
        assertEquals(500, CropMath.cropSquare(1000, 500, 300f, 1f, -10_000f, 0f).left)
        val (dx, dy) = CropMath.clampOffset(1000, 500, 300f, 1f, 999f, 999f)
        assertEquals(150f, dx, 0.01f); assertEquals(0f, dy, 0.01f)
        assertTrue(CropMath.cropSquare(400, 400, 300f, 99f, 0f, 0f).side >= 400 / 5 - 1)
    }

    // ---------- §6 Push ----------
    @Test fun `payload de FCM segun contrato`() {
        val p = PushPayload.parse(mapOf("title" to "Almuerzo", "subtitle" to "Paula · Acme", "body" to "hola", "badge" to "7", "threadId" to "c1",
            "category" to "TC_MESSAGE", "type" to "message", "conversationId" to "c1", "messageId" to "m9", "authorId" to "p1",
            "authorName" to "Paula", "authorAvatarUrl" to "/api/v1/avatars/f1", "futuro" to "x"))!!
        assertEquals("Almuerzo", p.title); assertEquals("Paula · Acme", p.subtitle); assertEquals(7, p.badge)
        assertEquals("m9", p.messageId); assertEquals("/api/v1/avatars/f1", p.authorAvatarUrl)
        val d = PushPayload.parse(mapOf("type" to "message", "title" to "Paula", "subtitle" to "", "body" to "x", "badge" to "", "conversationId" to "d1", "authorAvatarUrl" to ""))!!
        assertEquals("", d.subtitle); assertEquals(0, d.badge); assertNull(d.authorAvatarUrl); assertEquals("d1", d.threadId)
        val r = PushPayload.parse(mapOf("type" to "reminder", "conversationId" to "c", "reminderId" to "r1", "title" to "⏰"))!!
        assertEquals("TC_REMINDER", r.category); assertEquals("r1", r.reminderId)
        assertEquals("TC_EVENT", PushPayload.parse(mapOf("type" to "event", "conversationId" to "c", "eventId" to "e"))!!.category)
        assertNull("tipo desconocido se ignora", PushPayload.parse(mapOf("type" to "call", "conversationId" to "c")))
        assertNull("sin conversación no hay a dónde abrir", PushPayload.parse(mapOf("type" to "message", "title" to "x")))
    }

    // ---------- §1, §4, §7 Contrato ----------
    @Test fun `foto de grupo, lateral y reenvio con messageId`() {
        val c = TcJson.decodeFromString(ConversationDTO.serializer(), """{"id":"s","kind":"group","deriveKind":"side","parentId":"g","parentMessageId":"m","avatarUrl":"/api/v1/avatars/x"}""")
        assertTrue(c.isSide); assertEquals("/api/v1/avatars/x", c.avatarUrl)
        assertFalse(c.copy(parentId = null).isSide)
        assertNull(TcJson.decodeFromString(AvatarResult.serializer(), """{"avatarUrl":null}""").avatarUrl)
        val m = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"x","body":"y","forwarded":{"source":"tiecoms","author":"Ana","sentAt":"2026-09-24T10:00:00Z","fromConversationId":"g","messageId":"m1"}}""")
        assertEquals("m1", m.forwarded?.messageId); assertEquals("g", m.forwarded?.fromConversationId)
        assertNull(TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"x","body":"y","forwarded":{"source":"whatsapp"}}""").forwarded?.messageId)
    }

    @Test fun `side_outsider trae las personas rechazadas`() {
        val e = ApiException(403, "side_outsider", "x", TcJson.parseToJsonElement("""{"userIds":["p1","p2"]}"""))
        assertEquals(setOf("p1", "p2"), SideOutsiders.from(e))
        assertTrue(SideOutsiders.from(ApiException(403, "blocked_user", "x")).isEmpty())
        assertTrue(SideOutsiders.from(IllegalStateException()).isEmpty())
        assertNotNull(e.details)
    }
}
