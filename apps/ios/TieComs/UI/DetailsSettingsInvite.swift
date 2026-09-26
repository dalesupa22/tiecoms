import SwiftUI
import UserNotifications

struct ConversationDetailsView: View {
    @Environment(AppStore.self) private var store
    /// Foto del grupo: grupos/internos con canManage o cualquier miembro de un chat grupal; nunca directos.
    static func canChangePhoto(_ c: ConversationDTO) -> Bool {
        switch c.kind { case .direct: return false; case .multi: return true; default: return c.canManage }
    }
    let conversationId: String
    @State private var adding = false
    @State private var confirmLeave = false
    @State private var choosePhoto = false
    @State private var confirmRemovePhoto = false
    @State private var inviting = false

    var body: some View {
        Group {
            if let d = store.data, let c = store.meta(conversationId) {
                let members = c.memberIds.compactMap { Naming.person(d, $0) }
                let regular = members.filter { !$0.guest }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
                let guests = members.filter(\.guest)
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 10) {
                                ConvIcon(d: d, c: c, size: 56)
                                if c.kind == .internal { Image(systemName: "lock.fill") }
                                Text(Naming.title(d, c)).font(.title3.weight(.semibold))
                            }
                            if let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) {
                                Text("\(L("chat.space")): \(ws.name)").font(.subheadline).foregroundStyle(Theme.textSecondary)
                            }
                            if c.kind == .multi {
                                let orgs = Naming.companies(d, c)
                                HStack(spacing: 6) {
                                    HStack(spacing: -4) { ForEach(orgs.prefix(5)) { OrgMark(org: $0, size: 20) } }
                                    Text(Naming.subtitle(d, c)).font(.subheadline).foregroundStyle(Theme.textSecondary)
                                }
                            }
                            if c.kind != .direct {
                                Text(c.kind == .internal
                                     ? L("chat.scopeInternal", ["org": Naming.org(d, c.internalOrgId)?.name ?? ""])
                                     : c.kind == .multi ? L("chat.scopeMulti") : L("chat.scopeGroup"))
                                    .font(.footnote).foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                    if Self.canChangePhoto(c) {
                        Section {
                            Button { choosePhoto = true } label: { Label(c.avatarUrl == nil ? L("group.addPhoto") : L("group.changePhoto"), systemImage: "camera") }
                                .accessibilityIdentifier("details.changePhoto")
                            if c.avatarUrl != nil {
                                Button(role: .destructive) { confirmRemovePhoto = true } label: { Label(L("group.removePhoto"), systemImage: "trash") }
                            }
                        }
                    }
                    if c.kind == .group || c.kind == .internal {
                        Section {
                            if !Naming.isGuest(d, c) && c.workspaceId != nil {
                                Button { inviting = true } label: { Label(L("grp.inviteToGroup"), systemImage: "person.badge.plus") }
                                    .accessibilityIdentifier("details.inviteGroup")
                            }
                        } footer: { Text(L("grp.adminsCanRead")).accessibilityIdentifier("details.oversightNote") }
                    }
                    ConversationAgendaSection(conversationId: c.id)
                    Section(L("details.participants", ["n": regular.count])) {
                        if c.kind == .multi {
                            Button { adding = true } label: { Label(L("dlg.addToGroup"), systemImage: "person.badge.plus") }
                                .accessibilityIdentifier("details.addPeople")
                        }
                        ForEach(regular) { p in PersonRow(d: d, p: p, isMe: p.id == d.me.id) }
                    }
                    if !guests.isEmpty {
                        Section(L("common.guests")) {
                            ForEach(guests) { p in PersonRow(d: d, p: p, isMe: p.id == d.me.id) }
                        }
                    }
                    if c.kind == .multi {
                        Section {
                            Button(L("chat.leave"), role: .destructive) { confirmLeave = true }
                                .accessibilityIdentifier("details.leave")
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .sheet(isPresented: $adding) { AddMembersSheet(conversationId: c.id) }
                .sheet(isPresented: $inviting) { InviteSheet(target: .group(c.id)) }
                .confirmationDialog(L("chat.leaveConfirm"), isPresented: $confirmLeave, titleVisibility: .visible) {
                    Button(L("chat.leave"), role: .destructive) {
                        Task { do { try await store.leaveConversation(c.id) } catch { store.show(L10n.errorText(error)) } }
                    }
                    Button(L("common.cancel"), role: .cancel) {}
                }
                .scrollContentBackground(.hidden)
            } else {
                ContentUnavailableView(L("chat.notFound"), systemImage: "lock.slash")
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("chat.details"))
        .photoChangeFlow(isPresented: $choosePhoto, title: L("photo.cropGroupTitle"),
                         onSave: { jpeg in try await store.uploadConversationAvatar(conversationId, jpeg: jpeg) },
                         onSaved: { store.show(L("group.photoSaved")) })
        .confirmationDialog(L("group.removeConfirm"), isPresented: $confirmRemovePhoto, titleVisibility: .visible) {
            Button(L("group.removePhoto"), role: .destructive) {
                Task { do { try await store.removeConversationAvatar(conversationId); store.show(L("group.photoRemoved")) } catch { store.show(L10n.errorText(error)) } }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Próximas reuniones de la conversación (panel de detalles).
struct ConversationAgendaSection: View {
    @Environment(AppStore.self) private var store
    let conversationId: String
    var body: some View {
        let list = store.events.values.filter { $0.conversationId == conversationId && !$0.isCancelled && $0.end > Date() }
            .sorted { $0.startsAt < $1.startsAt }.prefix(5)
        Section("\(L("cal.upcoming")) · \(list.count)") {
            if list.isEmpty { Text(L("cal.noUpcoming")).foregroundStyle(Theme.textSecondary) }
            ForEach(Array(list)) { e in NavigationLink(value: Route.event(e.id)) { EventRow(event: e, showConv: false) } }
        }
    }
}

private struct PersonRow: View {
    @Environment(AppStore.self) private var store
    private func message() {
        Task {
            do { let r = try await store.createChat(userIds: [p.id], name: nil); store.navigate(to: .conversation(r.id)) }
            catch { store.show(L10n.errorText(error)) }
        }
    }
    @State private var report = false
    @State private var confirmBlock = false
    var d: BootstrapDTO
    var p: PersonDTO
    var isMe: Bool

    var body: some View {
        let org = Naming.org(d, p.orgId)
        HStack(spacing: 12) {
            Avatar(person: p, org: org, size: 38, badge: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(p.name + (isMe ? " " + L("common.you") : "")).font(.body)
                let line = [p.title, p.area, org?.name ?? (p.guest ? L("common.guest") : L("common.noCompany"))].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                Text(line).font(.subheadline).foregroundStyle(Theme.textSecondary)
                if p.guest {
                    Text(p.guestUntil != nil ? L("chat.guestUntil", ["date": L10n.shortDate(p.guestUntil)]) : L("common.guest"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.accentText)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Theme.orange.opacity(0.14)))
                }
            }
            Spacer(minLength: 4)
            if !isMe && p.kind == "human" && !store.blockedUserIds.contains(p.id) {
                Button { message() } label: { Image(systemName: "message").font(.body.weight(.semibold)) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("\(L("people.sendMessage")), \(p.name)")
                    .accessibilityIdentifier("person.message.\(p.id)")
            }
        }
        .accessibilityElement(children: .contain)
        .contextMenu {
            if !isMe && p.kind == "human" {
                Button { message() } label: { Label(L("people.sendMessage"), systemImage: "message") }
            }
            if !isMe {
                Button { report = true } label: { Label(L("safety.reportUser"), systemImage: "flag") }
                Button(role: .destructive) { confirmBlock = true } label: {
                    Label(L(store.blockedUserIds.contains(p.id) ? "safety.unblock" : "safety.block"), systemImage: "person.slash")
                }
            }
        }
        .sheet(isPresented: $report) { ReportContentSheet(userId: p.id) }
        .confirmationDialog(L(store.blockedUserIds.contains(p.id) ? "safety.unblock" : "safety.blockConfirm"), isPresented: $confirmBlock, titleVisibility: .visible) {
            Button(L(store.blockedUserIds.contains(p.id) ? "safety.unblock" : "safety.block"), role: .destructive) {
                Task {
                    do { try await store.setUserBlocked(p.id, blocked: !store.blockedUserIds.contains(p.id)) }
                    catch { store.show(L10n.errorText(error)) }
                }
            }
            Button(L("common.cancel"), role: .cancel) {}
        } message: { Text(L("safety.blockHint")) }
    }
}

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var sounds = Prefs.soundsEnabled
    @State private var notifications = Prefs.notificationsEnabled
    @State private var systemDenied = false
    @State private var confirmLogout = false
    @State private var joining = false

    var body: some View {
        List {
            if let d = store.data {
                Section(L("settings.title")) {
                    let me = Naming.person(d, d.me.id)
                    let org = Naming.org(d, d.me.primaryOrgId)
                    HStack(spacing: 12) {
                        Avatar(name: d.me.name, org: org, size: 56, photo: me?.avatarUrl ?? d.me.avatarUrl)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.me.name).font(.headline)
                            if let email = d.me.email { Text(email).font(.subheadline).foregroundStyle(Theme.textSecondary) }
                            let line = [me?.title ?? d.me.title, me?.area ?? d.me.area, org?.name].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                            if !line.isEmpty { Text(line).font(.subheadline).foregroundStyle(Theme.textSecondary) }
                        }
                    }
                    .accessibilityElement(children: .combine)
                    NavigationLink(value: Route.profile) { Label(L("profile.edit"), systemImage: "person.crop.circle") }
                        .accessibilityIdentifier("settings.editProfile")
                }
                Section {
                    Button { joining = true } label: { Label(L("join.title"), systemImage: "ticket") }
                        .accessibilityIdentifier("you.joinCode")
                    // Supervisión: una por cada empresa donde soy owner/admin.
                    ForEach(d.organizations.filter(\.canAdmin)) { org in
                        NavigationLink(value: Route.oversight(org.id)) { Label(L("ovs.title", ["org": org.name]), systemImage: "eye") }
                            .accessibilityIdentifier("you.oversight.\(org.id)")
                    }
                } footer: { Text(L("join.youHint")) }
            }
            Section {
                Toggle(L("settings.sounds"), isOn: $sounds)
                    .onChange(of: sounds) { _, v in Prefs.soundsEnabled = v }
                    .accessibilityIdentifier("settings.sounds")
                Toggle(L("settings.notifications"), isOn: $notifications)
                    .onChange(of: notifications) { _, v in
                        let update = store.setNotificationsEnabled(v)
                        Task { await update.value; await checkSystem() }
                    }
                    .accessibilityIdentifier("settings.notifications")
                if systemDenied && notifications {
                    Button(L("settings.openSystem")) {
                        if let u = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(u) }
                    }
                }
            } header: { Text(L("settings.alerts")) } footer: { Text(L("settings.soundsHint")) }
            if let d = store.data, let org = Naming.org(d, d.me.primaryOrgId) {
                Section(L("settings.team")) {
                    HStack(spacing: 10) {
                        OrgMark(org: org, size: 28)
                        Text(org.name)
                        if org.verification != "none" { Image(systemName: "checkmark.seal.fill").foregroundStyle(.green).accessibilityLabel(L("dom.verified")) }
                    }
                    if org.canAdmin {
                        NavigationLink(value: Route.domains(org.id)) { Label(L("dom.title"), systemImage: "globe") }
                            .accessibilityIdentifier("settings.domains")
                    }
                }
            }
            Section {
                NavigationLink(value: Route.files) { Label(L("nav.files"), systemImage: "folder") }
                    .accessibilityIdentifier("settings.files")
                NavigationLink(value: Route.whatsapp) { Label(L("settings.whatsapp"), systemImage: "message") }
                NavigationLink(value: Route.reminders) { Label(L("rem.title"), systemImage: "alarm") }
                NavigationLink(value: Route.trazo) { Label(L("nav.trazo"), systemImage: "arrow.triangle.branch") }
            } footer: { Text(L("settings.whatsappHint")) }
            Section(L("safety.title")) {
                NavigationLink { BlockedUsersView() } label: { Label(L("safety.blockedUsers"), systemImage: "person.slash") }
                    .accessibilityIdentifier("settings.blockedUsers")
                Link(L("safety.support"), destination: URL(string: L10n.lang == "es" ? "https://www.tiecoms.com/soporte/" : "https://www.tiecoms.com/en/support/")!)
                Link(L("safety.terms"), destination: URL(string: L10n.lang == "es" ? "https://www.tiecoms.com/terminos/" : "https://www.tiecoms.com/en/terms/")!)
                Link(L("safety.privacy"), destination: URL(string: L10n.lang == "es" ? "https://www.tiecoms.com/privacidad/" : "https://www.tiecoms.com/en/privacy/")!)
            }
            Section {
                LabeledContent(L("settings.language"), value: L10n.lang == "es" ? "Español" : "English")
            } footer: { Text(L("settings.languageHint")) }
            Section {
                Button(L("settings.logout"), role: .destructive) { confirmLogout = true }
                    .accessibilityIdentifier("settings.logout")
                NavigationLink(value: Route.deleteAccount) { Text(L("del.title")).foregroundStyle(.red) }
                    .accessibilityIdentifier("settings.deleteAccount")
            }
            Section {
                LabeledContent(L("settings.version"), value: AppConfig.appVersion)
                #if DEBUG
                LabeledContent(L("debug.server"), value: store.api.baseURL.absoluteString)
                #endif
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("tab.you"))
        .task { await checkSystem() }
        .sheet(isPresented: $joining) { JoinWithCodeSheet() }
        .confirmationDialog(L("settings.logoutConfirm"), isPresented: $confirmLogout, titleVisibility: .visible) {
            Button(L("settings.logout"), role: .destructive) { Task { await store.logout() } }
            Button(L("common.cancel"), role: .cancel) {}
        }
    }

    private func checkSystem() async {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        systemDenied = s.authorizationStatus == .denied
    }
}

/// Invitación a un espacio: vista previa pública y "Unirme".
struct InviteView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let token: String
    @State private var inv: InvitationPreviewDTO?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack { Spacer(); LogoView(width: 150); Spacer() }
                    if let error { ErrorBanner(text: error) }
                    if inv == nil && error == nil { ProgressView().frame(maxWidth: .infinity).accessibilityLabel(L("common.loading")) }
                    if let inv {
                        Text(L("invite.title")).font(.caption.weight(.semibold)).foregroundStyle(Theme.accentText).textCase(.uppercase)
                        Text(inv.workspaceName).font(.largeTitle.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                        Text(L("invite.by", ["name": inv.invitedByName, "org": inv.invitedByOrg.isEmpty ? "" : " · \(inv.invitedByOrg)", "role": L("role.\(inv.role)")]))
                            .foregroundStyle(Theme.textSecondary)
                        if !inv.groupNames.isEmpty {
                            Label(inv.groupNames.joined(separator: ", "), systemImage: "number")
                                .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                                .accessibilityLabel(L("invite.groups", ["groups": inv.groupNames.joined(separator: ", ")]))
                                .accessibilityIdentifier("invite.groups")
                        }
                        if inv.role == "guest" { Text(L("join.asGuest")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                        if let email = inv.email { Text(L("invite.forEmail", ["email": email])).font(.footnote).foregroundStyle(Theme.textSecondary) }
                        if !inv.valid {
                            ErrorBanner(text: L("invite.invalid"))
                        } else if store.status == .ready {
                            Text(L("invite.as", ["name": store.me?.name ?? ""])).font(.footnote).foregroundStyle(Theme.textSecondary)
                            Button(action: accept) { Text(busy ? L("invite.accepting") : L("invite.join")) }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(busy)
                                .accessibilityIdentifier("invite.accept")
                        } else {
                            Text(L("invite.loginFirst")).font(.footnote).foregroundStyle(Theme.textSecondary)
                            Button(L("auth.createAccount")) { dismissForAuth(signup: true) }
                                .buttonStyle(PrimaryButtonStyle())
                            Button(L("invite.have")) { dismissForAuth(signup: false) }
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                    }
                }
                .padding(20)
            }
            .background(Theme.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } }
            }
        }
        .task(id: token) {
            do { inv = try await store.previewInvitation(token) } catch { self.error = L10n.errorText(error) }
        }
    }

    private func accept() {
        busy = true
        Task {
            do { try await store.acceptInvitation(token) } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }

    /// Sin sesión: se entra o se crea la cuenta y luego se vuelve a la invitación.
    private func dismissForAuth(signup: Bool) {
        store.rememberAfterLogin(.invite(token))
        store.inviteToken = nil
        if signup { store.signupOrgToken = nil; store.showSignup = true } else { store.showSignup = false }
    }
}
