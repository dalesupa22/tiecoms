import SwiftUI

/// /llamada/<token> (docs/LLAMADAS.md › Invitados por enlace): «Entrar a la llamada» con el nombre, con voz o con video,
/// y después la llamada como invitado a pantalla completa (la misma CallScreen, sin transcripción ni «Agregar»).
/// Paridad con apps/web/src/screens/GuestCall.tsx. Sirve con o sin sesión; se muestra encima de todo (RootView).
struct GuestCallLinkView: View {
    @Environment(AppStore.self) private var store
    let token: String

    enum Load: Equatable {
        case loading
        case ready(GuestCallPreviewDTO)
        /// 404 o enlace quitado: «Este enlace ya no sirve».
        case invalid
        case failed(String)
    }

    @State private var load: Load = .loading
    @State private var name = ""
    @State private var busy = false
    @State private var joinError: String?
    /// Ya estoy en otra llamada: se pregunta antes de colgarla (el valor es «con cámara»).
    @State private var pendingSwitch: Bool?

    var body: some View {
        let center = store.callCenter
        Group {
            if let v = center.view, v.isGuest, center.guest?.token == token {
                CallScreen()
            } else {
                card(center)
            }
        }
        .task(id: token) {
            if center.view?.isGuest != true { center.guestOutcome = nil }
            if name.isEmpty { name = Prefs.guestCallName ?? store.me?.name ?? "" }
            await reload()
        }
        // Salí o terminó: se vuelve a leer el enlace (si sigue abierta, se puede volver a entrar).
        .onChange(of: center.guestOutcome) { _, o in if o != nil { Task { await reload() } } }
    }

    private func card(_ center: CallCenter) -> some View {
        ZStack(alignment: .topTrailing) {
            Theme.background.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 20) {
                    LogoView(width: 170).padding(.top, 48)
                    if let o = center.guestOutcome {
                        Text(o == .left ? L("guest.left") : L("guest.ended"))
                            .font(.headline).foregroundStyle(Theme.textPrimary)
                            .accessibilityIdentifier("guest.outcome")
                    }
                    switch load {
                    case .loading:
                        ProgressView().accessibilityLabel(L("common.loading")).padding(.vertical, 20)
                    case .invalid:
                        ErrorBanner(text: L("guest.invalid")).accessibilityIdentifier("guest.invalid")
                    case .failed(let e):
                        ErrorBanner(text: e).accessibilityIdentifier("guest.error")
                        Button(L("common.retry")) { Task { await reload() } }
                            .buttonStyle(PrimaryButtonStyle())
                            .accessibilityIdentifier("guest.retryLoad")
                    case .ready(let info):
                        details(info)
                    }
                    Text(L("guest.powered")).font(.caption).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            Button { store.guestLinkToken = nil } label: {
                Image(systemName: "xmark").font(.headline).foregroundStyle(Theme.textSecondary)
                    .frame(width: 44, height: 44)
            }
            .padding(.trailing, 8).padding(.top, 4)
            .accessibilityLabel(L("common.close"))
            .accessibilityIdentifier("guest.close")
        }
        .overlay(alignment: .bottom) { ToastView(inSheet: true) }
        .confirmationDialog(L("guest.switchTitle"), isPresented: Binding(get: { pendingSwitch != nil }, set: { if !$0 { pendingSwitch = nil } }),
                            titleVisibility: .visible) {
            Button(L("guest.switchConfirm"), role: .destructive) {
                let camera = pendingSwitch ?? false
                pendingSwitch = nil
                join(camera: camera)
            }
            .accessibilityIdentifier("guest.switch.confirm")
            Button(L("common.cancel"), role: .cancel) { pendingSwitch = nil }
        } message: { Text(L("guest.switchBody")) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("guest.screen")
    }

    @ViewBuilder
    private func details(_ info: GuestCallPreviewDTO) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Label(info.title ?? L("guest.title"), systemImage: info.isVideo ? "video.fill" : "phone.fill")
                    .font(.title2.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                    .accessibilityIdentifier("guest.titleText")
                Text(info.orgName.map { L("guest.byOrg", ["host": info.hostName, "org": $0]) } ?? L("guest.by", ["host": info.hostName]))
                    .font(.subheadline).foregroundStyle(Theme.textSecondary)
                    .accessibilityIdentifier("guest.host")
            }
            if !info.active {
                Text(L("guest.notLive")).font(.subheadline).foregroundStyle(Theme.textSecondary)
                    .accessibilityIdentifier("guest.notLive")
                Button(L("guest.rejoin")) { Task { await reload() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("guest.retry")
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("guest.name")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                    TextField(L("guest.namePh"), text: $name)
                        .textContentType(.name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .submitLabel(.join)
                        .onSubmit { tryJoin(camera: info.isVideo) }
                        .onChange(of: name) { _, n in if n.count > CallRules.guestNameMax { name = String(n.prefix(CallRules.guestNameMax)) } }
                        .padding(.horizontal, 12).frame(minHeight: 46)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.textSecondary.opacity(0.25)))
                        .accessibilityIdentifier("guest.name")
                }
                if let joinError { ErrorBanner(text: joinError).accessibilityIdentifier("guest.joinError") }
                let ready = !busy && CallRules.cleanGuestName(name) != nil
                HStack(spacing: 10) {
                    Button { tryJoin(camera: false) } label: {
                        Label(L("guest.joinAudio"), systemImage: "phone.fill").font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.bordered).tint(Theme.accentText)
                    .accessibilityIdentifier("guest.joinAudio")
                    Button { tryJoin(camera: true) } label: {
                        Label(L("guest.joinVideo"), systemImage: "video.fill")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("guest.joinVideo")
                }
                .disabled(!ready)
                if busy { ProgressView().frame(maxWidth: .infinity) }
                Text(L("guest.privacy")).font(.footnote).foregroundStyle(Theme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tryJoin(camera: Bool) {
        let center = store.callCenter
        // Otra llamada (mía o de otro enlace): primero se pregunta.
        if center.inCall, !(center.view?.isGuest == true && center.guest?.token == token) {
            pendingSwitch = camera
            return
        }
        join(camera: camera)
    }

    private func join(camera: Bool) {
        guard !busy, let n = CallRules.cleanGuestName(name), case .ready(let info) = load else { return }
        Prefs.guestCallName = n
        busy = true
        joinError = nil
        let center = store.callCenter
        Task {
            do { try await center.joinAsGuest(token: token, name: n, camera: camera, title: info.title ?? info.hostName) }
            catch {
                joinError = L10n.errorText(error)
                await reload()
            }
            busy = false
        }
    }

    private func reload() async {
        do { load = .ready(try await store.previewCallLink(token)) }
        catch let e as ApiRequestError where e.status == 404 || e.status == 410 || e.code == "link_revoked" { load = .invalid }
        catch is CancellationError {}
        catch { load = .failed(L10n.errorText(error)) }
    }
}
