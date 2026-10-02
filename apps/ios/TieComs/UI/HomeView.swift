import SwiftUI

/// Hojas que se abren desde Grupos (botones «+», menús de pulsación larga y estado vacío).
enum GroupsSheet: Identifiable {
    case newGroup(NewGroupPreset), invite(InviteTarget), newIssue(String), issues(String), joinCode
    var id: String {
        switch self {
        case .newGroup(let p): return "new-\(p)"
        case .invite(let t): return "inv-\(t)"
        case .newIssue(let c): return "issue-\(c)"
        case .issues(let c): return "issues-\(c)"
        case .joinCode: return "join"
        }
    }
}

/// Pestaña Grupos: Tu organización · Relaciones · Invitado en, con los asuntos abiertos bajo cada grupo
/// (docs/GRUPOS.md). Los directos, chats y sidechats viven en la pestaña DMs.
struct HomeView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    /// Último árbol sin búsqueda de esta pintada (referencia: escribirlo no vuelve a pintar).
    @State private var treeMemo = TreeMemo()
    final class TreeMemo { var tree: GroupsTree? }
    @State private var sheet: GroupsSheet?
    @State private var collapsed = HomeCollapse.load()
    @State private var tab = HomeFilter.savedGroups
    /// «Lista» (por defecto) o «Árbol»; se recuerda en el dispositivo (UserDefaults `groupsView`).
    @State private var viewMode = GroupsViewMode.load()
    /// Grupo por archivar (confirmación).
    @State private var archiving: ConversationDTO?
    /// Chat de WhatsApp de la bandeja abierto (su hoja).
    @State private var waOpen: WaChatDTO?

    /// Asuntos abiertos por conversación (sin los personales), en orden de urgencia.
    static func openByConversation(_ all: [String: IssueDTO]) -> [String: [IssueDTO]] {
        let tops: [IssueDTO] = IssueTasks.tops(all.values.filter { !$0.status.closed && $0.conversationId != nil }, all)
        var out: [String: [IssueDTO]] = [:]
        for i in tops { if let c = i.conversationId { out[c, default: []].append(i) } }
        return out.mapValues { $0.sorted(by: IssueSort.order) }
    }

    var body: some View {
        @Bindable var store = store
        Group {
            if let d = store.data {
                let _ = PerfCounters.bump("home.body")
                let tree = PerfCounters.measure("home.groupsTree") { Naming.groupsTree(d, query: query, filterWorkspace: store.workspaceFilter, tab: tab) }
                let flat = viewMode == .list ? PerfCounters.measure("home.groupsList") { Naming.groupsList(d, from: tree) } : []
                // El menú de plegar usa el árbol sin búsqueda: sin búsqueda es este mismo (no se arma otra vez).
                let _ = { treeMemo.tree = query.trimmingCharacters(in: .whitespaces).isEmpty ? tree : nil }()
                let hasGroups = viewMode == .list ? !flat.isEmpty : tree.hasGroups
                let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
                // Asuntos abiertos por conversación (se muestran bajo cada grupo).
                // Las tareas de un asunto que veo no van sueltas: se cuentan en su chapita «☑ 1/3».
                // Los personales no tienen grupo: no van bajo ninguna fila.
                let open = Self.openByConversation(store.issues)
                // WhatsApp movido a Grupos: mismas reglas de orden y separadores (sin espacio elegido ni en Menciones/Tareas).
                let wa = store.workspaceFilter == nil ? WaInbox.rows(store.waInbox, place: WaInbox.groups, query: query, filter: tab) : []
                // Recordatorios vencidos: chip «🔔 N» al final de los filtros (antes, una fila propia).
                let due = store.reminders.filter { (ISODate.parse($0.remindAt) ?? .distantFuture) <= Date() }.count
                List {
                    if store.dndActive {
                        DndBanner()
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
                    }
                    // Cabecera compacta (contrato 1-oct): Lista/Árbol es un ícono junto a ≡ y una sola fila de chips con los
                    // accesos con logo al inicio y «🔔 N» al final.
                    HomeTabs(d: d, selected: $tab, cases: HomeFilter.groupCases, groupsOnly: true,
                             leading: store.channels.hasAny ? AnyView(ChannelAccessChips()) : nil,
                             trailing: due > 0 ? AnyView(DueRemindersChip(due: due)) : nil,
                             extraCount: { t in WaInbox.rows(store.waInbox, place: WaInbox.groups, filter: t).count })
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                    // Correo en el chat: «Comenta tus correos con el equipo · Conectar» (como Hoy en la web).
                    if MailConnectNudge.visible(store) {
                        MailConnectNudge()
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
                    }
                    if store.connection != .online {
                        ConnectionBanner(connection: store.connection)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    }
                    if let wid = store.workspaceFilter, let ws = d.workspaces.first(where: { $0.id == wid }) {
                        HStack {
                            Label(ws.name, systemImage: "square.stack.3d.up").font(.subheadline.weight(.semibold))
                            Spacer()
                            Button(L("home.showAll")) { store.workspaceFilter = nil }
                                .font(.subheadline)
                                .accessibilityIdentifier("home.clearFilter")
                        }
                        .listRowBackground(Color.clear)
                    }
                    if tab == .mentions {
                        MentionsInboxSection()
                    } else if viewMode == .list {
                        if !hasGroups && wa.isEmpty && !searching && tab == .all && store.workspaceFilter == nil { emptyState }
                        // Lista: una sola lista con el orden único y separadores discretos Fijados · Sin leer · Recientes.
                        // Los chats de WhatsApp movidos a Grupos se intercalan en el mismo orden.
                        let split = InboxBucket.split(flat, conv: \.conv, extraUnread: { $0.tree.derivedUnread + $0.tree.derivedMentions })
                        ForEach(WaInbox.mix(split, wa: wa, activity: { HomeOrder.activity($0.conv) }, urgent: { $0.conv.unreadMentions > 0 }), id: \.bucket) { b in
                            Section {
                                ForEach(b.items) { item in
                                    switch item {
                                    case .chaggu(let n):
                                        groupRows(d, n, indent: 0, color: companyColor(d, n.conv), guest: Naming.isGuest(d, n.conv), open: open, searching: searching, flat: true)
                                    case .wa(let w): waRow(w)
                                    }
                                }
                            } header: { HomeHeader(title: L(b.bucket.labelKey), identifier: "grp.bucket.\(b.bucket.rawValue)") }
                        }
                        if searching { QuickSearchSections(d: d, query: query, showGroups: false) }
                    } else {
                        if !tree.hasGroups && !searching && tab == .all && store.workspaceFilter == nil { emptyState }
                        // En el Árbol, los de WhatsApp van juntos en su bloque arriba (no son de ninguna empresa), con el mismo orden.
                        if !wa.isEmpty {
                            Section {
                                ForEach(wa) { w in waRow(w) }
                            } header: { HomeHeader(title: "WhatsApp", identifier: "grp.section.whatsapp") }
                        }
                        if !tree.pinned.isEmpty {
                            Section {
                                ForEach(tree.pinned) { c in convLink(d, c, indent: 0, showWs: true) }
                            } header: { HomeHeader(title: "📌 " + L("side.pinned")) }
                        }
                        ForEach(tree.sections) { s in section(d, s, tree: tree, open: open, searching: searching) }
                        // Al buscar: también personas (tocar = escribirle) y chats; los grupos ya salen arriba.
                        if searching { QuickSearchSections(d: d, query: query, showGroups: false) }
                    }
                }
                .listStyle(.insetGrouped)
                // Las sub-filas de asuntos miden lo que su texto (no 44 pt).
                .environment(\.defaultMinListRowHeight, 1)
                .scrollContentBackground(.hidden)
                .animation(.spring(response: 0.45, dampingFraction: 0.9), value: (viewMode == .list ? flat.map(\.id) : [tree.orderSignature].map { "\($0)" }) + wa.map(\.inboxKey))
                .onChange(of: viewMode) { _, m in GroupsViewMode.save(m) }
                .overlay {
                    if (viewMode == .list ? flat.isEmpty : tree.isEmpty) && wa.isEmpty && searching && QuickSearch.run(d, query: query).isEmpty { ContentUnavailableView.search(text: query) }
                    else if !hasGroups && wa.isEmpty && tab != .all && tab != .mentions {
                        ContentUnavailableView(L("home.empty.\(tab.rawValue)"), systemImage: tab == .unread ? "checkmark.seal" : "tray")
                            .accessibilityIdentifier("home.tab.emptyState")
                    }
                }
                .refreshable { await store.refreshAll() }
                .task(id: "\(store.mailEnabled)|\(store.mailRevision)|\(store.me?.id ?? "")") { await MailConnectNudge.refresh(store) }
                // Accesos con logo: lo conectado y sus no leídos (caché de 60 s; WhatsApp también al cambiar).
                .task(id: "\(store.mailEnabled)|\(store.mailRevision)|\(store.waRevision)|\(store.me?.id ?? "")|\(store.tab == .home)") {
                    guard store.tab == .home else { return }
                    await store.channels.refresh(store)
                }
                .sheet(item: $waOpen) { w in WaChatSheet(chat: w) { store.upsertWaInbox($0) } }
            } else {
                ProgressView()
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("tab.groups"))
        // Título pequeño y buscador siempre visible: con el título grande y el buscador que se esconde al desplazar, volver
        // de un chat a veces dejaba el List y la barra de navegación en un bucle de maquetación (UISearchBar ↔ safe area ↔
        // UICollectionView; Grupos en blanco y la app congelada, desde 1.7.0 en iOS 26). Prueba: MailUITests.test5BackToHome.
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("grp.search"))
        .toolbar {
            // Vista (plegar/desplegar): a la izquierda, aparte de ✏️ y «＋», que son para escribir y crear.
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    if let d = store.data { foldMenu(treeMemo.tree ?? Naming.groupsTree(d, filterWorkspace: store.workspaceFilter, tab: tab), issuesOnly: viewMode == .list) }
                } label: { Image(systemName: "line.3.horizontal") }
                .accessibilityLabel(L("grp.foldMenu"))
                .accessibilityIdentifier("home.fold")
            }
            // Lista ↔ Árbol (antes, un segmentado que ocupaba un renglón): un ícono que alterna, junto a ≡.
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { viewMode = viewMode == .list ? .tree : .list }
                    Haptics.tap()
                } label: { Image(systemName: viewMode == .list ? "list.bullet" : "list.bullet.indent") }
                .accessibilityLabel(L("grp.view"))
                .accessibilityValue(L(viewMode.labelKey))
                .accessibilityHint(L(viewMode == .list ? "grp.viewToggle.tree" : "grp.viewToggle.list"))
                .accessibilityIdentifier("grp.viewMode")
            }
        }
        .quickActions()
        .confirmationDialog(archiving.flatMap { c in store.data.map { L("groups.archiveConfirm", ["name": Naming.title($0, c)]) } } ?? "",
                            isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }), titleVisibility: .visible) {
            Button(L("groups.archive"), role: .destructive) {
                guard let c = archiving else { return }
                Task {
                    do { try await store.archiveGroup(c.id); store.show(L("groups.archived")) } catch { store.show(L10n.errorText(error)) }
                }
            }
            Button(L("common.cancel"), role: .cancel) { archiving = nil }
        }
        .sheet(item: $sheet) { s in
            switch s {
            case .newGroup(let p): NewGroupSheet(preset: p)
            // Un grupo: «Agregar al grupo» con invitar (SPEC-invitar); espacio o empresa: «Invitar a…».
            case .invite(.group(let id)): AddMembersSheet(conversationId: id)
            case .invite(let t): InviteSheet(target: t)
            case .newIssue(let c): NewIssueSheet(conversationId: c, origin: nil)
            case .issues(let c): ConversationIssuesSheet(conversationId: c)
            case .joinCode: JoinWithCodeSheet()
            }
        }
    }

    /// Sin grupos: crear el primero o entrar con un código.
    private var emptyState: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text(L("grp.emptyTitle")).font(.headline).foregroundStyle(Theme.textPrimary)
                Text(L("grp.emptyBody")).font(.footnote).foregroundStyle(Theme.textSecondary)
                HStack(spacing: 10) {
                    Button { sheet = .newGroup(.none) } label: { Label(L("grp.new"), systemImage: "plus") }
                        .primaryProminent()
                        .accessibilityIdentifier("groups.empty.new")
                    Button { sheet = .joinCode } label: { Label(L("join.title"), systemImage: "ticket") }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("groups.joinCode")
                }
            }
            .padding(.vertical, 6)
        }
    }

    // MARK: Secciones

    private func sectionTitle(_ s: GroupsTree.Section) -> String {
        switch s.kind {
        case .mine: return L("grp.yourOrg", ["org": s.org?.name ?? ""])
        case .relations: return L("grp.relations")
        case .guest: return L("grp.guestIn")
        case .other: return L("home.other")
        }
    }

    @ViewBuilder
    private func section(_ d: BootstrapDTO, _ s: GroupsTree.Section, tree: GroupsTree, open: [String: [IssueDTO]], searching: Bool) -> some View {
        let key = "sec:\(s.id)"
        let isOpen = searching || !collapsed.contains(key)
        Section {
            if isOpen {
                switch s.kind {
                case .mine:
                    if s.companies.isEmpty {
                        Text(L("grp.mineEmpty")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(s.companies) { co in groups(d, co, kind: s.kind, indent: 0, open: open, searching: searching) }
                case .relations, .guest:
                    if s.companies.isEmpty {
                        Text(L("grp.relationsEmpty")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(s.companies) { co in
                        let coOpen = searching || !collapsed.contains("org:\(co.id)")
                        let all = co.groups.map(\.conv)
                        CompanyRow(org: co.org, open: coOpen, unread: coOpen ? 0 : Naming.unreadCount(all), name: co.name, pending: co.pending) { toggle("org:\(co.id)") }
                            .contextMenu { companyMenu(co, kind: s.kind, tree: tree) }
                        if coOpen { groups(d, co, kind: s.kind, indent: 1, open: open, searching: searching) }
                    }
                case .other:
                    ForEach(s.orphans) { n in groupRows(d, n, indent: 0, color: nil, guest: false, open: open, searching: searching) }
                }
            }
        } header: {
            let add: (() -> Void)? = switch s.kind {
            case .mine: { sheet = .newGroup(.org(s.org?.id)) }
            case .relations: { sheet = .newGroup(.company(nil)) }
            default: nil
            }
            GroupSectionHeader(title: sectionTitle(s), open: isOpen, unread: isOpen ? 0 : Naming.unreadCount(s.allConvs),
                               onToggle: { toggle(key) }, onAdd: add, identifier: "home.section.\(s.kind.rawValue)")
                .contextMenu {
                    if s.kind == .mine {
                        Button { sheet = .newGroup(.org(s.org?.id)) } label: { Label(L("grp.new"), systemImage: "plus.bubble") }
                        if let org = s.org, org.canAdmin {
                            Button { sheet = .invite(.org(org.id)) } label: { Label(L("grp.inviteCompany"), systemImage: "person.badge.plus") }
                        }
                    } else if s.kind == .relations {
                        Button { sheet = .newGroup(.company(nil)) } label: { Label(L("grp.new"), systemImage: "plus.bubble") }
                    }
                    Divider()
                    foldMenu(tree)
                }
        }
    }

    /// Solo hay grupos y asuntos: los grupos de todos los espacios de la empresa, directo bajo ella.
    @ViewBuilder
    private func groups(_ d: BootstrapDTO, _ co: GroupsTree.CompanyNode, kind: GroupsTree.Kind, indent: Int, open: [String: [IssueDTO]], searching: Bool) -> some View {
        let color = co.org.flatMap { Theme.badgeColor($0.colorBg) }
        ForEach(co.groups) { n in groupRows(d, n, indent: indent, color: color, guest: kind == .guest, open: open, searching: searching) }
    }

    /// Un grupo con el chip «◆ N · M!» y, si están desplegados, sus asuntos activos (hasta 3 y «+N asuntos») como
    /// sub-filas compactas con sangría (sin alturas de 44 pt, separadores ni chevrons). Cada asunto es su propia fila
    /// de la lista para que su pulsación larga sea la del asunto (en una List el menú contextual es de toda la fila).
    /// Por defecto van plegados; al buscar se despliegan solos los grupos con un asunto que coincide.
    /// Tocar el chip pliega o despliega sin abrir el chat; tocar el resto de la fila abre el chat.
    @ViewBuilder
    private func groupRows(_ d: BootstrapDTO, _ n: GroupsTree.ConvNode, indent: Int, color: Color?, guest: Bool, open: [String: [IssueDTO]], searching: Bool, flat: Bool = false) -> some View {
        let all = open[n.conv.id] ?? []
        let hits = searching ? GroupIssues.matching(all, query: query) : []
        let expanded = !hits.isEmpty || HomeCollapse.issuesOpen(collapsed, n.conv.id)
        let sum = GroupIssues.summary(all, serverCount: n.conv.openIssues)
        let chip = sum.count > 0 ? IssuesToggle(count: sum.count, overdue: sum.overdue, expanded: expanded) : nil
        let list = hits.isEmpty ? all : hits
        let showLines = expanded && !list.isEmpty
        convButton(d, n.conv, badgeColor: color, group: true, guest: guest, label: n.label, company: n.company, threadUnread: n.threadUnread, threadMentions: n.tree.derivedMentions,
                   issues: chip, onToggleIssues: { toggle(HomeCollapse.issuesKey(n.conv.id)) }, flat: flat)
            .listRowInsets(EdgeInsets(top: 6, leading: 16 + CGFloat(indent) * 18, bottom: showLines ? 3 : 6, trailing: 12))
            .listRowSeparator(showLines ? .hidden : .automatic, edges: .bottom)
        if showLines { issueLines(n.conv.id, indent: indent, list: list) }
    }

    /// Sub-filas compactas bajo el grupo: alineadas con el nombre y con una guía vertical discreta.
    @ViewBuilder
    private func issueLines(_ conversationId: String, indent: Int, list: [IssueDTO]) -> some View {
        let shown = Array(list.prefix(3))
        let more = list.count > 3
        let inset = EdgeInsets(top: 0, leading: 16 + CGFloat(indent) * 18 + 28, bottom: 0, trailing: 12)
        ForEach(shown) { i in
            let last = !more && i.id == shown.last?.id
            // El círculo completa sin entrar; el resto de la sub-fila abre el asunto.
            issueGuide(HStack(spacing: 2) {
                IssueCheck(issue: i, compact: true)
                Button { store.homePath.append(.issue(i.id)) } label: {
                    GroupIssueLine(issue: i).contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .accessibilityIdentifier("grp.issue.\(i.id)")
            }, last: last)
            .listRowInsets(inset)
            .listRowSeparator(.hidden, edges: .top)
            .listRowSeparator(last ? .automatic : .hidden, edges: .bottom)
            // Mantener presionado: completar o cambiar el estado sin entrar al asunto.
            .contextMenu { IssueStatusMenu(issue: i) { store.homePath.append(.issue(i.id)) } }
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
        if more {
            Button { sheet = .issues(conversationId) } label: {
                issueGuide(Text(L("grp.moreIssues", ["n": list.count - 3])).font(.caption.weight(.semibold)).foregroundStyle(Theme.accentText)
                    .frame(maxWidth: .infinity, alignment: .leading), last: true)
            }
            .buttonStyle(RowPressStyle())
            .listRowInsets(inset)
            .listRowSeparator(.hidden, edges: .top)
            .accessibilityIdentifier("grp.moreIssues.\(conversationId)")
            .transition(.opacity)
        }
    }

    /// Una sub-fila con su tramo de la guía vertical (los tramos se unen de una fila a la siguiente).
    private func issueGuide(_ content: some View, last: Bool) -> some View {
        content
            .padding(.vertical, 5)
            .padding(.leading, 12)
            .overlay(alignment: .leading) {
                Rectangle().fill(Theme.orange.opacity(0.28)).frame(width: 2).padding(.bottom, last ? 6 : 0)
            }
            .padding(.bottom, last ? 4 : 0)
            .contentShape(Rectangle())
    }

    /// Color de la empresa del árbol (la mía, la contraparte o la anfitriona) para el globo de no leídos en la Lista.
    private func companyColor(_ d: BootstrapDTO, _ c: ConversationDTO) -> Color? {
        guard let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) else { return nil }
        switch Naming.placement(d, ws) {
        case .mine(let id), .relation(let id), .guest(let id): return Naming.org(d, id).flatMap { Theme.badgeColor($0.colorBg) }
        case .pending: return nil
        }
    }

    // MARK: Menús (mantener presionado)

    @ViewBuilder
    private func companyMenu(_ co: GroupsTree.CompanyNode, kind: GroupsTree.Kind, tree: GroupsTree) -> some View {
        if kind == .relations {
            Button { sheet = .newGroup(.company(co.id)) } label: { Label(L("grp.new"), systemImage: "plus.bubble") }
            if let ws = co.workspaces.first?.ws {
                Button { sheet = .invite(.workspace(ws.id)) } label: { Label(L("grp.inviteCompany"), systemImage: "person.badge.plus") }
            }
        }
        Divider()
        foldMenu(tree)
    }

    /// Plegar y desplegar (botón de vista arriba a la izquierda, cabeceras de sección y empresas).
    @ViewBuilder
    private func foldMenu(_ tree: GroupsTree, issuesOnly: Bool = false) -> some View {
        Button { fold { HomeCollapse.setIssues(&$0, HomeCollapse.groupIds(tree), open: true) } } label: {
            Label(L("grp.showAllIssues"), systemImage: "list.bullet.indent")
        }
        .accessibilityIdentifier("home.fold.showIssues")
        Button { fold { HomeCollapse.setIssues(&$0, HomeCollapse.groupIds(tree), open: false) } } label: {
            Label(L("grp.hideAllIssues"), systemImage: "list.dash")
        }
        .accessibilityIdentifier("home.fold.hideIssues")
        // Secciones y empresas solo existen en el Árbol.
        if !issuesOnly {
        Button { fold { HomeCollapse.expandAll(&$0, tree) } } label: { Label(L("grp.expandAll"), systemImage: "rectangle.expand.vertical") }
            .accessibilityIdentifier("home.fold.expandAll")
        Button { fold { HomeCollapse.collapseAll(&$0, tree) } } label: { Label(L("grp.collapseAll"), systemImage: "rectangle.compress.vertical") }
            .accessibilityIdentifier("home.fold.collapseAll")
        }
    }

    private func toggle(_ key: String) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if collapsed.contains(key) { collapsed.remove(key) } else { collapsed.insert(key) }
        }
        HomeCollapse.save(collapsed)
    }

    private func fold(_ f: (inout Set<String>) -> Void) {
        withAnimation(.easeInOut(duration: 0.25)) { f(&collapsed) }
        HomeCollapse.save(collapsed)
    }

    /// Fila de un chat de WhatsApp en Grupos: abre su hoja; pulsación larga y deslizar para fijar, mover o sacar.
    private func waRow(_ w: WaChatDTO) -> some View {
        Button { waOpen = w } label: { WaInboxRow(chat: w).contentShape(Rectangle()) }
            .buttonStyle(RowPressStyle())
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 12))
            .accessibilityIdentifier("wa.row.\(w.inboxKey)")
            .contextMenu { WaInboxMenuItems(chat: w, onOpen: { waOpen = w }) }
            .pinSwipe(pinned: w.inboxPinnedAt != nil, id: w.inboxKey) { store.toggleWaPin(w) }
    }

    @ViewBuilder
    private func convLink(_ d: BootstrapDTO, _ c: ConversationDTO, indent: Int, showWs: Bool = false) -> some View {
        convButton(d, c, showWs: showWs)
            .listRowInsets(EdgeInsets(top: 6, leading: 16 + CGFloat(indent) * 18, bottom: 6, trailing: 12))
    }

    /// Fila de conversación: un botón (no NavigationLink) para que el chip de asuntos reciba su toque aparte y la
    /// fila no lleve chevron. Mantener presionado: el mismo menú de grupo en Lista y Árbol.
    @ViewBuilder
    private func convButton(_ d: BootstrapDTO, _ c: ConversationDTO, badgeColor: Color? = nil, showWs: Bool = false, group: Bool = false, guest: Bool = false,
                            label: String? = nil, company: String? = nil, threadUnread: Int = 0, threadMentions: Int = 0, issues: IssuesToggle? = nil, onToggleIssues: (() -> Void)? = nil, flat: Bool = false) -> some View {
        Button { store.homePath.append(.conversation(c.id)) } label: {
            HierarchyConvRow(d: d, c: c, badgeColor: badgeColor, showIssueChip: !group, titleOverride: label, threadUnread: threadUnread, threadMentions: threadMentions,
                             issuesToggle: issues, onToggleIssues: onToggleIssues, showOnlyOrg: !flat,
                             company: flat ? company : showWs ? Naming.companyLine(d, c, title: label) : nil) { sheet = .issues(c.id) }
                .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityIdentifier("conv.row.\(c.id)")
        .pinSwipe(pinned: c.pinnedAt != nil, id: c.id) { store.togglePin(c) }
        .contextMenu {
            ConversationMenuItems(conv: c)
            // Los terceros participan en los asuntos pero no los crean, ni invitan.
            if !(guest || Naming.isGuest(d, c)) {
                Divider()
                Button { sheet = .newIssue(c.id) } label: { Label(L("grp.newIssue"), systemImage: "checklist") }
                Button { sheet = .invite(.group(c.id)) } label: { Label(L("grp.inviteToGroup"), systemImage: "person.badge.plus") }
            }
            if group && c.canManage {
                Divider()
                Button(role: .destructive) { archiving = c } label: { Label(L("groups.archive"), systemImage: "archivebox") }
                    .accessibilityIdentifier("grp.archive.\(c.id)")
            }
        }
    }
}

/// Cabecera de sección de Grupos: plegable (tocar el título), con la suma de no leídos plegada y «+» opcional.
struct GroupSectionHeader: View {
    var title: String
    var open: Bool
    var unread: Int
    var onToggle: () -> Void
    var onAdd: (() -> Void)?
    var identifier: String
    var body: some View {
        HStack(spacing: 6) {
            Button(action: onToggle) {
                HStack(spacing: 6) {
                    Text(title).font(.caption.weight(.bold)).textCase(.uppercase).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    if unread > 0 { UnreadPill(count: unread) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityLabel([title, unread > 0 ? L("a11y.unread", ["n": unread]) : nil].compactMap { $0 }.joined(separator: ", "))
            .accessibilityHint(open ? L("home.collapse") : L("home.expand"))
            .accessibilityIdentifier(identifier)
            Spacer()
            if let onAdd {
                Button(action: onAdd) { Image(systemName: "plus").font(.subheadline.weight(.bold)) }
                    .accessibilityLabel(L("grp.new"))
                    .accessibilityIdentifier("\(identifier).add")
                    .frame(minWidth: 44, minHeight: 32)
            }
        }
    }
}

/// Asunto abierto bajo su grupo: título, el primer nombre del responsable si no soy yo, la fecha límite (roja si
/// venció) o el estado si está en curso o esperando. El círculo para completarlo va a la izquierda (IssueCheck).
struct GroupIssueLine: View {
    @Environment(AppStore.self) private var store
    let issue: IssueDTO
    var body: some View {
        let f = IssueSort.flags(issue)
        let me = store.data?.me.id
        let owner = store.data.flatMap { d in issue.ownerId.flatMap { Naming.person(d, $0) } }
        let progress = issue.parentIssueId == nil ? IssueTasks.progress(store.issues, of: issue.id) : nil
        HStack(spacing: 6) {
            Text((issue.isRestricted ? "🔒 " : "") + issue.title).font(.caption).foregroundStyle(Theme.textPrimary).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            if let progress {
                Text("☑ \(progress.done)/\(progress.total)").font(.caption2.weight(.bold)).monospacedDigit()
                    .foregroundStyle(progress.done == progress.total ? Theme.doneGreen : Theme.textSecondary).fixedSize()
            }
            if let owner, owner.id != me {
                Text(String(owner.name.split(separator: " ").first ?? Substring(owner.name)))
                    .font(.caption2).foregroundStyle(Theme.textSecondary).lineLimit(1).fixedSize()
            }
            if issue.dueDate != nil {
                Text(f.overdue ? L("issue.overdue") : f.dueToday ? L("issue.today") : IssueSort.dueLabel(issue))
                    .font(.caption2.weight(f.overdue ? .semibold : .regular)).foregroundStyle(f.overdue ? .red : Theme.textSecondary)
                    .lineLimit(1).fixedSize()
            } else if issue.status == .in_progress || issue.status == .waiting {
                Text(L("issue.st.\(issue.status.rawValue)")).font(.caption2.weight(.semibold))
                    .foregroundStyle(issue.status == .waiting ? Color.purple : Theme.accentText).lineLimit(1).fixedSize()
            }
        }
        .frame(minHeight: 22)
        .accessibilityElement(children: .combine)
    }
}

struct IdBox: Identifiable { let id: String }

/// Toque de una fila hecha con Button en una List: resalta como una celda, sin tomar el estilo de botón.
struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.textSecondary.opacity(configuration.isPressed ? 0.12 : 0)).padding(-4))
    }
}

