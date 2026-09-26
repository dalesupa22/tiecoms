import SwiftUI
import UIKit

// Nuevo grupo, invitar (correo, enlace o código), unirme con código, DMs, supervisión y el ícono de «Tú»
// (docs/GRUPOS.md: mismas reglas en web, iOS y Android).

/// Cómo se abre «Nuevo grupo»: desde el «+» general, el de una sección o el menú de una empresa o espacio.
enum NewGroupPreset: Hashable {
    case none
    /// «Solo {mi empresa}» marcado (nil = mi empresa principal).
    case org(String?)
    /// «Con otra empresa» marcado, con la relación ya puesta (clave de empresa del árbol) o sin elegir.
    case company(String?)
    /// «Nuevo grupo aquí»: en este espacio.
    case workspace(String)
}

/// A quién invita la hoja «Invitar».
enum InviteTarget: Hashable {
    case group(String)
    case workspace(String)
    /// Invitar a mi empresa (owner/admin).
    case org(String)
}

private let otherCompanyKey = "_new"

// MARK: - Nuevo grupo

/// Una sola hoja con títulos visibles en cada campo: ¿Para quién es? · Empresa · Nombre · Personas · Invitar de fuera · Enlace.
/// Envía POST /groups y, si vuelve un enlace, muestra la pantalla de compartir.
struct NewGroupSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let preset: NewGroupPreset
    @State private var forOther = false
    @State private var orgId: String?
    @State private var relationKey = ""
    @State private var newCompany = ""
    @State private var wsId: String?
    /// «Nuevo grupo aquí»: el espacio queda fijo.
    @State private var fixedWs: String?
    @State private var name = ""
    @State private var picked: [String] = []
    @State private var query = ""
    @State private var emails = ""
    @State private var inviteRole = "member"
    @State private var shareLink = false
    @State private var busy = false
    @State private var error: String?
    @State private var created: InviteShareData?
    @State private var didPreset = false

    var body: some View {
        if let created {
            NavigationStack {
                InviteShareView(data: created)
                    .navigationTitle(L("ishare.title"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button(L("ishare.done")) {
                                dismiss()
                                if let id = created.conversationId { store.navigate(to: .conversation(id)) }
                            }
                            .accessibilityIdentifier("share.done")
                        }
                    }
            }
        } else if let d = store.data {
            SheetForm(title: L("grp.newTitle"), action: L("grp.create"), busy: busy, disabled: !canSubmit(d), error: error, onSubmit: { submit(d) }) {
                form(d)
            }
            .onAppear { applyPreset(d) }
        }
    }

    // MARK: Datos

    private var myOrg: OrganizationDTO? {
        guard let d = store.data else { return nil }
        return Naming.org(d, orgId ?? d.me.primaryOrgId) ?? Naming.myOrgsOrdered(d).first
    }

    private func selectedRelation(_ d: BootstrapDTO) -> GroupsTree.CompanyNode? {
        Naming.relations(d).first { $0.id == relationKey }
    }

    /// Espacio donde irá el grupo si ya existe (relación elegida o «aquí»); nil = casa de la empresa o relación nueva.
    private func targetWorkspace(_ d: BootstrapDTO) -> WorkspaceDTO? {
        if let fixedWs { return d.workspaces.first { $0.id == fixedWs } }
        guard forOther, relationKey != otherCompanyKey, let rel = selectedRelation(d) else { return nil }
        return rel.workspaces.first { $0.ws.id == wsId }?.ws ?? rel.workspaces.first?.ws
    }

    private func target(_ d: BootstrapDTO) -> GroupTarget? {
        if let ws = targetWorkspace(d) { return .workspace(ws.id) }
        if !forOther { return .org(orgId: orgId) }
        if relationKey == otherCompanyKey {
            let n = newCompany.trimmingCharacters(in: .whitespaces)
            return n.count >= 2 ? .company(name: n, orgId: orgId) : nil
        }
        return nil
    }

    /// Nombre de la otra empresa para «De {empresa}».
    private func otherName(_ d: BootstrapDTO) -> String {
        if relationKey == otherCompanyKey { let n = newCompany.trimmingCharacters(in: .whitespaces); return n.isEmpty ? L("grp.otherCompany") : n }
        if let ws = targetWorkspace(d) {
            switch Naming.placement(d, ws) {
            case .relation(let id): return Naming.org(d, id)?.name ?? L("grp.otherCompany")
            case .pending(let n): return n
            default: break
            }
        }
        return selectedRelation(d)?.name ?? L("grp.otherCompany")
    }

    /// Personas que puedo sumar: en un espacio que ya existe, las del espacio; si no, mis colegas.
    private func candidates(_ d: BootstrapDTO, query: String? = nil) -> [PersonDTO] {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold((query ?? self.query).trimmingCharacters(in: .whitespaces))
        let base: [PersonDTO]
        if let ws = targetWorkspace(d) {
            let ids = Set(ws.memberIds)
            base = d.people.filter { ids.contains($0.id) }
        } else {
            base = d.people.filter { $0.orgId != nil && $0.orgId == myOrg?.id }
        }
        return base.filter { $0.kind == "human" && $0.id != d.me.id }
            .filter { p in q.isEmpty || [p.name, p.title ?? "", p.area ?? ""].contains { fold($0).contains(q) } }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func canSubmit(_ d: BootstrapDTO) -> Bool {
        name.trimmingCharacters(in: .whitespaces).count >= 2 && target(d) != nil && InviteEmails.parse(emails).invalid.isEmpty
    }

    private func applyPreset(_ d: BootstrapDTO) {
        guard !didPreset else { return }
        didPreset = true
        let rels = Naming.relations(d)
        relationKey = rels.first?.id ?? otherCompanyKey
        switch preset {
        case .none: break
        case .org(let id): forOther = false; orgId = id
        case .company(let key): forOther = true; if let key, rels.contains(where: { $0.id == key }) { relationKey = key }
        case .workspace(let id):
            fixedWs = id
            if let ws = d.workspaces.first(where: { $0.id == id }) {
                let p = Naming.placement(d, ws)
                switch p {
                case .relation, .pending: forOther = true; relationKey = p.companyKey; wsId = id
                case .mine(let o): forOther = false; orgId = o
                case .guest: break
                }
            }
        }
        shareLink = forOther
    }

    // MARK: Formulario

    @ViewBuilder private func form(_ d: BootstrapDTO) -> some View {
        let orgName = myOrg?.name ?? L("grp.myCompany")
        Section(L("grp.forWhom")) {
            if let fixedWs, let ws = d.workspaces.first(where: { $0.id == fixedWs }) {
                Label(L("grp.inSpace", ["name": ws.isOrgHome ? orgName : ws.name]), systemImage: ws.isOrgHome ? "building.2" : "square.stack.3d.up")
                    .accessibilityIdentifier("grp.fixedSpace")
            } else {
                Picker(L("grp.forWhom"), selection: $forOther) {
                    Text(L("grp.onlyOrg", ["org": orgName])).tag(false)
                    Text(L("grp.withOther")).tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .onChange(of: forOther) { _, v in shareLink = v }
                .accessibilityIdentifier("grp.forWhom")
                Text(forOther ? L("grp.withOtherHint") : L("grp.onlyOrgHint", ["org": orgName])).font(.footnote).foregroundStyle(Theme.textSecondary)
            }
        }
        if forOther && fixedWs == nil {
            let rels = Naming.relations(d)
            Section(L("grp.company")) {
                Picker(L("grp.company"), selection: $relationKey) {
                    ForEach(rels) { r in Text(r.pending ? "\(r.name) · \(L("grp.pending"))" : r.name).tag(r.id) }
                    Text(L("grp.newCompany")).tag(otherCompanyKey)
                }
                .onChange(of: relationKey) { _, _ in wsId = nil }
                .accessibilityIdentifier("grp.company")
                if relationKey == otherCompanyKey {
                    TextField(L("grp.companyNamePh"), text: $newCompany)
                        .textInputAutocapitalization(.words)
                        .accessibilityLabel(L("grp.companyName"))
                        .accessibilityIdentifier("grp.companyName")
                }
                if let rel = selectedRelation(d), rel.workspaces.count > 1 {
                    Picker(L("grp.space"), selection: Binding(get: { wsId ?? rel.workspaces.first?.ws.id ?? "" }, set: { wsId = $0 })) {
                        ForEach(rel.workspaces) { w in Text(w.ws.name).tag(w.ws.id) }
                    }
                    .accessibilityIdentifier("grp.space")
                }
            }
        }
        Section(L("grp.name")) {
            TextField(L("grp.namePh"), text: $name)
                .onChange(of: name) { _, v in if v.count > 120 { name = String(v.prefix(120)) } }
                .accessibilityLabel(L("grp.name"))
                .accessibilityIdentifier("grp.name")
        }
        let people = candidates(d)
        Section(targetWorkspace(d) != nil ? L("grp.peopleSpace") : L("grp.people", ["org": orgName])) {
            if people.count > 8 || !query.isEmpty {
                TextField(L("chat.searchPeople"), text: $query).textInputAutocapitalization(.never)
            }
            if people.isEmpty { Text(query.isEmpty ? (targetWorkspace(d) != nil ? L("dlg.noCandidates") : L("grp.noColleagues")) : L("chat.nobody")).font(.footnote).foregroundStyle(Theme.textSecondary) }
            ForEach(people) { p in
                let on = picked.contains(p.id)
                Button { if let i = picked.firstIndex(of: p.id) { picked.remove(at: i) } else { picked.append(p.id) } } label: {
                    HStack(spacing: 10) {
                        Avatar(person: p, org: Naming.org(d, p.orgId), size: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(p.name).foregroundStyle(Theme.textPrimary)
                            let line = Naming.roleLine(p)
                            Text(line.isEmpty ? (Naming.org(d, p.orgId)?.name ?? "") : line).font(.caption).foregroundStyle(Theme.textSecondary)
                        }
                        Spacer()
                        Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundStyle(on ? Theme.accentText : Theme.textSecondary)
                    }
                }
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("grp.member.\(p.id)")
            }
        }
        let parsed = InviteEmails.parse(emails)
        Section {
            TextField(L("grp.emailsPh"), text: $emails, axis: .vertical)
                .lineLimit(1...4)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(L("grp.inviteOutside"))
                .accessibilityIdentifier("grp.emails")
            if !parsed.invalid.isEmpty {
                Text(L("grp.badEmails", ["list": parsed.invalid.joined(separator: ", ")])).font(.caption).foregroundStyle(.red)
            }
            if forOther {
                RoleChoice(role: $inviteRole, memberLabel: L("grp.roleMember", ["org": otherName(d)]), guestLabel: L("grp.roleGuest"))
            } else {
                Label(L("grp.guestsNotice"), systemImage: "person.crop.circle.badge.questionmark").font(.footnote).foregroundStyle(Theme.textSecondary)
            }
        } header: { Text(L("grp.inviteOutside")) } footer: { Text(L("grp.inviteOutsideHint")) }
        Section {
            Toggle(L("grp.shareLink"), isOn: $shareLink).accessibilityIdentifier("grp.shareLink")
        } footer: { Text(L("grp.shareLinkHint")) }
    }

    private func submit(_ d: BootstrapDTO) {
        guard let target = target(d) else { return }
        busy = true; error = nil
        // Si cambió el destino después de elegir, solo van las personas que caben en él.
        let allowed = Set(candidates(d, query: "").map(\.id))
        let members = picked.filter(allowed.contains)
        let groupName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                let r = try await store.createGroup(name: groupName, target: target, memberIds: members,
                                                    inviteEmails: InviteEmails.parse(emails).valid,
                                                    inviteRole: forOther ? inviteRole : "guest", shareLink: shareLink)
                if r.invited > 0 { store.show(L("inv.sent", ["n": r.invited])) }
                if let url = r.inviteUrl {
                    created = InviteShareData(name: groupName, url: url, code: r.inviteCode, expiresAt: Date().addingTimeInterval(14 * 86400),
                                              conversationId: r.conversationId)
                } else {
                    dismiss()
                    store.navigate(to: .conversation(r.conversationId))
                }
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

/// Rol de quien viene de fuera: «De {empresa}» (member) o «Tercero a título propio» (guest).
struct RoleChoice: View {
    @Binding var role: String
    var memberLabel: String
    var guestLabel: String
    var body: some View {
        ForEach([("member", memberLabel), ("guest", guestLabel)], id: \.0) { value, label in
            Button { role = value } label: {
                HStack {
                    Text(label).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    if role == value { Image(systemName: "checkmark").foregroundStyle(Theme.accentText) }
                }
            }
            .accessibilityAddTraits(role == value ? .isSelected : [])
            .accessibilityIdentifier("grp.role.\(value)")
        }
    }
}

// MARK: - Invitar

/// «Invitar a {grupo}»: rol, por correo o enlace y código (POST /workspaces/{id}/invitations).
/// También sirve para un espacio (sin grupos) y para invitar a mi empresa por correo.
struct InviteSheet: View {
    enum Mode: String, CaseIterable, Identifiable { case email, link; var id: String { rawValue } }
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let target: InviteTarget
    @State private var role = "member"
    @State private var mode: Mode = .email
    @State private var emails = ""
    @State private var busy = false
    @State private var error: String?
    @State private var created: InviteShareData?

    private struct Resolved { var title: String; var workspace: WorkspaceDTO?; var conversationIds: [String]; var guestOnly: Bool; var roleFixed: String?; var org: OrganizationDTO? }

    private func resolve(_ d: BootstrapDTO) -> Resolved? {
        switch target {
        case .group(let id):
            guard let c = store.meta(id) else { return nil }
            let ws = d.workspaces.first { $0.id == c.workspaceId }
            let home = ws?.isOrgHome == true
            return .init(title: Naming.title(d, c), workspace: ws, conversationIds: [id], guestOnly: home, roleFixed: home ? "guest" : nil, org: nil)
        case .workspace(let id):
            guard let ws = d.workspaces.first(where: { $0.id == id }) else { return nil }
            // Un tercero debe entrar a grupos concretos: al espacio se invita a personas de otra empresa.
            return .init(title: ws.name, workspace: ws, conversationIds: [], guestOnly: false, roleFixed: "member", org: nil)
        case .org(let id):
            guard let o = Naming.org(d, id) else { return nil }
            return .init(title: o.name, workspace: nil, conversationIds: [], guestOnly: false, roleFixed: nil, org: o)
        }
    }

    var body: some View {
        if let created {
            NavigationStack {
                InviteShareView(data: created)
                    .navigationTitle(L("ishare.title"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("ishare.done")) { dismiss() }.accessibilityIdentifier("share.done") } }
            }
        } else if let d = store.data, let r = resolve(d) {
            let parsed = InviteEmails.parse(emails)
            let emailMode = mode == .email || r.org != nil
            SheetForm(title: L("inv.title", ["name": r.title]), action: emailMode ? L("inv.send") : L("inv.createLink"), busy: busy,
                      disabled: emailMode && (parsed.valid.isEmpty || !parsed.invalid.isEmpty), error: error, onSubmit: { submit(r) }) {
                if r.org == nil {
                    Section(L("inv.role")) {
                        if let fixed = r.roleFixed {
                            Label(fixed == "guest" ? L("inv.roleGuest") : L("inv.roleMember"), systemImage: "person.crop.circle")
                            if r.guestOnly { Text(L("inv.orgHomeGuests")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                        } else {
                            RoleChoice(role: $role, memberLabel: L("inv.roleMember"), guestLabel: L("inv.roleGuest"))
                        }
                    }
                    Section {
                        Picker(L("inv.how"), selection: $mode) {
                            Text(L("inv.byEmail")).tag(Mode.email)
                            Text(L("inv.byLink")).tag(Mode.link)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .accessibilityIdentifier("inv.mode")
                    } header: { Text(L("inv.how")) }
                }
                if emailMode {
                    Section {
                        TextField(L("grp.emailsPh"), text: $emails, axis: .vertical)
                            .lineLimit(1...4)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityLabel(L("inv.emails"))
                            .accessibilityIdentifier("inv.emails")
                        if !parsed.invalid.isEmpty {
                            Text(L("grp.badEmails", ["list": parsed.invalid.joined(separator: ", ")])).font(.caption).foregroundStyle(.red)
                        }
                    } header: { Text(L("inv.emails")) }
                } else {
                    Section { Text(L("inv.linkHint")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                }
            }
            .onAppear { if let fixed = r.roleFixed { role = fixed } }
        } else {
            ContentUnavailableView(L("chat.notFound"), systemImage: "lock.slash")
        }
    }

    private func submit(_ r: Resolved) {
        busy = true; error = nil
        let role = r.roleFixed ?? self.role
        Task {
            defer { busy = false }
            do {
                if let org = r.org {
                    for e in InviteEmails.parse(emails).valid { try await store.createOrgInvitation(orgId: org.id, email: e) }
                    store.show(L("inv.sent", ["n": InviteEmails.parse(emails).valid.count]))
                    dismiss()
                    return
                }
                guard let ws = r.workspace else { return }
                if mode == .email {
                    var n = 0
                    for e in InviteEmails.parse(emails).valid {
                        _ = try await store.createInvitation(workspaceId: ws.id, conversationIds: r.conversationIds, email: e, role: role)
                        n += 1
                    }
                    store.show(L("inv.sent", ["n": n]))
                    dismiss()
                } else {
                    let inv = try await store.createInvitation(workspaceId: ws.id, conversationIds: r.conversationIds, email: nil, role: role)
                    created = InviteShareData(name: r.title, url: inv.url, code: inv.code,
                                              expiresAt: ISODate.parse(inv.expiresAt) ?? Date().addingTimeInterval(14 * 86400), conversationId: nil)
                }
            } catch { self.error = L10n.errorText(error) }
        }
    }
}

struct InviteShareData: Equatable {
    var name: String
    var url: String
    var code: String?
    var expiresAt: Date
    /// Grupo que «Listo» abre (al crear un grupo).
    var conversationId: String?

    var shareText: String {
        code.map { L("ishare.text", ["name": name, "url": url, "code": $0]) } ?? L("ishare.textNoCode", ["name": name, "url": url])
    }
}

/// Pantalla de compartir: el código en grande (Copiar), el enlace (Copiar) y el botón Compartir del sistema.
struct InviteShareView: View {
    @Environment(AppStore.self) private var store
    let data: InviteShareData

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "person.2.wave.2.fill").font(.system(size: 40)).foregroundStyle(Theme.accentText).padding(.top, 8)
                    .accessibilityHidden(true)
                Text(L("ishare.inviteTo", ["name": data.name])).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                    .foregroundStyle(Theme.textPrimary)
                if let code = data.code {
                    VStack(spacing: 8) {
                        Text(L("ishare.code")).font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(Theme.textSecondary)
                        Text(code).font(.system(size: 40, weight: .heavy, design: .monospaced)).foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                            .minimumScaleFactor(0.6).lineLimit(1)
                            .accessibilityLabel(code.map { String($0) }.joined(separator: " "))
                            .accessibilityIdentifier("share.code")
                        Button { copy(code) } label: { Label(L("ishare.copy"), systemImage: "doc.on.doc") }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("share.copyCode")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(16)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Theme.surface))
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(L("ishare.link")).font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(Theme.textSecondary)
                    HStack(alignment: .center, spacing: 10) {
                        Text(data.url).font(.footnote.monospaced()).foregroundStyle(Theme.textPrimary).lineLimit(2).textSelection(.enabled)
                            .accessibilityIdentifier("share.url")
                        Spacer(minLength: 4)
                        Button { copy(data.url) } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.bordered)
                            .accessibilityLabel(L("ishare.copyLink"))
                            .accessibilityIdentifier("share.copyLink")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: 16).fill(Theme.surface))
                ShareLink(item: data.shareText) { Label(L("ishare.share"), systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("share.system")
                Text(L("ishare.expires", ["date": data.expiresAt.formatted(Date.FormatStyle(date: .long, time: .omitted).locale(L10n.locale))]))
                    .font(.footnote).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
            }
            .padding(20)
        }
        .background(Theme.background.ignoresSafeArea())
    }

    private func copy(_ s: String) {
        UIPasteboard.general.string = s
        store.show(L("toast.copied"))
    }
}

// MARK: - Unirme con código

/// «Unirme con código»: acepta minúsculas, espacios y sin guion; también un enlace …/invite/<token> pegado.
struct JoinWithCodeSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var preview: InvitationPreviewDTO?
    @State private var busy = false
    @State private var error: String?

    private var key: String? { InviteCode.lookupKey(code) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L("join.placeholder"), text: $code)
                        .font(.title3.monospaced())
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .onChange(of: code) { _, v in
                            // Un enlace pegado se deja tal cual; un código se escribe como K7QM-4XPA.
                            if !v.contains("/") { let t = InviteCode.typing(v); if t != v { code = t } }
                            preview = nil; error = nil
                        }
                        .accessibilityLabel(L("join.codeLabel"))
                        .accessibilityIdentifier("join.code")
                } header: { Text(L("join.codeLabel")) } footer: { Text(L("join.hint")) }
                if let preview {
                    Section {
                        InvitePreviewSummary(inv: preview)
                        if preview.valid {
                            Button(action: accept) { Text(busy ? L("invite.accepting") : L("invite.join")) }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(busy)
                                .listRowBackground(Color.clear)
                                .listRowInsets(EdgeInsets())
                                .accessibilityIdentifier("join.accept")
                        }
                    }
                } else if busy {
                    Section { ProgressView().frame(maxWidth: .infinity) }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(L("join.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
            }
            // En cuanto el código está completo se busca la invitación.
            .task(id: key) {
                guard let key else { return }
                busy = true
                defer { busy = false }
                do { preview = try await store.previewInvitation(key) }
                catch let e as ApiRequestError where e.status == 404 { error = L("join.notFound") }
                catch { self.error = L10n.errorText(error) }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func accept() {
        guard let key else { return }
        busy = true; error = nil
        Task {
            do { try await store.acceptInvitation(key); dismiss() } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

/// «{invitedByName} de {invitedByOrg} te invita a {groupNames} en {workspaceName}» (+ tercero / vencida).
struct InvitePreviewSummary: View {
    let inv: InvitationPreviewDTO
    var body: some View {
        let org = inv.invitedByOrg.isEmpty ? "" : L("join.fromOrg", ["org": inv.invitedByOrg])
        VStack(alignment: .leading, spacing: 6) {
            Text(inv.groupNames.isEmpty
                 ? L("join.previewSpace", ["name": inv.invitedByName, "org": org, "space": inv.workspaceName])
                 : L("join.preview", ["name": inv.invitedByName, "org": org, "groups": inv.groupNames.joined(separator: ", "), "space": inv.workspaceName]))
                .font(.body).foregroundStyle(Theme.textPrimary)
                .accessibilityIdentifier("join.preview")
            if inv.role == "guest" { Text(L("join.asGuest")).font(.footnote).foregroundStyle(Theme.textSecondary) }
            if inv.multiUse { Text(L("join.multiUse")).font(.caption).foregroundStyle(Theme.textSecondary) }
            if !inv.valid { ErrorBanner(text: L("join.invalid")) }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - DMs

/// Pestaña DMs: directos y chats grupales, incluidos los sidechats (con su burbuja y «desde #origen»).
struct DMsView: View {
    @Environment(AppStore.self) private var store
    @State private var query = ""
    @State private var newChat = false
    @State private var issuesFor: String?

    var body: some View {
        Group {
            if let d = store.data {
                let list = Naming.dms(d, query: query)
                List {
                    if store.connection != .online {
                        ConnectionBanner(connection: store.connection)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    }
                    Section {
                        ForEach(list) { c in
                            NavigationLink(value: Route.conversation(c.id)) {
                                HierarchyConvRow(d: d, c: c) { issuesFor = c.id }
                            }
                            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 12))
                            .accessibilityIdentifier("conv.row.\(c.id)")
                            .contextMenu { ConversationMenuItems(conv: c) }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .animation(.spring(response: 0.45, dampingFraction: 0.9), value: list.map(\.id))
                .overlay {
                    if list.isEmpty {
                        if query.trimmingCharacters(in: .whitespaces).isEmpty {
                            ContentUnavailableView {
                                Label(L("dm.empty"), systemImage: "bubble.left.and.bubble.right")
                            } description: { Text(L("dm.emptyBody")) } actions: {
                                Button(L("dm.new")) { newChat = true }.primaryProminent()
                            }
                        } else { ContentUnavailableView.search(text: query) }
                    }
                }
                .refreshable { await store.refreshAll() }
            } else {
                ProgressView()
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("tab.dms"))
        .searchable(text: $query, prompt: L("dm.search"))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { newChat = true } label: { Label(L("dm.new"), systemImage: "square.and.pencil") }
                    .accessibilityIdentifier("dms.newChat")
            }
        }
        .sheet(isPresented: $newChat) { NewChatSheet(personOnly: true) }
        .sheet(item: Binding(get: { issuesFor.map(IdBox.init) }, set: { issuesFor = $0?.id })) { ConversationIssuesSheet(conversationId: $0.id) }
    }
}

// MARK: - Supervisión

/// «Supervisión de {empresa}»: los grupos donde participa mi gente, agrupados por espacio (owner/admin).
struct OversightView: View {
    @Environment(AppStore.self) private var store
    let orgId: String
    @State private var result: OversightDTO?
    @State private var error: String?

    var body: some View {
        let org = store.data.flatMap { Naming.org($0, orgId) }
        List {
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            if result == nil && error == nil { ProgressView().frame(maxWidth: .infinity) }
            if let r = result, r.groups.isEmpty { Text(L("ovs.empty")).foregroundStyle(Theme.textSecondary) }
            Section { Text(L("ovs.hint")).font(.footnote).foregroundStyle(Theme.textSecondary) }
            if let d = store.data, let r = result {
                ForEach(Self.byWorkspace(r.groups), id: \.0) { _, groups in
                    Section(groups.first?.workspaceName ?? "") {
                        ForEach(groups) { g in row(d, g) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("ovs.title", ["org": org?.name ?? ""]))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    /// Por espacio, en el orden en que llegan (última actividad primero).
    static func byWorkspace(_ list: [OversightGroupDTO]) -> [(String, [OversightGroupDTO])] {
        var order: [String] = []
        var map: [String: [OversightGroupDTO]] = [:]
        for g in list { if map[g.workspaceId] == nil { order.append(g.workspaceId) }; map[g.workspaceId, default: []].append(g) }
        return order.map { ($0, map[$0]!) }
    }

    private func row(_ d: BootstrapDTO, _ g: OversightGroupDTO) -> some View {
        let name = g.name ?? L("chat.aConversation")
        return Button {
            if g.iAmMember && store.meta(g.conversationId) != nil { store.push(.conversation(g.conversationId)) }
            else { store.push(.oversightReader(conversationId: g.conversationId, name: name)) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: g.kind == "internal" ? "lock.fill" : "number")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.accentText)
                    .frame(width: 30, height: 30)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.orange.opacity(0.12)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    HStack(spacing: 6) {
                        HStack(spacing: -6) {
                            ForEach(g.myOrgMemberIds.prefix(4), id: \.self) { id in
                                let p = Naming.person(d, id)
                                Avatar(person: p, org: Naming.org(d, p?.orgId), size: 20)
                                    .overlay(Circle().stroke(Theme.surface, lineWidth: 1.5))
                            }
                        }
                        Text(L("ovs.members", ["n": g.memberCount])).font(.caption2).foregroundStyle(Theme.textSecondary)
                        Text(L10n.timeLabel(g.lastMessageAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
                    }
                }
                Spacer(minLength: 4)
                if !g.iAmMember {
                    Text(L("ovs.readOnly")).font(.caption2.weight(.bold)).foregroundStyle(Theme.accentText)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(Theme.orange.opacity(0.14)))
                        .fixedSize()
                }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("ovs.group.\(g.conversationId)")
    }

    private func load() async {
        do { result = try await store.loadOversight(orgId: orgId); error = nil } catch { self.error = L10n.errorText(error) }
    }
}

/// Visor de solo lectura (supervisión): los mensajes de un grupo donde no soy miembro, sin compositor.
struct OversightReaderView: View {
    @Environment(AppStore.self) private var store
    let conversationId: String
    let name: String
    @State private var messages: [MessageDTO] = []
    @State private var hasMore = false
    @State private var loading = false
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            Label(L("ovs.banner"), systemImage: "eye")
                .font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentText)
                .frame(maxWidth: .infinity).padding(.vertical, 10).padding(.horizontal, 16)
                .background(Theme.orange.opacity(0.12))
                .accessibilityIdentifier("ovs.banner")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if hasMore {
                        Button(loading ? L("common.loading") : L("ovs.older")) { Task { await load(older: true) } }
                            .font(.footnote).frame(maxWidth: .infinity).disabled(loading)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                    if loaded && messages.isEmpty { Text(L("conv.noMessages")).font(.subheadline).foregroundStyle(Theme.textSecondary).frame(maxWidth: .infinity).padding(.top, 40) }
                    if let d = store.data { ForEach(messages) { m in row(d, m) } }
                }
                .padding(16)
            }
            .defaultScrollAnchor(.bottom)
            .overlay { if !loaded && error == nil { ProgressView() } }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load(older: false) }
    }

    @ViewBuilder private func row(_ d: BootstrapDTO, _ m: MessageDTO) -> some View {
        if m.isSystem {
            Text(L10n.systemText(m.body)).font(.caption).foregroundStyle(Theme.textSecondary).frame(maxWidth: .infinity)
        } else {
            let p = Naming.person(d, m.authorId)
            HStack(alignment: .top, spacing: 10) {
                Avatar(person: p, org: Naming.org(d, p?.orgId), size: 30)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(p?.name ?? L("common.participant")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                        if let o = Naming.org(d, p?.orgId) { Text(o.name).font(.caption2).foregroundStyle(Theme.textSecondary) }
                        Text(L10n.timeLabel(m.createdAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
                    }
                    Text(m.deletedAt != nil ? L("chat.deleted") : m.body).font(.subheadline).foregroundStyle(m.deletedAt != nil ? Theme.textSecondary : Theme.textPrimary)
                        .textSelection(.enabled)
                    if !m.attachments.isEmpty {
                        Label(m.attachments.map(\.name).joined(separator: ", "), systemImage: "paperclip").font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(2)
                    }
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func load(older: Bool) async {
        guard !loading else { return }
        loading = true
        defer { loading = false; loaded = true }
        do {
            let page = try await store.readOnlyMessages(conversationId, before: older ? messages.first?.seq : nil)
            let known = Set(messages.map(\.id))
            messages = (page.messages.filter { !known.contains($0.id) } + (older ? messages : [])).sorted { $0.seq < $1.seq }
            hasMore = page.hasMore
            error = nil
        } catch { self.error = L10n.errorText(error) }
    }
}

// MARK: - Ícono de «Tú»

/// Mi foto (o mis iniciales) en círculo como ícono de la pestaña «Tú», como el perfil de Instagram.
enum TabAvatar {
    static func image(name: String, photo: UIImage?, fill: UIColor, selected: Bool, side: CGFloat = 26) -> UIImage {
        let size = CGSize(width: side, height: side)
        let img = UIGraphicsImageRenderer(size: size).image { _ in
            let rect = CGRect(origin: .zero, size: size)
            if selected {
                UIColor.label.setStroke()
                let ring = UIBezierPath(ovalIn: rect.insetBy(dx: 0.75, dy: 0.75))
                ring.lineWidth = 1.5
                ring.stroke()
            }
            let inner = rect.insetBy(dx: selected ? 3 : 1, dy: selected ? 3 : 1)
            UIBezierPath(ovalIn: inner).addClip()
            if let photo, photo.size.width > 0, photo.size.height > 0 {
                let scale = max(inner.width / photo.size.width, inner.height / photo.size.height)
                let w = photo.size.width * scale, h = photo.size.height * scale
                photo.draw(in: CGRect(x: inner.midX - w / 2, y: inner.midY - h / 2, width: w, height: h))
            } else {
                fill.setFill()
                UIRectFill(inner)
                let text = Naming.initials(name) as NSString
                let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: inner.height * 0.4, weight: .semibold), .foregroundColor: UIColor.white]
                let t = text.size(withAttributes: attrs)
                text.draw(at: CGPoint(x: inner.midX - t.width / 2, y: inner.midY - t.height / 2), withAttributes: attrs)
            }
        }
        return img.withRenderingMode(.alwaysOriginal)
    }
}
