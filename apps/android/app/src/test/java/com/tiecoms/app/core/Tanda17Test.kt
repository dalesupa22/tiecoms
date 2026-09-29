package com.tiecoms.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.time.LocalDate
import java.util.concurrent.CopyOnWriteArrayList

/** Tanda 1.7 (docs/TANDA-1.7.md; contratos 1.7): DTOs nuevos, textos de sistema, #grupos, búsqueda y una sola vista. */
class Tanda17Test {
    @Test fun `MessageDTO con refs, una vista y openedBy`() {
        val m = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m1","seq":3,"authorId":"u2","body":"Mira #Ventas hoy",
            "refs":[{"conversationId":"c9","name":"Ventas","start":5,"length":7}],"viewOnce":false}""")
        assertEquals("c9", m.refs.single().conversationId); assertEquals(7, m.refs.single().length)
        val once = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m2","seq":4,"authorId":"u2","body":"","viewOnce":true,"viewOnceState":"unopened",
            "attachments":[{"id":"a1","kind":"image","contentType":"image/jpeg","name":"f.jpg","url":"","thumbUrl":null}],"openedBy":[{"userId":"u3","at":"2026-09-29T10:00:00Z"}]}""")
        assertTrue(once.viewOnce); assertEquals("unopened", once.viewOnceState); assertEquals("u3", once.openedBy.single().userId)
        val old = TcJson.decodeFromString(MessageDTO.serializer(), """{"id":"m3","body":"x"}""")
        assertTrue(old.refs.isEmpty()); assertFalse(old.viewOnce); assertNull(old.viewOnceState)
    }

    @Test fun `eventos con comentarios, busqueda y abrir`() {
        val ev = TcJson.decodeFromString(CalendarEventDTO.serializer(), """{"id":"e1","commentCount":3,"lastComments":[{"id":"k1","eventId":"e1","authorId":"u2","body":"¿Llevo algo?","createdAt":"2026-09-29T10:00:00Z"}]}""")
        assertEquals(3, ev.commentCount); assertEquals("¿Llevo algo?", ev.lastComments.single().body)
        assertEquals(0, TcJson.decodeFromString(CalendarEventDTO.serializer(), """{"id":"e2"}""").commentCount)
        assertEquals(1, decodeEventComments(TcJson.parseToJsonElement("""{"comments":[{"id":"k1","body":"a"},{"body":"sin id"}]}""")).size)
        assertEquals(1, decodeEventComments(TcJson.parseToJsonElement("""[{"id":"k1","body":"a"}]""")).size)
        val page = TcJson.decodeFromString(ChatSearchPageDTO.serializer(), """{"results":[{"message":{"id":"m1","seq":9,"body":"el acuerdo"},"snippet":"el acuerdo","matches":[[3,7]],"field":"body"}],"hasMore":true}""")
        assertEquals(listOf(listOf(3, 7)), page.results.single().matches); assertTrue(page.hasMore)
        val o = TcJson.decodeFromString(ViewOnceOpenDTO.serializer(), """{"body":"secreto","attachments":[{"id":"a1","url":"https://s3/firmada","kind":"image","contentType":"image/jpeg"}]}""")
        assertEquals("secreto", o.body); assertEquals("https://s3/firmada", o.attachments.single().url)
    }

    @Test fun `hashtag en el compositor`() {
        assertEquals(0 to "Ven", Refs.query("#Ven", 4))
        assertEquals(5 to "", Refs.query("Mira #", 6))
        assertNull(Refs.query("C#", 2)) // dentro de una palabra no
        assertNull(Refs.query("Mira @Ana", 9))
        val (t, tokens, cur) = Refs.insert("Mira #ven y", emptyList(), 5, 9, "Ventas", "c9")
        assertEquals("Mira #Ventas  y", t); assertEquals(13, cur)
        assertEquals(Refs.token("c9", 5, 7), tokens.single())
        // Menciones y refs juntas: split separa, recorta y corre offsets.
        val all = listOf(MentionDTO("u2", 2, 4), Refs.token("c9", 14, 7))
        val (body, ments, refs) = Refs.split("  @Ana revisa #Ventas ", all)
        assertEquals("@Ana revisa #Ventas", body)
        assertEquals(listOf(MentionDTO("u2", 0, 4)), ments)
        assertEquals(listOf(RefInput("c9", 12, 7)), refs)
        // Un token que ya no calza con «#» se descarta.
        assertTrue(Refs.split("hola", listOf(Refs.token("c9", 0, 4))).third.isEmpty())
        val m = MessageDTO(refs = listOf(MessageRefDTO("c9", "Ventas", 5, 7)))
        assertEquals(listOf(Refs.token("c9", 5, 7)), Refs.tokens(m))
        val d = BootstrapDTO(conversations = listOf(ConversationDTO(id = "c9", name = "Ventas"), ConversationDTO(id = "c8", name = "Pagos")))
        assertTrue(Refs.canOpen(d, "c9")); assertFalse(Refs.canOpen(d, "zz"))
        assertEquals(listOf("c9"), Refs.candidates(d, "ven", { it.name ?: "" }).map { it.first.id })
    }

    @Test fun `el envio lleva refs y una vista solo si hay`() {
        val with = TcJson.encodeToJsonElement(SendBody.serializer(), SendBody("cm", "#Ventas", refs = listOf(RefInput("c9", 0, 7)), viewOnce = true)) as JsonObject
        assertEquals("c9", with["refs"]!!.toString().substringAfter("\"conversationId\":\"").substringBefore('"'))
        assertEquals("true", with["viewOnce"].toString())
        val without = TcJson.encodeToJsonElement(SendBody.serializer(), SendBody("cm", "hola")) as JsonObject
        assertFalse(without.containsKey("refs")); assertFalse(without.containsKey("viewOnce"))
    }

    @Test fun `mensajes de sistema de la tanda`() {
        fun sys(j: String) = System17.parse(MessageDTO(kind = "system", body = j))
        assertEquals("e1", sys("""{"k":"event.today","eventId":"e1","title":"Demo","startsAt":"2026-09-29T20:00:00Z","timezone":"America/Bogota"}""")!!.eventId)
        assertEquals("Ana", sys("""{"k":"issue.done","issueId":"i1","title":"Cotizar","byId":"u1","byName":"Ana"}""")!!.byName)
        val od = sys("""{"k":"issue.overdue","issueId":"i1","title":"Cotizar","ownerId":null,"ownerName":null,"dueDate":"2026-09-28"}""")!!
        assertEquals("2026-09-28", od.dueDate); assertNull(od.ownerId)
        val c = sys("""{"k":"issue.comments","issueId":"i1","title":"Cotizar","count":3,"lastById":"u2","lastByName":"Beto","lastExcerpt":"Listo"}""")!!
        assertEquals(3, c.count); assertEquals("Listo", c.lastExcerpt)
        assertEquals("e1", sys("""{"k":"event.comments","eventId":"e1","title":"Demo","count":1,"lastById":"u2","lastByName":"Beto","lastExcerpt":"Voy"}""")!!.eventId)
        assertNull(sys("""{"k":"issue.created","issueId":"i1"}"""))
        assertNull(System17.parse(MessageDTO(kind = "text", body = """{"k":"issue.done"}""")))
        // Nueva fecha: Hoy, Mañana y el próximo lunes (lunes 28 → hoy lunes, mañana martes, próximo lunes 5 oct).
        assertEquals(listOf(LocalDate.of(2026, 9, 28), LocalDate.of(2026, 9, 29), LocalDate.of(2026, 10, 5)), System17.quickDates(LocalDate.of(2026, 9, 28)))
    }

    @Test fun `una sola vista`() {
        val base = MessageDTO(id = "m", authorId = "u2", viewOnce = true, attachments = listOf(AttachmentDTO(id = "a", kind = "image", contentType = "image/jpeg")))
        assertEquals("unopened", ViewOnce.state(base, "u1"))
        assertEquals("sent", ViewOnce.state(base, "u2"))
        assertEquals("opened", ViewOnce.state(base.copy(openedBy = listOf(OpenedBy("u1", "t"))), "u1"))
        assertEquals("opened", ViewOnce.state(base.copy(viewOnceState = "opened"), "u1"))
        assertEquals(ViewOnce.Kind.PHOTO, ViewOnce.kind(base))
        assertEquals(ViewOnce.Kind.VOICE, ViewOnce.kind(base.copy(attachments = listOf(AttachmentDTO(id = "v", kind = "voice", contentType = "audio/mp4")))))
        assertEquals(ViewOnce.Kind.TEXT, ViewOnce.kind(base.copy(attachments = emptyList())))
        assertTrue(ViewOnce.allowed(base.attachments)); assertFalse(ViewOnce.allowed(listOf(AttachmentDTO(id = "p", kind = "file", contentType = "application/pdf"))))
        assertEquals("① Foto", ViewOnce.preview(base, "Foto", "Nota de voz", "Mensaje"))
        assertTrue(ViewOnce.blocksActions(base)); assertFalse(ViewOnce.blocksActions(base.copy(viewOnce = false)))
        assertEquals(listOf("Ana"), ViewOnce.openedNames(base.copy(openedBy = listOf(OpenedBy("u1", "t"), OpenedBy("zz", "t")))) { if (it == "u1") "Ana" else null })
    }

    @Test fun `busqueda en el chat, tres de diecisiete`() {
        val r = (1..3).map { ChatSearchResultDTO(MessageDTO(id = "m$it", seq = (100 - it).toLong())) }
        var nav = ChatSearchNav().append(ChatSearchPageDTO(r, hasMore = true))
        assertEquals(3, nav.total); assertEquals("m1", nav.current!!.message.id)
        nav = nav.older(); assertEquals(1, nav.index)
        nav = nav.newer().newer(); assertEquals(0, nav.index)
        nav = nav.older().older(); assertTrue(nav.needsMore); assertEquals(97L, nav.before)
        nav = nav.append(ChatSearchPageDTO(listOf(ChatSearchResultDTO(MessageDTO(id = "m4", seq = 90))), false)).older()
        assertEquals("m4", nav.current!!.message.id); assertFalse(nav.needsMore)
        assertFalse(ChatSearchNav.ready("a")); assertTrue(ChatSearchNav.ready("ac"))
        // Sin mayúsculas ni tildes, con los índices del texto original.
        assertEquals(listOf(3..8, 17..22), matchRanges("Tu acción y otra ACCION", "accion"))
        assertTrue(matchRanges("hola", "x").isEmpty())
        assertTrue(matchRanges("hola", "h").isEmpty()) // mínimo 2
    }

    @Test fun `textos de la tanda en espanol e ingles`() {
        fun s(dir: String) = File("src/main/res/$dir").listFiles { f -> f.name.endsWith(".xml") }!!.flatMap { f ->
            Regex("<string name=\"([^\"]+)\">(.*?)</string>").findAll(f.readText()).map { it.groupValues[1] to it.groupValues[2] }.toList() }.toMap()
        val es = s("values-es"); val en = s("values")
        assertEquals("No tienes acceso a %1\$s", es["ref_no_access"])
        assertEquals("Hoy: %1\$s a las %2\$s", es["sys_event_today"])
        assertEquals("No cumplimos: %1\$s venció el %2\$s", es["sys_issue_overdue"])
        assertEquals("%1\$d de %2\$d", es["cs_of"])
        listOf("sys_issue_done", "sys_issue_comments_one", "sys_issue_comments_n", "sys_event_comments_one", "sys_event_comments_n", "card_today", "card_done",
            "card_overdue", "od_new_date", "od_mark_done", "od_reassign", "cm_added", "cm_new_n", "vo_photo", "vo_voice", "vo_message", "vo_seen_by", "vo_opened")
            .forEach { assertTrue("falta $it", es.containsKey(it) && en.containsKey(it)) }
    }

    // ---------- API ----------
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private lateinit var client: TieComsClient

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val text = request.body.readUtf8()
                requests += request to text
                val body = when (request.path!!.substringBefore('?')) {
                    "$AUTH_BASE_PATH/login" -> """{"accessToken":"t","accessExpiresAt":"2099-01-01T00:00:00Z","refreshToken":"r","sessionId":"s","user":{"id":"u1","name":"Ana"}}"""
                    "/api/v1/bootstrap" -> """{"me":{"id":"u1","name":"Ana"},"conversations":[{"id":"c1","kind":"direct","memberIds":["u1","u2"],"canPost":true,"lastMessageSeq":1}]}"""
                    "/api/v1/blocks" -> """{"userIds":[]}"""
                    "/api/v1/conversations/c1/messages" -> """{"messages":[{"id":"m1","conversationId":"c1","seq":1,"authorId":"u2","body":"","viewOnce":true,"viewOnceState":"unopened"}],"hasMore":false,"lastEventSeq":1}"""
                    "/api/v1/conversations/c1/events" -> """{"events":[],"resetRequired":false}"""
                    "/api/v1/conversations/c1/search" -> """{"results":[{"message":{"id":"m9","seq":9,"body":"acuerdo"},"snippet":"acuerdo","matches":[[0,7]]}],"hasMore":false}"""
                    "/api/v1/messages/m1/open" -> if (requests.count { it.first.path == "/api/v1/messages/m1/open" } > 1) return MockResponse().setResponseCode(410).setBody("""{"error":{"code":"already_opened","message":"Ya lo abriste"}}""")
                        else """{"body":"secreto","attachments":[]}"""
                    "/api/v1/events/e1/comments" -> if (request.method == "GET") """{"comments":[{"id":"k1","eventId":"e1","authorId":"u2","body":"Voy"}]}""" else """{"comment":{"id":"k2"}}"""
                    "/api/v1/events/e1" -> """{"id":"e1","commentCount":2}"""
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"no"}}""")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        client = TieComsClient(server.url("/").toString().trimEnd('/'), "Pixel", MemoryStorage(), MemorySecretStore(), OkHttpClient())
        runBlocking { client.login("ana@acme.co", "x"); client.openConversation("c1") }
    }
    @After fun tearDown() { client.close(); server.shutdown() }

    @Test fun `buscar, abrir una vez y comentar eventos`() = runBlocking {
        val page = client.searchConversation("c1", "  acuerdo ", before = 50)
        assertEquals("m9", page.results.single().message.id)
        val q = requests.last { it.first.path!!.startsWith("/api/v1/conversations/c1/search") }.first.path!!.substringAfter('?')
        assertEquals("q=acuerdo&before=50&limit=30", q)
        val m = client.state.value.conversations["c1"]!!.messages.single()
        assertEquals("secreto", client.openViewOnce(m).body)
        assertEquals("opened", client.state.value.conversations["c1"]!!.messages.single().viewOnceState)
        val e = runCatching { client.openViewOnce(m) }.exceptionOrNull() as ApiException
        assertEquals(410, e.status)
        assertEquals("Voy", client.eventComments("e1").single().body)
        client.commentEvent("e1", "  Listo ")
        assertEquals("Listo", TcJson.parseToJsonElement(requests.last { it.first.method == "POST" && it.first.path == "/api/v1/events/e1/comments" }.second).jsonObject["body"].toString().trim('"'))
        assertEquals(2, client.state.value.events["e1"]!!.commentCount)
    }
}