/// Secciones y empresas plegadas (`sec:`, `org:`) y asuntos desplegados por grupo (`iss:`; por defecto plegados).
/// Se recuerda en este dispositivo.
enum HomeCollapse {
    static let key = "tc.home.collapsed"
    static func load(_ defaults: UserDefaults = .standard) -> Set<String> { Set(defaults.stringArray(forKey: key) ?? []) }
    static func save(_ s: Set<String>, _ defaults: UserDefaults = .standard) { defaults.set(Array(s).sorted(), forKey: key) }

    static func issuesKey(_ conversationId: String) -> String { "iss:\(conversationId)" }
    /// ¿Los asuntos del grupo están desplegados?
    static func issuesOpen(_ s: Set<String>, _ conversationId: String) -> Bool { s.contains(issuesKey(conversationId)) }
    /// Los grupos del árbol (los que pueden llevar asuntos debajo).
    static func groupIds(_ tree: GroupsTree) -> [String] { tree.sections.flatMap { $0.allConvs.map(\.id) } }

    static func setIssues(_ s: inout Set<String>, _ ids: [String], open: Bool) {
        for id in ids { if open { s.insert(issuesKey(id)) } else { s.remove(issuesKey(id)) } }
    }

    /// «Plegar todo»: las empresas de Relaciones e Invitado en y los asuntos de todos los grupos.
    static func collapseAll(_ s: inout Set<String>, _ tree: GroupsTree) {
        for sec in tree.sections where sec.kind == .relations || sec.kind == .guest {
            for co in sec.companies { s.insert("org:\(co.id)") }
        }
        setIssues(&s, groupIds(tree), open: false)
    }

