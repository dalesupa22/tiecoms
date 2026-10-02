import SwiftUI
import UIKit

// gg dentro del chat (docs/CONTRATO-GG-CHAT-WA-INBOX.md, parte B). Botón en el encabezado, hoja «gg de este chat»,
// «Responder por mí», citar mensajes y «✨ Pedir a gg (N)». Nada se envía ni se crea solo: el borrador cae en el
// compositor y las tareas o recordatorios abren su diálogo ya lleno.

/// Las letras «gg» en un círculo oscuro con la chispa; con número si hay pendientes.
struct GgMarkButton: View {
    var count: Int = 0
    var size: CGFloat = 30
    var body: some View {
        Circle().fill(Theme.ink)
            .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            .overlay(GGMark(ink: .white, animated: false).padding(size * 0.17))
            .frame(width: size, height: size)
            .overlay(alignment: .topTrailing) {
                if count > 0 {
                    Text(count > 9 ? "9+" : "\(count)")
                        .font(.system(size: 10, weight: .heavy)).monospacedDigit().foregroundStyle(.white)
                        .padding(.horizontal, 4).frame(minWidth: 16, minHeight: 16)
                        .background(Capsule().fill(Theme.orange))
                        .overlay(Capsule().stroke(Theme.background, lineWidth: 1.5))
                        .offset(x: 6, y: -5)
                        .accessibilityIdentifier("gg.button.count")
                }
            }
            .accessibilityHidden(true)
    }
}

/// Sello gg del encabezado de un chat (chaggu o WhatsApp), junto al nombre: pequeñito (≈ 21 pt), sin círculo oscuro,
/// con sus estrellitas que titilan. La entrada principal es «✨ Seguir con gg» de abajo; este sigue abriendo gg.
/// Solo sale cuando el API respondió que existe.
struct GgHeaderButton: View {
    @Environment(AppStore.self) private var store
    let source: String
    let action: () -> Void
    static let size: CGFloat = 21
    /// Lo que ocupa junto al nombre (sello + separación), para el ancho del título.
    static let slot: CGFloat = 28
    var body: some View {
        Button(action: action) {
            GGMark(ink: Theme.textPrimary, animated: true)
                .frame(width: Self.size, height: Self.size)
                .padding(2)
                .background(Circle().fill(Theme.orange.opacity(0.10)))
                .frame(width: Self.slot, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("ggs.title"))
        .accessibilityIdentifier("chat.gg")
    }
}

/// «✨ Seguir con gg» sobre el compositor (queda tras cerrar la hoja; el historial sigue ahí otro día).
struct GgContinueBar: View {
    var onTap: () -> Void
    var body: some View {
        HStack {
            Button(action: onTap) {
                HStack(spacing: 6) {
                    GgMarkButton(size: 18)
                    Text(L("ggs.continue")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                }
                .padding(.leading, 4).padding(.trailing, 10).padding(.vertical, 4)
                .background(Capsule().fill(Theme.bubbleOther))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("gg.continue")
            Spacer()
        }
        .padding(.horizontal, 12).padding(.top, 6)
    }
}

/// Las 3 burbujitas de respuesta sobre la caja (se cargan al tocar ✨, nunca solas).
struct GgReplyBubbles: View {
    let drafts: [GgDraft]
    var onPick: (GgDraft) -> Void
    var onClose: () -> Void
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(drafts) { d in
                    Button { onPick(d) } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(L(d.labelKey)).font(.caption2.weight(.bold)).foregroundStyle(Theme.accentText)
                            Text(d.text).font(.caption).foregroundStyle(Theme.textPrimary).lineLimit(2).multilineTextAlignment(.leading)
                        }
                        .frame(maxWidth: 220, alignment: .leading)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bubbleOther))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("gg.replyBubble.\(d.style)")
                }
                Button(action: onClose) { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(Theme.textSecondary).frame(width: 30, height: 30) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("common.close"))
            }
            .padding(.horizontal, 12)
        }
        .padding(.top, 6)
        .accessibilityIdentifier("gg.replyBubbles")
    }
}

/// Barra de selección: «Cancelar · N seleccionados · ✨ Pedir a gg (N)».
struct GgSelectionBar: View {
    let count: Int
    var onCancel: () -> Void
    var onAsk: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Button(L("common.cancel"), action: onCancel).font(.subheadline).accessibilityIdentifier("gg.select.cancel")
            Text(L("ggs.selected", ["n": count])).font(.footnote).foregroundStyle(Theme.textSecondary)
            Spacer()
            Button(action: onAsk) {
                Text(L("ggs.askN", ["n": count])).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Capsule().fill(Theme.ink))
            }
            .buttonStyle(.plain)
            .disabled(count == 0)
            .opacity(count == 0 ? 0.5 : 1)
            .accessibilityIdentifier("gg.select.ask")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
    }
}

