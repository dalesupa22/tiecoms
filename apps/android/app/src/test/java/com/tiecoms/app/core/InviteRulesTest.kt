package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** SPEC-invitar (1.6.4 build 21): correo válido, tipo por defecto según el grupo, candidatos y texto de compartir. */
class InviteRulesTest {
    private val acme = OrganizationDTO(id = "o-acme", name = "Acme", myRole = "member")
    private val beta = OrganizationDTO(id = "o-beta", name = "Beta Logística")
    private val me = UserDTO(id = "u-me", name = "Ana", email = "ana@acme.co", primaryOrgId = "o-acme")
    private val people = listOf(
        PersonDTO(id = "u-me", name = "Ana", orgId = "o-acme"),
        PersonDTO(id = "u-luis", name = "Luis Peña", orgId = "o-acme", email = "luis@acme.co"),
        PersonDTO(id = "u-jose", name = "José Álvarez", orgId = "o-beta"),
        PersonDTO(id = "u-mar", name = "Marta Ruiz", orgId = null, guest = true),
        PersonDTO(id = "u-bot", name = "Bot", kind = "agent", orgId = "o-acme"),
        PersonDTO(id = "u-out", name = "Fuera del espacio", orgId = "o-beta"),
        PersonDTO(id = "u-col", name = "Colega Nueva", orgId = "o-acme"),
    )
    private val home = WorkspaceDTO(id = "w-home", name = "Acme", owningOrgId = "o-acme", organizationIds = listOf("o-acme"), isOrgHome = true,
        memberIds = listOf("u-me", "u-luis", "u-bot"))
    private val rel = WorkspaceDTO(id = "w-rel", name = "Acme · Beta", owningOrgId = "o-acme", organizationIds = listOf("o-acme", "o-beta"),
        memberIds = listOf("u-me", "u-luis", "u-jose", "u-mar", "u-bot"))
    private val pendingRel = WorkspaceDTO(id = "w-pend", name = "Acme · Gamma", owningOrgId = "o-acme", organizationIds = listOf("o-acme"),
        counterpartName = "Gamma SAS", memberIds = listOf("u-me"))
    private val guestWs = WorkspaceDTO(id = "w-guest", name = "Otro", owningOrgId = "o-beta", organizationIds = listOf("o-beta"), myRole = "guest", memberIds = listOf("u-me", "u-jose"))
    private fun data(vararg convs: ConversationDTO) = BootstrapDTO(me = me, organizations = listOf(acme, beta), workspaces = listOf(home, rel, pendingRel, guestWs),
        conversations = convs.toList(), people = people)

    private val gHome = ConversationDTO(id = "c-home", workspaceId = "w-home", kind = "group", memberIds = listOf("u-me"))
    private val gRel = ConversationDTO(id = "c-rel", workspaceId = "w-rel", kind = "group", memberIds = listOf("u-me", "u-jose"))
    private val gInternal = ConversationDTO(id = "c-int", workspaceId = "w-rel", kind = "internal", internalOrgId = "o-acme", memberIds = listOf("u-me"))
    private val gPend = ConversationDTO(id = "c-pend", workspaceId = "w-pend", kind = "group", memberIds = listOf("u-me"))
    private val gGuest = ConversationDTO(id = "c-guest", workspaceId = "w-guest", kind = "group", memberIds = listOf("u-me"))
    private val multi = ConversationDTO(id = "c-multi", workspaceId = null, kind = "multi", memberIds = listOf("u-me", "u-luis"))

    @Test fun `correo valido`() {
        listOf("ana@acme.co", " Luis.Pena+chaggu@beta-logistica.com.co ", "x@y.io", "MAYUS@EMPRESA.COM").forEach { assertTrue(it, InviteRules.isEmail(it)) }
        listOf("", "ana", "ana@", "@acme.co", "ana@acme", "ana@acme.c", "ana @acme.co", "ana@@acme.co", "a,b@acme.co", "ana@.acme.co", "ana@acme..co",
            "ana@acme.co.", "Ana <ana@acme.co>", "a".repeat(250) + "@x.co").forEach { assertFalse(it, InviteRules.isEmail(it)) }
    }