    /// «Expandir todo»: secciones, empresas y asuntos.
    static func expandAll(_ s: inout Set<String>, _ tree: GroupsTree) {
        for sec in tree.sections {
            s.remove("sec:\(sec.id)")
            for co in sec.companies { s.remove("org:\(co.id)") }
        }
        setIssues(&s, groupIds(tree), open: true)
    }
}

/// Chip de asuntos de un grupo en Grupos.
struct IssuesToggle: Equatable {
    var count: Int
    var overdue: Int
    var expanded: Bool
}

/// Asuntos activos bajo un grupo: conteo del chip y búsqueda.
enum GroupIssues {
    /// Activos que conozco (o el conteo del servidor si aún no los cargué) y cuántos vencieron.
    static func summary(_ list: [IssueDTO], serverCount: Int, now: Date = Date()) -> (count: Int, overdue: Int) {
        let active = list.filter { !$0.status.closed }
        let overdue = active.filter { IssueSort.flags($0, now: now).overdue }.count
        return (active.isEmpty ? max(0, serverCount) : active.count, overdue)
    }

    /// Asuntos cuyo título coincide con la búsqueda (sin tildes ni mayúsculas).
    static func matching(_ list: [IssueDTO], query: String) -> [IssueDTO] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        return list.filter { $0.title.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
}

/// Encabezado de sección en mayúsculas con botón + opcional (como EMPRESAS Y ESPACIOS / CHATS de la web).
struct HomeHeader: View {
    var title: String
    var action: (label: String, run: () -> Void)? = nil
    var identifier: String? = nil
    var body: some View {
        HStack {
            Text(title).font(.caption.weight(.bold)).textCase(.uppercase).foregroundStyle(Theme.textSecondary)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(action == nil ? (identifier ?? "") : "")
            Spacer()
            if let action {
                Button(action: action.run) { Image(systemName: "plus").font(.subheadline.weight(.bold)) }
                    .accessibilityLabel(action.label)
                    .accessibilityIdentifier(identifier ?? "")
                    .frame(minWidth: 44, minHeight: 32)
            }
        }
    }
}

struct CompanyRow: View {
    var org: OrganizationDTO?
    var open: Bool
    var unread: Int
    /// Nombre a mostrar (una relación pendiente no tiene organización: su `counterpartName`).
    var name: String? = nil
    /// «Invitación pendiente»: la otra empresa aún no entra.
    var pending = false
    var onToggle: () -> Void
    var body: some View {
        let title = name ?? org?.name ?? L("common.noCompany")
        Button(action: onToggle) {
            HStack(spacing: 10) {
                if pending {
                    Image(systemName: "hourglass").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textSecondary)
                        .frame(width: 26, height: 26)
                        .background(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.textSecondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [3])))
                        .accessibilityHidden(true)
                } else {
                    OrgMark(org: org, size: 26)
                }
                Text(title).font(.body.weight(.bold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                if pending {
                    Text(L("grp.pending")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(Theme.orange.opacity(0.14)))
                        .lineLimit(1).fixedSize()
                        .accessibilityIdentifier("home.pending")
                }
                Spacer()
                if unread > 0 { UnreadPill(count: unread, color: org.flatMap { Theme.badgeColor($0.colorBg) }) }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel([title, pending ? L("grp.pending") : nil, unread > 0 ? L("a11y.unread", ["n": unread]) : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint(open ? L("home.collapse") : L("home.expand"))
        .accessibilityIdentifier("home.org.\(org?.id ?? (pending ? "pending" : "none"))")
    }
}

/// Badge «@» junto a los no leídos cuando me mencionaron.
struct MentionBadge: View {
    var body: some View {
        Text(L("mention.badge")).font(.caption2.weight(.heavy)).foregroundStyle(.white)
            .frame(width: 20, height: 18)
            .background(Capsule().fill(Theme.badgeFallback))
            .accessibilityHidden(true)
            .accessibilityIdentifier("home.mentionBadge")
    }
}

struct UnreadPill: View {
    var count: Int
    var color: Color? = nil
    var muted = false
    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.caption2.weight(.bold)).foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(muted ? Theme.badgeMuted : (color ?? Theme.badgeFallback)))
            .accessibilityHidden(true)
    }
}

/// Fila compacta de la jerarquía: ícono (# / candado / foto / ⑂ / consulta lateral), nombre y badge;
/// debajo, en letra pequeña, vista previa y hora; chip «◆ N asuntos» si hay asuntos abiertos.
struct HierarchyConvRow: View {
    @Environment(AppStore.self) private var store
    /// Con tamaños de accesibilidad (o «Máximo» en Tú) el nombre y la vista previa usan dos líneas.
    @Environment(\.dynamicTypeSize) private var typeSize
    var d: BootstrapDTO
    var c: ConversationDTO
    var badgeColor: Color? = nil
    var showWs = false
    /// En Grupos los asuntos van en filas bajo el grupo: sin chip.
    var showIssueChip = true
    /// «{espacio} · {grupo}» cuando dos grupos de la misma empresa se llaman igual.
    var titleOverride: String? = nil
    /// Pendientes de sus derivadas (hilos, ramas, internas): chip «⑂ N» (antes «💬 N»), 2026-09-28.
    var threadUnread = 0
    /// Menciones sin leer en sus derivadas: la «@» de la fila también las cuenta.
    var threadMentions = 0
    /// Grupos: chip «◆ N asuntos · N vencidos ⌄» que despliega o pliega sus asuntos (sin abrir el chat).
    var issuesToggle: IssuesToggle? = nil
    var onToggleIssues: (() -> Void)? = nil
    /// «Solo {empresa}» junto al nombre de un grupo interno (en la Lista basta el candado: el título ya lleva la empresa).
    var showOnlyOrg = true
    /// Empresa en gris pequeño bajo el nombre (1.7.1): Lista, fijados, DMs 1:1 y búsqueda. En el Árbol no va.
    var company: String? = nil
    var onIssues: () -> Void