/// Círculo de selección junto a un mensaje en modo «Seleccionar».
struct GgSelectCircle: View {
    let on: Bool
    var body: some View {
        Image(systemName: on ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 20, weight: .medium))
            .foregroundStyle(on ? Theme.accentText : Theme.textSecondary.opacity(0.7))
            .accessibilityHidden(true)
    }
}

/// Qué hacer con lo que gg propone. El chat decide (compositor, diálogo de tarea, de recordatorio, DM).
enum GgOutcome: Equatable {
    case draft(String)
    case task(GgPrefill)
    case reminder(GgPrefill)
    case messagePerson(name: String?, draft: String?)
}

// MARK: - Hoja «gg de este chat»

struct GgSideSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: String
    let chatTitle: String
    /// Mensajes citados («Preguntar a gg»): van encima de la caja como contexto.
    @Binding var quotes: [GgQuote]
    /// Pregunta que llega lista (p. ej. el campo libre de «Pedir a gg»).
    var initialAsk: String? = nil
    var onOutcome: (GgOutcome) -> Void

    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var retry: (() async throws -> Void)?
    @State private var askConsent = false
    @State private var loading = true
    @State private var calendar = false
    @State private var mail = false
    @FocusState private var focused: Bool

    private var thread: GgSideThread? { store.ggSide.threads[source] }
    private var messages: [GgSideMessageDTO] { thread?.messages ?? [] }
    private var lastGg: GgSideMessageDTO? { messages.last(where: \.isGg) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            Text(L("ggs.scope")).font(.caption).foregroundStyle(Theme.textSecondary)
                                .frame(maxWidth: .infinity).padding(.top, 6)
                                .accessibilityIdentifier("gg.scope")
                            if loading && messages.isEmpty { ProgressView().frame(maxWidth: .infinity).padding() }
                            ForEach(messages) { m in row(m).id(m.id) }
                            if busy {
                                HStack(spacing: 6) { ProgressView().controlSize(.small); Text(L("ggs.thinking")).font(.caption).foregroundStyle(Theme.textSecondary) }
                                    .id("busy")
                            }
                            if let error {
                                HStack(spacing: 8) {
                                    Text(error).font(.footnote).foregroundStyle(.red)
                                    if retry != nil { Button(L("common.retry")) { if let r = retry { run(r) } }.font(.footnote.weight(.semibold)) }
                                }
                                .id("error")
                            }
                            if !busy { chips }
                            Color.clear.frame(height: 4).id("bottom")
                        }
                        .padding(.horizontal, 14)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    // Al volver otro día, el historial abre en lo último.
                    .onChange(of: loading) { _, v in if !v { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { proxy.scrollTo("bottom", anchor: .bottom) } } }
                    .onChange(of: messages.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                    .onChange(of: busy) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                }
                composer
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        GgMarkButton(size: 24)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(L("ggs.title")).font(.subheadline.weight(.bold)).foregroundStyle(Theme.textPrimary)
                            Text(chatTitle).font(.caption2).foregroundStyle(Theme.textSecondary).lineLimit(1)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.close")) { dismiss() }.accessibilityIdentifier("gg.close")
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { calendar = true } label: { Label(L("gg.meeting.action"), systemImage: "calendar") }
                            .accessibilityIdentifier("gg.meeting.open")
                        if store.mailEnabled {
                            Button { mail = true } label: { Label(L("gg.mail.action"), systemImage: "envelope") }
                                .accessibilityIdentifier("gg.mail.open")
                        }
                        Button { run { try await store.ggSideNew(source) } } label: { Label(L("ggs.new"), systemImage: "plus.bubble") }
                            .accessibilityIdentifier("gg.new")
                        Button {
                            dismiss()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { store.ggSide.openGeneral += 1 }
                        } label: { Label(L("ggs.openAssistant"), systemImage: "sparkles") }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel(L("menu.open"))
                    .accessibilityIdentifier("gg.menu")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sheet(isPresented: $calendar) { GgCalendarSheet(source: source, messageIds: quotes.map(\.id), suggestedTitle: quotes.first?.text ?? chatTitle) }
        .sheet(isPresented: $mail) { GgMailSheet(source: source, messageIds: quotes.map(\.id)) }
        .onDisappear { focused = false; UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        .waPrivateSource(source)
        .onChange(of: store.waPrivacy.token(source)) { _, _ in quotes = []; text = ""; retry = nil; calendar = false; mail = false; dismiss() }
        .task(id: source) { await open() }
        .alert(L("ai.consentTitle"), isPresented: $askConsent) {
            Button(L("common.cancel"), role: .cancel) { retry = nil }
            Button(L("ai.consentAllow")) {
                let r = retry
                run { try await store.ggSideGrantConsent(); try await r?() }
            }
            .accessibilityIdentifier("gg.consent.allow")
        } message: { Text(L("ai.consentBody")) }
    }

    // MARK: Filas

    @ViewBuilder private func row(_ m: GgSideMessageDTO) -> some View {
        if m.isGg {
            VStack(alignment: .leading, spacing: 8) {
                if !m.body.isEmpty {
                    Text(m.body).font(.subheadline).foregroundStyle(Theme.textPrimary).textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.surface))
                }
                if let p = m.extra?.pending, !p.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L("ggs.pendingTitle")).font(.caption.weight(.bold)).foregroundStyle(Theme.textSecondary).textCase(.uppercase)
                        ForEach(Array(p.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .top, spacing: 6) {
                                Circle().fill(Theme.orange).frame(width: 6, height: 6).padding(.top, 6)
                                Text(item.text).font(.subheadline).foregroundStyle(Theme.textPrimary)
                            }
                        }
                    }
                    .accessibilityIdentifier("gg.pending")
                }
                if let ds = m.extra?.drafts, !ds.isEmpty {
                    ForEach(ds) { d in draftCard(d) }
                    if m.id == lastGg?.id { toneChips }
                }
                if let ss = m.extra?.suggestions, !ss.isEmpty {
                    ForEach(ss) { s in suggestionRow(s) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
        } else {
            VStack(alignment: .trailing, spacing: 4) {
                ForEach(m.quoted ?? []) { q in quoteChip(q, removable: false) }
                Text(m.body).font(.subheadline).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Theme.bubbleMine))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    private func draftCard(_ d: GgDraft) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L(d.labelKey)).font(.caption.weight(.bold)).foregroundStyle(Theme.accentText)
            Text(d.text).font(.subheadline).foregroundStyle(Theme.textPrimary).textSelection(.enabled)
            HStack(spacing: 8) {
                Button { use(.draft(d.text)) } label: { Label(L("ggs.useDraft"), systemImage: "text.cursor") }
                    .buttonStyle(.borderedProminent).tint(Theme.primaryFill).controlSize(.small)
                    .accessibilityIdentifier("gg.useDraft.\(d.style)")
                if let a = d.action {
                    Button { use(a.kind == "reminder" ? .reminder(GgPrefill(a)) : .task(GgPrefill(a))) } label: {
                        Label(L(a.kind == "reminder" ? "ggs.remindAction" : "ggs.taskAction"), systemImage: a.kind == "reminder" ? "alarm" : "checklist")
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.textSecondary.opacity(0.15)))
    }

    private func suggestionRow(_ s: GgSuggestion) -> some View {
        Button { use(GgSuggestSheet.outcome(s)) } label: {
            Label { VStack(alignment: .leading, spacing: 1) { Text(s.title).font(.subheadline.weight(.semibold)); if let d = s.detail { Text(d).font(.caption).foregroundStyle(Theme.textSecondary) } } }
                icon: { Image(systemName: s.icon) }
                .foregroundStyle(Theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
        }
        .buttonStyle(.plain)
    }

    private var toneChips: some View {
        FlowLayout(spacing: 6) {
            ForEach(["me", "shorter", "formal", "more"], id: \.self) { t in
                chip(L("ggs.tone.\(t)"), id: "gg.tone.\(t)") { replyForMe(tone: t) }
            }
        }
    }

    /// Siguientes preguntas de la última respuesta; en el saludo (o si no trae), además las acciones de arranque.
    @ViewBuilder private var chips: some View {
        let follow = lastGg?.extra?.followUps ?? []
        let greeting = lastGg == nil || lastGg?.id == messages.first?.id
        if !(loading && messages.isEmpty) {
            FlowLayout(spacing: 6) {
                if greeting || follow.isEmpty {
                    chip("✨ " + L("ggs.replyForMe"), id: "gg.chip.reply") { replyForMe(tone: nil) }
                    chip(L("ggs.summarize"), id: "gg.chip.summary") { ask(L("ggs.summarize")) }
                    chip(L("ggs.whatsLeft"), id: "gg.chip.left") { ask(L("ggs.whatsLeft")) }
                    chip(L("ggs.agreed"), id: "gg.chip.agreed") { ask(L("ggs.agreed")) }
                }
                // Agendar y redactar correo: gg prepara, la persona revisa y confirma en su hoja.
                chip(L("gg.meeting.action"), id: "gg.chip.meeting") { calendar = true }
                if store.mailEnabled { chip(L("gg.mail.action"), id: "gg.chip.mail") { mail = true } }
                // Sin repetir los de arranque; «Responder por mí» como sugerencia pide los 3 borradores.
                let starters = Set([L("ggs.replyForMe"), L("ggs.summarize"), L("ggs.whatsLeft"), L("ggs.agreed"), "Responder por mí", "Reply for me"].map(Self.fold))
                ForEach(follow.prefix(4).filter { !(greeting || follow.isEmpty) || !starters.contains(Self.fold($0)) }, id: \.self) { f in
                    chip(f, id: "gg.follow") { Self.isReplyForMe(f) ? replyForMe(tone: nil) : ask(f) }
                }
            }
            .padding(.top, 2)
        }
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).trimmingCharacters(in: CharacterSet.alphanumerics.inverted.union(.whitespaces))
    }
    static func isReplyForMe(_ s: String) -> Bool { ["responder por mi", "reply for me"].contains(fold(s)) }

    private func chip(_ title: String, id: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.leading)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Capsule().fill(Theme.surface))
                .overlay(Capsule().stroke(Theme.textSecondary.opacity(0.2)))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityIdentifier(id)
    }

    private func quoteChip(_ q: GgQuote, removable: Bool) -> some View {
        HStack(spacing: 6) {
            Rectangle().fill(Theme.orange).frame(width: 3)
            VStack(alignment: .leading, spacing: 0) {
                if !q.author.isEmpty { Text(q.author).font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary) }
                Text(q.text).font(.caption).foregroundStyle(Theme.textPrimary).lineLimit(2)
            }
            if removable {
                Spacer(minLength: 4)
                Button { quotes.removeAll { $0.id == q.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textSecondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("common.remove"))
            }
        }
        .padding(.vertical, 4).padding(.trailing, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bubbleOther))
        .frame(maxWidth: 320, alignment: .leading)
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if !quotes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(quotes.count == 1 ? L("ggs.quoting") : L("ggs.quotingN", ["n": quotes.count])).font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary)
                    ForEach(quotes) { q in quoteChip(q, removable: true) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("gg.quotes")
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(L("ggs.placeholder"), text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Theme.background))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Theme.textSecondary.opacity(0.25)))
                    .accessibilityIdentifier("gg.input")
                    .onSubmit { send() }
                let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button(action: send) {
                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(empty || busy ? Theme.textSecondary.opacity(0.35) : Theme.ink))
                }
                .disabled(empty || busy)
                .accessibilityLabel(L("chat.send"))
                .accessibilityIdentifier("gg.send")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
    }

    // MARK: Acciones

    private func open() async {
        loading = true
        defer { loading = false }
        if thread?.loaded != true || messages.isEmpty {
            await attempt { try await store.ggSideLoad(source) }
        }
        if let q = initialAsk, !q.isEmpty { ask(q) }
        else if !quotes.isEmpty { focused = true }
    }

    private func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !busy else { return }
        text = ""
        ask(t)
    }

    private func ask(_ t: String) {
        let qs = quotes
        quotes = []
        run { try await store.ggSideAsk(source, text: t, quotes: qs) }
    }

    private func replyForMe(tone: String?) {
        let qs = quotes
        run { _ = try await store.ggSideReplyForMe(source, tone: tone, quotes: qs) }
    }

    private func use(_ o: GgOutcome) {
        onOutcome(o)
        dismiss()
    }

    private func run(_ f: @escaping () async throws -> Void) {
        Task { await attempt(f) }
    }

    private func attempt(_ f: @escaping () async throws -> Void) async {
        busy = true; error = nil
        defer { busy = false }
        do { try await f(); retry = nil }
        catch let e as ApiRequestError where e.needsAIConsent {
            retry = f
            askConsent = true
        } catch {
            retry = f
            self.error = L("ggs.error")
        }
    }
}

