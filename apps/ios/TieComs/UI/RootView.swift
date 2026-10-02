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
            // /llamada/<token>: encima de todo (con o sin sesión, también en el arranque en frío). Es una capa y no una
            // hoja: así no choca con otra pantalla presentada (la llamada en curso se minimiza al abrir el enlace).
            if let token = store.guestLinkToken {
                GuestCallLinkView(token: token)
                    .environment(\.locale, L10n.locale)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(1.5)
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

    /// Pestañas ya abiertas en la barra propia (se crean al visitarlas y conservan su pila).
    @State private var visited: Set<AppTab> = []
    @State private var keyboardVisible = false

    var body: some View {
        @Bindable var store = store
        let d = store.data
        // Barra propia (con llamadas son 6 pestañas y el TabView del sistema pondría «Más» en iPhone): solo íconos, salvo «DMs».
        tabShell(d, tabs: AppTab.allCases.filter { $0 != .calls || d?.callsEnabled == true })
            .onAppear { Perf.mark("list.visible") }
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
                // Lo que queda debajo de la cápsula se desvanece (no se ve texto «fantasma» bajo el vidrio).
                .background(alignment: .bottom) {
                    LinearGradient(colors: [Theme.background.opacity(0), Theme.background.opacity(0.92)], startPoint: .top, endPoint: .bottom)
                        .frame(height: AppTabBar.height + 20)
                        .ignoresSafeArea(edges: .bottom)
                        .allowsHitTesting(false)
                }
            }
        }
        .animation(.spring(duration: 0.3), value: assistant.open)
        .onDisappear { assistant.close() }
        // gg de un chat › «Abrir en gg»: pasa al asistente general.
        .onChange(of: store.ggSide.openGeneral) { _, _ in
            if let me = d?.me.id { assistant.bind(me) }
            assistant.apiRef = store.api
            assistant.present(listen: false)
        }
        .overlay(alignment: .bottom) { ToastView() }
        // Llamadas: aviso de llamada entrante y la llamada minimizada, encima de todo.
        .overlay(alignment: .top) {
            VStack(spacing: 6) {
                IncomingCallBanner()
                ActiveCallPill()
                OtherDeviceCallBanner()
            }
            .animation(.spring(duration: 0.3), value: store.callCenter.ringing?.id)
            .animation(.spring(duration: 0.3), value: store.callCenter.expanded)
        }
        // La llamada como invitado se muestra en la pantalla del enlace (GuestCallLinkView), no aquí.
        .fullScreenCover(isPresented: Binding(get: { store.callCenter.expanded && store.callCenter.view != nil && store.callCenter.view?.isGuest != true },
                                              set: { if !$0 { store.callCenter.expanded = false } })) { CallScreen() }
        .sheet(isPresented: $store.showPushPrompt) { PushPromptView() }
        .sheet(isPresented: $store.showSleepSettings) { SleepSheet() }
        .sheet(isPresented: Binding(get: { store.shareText != nil }, set: { if !$0 { store.shareText = nil } })) {
            ShareIntoTieComsView(text: store.shareText ?? "")
        }
    }
}

extension MainView {
    /// Pila de navegación de una pestaña (la misma en la barra del sistema y en la propia).
    @ViewBuilder fileprivate func stack(_ t: AppTab) -> some View {
        @Bindable var store = store
        switch t {
        case .home:
            NavigationStack(path: $store.homePath) { HomeView().assistantListMargin().routes() }.issueSheets(host: "tab.home").appTextSize()
        case .dms:
            NavigationStack(path: $store.dmsPath) { DMsView().assistantListMargin().routes() }.issueSheets(host: "tab.dms").appTextSize()
        case .issues:
            NavigationStack(path: $store.issuesPath) { IssuesScreen(hub: true).assistantListMargin().routes() }.issueSheets(host: "tab.issues").appTextSize()
        case .agenda:
            NavigationStack(path: $store.agendaPath) { AgendaScreen().assistantListMargin().routes() }.issueSheets(host: "tab.agenda").appTextSize()
        case .calls:
            NavigationStack(path: $store.callsPath) { CallsScreen().assistantListMargin().routes() }.issueSheets(host: "tab.calls").appTextSize()
        case .settings:
            NavigationStack(path: $store.settingsPath) { SettingsView().assistantListMargin().routes() }.issueSheets(host: "tab.settings").appTextSize()
        }
    }