    var body: some View {
        let title = titleOverride ?? Naming.sideRowTitle(d, c)
        let blocked = c.memberIds.contains(where: { store.blockedUserIds.contains($0) })
        let preview = blocked ? L("safety.previewHidden") : (L10n.listPreview(c) ?? L("conv.noMessages"))
        let time = L10n.timeLabel(c.lastMessageAt)
        HStack(alignment: .top, spacing: 10) {
            ConvIcon(d: d, c: c, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(.subheadline.weight(c.unread > 0 && !c.isMuted ? .bold : .medium)).foregroundStyle(Theme.textPrimary).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    if showWs, let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) {
                        Text("· \(ws.name)").font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    }
                    // Un grupo interno lleva candado y «Solo {empresa}».
                    if showOnlyOrg, c.kind == .internal, let o = Naming.org(d, c.internalOrgId) {
                        Text(L("grp.onlyOrg", ["org": o.name])).font(.caption2.weight(.semibold)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    }
                    if c.isMuted { Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(Theme.textSecondary).accessibilityHidden(true) }
                    Spacer(minLength: 4)
                    if c.pinnedAt != nil {
                        Text("📌").font(.caption2).accessibilityHidden(true).accessibilityIdentifier("row.pinned.\(c.id)")
                    }
                    if threadUnread > 0 {
                        Text("⑂ \(threadUnread)").font(.caption2.weight(.bold)).foregroundStyle(Theme.accentText).monospacedDigit()
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Theme.orange.opacity(0.14)))
                            .help(L("tree.chipHelp", ["n": threadUnread]))
                            .accessibilityLabel(L("tree.chipHelp", ["n": threadUnread]))
                            .accessibilityIdentifier("grp.threadUnread.\(c.id)")
                    }
                    // En la misma línea que el nombre (como la web): plegado, cada grupo ocupa su fila y nada más.
                    if let t = issuesToggle { issuesChip(t) }
                    if c.unreadMentions > 0 || threadMentions > 0 { MentionBadge() }
                    if c.unread > 0 { UnreadPill(count: c.unread, color: badgeColor, muted: c.isMuted && c.unreadMentions == 0) }
                }
                if let company {
                    Text(company).font(.caption2).foregroundStyle(Theme.textSecondary).lineLimit(1)
                        .padding(.top, -1)
                        .accessibilityIdentifier("row.company.\(c.id)")
                }
                if Naming.isSide(c) {
                    // DMs: el sidechat se distingue con su burbuja y, si veo el origen, «desde #Grupo».
                    HStack(spacing: 6) {
                        Text(L("dm.side")).font(.caption2.weight(.bold)).foregroundStyle(Theme.sideText)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Capsule().fill(Theme.sideFill))
                            .accessibilityIdentifier("dm.sideTag")
                        if let origin = Naming.sideOrigin(d, c) {
                            Text(L("dm.fromOrigin", ["name": Naming.title(d, origin)])).font(.caption2).foregroundStyle(Theme.textSecondary).lineLimit(1)
                        }
                    }
                }
                HStack(spacing: 6) {
                    Text(preview).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    Spacer(minLength: 4)
                    Text(time).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                if showIssueChip && c.openIssues > 0 {
                    Button(action: onIssues) {
                        Text(c.openIssues == 1 ? L("issue.chipOne") : L("issue.chipMany", ["n": c.openIssues]))
                            .font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Capsule().fill(Theme.orange.opacity(0.12)))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("conv.issues.\(c.id)")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([title, company, Naming.isSide(c) ? L("dm.side") : nil,
                             Naming.sideOrigin(d, c).map { L("dm.fromOrigin", ["name": Naming.title(d, $0)]) },
                             c.pinnedAt != nil ? L("side.pinned") : nil,
                             c.isMuted ? L("side.muted") : nil, c.unreadMentions > 0 || threadMentions > 0 ? L("mention.youMentioned") : nil,
                             c.unread > 0 ? L("a11y.unread", ["n": c.unread]) : nil,
                             threadUnread > 0 ? L("tree.chipHelp", ["n": threadUnread]) : nil, preview, time,
                             issueCountLabel].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityActions {
            if let t = issuesToggle, let onToggleIssues {
                Button(t.expanded ? L("grp.hideIssues") : L("grp.showIssues"), action: onToggleIssues)
            }
        }
    }

    /// Asuntos para VoiceOver: los del chip (con vencidos) o el conteo del servidor.
    private var issueCountLabel: String? {
        let n = issuesToggle?.count ?? c.openIssues
        guard n > 0 else { return nil }
        var s = (n == 1 ? L("issue.chipOne") : L("issue.chipMany", ["n": n])).replacingOccurrences(of: "◆ ", with: "")
        if let o = issuesToggle?.overdue, o > 0 { s += ", " + (o == 1 ? L("grp.overdueOne") : L("grp.overdueMany", ["n": o])) }
        return s
    }

    private func issuesChip(_ t: IssuesToggle) -> some View {
        Button { onToggleIssues?() } label: {
            // «◆ 18 · 2! ›»: el conteo, los vencidos en rojo y el chevron que gira al desplegar.
            HStack(spacing: 3) {
                Text("◆ \(t.count)").foregroundStyle(Theme.accentText).monospacedDigit()
                if t.overdue > 0 { Text("· \(t.overdue)!").foregroundStyle(.red).monospacedDigit() }
                Image(systemName: "chevron.right").scaledFont(8, weight: .heavy, relativeTo: .caption).foregroundStyle(Theme.accentText)
                    .rotationEffect(.degrees(t.expanded ? 90 : 0))
            }
            .font(.caption2.weight(.bold))
            .lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(Theme.orange.opacity(t.expanded ? 0.22 : 0.12)))
            // Área táctil más grande que la cápsula (sin agrandar la fila).
            .padding(.vertical, 6).padding(.horizontal, 2)
            .contentShape(Rectangle())
            .padding(.vertical, -6)
        }
        .fixedSize()
        .layoutPriority(1)
        .buttonStyle(.borderless)
        .accessibilityLabel(issueCountLabel ?? "")
        .accessibilityHint(t.expanded ? L("grp.hideIssues") : L("grp.showIssues"))
        .accessibilityIdentifier("grp.issuesToggle.\(c.id)")
    }
}

/// Ícono de conversación: foto del grupo, persona, varias personas, # / candado / ⑂ / consulta lateral.
struct ConvIcon: View {
    var d: BootstrapDTO
    var c: ConversationDTO
    var size: CGFloat = 30
    var body: some View {
        if let photo = c.avatarUrl, MediaURL.absolute(photo) != nil {
            Avatar(name: Naming.title(d, c), org: nil, size: size, photo: photo, fill: PersonColor.fill(c.id))
        } else if c.kind == .direct, let other = Naming.otherInDirect(d, c) {
            Avatar(person: other, org: Naming.org(d, other.orgId), size: size)
        } else if Naming.isSide(c) {
            glyph("bubble.left.and.text.bubble.right", fg: Theme.sideText, bg: Theme.sideFill)
        } else if c.kind == .multi {
            StackedAvatars(d: d, c: c, box: size)
        } else {
            glyph(c.parentId != nil ? "bubble.left.and.bubble.right" : c.kind == .internal ? "lock.fill" : "number")
        }
    }