// MARK: - «✨ Pedir a gg (N)»: sugerencias con casilla

struct GgSuggestSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: String
    let messageIds: [String]
    /// «Hacer estas N»: en orden, cada una abre su diálogo.
    var onDo: ([GgOutcome]) -> Void
    /// «O pide lo que quieras…»: pasa a la hoja de gg con los mensajes citados.
    var onAsk: (String) -> Void

    @State private var list: [GgSuggestion]?
    @State private var picked: Set<String> = []
    @State private var free = ""
    @State private var error: String?
    @State private var askConsent = false
    @State private var calendar = false
    @State private var mail = false

    static func outcome(_ s: GgSuggestion) -> GgOutcome {
        switch s.kind {
        case "reply": return .draft(s.draft ?? s.detail ?? s.title)
        case "task": return .task(GgPrefill(s))
        case "reminder": return .reminder(GgPrefill(s))
        case "message_person": return .messagePerson(name: s.param("personName", "name", "person", "to"), draft: s.draft)
        default: return .draft(s.draft ?? s.detail ?? s.title)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                    Button(L("common.retry")) { Task { await load() } }
                }
                if list == nil && error == nil { HStack { Spacer(); ProgressView(); Spacer() } }
                if let list, list.isEmpty { Text(L("ggs.nothingToSuggest")).foregroundStyle(Theme.textSecondary) }
                ForEach(list ?? []) { s in
                    Button {
                        if picked.contains(s.id) { picked.remove(s.id) } else { picked.insert(s.id) }
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: picked.contains(s.id) ? "checkmark.square.fill" : "square")
                                .font(.title3).foregroundStyle(picked.contains(s.id) ? Theme.accentText : Theme.textSecondary)
                            Image(systemName: s.icon).foregroundStyle(Theme.textSecondary).frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                                if let d = s.detail ?? s.draft { Text(d).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(3) }
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(picked.contains(s.id) ? .isSelected : [])
                    .accessibilityIdentifier("gg.suggest.\(s.kind)")
                }
                // Con los mensajes elegidos: agendar o redactar un correo (cada uno con su hoja y su confirmación).
                Section {
                    Button { calendar = true } label: { Label(L("gg.meeting.action"), systemImage: "calendar") }
                        .accessibilityIdentifier("gg.suggest.meeting")
                    if store.mailEnabled {
                        Button { mail = true } label: { Label(L("gg.mail.action"), systemImage: "envelope") }
                            .accessibilityIdentifier("gg.suggest.mail")
                    }
                }
                Section {
                    HStack {
                        TextField(L("ggs.free"), text: $free, axis: .vertical).lineLimit(1...3).accessibilityIdentifier("gg.suggest.free")
                        Button { let t = free; dismiss(); onAsk(t) } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                            .disabled(free.trimmingCharacters(in: .whitespaces).isEmpty)
                            .tint(Theme.ink)
                    }
                }
            }
            .navigationTitle(L("ggs.suggestTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(picked.count == 1 ? L("ggs.doOne") : L("ggs.doN", ["n": picked.count])) {
                        let chosen = (list ?? []).filter { picked.contains($0.id) }.map(Self.outcome)
                        dismiss()
                        onDo(chosen)
                    }
                    .disabled(picked.isEmpty)
                    .accessibilityIdentifier("gg.suggest.do")
                }
            }
            .task { await load() }
            .alert(L("ai.consentTitle"), isPresented: $askConsent) {
                Button(L("common.cancel"), role: .cancel) { dismiss() }
                Button(L("ai.consentAllow")) { Task { try? await store.ggSideGrantConsent(); await load() } }
            } message: { Text(L("ai.consentBody")) }
        }
        .presentationDetents([.medium, .large])
        .sheet(isPresented: $calendar) { GgCalendarSheet(source: source, messageIds: messageIds, suggestedTitle: "") }
        .sheet(isPresented: $mail) { GgMailSheet(source: source, messageIds: messageIds) }
        .waPrivateSource(source)
        .onChange(of: store.waPrivacy.token(source)) { _, _ in list = []; picked = []; free = ""; calendar = false; mail = false; dismiss() }
    }

    private func load() async {
        error = nil
        do { list = try await store.ggSideSuggest(source, messageIds: messageIds) }
        catch let e as ApiRequestError where e.needsAIConsent { askConsent = true }
        catch { self.error = L("ggs.error") }
    }
}

