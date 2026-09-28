import SwiftUI

/// Estado del panel de gg (vive mientras haya sesión en MainView).
@MainActor
@Observable
final class AssistantModel {
    var open = false
    /// Se abrió manteniendo presionada la burbuja: escucha y envía al soltar.
    var holding = false
    var turns: [AssistantTurn] = []
    var text = ""
    var busy = false
    var error: String?
    var speakOn = AssistantHistory.speakOn
    let listener = AssistantListener()
    @ObservationIgnored private(set) var userId: String?
    @ObservationIgnored private var byVoice = false

    func bind(_ userId: String) {
        guard self.userId != userId else { return }
        self.userId = userId
        turns = AssistantHistory.load(userId)
    }

    private func persist() { if let userId { AssistantHistory.save(userId, turns) } }

    var pending: [AssistantActionDTO] { Assistant.pending(turns) }

    func present(listen: Bool) {
        error = nil
        open = true
        if listen { startListening() }
    }

    func close() {
        listener.cancel()
        AssistantSpeaker.shared.stop()
        holding = false
        open = false
    }

    func clear() {
        turns = []; error = nil
        persist()
    }

    func toggleSpeak() {
        speakOn.toggle()
        AssistantHistory.speakOn = speakOn
        if !speakOn { AssistantSpeaker.shared.stop() }
    }

    func startListening() {
        guard !listener.listening else { return }
        AssistantSpeaker.shared.stop()
        listener.onFinish = { [weak self] said in
            guard let self, !said.isEmpty else { return }
            self.byVoice = true
            Task { await self.ask(said) }
        }
        listener.start()
    }

    func stopListening() { listener.stop() }

    private func patch(_ id: String, _ change: (inout AssistantActionDTO) -> Void) {
        Assistant.patch(&turns, id, change)
        persist()
    }

    func run(_ a: AssistantActionDTO, api: APIClient, editedText: String? = nil) async {
        guard let token = a.token else { return }
        patch(a.id) { $0.status = .done; $0.error = nil; if let editedText { $0.text = editedText } }
        do {
            let out = try await api.assistantRun(token: token, text: editedText)
            patch(a.id) { $0.status = .done; $0.token = nil; $0.undoToken = out.undoToken; $0.link = out.link ?? a.link }
        } catch {
            patch(a.id) { $0.status = .failed; $0.error = L10n.errorText(error) }
        }
    }

    func undo(_ a: AssistantActionDTO, api: APIClient) async {
        guard let t = a.undoToken else { return }
        do {
            _ = try await api.assistantRun(token: t)
            patch(a.id) { $0.status = .undone; $0.undoToken = nil }
        } catch {
            patch(a.id) { $0.error = L10n.errorText(error) }
        }
    }

    func discard(_ a: AssistantActionDTO) { patch(a.id) { $0.status = .undone; $0.token = nil } }

    func sendAll(api: APIClient) async {
        let all = pending
        await withTaskGroup(of: Void.self) { g in for a in all { g.addTask { await self.run(a, api: api) } } }
    }

    /// Reintentar: la última pregunta falló; se vuelve a mandar sin repetirla en el historial.
    var canRetry: Bool { error != nil && turns.last?.role == .user }
    func retry(api: APIClient) async {
        guard let last = turns.last, last.role == .user else { return }
        await ask(last.content, api: api, retry: true)
    }

    /// «Otra versión»: descarta el borrador y le pide a gg que lo redacte de nuevo.
    func redo(_ a: AssistantActionDTO, api: APIClient) async {
        guard !busy else { return }
        discard(a)
        await ask(L("ai.redoAsk", ["name": a.target]), api: api)
    }

