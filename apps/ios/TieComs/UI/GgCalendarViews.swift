import SwiftUI

struct GgCalendarSlots: Decodable, Sendable {
    struct Slot: Decodable, Identifiable, Equatable, Sendable {
        let startsAt: String
        let endsAt: String
        var id: String { startsAt + "|" + endsAt }
    }
    let status: String
    let provider: String?
    let checkedAt: String?
    let timezone: String?
    let slots: [Slot]
}

/// Provider availability is checked on demand. Creating a meeting always requires a second explicit action.
/// 2-oct-2026: al abrir, gg prepara la reunión con el chat (POST /gg/meeting-draft: título, duración, quiénes, correos
/// escritos y enlaces) y busca horarios (solo lectura). Nada se agenda hasta «Confirmar y agendar». Si gg no puede
/// (sin permiso de IA, sin red), el formulario queda manual como antes.
struct GgCalendarSheet: View {
    enum DraftState: Equatable { case loading, ready(GgMeetingDraft), failed }
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: String
    let messageIds: [String]
    let suggestedTitle: String
    @State private var title = ""
    @State private var description = ""
    @State private var attendeeEmails = ""
    @State private var invitees: [GgInvitee] = []
    @State private var draft: DraftState = .loading
    @State private var from = Date().addingTimeInterval(3600)
    @State private var to = Date().addingTimeInterval(7 * 86400)
    @State private var duration = 30
    @State private var result: GgCalendarSlots?
    @State private var selected: GgCalendarSlots.Slot?
    @State private var busy = false
    @State private var error: String?
    @State private var connecting = false
    @State private var confirm = false
    @State private var idempotencyKey = UUID().uuidString.lowercased()
    @State private var created: MeetingDTO?
    private var timezone: String { TimeZone.current.identifier }
    private var durations: [Int] { Array(Set([15, 30, 45, 60, 90, 120, 180, 240, duration])).sorted() }
    /// Solo en chats de chaggu se invita a personas del chat por id (en WhatsApp no hay cuentas de chaggu).
    private var canInvite: Bool { source.hasPrefix("c:") }
    var body: some View {
        NavigationStack {
            Form {
                if let created {
                    Section {
                        Label(L("meet.createdNotShared"), systemImage: "checkmark.circle.fill")
                        Text(created.title)
                        Text(L10n.dateTime(ISODate.parse(created.startsAt) ?? Date()))
                        if let raw = created.joinUrl, let link = URL(string: raw), link.scheme == "https" { Link(L("meet.open", ["app": created.provider.appName]), destination: link) }
                        if let error = created.error { Text(error).font(.caption).foregroundStyle(.red) }
                    }
                } else {
                    draftNotice
                    Section {
                        TextField(L("meet.titleField"), text: $title).accessibilityIdentifier("gg.meeting.title")
                        if canInvite && !invitees.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(L("gg.meeting.fromChat")).font(.caption).foregroundStyle(Theme.textSecondary)
                                FlowLayout(spacing: 6) {
                                    ForEach(invitees) { p in
                                        HStack(spacing: 4) {
                                            Text(p.name).font(.caption.weight(.semibold))
                                            Button { invitees.removeAll { $0.id == p.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textSecondary) }
                                                .buttonStyle(.borderless)
                                                .accessibilityLabel(L("gg.meeting.removeInvitee", ["name": p.name]))
                                                .accessibilityIdentifier("gg.meeting.invitee.remove")
                                        }
                                        .padding(.horizontal, 10).padding(.vertical, 5)
                                        .background(Capsule().fill(Theme.bubbleOther))
                                        .accessibilityElement(children: .contain)
                                        .accessibilityIdentifier("gg.meeting.invitee")
                                    }
                                }
                            }
                        }
                        TextField(L("gg.calendar.attendees"), text: $attendeeEmails, axis: .vertical).lineLimit(1...3)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                            .accessibilityIdentifier("gg.meeting.emails")
                        TextField(L("gg.calendar.description"), text: $description, axis: .vertical).lineLimit(2...6)
                            .accessibilityIdentifier("gg.meeting.description")
                    }
                    Section {
                        DatePicker(L("gg.calendar.from"), selection: $from)
                        DatePicker(L("gg.calendar.to"), selection: $to)
                        Picker(L("gg.calendar.duration"), selection: $duration) { ForEach(durations, id: \.self) { Text("\($0) min").tag($0) } }
                            .accessibilityIdentifier("gg.meeting.duration")
                        Text(L("gg.calendar.workHours")).font(.caption).foregroundStyle(Theme.textSecondary)
                        Text(timezone).font(.caption).foregroundStyle(Theme.textSecondary)
                        Button(L("gg.calendar.check")) { checkSlots() }.disabled(busy || to <= from).accessibilityIdentifier("gg.meeting.check")
                    }
                    if let result {
                        Section {
                            if result.status == "ready" {
                                if let provider = result.provider { Text(provider == "google" ? "Google Calendar" : "Microsoft Calendar").font(.caption.weight(.semibold)) }
                                if let at = result.checkedAt { Text(L("gg.calendar.checked", ["date": L10n.dateTime(ISODate.parse(at) ?? Date())])).font(.caption) }
                                ForEach(result.slots) { slot in
                                    Button { selected = slot; idempotencyKey = UUID().uuidString.lowercased() } label: {
                                        Label(L10n.dateTime(ISODate.parse(slot.startsAt) ?? Date()), systemImage: selected == slot ? "checkmark.circle.fill" : "circle")
                                    }
                                    .accessibilityIdentifier("gg.meeting.slot")
                                }
                                if result.slots.isEmpty { Text(L("gg.calendar.noSlots")) }
                                if selected != nil {
                                    Button(L("gg.meeting.confirm")) { askConfirm() }
                                        .fontWeight(.semibold)
                                        .disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                        .accessibilityIdentifier("gg.meeting.confirm")
                                }
                            } else {
                                Text(L("gg.calendar.\(result.status)"))
                                Button(L("gg.calendar.connect")) { connecting = true }
                            }
                        }
                    }
                    if busy { ProgressView() }
                    if let error { Text(error).foregroundStyle(.red).font(.caption).accessibilityIdentifier("gg.meeting.error") }
                }
            }
            .navigationTitle(L("gg.calendar.title"))
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
            .task { await loadDraft() }
            .onChange(of: from) { _, _ in result = nil; selected = nil }
            .onChange(of: to) { _, _ in result = nil; selected = nil }
            .onChange(of: duration) { _, _ in result = nil; selected = nil }
            .onChange(of: title) { _, _ in idempotencyKey = UUID().uuidString.lowercased() }
            .onChange(of: description) { _, _ in idempotencyKey = UUID().uuidString.lowercased() }
            .onChange(of: attendeeEmails) { _, _ in idempotencyKey = UUID().uuidString.lowercased() }
            .onChange(of: invitees) { _, _ in idempotencyKey = UUID().uuidString.lowercased() }
            .sheet(isPresented: $connecting) { NavigationStack { Form { MeetingsSettingsSection() }.navigationTitle(L("gg.calendar.connect")).toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.close")) { connecting = false; result = nil } } } } }
            .confirmationDialog(L("gg.meeting.confirm"), isPresented: $confirm, titleVisibility: .visible) {
                Button(L("gg.calendar.create")) { createMeeting() }.accessibilityIdentifier("gg.meeting.create")
                Button(L("common.cancel"), role: .cancel) {}
            } message: {
                Text(confirmSummary)
            }
        }.accessibilityIdentifier("gg.calendar")
    }

