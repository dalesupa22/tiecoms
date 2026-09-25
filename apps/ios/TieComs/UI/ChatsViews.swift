import SwiftUI

// Chats entre personas (directos y grupales de varias empresas), reenvío a varios chats y
// vista previa de enlaces. Mismas reglas que apps/web/src/screens/Chats.tsx.

// MARK: - Enlaces en el texto

enum Linkify {
    /// Igual que URL_SPLIT de la web: http(s) hasta un espacio o comillas.
    private static let pattern = try! NSRegularExpression(pattern: #"\bhttps?://[^\s<>"'`]+"#, options: [.caseInsensitive])
    /// La puntuación final no es parte del enlace.
    private static let trailing = CharacterSet(charactersIn: ".,;:!?¿¡)]}»”’")

    /// Rangos y URL de los enlaces del texto (sin la puntuación final).
    static func links(in text: String) -> [(range: Range<String.Index>, url: URL)] {
        let ns = text as NSString
        return pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            guard var r = Range(m.range, in: text) else { return nil }
            while r.upperBound > r.lowerBound, let last = text[r].unicodeScalars.last, trailing.contains(last) {
                r = r.lowerBound..<text.index(before: r.upperBound)
            }
            guard r.upperBound > r.lowerBound, let u = URL(string: String(text[r])) else { return nil }
            return (r, u)
        }
    }

    /// Texto con enlaces tocables (abren el navegador del sistema) y subrayados.
    static func attributed(_ text: String) -> AttributedString {
        var out = AttributedString(text)
        for (r, u) in links(in: text) {
            guard let lo = AttributedString.Index(r.lowerBound, within: out), let hi = AttributedString.Index(r.upperBound, within: out) else { continue }
            out[lo..<hi].link = u
            out[lo..<hi].underlineStyle = .single
        }
        return out
    }
}

// MARK: - Vista previa de enlace

/// Tarjeta bajo el texto: miniatura, sitio, título (2 líneas) y descripción (2 líneas). Abre la URL en el navegador.
struct LinkPreviewCard: View {
    @Environment(\.openURL) private var openURL
    let preview: LinkPreviewDTO
    var mine = false

