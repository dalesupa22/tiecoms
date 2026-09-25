package com.tiecoms.app.core

/** «Nuevo chat → Grupo en un espacio» (SPEC-v4 §D): qué espacios y qué personas se pueden elegir. */
object SpaceGroups {
    /** Espacios donde no soy tercero (guest), agrupados por empresa como Inicio. */
    fun eligible(d: BootstrapDTO): List<Pair<OrganizationDTO?, List<WorkspaceDTO>>> =
        HomeTree.groupWorkspaces(d).map { (o, l) -> o to l.filter { it.myRole != "guest" } }.filter { it.second.isNotEmpty() }

    /** Participantes del espacio (sin mí). Si es interno, solo personas de mis empresas. */
    fun candidates(d: BootstrapDTO, ws: WorkspaceDTO, internal: Boolean): Set<String> {
        val mine = d.organizations.filter { it.myRole != null }.map { it.id }.toSet()
        return ws.memberIds.filter { it != d.me.id }.filter { id ->
            val p = Names.person(d, id) ?: return@filter false
            p.kind != "agent" && (!internal || (p.orgId != null && p.orgId in mine))
        }.toSet()
    }

    fun valid(name: String, ws: WorkspaceDTO?) = ws != null && name.trim().length >= 2
}
