package com.tiecoms.app.core

import java.text.Collator
import java.text.Normalizer
import java.util.Locale

/** Nombres visibles, iguales en web, iOS y Android. */
object Names {
    /**
     * Textos que dependen del idioma y se usan desde código puro (títulos de chats grupales).
     * La app los fija al arrancar con los recursos; por defecto, español.
     */
    data class Labels(val groupChat: String = "Chat grupal", val andMore: String = "y %1\$d más", val sideName: String = "Sidechat · %1\$s")

    /** Sidechats viejos se llamaban «Consulta · …»: se muestran como «Sidechat · …» (side.defaultName). */
    val OLD_SIDE_PREFIXES = listOf("Consulta · ", "Consulta lateral · ", "Side conversation · ")
    fun sideName(name: String, labels: Labels): String =
        OLD_SIDE_PREFIXES.firstOrNull { name.startsWith(it) }?.let { labels.sideName.replace("%1\$s", name.removePrefix(it)) } ?: name
    @Volatile var labels = Labels()

    fun person(data: BootstrapDTO?, id: String): PersonDTO? = data?.people?.firstOrNull { it.id == id }
    fun org(data: BootstrapDTO?, id: String?): OrganizationDTO? = id?.let { oid -> data?.organizations?.firstOrNull { it.id == oid } }

    fun otherInDirect(c: ConversationDTO, data: BootstrapDTO?): PersonDTO? {
        val me = data?.me?.id
        return c.memberIds.firstOrNull { it != me }?.let { person(data, it) }
    }

    /** Personas del chat distintas de mí (caritas apiladas). */
    fun others(c: ConversationDTO, data: BootstrapDTO?): List<PersonDTO> {
        val me = data?.me?.id
        return c.memberIds.filter { it != me }.mapNotNull { person(data, it) }
    }

    /** group → name; internal → name (con candado en la interfaz); direct → la otra persona; multi → name o primeros nombres. */
    fun conversationTitle(c: ConversationDTO, data: BootstrapDTO?, internalFallback: String, directFallback: String, labels: Labels = this.labels): String {
        val t = when (c.kind) {
            "direct" -> otherInDirect(c, data)?.name ?: c.name ?: directFallback
            "internal" -> c.name?.takeIf { it.isNotBlank() } ?: internalFallback
            "multi" -> c.name?.takeIf { it.isNotBlank() } ?: multiTitle(c, data, labels)
            else -> c.name?.takeIf { it.isNotBlank() } ?: directFallback
        }
        return if (c.isSide) sideName(t, labels) else t
    }

    /** Chat grupal sin nombre: primeros nombres de los demás («Mateo, Ana, Laura y 2 más»). */
    fun multiTitle(c: ConversationDTO, data: BootstrapDTO?, labels: Labels = this.labels): String {
        val names = others(c, data).mapNotNull { p -> p.name.trim().split(Regex("\\s+")).firstOrNull()?.takeIf { it.isNotEmpty() } }
        if (names.isEmpty()) return labels.groupChat
        if (names.size > 3) return names.take(3).joinToString(", ") + " " + String.format(Locale.getDefault(), labels.andMore, names.size - 3)
        return names.joinToString(", ")
    }

    /** Empresas de los participantes, en orden de aparición. */
    fun participantOrgs(c: ConversationDTO, data: BootstrapDTO?): List<OrganizationDTO> =
        c.memberIds.mapNotNull { person(data, it)?.orgId }.distinct().mapNotNull { org(data, it) }

    /** Subtítulo de un chat grupal: «Chat grupal · Acme, Beta» (hasta 3 empresas). */
    fun multiSubtitle(c: ConversationDTO, data: BootstrapDTO?, labels: Labels = this.labels): String =
        listOf(labels.groupChat, participantOrgs(c, data).take(3).joinToString(", ") { it.name }).filter { it.isNotBlank() }.joinToString(" · ")

    /** «cargo · área» de una persona (vacío si no tiene ninguno). */
    fun roleLine(p: PersonDTO): String = listOfNotNull(p.title, p.area).filter { it.isNotBlank() }.joinToString(" · ")

    /** Personas agrupadas por empresa para elegir en un chat nuevo. [key] = id de la empresa o [GUESTS]. */
    data class OrgGroup(val key: String, val org: OrganizationDTO?, val isMine: Boolean, val people: List<PersonDTO>)
    const val GUESTS = "_guests"

    private fun fold(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)

    /**
     * Personas para un chat nuevo (PeoplePicker de la web): solo humanas, sin mí ni [exclude], filtradas por
     * nombre, cargo, área o empresa (sin tildes ni mayúsculas) y agrupadas: primero mi empresa, luego las demás
     * por nombre y al final los terceros (sin empresa conocida).
     */
    fun peopleByOrg(data: BootstrapDTO, query: String, exclude: Set<String> = emptySet()): List<OrgGroup> {
        val q = fold(query.trim())
        val coll = Collator.getInstance(Locale.getDefault()).apply { strength = Collator.PRIMARY }
        val people = data.people
            .filter { it.kind == "human" && it.id != data.me.id && it.id !in exclude }
            .filter { p -> q.isEmpty() || listOfNotNull(p.name, p.title, p.area, org(data, p.orgId)?.name).any { fold(it).contains(q) } }
            .sortedWith { a, b -> coll.compare(a.name, b.name) }
        val groups = LinkedHashMap<String, MutableList<PersonDTO>>()
        for (p in people) {
            val k = p.orgId?.takeIf { org(data, it) != null } ?: GUESTS
            groups.getOrPut(k) { mutableListOf() }.add(p)
        }
        val mine = data.me.primaryOrgId
        return groups.map { (k, list) -> OrgGroup(k, org(data, k), k == mine, list) }
            .sortedWith { a, b ->
                when {
                    a.isMine != b.isMine -> if (a.isMine) -1 else 1
                    (a.key == GUESTS) != (b.key == GUESTS) -> if (b.key == GUESTS) -1 else 1
                    else -> coll.compare(a.org?.name ?: "", b.org?.name ?: "")
                }
            }
    }

    /** Empresas involucradas en un chat nuevo: la mía y las de las personas elegidas, sin repetir. */
    fun chatOrgs(data: BootstrapDTO, picked: List<String>): List<OrganizationDTO> =
        (listOf(data.me.primaryOrgId) + picked.map { person(data, it)?.orgId }).filterNotNull().distinct().mapNotNull { org(data, it) }

    fun initials(name: String): String =
        name.split(' ', '-', '.').filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "?" }
}