    func ask(_ content: String, api: APIClient? = nil, retry: Bool = false) async {
        let q = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !busy, let api = api ?? apiRef else { return }
        error = nil; text = ""
        let voice = byVoice; byVoice = false
        let waiting = pending
        // «Envíalos» con borradores pendientes: se confirman aquí mismo, sin volver a llamar al modelo.
        if Assistant.isSendAll(q), !waiting.isEmpty {
            turns.append(AssistantTurn(role: .user, content: q)); persist()
            await sendAll(api: api)
            let done = Assistant.sentText(waiting.count)
            turns.append(AssistantTurn(role: .assistant, content: done)); persist()
            if voice || speakOn { AssistantSpeaker.shared.speak(done) }
            return
        }
        if !retry { turns.append(AssistantTurn(role: .user, content: q)); persist() }
        busy = true
        defer { busy = false }
        do {
            let out = try await api.assistantTurn(turns)
            turns.append(AssistantTurn(role: .assistant, content: out.reply, actions: out.actions.isEmpty ? nil : out.actions,
                                       suggestions: out.suggestions.isEmpty ? nil : out.suggestions)); persist()
            if voice || speakOn { AssistantSpeaker.shared.speak(out.reply) }
        } catch let e as ApiRequestError where e.status == 503 {
            error = L("ai.unavailable")
        } catch {
            self.error = L10n.errorText(error)
        }
    }

    /// El API de la sesión (lo fija la vista al montarse).
    @ObservationIgnored var apiRef: APIClient?
}

// MARK: - Burbuja

/// Burbuja ✦ abajo a la derecha, encima de la barra de pestañas. Tocar abre; mantener presionado escucha y envía al soltar.
struct AssistantBubble: View {
    let model: AssistantModel
    @State private var pressTask: Task<Void, Never>?
    @State private var pressing = false
    @State private var long = false

    var body: some View {
        // Círculo blanco de 56 pt, borde naranja al 28 %, anillo exterior al 7 % y la marca de 40 pt (≈3 pt abajo a la derecha).
        GGMark(ink: Theme.ink)
            .frame(width: 40, height: 40)
            .offset(x: 3, y: 3)
            .frame(width: 56, height: 56)
            .background(Circle().fill(Color.white).shadow(color: Theme.ink.opacity(0.14), radius: 8, y: 4))
            .overlay(Circle().strokeBorder(Theme.orange.opacity(0.28), lineWidth: 1))
            .background(Circle().fill(Theme.orange.opacity(0.07)).padding(-4))
            .scaleEffect(pressing ? 0.94 : 1)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressing else { return }
                        pressing = true
                        long = false
                        pressTask = Task { @MainActor in
                            try? await Task.sleep(nanoseconds: UInt64(Assistant.holdSeconds * 1_000_000_000))
                            guard !Task.isCancelled, pressing else { return }
                            long = true
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            model.holding = true
                            model.present(listen: true)
                        }
                    }
                    .onEnded { _ in
                        pressTask?.cancel(); pressTask = nil
                        pressing = false
                        if long { model.holding = false; model.stopListening() } else { model.present(listen: false) }
                        long = false
                    }
            )
            .accessibilityElement()
            .accessibilityLabel(L("ai.open"))
            .accessibilityHint(L("ai.bubbleHint"))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { model.present(listen: false) }
            .accessibilityIdentifier("assistant.bubble")
            // Con el panel abierto se oculta pero sigue montada: el gesto de mantener presionado no se corta al abrir.
            .opacity(model.open ? 0 : 1)
            .allowsHitTesting(!model.open || pressing)
            .accessibilityHidden(model.open)
    }
}

/// Margen al final de las listas para que la burbuja no tape la última fila.
extension View {
    func assistantListMargin() -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: 68).allowsHitTesting(false) }
    }
}

// MARK: - Panel

/// Hoja inferior al 86 % de alto con la conversación, las tarjetas y el campo para pedirle algo a gg.
struct AssistantPanel: View {
    @Environment(AppStore.self) private var store
    @Bindable var model: AssistantModel
    @FocusState private var focused: Bool
    @State private var dragY: CGFloat = 0