    private func glyph(_ name: String, fg: Color = Theme.accentText, bg: Color = Theme.orange.opacity(0.12)) -> some View {
        Image(systemName: name)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(fg)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.28).fill(bg))
            .accessibilityHidden(true)
    }
}

struct ConnectionBanner: View {
    var connection: AppStore.Connection
    var body: some View {
        HStack(spacing: 8) {
            if connection == .connecting { ProgressView().controlSize(.small) } else { Image(systemName: "wifi.slash") }
            Text(connection == .connecting ? L("conn.connecting") : L("conn.offline")).font(.footnote)
        }
        .foregroundStyle(Theme.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("conn.banner")
    }
}

struct ConversationRow: View {
    @Environment(AppStore.self) private var store
    var d: BootstrapDTO
    var c: ConversationDTO

    var body: some View {
        let title = Naming.title(d, c)
        let preview = c.memberIds.contains(where: { store.blockedUserIds.contains($0) }) ? L("safety.previewHidden") : (L10n.listPreview(c) ?? L("conv.noMessages"))
        let time = L10n.timeLabel(c.lastMessageAt)
        HStack(spacing: 12) {
            icon
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.body.weight(c.unread > 0 ? .semibold : .regular)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    if c.isMuted { Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(Theme.textSecondary).accessibilityHidden(true) }
                    if c.openIssues > 0 {
                        Text("◆ \(c.openIssues)").font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText).accessibilityHidden(true)
                    }
                    Spacer(minLength: 6)
                    Text(time).font(.caption).foregroundStyle(c.unread > 0 ? Theme.accentText : Theme.textSecondary)
                }
                HStack(alignment: .top) {
                    Text(preview).font(.subheadline).foregroundStyle(Theme.textSecondary).lineLimit(2)
                    Spacer(minLength: 6)
                    if c.unreadMentions > 0 { MentionBadge() }
                    if c.unread > 0 {
                        Text(c.unread > 99 ? "99+" : "\(c.unread)")
                            .font(.caption.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Capsule().fill(c.isMuted && c.unreadMentions == 0 ? Theme.badgeMuted : Theme.bubbleMine))
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(title: title, preview: preview, time: time))
    }

