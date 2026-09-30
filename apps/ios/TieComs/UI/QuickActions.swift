import SwiftUI

// MARK: - Barra de arriba: ✏️ Mensaje nuevo · ＋ Crear

/// Lo que se abre desde la barra de arriba (igual en Grupos, DMs, Asuntos y Calendario).
enum QuickSheet: String, Identifiable {
    case compose, group, issue, event, join
    var id: String { rawValue }
}

/// ✏️ siempre a mano para escribirle a alguien, y «＋» solo para crear: grupo, asunto o reunión (o entrar con código).
/// Todo lo demás (Archivos, Recordatorios, Trazo, WhatsApp) vive en «Tú».
struct QuickActions: ViewModifier {
    @Environment(AppStore.self) private var store
    @State private var sheet: QuickSheet?

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        Button { sheet = .group } label: { Label(L("grp.new"), systemImage: "person.3") }
                            .accessibilityIdentifier("create.group")
                        Button { sheet = .issue } label: { Label(L("grp.newIssue"), systemImage: "checklist") }
                            .disabled(!canCreateIssue)
                            .accessibilityIdentifier("create.issue")
                        Button { sheet = .event } label: { Label(L("cal.newTitle"), systemImage: "calendar.badge.plus") }
                            .accessibilityIdentifier("create.event")
                        Divider()
                        Button { sheet = .join } label: { Label(L("join.title"), systemImage: "ticket") }
                            .accessibilityIdentifier("create.join")
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel(L("quick.create"))
                    .accessibilityIdentifier("quick.create")
                    Button { sheet = .compose } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel(L("dm.new"))
                        .accessibilityIdentifier("quick.compose")
                }
            }
            .sheet(item: $sheet) { s in
                switch s {
                case .compose: NewChatSheet()
                case .group: NewGroupSheet(preset: .none)
                case .issue: NewIssueSheet(conversationId: nil, origin: nil)
                case .event: EventEditorSheet(conversationId: nil, origin: nil, event: nil)
                case .join: JoinWithCodeSheet()
                }
            }
    }

    // Siempre se puede crear: al menos un asunto personal (1.6.6).
    private var canCreateIssue: Bool { store.data != nil }
}

extension View {
    /// ✏️ y «＋» de las pestañas (docs/GRUPOS.md › Barra de arriba).
    func quickActions() -> some View { modifier(QuickActions()) }
}

// MARK: - Resultados de búsqueda en las pestañas

/// Al buscar en Grupos o DMs también salen personas (tocar = abrir su directo), grupos y chats.
struct QuickSearchSections: View {
    @Environment(AppStore.self) private var store
    let d: BootstrapDTO
    let query: String
    var showGroups = true
    var showChats = true
    /// Personas cuyo directo ya aparece en la lista de la pestaña (no se repiten).
    var hidePeople: Set<String> = []

    var body: some View {
        let groups = showGroups ? QuickSearch.groups(d, query: query) : []
        let chats = showChats ? Naming.dms(d, query: query) : []
        // Quien ya tiene su directo entre los chats encontrados sale una sola vez (en Chats).
        let people = QuickSearch.people(d, query: query, exclude: hidePeople.union(chats.filter { $0.kind == .direct }.flatMap(\.memberIds)))
        if !people.isEmpty {
            Section {
                ForEach(people.prefix(8)) { p in
                    Button { open(p) } label: { PersonPickRow(d: d, p: p, selected: nil) }
                        .accessibilityIdentifier("search.person.\(p.id)")
                }
            } header: { HomeHeader(title: L("search.people")) }
        }
        if !groups.isEmpty {
            Section {
                ForEach(groups.prefix(8)) { c in convRow(c) }
            } header: { HomeHeader(title: L("search.groups")) }
        }
        if !chats.isEmpty {
            Section {
                ForEach(chats.prefix(8)) { c in convRow(c) }
            } header: { HomeHeader(title: L("search.chats")) }
        }
    }

    private func convRow(_ c: ConversationDTO) -> some View {
        NavigationLink(value: Route.conversation(c.id)) { HierarchyConvRow(d: d, c: c, showIssueChip: false, company: Naming.companyLine(d, c)) {} }
            .accessibilityIdentifier("search.conv.\(c.id)")
    }

    private func open(_ p: PersonDTO) {
        // Con directo: se abre en esta misma pestaña; sin directo: se crea y se abre en DMs.
        if let c = QuickSearch.direct(d, with: p.id) { store.push(.conversation(c.id)); return }
        Task { do { try await store.openDirect(with: p.id) } catch { store.show(L10n.errorText(error)) } }
    }
}

/// Persona con su foto, cargo o empresa; con `selected` muestra el círculo de selección, sin él un globito (abre chat).
struct PersonPickRow: View {
    let d: BootstrapDTO
    let p: PersonDTO
    var selected: Bool?
    /// Sin el círculo ni la burbuja de la derecha (la fila de «Mensaje nuevo» pone los suyos).
    var trailing = true

    var body: some View {
        let org = Naming.org(d, p.orgId)
        HStack(spacing: 12) {
            Avatar(person: p, org: org, size: 38, badge: org != nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(p.name).font(.body).foregroundStyle(Theme.textPrimary).lineLimit(1)
                let line = Naming.roleLine(p)
                let company = org?.name ?? (p.guest ? L("common.guest") : "")
                Text([line, company].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer()
            if !trailing {
                EmptyView()
            } else if let selected {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Theme.accentText : Theme.textSecondary.opacity(0.5))
            } else {
                Image(systemName: "bubble.left").font(.subheadline).foregroundStyle(Theme.accentText)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected == true ? .isSelected : [])
        .accessibilityHint(selected == nil ? L("search.opensChat") : "")
    }
}

/// Campo de búsqueda fijo arriba de una hoja (no se esconde al desplazar ni tapa el contenido).
struct InlineSearchField: View {
    @Binding var text: String
    var prompt: String
    var identifier: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.textSecondary)
            TextField(prompt, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityIdentifier(identifier)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textSecondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("common.clear"))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Capsule().fill(Color(uiColor: .tertiarySystemFill)))
        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
        .background(Color(uiColor: .systemGroupedBackground))
    }
}