    var body: some View {
        GeometryReader { outer in
            let full = outer.size.height + outer.safeAreaInsets.top + outer.safeAreaInsets.bottom
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { model.close() }
                    .accessibilityHidden(true)
                VStack(spacing: 0) {
                    Capsule().fill(Theme.textSecondary.opacity(0.35)).frame(width: 36, height: 5).padding(.top, 7)
                    header
                    Divider()
                    conversation
                    if model.listener.listening { listenStrip }
                    composer
                }
                .frame(maxWidth: .infinity)
                .frame(maxHeight: full * 0.86)
                .background(
                    UnevenRoundedRectangle(topLeadingRadius: 20, topTrailingRadius: 20)
                        .fill(Theme.surface)
                        .ignoresSafeArea(edges: .bottom)
                        .shadow(color: .black.opacity(0.18), radius: 20, y: -4)
                )
                .offset(y: max(0, dragY))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("assistant.panel")
            }
        }
        .onAppear { model.apiRef = store.api }
        .onDisappear { model.listener.cancel() }
    }

    private var header: some View {
        HStack(spacing: 6) {
            GGMark(ink: Theme.textPrimary).frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 0) {
                Text(L("ai.title")).font(.headline.weight(.bold)).foregroundStyle(Theme.textPrimary)
                Text(L("ai.subtitle")).font(.caption).foregroundStyle(Theme.textSecondary)
            }
            .accessibilityElement(children: .combine)
            .padding(.leading, 2)
            Spacer()
            iconButton(model.speakOn ? "speaker.wave.2" : "speaker.slash", label: L(model.speakOn ? "ai.speakOff" : "ai.speakOn"), id: "assistant.speak") { model.toggleSpeak() }
            if !model.turns.isEmpty {
                iconButton("arrow.counterclockwise", label: L("ai.clear"), id: "assistant.clear") { model.clear() }
            }
            iconButton("xmark", label: L("common.close"), id: "assistant.close") { model.close() }
        }
        .padding(.leading, 16).padding(.trailing, 8).padding(.vertical, 6)
        .contentShape(Rectangle())
        .gesture(DragGesture().onChanged { dragY = $0.translation.height }.onEnded { v in
            if v.translation.height > 120 { model.close() }
            withAnimation(.spring(duration: 0.25)) { dragY = 0 }
        })
    }

    private func iconButton(_ symbol: String, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.textSecondary)
                .frame(width: 40, height: 40).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if model.turns.isEmpty { empty }
                    ForEach(model.turns) { t in
                        TurnView(turn: t, model: model).id(t.id)
                    }
                    if model.pending.count > 1 {
                        Button {
                            Task { await model.sendAll(api: store.api) }
                        } label: { Text(L("ai.sendAll", ["n": model.pending.count])).frame(maxWidth: .infinity) }
                            .buttonStyle(PrimaryButtonStyle())
                            .accessibilityIdentifier("assistant.sendAll")
                    }
                    if model.busy { ThinkingDots().id("busy") }
                    let next = Assistant.nextSteps(model.turns, busy: model.busy, listening: model.listener.listening)
                    if !next.isEmpty {
                        FlowLayout(spacing: 8) {
                            ForEach(next, id: \.self) { q in
                                Button { Task { await model.ask(q, api: store.api) } } label: {
                                    Text(q).font(.subheadline).foregroundStyle(Theme.accentText).multilineTextAlignment(.leading)
                                        .padding(.horizontal, 12).padding(.vertical, 7)
                                        .background(Capsule().fill(Theme.surface))
                                        .overlay(Capsule().strokeBorder(Theme.accentText, lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("assistant.next")
                            }
                        }
                    }
                    if let e = model.error {
                        HStack(spacing: 10) {
                            Text(e).font(.subheadline).foregroundStyle(Color.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .accessibilityIdentifier("assistant.error")
                            if model.canRetry {
                                Button(L("ai.retry")) { Task { await model.retry(api: store.api) } }
                                    .buttonStyle(CardButtonStyle(filled: false, tint: Theme.textPrimary))
                                    .accessibilityIdentifier("assistant.retry")
                            }
                        }
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color.red.opacity(0.08)))
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(14)
            }
            .scrollDismissesKeyboard(.interactively)
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: model.turns.count) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: model.busy) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: model.error) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
        }
    }

    private var suggestions: [(key: String, fill: Bool)] {
        [("ai.s.report", false), ("ai.s.pending", false), ("ai.s.due", false),
         ("ai.s.write", true), ("ai.s.group", true), ("ai.s.meeting", true), ("ai.s.issue", true), ("ai.s.cancel", true)]
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 10) {
            let first = store.me?.name.split(separator: " ").first.map(String.init) ?? store.me?.name ?? ""
            Text(L("ai.hello", ["name": first])).font(.title3.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                .accessibilityIdentifier("assistant.hello")
            Text(L("ai.intro")).font(.subheadline).foregroundStyle(Theme.textSecondary)
            FlowLayout(spacing: 8) {
                ForEach(suggestions, id: \.key) { s in
                    Button {
                        let label = L(s.key)
                        if s.fill {
                            model.text = label.hasSuffix("…") ? String(label.dropLast()) + " " : label
                            focused = true
                        } else {
                            Task { await model.ask(label, api: store.api) }
                        }
                    } label: {
                        Text(L(s.key)).font(.subheadline).foregroundStyle(Theme.textPrimary)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Capsule().fill(Theme.bubbleOther))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("assistant.chip.\(s.key)")
                }
            }
            Text(L("ai.voiceHint")).font(.footnote).foregroundStyle(Theme.textSecondary)
        }
        .padding(.top, 6)
    }

    private var listenStrip: some View {
        HStack(spacing: 10) {
            ListeningWave()
            Text(model.listener.interim.isEmpty ? L("ai.listening") : model.listener.interim)
                .font(.subheadline).foregroundStyle(Theme.textPrimary).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(L("ai.stop")) { model.stopListening() }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("assistant.stop")
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Theme.bubbleOther.opacity(0.6))
        .accessibilityElement(children: .combine)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(L("ai.placeholder"), text: $model.text, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .submitLabel(.send)
                .onSubmit { send() }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 18).fill(Theme.bubbleOther))
                .accessibilityIdentifier("assistant.input")
            let hasText = !model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if hasText {
                roundButton("arrow.up", filled: true, label: L("ai.send"), id: "assistant.send") { send() }
                    .disabled(model.busy)
            } else {
                roundButton("mic.fill", filled: model.listener.listening, label: L(model.listener.listening ? "ai.stop" : "ai.talk"), id: "assistant.mic") {
                    if model.listener.listening { model.stopListening() } else { focused = false; model.startListening() }
                }
            }
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 10)
    }

    private func roundButton(_ symbol: String, filled: Bool, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 16, weight: .bold))
                .foregroundStyle(filled ? Theme.onPrimary : Theme.accentText)
                .frame(width: 38, height: 38)
                .background(Circle().fill(filled ? Theme.primaryFill : Theme.bubbleOther))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }

    private func send() {
        let q = model.text
        Task { await model.ask(q, api: store.api) }
    }
}

