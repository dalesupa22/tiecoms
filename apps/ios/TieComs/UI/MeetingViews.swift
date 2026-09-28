import SwiftUI
import UIKit

// «📹 Reunión ahora» y «📅 Agendar reunión con enlace» del menú ＋ del chat, y la sección «Reuniones» de Ajustes.
// docs/TANDA-LECTURA-REUNIONES.md §4. Nada de enlaces inventados: solo se muestra el que confirma el proveedor.

struct MeetingSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    /// true = «Reunión ahora»; false = agendada con fecha y hora.
    let now: Bool

    @State private var connections: [MeetingConnectionDTO] = []
    @State private var loading = true
    @State private var provider: MeetingProvider?
    @State private var instant = true
    @State private var startsAt = MeetingSheet.nextSlot()
    @State private var duration = 30
    @State private var title = ""
    @State private var idem = MeetingIdempotency()
    @State private var error: MeetingError?
    @State private var connecting = false
    @State private var created: MeetingDTO?

    static let durations = [15, 30, 45, 60]
    /// Próxima media hora (para «Agendar»).
    static func nextSlot(_ d: Date = Date(), calendar: Calendar = .current) -> Date {
        let base = calendar.dateInterval(of: .minute, for: d)?.start ?? d
        let m = calendar.component(.minute, from: base)
        return base.addingTimeInterval(TimeInterval((m < 30 ? 30 - m : 60 - m) * 60))
    }

    var body: some View {
        NavigationStack {
            Form {
                if let m = created, let url = m.confirmedURL { result(m, url) } else { form }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
            .safeAreaInset(edge: .bottom) { if created == nil { createBar } }
            .navigationTitle(L(now ? "meet.nowTitle" : "meet.scheduleTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L(created == nil ? "common.cancel" : "common.close")) { dismiss() }.disabled(idem.inFlight)
                }
            }
            .interactiveDismissDisabled(idem.inFlight)
            .task { await reload() }
            .onChange(of: store.meetingsRevision) { _, _ in Task { await reload() } }
            .onAppear {
                instant = now
                if title.isEmpty, let d = store.data, let c = store.meta(conversationId) { title = L("meet.defaultTitle", ["name": Naming.title(d, c)]) }
            }
        }
        .sheetToasts()
    }

    // MARK: Formulario

    @ViewBuilder private var form: some View {
        Section {
            if loading && connections.isEmpty { ProgressView().frame(maxWidth: .infinity) }
            // Una fila por proveedor (se lee bien con texto grande): nombre y estado.
            ForEach(connections) { c in providerChip(c) }
            if let c = selected {
                switch c.chipState {
                case .unavailable(let why):
                    Label(why ?? L("meet.unavailable"), systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(Theme.textSecondary)
                        .accessibilityIdentifier("meet.unavailableReason")
                case .connect, .reconnect:
                    Button { connect(c.provider) } label: {
                        Label(L(c.status == .reconnect ? "meet.reconnectTo" : "meet.connectTo", ["provider": c.provider.label]),
                              systemImage: "link.badge.plus")
                    }
                    .disabled(connecting)
                    .accessibilityIdentifier("meet.connect.\(c.provider.rawValue)")
                case .connected: EmptyView()
                }
            }
        } header: { Text(L("meet.provider")) } footer: { Text(L("meet.scopeHint")) }

        Section(L("meet.when")) {
            Picker(L("meet.when"), selection: $instant) {
                Text(L("meet.nowOpt")).tag(true)
                Text(L("meet.at")).tag(false)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("meet.when")
            if !instant {
                DatePicker(L("meet.at"), selection: $startsAt, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    .accessibilityIdentifier("meet.startsAt")
                Text(TimeZone.current.identifier.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(Theme.textSecondary)
            }
            Picker(L("meet.duration"), selection: $duration) {
                ForEach(Self.durations, id: \.self) { Text(L("meet.min", ["n": $0])).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("meet.duration")
        }

        Section(L("meet.titleField")) {
            TextField(L("meet.titleField"), text: $title, axis: .vertical).lineLimit(1...3)
                .accessibilityIdentifier("meet.titleInput")
        }

        Section { EmptyView() } footer: { Text(L("meet.createHint")) }
    }

    /// Fija abajo: el error (si hay) y «Crear y compartir», siempre a la vista.
    @ViewBuilder private var createBar: some View {
        VStack(spacing: 8) {
            if let error, let p = provider {
                Text(error.text(p)).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("meet.error")
                if error.needsConnect {
                    Button(L(error == .reconnectRequired ? "meet.reconnectTo" : "meet.connectTo", ["provider": p.label])) { connect(p) }
                        .disabled(connecting)
                        .accessibilityIdentifier("meet.errorConnect")
                }
            }
            Button { create() } label: {
                HStack(spacing: 6) {
                    if idem.inFlight { ProgressView(); Text(L("meet.creating")) }
                    else { Text(L(error != nil && idem.pendingKey != nil ? "meet.retry" : "meet.create")).font(.headline) }
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .primaryProminent()
            .disabled(!canCreate)
            .accessibilityIdentifier("meet.create")
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Theme.background)
    }

    private var selected: MeetingConnectionDTO? { connections.first { $0.provider == provider } }

    private var canCreate: Bool {
        guard let c = selected, c.canCreate, !idem.inFlight, !connecting else { return false }
        if case .unavailable = error { return false }
        return title.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
    }

    private func providerChip(_ c: MeetingConnectionDTO) -> some View {
        let on = provider == c.provider
        let sub: String = {
            switch c.chipState {
            case .connected(let email): return email ?? L("meet.connected")
            case .connect: return L("meet.connect")
            case .reconnect: return L("meet.reconnect")
            case .unavailable: return L("meet.unavailable")
            }
        }()
        let dim: Bool = { if case .unavailable = c.chipState { return true }; return false }()
        return Button {
            provider = c.provider
            // El motivo de «No disponible» ya va bajo la lista; otro proveedor limpia el error anterior.
            error = nil
        } label: {
            HStack(spacing: 10) {
                Image(systemName: on ? "largecircle.fill.circle" : "circle").foregroundStyle(on ? Theme.accentText : Theme.textSecondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Label(c.provider.label, systemImage: c.provider.systemImage).font(.subheadline.weight(.semibold))
                    Text(sub).font(.caption).foregroundStyle(dim ? Theme.textSecondary : c.canCreate ? Theme.doneGreen : Theme.accentText)
                        .lineLimit(2).truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(dim ? Theme.textSecondary : Theme.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(c.provider.label), \(sub)")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("meet.chip.\(c.provider.rawValue)")
    }

    // MARK: Resultado

    @ViewBuilder private func result(_ m: MeetingDTO, _ url: URL) -> some View {
        Section {
            Label(L(m.shared ? "meet.created" : "meet.createdNotShared"), systemImage: m.shared ? "checkmark.circle.fill" : "exclamationmark.circle")
                .foregroundStyle(m.shared ? Theme.doneGreen : .orange)
                .accessibilityIdentifier("meet.result")
            Text(m.title).font(.headline)
            Text(url.absoluteString).font(.footnote.monospaced()).textSelection(.enabled).foregroundStyle(Theme.accentText)
                .accessibilityIdentifier("meet.link")
        }
        Section {
            Button { MeetingOpener.open(url) } label: { Label(L("meet.open", ["app": m.provider.appName]), systemImage: "arrow.up.forward.app") }
                .accessibilityIdentifier("meet.open")
            Button {
                UIPasteboard.general.string = url.absoluteString
                store.show(L("toast.linkCopied"))
            } label: { Label(L("meet.copy"), systemImage: "doc.on.doc") }
                .accessibilityIdentifier("meet.copy")
        } footer: { Text(L("meet.openHint")) }
    }

    // MARK: Acciones

    private func reload() async {
        loading = true
        do {
            connections = try await store.loadMeetingConnections()
            if provider == nil { provider = connections.first(where: \.canCreate)?.provider ?? connections.first(where: \.available)?.provider ?? connections.first?.provider }
            if let c = selected, c.canCreate, error?.needsConnect == true { error = nil }
        } catch { self.error = MeetingError(error); if provider == nil { provider = .google } }
        loading = false
    }

    private func connect(_ p: MeetingProvider) {
        connecting = true
        Task {
            do {
                switch try await store.connectMeetings(p) {
                case .connected: store.show(L("meet.connectedToast", ["provider": p.label])); error = nil
                case .failed(_, let code): store.show(code == "cancelled" ? L("meet.connectCancelled") : L("meet.connectFailed", ["provider": p.label, "code": code]))
                }
            } catch { self.error = MeetingError(error) }
            await reload()
            connecting = false
        }
    }

    private func create() {
        guard let p = provider, let key = idem.begin() else { return }
        error = nil
        let when: Date? = instant ? nil : startsAt
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                let m = try await store.createMeeting(p, conversationId: conversationId, idempotencyKey: key, title: t, startsAt: when, durationMin: duration)
                guard m.confirmedURL != nil else { throw ApiRequestError(status: 502, code: "no_link", message: L("meet.err.noLink")) }
                idem.succeeded()
                Haptics.tap()
                withAnimation { created = m }
            } catch {
                idem.failed()
                self.error = MeetingError(error)
                if self.error?.needsConnect == true { await reload() }
            }
        }
    }
}

// MARK: - Ajustes › Reuniones

struct MeetingsSettingsSection: View {
    @Environment(AppStore.self) private var store
    @State private var connections: [MeetingConnectionDTO] = []
    @State private var error: String?
    @State private var busy: MeetingProvider?
    @State private var confirmDisconnect: MeetingProvider?

    var body: some View {
        Section {
            if connections.isEmpty && error == nil { ProgressView() }
            ForEach(connections) { c in row(c) }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        } header: { Text(L("meet.settings")) } footer: { Text(L("meet.settingsHint")) }
        .task { await load() }
        .onChange(of: store.meetingsRevision) { _, _ in Task { await load() } }
        .confirmationDialog(L("meet.disconnectConfirm", ["provider": confirmDisconnect?.label ?? ""]),
                            isPresented: Binding(get: { confirmDisconnect != nil }, set: { if !$0 { confirmDisconnect = nil } }), titleVisibility: .visible) {
            Button(L("meet.disconnect"), role: .destructive) { if let p = confirmDisconnect { disconnect(p) } }
            Button(L("common.cancel"), role: .cancel) {}
        }
    }

    @ViewBuilder private func row(_ c: MeetingConnectionDTO) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: c.provider.systemImage).foregroundStyle(Theme.accentText).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(c.provider.label).font(.body)
                switch c.chipState {
                case .connected(let email): Text(email ?? L("meet.connected")).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                case .reconnect: Text(L("meet.needsReconnect")).font(.caption).foregroundStyle(.orange)
                case .connect: EmptyView()
                case .unavailable(let why): Text(why ?? L("meet.unavailable")).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(3)
                }
            }
            Spacer(minLength: 4)
            if busy == c.provider { ProgressView() } else {
                switch c.chipState {
                case .connected:
                    Button(L("meet.disconnect"), role: .destructive) { confirmDisconnect = c.provider }
                        .buttonStyle(.borderless).accessibilityIdentifier("meet.settings.disconnect.\(c.provider.rawValue)")
                case .reconnect:
                    Button(L("meet.reconnect")) { connect(c.provider) }.buttonStyle(.borderless)
                        .accessibilityIdentifier("meet.settings.reconnect.\(c.provider.rawValue)")
                case .connect:
                    Button(L("meet.connect")) { connect(c.provider) }.buttonStyle(.borderless)
                        .accessibilityIdentifier("meet.settings.connect.\(c.provider.rawValue)")
                case .unavailable:
                    Text(L("meet.unavailable")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meet.settings.\(c.provider.rawValue)")
    }

    private func load() async {
        do { connections = try await store.loadMeetingConnections(); error = nil } catch { self.error = L10n.errorText(error) }
    }

    private func connect(_ p: MeetingProvider) {
        busy = p
        Task {
            do {
                switch try await store.connectMeetings(p) {
                case .connected: store.show(L("meet.connectedToast", ["provider": p.label]))
                case .failed(_, let code): store.show(code == "cancelled" ? L("meet.connectCancelled") : L("meet.connectFailed", ["provider": p.label, "code": code]))
                }
            } catch { self.error = MeetingError(error).text(p) }
            await load()
            busy = nil
        }
    }

    private func disconnect(_ p: MeetingProvider) {
        busy = p
        Task {
            do { try await store.disconnectMeetings(p); store.show(L("meet.disconnectedToast", ["provider": p.label])) }
            catch { self.error = L10n.errorText(error) }
            await load()
            busy = nil
        }
    }
}
