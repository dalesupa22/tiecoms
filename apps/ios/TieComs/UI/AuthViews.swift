import SwiftUI

struct AuthFlowView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            LoginView()
                .navigationDestination(isPresented: $store.showSignup) { SignupView(orgToken: store.signupOrgToken) }
        }
    }
}

private struct FieldLabel: View {
    var text: String
    var body: some View {
        Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textSecondary)
    }
}

struct AuthField: View {
    var label: String
    @Binding var text: String
    var secure = false
    var content: UITextContentType?
    var keyboard: UIKeyboardType = .default
    var identifier: String
    var hint: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldLabel(text: label)
            Group {
                if secure { SecureField("", text: $text) } else { TextField("", text: $text) }
            }
            .textContentType(content)
            .keyboardType(keyboard)
            .textInputAutocapitalization(keyboard == .emailAddress || secure ? .never : .words)
            .autocorrectionDisabled(keyboard == .emailAddress || secure)
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.textSecondary.opacity(0.3)))
            .accessibilityLabel(label)
            .accessibilityHint(hint ?? "")
            .accessibilityIdentifier(identifier)
            if let hint { Text(hint).font(.footnote).foregroundStyle(Theme.textSecondary) }
        }
    }
}

struct ErrorBanner: View {
    var text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.subheadline)
            .foregroundStyle(Color(light: 0x9B1C1C, dark: 0xFFB4AB))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(light: 0xFDECEC, dark: 0x3B1D1D)))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isStaticText)
            .accessibilityIdentifier("auth.error")
    }
}

struct LoginView: View {
    @Environment(AppStore.self) private var store
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @State private var showServer = false
    @State private var ssoBusy: SSOProvider?

