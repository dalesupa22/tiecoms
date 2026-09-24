import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Extensión "Compartir en TieComs": recibe texto o un enlace de cualquier app y lo
/// publica en la conversación elegida como mensaje reenviado (`forwarded`).
/// Usa la misma sesión que la app (refresh token en el Keychain del grupo
/// group.com.tiecoms.app) y la lista de conversaciones que la app deja en el App Group.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext)
        let host = UIHostingController(rootView: ShareExtensionView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.loadInput() }
    }
}

@MainActor
@Observable
final class ShareModel {
    private let context: NSExtensionContext?
    var text = ""
    var targets: [ShareTargets.Target] = []
    var apiURL: URL?
    var source: ForwardSource = .other
    var sending = false
    var error: String?
    var sentTo: String?

    init(context: NSExtensionContext?) {
        self.context = context
        let saved = ShareTargets.load()
        targets = saved.targets
        apiURL = saved.apiURL
    }

    var hasSession: Bool { apiURL != nil && !targets.isEmpty && KeychainSecretStore().get() != nil }

    func loadInput() async {
        var parts: [String] = []
        for item in (context?.inputItems as? [NSExtensionItem]) ?? [] {
            if let t = item.attributedContentText?.string, !t.isEmpty { parts.append(t) }
            for p in item.attachments ?? [] {
                if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let s = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String { parts.append(s) }
                else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                        let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL { parts.append(u.absoluteString) }
            }
        }
        var seen = Set<String>()
        text = parts.filter { seen.insert($0).inserted }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        source = SharedText.detectSource(text)
    }

    func send(to target: ShareTargets.Target) async {
        guard let apiURL else { return }
        sending = true
        error = nil
        let api = APIClient(baseURL: apiURL, secrets: KeychainSecretStore())
        do {
            for item in SharedText.analyze(text, source: source) {
                let body: [String: Any] = ["clientMessageId": UUID().uuidString.lowercased(), "body": item.body, "forwarded": item.forwarded.json]
                try await api.requestData("/conversations/\(target.id)/messages", method: "POST", json: body)
            }
            sentTo = target.title
            try? await Task.sleep(nanoseconds: 700_000_000)
            context?.completeRequest(returningItems: nil)
        } catch {
            self.error = L10n.errorText(error)
        }
        sending = false
    }

    func cancel() { context?.cancelRequest(withError: NSError(domain: "com.tiecoms.share", code: 0)) }
}

struct ShareExtensionView: View {
    @Bindable var model: ShareModel
    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                if !model.hasSession {
                    ContentUnavailableView(L("share.title"), systemImage: "person.crop.circle.badge.exclamationmark", description: Text(L("share.openApp")))
                } else if let sent = model.sentTo {
                    ContentUnavailableView(L("share.sent", ["name": sent]), systemImage: "checkmark.circle.fill")
                } else {
                    List {
                        Section {
                            Text(L("share.body")).font(.footnote).foregroundStyle(.secondary)
                            if model.text.isEmpty { Text(L("share.empty")) } else { Text(String(model.text.prefix(400))).italic().lineLimit(6) }
                            Picker(L("imp.source"), selection: $model.source) {
                                ForEach(ForwardSource.allCases.filter { $0 != .tiecoms }, id: \.self) { Text(L("src.\($0.rawValue)")).tag($0) }
                            }
                        }
                        if let e = model.error { Section { Text(e).foregroundStyle(.red) } }
                        Section(L("fwd.pick")) {
                            ForEach(model.targets.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }) { t in
                                Button { Task { await model.send(to: t) } } label: {
                                    VStack(alignment: .leading) {
                                        Text(t.title).foregroundStyle(.primary)
                                        Text(t.subtitle).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                .disabled(model.sending || model.text.isEmpty)
                            }
                        }
                    }
                    .searchable(text: $query, prompt: L("fwd.search"))
                    .overlay { if model.sending { ProgressView() } }
                }
            }
            .navigationTitle(L("share.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { model.cancel() } } }
        }
        .tint(Color(red: 0.70, green: 0.33, blue: 0))
    }
}