    fileprivate func youIcon(_ d: BootstrapDTO?) -> UIImage {
        TabAvatar.image(name: d?.me.name ?? "", photo: myPhoto,
                        fill: UIColor(d.map { PersonColor.fill($0.me.id) } ?? Theme.bubbleMine),
                        selected: false, moon: store.dndActive || store.sleepActive)
    }

    fileprivate func badge(_ t: AppTab, _ d: BootstrapDTO?) -> Int {
        switch t {
        case .home: return d.map(Naming.groupsUnread) ?? 0
        case .dms: return d.map(Naming.dmsUnread) ?? 0
        case .issues: return store.myOpenIssues
        case .calls: return store.missedCalls
        default: return 0
        }
    }

    /// Cada pila se crea al visitarla y se conserva; la barra se esconde con el teclado (como la del sistema, que queda debajo).
    fileprivate func tabShell(_ d: BootstrapDTO?, tabs: [AppTab]) -> some View {
        ZStack {
            ForEach(tabs, id: \.self) { t in
                if visited.contains(t) || store.tab == t {
                    stack(t)
                        .opacity(store.tab == t ? 1 : 0)
                        .allowsHitTesting(store.tab == t)
                        .accessibilityHidden(store.tab != t)
                        .zIndex(store.tab == t ? 1 : 0)
                }
            }
        }
        // Como hidesBottomBarWhenPushed (y .shell.in-conv de la web): dentro de un chat, un detalle o cualquier pantalla
        // empujada no hay barra, así nunca tapa el compositor. Tampoco con el teclado.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if TabBarRule.visible(path: store.currentPath, keyboard: keyboardVisible) {
                AppTabBar(items: tabs.map { t in
                    AppTabBar.Item(tab: t, label: TabInfo.title(t), symbol: TabInfo.symbol(t), badge: badge(t, d), identifier: "tab.\(TabInfo.id(t))",
                                   missed: t == .calls && store.missedCalls > 0)
                }, selected: store.tab, avatar: youIcon(d)) { t in
                    if store.tab == t { store.popToRoot(t) } else { store.tab = t }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                // Lo que queda debajo de la cápsula se desvanece (no se ve texto «fantasma» bajo el vidrio).
                .background(alignment: .bottom) {
                    LinearGradient(colors: [Theme.background.opacity(0), Theme.background.opacity(0.92)], startPoint: .top, endPoint: .bottom)
                        .frame(height: AppTabBar.height + 20)
                        .ignoresSafeArea(edges: .bottom)
                        .allowsHitTesting(false)
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: TabBarRule.visible(path: store.currentPath, keyboard: keyboardVisible))
        .onChange(of: store.tab, initial: true) { _, t in visited.insert(t) }
        .onChange(of: d?.callsEnabled) { _, on in if on != true, store.tab == .calls { store.tab = .home } }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboardVisible = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardVisible = false }
    }

