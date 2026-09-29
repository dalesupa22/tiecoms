import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(AppUpdateChecker.self) private var updates
    /// Splash solo en arranque en frío (este estado vive mientras viva el proceso).
    @State private var showSplash = !AppConfig.launchFlag("TCNoSplash")
    @State private var splashSeconds: Double?

    var body: some View {
        @Bindable var store = store
        let update = updates.state
        ZStack(alignment: .topLeading) {
            // La franja va en la misma columna que el contenido: lo empuja hacia abajo (no tapa cabecera ni chat).
            VStack(spacing: 0) {
                if case .available(let info) = update { UpdateBanner(info: info) { updates.openUpdate() } }
                content
            }
            // Solo pruebas de interfaz (-TCMetrics YES): duración real del splash.
            if AppConfig.launchFlag("TCMetrics"), let s = splashSeconds {
                Text("\(Int(s * 1000))").font(.system(size: 2)).opacity(0.05)
                    .accessibilityIdentifier("metrics.splash").accessibilityLabel("\(Int(s * 1000))")
            }
            if showSplash {
                LaunchSplashView(ready: store.status != .loading, short: store.launchedByLink) { seconds in
                    splashSeconds = seconds
                    withAnimation(.easeOut(duration: 0.2)) { showSplash = false }
                }
                .transition(.opacity)
                .zIndex(1)
            }
            if case .blocked(let info) = update {
                UpdateBlockedView(info: info) { updates.openUpdate() }.zIndex(2)
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
        // Idioma elegido en la app: se redibuja todo (las rutas viven en el store y se conservan) y los formatos del
        // sistema (fechas de DatePicker, etc.) usan ese idioma.
        .id(store.languageRevision)
        .environment(\.locale, L10n.locale)
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
    /// gg: burbuja ✦ y panel (docs/ASISTENTE.md).
    @State private var assistant = AssistantModel()

    var body: some View {
        @Bindable var store = store
        let d = store.data
        TabView(selection: $store.tab) {
            NavigationStack(path: $store.homePath) { HomeView().assistantListMargin().routes() }
                .issueSheets(host: "tab.home")
                .appTextSize()
                .tabItem { Label(L("tab.groups"), systemImage: "person.3") }
                .tag(AppTab.home)
                .badge(d.map(Naming.groupsUnread) ?? 0)
                .accessibilityIdentifier("tab.home")
            NavigationStack(path: $store.dmsPath) { DMsView().assistantListMargin().routes() }
                .issueSheets(host: "tab.dms")
                .appTextSize()
                .tabItem { Label(L("tab.dms"), systemImage: "bubble.left.and.bubble.right") }
                .tag(AppTab.dms)
                .badge(d.map(Naming.dmsUnread) ?? 0)
            NavigationStack(path: $store.issuesPath) { IssuesScreen().assistantListMargin().routes() }
                .issueSheets(host: "tab.issues")
                .appTextSize()
                .tabItem { Label(L("tab.issues"), systemImage: "checklist") }
                .tag(AppTab.issues)
                .badge(store.myOpenIssues)
            NavigationStack(path: $store.agendaPath) { AgendaScreen().assistantListMargin().routes() }
                .issueSheets(host: "tab.agenda")
                .appTextSize()
                .tabItem { Label(L("tab.calendar"), systemImage: "calendar") }
                .tag(AppTab.agenda)
            NavigationStack(path: $store.settingsPath) { SettingsView().assistantListMargin().routes() }
                .issueSheets(host: "tab.settings")
                .appTextSize()
                .tabItem {
                    Label {
                        Text(L("tab.you"))
                    } icon: {
                        Image(uiImage: TabAvatar.image(name: d?.me.name ?? "", photo: myPhoto,
                                                       fill: UIColor(d.map { PersonColor.fill($0.me.id) } ?? Theme.bubbleMine),
                                                       selected: store.tab == .settings, moon: store.dndActive || store.sleepActive))
                    }
                }
                .tag(AppTab.settings)
        }
        // Cada minuto: la ventana de «No molestar todas las noches» (lunita y avisos) entra y sale sola.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                store.clockTick += 1
            }
        }
        // La barra de pestañas no crece más allá de un tamaño razonable; cada pestaña aplica el tamaño elegido.
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .task(id: myPhotoURL) {
            guard let url = myPhotoURL else { myPhoto = nil; return }
            if let hit = RemoteImageCache.shared.object(forKey: url as NSURL) { myPhoto = hit; return }
            guard let (data, resp) = try? await RemoteImageCache.session.data(from: url),
                  (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false,
                  let img = UIImage(data: data) else { return }
            RemoteImageCache.shared.setObject(img, forKey: url as NSURL)
            myPhoto = img
        }
        .overlay(alignment: .bottomTrailing) {
            // Solo en las listas: dentro de un chat (o de otra pantalla de la pila) no se monta.
            if let me = d?.me.id, assistantBubbleVisible {
                AssistantBubble(model: assistant)
                    .padding(.trailing, 14).padding(.bottom, Self.bubbleBottom)
                    .onAppear { assistant.bind(me); assistant.apiRef = store.api }
                    .onChange(of: me) { _, id in assistant.bind(id) }
            }
        }
        .overlay {
            if assistant.open {
                AssistantPanel(model: assistant)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3), value: assistant.open)
        .onDisappear { assistant.close() }
        .overlay(alignment: .bottom) { ToastView() }
        .sheet(isPresented: $store.showPushPrompt) { PushPromptView() }
        .sheet(isPresented: $store.showSleepSettings) { SleepSheet() }
        .sheet(isPresented: Binding(get: { store.shareText != nil }, set: { if !$0 { store.shareText = nil } })) {
            ShareIntoTieComsView(text: store.shareText ?? "")
        }
    }
}

extension MainView {
    /// Distancia de la burbuja al borde inferior del área segura: justo encima de la barra de pestañas.
    fileprivate static let bubbleBottom: CGFloat = 58

    /// Solo en las listas (raíz de la pestaña), nunca dentro de un chat.
    fileprivate var assistantBubbleVisible: Bool {
        Assistant.bubbleVisible(path: store.currentPath, openConversationId: store.openConversationId)
    }

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
            case .signed: SignedDocumentsView()
            case .files: FilesRootView()
            case .drive(let ws, let folder): DriveFolderView(workspaceId: ws, folderId: folder)
            case .oversight(let orgId): OversightView(orgId: orgId)
            case .oversightReader(let id, let name): OversightReaderView(conversationId: id, name: name)
            case .scheduled: ScheduledScreen()
            }
        }
    }
}

