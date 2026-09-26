import SwiftUI

struct ReportContentSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let userId: String
    var messageId: String? = nil
    @State private var reason = ""
    @State private var busy = false
    @State private var error: String?

    private var trimmed: String { reason.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(L("safety.reportHint")).foregroundStyle(Theme.textSecondary)
                    if let d = store.data, let person = Naming.person(d, userId) {
                        LabeledContent(L("common.participant"), value: person.name)
                    }
                }
                Section(L("safety.reason")) {
                    TextField(L("safety.reason"), text: $reason, axis: .vertical)
                        .lineLimit(4...10)
                        .onChange(of: reason) { _, value in if value.count > 2000 { reason = String(value.prefix(2000)) } }
                        .accessibilityIdentifier("safety.reason")
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(L("safety.reportTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("safety.send")) {
                        busy = true
                        Task {
                            do {
                                try await store.reportContent(userId: userId, messageId: messageId, reason: trimmed)
                                store.show(L("safety.sent"))
                                dismiss()
                            } catch { self.error = L10n.errorText(error) }
                            busy = false
                        }
                    }
                    .disabled(busy || trimmed.count < 5 || trimmed.count > 2000)
                    .accessibilityIdentifier("safety.send")
                }
            }
        }
    }
}

struct BlockedUsersView: View {
    @Environment(AppStore.self) private var store
    @State private var loading = true
    @State private var error: String?
    @State private var changing: String?

    var body: some View {
        List {
            if loading { ProgressView() }
            if let error {
                Text(error).foregroundStyle(.red)
                Button(L("common.retry")) { Task { await load() } }
            }
            if !loading && error == nil && store.blockedUserIds.isEmpty { Text(L("safety.none")).foregroundStyle(Theme.textSecondary) }
            ForEach(store.blockedUserIds.sorted(), id: \.self) { id in
                HStack {
                    Text(store.data.flatMap { Naming.person($0, id)?.name } ?? L("common.participant"))
                    Spacer()
                    Button(L("safety.unblock")) {
                        changing = id
                        Task {
                            do { try await store.setUserBlocked(id, blocked: false) }
                            catch { self.error = L10n.errorText(error) }
                            changing = nil
                        }
                    }.disabled(changing != nil)
                }
            }
        }
        .navigationTitle(L("safety.blockedUsers"))
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do { try await store.loadBlockedUsers() } catch { self.error = L10n.errorText(error) }
        loading = false
    }
}

/// Se usa en registro y en SSO: un proveedor también puede crear una cuenta nueva.
struct LegalConsentView: View {
    @Binding var accepted: Bool
    var identifier: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(L("safety.acceptTerms"), isOn: $accepted).accessibilityIdentifier(identifier)
            HStack {
                Link(L("safety.terms"), destination: URL(string: L10n.lang == "es" ? AppConfig.website + "/terminos/" : AppConfig.website + "/en/terms/")!)
                Text("·")
                Link(L("safety.privacy"), destination: URL(string: L10n.lang == "es" ? AppConfig.website + "/privacidad/" : AppConfig.website + "/en/privacy/")!)
            }.font(.footnote)
            Text(L("safety.rulesSummary")).font(.footnote).foregroundStyle(Theme.textSecondary)
        }
    }
}
