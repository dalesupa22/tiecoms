import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { AppFeedback.shared.install() }
        return true
    }

    // Punto de extensión para APNs (desactivado: el backend aún no recibe tokens).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistration.tokenReceived(deviceToken)
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
        let secrets = KeychainSecretStore()
        // Solo para pruebas de interfaz: empezar sin sesión guardada.
        if AppConfig.launchFlag("TCResetSession") { secrets.set(nil) }
        let s = AppStore(baseURL: AppConfig.apiBaseURL, secrets: secrets, feedback: AppFeedback.shared)
        _store = State(initialValue: s)
        AppFeedback.shared.openConversationId = { [weak s] in s?.appActive == true ? s?.openConversationId : nil }
        AppFeedback.shared.onOpenConversation = { [weak s] id in s?.handle(.conversation(id)) }
        s.onReady = { Task { await AppFeedback.shared.requestAuthorizationIfNeeded() } }
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