    var body: some View {
        Button {
            if let u = URL(string: preview.url) { openURL(u) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                if let img = MediaURL.absolute(preview.imageUrl) {
                    RemoteImage(url: img) { $0.resizable().scaledToFill() }
                        .frame(width: 64, height: 64)
                        .background(Theme.bubbleOther)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(preview.host).font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText).lineLimit(1)
                    if let t = preview.title, !t.isEmpty {
                        Text(t).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(2).multilineTextAlignment(.leading)
                    }
                    if let desc = preview.description, !desc.isEmpty {
                        Text(desc).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(2).multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .frame(maxWidth: 300, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(mine ? Color.white.opacity(0.4) : Theme.textSecondary.opacity(0.2)))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([preview.host, preview.title, preview.description].compactMap { $0 }.joined(separator: ". "))
        .accessibilityAddTraits(.isLink)
        .accessibilityIdentifier("msg.linkPreview")
    }
}

// MARK: - Selector de personas

/// Personas agrupadas por empresa con buscador y chips de seleccionados.
struct PeoplePicker: View {
    let d: BootstrapDTO
    @Binding var picked: [String]
    var exclude: Set<String> = []
    @Binding var query: String

    var body: some View {
        let groups = Naming.peopleByOrg(d, query: query, exclude: exclude)
        if !picked.isEmpty {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(picked, id: \.self) { id in
                            let p = Naming.person(d, id)
                            Button { toggle(id) } label: {
                                HStack(spacing: 4) {
                                    Avatar(person: p, org: Naming.org(d, p?.orgId), size: 22)
                                    Text(p?.name.split(separator: " ").first.map(String.init) ?? "?").font(.subheadline)
                                    Image(systemName: "xmark").font(.caption2.weight(.bold))
                                }
                                .padding(.leading, 3).padding(.trailing, 9).padding(.vertical, 3)
                                .background(Capsule().fill(Theme.orange.opacity(0.14)))
                                .foregroundStyle(Theme.textPrimary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(L("common.remove")) \(p?.name ?? "")")
                            .accessibilityIdentifier("picker.chip.\(id)")
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        if groups.isEmpty {
            Section { Text(L("chat.nobody")).foregroundStyle(Theme.textSecondary) }
        }
        ForEach(groups) { g in
            Section {
                ForEach(g.people) { p in
                    let on = picked.contains(p.id)
                    Button { toggle(p.id) } label: {
                        HStack(spacing: 12) {
                            Avatar(person: p, org: g.org, size: 38, badge: g.org != nil)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name).font(.body).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                let line = Naming.roleLine(p)
                                Text(line.isEmpty ? (p.guest ? L("common.guest") : g.org?.name ?? "") : line)
                                    .font(.subheadline).foregroundStyle(Theme.textSecondary).lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(on ? Theme.accentText : Theme.textSecondary.opacity(0.5))
                        }
                    }
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("picker.person.\(p.id)")
                }
            } header: {
                HStack(spacing: 6) {
                    if let org = g.org { OrgMark(org: org, size: 18) }
                    Text(g.org?.name ?? L("common.guests"))
                    if g.isMine {
                        Text(L("chat.myTeam")).font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(Theme.orange.opacity(0.15)))
                            .foregroundStyle(Theme.accentText)
                    }
                }
                .textCase(nil)
            }
        }
    }

    private func toggle(_ id: String) {
        if let i = picked.firstIndex(of: id) { picked.remove(at: i) } else { picked.append(id) }
    }
}

// MARK: - Nuevo chat

/// Nuevo chat con selector arriba (como la web): «Persona o chat grupal» o «Grupo en un espacio».
struct NewChatSheet: View {
    enum Mode: String, CaseIterable, Identifiable { case person, space; var id: String { rawValue } }
    @State private var mode: Mode = .person
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker(L("chat.new"), selection: $mode) {
                    ForEach(Mode.allCases) { m in Text(L("chat.mode.\(m.rawValue)")).tag(m) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16).padding(.vertical, 8)
                .accessibilityIdentifier("newChat.mode")
                switch mode {
                case .person: PersonChatForm()
                case .space: SpaceGroupForm()
                }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle(L("chat.new"))
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// «Grupo en un espacio»: espacio agrupado por empresa (solo donde no soy tercero), nombre obligatorio, interno,
/// nivel directivo (oculto si es interno) y miembros del espacio. Al crear, abre el grupo.
struct SpaceGroupForm: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var wsId: String?
    @State private var name = ""
    @State private var isInternal = false
    @State private var directive = false
    @State private var query = ""
    @State private var picked: [String] = []
    @State private var busy = false
    @State private var error: String?
    @State private var newSpace = false

    var body: some View {
        if let d = store.data {
            let groups = Self.groups(d)
            let ws = d.workspaces.first { $0.id == (wsId ?? groups.first?.1.first?.id) }
            Form {
                if groups.isEmpty {
                    Section {
                        Text(L("chat.noSpaces")).foregroundStyle(Theme.textSecondary)
                        Button(L("dlg.createSpace")) { newSpace = true }.accessibilityIdentifier("newChat.createSpace")
                    }
                } else {
                    Section(L("chat.pickSpace")) {
                        ForEach(groups, id: \.0) { key, list in
                            let org = Naming.org(d, key)
                            Label { Text(org?.name ?? L("common.noCompany")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.textSecondary) } icon: { OrgMark(org: org, size: 18) }
                            ForEach(list) { w in
                                Button { wsId = w.id; picked = [] } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(w.name).foregroundStyle(Theme.textPrimary)
                                            if let dep = w.department, !dep.isEmpty { Text(dep).font(.caption).foregroundStyle(Theme.textSecondary) }
                                        }
                                        Spacer()
                                        if ws?.id == w.id { Image(systemName: "checkmark").foregroundStyle(Theme.accentText) }
                                    }
                                }
                                .accessibilityAddTraits(ws?.id == w.id ? .isSelected : [])
                                .accessibilityIdentifier("newChat.space.\(w.id)")
                            }
                        }
                    }
                    Section {
                        TextField(L("chat.groupName"), text: $name)
                            .onChange(of: name) { _, v in if v.count > 120 { name = String(v.prefix(120)) } }
                            .accessibilityIdentifier("newChat.spaceGroupName")
                        Toggle(isOn: $isInternal) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(L("chat.internalOnly"))
                                Text(L("chat.internalHint")).font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .onChange(of: isInternal) { _, _ in picked = [] }
                        .accessibilityIdentifier("newChat.internal")
                        if !isInternal { Toggle(L("chat.directive"), isOn: $directive).accessibilityIdentifier("newChat.directive") }
                    }
                    if let ws {
                        let people = candidates(d, ws)
                        Section(L("chat.spaceMembers")) {
                            TextField(L("chat.searchSpace"), text: $query).textInputAutocapitalization(.never)
                            if people.isEmpty { Text(query.isEmpty ? L("dlg.noCandidates") : L("chat.nobody")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                            ForEach(people) { p in
                                Button { if let i = picked.firstIndex(of: p.id) { picked.remove(at: i) } else { picked.append(p.id) } } label: {
                                    HStack(spacing: 10) {
                                        Avatar(person: p, org: Naming.org(d, p.orgId), size: 30)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(p.name).foregroundStyle(Theme.textPrimary)
                                            Text(Naming.org(d, p.orgId)?.name ?? "").font(.caption).foregroundStyle(Theme.textSecondary)
                                        }
                                        Spacer()
                                        Image(systemName: picked.contains(p.id) ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(picked.contains(p.id) ? Theme.accentText : Theme.textSecondary)
                                    }
                                }
                                .accessibilityAddTraits(picked.contains(p.id) ? .isSelected : [])
                                .accessibilityIdentifier("newChat.member.\(p.id)")
                            }
                        }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else if let ws {
                        Button(L("chat.createSpaceGroup")) { create(d, ws) }
                            .disabled(name.trimmingCharacters(in: .whitespaces).count < 2)
                            .accessibilityIdentifier("newChat.createSpaceGroup")
                    }
                }
            }
            .sheet(isPresented: $newSpace) { NewWorkspaceSheet() }
        }
    }

    /// Espacios donde no soy tercero, agrupados por empresa contraparte (como Inicio).
    static func groups(_ d: BootstrapDTO) -> [(String, [WorkspaceDTO])] {
        var order: [String] = []
        var map: [String: [WorkspaceDTO]] = [:]
        for w in d.workspaces where w.myRole != "guest" {
            let key = Naming.counterpartOrg(d, w)?.id ?? "none"
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(w)
        }
        return order.map { ($0, map[$0]!.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) }
    }

    /// Participantes del espacio (sin mí); con «interno», solo los de mis empresas.
    static func candidates(_ d: BootstrapDTO, _ ws: WorkspaceDTO, isInternal: Bool, query: String) -> [PersonDTO] {
        let myOrgs = Set(d.organizations.filter { $0.myRole != nil }.map(\.id))
        let members = Set(ws.memberIds)
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        return d.people
            .filter { members.contains($0.id) && $0.id != d.me.id && (!isInternal || $0.orgId.map(myOrgs.contains) == true) }
            .filter { p in q.isEmpty || [p.name, p.title ?? "", Naming.org(d, p.orgId)?.name ?? ""].contains { fold($0).contains(q) } }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func candidates(_ d: BootstrapDTO, _ ws: WorkspaceDTO) -> [PersonDTO] { Self.candidates(d, ws, isInternal: isInternal, query: query) }

    private func create(_ d: BootstrapDTO, _ ws: WorkspaceDTO) {
        busy = true; error = nil
        let allowed = Set(Self.candidates(d, ws, isInternal: isInternal, query: "").map(\.id))
        Task {
            do {
                let r = try await store.createWorkspaceConversation(workspaceId: ws.id, name: name, isInternal: isInternal, directive: directive,
                                                                    memberIds: picked.filter(allowed.contains))
                dismiss()
                store.navigate(to: .conversation(r.id))
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

/// «Persona o chat grupal»: una persona abre el directo; varias crean un chat grupal (pueden ser de empresas distintas).
struct PersonChatForm: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var picked: [String] = []
    @State private var query = ""
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Group {
            if let d = store.data {
                let orgs = involvedOrgs(d)
                Form {
                    Section { Text(L("chat.newHint")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                    if picked.count > 1 {
                        Section {
                            HStack(spacing: 6) {
                                HStack(spacing: -4) { ForEach(orgs) { OrgMark(org: $0, size: 22) } }
                                Text(orgs.count > 1 ? L("chat.crossCompany", ["n": orgs.count]) : L("chat.sameCompany"))
                                    .font(.footnote).foregroundStyle(Theme.textSecondary)
                            }
                            .accessibilityElement(children: .combine)
                            TextField(L("chat.groupNamePh"), text: $name)
                                .onChange(of: name) { _, v in if v.count > 120 { name = String(v.prefix(120)) } }
                                .accessibilityIdentifier("newChat.name")
                        }
                    }
                    PeoplePicker(d: d, picked: $picked, query: $query)
                    if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
                }
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("chat.searchPeople"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        if busy { ProgressView() } else {
                            Button(picked.count > 1 ? L("chat.createGroup", ["n": picked.count + 1]) : L("chat.openDirect"), action: create)
                                .disabled(picked.isEmpty)
                                .accessibilityIdentifier("newChat.create")
                        }
                    }
                }
            }
        }
    }

    /// Mi empresa y las de las personas elegidas (sin repetir).
    private func involvedOrgs(_ d: BootstrapDTO) -> [OrganizationDTO] {
        var seen = Set<String>()
        return ([d.me.primaryOrgId] + picked.map { Naming.person(d, $0)?.orgId }).compactMap { $0 }
            .filter { seen.insert($0).inserted }.compactMap { Naming.org(d, $0) }
    }

    private func create() {
        busy = true; error = nil
        Task {
            do {
                let r = try await store.createChat(userIds: picked, name: picked.count > 1 ? name : nil)
                dismiss()
                store.navigate(to: .conversation(r.id))
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

// MARK: - Sumar personas a un chat

struct AddMembersSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    @State private var picked: [String] = []
    @State private var query = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            if let d = store.data, let c = store.meta(conversationId) {
                Form {
                    PeoplePicker(d: d, picked: $picked, exclude: Set(c.memberIds), query: $query)
                    if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
                }
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("chat.searchPeople"))
                .navigationTitle(L("dlg.addToGroup"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        if busy { ProgressView() } else {
                            Button(L("dlg.add"), action: add).disabled(picked.isEmpty).accessibilityIdentifier("addMembers.submit")
                        }
                    }
                }
            }
        }
    }

    private func add() {
        busy = true; error = nil
        Task {
            do { try await store.addMembers(conversationId, userIds: picked); dismiss() } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

// MARK: - Reenviar a otros chats

/// Reenvío a hasta 10 chats (directos, grupos y chats grupales) con comentario opcional.
struct ForwardSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: MessageDTO
    @State private var query = ""
    @State private var picked: [String] = []
    @State private var comment = ""

    var body: some View {
        NavigationStack {
            if let d = store.data {
                let author = Naming.person(d, source.authorId)?.name
                let q = query.trimmingCharacters(in: .whitespaces)
                let list = d.conversations
                    .filter { $0.canPost && $0.id != source.conversationId && (q.isEmpty || Naming.title(d, $0).localizedCaseInsensitiveContains(q)) }
                    .sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
                Form {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("“\(excerpt(source.body, 240))”").italic()
                            if let author { Text("— \(author)").font(.caption).foregroundStyle(Theme.textSecondary) }
                        }
                    }
                    Section {
                        TextField(L("fwd.comment"), text: $comment, axis: .vertical).lineLimit(1...4)
                            .accessibilityIdentifier("fwd.comment")
                    }
                    Section {
                        ForEach(list) { c in
                            let on = picked.contains(c.id)
                            Button { toggle(c.id) } label: { ChatOption(d: d, c: c, on: on) }
                                .disabled(!on && picked.count >= AppStore.maxForwardTargets)
                                .accessibilityAddTraits(on ? .isSelected : [])
                                .accessibilityIdentifier("fwd.target.\(c.id)")
                        }
                    } header: {
                        Text(picked.count >= AppStore.maxForwardTargets ? L("fwd.limit", ["n": AppStore.maxForwardTargets]) : L("fwd.pick"))
                    }
                }
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("fwd.search"))
                .navigationTitle(L("fwd.title"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(picked.count > 1 ? L("fwd.sendMany", ["n": picked.count]) : L("fwd.send")) {
                            let n = store.forward(source, to: picked, comment: comment)
                            store.show(n == 1 ? L("toast.sent") : L("fwd.sentMany", ["n": n]))
                            dismiss()
                        }
                        .disabled(picked.isEmpty)
                        .accessibilityIdentifier("fwd.send")
                    }
                }
            }
        }
    }

    private func toggle(_ id: String) {
        if let i = picked.firstIndex(of: id) { picked.remove(at: i) }
        else if picked.count < AppStore.maxForwardTargets { picked.append(id) }
    }
}

/// Fila de un chat destino: avatar (directo), caritas (grupal) o # / candado (espacio), con logos de las empresas.
struct ChatOption: View {
    var d: BootstrapDTO
    var c: ConversationDTO
    var on: Bool

    var body: some View {
        let other = c.kind == .direct ? Naming.otherInDirect(d, c) : nil
        let ws = d.workspaces.first { $0.id == c.workspaceId }
        let sub: String = {
            if let other { return [other.title, Naming.org(d, other.orgId)?.name].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }
            return ws?.name ?? L("chat.groupChat")
        }()
        HStack(spacing: 12) {
            Group {
                if let other {
                    Avatar(person: other, org: Naming.org(d, other.orgId), size: 36, badge: true)
                } else if c.kind == .multi {
                    StackedAvatars(d: d, c: c, box: 36)
                } else {
                    Image(systemName: c.kind == .internal ? "lock.fill" : "number")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.accentText)
                        .frame(width: 36, height: 36)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.orange.opacity(0.14)))
                }
            }
            .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(Naming.title(d, c)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1) }
            }
            Spacer(minLength: 4)
            if other == nil {
                HStack(spacing: 2) { ForEach(Naming.companies(d, c).prefix(4)) { OrgMark(org: $0, size: 16) } }
            }
            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(on ? Theme.accentText : Theme.textSecondary.opacity(0.5))
        }
        .accessibilityElement(children: .combine)
    }
}
