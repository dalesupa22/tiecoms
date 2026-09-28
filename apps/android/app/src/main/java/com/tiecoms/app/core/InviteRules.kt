package com.tiecoms.app.core

import java.text.Normalizer
import java.util.Locale

/**
 * Reglas de la hoja «Agregar al grupo» (SPEC-invitar, 1.6.4 build 21): candidatos con buscador, fila
 * «Invitar a {correo}», tipo de persona que se invita (de mi empresa, de otra empresa del espacio o tercero)
 * y el texto que se comparte. Sin Android para poder probarlas en la JVM.
 */
object InviteRules {
    private val EMAIL = Regex("^[^\\s@,;<>()\"]+@[^\\s@,;<>()\"]+\\.[^\\s@,;<>()\"]{2,}$")

    /** ¿Es un correo que se puede invitar? Sin espacios, con dominio y extensión de 2 letras o más. */
    fun isEmail(raw: String): Boolean {
        val s = raw.trim()
        if (s.length > 254 || s.startsWith('.') || s.contains("..")) return false
        val domain = s.substringAfterLast('@', "")
        if (domain.startsWith('.') || domain.startsWith('-') || domain.endsWith('.')) return false
        return EMAIL.matches(s)
    }

    fun fold(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)

    // ---------- Candidatos ----------
    /**
     * Personas que se pueden sumar (como el diálogo de la web): las del espacio y mis colegas que no están en el grupo; en un chat
     * grupal sin espacio, cualquiera con quien comparto algo; en un grupo interno, solo las de esa empresa.
     */
    fun candidates(data: BootstrapDTO, conv: ConversationDTO): List<PersonDTO> {
        val ws = data.workspaces.firstOrNull { it.id == conv.workspaceId }
        val myOrg = data.me.primaryOrgId
        // Del espacio y, si participo en él como parte de mi empresa, también mis colegas (el API los suma al espacio).
        val mates = if (ws != null && myOrg != null && myOrg in ws.organizationIds && ws.myRole != "guest")
            data.people.filter { it.orgId == myOrg && !it.guest }.map { it.id } else emptyList()
        val inScope: Set<String> = if (conv.kind == "multi" || ws == null) data.people.map { it.id }.toSet() else ws.memberIds.toSet() + mates
        val members = conv.memberIds.toSet()
        return data.people.filter { p ->
            p.kind == "human" && p.id != data.me.id && p.id in inScope && p.id !in members &&
                (conv.kind != "internal" || p.orgId == conv.internalOrgId)
        }
    }

    /** Filtra por nombre, correo (si el servidor lo manda), cargo, área o empresa; sin tildes ni mayúsculas. */
    fun filter(data: BootstrapDTO, people: List<PersonDTO>, query: String): List<PersonDTO> {
        val q = fold(query.trim())
        if (q.isEmpty()) return people
        return people.filter { p -> listOfNotNull(p.name, p.email, p.title, p.area, Names.org(data, p.orgId)?.name).any { fold(it).contains(q) } }
    }

    /**
     * Correo para la fila «✉ Invitar a {correo}»: lo escrito, si es un correo válido que no coincide con nadie
     * (ni candidatos, ni quienes ya están en el grupo, ni yo). null = no se muestra.
     */
    fun emailToInvite(data: BootstrapDTO, query: String): String? {
        val e = query.trim()
        if (!isEmail(e)) return null
        val low = e.lowercase(Locale.ROOT)
        if (data.me.email?.lowercase(Locale.ROOT) == low) return null
        if (data.people.any { it.email?.lowercase(Locale.ROOT) == low }) return null
        return low
    }

    // ---------- Tipo de persona ----------
    sealed interface Kind {
        /** Clave estable (chips, testTag y caché de enlaces). */
        val key: String
        /** Colega de mi empresa que aún no usa Chaggu: entra a mi organización y al grupo. */
        data class Mine(val orgId: String, val name: String) : Kind { override val key get() = "mine:$orgId" }
        /** Persona de otra empresa del espacio ([orgId] null = relación pendiente, solo con su nombre). */
        data class Company(val orgId: String?, val name: String) : Kind { override val key get() = "org:" + (orgId ?: fold(name)) }
        /** Tercero (asesor, mentor, cliente…): `guest`. */
        data object Guest : Kind { override val key get() = "guest" }
    }