    /// Distancia de la burbuja al borde inferior del área segura: justo encima de la barra de pestañas.
    fileprivate static let bubbleBottom: CGFloat = 78

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
            case .callDetail(let id): CallDetailView(callId: id)
            case .mail(let id, let mode): MailDetailView(emailId: id, mode: mode)
            case .mailBox(let cid): MailBoxScreen(conversationId: cid)
            case .waChat(let c): WaChatView(chat: c)
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

/// ¿Se ve la barra? Solo en la raíz de la pestaña y sin teclado.
enum TabBarRule {
    static func visible(path: [Route], keyboard: Bool) -> Bool { path.isEmpty && !keyboard }
}

/// Textos e íconos de la barra inferior.
enum TabInfo {
    static func title(_ t: AppTab) -> String {
        switch t {
        case .home: return L("tab.groups")
        case .dms: return L("tab.dms")
        case .issues: return L("tab.hub")
        case .agenda: return L("bar.agenda")
        case .calls: return L("tab.calls")
        case .settings: return L("tab.you")
        }
    }
    static func symbol(_ t: AppTab) -> String {
        switch t {
        case .home: return "person.2"
        case .dms: return "bubble.left.and.bubble.right"
        case .issues: return "square.grid.2x2"
        case .agenda: return "calendar"
        case .calls: return "phone"
        case .settings: return "person.crop.circle"
        }
    }
    static func id(_ t: AppTab) -> String {
        switch t {
        case .home: return "home"
        case .dms: return "dms"
        case .issues: return "issues"
        case .agenda: return "agenda"
        case .calls: return "calls"
        case .settings: return "settings"
        }
    }
}

/// Barra inferior (1.6.9, pedido de Danny): cápsula flotante solo con íconos (Liquid Glass en iOS 26, material antes),
/// íconos de 22 pt en gris y el elegido en su variante llena con el acento sobre una cápsula pequeña; globos pequeños
/// arriba a la derecha del ícono; «Tú» con el avatar. Va dentro de una UITabBar vacía: VoiceOver y XCTest la ven como
/// barra de pestañas (`tabBars`), cada botón con el nombre completo.
struct AppTabBar: View {
    struct Item {
        var tab: AppTab
        var label: String
        /// SF Symbol (sin «.fill»: la variante llena se pone al elegirla).
        var symbol: String
        var badge: Int
        var identifier: String
        /// Llamadas con perdidas sin ver: ícono y pastilla en rojo (#D93025).
        var missed = false
    }
    var items: [Item]
    var selected: AppTab
    var avatar: UIImage?
    var onSelect: (AppTab) -> Void

    static let height: CGFloat = 58

    var body: some View {
        TabBarAccessibilityHost(content: AnyView(row), labels: items.map(\.label))
            .frame(height: Self.height)
            .modifier(TabBarChrome())
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
    }

    private var row: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.tab) { it in
                let on = it.tab == selected
                Button {
                    Haptics.tap()
                    onSelect(it.tab)
                } label: {
                    icon(it, on: on)
                        .frame(width: 48, height: 36)
                        .background(Capsule().fill(on && it.tab != .settings ? Theme.accentText.opacity(0.12) : .clear))
                        .overlay(alignment: .topTrailing) { badge(it.badge, missed: it.missed) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(it.label)
                .accessibilityValue(it.badge > 0 ? L(it.missed ? "calls.missedN" : "a11y.unread", ["n": it.badge]) : "")
                .accessibilityAddTraits(on ? [.isSelected] : [])
                .accessibilityIdentifier(it.identifier)
            }
        }
        .padding(.horizontal, 6)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }

    @ViewBuilder private func icon(_ it: Item, on: Bool) -> some View {
        if it.tab == .settings {
            Group {
                if let avatar { Image(uiImage: avatar).resizable().scaledToFill() } else { Image(systemName: "person.crop.circle").resizable().scaledToFit() }
            }
            .frame(width: 26, height: 26)
            .clipShape(Circle())
            .padding(2)
            .overlay(Circle().stroke(on ? Theme.accentText : .clear, lineWidth: 2))
        } else if it.tab == .issues {
            // «Todo» (1.7.3): cuadrícula con un chulito, para que se siga leyendo como tareas.
            HubGlyph(filled: on)
                .foregroundStyle(on ? Theme.accentText : Theme.textSecondary)
                .frame(width: 24, height: 24)
                .frame(height: 26)
        } else {
            Image(systemName: it.symbol)
                .symbolVariant(on ? .fill : .none)
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(it.missed ? Theme.missed : on ? Theme.accentText : Theme.textSecondary)
                .frame(height: 26)
        }
    }