    @Test fun `fila invitar solo con correo que no es de nadie`() {
        val d = data(gRel)
        assertEquals("nuevo@beta.co", InviteRules.emailToInvite(d, "  Nuevo@Beta.co "))
        assertNull("a medio escribir", InviteRules.emailToInvite(d, "nuevo@beta"))
        assertNull("es mi correo", InviteRules.emailToInvite(d, "ANA@acme.co"))
        assertNull("ya es de Luis", InviteRules.emailToInvite(d, "luis@acme.co"))
        assertNull("un nombre", InviteRules.emailToInvite(d, "José"))
    }

    @Test fun `tipos por defecto segun el grupo`() {
        val d = data(gHome, gRel, gInternal, gPend, multi)
        // Tu organización: de mi empresa (y tercero); nunca otra empresa.
        val kh = InviteRules.kinds(d, gHome)
        assertEquals(listOf("mine:o-acme", "guest"), kh.map { it.key })
        assertEquals(InviteRules.Kind.Mine("o-acme", "Acme"), InviteRules.defaultKind(d, gHome))
        // Relación: la contraparte primero por defecto; también mi empresa y tercero.
        val kr = InviteRules.kinds(d, gRel)
        assertEquals(listOf("mine:o-acme", "org:o-beta", "guest"), kr.map { it.key })
        assertEquals(InviteRules.Kind.Company("o-beta", "Beta Logística"), InviteRules.defaultKind(d, gRel))
        // Relación pendiente: «De {counterpartName}».
        val kp = InviteRules.kinds(d, gPend)
        assertTrue(kp.any { it is InviteRules.Kind.Company && it.orgId == null && it.name == "Gamma SAS" })
        assertEquals("Gamma SAS", (InviteRules.defaultKind(d, gPend) as InviteRules.Kind.Company).name)
        // Grupo interno: solo mi empresa.
        assertEquals(listOf("mine:o-acme"), InviteRules.kinds(d, gInternal).map { it.key })
        assertEquals("mine:o-acme", InviteRules.defaultKind(d, gInternal)?.key)
        // Chat grupal sin espacio: no se invita desde aquí.
        assertTrue(InviteRules.kinds(d, multi).isEmpty())
        assertNull(InviteRules.defaultKind(d, multi))
        // Sin empresa propia conocida y sin contraparte: tercero.
        val lonely = d.copy(me = me.copy(primaryOrgId = null), workspaces = listOf(home.copy(isOrgHome = false)))
        assertEquals(InviteRules.Kind.Guest, InviteRules.defaultKind(lonely, gHome))
    }

    @Test fun `un tercero no invita`() {
        val d = data(gRel, gGuest)
        assertTrue(InviteRules.canInvite(d, gRel))
        assertFalse(InviteRules.canInvite(d, gGuest))
        assertFalse(InviteRules.canInvite(d, multi))
    }

    @Test fun `candidatos y buscador sin tildes ni mayusculas`() {
        val d = data(gRel, gInternal, multi)
        // Del espacio y mis colegas, humanos, sin mí ni los que ya están; nadie de otra empresa fuera del espacio.
        assertEquals(listOf("u-luis", "u-mar", "u-col"), InviteRules.candidates(d, gRel).map { it.id })
        assertEquals(listOf("u-luis", "u-col"), InviteRules.candidates(d, gInternal).map { it.id })
        assertEquals(listOf("u-jose", "u-mar", "u-out", "u-col"), InviteRules.candidates(d, multi).map { it.id })
        // Donde soy tercero no sumo a mis colegas.
        assertEquals(listOf("u-jose"), InviteRules.candidates(d, gGuest).map { it.id })
        val all = InviteRules.candidates(d, multi)
        assertEquals(listOf("u-jose"), InviteRules.filter(d, all, "JOSE alv").map { it.id })
        assertEquals(listOf("u-jose", "u-out"), InviteRules.filter(d, all, "logistica").map { it.id })
        assertEquals(listOf("u-luis"), InviteRules.filter(d, InviteRules.candidates(d, gRel), "luis@ACME").map { it.id })
        assertEquals(all, InviteRules.filter(d, all, "  "))
    }

    @Test fun `pendientes de este grupo`() {
        val a = PendingInvitationDTO(id = "1", email = "a@x.co", conversationIds = listOf("c-rel"))
        val b = PendingInvitationDTO(id = "2", email = "b@x.co", conversationIds = listOf("c-otro"))
        val old = PendingInvitationDTO(id = "3", email = "c@x.co", conversationIds = null)
        assertEquals(listOf("1", "3"), InviteRules.pendingFor(listOf(a, b, old), "c-rel").map { it.id })
    }