    /// «✨ gg lo preparó con el chat…», a quién no encontró y los enlaces que puso en la descripción.
    @ViewBuilder private var draftNotice: some View {
        switch draft {
        case .loading:
            Section {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text(L("gg.meeting.preparing")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                    .accessibilityIdentifier("gg.meeting.preparing")
            }
        case .ready(let d):
            Section {
                Text(L("gg.meeting.prepared")).font(.footnote).accessibilityIdentifier("gg.meeting.notice")
                if !d.missingPeople.isEmpty {
                    Label(L("gg.meeting.missing", ["names": d.missingPeople.joined(separator: ", ")]), systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(Theme.orange)
                        .accessibilityIdentifier("gg.meeting.missing")
                }
                if !d.links.isEmpty {
                    Label(L("gg.meeting.links", ["n": d.links.count]), systemImage: "link").font(.footnote).foregroundStyle(Theme.textSecondary)
                        .accessibilityIdentifier("gg.meeting.links")
                }
            }
        case .failed:
            EmptyView()
        }
    }

    private var confirmSummary: String {
        let emails = GgEmails.parse(attendeeEmails)
        let who = (canInvite ? invitees.map(\.name) : []) + emails
        return [title.trimmingCharacters(in: .whitespacesAndNewlines),
                selected.map { L10n.dateTime(ISODate.parse($0.startsAt) ?? Date()) } ?? "",
                "\(duration) min · \(timezone)",
                who.isEmpty ? "" : L("gg.meeting.with", ["who": who.joined(separator: ", ")]),
                result?.provider.map { $0 == "google" ? "Google Calendar" : "Microsoft Calendar" } ?? ""]
            .filter { !$0.isEmpty }.joined(separator: "\n")
    }

    private func loadDraft() async {
        guard case .loading = draft else { return }
        if title.isEmpty { title = String(suggestedTitle.prefix(200)) }
        let stamp = store.sessionStamp
        do {
            let d: GgMeetingDraft = try await store.api.request("/gg/meeting-draft", method: "POST", json: ["source": source, "messageIds": messageIds])
            try store.requireSession(stamp)
            // Lo que la persona ya escribió mientras gg pensaba no se pisa.
            if !d.title.isEmpty && (title.isEmpty || title == String(suggestedTitle.prefix(200))) { title = String(d.title.prefix(200)) }
            if description.isEmpty { description = String(d.description.prefix(4000)) }
            if attendeeEmails.isEmpty { attendeeEmails = d.attendeeEmails.joined(separator: ", ") }
            invitees = d.invitees
            duration = d.durationMin
            draft = .ready(d)
            // Buscar horarios es solo lectura; agendar sigue siendo otro toque.
            DispatchQueue.main.async { checkSlots() }
        } catch {
            if stamp == store.sessionStamp { draft = .failed }
        }
    }

    private func askConfirm() {
        let emails = GgEmails.parse(attendeeEmails)
        if emails.count > 20 { error = L("gg.calendar.tooMany"); return }
        let bad = GgEmails.invalid(emails)
        if !bad.isEmpty { error = L("gg.mail.checkEmails", ["list": bad.joined(separator: ", ")]); return }
        error = nil
        confirm = true
    }

    private func checkSlots() {
        guard !busy else { return }
        busy = true; error = nil; selected = nil
        let stamp = store.sessionStamp
        Task {
            defer { busy = false }
            do {
                let slots: GgCalendarSlots = try await store.api.request("/gg/calendar/slots", method: "POST", json: ["source": source, "messageIds": messageIds, "from": ISODate.string(from), "to": ISODate.string(to), "durationMin": duration, "timezone": timezone, "startHour": 9, "endHour": 18])
                try store.requireSession(stamp); result = slots
            } catch { if stamp == store.sessionStamp { self.error = L10n.errorText(error) } }
        }
    }
    private func createMeeting() {
        guard !busy, let selected, let provider = result?.provider, ["google", "microsoft"].contains(provider) else { return }
        let emails = GgEmails.parse(attendeeEmails)
        guard emails.count <= 20 else { error = L("gg.calendar.tooMany"); return }
        guard GgEmails.invalid(emails).isEmpty else { error = L("gg.mail.checkEmails", ["list": GgEmails.invalid(emails).joined(separator: ", ")]); return }
        busy = true; error = nil
        let stamp = store.sessionStamp
        var payload: [String: Any] = ["description": description, "attendeeEmails": emails, "source": source, "messageIds": messageIds, "provider": provider, "idempotencyKey": idempotencyKey, "title": title.trimmingCharacters(in: .whitespacesAndNewlines), "startsAt": selected.startsAt, "endsAt": selected.endsAt, "timezone": result?.timezone ?? timezone, "shareToChat": false]
        if canInvite && !invitees.isEmpty { payload["inviteeIds"] = invitees.map(\.id) }
        Task {
            defer { busy = false }
            do {
                let meeting: MeetingDTO = try await store.api.request("/gg/calendar/confirm", method: "POST", json: payload)
                try store.requireSession(stamp); created = meeting
                _ = try? await store.loadEvents(from: from, to: to, conversationId: nil)
            } catch { if stamp == store.sessionStamp { self.error = L10n.errorText(error) } }
        }
    }
}

// MARK: - ✉ Redactar correo con gg

/// gg redacta un correo con el chat (POST /gg/mail-draft) y la persona lo revisa y edita. Sale solo con «Enviar» + la
/// alerta de confirmación (POST /gg/mail-send). La clave cambia si se edita algo: es otro correo. gg solo propone
/// direcciones escritas en el chat (chaggu no revela el correo de nadie).
struct GgMailSheet: View {
    enum Phase: Equatable { case loading, ready(GgMailDraft), needsConnect, failed(String), sent }
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: String
    let messageIds: [String]
    var instruction: String? = nil
    @State private var phase: Phase = .loading
    @State private var to = ""
    @State private var cc = ""
    @State private var subject = ""
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var confirm = false
    @State private var askConsent = false
    @State private var connecting = false
    @State private var connections: [MailConnectionDTO]?
    @State private var key = UUID().uuidString.lowercased()
    @State private var filled = false

    private var toList: [String] { GgEmails.parse(to) }
    private var ccList: [String] { GgEmails.parse(cc).filter { !GgEmails.parse(to).contains($0) } }

    var body: some View {
        NavigationStack {
            Form {
                switch phase {
                case .loading:
                    Section {
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(L("gg.mail.preparing")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                            .accessibilityIdentifier("gg.mail.preparing")
                    }
                case .needsConnect:
                    Section {
                        Text(L("gg.mail.needsConnect")).accessibilityIdentifier("gg.mail.needsConnect")
                        Button(L("gg.mail.connect")) { connecting = true }.accessibilityIdentifier("gg.mail.connect")
                    }
                case .failed(let message):
                    Section {
                        Text(message).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("gg.mail.error")
                        Button(L("common.retry")) { phase = .loading; Task { await load() } }
                    }
                case .sent:
                    Section {
                        Label(L("gg.mail.sent"), systemImage: "checkmark.circle.fill").accessibilityIdentifier("gg.mail.sent")
                        Button(L("common.close")) { dismiss() }
                    }
                case .ready(let d):
                    Section {
                        Text(L("gg.mail.prepared")).font(.footnote).accessibilityIdentifier("gg.mail.notice")
                        if !d.missingPeople.isEmpty {
                            Label(L("gg.mail.missing", ["names": d.missingPeople.joined(separator: ", ")]), systemImage: "exclamationmark.triangle")
                                .font(.footnote).foregroundStyle(Theme.orange)
                                .accessibilityIdentifier("gg.mail.missing")
                        }
                    }
                    Section {
                        LabeledContent(L("gg.mail.from"), value: d.fromLabel).accessibilityIdentifier("gg.mail.from")
                        field(L("gg.mail.toShort")) {
                            TextField(L("gg.mail.to"), text: edit($to), axis: .vertical).lineLimit(1...3)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                                .accessibilityIdentifier("gg.mail.to")
                        }
                        field(L("gg.mail.ccShort")) {
                            TextField(L("gg.mail.cc"), text: edit($cc), axis: .vertical).lineLimit(1...3)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                                .accessibilityIdentifier("gg.mail.cc")
                        }
                        field(L("gg.mail.subject")) {
                            TextField(L("gg.mail.subject"), text: edit($subject)).accessibilityIdentifier("gg.mail.subject")
                        }
                    }

                    Section(L("gg.mail.body")) {
                        TextField(L("gg.mail.body"), text: edit($text), axis: .vertical).lineLimit(6...20)
                            .accessibilityIdentifier("gg.mail.body")
                    }
                    Section {
                        Button { askSend(d) } label: {
                            HStack { Spacer(); if busy { ProgressView() } else { Text(L("gg.mail.send")).fontWeight(.semibold) }; Spacer() }
                        }
                        .disabled(busy || toList.isEmpty)
                        .accessibilityIdentifier("gg.mail.send")
                        if let error { Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("gg.mail.validation") }
                    }
                }
            }
            .navigationTitle(L("gg.mail.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(phase == .sent ? L("common.close") : L("common.cancel")) { dismiss() }.accessibilityIdentifier("gg.mail.close") } }
            .task { await load() }
            .alert(L("gg.mail.confirmTitle"), isPresented: $confirm) {
                Button(L("common.cancel"), role: .cancel) {}
                Button(L("gg.mail.send")) { send() }.accessibilityIdentifier("gg.mail.confirmSend")
            } message: { Text(confirmText) }
            .alert(L("ai.consentTitle"), isPresented: $askConsent) {
                Button(L("common.cancel"), role: .cancel) { dismiss() }
                Button(L("ai.consentAllow")) { Task { do { try await store.ggSideGrantConsent(); phase = .loading; await load() } catch { phase = .failed(L10n.errorText(error)) } } }
            } message: { Text(L("ai.consentBody")) }
            .sheet(isPresented: $connecting, onDismiss: { phase = .loading; Task { await load() } }) {
                NavigationStack {
                    List {
                        if connections == nil { ProgressView() }
                        Section { MailConnectCards(list: connections ?? []) { Task { connections = try? await store.mailConnections() } } } footer: { Text(L("mail.privacyHint")) }
                    }
                    .navigationTitle(L("gg.mail.connect"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.done")) { connecting = false } } }
                    .task { connections = try? await store.mailConnections() }
                }
                .presentationDetents([.medium, .large])
            }
        }
        .accessibilityIdentifier("gg.mail")
    }

    /// Etiqueta fija a la izquierda: «Para», «Copia», «Asunto» se ven aunque el campo ya venga lleno.
    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label).font(.subheadline).foregroundStyle(Theme.textSecondary).frame(minWidth: 56, alignment: .leading)
            content()
        }
    }

    private var confirmText: String {
        let from: String = { if case .ready(let d) = phase { return d.fromLabel }; return "" }()
        var s = L("gg.mail.confirmBody", ["from": from, "to": toList.joined(separator: ", ")])
        if !ccList.isEmpty { s += "\n" + L("gg.mail.confirmCc", ["cc": ccList.joined(separator: ", ")]) }
        return s
    }

    /// Cualquier cambio en lo que se va a enviar es otro correo: otra clave.
    private func edit(_ b: Binding<String>) -> Binding<String> {
        Binding(get: { b.wrappedValue }, set: { v in if v != b.wrappedValue { b.wrappedValue = v; key = UUID().uuidString.lowercased(); error = nil } })
    }

    private func load() async {
        let stamp = store.sessionStamp
        var json: [String: Any] = ["source": source, "messageIds": messageIds]
        if let instruction, !instruction.isEmpty { json["instruction"] = instruction }
        do {
            let d: GgMailDraft = try await store.api.request("/gg/mail-draft", method: "POST", json: json)
            try store.requireSession(stamp)
            guard d.ready else { phase = .needsConnect; return }
            // Al volver de conectar el correo, lo que ya se editó no se pisa.
            if !filled { to = d.to.joined(separator: ", "); cc = d.cc.joined(separator: ", "); subject = d.subject; text = d.body; filled = true; key = UUID().uuidString.lowercased() }
            phase = .ready(d)
        } catch let e as ApiRequestError where e.needsAIConsent {
            if stamp == store.sessionStamp { askConsent = true }
        } catch {
            if stamp == store.sessionStamp { phase = .failed(L10n.errorText(error)) }
        }
    }

    private func askSend(_ d: GgMailDraft) {
        let all = toList + ccList
        let bad = GgEmails.invalid(all)
        if !bad.isEmpty { error = L("gg.mail.checkEmails", ["list": bad.joined(separator: ", ")]); return }
        if toList.isEmpty || subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { error = L("gg.mail.incomplete"); return }
        if toList.count > 20 || ccList.count > 20 { error = L("gg.mail.tooMany"); return }
        error = nil
        confirm = true
    }

    private func send() {
        guard !busy, case .ready(let d) = phase, let provider = d.provider else { return }
        busy = true; error = nil
        let stamp = store.sessionStamp
        let payload: [String: Any] = ["source": source, "provider": provider, "idempotencyKey": key, "to": toList, "cc": ccList,
                                      "subject": subject.trimmingCharacters(in: .whitespacesAndNewlines), "body": text.trimmingCharacters(in: .whitespacesAndNewlines)]
        Task {
            defer { busy = false }
            do {
                let r: GgMailSendResult = try await store.api.request("/gg/mail-send", method: "POST", json: payload)
                try store.requireSession(stamp)
                if r.ok { phase = .sent; Haptics.tap() } else { error = L("ggs.error") }
            } catch let e as ApiRequestError where e.code == "mail_connect_required" {
                if stamp == store.sessionStamp { phase = .needsConnect }
            } catch { if stamp == store.sessionStamp { self.error = L10n.errorText(error) } }
        }
    }
}