    @ViewBuilder private var icon: some View {
        if c.kind == .direct, let other = Naming.otherInDirect(d, c) {
            Avatar(person: other, org: Naming.org(d, other.orgId), size: 44, badge: true)
        } else if c.kind == .multi {
            StackedAvatars(d: d, c: c, box: 44)
        } else {
            Image(systemName: c.kind == .internal ? "lock.fill" : "number")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.accentText)
                .frame(width: 44, height: 44)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.orange.opacity(0.14)))
                .accessibilityHidden(true)
        }
    }

    private func accessibilityText(title: String, preview: String, time: String) -> String {
        var parts = [title]
        if c.kind == .internal { parts.append(L("kind.internalShort")) }
        if c.kind == .multi { parts.append(Naming.subtitle(d, c)) }
        if c.isMuted { parts.append(L("side.muted")) }
        if c.pinnedAt != nil { parts.append(L("side.pinned")) }
        if c.unreadMentions > 0 { parts.append(L("mention.youMentioned")) }
        if c.unread > 0 { parts.append(L("a11y.unread", ["n": c.unread])) }
        parts.append(preview)
        if !time.isEmpty { parts.append(time) }
        return parts.joined(separator: ", ")
    }
}


/// Pestañas grandes tipo «pill» bajo el buscador: Todo · No leídos · Asuntos · Chats · Laterales, con contador.
struct HomeTabs: View {
    let d: BootstrapDTO
    @Binding var selected: HomeFilter
    var cases: [HomeFilter] = HomeFilter.allCases
    /// Grupos: los contadores cuentan solo grupos.
    var groupsOnly = false
    /// Accesos con logo (WhatsApp, correo) al inicio de la fila.
    var leading: AnyView? = nil
    /// «🔔 N» al final de la fila.
    var trailing: AnyView? = nil
    /// Filas que no son de chaggu y también cuentan (WhatsApp en la bandeja).
    var extraCount: ((HomeFilter) -> Int)? = nil
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if let leading {
                    leading
                    Rectangle().fill(Theme.textSecondary.opacity(0.25)).frame(width: 1, height: 22).accessibilityHidden(true)
                }
                ForEach(cases) { t in
                    let n = (groupsOnly ? t.groupCount(d) : t.count(d)) + (extraCount?(t) ?? 0)
                    let on = selected == t
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { selected = t }
                        HomeFilter.saved = t
                    } label: {
                        HStack(spacing: 6) {
                            Text(L(t.labelKey)).font(.subheadline.weight(.semibold))
                            if t != .all || n > 0 {
                                Text("\(n)").font(.caption.weight(.bold)).monospacedDigit()
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(Capsule().fill(on ? Color.white.opacity(0.25) : Theme.textSecondary.opacity(0.15)))
                            }
                        }
                        .foregroundStyle(on ? Theme.onPrimary : Theme.textPrimary)
                        .padding(.horizontal, 14).frame(minHeight: 40)
                        .background(Capsule().fill(on ? Theme.primaryFill : Theme.surface))
                        .overlay(Capsule().stroke(Theme.textSecondary.opacity(on ? 0 : 0.2)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(L(t.labelKey)), \(n)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("home.tab.\(t.rawValue)")
                }
                if let trailing { trailing }
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
        }
    }
}