    var body: some View {
        @Bindable var store = store
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Spacer(); logo; Spacer() }.padding(.top, 24)
                Text(L("brand.tagline")).font(.body).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                ForEach(SSOProvider.allCases) { provider in
                    Button { sso(provider) } label: {
                        HStack(spacing: 10) {
                            if ssoBusy == provider { ProgressView().controlSize(.small) }
                            Text(provider.label).font(.headline)
                        }
                        .foregroundStyle(Theme.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.textSecondary.opacity(0.35)))
                    }
                    .disabled(busy || ssoBusy != nil)
                    .accessibilityIdentifier("login.sso.\(provider.rawValue)")
                }
                HStack(spacing: 10) {
                    Rectangle().fill(Theme.textSecondary.opacity(0.3)).frame(height: 1)
                    Text(L("auth.orEmail")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    Rectangle().fill(Theme.textSecondary.opacity(0.3)).frame(height: 1)
                }
                .accessibilityHidden(true)
                AuthField(label: L("auth.email"), text: $email, content: .username, keyboard: .emailAddress, identifier: "login.email")
                AuthField(label: L("auth.password"), text: $password, secure: true, content: .password, identifier: "login.password")
                if let error { ErrorBanner(text: error) }
                Button(action: submit) { Text(busy ? L("common.wait") : L("auth.login")) }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(busy || email.isEmpty || password.isEmpty)
                    .accessibilityIdentifier("login.submit")
                VStack(spacing: 4) {
                    Text(L("auth.noAccount")).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
                    Button(L("auth.createAccount")) { store.signupOrgToken = nil; store.showSignup = true }
                        .fontWeight(.semibold)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("login.createAccount")
                }
                .font(.subheadline)
                .frame(maxWidth: .infinity)
            }
            .padding(20)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showServer) { ServerSettingsView() }
        .onSubmit(submit)
    }

    @ViewBuilder private var logo: some View {
        #if DEBUG
        LogoView(width: 230)
            .onLongPressGesture(minimumDuration: 1.2) { showServer = true }
            .accessibilityAction(named: Text(L("debug.server"))) { showServer = true }
        #else
        LogoView(width: 230)
        #endif
    }

    private func sso(_ provider: SSOProvider) {
        ssoBusy = provider
        error = nil
        Task {
            do {
                try await store.loginWithSSO(provider)
            } catch SSOError.provider(let code, let message) {
                self.error = L10n.codeText(code, message: message)
            } catch SSOError.couldNotStart {
                self.error = L("err.sso_failed")
            } catch {
                self.error = L10n.errorText(error)
            }
            ssoBusy = nil
        }
    }

    private func submit() {
        guard !busy, !email.isEmpty, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            do { try await store.login(email: email, password: password) } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

struct SignupView: View {
    @Environment(AppStore.self) private var store
    var orgToken: String?
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var orgName = ""
    @State private var title = ""
    @State private var orgInvite: OrgInvitationPreviewDTO?
    @State private var error: String?
    @State private var busy = false
    @State private var ssoBusy: SSOProvider?

    private func sso(_ provider: SSOProvider) {
        if !joining && orgName.trimmingCharacters(in: .whitespaces).isEmpty { error = L("auth.ssoNeedsCompany"); return }
        ssoBusy = provider
        error = nil
        Task {
            do {
                try await store.loginWithSSO(provider, orgInviteToken: orgToken, orgName: joining ? nil : orgName.trimmingCharacters(in: .whitespaces))
            } catch SSOError.provider(let code, let message) {
                self.error = L10n.codeText(code, message: message)
            } catch SSOError.couldNotStart {
                self.error = L("err.sso_failed")
            } catch {
                self.error = L10n.errorText(error)
            }
            ssoBusy = nil
        }
    }

    private var joining: Bool { orgToken != nil }
    private var canSubmit: Bool {
        !busy && name.trimmingCharacters(in: .whitespaces).count >= 2 && email.contains("@") && password.count >= 10
            && (joining ? orgInvite?.valid != false : orgName.trimmingCharacters(in: .whitespaces).count >= 2)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Spacer(); LogoView(width: 160); Spacer() }
                if joining {
                    VStack(alignment: .leading, spacing: 4) {
                        if let inv = orgInvite {
                            Text(L("auth.joining", ["org": inv.orgName])).font(.headline)
                            Text(inv.valid ? L("auth.joiningBy", ["name": inv.invitedByName]) : L("auth.inviteInvalid"))
                                .font(.subheadline).foregroundStyle(Theme.textSecondary)
                        } else if error == nil {
                            ProgressView()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("signup.joining")
                }
                if !joining {
                    AuthField(label: L("auth.company"), text: $orgName, content: .organizationName, identifier: "signup.company")
                }
                ForEach(SSOProvider.allCases) { provider in
                    Button { sso(provider) } label: {
                        HStack(spacing: 10) {
                            if ssoBusy == provider { ProgressView().controlSize(.small) }
                            Text(provider.label).font(.headline)
                        }
                        .foregroundStyle(Theme.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.textSecondary.opacity(0.35)))
                    }
                    .disabled(busy || ssoBusy != nil || (joining && orgInvite?.valid == false))
                    .accessibilityIdentifier("signup.sso.\(provider.rawValue)")
                }
                Text(L("auth.orEmail")).font(.footnote).foregroundStyle(Theme.textSecondary).frame(maxWidth: .infinity)
                AuthField(label: L("auth.name"), text: $name, content: .name, identifier: "signup.name")
                AuthField(label: L("auth.email"), text: $email, content: .username, keyboard: .emailAddress, identifier: "signup.email")
                AuthField(label: L("auth.password"), text: $password, secure: true, content: .newPassword, identifier: "signup.password", hint: L("auth.passwordHint"))
                AuthField(label: L("auth.title"), text: $title, content: .jobTitle, identifier: "signup.title")
                if let error { ErrorBanner(text: error) }
                Button(action: submit) { Text(busy ? L("common.wait") : joining ? L("auth.signupJoin") : L("auth.signup")) }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("signup.submit")
            }
            .padding(20)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("auth.createAccount"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: orgToken) {
            guard let orgToken else { return }
            do {
                let p = try await store.previewOrgInvitation(orgToken)
                orgInvite = p
                if let e = p.email, email.isEmpty { email = e }
            } catch { self.error = L10n.errorText(error) }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        Task {
            do {
                try await store.signup(name: name.trimmingCharacters(in: .whitespaces), email: email, password: password,
                                       orgName: joining ? nil : orgName.trimmingCharacters(in: .whitespaces), orgInviteToken: orgToken,
                                       title: title.trimmingCharacters(in: .whitespaces))
            } catch { self.error = L10n.errorText(error) }
            busy = false
        }
    }
}

/// Pantalla oculta (solo depuración): cambiar la URL del API.
struct ServerSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var url = Prefs.customAPIURL ?? AppConfig.apiBaseURL.absoluteString

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://app.tiecoms.com", text: $url)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("debug.url")
                } header: { Text(L("debug.server")) } footer: { Text(L("debug.serverHint")) }
                Section {
                    Button(L("debug.useDefault")) { url = AppConfig.defaultAPI }
                }
            }
            .navigationTitle(L("debug.server"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("common.save")) {
                        Prefs.customAPIURL = url == AppConfig.defaultAPI ? nil : url
                        dismiss()
                    }
                    .disabled(URL(string: url)?.scheme == nil)
                }
            }
        }
    }
}