    /**
     * Chips de tipo para invitar a [conv]: «De {mi empresa}», una por cada empresa contraparte del espacio (o la
     * pendiente, con su counterpartName) y «Tercero». En un grupo interno solo la mía; sin espacio, ninguno.
     */
    fun kinds(data: BootstrapDTO, conv: ConversationDTO): List<Kind> {
        val ws = data.workspaces.firstOrNull { it.id == conv.workspaceId } ?: return emptyList()
        if (conv.kind == "direct" || conv.kind == "multi") return emptyList()
        val myOrg = data.me.primaryOrgId?.let { Names.org(data, it) }
        val out = mutableListOf<Kind>()
        if (myOrg != null) out += Kind.Mine(myOrg.id, myOrg.name)
        if (conv.kind == "internal") return out
        if (!ws.isOrgHome) {
            // Contrapartes: las empresas del espacio que no son mías (las mías traen myRole).
            val others = ws.organizationIds.filter { it != myOrg?.id }.mapNotNull { Names.org(data, it) }.filter { it.myRole == null }
            out += others.map { Kind.Company(it.id, it.name) }
            val pending = ws.counterpartName?.trim().orEmpty()
            if (pending.isNotEmpty() && others.none { fold(it.name) == fold(pending) }) out += Kind.Company(null, pending)
        }
        out += Kind.Guest
        return out
    }

    /** Por defecto: en Tu organización, mi empresa; en una relación, la contraparte; si no, Tercero. */
    fun defaultKind(data: BootstrapDTO, conv: ConversationDTO, kinds: List<Kind> = kinds(data, conv)): Kind? {
        if (kinds.isEmpty()) return null
        val ws = data.workspaces.firstOrNull { it.id == conv.workspaceId }
        if (ws?.isOrgHome == true || conv.kind == "internal") kinds.firstOrNull { it is Kind.Mine }?.let { return it }
        kinds.firstOrNull { it is Kind.Company }?.let { return it }
        return kinds.firstOrNull { it is Kind.Guest } ?: kinds.first()
    }

    /** Un tercero (guest) del espacio no invita: «Solo los miembros pueden invitar». */
    fun canInvite(data: BootstrapDTO, conv: ConversationDTO): Boolean {
        val ws = data.workspaces.firstOrNull { it.id == conv.workspaceId } ?: return false
        return ws.myRole != "guest" && data.people.firstOrNull { it.id == data.me.id }?.guest != true
    }

    // ---------- Compartir ----------
    /** «Te invito a {grupo} en Chaggu: {url} (código {code})»; sin código, sin el paréntesis. */
    fun shareText(template: String, templateNoCode: String, group: String, url: String, code: String?): String =
        if (code.isNullOrBlank()) String.format(Locale.ROOT, templateNoCode, group, url) else String.format(Locale.ROOT, template, group, url, code)

    /** Pendientes de este grupo: si el servidor dice a qué grupos entra cada una, solo las de [conversationId]. */
    fun pendingFor(list: List<PendingInvitationDTO>, conversationId: String): List<PendingInvitationDTO> =
        list.filter { it.conversationIds == null || conversationId in it.conversationIds }
}

/**
 * Enlaces de varios usos creados en esta sesión, por grupo y tipo: «Copiar enlace» reutiliza el vigente en vez de
 * crear otro cada vez. Solo en memoria (se pierde al cerrar la app, como pide la especificación).
 */
object InviteLinkCache {
    private val links = HashMap<String, InvitationCreatedDTO>()
    private fun k(conversationId: String, kindKey: String) = "$conversationId|$kindKey"

    @Synchronized fun get(conversationId: String, kindKey: String, nowMs: Long = System.currentTimeMillis()): InvitationCreatedDTO? {
        val l = links[k(conversationId, kindKey)] ?: return null
        val exp = runCatching { java.time.Instant.parse(l.expiresAt).toEpochMilli() }.getOrNull()
        // Sin fecha o a menos de una hora de vencer: se crea uno nuevo.
        if (exp == null || exp - nowMs < 3_600_000L) { links.remove(k(conversationId, kindKey)); return null }
        return l
    }

    @Synchronized fun put(conversationId: String, kindKey: String, link: InvitationCreatedDTO) { links[k(conversationId, kindKey)] = link }
    @Synchronized fun clear() = links.clear()
}
