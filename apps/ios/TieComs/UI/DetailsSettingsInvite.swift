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
                    MuteSection(conv: c)
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
                            // «Agregar al grupo»: sumar a alguien del espacio o invitar por correo o enlace (SPEC-invitar).
                            if c.workspaceId != nil && (c.canManage || !Naming.isGuest(d, c)) {
                                Button { adding = true } label: { Label(L("dlg.addToGroup"), systemImage: "person.badge.plus") }
                                    .accessibilityIdentifier("details.addPeople")
                            }
                        } footer: { Text(L("grp.adminsCanRead")).accessibilityIdentifier("details.oversightNote") }
                    }
                    ConversationAgendaSection(conversationId: c.id)
                    Section(L("details.participants", ["n": regular.count])) {
                        if c.kind == .multi {
                            Button { adding = true } label: { Label(L("dlg.addToGroup"), systemImage: "person.badge.plus") }
                                .accessibilityIdentifier("details.addPeople")
                        }
                        ForEach(regular) { p in PersonRow(d: d, p: p, isMe: p.id == d.me.id, conv: c) }
                    }
                    if !guests.isEmpty {
                        Section(L("common.guests")) {
                            ForEach(guests) { p in PersonRow(d: d, p: p, isMe: p.id == d.me.id, conv: c) }
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

/// Detalles del chat: interruptor «Silenciar» con el tiempo restante (SPEC-silencio §2). Al encenderlo se elige cuánto.
struct MuteSection: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    @State private var choosing = false

    var body: some View {
        let muted = conv.isMuted
        Section {
            Toggle(isOn: Binding(get: { muted || choosing }, set: { on in
                if on { choosing = true } else { set(nil) }
            })) {
                HStack(spacing: 12) {
                    Image(systemName: muted ? "bell.slash.fill" : "bell.slash").foregroundStyle(Theme.accentText)
                        .frame(width: 28).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("menu.mute"))
                        if muted, let until = ISODate.parse(conv.mutedUntil) {
                            Text(Silence.text(.muted, until: until)).font(.footnote).foregroundStyle(Theme.textSecondary)
                                .accessibilityIdentifier("details.muteState")
                        }
                    }
                }
            }
            .accessibilityIdentifier("details.mute")
            .confirmationDialog(L("menu.mute"), isPresented: $choosing, titleVisibility: .visible) {
                ForEach(MuteOption.allCases, id: \.self) { o in
                    Button(L(o.labelKey)) { set(AppStore.muteUntil(o)) }.accessibilityIdentifier("details.mute.\(o.id)")
                }
                Button(L("common.cancel"), role: .cancel) {}
            }
        } footer: { Text(L("mute.hint")) }
    }

    private func set(_ until: Date?) {
        choosing = false
        Task {
            do {
                try await store.setConversationPrefs(conv.id, mutedUntil: .some(until))
                store.show(L(until == nil ? "toast.unmuted" : "toast.muted"))
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// Opciones de «No molestar» (fila de Tú, franja de las listas).
struct DndOptions: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        if store.dndActive {
            Button { Task { await store.setDoNotDisturb(until: nil) } } label: { Label(L("dnd.off"), systemImage: "bell") }
                .accessibilityIdentifier("dnd.off")
            Divider()
        }
        ForEach(DndOption.allCases, id: \.self) { o in
            Button(L(o.labelKey)) { Task { await store.setDoNotDisturb(until: Silence.dndUntil(o)) } }
                .accessibilityIdentifier("dnd.opt.\(o.id)")
        }
        // «Todas las noches» va dentro de «No molestar», con desde y hasta.
        Divider()
        Button { store.showSleepSettings = true } label: {
            Label("\(L("sleep.title")) · \(SleepRules.summary(store.data?.me.sleep))", systemImage: "moon.stars")
        }
        .accessibilityIdentifier("dnd.opt.sleep")
    }
}

/// Tú › «No molestar»: el estado («Activo hasta las 18:00») y las opciones en un menú.
struct DndRow: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        let until = store.dndUntil
        Menu { DndOptions() } label: {
            HStack(spacing: 12) {
                Image(systemName: until != nil ? "moon.fill" : "moon").foregroundStyle(until != nil ? Theme.accentText : Theme.textPrimary)
                    .frame(width: 28).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("dnd.title")).foregroundStyle(Theme.textPrimary)
                    Text(until.map { Silence.text(.dndStatus, until: $0) } ?? L("dnd.offState"))
                        .font(.footnote).foregroundStyle(until != nil ? Theme.accentText : Theme.textSecondary)
                        .accessibilityIdentifier("settings.dnd.state")
                }
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Theme.textSecondary).accessibilityHidden(true)
            }
        }
        .accessibilityIdentifier("settings.dnd")
    }
}