/// «Borrador de gg» sobre el compositor: el texto ya está en la caja; se edita y se envía a mano.
struct GgDraftBar: View {
    var onClose: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            GgMarkButton(size: 18)
            VStack(alignment: .leading, spacing: 0) {
                Text(L("ggs.draftBar")).font(.caption.weight(.bold)).foregroundStyle(Theme.textPrimary)
                Text(L("ggs.draftHint")).font(.caption2).foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            Button(action: onClose) { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(Theme.textSecondary).frame(width: 28, height: 28) }
                .buttonStyle(.plain)
                .accessibilityLabel(L("common.close"))
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gg.draftBar")
    }
}

/// Persona del chat por su nombre (o primer nombre) para «Escribirle a X» o el responsable de una tarea.
enum GgPeople {
    static func find(_ d: BootstrapDTO, name: String?, among ids: [String]? = nil) -> PersonDTO? {
        guard let raw = name?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(raw.hasPrefix("@") ? String(raw.dropFirst()) : raw)
        let pool = ids.map { Set($0) }.map { s in d.people.filter { s.contains($0.id) } } ?? d.people
        return pool.first { fold($0.name) == q } ?? pool.first { fold($0.name).hasPrefix(q) || q.hasPrefix(fold(String($0.name.split(separator: " ").first ?? ""))) && !$0.name.isEmpty }
    }
}

