import SwiftUI
import UIKit

// MARK: - Agregar al grupo (con invitar)

/// «Agregar al grupo» (SPEC-invitar): buscador «Nombre o correo», candidatos con casilla y «Ven solo lo nuevo / Ven el
/// historial», «Invitar a {correo}» si lo escrito es un correo, y abajo «Invitar a alguien nuevo» (tipo de persona,
/// Invitar por correo, Copiar enlace, Compartir…) con las invitaciones pendientes del grupo.
/// En chats grupales y laterales solo se suman personas (no hay espacio al que invitar).
struct AddMembersSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    @State private var picked: [String] = []
    @State private var query = ""
    @State private var history = "now"
    @State private var busy = false
    @State private var error: String?
    @State private var kind: InviteKind?
    /// «Invitar por correo»: el buscador pide el correo.
    @State private var askEmail = false
    @FocusState private var searchFocused: Bool
    @State private var sending = false
    /// Correos ya invitados en esta hoja: su fila queda como «Pendiente».
    @State private var sent: [String] = []
    @State private var link: InviteLink?
    @State private var linkBusy = false
    @State private var shareText: ShareText?
    @State private var pending: [PendingInvitationDTO] = []
    @State private var pendingOpen = false

    struct ShareText: Identifiable { var text: String; var id: String { text } }

    var body: some View {
        NavigationStack {
            if let d = store.data, let c = store.meta(conversationId) {
                content(d, c)
                    .navigationTitle(L("dlg.addToGroup"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                        ToolbarItem(placement: .confirmationAction) {
                            if !c.canManage { EmptyView() } else if busy { ProgressView() } else {
                                Button(picked.isEmpty ? L("dlg.add") : L("addinv.add", ["n": picked.count]), action: add)
                                    .disabled(picked.isEmpty)
                                    .accessibilityIdentifier("addMembers.submit")
                            }
                        }
                    }
                    .onAppear { if kind == nil { kind = AddInvite.defaultKind(d, c) } }
                    .task { await loadPending(d, c) }
                    .sheet(item: $shareText) { s in ActivityView(items: [s.text]).presentationDetents([.medium, .large]) }
            } else {
                ContentUnavailableView(L("chat.notFound"), systemImage: "lock.slash")
            }
        }
    }

    @ViewBuilder
    private func content(_ d: BootstrapDTO, _ c: ConversationDTO) -> some View {
        // Sin permiso para administrar el grupo no se suman personas; se puede invitar igual.
        let people = c.canManage ? AddInvite.candidates(d, c, query: query) : []
        let email = AddInvite.email(query)
        let canInvite = AddInvite.supportsInvite(d, c)
        let chips = AddInvite.chips(d, c)
        Form {
            Section {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Theme.textSecondary).accessibilityHidden(true)
                    TextField(askEmail ? L("addinv.typeEmail") : L("addinv.search"), text: $query)
                        .focused($searchFocused)
                        .keyboardType(askEmail ? .emailAddress : .default)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(email != nil ? .send : .search)
                        .onSubmit { if let email, canInvite, !chips.isEmpty { sendInvite(d, c, email) } }
                        .accessibilityLabel(L("addinv.search"))
                        .accessibilityIdentifier("addMembers.search")
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textSecondary) }
                            .buttonStyle(.plain)
                            .accessibilityLabel(L("common.clear"))
                    }
                }
            }

            if let email, canInvite, !chips.isEmpty, people.isEmpty {
                emailRow(d, c, email, chips: chips)
            }

            if !people.isEmpty {
                Section {
                    ForEach(people) { p in personRow(d, p) }
                } footer: {
                    Picker(L("dlg.seeNewPl"), selection: $history) {
                        Text(L("dlg.seeNewPl")).tag("now")
                        Text(L("dlg.seeHistoryPl")).tag("all")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .padding(.top, 8)
                    .accessibilityIdentifier("addMembers.history")
                }
            } else if c.canManage && !query.trimmingCharacters(in: .whitespaces).isEmpty && email == nil {
                Section { Text(L("chat.nobody")).foregroundStyle(Theme.textSecondary) }
            }

            if canInvite { inviteSection(d, c, chips: chips) }
            if canInvite && !pending.isEmpty { pendingSection() }
            if let error { Section { Text(error).foregroundStyle(.red).font(.footnote).accessibilityIdentifier("addMembers.error") } }
        }
    }

    // MARK: Filas

    private func personRow(_ d: BootstrapDTO, _ p: PersonDTO) -> some View {
        let on = picked.contains(p.id)
        let org = Naming.org(d, p.orgId)
        return Button { toggle(p.id) } label: {
            HStack(spacing: 12) {
                Avatar(person: p, org: org, size: 36, badge: org != nil)
                (Text(p.name).foregroundStyle(Theme.textPrimary) + Text(" · " + AddInvite.personLine(d, p)).foregroundStyle(Theme.textSecondary))
                    .lineLimit(1)
                Spacer()
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(on ? Theme.accentText : Theme.textSecondary.opacity(0.5))
            }
        }
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("picker.person.\(p.id)")
    }

    /// Fila destacada «✉ Invitar a {correo}» con el tipo de persona y «Enviar invitación».
    @ViewBuilder
    private func emailRow(_ d: BootstrapDTO, _ c: ConversationDTO, _ email: String, chips: [InviteChip]) -> some View {
        let done = sent.contains(email) || pending.contains { $0.email.lowercased() == email }
        Section {
            HStack(spacing: 10) {
                Image(systemName: "envelope.fill").foregroundStyle(Theme.accentText).accessibilityHidden(true)
                Text(L("addinv.inviteEmail", ["email": email])).font(.body.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: 4)
                if done {
                    Text(L("addinv.pendingOne")).font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Theme.orange.opacity(0.15)))
                        .foregroundStyle(Theme.accentText)
                        .accessibilityIdentifier("addMembers.emailPending")
                }
            }
            if done {
                Text(L("addinv.sent", ["email": email])).font(.footnote).foregroundStyle(Theme.textSecondary)
                    .accessibilityIdentifier("addMembers.sentNote")
            } else {
                kindChips(chips)
                Button { sendInvite(d, c, email) } label: {
                    HStack {
                        Spacer()
                        if sending { ProgressView() } else { Text(L("addinv.send")).font(.body.weight(.semibold)) }
                        Spacer()
                    }
                }
                .disabled(sending || kind == nil)
                .accessibilityIdentifier("addMembers.sendInvite")
            }
        }
        .listRowBackground(Theme.orange.opacity(0.08))
    }

    /// «Invitar a alguien nuevo»: tipo de persona, Invitar por correo, Copiar enlace y Compartir….
    @ViewBuilder
    private func inviteSection(_ d: BootstrapDTO, _ c: ConversationDTO, chips: [InviteChip]) -> some View {
        Section {
            if chips.isEmpty {
                Text(L("addinv.onlyMembers")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    .accessibilityIdentifier("addMembers.onlyMembers")
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("addinv.kind")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    kindChips(chips)
                }
                Button {
                    askEmail = true
                    if AddInvite.email(query) == nil { query = "" }
                    searchFocused = true
                } label: { Label(L("addinv.byEmail"), systemImage: "envelope") }
                    .accessibilityIdentifier("addMembers.byEmail")
                Button { copyLink(d, c) } label: {
                    HStack {
                        Label(L("addinv.copyLink"), systemImage: "link")
                        if linkBusy { Spacer(); ProgressView() }
                    }
                }
                .disabled(linkBusy || kind == nil)
                .accessibilityIdentifier("addMembers.copyLink")
                Button { share(d, c) } label: { Label(L("addinv.share"), systemImage: "square.and.arrow.up") }
                    .disabled(linkBusy || kind == nil)
                    .accessibilityIdentifier("addMembers.share")
                if let link {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(L("addinv.copied", ["date": link.expiresAt.formatted(Date.FormatStyle(date: .long, time: .omitted).locale(L10n.locale))]),
                              systemImage: "checkmark.circle.fill")
                            .font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentText)
                            .accessibilityIdentifier("addMembers.linkCopied")
                        if let code = link.code {
                            HStack(spacing: 8) {
                                Text(L("addinv.code", ["code": code])).font(.caption.monospaced()).foregroundStyle(Theme.textSecondary)
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier("addMembers.code")
                                Button {
                                    UIPasteboard.general.string = code
                                    store.show(L("toast.copied"))
                                } label: { Image(systemName: "doc.on.doc").font(.caption) }
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel(L("addinv.copyCode"))
                                    .accessibilityIdentifier("addMembers.copyCode")
                            }
                        }
                    }
                }
            }
        } header: { Text(L("addinv.newTitle")) }
    }

    /// Chips que se acomodan en varias líneas (los nombres largos se leen completos).
    private func kindChips(_ chips: [InviteChip]) -> some View {
        ChipFlow(spacing: 6) {
            ForEach(chips) { chip in
                let on = kind == chip.kind
                Button {
                    kind = chip.kind
                    link = nil
                } label: {
                    Text(chip.label).font(.subheadline.weight(on ? .semibold : .regular)).lineLimit(1)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(on ? Theme.orange.opacity(0.18) : Theme.textSecondary.opacity(0.1)))
                        .overlay(Capsule().stroke(on ? Theme.accentText : .clear, lineWidth: 1))
                        .foregroundStyle(on ? Theme.accentText : Theme.textPrimary)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("addMembers.kind.\(chip.kind.key)")
            }
        }
        .padding(.vertical, 2)
    }

    /// «Invitaciones pendientes (N)», plegado, con Reenviar y Anular.
    private func pendingSection() -> some View {
        Section {
            DisclosureGroup(isExpanded: $pendingOpen) {
                ForEach(pending) { p in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.email).font(.subheadline).foregroundStyle(Theme.textPrimary).lineLimit(1)
                            Text(p.role == "guest" ? L("common.guest") : (p.expired ? L("inv.expired") : L("addinv.pendingOne")))
                                .font(.caption).foregroundStyle(Theme.textSecondary)
                        }
                        Spacer()
                        if p.canManage {
                            Button(L("addinv.resend")) { resend(p) }.buttonStyle(.borderless).font(.subheadline)
                                .accessibilityIdentifier("addMembers.resend.\(p.id)")
                            Button(L("addinv.revoke"), role: .destructive) { revoke(p) }.buttonStyle(.borderless).font(.subheadline)
                                .accessibilityIdentifier("addMembers.revoke.\(p.id)")
                        }
                    }
                }
            } label: {
                Text(L("addinv.pending", ["n": pending.count])).accessibilityIdentifier("addMembers.pending")
            }
        }
    }

    // MARK: Acciones

    private func toggle(_ id: String) {
        if let i = picked.firstIndex(of: id) { picked.remove(at: i) } else { picked.append(id) }
    }

    private func add() {
        busy = true; error = nil
        Task {
            do { try await store.addMembers(conversationId, userIds: picked, history: history); dismiss() } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }

    private func sendInvite(_ d: BootstrapDTO, _ c: ConversationDTO, _ email: String) {
        guard let kind, let wid = c.workspaceId, !sending else { return }
        sending = true; error = nil
        Task {
            defer { sending = false }
            do {
                _ = try await store.createGroupInvite(kind: kind, workspaceId: wid, conversationId: c.id, email: email, history: history)
                if !sent.contains(email) { sent.append(email) }
                store.show(L("addinv.sent", ["email": email]))
                await loadPending(d, c)
            } catch { self.error = L10n.errorText(error) }
        }
    }

    private func ensureLink(_ c: ConversationDTO) async -> InviteLink? {
        guard let kind, let wid = c.workspaceId else { return nil }
        linkBusy = true; error = nil
        defer { linkBusy = false }
        do {
            let l = try await store.groupInviteLink(kind: kind, workspaceId: wid, conversationId: c.id, history: history)
            link = l
            return l
        } catch { self.error = L10n.errorText(error); return nil }
    }

    private func copyLink(_ d: BootstrapDTO, _ c: ConversationDTO) {
        Task {
            guard let l = await ensureLink(c) else { return }
            UIPasteboard.general.string = AddInvite.shareText(group: Naming.title(d, c), link: l)
        }
    }

    private func share(_ d: BootstrapDTO, _ c: ConversationDTO) {
        Task {
            guard let l = await ensureLink(c) else { return }
            shareText = ShareText(text: AddInvite.shareText(group: Naming.title(d, c), link: l))
        }
    }

    private func loadPending(_ d: BootstrapDTO, _ c: ConversationDTO) async {
        guard AddInvite.supportsInvite(d, c), let wid = c.workspaceId, let ws = d.workspaces.first(where: { $0.id == wid }), ws.myRole != "guest" else { return }
        pending = await store.groupPendingInvites(workspaceId: wid, orgId: AddInvite.myOrg(d, ws)?.id, conversationId: c.id)
    }

    private func resend(_ p: PendingInvitationDTO) {
        Task {
            do { try await store.resendInvite(p); store.show(L("inv.resent")) } catch { self.error = L10n.errorText(error) }
        }
    }

    private func revoke(_ p: PendingInvitationDTO) {
        Task {
            do {
                try await store.revokeInvite(p)
                pending.removeAll { $0.id == p.id && $0.scope == p.scope }
                sent.removeAll { $0 == p.email.lowercased() }
                store.show(L("addinv.revoked"))
            } catch { self.error = L10n.errorText(error) }
        }
    }
}

/// Hoja «Compartir» del sistema (WhatsApp, Mensajes, correo…).
struct ActivityView: UIViewControllerRepresentable {
    var items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