/// Franja fina arriba de Grupos y DMs mientras «No molestar» está activo: «🌙 No molestar hasta las 18:00 · Reactivar».
struct DndBanner: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        if let until = store.dndUntil {
            HStack(spacing: 6) {
                Image(systemName: "moon.fill").font(.caption).foregroundStyle(Theme.accentText).accessibilityHidden(true)
                Text(Silence.text(.dndBanner, until: until)).font(.footnote).foregroundStyle(Theme.textSecondary).lineLimit(1)
                Text("·").font(.footnote).foregroundStyle(Theme.textSecondary).accessibilityHidden(true)
                Button(L("dnd.off")) { Task { await store.setDoNotDisturb(until: nil) } }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("dnd.banner.off")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Capsule().fill(Theme.orange.opacity(0.10)))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("dnd.banner")
        }
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
    /// Acción de admin pendiente de confirmar (docs/ADMINS-INTEGRACIONES.md §1).
    @State private var pendingAction: GroupMemberAction?
    var d: BootstrapDTO
    var p: PersonDTO
    var isMe: Bool
    /// Grupo del que se muestran los participantes: etiquetas «Admin»/«Bot» y menú de admin.
    var conv: ConversationDTO? = nil

    private func run(_ a: GroupMemberAction) {
        guard let conv else { return }
        Task {
            do {
                try await store.perform(a, conversationId: conv.id, userId: p.id)
                store.show(L("admin.done.\(a.rawValue)", ["name": p.name]))
            } catch { store.show(L10n.errorText(error)) }
        }
    }

    var body: some View {
        let org = Naming.org(d, p.orgId)
        let adminActions = conv.map { GroupAdmins.actions($0, person: p, me: d.me.id) } ?? []
        HStack(spacing: 12) {
            Avatar(person: p, org: org, size: 38, badge: true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(p.name + (isMe ? " " + L("common.you") : "")).font(.body)
                    if let conv, let key = GroupAdmins.badgeKey(conv, person: p) {
                        Text(L(key))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.accentText)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(Theme.orange.opacity(0.14)))
                            .accessibilityIdentifier("person.badge.\(p.id)")
                    }
                }
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
            if !adminActions.isEmpty {
                Section {
                    ForEach(adminActions) { a in
                        Button(role: a.isDestructive ? .destructive : nil) { pendingAction = a } label: {
                            Label(L(a.labelKey), systemImage: a.systemImage)
                        }
                        .accessibilityIdentifier("person.\(a.rawValue).\(p.id)")
                    }
                }
            }
            if !isMe {
                Button { report = true } label: { Label(L("safety.reportUser"), systemImage: "flag") }
                Button(role: .destructive) { confirmBlock = true } label: {
                    Label(L(store.blockedUserIds.contains(p.id) ? "safety.unblock" : "safety.block"), systemImage: "person.slash")
                }
            }
        }
        .sheet(isPresented: $report) { ReportContentSheet(userId: p.id) }
        .confirmationDialog(pendingAction.map { L($0.confirmKey, ["name": p.name]) } ?? "",
                            isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } }),
                            titleVisibility: .visible, presenting: pendingAction) { a in
            Button(L(a.labelKey), role: a.isDestructive ? .destructive : nil) { run(a) }
                .accessibilityIdentifier("person.confirm.\(a.rawValue)")
            Button(L("common.cancel"), role: .cancel) {}
        }
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
                    NavigationLink(value: Route.signed) { Label(L("signed.title"), systemImage: "signature") }
                        .accessibilityIdentifier("settings.signed")
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
            // Conexiones para crear reuniones reales de Meet, Teams o Zoom (1.6.6).
            if store.data != nil { MeetingsSettingsSection() }
            Section {
                DndRow()
                SleepRow()
            } footer: {
                Text(store.dndLocalOnly && store.dndActive ? L("dnd.hint") + " " + L("dnd.localOnlyIos") : L("dnd.hint"))
                    .accessibilityIdentifier("settings.dnd.footer")
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
                NavigationLink(value: Route.scheduled) {
                    Label(L("nav.scheduled") + (store.scheduled.isEmpty ? "" : " · \(store.scheduled.count)"), systemImage: "clock")
                }
                .accessibilityIdentifier("settings.scheduled")
                NavigationLink(value: Route.trazo) { Label(L("nav.trazo"), systemImage: "arrow.triangle.branch") }
            } footer: { Text(L("settings.whatsappHint")) }
            Section(L("safety.title")) {
                NavigationLink { BlockedUsersView() } label: { Label(L("safety.blockedUsers"), systemImage: "person.slash") }
                    .accessibilityIdentifier("settings.blockedUsers")
                Link(L("safety.support"), destination: URL(string: L10n.lang == "es" ? AppConfig.website + "/soporte/" : AppConfig.website + "/en/support/")!)
                Link(L("safety.terms"), destination: URL(string: L10n.lang == "es" ? AppConfig.website + "/terminos/" : AppConfig.website + "/en/terms/")!)
                Link(L("safety.privacy"), destination: URL(string: L10n.lang == "es" ? AppConfig.website + "/privacidad/" : AppConfig.website + "/en/privacy/")!)
            }
            TextSizeSection()
            Section {
                Picker(selection: Binding(get: { L10n.choice }, set: { store.setLanguage($0) })) {
                    Text(L("settings.langSystem")).tag(L10n.Choice.system)
                    // Cada idioma con su propio nombre, para encontrarlo aunque no se entienda el actual.
                    Text("Español").tag(L10n.Choice.es)
                    Text("English").tag(L10n.Choice.en)
                } label: {
                    Label(L("settings.languageBoth"), systemImage: "globe")
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("settings.language")
            } footer: { Text(L("settings.languageHintApp")) }
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

/// «Tamaño del texto»: cinco pasos (A pequeña ··· A grande) con vista previa en vivo; toda la app cambia al instante.
struct TextSizeSection: View {
    @AppStorage(TextSize.key) private var raw = TextSize.normal.rawValue

    var body: some View {
        let size = TextSize(rawValue: raw) ?? .normal
        Section {
            HStack(spacing: 12) {
                Text("A").font(.footnote.weight(.semibold)).accessibilityHidden(true)
                Slider(value: Binding(get: { Double(raw) }, set: { v in
                    let next = TextSize(rawValue: Int(v.rounded())) ?? .normal
                    if next.rawValue != raw { Haptics.tap() }
                    TextSize.save(next)
                    raw = next.rawValue
                }), in: 0...Double(TextSize.allCases.count - 1), step: 1)
                .tint(Theme.accentText)
                .accessibilityLabel(L("textSize.title"))
                .accessibilityValue(L(size.labelKey))
                .accessibilityIdentifier("settings.textSize")
                Text("A").font(.title.weight(.semibold)).accessibilityHidden(true)
            }
            .frame(minHeight: 44)
            // Vista previa: una fila como las de Grupos.
            HStack(spacing: 10) {
                Text("#").font(.headline.weight(.bold)).foregroundStyle(Theme.accentText)
                    .frame(width: 36, height: 36).background(RoundedRectangle(cornerRadius: 9).fill(Theme.orange.opacity(0.12)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("textSize.previewTitle")).font(.body.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                    Text(L("textSize.previewBody")).font(.subheadline).foregroundStyle(Theme.textSecondary)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings.textSize.preview")
        } header: {
            HStack {
                Text(L("textSize.title"))
                Spacer()
                Text(L(size.labelKey)).textCase(nil).accessibilityIdentifier("settings.textSize.value")
            }
        } footer: { Text(L("textSize.hint")) }
    }
}