/// Hojas de gg en un chat de chaggu: «gg de este chat», «Pedir a gg (N)» y los diálogos de siempre ya llenos,
/// uno tras otro («Hacer estas N»: cada uno se abre al cerrar el anterior; nada se ejecuta sin confirmar).
struct GgChatSheets: ViewModifier {
    @Environment(AppStore.self) private var store
    @Binding var gg: GgChatState
    let source: String
    let conversationId: String
    let chatTitle: String
    let messages: [MessageDTO]
    var onDraft: (String) -> Void

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $gg.open, onDismiss: { gg.ask = nil; gg.quotes = []; gg.selecting = false; gg.selected = []; runQueue() }) {
                GgSideSheet(source: source, chatTitle: chatTitle, quotes: $gg.quotes, initialAsk: gg.ask) { gg.queue = [$0] }
                    .environment(store)
            }
            .sheet(isPresented: $gg.suggesting, onDismiss: runQueue) {
                GgSuggestSheet(source: source, messageIds: messages.filter { gg.selected.contains($0.id) }.map(\.id), onDo: { list in
                    gg.queue = list; gg.selecting = false; gg.selected = []
                }, onAsk: { text in
                    let d = store.data
                    gg.quotes = messages.filter { gg.selected.contains($0.id) }.map { m in
                        GgQuote(id: m.id, author: d.flatMap { Naming.person($0, m.authorId)?.name } ?? "", text: excerpt(m.body, 200))
                    }
                    gg.ask = text; gg.selecting = false; gg.selected = []
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { gg.open = true }
                })
                .environment(store)
            }
            .sheet(item: $gg.task, onDismiss: runQueue) { p in
                let origin = p.messageId.flatMap { id in messages.first { $0.id == id } }
                let canHere = store.data.map { d in store.meta(conversationId).map { $0.canPost && !Naming.isGuest(d, $0) } ?? false } ?? false
                NewIssueSheet(conversationId: canHere ? conversationId : nil, origin: origin, prefill: p).environment(store)
            }
            .sheet(item: $gg.reminder, onDismiss: runQueue) { p in
                ReminderSheet(conversationId: conversationId, message: p.messageId.flatMap { id in messages.first { $0.id == id } }, prefill: p)
                    .environment(store)
            }
    }

    private func runQueue() {
        guard !gg.queue.isEmpty else { return }
        let next = gg.queue.removeFirst()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            switch next {
            case .draft(let t):
                onDraft(t)
                runQueue()
            case .task(let p): gg.task = p
            case .reminder(let p): gg.reminder = p
            case .messagePerson(let name, let draft):
                let members = store.meta(conversationId)?.memberIds
                if let d = store.data, let person = GgPeople.find(d, name: name, among: members) ?? GgPeople.find(d, name: name) {
                    if let draft { UIPasteboard.general.string = draft; store.show(L("ggs.copied")) }
                    Task { do { try await store.openDirect(with: person.id) } catch { store.show(L10n.errorText(error)) } }
                } else {
                    if let draft { onDraft(draft) }
                    runQueue()
                }
            }
        }
    }
}