private struct TurnView: View {
    @Environment(AppStore.self) private var store
    let turn: AssistantTurn
    let model: AssistantModel

    var body: some View {
        VStack(alignment: turn.role == .user ? .trailing : .leading, spacing: 8) {
            Text(turn.content)
                .font(.body)
                .foregroundStyle(turn.role == .user ? Color.white : Theme.textPrimary)
                .textSelection(.enabled)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 16).fill(turn.role == .user ? Theme.ink : Theme.bubbleOther))
                .frame(maxWidth: 300, alignment: turn.role == .user ? .trailing : .leading)
                .accessibilityIdentifier(turn.role == .user ? "assistant.turn.user" : "assistant.turn.assistant")
            if let acts = turn.actions, !acts.isEmpty {
                VStack(spacing: 8) {
                    ForEach(acts) { a in
                        AssistantActionCard(action: a, model: model) { link in
                            guard let l = Assistant.deepLink(link) else { return }
                            model.close()
                            store.handle(l)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: turn.role == .user ? .trailing : .leading)
    }
}

/// Tarjeta de una acción: pendiente (Enviar / Crear / Cancelar reunión · Editar · Descartar), hecha (Abrir · Deshacer),
/// deshecha o fallida.
struct AssistantActionCard: View {
    @Environment(AppStore.self) private var store
    let action: AssistantActionDTO
    let model: AssistantModel
    let onOpen: (String) -> Void
    @State private var editing = false
    @State private var draft = ""

    private var danger: Bool { action.kind == .cancelEvent }
    private var accent: Color { danger ? .red : Theme.accentText }
    private let ok = Color(light: 0x15803D, dark: 0x4ADE80)

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(action.icon).font(.system(size: 15)).foregroundStyle(accent).accessibilityHidden(true)
                Text(action.target).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Spacer(minLength: 4)
                switch action.status {
                case .done: Text(L("ai.done")).font(.caption.weight(.semibold)).foregroundStyle(ok).accessibilityIdentifier("assistant.card.done")
                case .undone: Text(L("ai.undone")).font(.caption).foregroundStyle(Theme.textSecondary)
                case .failed: Text(L("ai.failed")).font(.caption.weight(.semibold)).foregroundStyle(Color.red)
                case .pending: EmptyView()
                }
            }
            if editing {
                TextField("", text: $draft, axis: .vertical)
                    .lineLimit(2...6)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bubbleOther))
                    .accessibilityIdentifier("assistant.card.editor")
            } else if !action.text.isEmpty {
                Text(action.text).font(.subheadline).foregroundStyle(Theme.textPrimary)
                    .strikethrough(danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let d = action.detail, !d.isEmpty { Text(d).font(.caption).foregroundStyle(Theme.textSecondary) }
            if let e = action.error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(Color.red) }
            if action.status == .pending {
                HStack(spacing: 6) {
                    Button(L(action.verbKey)) {
                        let edited = editing ? draft.trimmingCharacters(in: .whitespacesAndNewlines) : ""
                        let text = edited.isEmpty || edited == action.text ? nil : edited
                        editing = false
                        Task { await model.run(action, api: store.api, editedText: text) }
                    }
                    .buttonStyle(CardButtonStyle(filled: true, tint: danger ? .red : Theme.primaryFill))
                    .accessibilityIdentifier("assistant.card.run")
                    if action.kind == .sendMessage && !editing {
                        Button(L("ai.edit")) { draft = action.text; editing = true }
                            .buttonStyle(CardButtonStyle(filled: false, tint: Theme.textPrimary))
                            .accessibilityIdentifier("assistant.card.edit")
                        Button(L("ai.redo")) { Task { await model.redo(action, api: store.api) } }
                            .buttonStyle(CardButtonStyle(filled: false, tint: Theme.textPrimary))
                            .accessibilityIdentifier("assistant.card.redo")
                    }
                    Button(L("ai.discard")) { model.discard(action) }
                        .buttonStyle(CardButtonStyle(filled: false, tint: Theme.textPrimary))
                        .accessibilityIdentifier("assistant.card.discard")
                }
                .padding(.top, 2)
            }
            if action.status == .done && (action.undoToken != nil || action.link != nil) {
                HStack(spacing: 8) {
                    if let link = action.link, Assistant.deepLink(link) != nil {
                        Button(L("ai.openIt")) { onOpen(link) }
                            .buttonStyle(CardButtonStyle(filled: false, tint: Theme.textPrimary))
                            .accessibilityIdentifier("assistant.card.open")
                    }
                    if action.undoToken != nil {
                        Button(L("ai.undo")) { Task { await model.undo(action, api: store.api) } }
                            .buttonStyle(CardButtonStyle(filled: false, tint: Theme.textPrimary))
                            .accessibilityIdentifier("assistant.card.undo")
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(action.status == .pending ? accent.opacity(0.8) : Theme.textSecondary.opacity(0.22),
                                                                 lineWidth: action.status == .pending ? 1.5 : 1))
        .opacity(action.status == .undone ? 0.55 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.card.\(action.kind.rawValue)")
    }
}

private struct CardButtonStyle: ButtonStyle {
    var filled: Bool
    var tint: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(filled ? Theme.onPrimary : tint)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .frame(minHeight: 30)
            .background(Capsule().fill(filled ? tint : Theme.bubbleOther))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Tres puntos mientras gg piensa.
private struct ThinkingDots: View {
    @State private var phase = 0
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle().fill(Theme.textSecondary).frame(width: 7, height: 7).opacity(phase == i ? 1 : 0.35)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.bubbleOther))
        .accessibilityElement()
        .accessibilityLabel(L("common.wait"))
        .accessibilityIdentifier("assistant.thinking")
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 300_000_000)
                phase = (phase + 1) % 3
            }
        }
    }
}