/// Aviso breve en la parte inferior; con «Deshacer» cuando el aviso lo trae (asuntos completados o descartados).
/// `inSheet`: la copia que muestra una hoja abierta (la de la pestaña queda tapada por la hoja). Solo la de la pestaña
/// lo anuncia a VoiceOver, para no repetirlo.
struct ToastView: View {
    @Environment(AppStore.self) private var store
    var inSheet = false
    var body: some View {
        if let text = store.toast {
            let undo = store.toastUndo
            HStack(spacing: 12) {
                Text(text)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                if let undo {
                    Button {
                        store.toast = nil; store.toastUndo = nil
                        undo()
                    } label: {
                        Text(L("issue.undo")).font(.subheadline.weight(.bold)).foregroundStyle(Theme.orangeLight)
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("toast.undo")
                }
            }
            .padding(.horizontal, 16).padding(.vertical, undo == nil ? 10 : 2)
            .background(Capsule().fill(Theme.ink.opacity(0.92)))
            .padding(.bottom, inSheet ? 16 : 64)
            .padding(.horizontal, 16)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("toast")
            .task(id: store.toastSeq) {
                if !inSheet { UIAccessibility.post(notification: .announcement, argument: text) }
                let seq = store.toastSeq
                try? await Task.sleep(nanoseconds: undo == nil ? 2_400_000_000 : 5_000_000_000)
                withAnimation { if store.toastSeq == seq { store.toast = nil; store.toastUndo = nil } }
            }
        }
    }
}

extension View {
    /// Muestra los avisos (y su «Deshacer») encima de una hoja: la hoja tapa el aviso de la pestaña.
    func sheetToasts() -> some View { modifier(SheetToasts()) }
}

private struct SheetToasts: ViewModifier {
    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) { ToastView(inSheet: true) }
    }
}
