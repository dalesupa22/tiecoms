import SwiftUI
import UserNotifications

struct ConversationDetailsView: View {
    @Environment(AppStore.self) private var store
    let conversationId: String

    var body: some View {
        Group {
            if let d = store.data, let c = store.meta(conversationId) {
                let members = c.memberIds.compactMap { Naming.person(d, $0) }
                let regular = members.filter { !$0.guest }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
                let guests = members.filter(\.guest)
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                if c.kind == .internal { Image(systemName: "lock.fill") }
                                Text(Naming.title(d, c)).font(.title3.weight(.semibold))
                            }
                            if let ws = d.workspaces.first(where: { $0.id == c.workspaceId }) {
                                Text("\(L("chat.space")): \(ws.name)").font(.subheadline).foregroundStyle(Theme.textSecondary)
                            }
                            Text(c.kind == .internal
                                 ? L("chat.scopeInternal", ["org": Naming.org(d, c.internalOrgId)?.name ?? ""])
                                 : L("chat.scopeGroup"))
                                .font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                    Section(L("details.participants", ["n": regular.count])) {
                        ForEach(regular) { p in PersonRow(d: d, p: p, isMe: p.id == d.me.id) }
                    }
                    if !guests.isEmpty {
                        Section(L("common.guests")) {
                            ForEach(guests) { p in PersonRow(d: d, p: p, isMe: p.id == d.me.id) }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
            } else {
                ContentUnavailableView(L("chat.notFound"), systemImage: "lock.slash")
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("chat.details"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PersonRow: View {
    var d: BootstrapDTO
    var p: PersonDTO
    var isMe: Bool

    var body: some View {
        let org = Naming.org(d, p.orgId)
        HStack(spacing: 12) {
            Avatar(name: p.name, org: org, isAgent: p.kind == "agent", size: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(p.name + (isMe ? " " + L("common.you") : "")).font(.body)
                let line = [p.title, org?.name ?? (p.guest ? L("common.guest") : L("common.noCompany"))].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                Text(line).font(.subheadline).foregroundStyle(Theme.textSecondary)
                if p.guest {
                    Text(p.guestUntil != nil ? L("chat.guestUntil", ["date": L10n.shortDate(p.guestUntil)]) : L("common.guest"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.accentText)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Theme.orange.opacity(0.14)))
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var sounds = Prefs.soundsEnabled
    @State private var notifications = Prefs.notificationsEnabled
    @State private var systemDenied = false
    @State private var confirmLogout = false

    var body: some View {
        List {
            if let d = store.data {
                Section(L("settings.title")) {
                    let me = Naming.person(d, d.me.id)
                    let org = Naming.org(d, d.me.primaryOrgId)
                    HStack(spacing: 12) {
                        Avatar(name: d.me.name, org: org, size: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.me.name).font(.headline)
                            if let email = d.me.email { Text(email).font(.subheadline).foregroundStyle(Theme.textSecondary) }
                            let line = [me?.title ?? d.me.title, org?.name].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                            if !line.isEmpty { Text(line).font(.subheadline).foregroundStyle(Theme.textSecondary) }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Section {
                Toggle(L("settings.sounds"), isOn: $sounds)
                    .onChange(of: sounds) { _, v in Prefs.soundsEnabled = v }
                    .accessibilityIdentifier("settings.sounds")
                Toggle(L("settings.notifications"), isOn: $notifications)
                    .onChange(of: notifications) { _, v in
                        Prefs.notificationsEnabled = v
                        if v { Task { await AppFeedback.shared.requestAuthorizationIfNeeded(); await checkSystem() } }
                    }
                    .accessibilityIdentifier("settings.notifications")
                if systemDenied && notifications {
                    Button(L("settings.openSystem")) {
                        if let u = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(u) }
                    }
                }
            } header: { Text(L("settings.alerts")) } footer: { Text(L("settings.soundsHint")) }
            Section {
                LabeledContent(L("settings.language"), value: L10n.lang == "es" ? "Español" : "English")
            } footer: { Text(L("settings.languageHint")) }
            Section {
                Button(L("settings.logout"), role: .destructive) { confirmLogout = true }
                    .accessibilityIdentifier("settings.logout")
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
        .navigationTitle(L("settings.nav"))
        .task { await checkSystem() }
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