    @ViewBuilder private func badge(_ n: Int, missed: Bool) -> some View {
        if n > 0 {
            Text(n > 99 ? "99+" : "\(n)")
                .font(.system(size: 10, weight: .semibold)).monospacedDigit()
                .foregroundStyle(missed ? .white : Theme.onPrimary)
                .padding(.horizontal, 4)
                .frame(minWidth: 16, minHeight: 16)
                .background(Capsule().fill(missed ? Theme.missed : Theme.primaryFill))
                .overlay(Capsule().stroke(Theme.background, lineWidth: 1.5))
                .fixedSize()
                // Pegado arriba a la derecha del ícono (dentro de la celda de 48 pt: no tapa al vecino).
                .offset(x: 2, y: -3)
                .accessibilityHidden(true)
        }
    }
}

/// Ícono de «Todo»: tres cuadros y un chulito en el cuarto lugar (el del mockup aprobado). Elegido: cuadros llenos.
struct HubGlyph: View {
    var filled: Bool
    var body: some View {
        GeometryReader { g in
            let u = min(g.size.width, g.size.height) / 24
            let line = 1.8 * u
            ZStack {
                ForEach(0..<3, id: \.self) { i in
                    let r = CGRect(x: (i == 1 ? 13.5 : 4) * u, y: (i == 2 ? 13.5 : 4) * u, width: 6.5 * u, height: 6.5 * u)
                    let shape = RoundedRectangle(cornerRadius: 1.8 * u).path(in: r)
                    if filled { shape.fill() } else { shape.stroke(style: StrokeStyle(lineWidth: line, lineJoin: .round)) }
                }
                Path { p in
                    p.move(to: CGPoint(x: 14.2 * u, y: 16.8 * u))
                    p.addLine(to: CGPoint(x: 16.1 * u, y: 18.7 * u))
                    p.addLine(to: CGPoint(x: 19.6 * u, y: 15 * u))
                }
                .stroke(style: StrokeStyle(lineWidth: filled ? line * 1.25 : line, lineCap: .round, lineJoin: .round))
            }
        }
        .accessibilityHidden(true)
    }
}

/// Fondo de la cápsula: Liquid Glass en iOS 26; antes, material con borde fino y sombra suave.
private struct TabBarChrome: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: Capsule())
                .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
        } else {
            content
                .background(Capsule().fill(.regularMaterial))
                .overlay(Capsule().stroke(Theme.textSecondary.opacity(0.18), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.10), radius: 12, y: 4)
        }
    }
}

/// UITabBar vacía (sin ítems ni fondo) que aloja la fila de SwiftUI, para que la accesibilidad la anuncie como barra de pestañas.
private struct TabBarAccessibilityHost: UIViewRepresentable {
    var content: AnyView
    var labels: [String]
    final class Bar: UITabBar {
        let host: UIHostingController<AnyView>
        init(_ v: AnyView) {
            host = UIHostingController(rootView: v)
            super.init(frame: .zero)
            let ap = UITabBarAppearance()
            ap.configureWithTransparentBackground()
            standardAppearance = ap
            scrollEdgeAppearance = ap
            backgroundImage = UIImage(); shadowImage = UIImage()
            host.safeAreaRegions = []
            host.view.backgroundColor = .clear
            host.view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(host.view)
            NSLayoutConstraint.activate([host.view.leadingAnchor.constraint(equalTo: leadingAnchor), host.view.trailingAnchor.constraint(equalTo: trailingAnchor),
                                         host.view.topAnchor.constraint(equalTo: topAnchor), host.view.bottomAnchor.constraint(equalTo: bottomAnchor)])
            accessibilityIdentifier = "tab.bar"
        }
        required init?(coder: NSCoder) { fatalError() }
        // Solo la fila propia: sin ítems del sistema.
        override var accessibilityElements: [Any]? { get { [host.view as Any] } set {} }
        override func sizeThatFits(_ size: CGSize) -> CGSize { CGSize(width: size.width, height: AppTabBar.height) }
    }
    func makeUIView(context: Context) -> Bar { Bar(content) }
    func updateUIView(_ v: Bar, context: Context) { v.host.rootView = content }
}