    @Test fun `enlace reutilizado mientras esta vigente`() {
        InviteLinkCache.clear()
        val now = 1_800_000_000_000L
        val l = InvitationCreatedDTO(id = "i", url = "https://chaggu.com/invite/t", code = "K7QM-4XPA", expiresAt = java.time.Instant.ofEpochMilli(now + 14L * 86_400_000).toString())
        InviteLinkCache.put("c-rel", "guest|now", l)
        assertEquals(l, InviteLinkCache.get("c-rel", "guest|now", now))
        assertNull("otro tipo", InviteLinkCache.get("c-rel", "org:o-beta|now", now))
        assertNull("otro grupo", InviteLinkCache.get("c-home", "guest|now", now))
        assertNull("por vencer", InviteLinkCache.get("c-rel", "guest|now", now + 14L * 86_400_000 - 60_000))
        assertNull("ya se descartó", InviteLinkCache.get("c-rel", "guest|now", now))
    }

    private fun string(dir: String, name: String): String {
        File("src/main/res/$dir").listFiles { f -> f.name.endsWith(".xml") }!!.forEach { f ->
            Regex("<string name=\"$name\">(.*?)</string>").find(f.readText())?.let { return it.groupValues[1] }
        }
        error("falta $name en $dir")
    }

    @Test fun `texto de compartir en espanol e ingles`() {
        val es = InviteRules.shareText(string("values-es", "gshare_text"), string("values-es", "gshare_text_nocode"), "Pedidos Beta", "https://chaggu.com/invite/abc", "K7QM-4XPA")
        assertEquals("Te invito a Pedidos Beta en Chaggu: https://chaggu.com/invite/abc (código K7QM-4XPA)", es)
        val esNoCode = InviteRules.shareText(string("values-es", "gshare_text"), string("values-es", "gshare_text_nocode"), "Pedidos Beta", "https://chaggu.com/signup?org=t", null)
        assertEquals("Te invito a Pedidos Beta en Chaggu: https://chaggu.com/signup?org=t", esNoCode)
        val en = InviteRules.shareText(string("values", "gshare_text"), string("values", "gshare_text_nocode"), "Beta orders", "https://chaggu.com/invite/abc", "K7QM-4XPA")
        assertTrue(en, en.contains("Beta orders") && en.contains("https://chaggu.com/invite/abc") && en.contains("K7QM-4XPA") && en.contains("Chaggu"))
    }

    @Test fun `textos de la hoja en espanol e ingles`() {
        val pairs = mapOf(
            "ainv_search_ph" to ("Nombre o correo" to "Name or email"),
            "ainv_invite_email" to ("Invitar a %1\$s" to "Invite %1\$s"),
            "ainv_send" to ("Enviar invitación" to "Send invite"),
            "ainv_sent" to ("Invitación enviada a %1\$s" to "Invite sent to %1\$s"),
            "ainv_new" to ("Invitar a alguien nuevo" to "Invite someone new"),
            "ainv_from" to ("De %1\$s" to "From %1\$s"),
            "ainv_guest" to ("Tercero (asesor, mentor, cliente…)" to "Guest (advisor, mentor, client…)"),
            "ainv_by_email" to ("Invitar por correo" to "Invite by email"),
            "ainv_copy_link" to ("Copiar enlace" to "Copy link"),
            "ainv_copied" to ("Enlace copiado · vence el %1\$s" to "Link copied · expires %1\$s"),
            "ainv_share" to ("Compartir…" to "Share…"),
            "ainv_pending" to ("Invitaciones pendientes (%1\$d)" to "Pending invites (%1\$d)"),
            "ainv_resend" to ("Reenviar" to "Resend"),
            "ainv_revoke" to ("Anular" to "Revoke"),
            "ainv_members_only" to ("Solo los miembros pueden invitar" to "Only members can invite"),
        )
        pairs.forEach { (k, v) -> assertEquals(k, v.first, string("values-es", k)); assertEquals(k, v.second, string("values", k)) }
        assertNotNull(string("values-es", "ainv_see_new"))
    }
}
