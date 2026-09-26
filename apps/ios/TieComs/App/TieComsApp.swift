import SwiftUI
import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { AppFeedback.shared.install() }
        return true
    }

    /// Token APNs → PUT /push/token (lo hace el AppStore).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { PushRegistration.tokenReceived(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[TieComs] APNs no disponible: \(error.localizedDescription)")
    }
}

@main
struct TieComsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: AppStore

    init() {
        let base = AppConfig.apiBaseURL
        let secrets = KeychainSecretStore(apiURL: base)
        // Solo para pruebas de interfaz: empezar sin sesión guardada.
        if AppConfig.launchFlag("TCResetSession") { secrets.set(nil) }
        let s = AppStore(baseURL: base, secrets: secrets, feedback: AppFeedback.shared)
        _store = State(initialValue: s)
        AppFeedback.shared.openConversationId = { [weak s] in s?.appActive == true ? s?.openConversationId : nil }
        AppFeedback.shared.onOpenConversation = { [weak s] id in s?.handle(.conversation(id)) }
        AppFeedback.shared.onOpenSide = { [weak s] origin, side in s?.openSide(origin: origin, side: side) }
        AppFeedback.shared.onReply = { [weak s] conv, text in await s?.replyFromNotification(conv, text: text) }
        AppFeedback.shared.onMarkRead = { [weak s] conv in await s?.markReadFromNotification(conv) }
        AppFeedback.shared.socketOnline = { [weak s] in s?.connection == .online && s?.appActive == true }
        PushRegistration.onToken = { [weak s] hex in Task { await s?.registerPushToken(hex) } }
        // Tras entrar: si nunca se pidió el permiso, primero una pantalla que explica por qué; si ya hay permiso, registrar APNs.
        s.onReady = { [weak s] in
            Task { @MainActor in
                let settings = await UNUserNotificationCenter.current().notificationSettings()
                if settings.authorizationStatus == .notDetermined {
                    if Prefs.notificationsEnabled && !Prefs.pushPrompted && !AppConfig.launchFlag("TCNoPushPrompt") { s?.showPushPrompt = true }
                }
            }
        }
    }

    private let launchedAt = Date()

    /// Un enlace que llega en el primer segundo abrió la app en frío: splash corto.
    private func markLinkLaunch() {
        if Date().timeIntervalSince(launchedAt) < 1.5 { store.launchedByLink = true }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .task {
                    // Las pruebas unitarias se alojan en la app: no se arranca la sesión real.
                    guard !AppConfig.isRunningUnitTests else { return }
                    await store.start()
                }
                .onOpenURL { markLinkLaunch(); store.handle(url: $0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    markLinkLaunch()
                    if let url = activity.webpageURL { store.handle(url: url) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: store.becameActive()
            case .background: store.enteredBackground()
            default: break
            }
        }
    }
}