/// Onda mientras escucha.
private struct ListeningWave: View {
    @State private var on = false
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<5, id: \.self) { i in
                Capsule().fill(Theme.accentText).frame(width: 3, height: on ? [10, 18, 12, 20, 9][i] : [6, 8, 5, 9, 6][i])
            }
        }
        .frame(height: 22)
        .animation(.easeInOut(duration: 0.45).repeatForever(autoreverses: true), value: on)
        .onAppear { on = true }
        .accessibilityHidden(true)
    }
}

/// Chips en varias líneas.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0 && x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            row = max(row, size.height)
        }
        return CGSize(width: min(maxX, width), height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

// MARK: - Marca de gg

/// Marca de gg (chaggu-marca/gg/gg-marca.svg): las dos «g» del logo como burbujas (tinta y naranja, con puntitos) y
/// estrellitas de IA. Se dibuja en vectorial con el mismo lienzo del SVG (viewBox -20 -200 820 810).
/// Las estrellitas titilan suave cada ~2,8 s (como gg-marca-animada.svg), salvo con «Reducir movimiento».
struct GGMark: View {
    /// Color de la «g» oscura y de la estrellita pequeña (tinta de la marca; en el encabezado oscuro, el texto principal).
    var ink: Color = Theme.ink
    var animated = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim: [Bool] = [false, false, false]

    static let box = CGRect(x: -20, y: -200, width: 820, height: 810)
    private static let orange = Color(hex: 0xFF5A36)
    /// Estrellitas: centro, radio (medio ancho) y si es naranja.
    private static let stars: [(c: CGPoint, r: CGFloat, orange: Bool)] = [
        (CGPoint(x: 680, y: -30), 92, true), (CGPoint(x: 560, y: -150), 44, true), (CGPoint(x: 770, y: 95), 30, false),
    ]

    var body: some View {
        ZStack {
            Canvas { ctx, size in
                let s = min(size.width / Self.box.width, size.height / Self.box.height)
                ctx.translateBy(x: (size.width - Self.box.width * s) / 2, y: (size.height - Self.box.height * s) / 2)
                ctx.scaleBy(x: s, y: s)
                ctx.translateBy(x: -Self.box.minX, y: -Self.box.minY)
                Self.drawLetters(ctx, ink: ink)
            }
            GeometryReader { geo in
                ForEach(0..<3, id: \.self) { i in
                    let st = Self.stars[i]
                    Self.StarShape(center: st.c, radius: st.r)
                        .fill(st.orange ? Self.orange : ink)
                        .scaleEffect(dim[i] ? 0.55 : 1, anchor: Self.anchor(st.c, in: geo.size))
                        .rotationEffect(.degrees(dim[i] ? 45 : 0), anchor: Self.anchor(st.c, in: geo.size))
                        .opacity(dim[i] ? 0.6 : 1)
                }
            }
        }
        .aspectRatio(Self.box.width / Self.box.height, contentMode: .fit)
        .accessibilityHidden(true)
        .task(id: animated && !reduceMotion) {
            // Pruebas de interfaz (-TCNoAnimations YES): sin titileo, para que la app quede quieta entre consultas.
            guard animated && !reduceMotion && !AppConfig.launchFlag("TCNoAnimations") else { dim = [false, false, false]; return }
            while !Task.isCancelled {
                for (i, delay) in [(0, 0.0), (1, 0.5), (2, 1.1)] {
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: UInt64((2.0 + delay) * 1_000_000_000))
                        withAnimation(.easeInOut(duration: 0.34)) { dim[i] = true }
                        try? await Task.sleep(nanoseconds: 340_000_000)
                        withAnimation(.easeInOut(duration: 0.5)) { dim[i] = false }
                    }
                }
                try? await Task.sleep(nanoseconds: 2_800_000_000)
            }
        }
    }

    /// Punto del lienzo del SVG como ancla relativa dentro de `size` (contenido centrado y ajustado).
    private static func anchor(_ p: CGPoint, in size: CGSize) -> UnitPoint {
        let s = min(size.width / box.width, size.height / box.height)
        let ox = (size.width - box.width * s) / 2, oy = (size.height - box.height * s) / 2
        guard size.width > 0, size.height > 0 else { return .center }
        return UnitPoint(x: (ox + (p.x - box.minX) * s) / size.width, y: (oy + (p.y - box.minY) * s) / size.height)
    }

    private static func body(x: CGFloat) -> Path {
        Path(roundedRect: CGRect(x: x, y: 0, width: 330, height: 250), cornerRadius: 118)
    }

    private static func descender(x: CGFloat) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: x + 286, y: 150))
        p.addLine(to: CGPoint(x: x + 286, y: 336))
        p.addCurve(to: CGPoint(x: x + 182, y: 428), control1: CGPoint(x: x + 286, y: 408), control2: CGPoint(x: x + 248, y: 428))
        p.addLine(to: CGPoint(x: x + (x == 0 ? 110 : 104), y: 428))
        return p
    }

    private static func dots(x: CGFloat) -> Path {
        var p = Path()
        for cx in [105.0, 165, 225] { p.addEllipse(in: CGRect(x: x + cx - 23, y: 102, width: 46, height: 46)) }
        return p
    }

    private static func drawLetters(_ ctx: GraphicsContext, ink: Color) {
        let round = StrokeStyle(lineWidth: 88, lineCap: .round)
        // «g» oscura, recortada por los puntitos y por un margen alrededor de la naranja.
        ctx.drawLayer { l in
            l.fill(body(x: 0), with: .color(ink))
            var tail = Path()
            tail.move(to: CGPoint(x: 34, y: 196)); tail.addLine(to: CGPoint(x: 14, y: 300)); tail.addLine(to: CGPoint(x: 118, y: 238)); tail.closeSubpath()
            l.fill(tail, with: .color(ink))
            l.stroke(tail, with: .color(ink), style: StrokeStyle(lineWidth: 10, lineJoin: .round))
            l.stroke(descender(x: 0), with: .color(ink), style: round)
            l.blendMode = .destinationOut
            l.fill(body(x: 300), with: .color(.black))
            l.stroke(body(x: 300), with: .color(.black), lineWidth: 56)
            l.fill(dots(x: 0), with: .color(.black))
        }
        // «g» naranja con sus puntitos.
        ctx.drawLayer { l in
            l.fill(body(x: 300), with: .color(orange))
            l.stroke(descender(x: 300), with: .color(orange), style: round)
            l.blendMode = .destinationOut
            l.fill(dots(x: 300), with: .color(.black))
        }
    }

    /// Estrellita de 4 puntas con lados curvos (misma curva del SVG).
    struct StarShape: Shape {
        var center: CGPoint
        var radius: CGFloat
        func path(in rect: CGRect) -> Path {
            let s = min(rect.width / GGMark.box.width, rect.height / GGMark.box.height)
            let ox = rect.minX + (rect.width - GGMark.box.width * s) / 2, oy = rect.minY + (rect.height - GGMark.box.height * s) / 2
            func pt(_ dx: CGFloat, _ dy: CGFloat) -> CGPoint {
                CGPoint(x: ox + (center.x + dx * radius - GGMark.box.minX) * s, y: oy + (center.y + dy * radius - GGMark.box.minY) * s)
            }
            // En el SVG, los controles están a ~0,098 r y ~0,28 r del centro sobre cada eje.
            let a: CGFloat = 0.098, b: CGFloat = 0.28
            var p = Path()
            p.move(to: pt(0, -1))
            p.addCurve(to: pt(1, 0), control1: pt(a, -b), control2: pt(b, -a))
            p.addCurve(to: pt(0, 1), control1: pt(b, a), control2: pt(a, b))
            p.addCurve(to: pt(-1, 0), control1: pt(-a, b), control2: pt(-b, a))
            p.addCurve(to: pt(0, -1), control1: pt(-b, -a), control2: pt(-a, -b))
            p.closeSubpath()
            return p
        }
    }
}