/// Bandeja «Menciones» (pestaña de Inicio): mis menciones recientes con el texto resaltado; tocar abre el mensaje.
struct MentionsInboxSection: View {
    @Environment(AppStore.self) private var store
    @State private var items: [MentionItem] = []
    @State private var hasMore = false
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        Section {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            if items.isEmpty && !loading && error == nil {
                Text(L("mention.empty")).foregroundStyle(Theme.textSecondary).accessibilityIdentifier("mention.empty")
            }
            if let d = store.data {
                ForEach(items) { it in row(d, it) }
            }
            if loading { ProgressView().frame(maxWidth: .infinity) }
            if hasMore && !loading {
                Button(L("mention.loadMore")) { Task { await load(more: true) } }.accessibilityIdentifier("mention.loadMore")
            }
        } header: { HomeHeader(title: L("mention.inbox")) }
        .task { await load(more: false) }
    }

    private func row(_ d: BootstrapDTO, _ it: MentionItem) -> some View {
        let author = Naming.person(d, it.message.authorId)
        let conv = store.meta(it.conversationId)
        let title = conv.map { Naming.title(d, $0) } ?? ""
        return Button {
            store.jumpTo[it.conversationId] = it.message.seq
            store.navigate(to: .conversation(it.conversationId))
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Avatar(person: author, org: Naming.org(d, author?.orgId), size: 36)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text(author?.name ?? "").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                        if !title.isEmpty { Text(L("mention.inConv", ["name": title])).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                        Spacer(minLength: 4)
                        Text(L10n.timeLabel(it.createdAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
                    }
                    Text(MentionText.attributed(AttributedString(it.message.body), text: it.message.body, mentions: it.message.mentions, mine: false, links: false))
                        .font(.subheadline).lineLimit(3).foregroundStyle(Theme.textPrimary)
                }
                if !it.read { Circle().fill(Theme.orange).frame(width: 8, height: 8).padding(.top, 6).accessibilityLabel(L("home.tab.unread")) }
            }
            .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("mention.item.\(it.message.id)")
    }

    private func load(more: Bool) async {
        loading = true
        defer { loading = false }
        do {
            let page = try await store.loadMentions(before: more ? items.last?.createdAt : nil)
            items = more ? items + page.mentions.filter { n in !items.contains { $0.id == n.id } } : page.mentions
            hasMore = page.hasMore
            error = nil
        } catch { self.error = L10n.errorText(error) }
    }
}
