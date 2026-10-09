import Foundation
import SwiftUI
import UIKit

// Aviso de «Actualización disponible» (docs/ACTUALIZAR.md): GET /api/v1/app-version?platform=ios&lang=… es público.
// Si el build instalado es menor que latestBuild, franja fija arriba; si es menor que minBuild, pantalla que bloquea.

/// Respuesta de /app-version. Tolerante: lo que falte vale 0 / vacío (y entonces no se avisa nada).
struct AppVersionInfo: Decodable, Equatable, Sendable {
    var platform: String
    var latestVersion: String
    var latestBuild: Int
    var minBuild: Int
    var url: String?
    var notes: String?

    init(platform: String = "ios", latestVersion: String, latestBuild: Int, minBuild: Int = 0, url: String? = nil, notes: String? = nil) {
        self.platform = platform; self.latestVersion = latestVersion; self.latestBuild = latestBuild
        self.minBuild = minBuild; self.url = url; self.notes = notes
    }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        platform = c.v("platform", "ios")
        latestVersion = c.v("latestVersion", "")
        latestBuild = c.int("latestBuild")
        minBuild = c.int("minBuild")
        url = c.o("url").flatMap { (s: String) in s.isEmpty ? nil : s }
        notes = c.o("notes").flatMap { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : s }
    }
}

enum AppUpdate {
    enum State: Equatable { case none, available(AppVersionInfo), blocked(AppVersionInfo) }

    /// Compara el build instalado (entero) con el publicado. Debug y simulador comparan igual, para poder probarlo.
    static func state(installedBuild: Int?, info: AppVersionInfo?) -> State {
        guard let info, let installed = installedBuild, info.platform == "ios" else { return .none }
        if info.minBuild > 0 && installed < info.minBuild { return .blocked(info) }
        if info.latestBuild > 0 && installed < info.latestBuild { return .available(info) }
        return .none
    }

    /// CFBundleVersion como entero. En Debug, `-TCBuildOverride <n>` lo reemplaza (solo para probar el aviso).
    static var installedBuild: Int? {
        #if DEBUG
        if let o = AppConfig.launchValue("TCBuildOverride"), let n = Int(o) { return n }
        #endif
        return (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String).flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
    }

    /// Instalada desde TestFlight: el recibo se llama «sandboxReceipt».
    static func isTestFlight(receiptURL: URL? = Bundle.main.appStoreReceiptURL) -> Bool {
        receiptURL?.lastPathComponent == "sandboxReceipt"
    }

    /// A dónde lleva «Actualizar», en orden de preferencia.
    static func targets(testFlight: Bool, storeURL: String?) -> [URL] {
        if testFlight { return [URL(string: "itms-beta://")!, URL(string: "https://testflight.apple.com")!] }
        return [storeURL.flatMap(URL.init(string:)) ?? URL(string: "https://apps.apple.com/app/id6816439007")!]
    }

    static func path(lang: String) -> String { "/api/v1/app-version?platform=ios&lang=\(lang)" }
}

/// Pide /app-version al abrir la app y cada vez que vuelve al frente: como mucho una petición en vuelo,
/// sin reintentos (si falla la red no muestra nada y lo intenta en la siguiente apertura).
@MainActor
@Observable
final class AppUpdateChecker {
    private(set) var info: AppVersionInfo?
    private var inFlight = false
    private var lastCheck: Date?
    private let baseURL: URL
    private let session: URLSession
    /// Peticiones hechas (pruebas).
    private(set) var requests = 0

    init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.session = session ?? {
            let c = URLSessionConfiguration.ephemeral
            c.timeoutIntervalForRequest = 10
            c.requestCachePolicy = .reloadIgnoringLocalCacheData
            return URLSession(configuration: c)
        }()
    }

    var state: AppUpdate.State { AppUpdate.state(installedBuild: AppUpdate.installedBuild, info: info) }

    /// Una por apertura o vuelta al frente: si ya hay una en vuelo o hubo otra hace menos de 2 s (el arranque dispara
    /// la tarea y el cambio a activo casi a la vez), no pide otra.
    func check(now: Date = Date()) async {
        guard !inFlight else { return }
        if let lastCheck, now.timeIntervalSince(lastCheck) < 2 { return }
        inFlight = true
        lastCheck = now
        requests += 1
        defer { inFlight = false }
        let base = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base + AppUpdate.path(lang: L10n.lang)) else { return }
        do {
            let (data, response) = try await session.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let next = try JSONDecoder().decode(AppVersionInfo.self, from: data)
            if next != info { info = next }
        } catch {
            // Sin red o respuesta rara: no se muestra nada nuevo; se reintenta en la siguiente apertura.
        }
    }

    /// «Actualizar»: TestFlight (itms-beta://, o la web de TestFlight) o la tienda.
    func openUpdate() {
        let targets = AppUpdate.targets(testFlight: AppUpdate.isTestFlight(), storeURL: info?.url)
        open(targets[...])
    }

    private func open(_ list: ArraySlice<URL>) {
        guard let first = list.first else { return }
        UIApplication.shared.open(first, options: [:]) { [weak self] ok in
            if !ok { Task { @MainActor in self?.open(list.dropFirst()) } }
        }
    }
}
