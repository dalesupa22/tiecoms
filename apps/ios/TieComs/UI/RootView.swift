import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store
    /// Splash animado solo en arranque en frío (este estado vive mientras viva el proceso).
    @State private var showSplash = !AppConfig.launchFlag("TCNoSplash")
    @State private var splashSeconds: Double?

    var body: some View {
        @Bindable var store = store
        ZStack(alignment: .topLeading) {
            content
            // Solo pruebas de interfaz (-TCMetrics YES): duración real del splash.
            if AppConfig.launchFlag("TCMetrics"), let s = splashSeconds {
                Text("\(Int(s * 1000))").font(.system(size: 2)).opacity(0.05)
                    .accessibilityIdentifier("metrics.splash").accessibilityLabel("\(Int(s * 1000))")
            }
            if showSplash {
                AnimatedSplashView(ready: store.status != .loading, short: store.launchedByLink) { seconds in
                    splashSeconds = seconds
                    withAnimation(.easeOut(duration: 0.2)) { showSplash = false }
                }
                .transition(.opacity)
                .zIndex(1)
            }
        }
    }

    @ViewBuilder private var content: some View {
        @Bindable var store = store
        Group {
            switch store.status {
            case .loading:
                SplashView()
            case .unreachable:
                UnreachableView()
            case .anonymous:
                AuthFlowView()
            case .ready:
                MainView()
            }
        }
        .tint(Theme.accentText)
        .sheet(isPresented: Binding(get: { store.inviteToken != nil }, set: { if !$0 { store.inviteToken = nil } })) {
            if let token = store.inviteToken { InviteView(token: token) }
        }
        .alert(store.alert?.title ?? "", isPresented: Binding(get: { store.alert != nil }, set: { if !$0 { store.alert = nil } }), presenting: store.alert) { _ in
            Button(L("common.ok"), role: .cancel) {}
        } message: { a in
            if let m = a.message { Text(m) }
        }
    }
}

struct SplashView: View {
    var body: some View {
        VStack(spacing: 24) {
            LogoView(width: 200)
            ProgressView().accessibilityLabel(L("common.loading"))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
    }
}

struct UnreachableView: View {
    @Environment(AppStore.self) private var store
    @State private var busy = false
    var body: some View {
        VStack(spacing: 20) {
            LogoView(width: 180)
            Text(L("err.network")).font(.headline).foregroundStyle(Theme.textPrimary)
            Text(L("conn.retryHint")).font(.subheadline).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
            Button {
                busy = true
                Task { await store.start(); busy = false }
            } label: { Text(busy ? L("common.wait") : L("common.retry")) }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy)
                .frame(maxWidth: 320)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
    }
}

/// Con sesión: 5 pestañas fijas (docs/GRUPOS.md) Grupos · DMs · Asuntos · Calendario · Tú, cada una con su pila.
struct MainView: View {
    @Environment(AppStore.self) private var store
    /// Mi foto para el ícono de «Tú» (se carga una vez por URL).
    @State private var myPhoto: UIImage?

    var body: some View {
        @Bindable var store = store
        let d = store.data
        TabView(selection: $store.tab) {
            NavigationStack(path: $store.homePath) { HomeView().routes() }
                .tabItem { Label(L("tab.groups"), systemImage: "person.3") }
                .tag(AppTab.home)
                .badge(d.map(Naming.groupsUnread) ?? 0)
                .accessibilityIdentifier("tab.home")
            NavigationStack(path: $store.dmsPath) { DMsView().routes() }
                .tabItem { Label(L("tab.dms"), systemImage: "bubble.left.and.bubble.right") }
                .tag(AppTab.dms)
                .badge(d.map(Naming.dmsUnread) ?? 0)
            NavigationStack(path: $store.issuesPath) { IssuesScreen().routes() }
                .tabItem { Label(L("tab.issues"), systemImage: "checklist") }
                .tag(AppTab.issues)
                .badge(store.myOpenIssues)
            NavigationStack(path: $store.agendaPath) { AgendaScreen().routes() }
                .tabItem { Label(L("tab.calendar"), systemImage: "calendar") }
                .tag(AppTab.agenda)
            NavigationStack(path: $store.settingsPath) { SettingsView().routes() }
                .tabItem {
                    Label {
                        Text(L("tab.you"))
                    } icon: {
                        Image(uiImage: TabAvatar.image(name: d?.me.name ?? "", photo: myPhoto,
                                                       fill: UIColor(d.map { PersonColor.fill($0.me.id) } ?? Theme.bubbleMine),
                                                       selected: store.tab == .settings))
                    }
                }
                .tag(AppTab.settings)
        }
        .task(id: myPhotoURL) {
            guard let url = myPhotoURL else { myPhoto = nil; return }
            if let hit = RemoteImageCache.shared.object(forKey: url as NSURL) { myPhoto = hit; return }
            guard let (data, resp) = try? await RemoteImageCache.session.data(from: url),
                  (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false,
                  let img = UIImage(data: data) else { return }
            RemoteImageCache.shared.setObject(img, forKey: url as NSURL)
            myPhoto = img
        }
        .overlay(alignment: .bottom) { ToastView() }
        .sheet(isPresented: $store.showPushPrompt) { PushPromptView() }
        .sheet(isPresented: Binding(get: { store.shareText != nil }, set: { if !$0 { store.shareText = nil } })) {
            ShareIntoTieComsView(text: store.shareText ?? "")
        }
    }
}

extension MainView {
    fileprivate var myPhotoURL: URL? {
        guard let d = store.data else { return nil }
        return MediaURL.absolute(Naming.person(d, d.me.id)?.avatarUrl ?? d.me.avatarUrl)
    }
}

extension View {
    /// Destinos de navegación comunes a todas las pestañas.
    func routes() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .conversation(let id): ConversationView(conversationId: id)
            case .details(let id): ConversationDetailsView(conversationId: id)
            case .issue(let id): IssueDetailView(issueId: id)
            case .event(let id): EventDetailView(eventId: id)
            case .trazo: TrazoScreen()
            case .reminders: RemindersScreen()
            case .whatsapp: WhatsAppScreen()
            case .domains(let orgId): DomainsScreen(orgId: orgId)
            case .deleteAccount: DeleteAccountView()
            case .workspace(let id): WorkspaceDetailsView(workspaceId: id)
            case .profile: EditProfileView()
            case .files: FilesRootView()
            case .drive(let ws, let folder): DriveFolderView(workspaceId: ws, folderId: folder)
            case .oversight(let orgId): OversightView(orgId: orgId)
            case .oversightReader(let id, let name): OversightReaderView(conversationId: id, name: name)
            }
        }
    }
}

/// Aviso breve en la parte inferior.
struct ToastView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        if let text = store.toast {
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Capsule().fill(Theme.ink.opacity(0.92)))
                .padding(.bottom, 64)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityIdentifier("toast")
                .task(id: text) {
                    UIAccessibility.post(notification: .announcement, argument: text)
                    try? await Task.sleep(nanoseconds: 2_400_000_000)
                    withAnimation { if store.toast == text { store.toast = nil } }
                }
        }
    }
}
