import SwiftUI

// MARK: - Sidechats (SPEC-v4 G). El API sigue siendo `deriveKind:'side'`.

/// Lógica pura de los sidechats (se prueba en unitarias).
enum SideLogic {
    /// Sugerencias arriba del selector: autor del mensaje, gente mencionada y colegas frecuentes (máx. 6, sin mí).
    static func suggestions(_ d: BootstrapDTO, candidates: [PersonDTO], message: MessageDTO, limit: Int = 6) -> [PersonDTO] {
        let allowed = Dictionary(candidates.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [PersonDTO] = []
        func add(_ id: String?) { if let id, id != d.me.id, let p = allowed[id], !out.contains(where: { $0.id == id }) { out.append(p) } }
        add(message.authorId)
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let body = fold(message.body)
        for p in candidates {
            let full = fold(p.name), first = full.split(separator: " ").first.map(String.init) ?? full
            if body.contains("@" + first) || body.contains("@" + full) || (full.count > 4 && body.contains(full)) { add(p.id) }
        }
        // Frecuentes: personas de mis conversaciones con actividad más reciente.
        for c in d.conversations.sorted(by: { HomeOrder.activity($0) > HomeOrder.activity($1) }).prefix(12) {
            for id in c.memberIds { add(id) }
            if out.count >= limit { break }
        }
        return Array(out.prefix(limit))
    }

    /// Mensajes del sidechat para el chip-hilo (igual que la web: lastMessageSeq − 1, sin el de sistema).
    static func messageCount(_ side: ConversationDTO) -> Int { max(0, side.lastMessageSeq - 1) }

    /// Respuestas del sidechat (sin el mensaje de sistema ni la pregunta inicial).
    static func replyCount(_ side: ConversationDTO, loaded: [MessageDTO]?) -> Int {
        if let loaded {
            let humans = loaded.filter { !$0.isSystem && $0.deletedAt == nil }
            return max(0, humans.count - 1)
        }
        // Sin cargar: seq 1 = side.started y seq 2 = la pregunta.
        return max(0, side.lastMessageSeq - 2)
    }

    /// Conector curvo del split: del borde derecho de la burbuja ancla al panel. Si el ancla no está en pantalla,
    /// sale del borde superior o inferior del chat (según dónde estuvo por última vez).
    static func connector(anchor: CGRect?, target: CGPoint, chatHeight: CGFloat, lastY: CGFloat?) -> (start: CGPoint, end: CGPoint, c1: CGPoint, c2: CGPoint, visible: Bool) {
        let start: CGPoint
        var visible = true
        if let a = anchor, a.midY >= 0, a.midY <= chatHeight {
            start = CGPoint(x: a.maxX + 4, y: a.midY)
        } else {
            visible = false
            let above = (anchor?.midY ?? lastY ?? 0) < chatHeight / 2
            start = CGPoint(x: max(target.x - 90, 0), y: above ? 6 : chatHeight - 6)
        }
        let dx = max(40, (target.x - start.x) * 0.5)
        return (start, target, CGPoint(x: start.x + dx, y: start.y), CGPoint(x: target.x - dx, y: target.y), visible)
    }
}

/// Posición de la burbuja ancla (para el conector y la línea) y de la tarjeta del ancla en el panel.
/// "anchor" = burbuja ancla en el chat; "target" = tarjeta del ancla en el panel.
struct SideAnchorKey: PreferenceKey {
    static let defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) { value.merge(nextValue()) { $1 } }
}

/// Recuerda dónde estuvo el ancla (sin provocar redibujos).
final class ConnectorMemory { var lastY: CGFloat? }

// MARK: - Iniciar

/// «Preguntar en un sidechat»: el mensaje ancla arriba como burbuja, personas en chips con sugerencias,
/// «¿Qué quieres preguntar?» con foco y Enviar. Con una sola persona, Enter envía.
struct NewSideSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    let message: MessageDTO
    /// Personas ya elegidas (p. ej. «Preguntarle en un sidechat» desde una mención a alguien que no está).
    var preselect: [String] = []
    var onCreated: (String) -> Void

    @State private var query = ""
    @State private var chosen: [String] = []
    @State private var outsiders: Set<String> = []
    @State private var question = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showAll = false
    @FocusState private var questionFocused: Bool

    var body: some View {
        NavigationStack {
            if let d = store.data {
                let cand = store.sideCandidates(conversationId)
                let suggested = SideLogic.suggestions(d, candidates: cand.members + cand.colleagues, message: message)
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        SideAnchorBubble(d: d, message: message)
                        VStack(alignment: .leading, spacing: 8) {
                            Text(L("side.pickPeople")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                            chipsRow(d)
                            if !suggested.isEmpty {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 14) { ForEach(suggested) { p in suggestion(d, p) } }.padding(.vertical, 2)
                                }
                            }
                            Button { withAnimation { showAll.toggle() } } label: {
                                Label(showAll ? L("side.lessPeople") : L("side.morePeople"), systemImage: showAll ? "chevron.up" : "person.2")
                                    .font(.footnote.weight(.semibold))
                            }
                            .foregroundStyle(Theme.accentText)
                            .accessibilityIdentifier("side.morePeople")
                            if showAll { fullList(d, cand) }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            TextField(L("side.question"), text: $question, axis: .vertical)
                                .lineLimit(2...6)
                                .focused($questionFocused)
                                .submitLabel(.send)
                                .onSubmit { if chosen.count == 1 && !question.trimmingCharacters(in: .whitespaces).isEmpty { submit() } }
                                .padding(12)
                                .background(RoundedRectangle(cornerRadius: 16).fill(Theme.surface))
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.orange.opacity(questionFocused ? 0.8 : 0.25), lineWidth: 1.5))
                                .accessibilityLabel(L("side.question"))
                                .accessibilityIdentifier("side.question")
                            Label(L("side.private"), systemImage: "lock.fill").font(.caption).foregroundStyle(Theme.textSecondary)
                            if chosen.count == 1 { Text(L("side.enterSends")).font(.caption2).foregroundStyle(Theme.textSecondary) }
                        }
                        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    }
                    .padding(16)
                }
                .background(Theme.background.ignoresSafeArea())
                .navigationTitle(L("side.ask"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        if busy { ProgressView() } else {
                            Button(L("chat.send"), action: submit).bold().disabled(chosen.isEmpty).accessibilityIdentifier("side.submit")
                        }
                    }
                }
                .onAppear {
                    if chosen.isEmpty, !preselect.isEmpty { chosen = preselect }
                    else if chosen.isEmpty, let first = suggested.first, first.id == message.authorId { chosen = [first.id] }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { questionFocused = true }
                }
            }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder private func chipsRow(_ d: BootstrapDTO) -> some View {
        if chosen.isEmpty {
            Text(L("side.pickHint")).font(.subheadline).foregroundStyle(Theme.textSecondary)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(chosen.compactMap { Naming.person(d, $0) }) { p in
                        Button { chosen.removeAll { $0 == p.id } } label: {
                            HStack(spacing: 5) {
                                Avatar(person: p, org: Naming.org(d, p.orgId), size: 24)
                                Text(p.name.split(separator: " ").first.map(String.init) ?? p.name).font(.subheadline.weight(.semibold))
                                Image(systemName: "xmark").font(.caption2.weight(.bold))
                            }
                            .padding(.leading, 3).padding(.trailing, 10).padding(.vertical, 3)
                            .background(Capsule().fill(Theme.orange.opacity(0.15)))
                            .foregroundStyle(Theme.textPrimary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L("sideq.removeChip", ["name": p.name]))
                        .accessibilityIdentifier("side.chosen.\(p.id)")
                    }
                }
            }
        }
    }

    private func suggestion(_ d: BootstrapDTO, _ p: PersonDTO) -> some View {
        let on = chosen.contains(p.id)
        return Button { toggle(p.id) } label: {
            VStack(spacing: 4) {
                Avatar(person: p, org: Naming.org(d, p.orgId), size: 48)
                    .overlay(alignment: .bottomTrailing) {
                        if on { Image(systemName: "checkmark.circle.fill").foregroundStyle(.white, Theme.bubbleMine).font(.system(size: 18)) }
                    }
                    .overlay(Circle().stroke(on ? Theme.bubbleMine : .clear, lineWidth: 2.5).padding(-3))
                Text(p.name.split(separator: " ").first.map(String.init) ?? p.name).font(.caption).lineLimit(1).frame(width: 60)
                    .foregroundStyle(Theme.textPrimary)
            }
        }
        .buttonStyle(.plain)
        .disabled(store.blockedUserIds.contains(p.id) || outsiders.contains(p.id))
        .accessibilityLabel(p.name)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("side.person.\(p.id)")
    }

    @ViewBuilder private func fullList(_ d: BootstrapDTO, _ cand: (members: [PersonDTO], colleagues: [PersonDTO])) -> some View {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        let filter: ([PersonDTO]) -> [PersonDTO] = { list in
            q.isEmpty ? list : list.filter { p in [p.name, p.title, p.area].compactMap { $0 }.contains { fold($0).contains(q) } }
        }
        VStack(alignment: .leading, spacing: 6) {
            TextField(L("side.search"), text: $query).textFieldStyle(.roundedBorder).accessibilityIdentifier("side.search")
            let members = filter(cand.members), colleagues = filter(cand.colleagues)
            if !members.isEmpty { Text(L("side.inChat")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary); ForEach(members) { row(d, $0) } }
            if !colleagues.isEmpty { Text(L("side.colleagues")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary); ForEach(colleagues) { row(d, $0) } }
            if members.isEmpty && colleagues.isEmpty { Text(L("sideq.nobody")).foregroundStyle(Theme.textSecondary) }
        }
    }

    private func row(_ d: BootstrapDTO, _ p: PersonDTO) -> some View {
        let blocked = store.blockedUserIds.contains(p.id)
        let outsider = outsiders.contains(p.id)
        let disabled = blocked || outsider
        let on = chosen.contains(p.id)
        return Button { if on || !disabled { toggle(p.id) } } label: {
            HStack(spacing: 10) {
                Avatar(person: p, org: Naming.org(d, p.orgId), size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(p.name).foregroundStyle(Theme.textPrimary)
                    let line = disabled ? L(blocked ? "sideq.blocked" : "sideq.outsider")
                        : [Naming.roleLine(p), Naming.org(d, p.orgId)?.name ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
                    Text(line).font(.caption).foregroundStyle(disabled ? .red : Theme.textSecondary)
                }
                Spacer()
                Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundStyle(on ? Theme.accentText : Theme.textSecondary)
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .opacity(disabled ? 0.55 : 1)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("side.row.\(p.id)")
    }

    private func toggle(_ id: String) {
        if let i = chosen.firstIndex(of: id) { chosen.remove(at: i) } else { chosen.append(id) }
        Haptics.tap()
    }

    private func submit() {
        guard !chosen.isEmpty, !busy else { return }
        busy = true; error = nil
        Task {
            do {
                let id = try await store.createSide(conversationId, messageId: message.id, userIds: chosen, question: question)
                dismiss()
                onCreated(id)
            } catch let e as ApiRequestError where e.code == "side_outsider" {
                outsiders.formUnion(e.userIds)
                chosen.removeAll { e.userIds.contains($0) }
                error = L("err.side_outsider")
            } catch {
                self.error = L10n.errorText(error)
            }
            busy = false
        }
    }
}

/// El mensaje ancla con su estilo de burbuja original y el avatar de quien lo escribió.
struct SideAnchorBubble: View {
    let d: BootstrapDTO
    let message: MessageDTO
    var body: some View {
        let author = Naming.person(d, message.authorId)
        let mine = message.authorId == d.me.id
        HStack(alignment: .top, spacing: 8) {
            Avatar(person: author, org: Naming.org(d, author?.orgId), size: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(author?.name ?? "").font(.caption.weight(.semibold)).foregroundStyle(PersonColor.text(message.authorId))
                Text(message.body.isEmpty ? L10n.messagePreview(message) : message.body)
                    .font(.body).lineLimit(5)
                    .foregroundStyle(mine ? .white : Theme.textPrimary)
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 18).fill(mine ? Theme.bubbleMine : Theme.bubbleOther))
                Text(L10n.clock(message.createdAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("side.anchorBubble")
    }
}

// MARK: - Panel

/// Panel del sidechat: cabecera (avatares, «Privado · solo ustedes N», cerrar, ⋯), tarjeta del ancla fija y el chat compacto.
struct SidePanel: View {
    @Environment(AppStore.self) private var store
    let sideId: String
    var onClose: () -> Void
    /// «Ver en el chat»: en iPad desplaza el chat; en iPhone minimiza y resalta el ancla.
    var onSeeInChat: (() -> Void)?
    @State private var returning = false
    @State private var adding = false

    /// En la hoja (teléfono) tiene su propia navegación; en el split vive dentro de la del chat
    /// (un NavigationStack anidado en un destino hace que el de fuera vuelva atrás).
    var ownsNavigation = true

    var body: some View {
        if ownsNavigation {
            NavigationStack { content.toolbar(.hidden, for: .navigationBar).routes() }
        } else {
            content
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            header
            anchorCard
            ConversationView(conversationId: sideId, embedded: true)
        }
        .background(Theme.background)
        .sheet(isPresented: $returning) { ReturnResultSheet(conversationId: sideId) }
        .sheet(isPresented: $adding) { AddMembersSheet(conversationId: sideId) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("side.panel")
    }

    @ViewBuilder private var header: some View {
        if let d = store.data, let c = store.meta(sideId) {
            HStack(spacing: 10) {
                StackedAvatars(d: d, c: c, size: 28)
                    .frame(width: 28 + CGFloat(max(0, min(3, Naming.others(d, c).count) - 1)) * 15, alignment: .leading)
                VStack(alignment: .leading, spacing: 1) {
                    Text(L("side.title")).font(.headline)
                    Label(L("side.privateN", ["n": c.memberIds.count]), systemImage: "lock.fill")
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                Menu {
                    Button { adding = true } label: { Label(L("side.addPerson"), systemImage: "person.badge.plus") }
                    MuteMenu(conv: c)
                    if c.returnedAt == nil, c.parentId.flatMap({ store.meta($0) })?.canPost == true {
                        Button { returning = true } label: { Label(L("side.return"), systemImage: "arrowshape.turn.up.backward") }
                            .accessibilityIdentifier("side.return")
                    }
                    Divider()
                    Button(role: .destructive) {
                        Task { try? await store.leaveConversation(sideId); onClose() }
                    } label: { Label(L("side.leave"), systemImage: "rectangle.portrait.and.arrow.right") }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold)).frame(width: 36, height: 36)
                        .background(Circle().fill(Theme.surface))
                }
                .accessibilityLabel(L("menu.open"))
                .accessibilityIdentifier("side.menu")
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).frame(width: 36, height: 36)
                        .background(Circle().fill(Theme.surface))
                }
                .foregroundStyle(Theme.textPrimary)
                .accessibilityLabel(L("side.close"))
                .accessibilityIdentifier("side.close")
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)
        }
    }

    /// Tarjeta del ancla: del origen si está cargado; si no, el extracto del mensaje de sistema side.started.
    @ViewBuilder private var anchorCard: some View {
        if let c = store.meta(sideId), let d = store.data {
            let orig = c.parentId.flatMap { pid in store.conversations[pid]?.messages.first { $0.id == c.parentMessageId } }
            let started = store.conversations[sideId]?.messages.first { ($0.systemPayload?["k"] as? String) == "side.started" }?.systemPayload
            let text = orig.map { $0.body.isEmpty ? L10n.messagePreview($0) : $0.body } ?? (started?["excerpt"] as? String) ?? ""
            let authorId = orig?.authorId ?? (started?["authorId"] as? String)
            let author = authorId.flatMap { Naming.person(d, $0) }
            let authorName = author?.name ?? (started?["authorName"] as? String) ?? ""
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(authorId.map { PersonColor.text($0) } ?? Theme.orange).frame(width: 3)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        if let author { Avatar(person: author, org: Naming.org(d, author.orgId), size: 20) }
                        Text(authorName).font(.caption.weight(.semibold))
                        if let orig { Text(L10n.clock(orig.createdAt)).font(.caption2).foregroundStyle(Theme.textSecondary) }
                        Spacer()
                        if let onSeeInChat, orig != nil {
                            Button(L("side.seeInChat"), action: onSeeInChat).font(.caption.weight(.semibold)).foregroundStyle(Theme.accentText)
                                .accessibilityIdentifier("side.seeInChat")
                        }
                    }
                    if !text.isEmpty { Text(text).font(.subheadline).foregroundStyle(Theme.textPrimary).lineLimit(3) }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.orange.opacity(0.25)))
            .anchorPreference(key: SideAnchorKey.self, value: .bounds) { ["target": $0] }
            .padding(.horizontal, 12).padding(.bottom, 6)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("side.anchor")
        }
    }
}

/// Estado vacío del sidechat.
struct SideEmptyState: View {
    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle().fill(Theme.orange.opacity(0.12)).frame(width: 84, height: 84)
                Image(systemName: "bubble.left.and.text.bubble.right.fill").font(.system(size: 34)).foregroundStyle(Theme.orange)
                Image(systemName: "lock.fill").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .padding(6).background(Circle().fill(Theme.bubbleMine)).offset(x: 30, y: 28)
            }
            Text(L("side.emptyChat")).font(.headline).multilineTextAlignment(.center)
        }
        .padding(.top, 30)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("side.empty")
    }
}

/// Respuestas rápidas del lado de quien recibe (se envían al tocar; «No sé, pregúntale a…» abre el selector).
struct SideQuickReplies: View {
    var onSend: (String) -> Void
    var onAskOther: () -> Void
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(L("side.quick.check")) { onSend(L("side.quick.check")) }.accessibilityIdentifier("side.quick.check")
                chip(L("side.quick.ask"), action: onAskOther).accessibilityIdentifier("side.quick.askOther")
                chip(L("side.quick.later")) { onSend(L("side.quick.later")) }.accessibilityIdentifier("side.quick.later")
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
    }
    private func chip(_ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text).font(.subheadline.weight(.medium))
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Capsule().fill(Theme.surface))
                .overlay(Capsule().stroke(Theme.orange.opacity(0.35)))
                .foregroundStyle(Theme.textPrimary)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Chip-hilo bajo el ancla

/// Bajo la burbuja ancla (solo para miembros): avatares, «Sidechat · N respuestas», extracto de la última y punto si hay no leídos.
/// Varios sidechats → «N sidechats» con la lista. Llevado al hilo → chip verde.
struct SideChip: View {
    @Environment(AppStore.self) private var store
    let sides: [ConversationDTO]
    var onOpen: (String) -> Void

    var body: some View {
        if let first = sides.first, let d = store.data {
            Group {
                if sides.count == 1 {
                    Button { onOpen(first.id) } label: { thread(d, first) }
                } else {
                    Menu {
                        ForEach(sides) { s in
                            Button { onOpen(s.id) } label: {
                                Text([Naming.others(d, s).map { $0.name.split(separator: " ").first.map(String.init) ?? $0.name }.joined(separator: ", "),
                                      s.lastHumanPreview?.body].compactMap { $0 }.joined(separator: " · "))
                            }
                        }
                    } label: { multi(d) }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("side.chip.\(first.parentMessageId ?? "")")
        }
    }

    private func thread(_ d: BootstrapDTO, _ s: ConversationDTO) -> some View {
        let n = SideLogic.messageCount(s)
        let returned = s.returnedAt != nil
        let unread = HomeOrder.pending(s) > 0
        let label = returned ? L("side.returnedChip") : L("side.thread", ["n": n == 1 ? L("side.replyOne") : L("side.replies", ["n": n])])
        return HStack(spacing: 8) {
            ThreadCurve().stroke(Theme.orange.opacity(0.6), style: StrokeStyle(lineWidth: 1.5, lineCap: .round)).frame(width: 12, height: 16)
                .offset(y: -8).accessibilityHidden(true)
            StackedAvatars(d: d, c: s, size: 20)
                .frame(width: 20 + CGFloat(max(0, min(3, Naming.others(d, s).count) - 1)) * 11, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.caption.weight(.bold)).foregroundStyle(returned ? Color.green : Theme.accentText)
                if !returned, let last = s.lastHumanPreview, !last.body.isEmpty {
                    Text(last.body).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
            }
            if unread { Circle().fill(Theme.orange).frame(width: 8, height: 8).accessibilityLabel(L("home.tab.unread")) }
            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 14).fill(returned ? Color.green.opacity(0.10) : Theme.orange.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(returned ? Color.green.opacity(0.35) : Theme.orange.opacity(0.25)))
        .accessibilityElement(children: .combine)
    }

    private func multi(_ d: BootstrapDTO) -> some View {
        HStack(spacing: 6) {
            Text(L("side.chipN", ["n": sides.count])).font(.caption.weight(.bold)).foregroundStyle(Theme.accentText)
            if sides.contains(where: { HomeOrder.pending($0) > 0 }) { Circle().fill(Theme.orange).frame(width: 8, height: 8) }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Capsule().fill(Theme.orange.opacity(0.10)))
    }
}

// MARK: - Presentación: split con conector (pantalla ancha) u hoja que se desprende (teléfono)

struct SidePanelPresenter: ViewModifier {
    @Environment(AppStore.self) private var store
    @Binding var sideId: String?
    /// Id del mensaje ancla del sidechat abierto o minimizado.
    var anchorColor: Color = Theme.orange
    /// Pide al chat desplazarse al ancla (y resaltarla).
    var onRevealAnchor: (String) -> Void = { _ in }
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var minimized: String?
    @State private var closing = false
    @State private var memory = ConnectorMemory()

    func body(content: Content) -> some View {
        if sizeClass == .regular { split(content) } else { phone(content) }
    }

    // iPad: chat a la izquierda, sidechat a la derecha (~40 %) y conector curvo que sigue al ancla.
    private func split(_ content: Content) -> some View {
        GeometryReader { g in
            HStack(spacing: 0) {
                content.frame(maxWidth: .infinity)
                if let id = sideId {
                    Divider()
                    SidePanel(sideId: id, onClose: { withAnimation(.spring(response: 0.35)) { sideId = nil } },
                              onSeeInChat: { if let m = store.meta(id)?.parentMessageId { onRevealAnchor(m) } }, ownsNavigation: false)
                        .frame(width: max(340, g.size.width * 0.4))
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .overlayPreferenceValue(SideAnchorKey.self) { anchors in
                GeometryReader { proxy in
                    // Del ancla a la tarjeta del ancla del panel.
                    if sideId != nil { connector(proxy: proxy, anchor: anchors["anchor"], target: anchors["target"], size: g.size) }
                }
                .allowsHitTesting(false)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.9), value: sideId)
    }

    @ViewBuilder private func connector(proxy: GeometryProxy, anchor: Anchor<CGRect>?, target: Anchor<CGRect>?, size: CGSize) -> some View {
        let panelX = size.width - max(340, size.width * 0.4)
        let t = target.map { proxy[$0] }
        let end = CGPoint(x: (t?.minX ?? panelX) + 1, y: t?.midY ?? 120)
        let a = anchor.map { proxy[$0] }
        let geo = SideLogic.connector(anchor: a, target: end, chatHeight: size.height, lastY: memory.lastY)
        let _ = { if let a { memory.lastY = a.midY } }()
        ZStack {
            Path { p in p.move(to: geo.start); p.addCurve(to: geo.end, control1: geo.c1, control2: geo.c2) }
                .stroke(anchorColor, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: geo.visible ? [] : [4, 5]))
            Circle().fill(anchorColor).frame(width: 7, height: 7).position(geo.start)
            Circle().fill(anchorColor).frame(width: 7, height: 7).position(geo.end)
        }
        .accessibilityHidden(true)
    }

    // iPhone: hoja media/grande que sale de la burbuja; con la hoja a medias el ancla sigue visible con una línea
    // que la une al borde de la hoja. Arrastrar abajo = minimizar a una burbuja flotante.
    private func phone(_ content: Content) -> some View {
        content
            .overlayPreferenceValue(SideAnchorKey.self) { anchors in
                GeometryReader { proxy in
                    if sideId != nil, let anchor = anchors["anchor"] {
                        // Por el margen derecho del chat (sin pasar sobre burbujas) hasta el asa de la hoja, con un punto en cada extremo.
                        let r = proxy[anchor]
                        let x = proxy.size.width - 5
                        let sheetTop = UIScreen.main.bounds.height * (1 - 0.58) - proxy.frame(in: .global).minY - 6
                        let start = CGPoint(x: x, y: r.midY), end = CGPoint(x: x, y: max(r.midY + 12, sheetTop))
                        ZStack {
                            Path { p in
                                p.move(to: CGPoint(x: x - 7, y: r.midY)); p.addQuadCurve(to: CGPoint(x: x, y: r.midY + 8), control: CGPoint(x: x, y: r.midY))
                                p.addLine(to: end)
                            }
                            .stroke(anchorColor.opacity(0.85), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                            Circle().fill(anchorColor).frame(width: 6, height: 6).position(CGPoint(x: x - 7, y: start.y))
                            Circle().fill(anchorColor).frame(width: 6, height: 6).position(end)
                        }
                        .accessibilityHidden(true)
                    }
                }
                .allowsHitTesting(false)
            }
            .overlay(alignment: .bottomTrailing) {
                if let id = minimized, sideId == nil { FloatingSideBubble(sideId: id, onOpen: { minimized = nil; sideId = id }, onDrop: { minimized = nil }) }
            }
            .sheet(item: Binding(get: { sideId.map(IdBox.init) }, set: { new in
                // Cerrar con la X = cerrar; arrastrar abajo = minimizar a la burbuja flotante.
                if new == nil, let id = sideId, !closing { minimized = id }
                closing = false
                sideId = new?.id
            })) { box in
                SidePanel(sideId: box.id, onClose: { closing = true; sideId = nil },
                          onSeeInChat: { if let m = store.meta(box.id)?.parentMessageId { onRevealAnchor(m) } })
                    .presentationDetents([.fraction(0.58), .large])
                    .presentationBackgroundInteraction(.enabled(upThrough: .fraction(0.58)))
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(24)
            }
            .onChange(of: sideId) { _, v in if let v, let m = store.meta(v)?.parentMessageId { onRevealAnchor(m) } }
    }
}

/// Burbuja flotante de un sidechat minimizado: avatares apilados + no leídos. Tocar abre; mantener para soltar.
struct FloatingSideBubble: View {
    @Environment(AppStore.self) private var store
    let sideId: String
    var onOpen: () -> Void
    var onDrop: () -> Void

    var body: some View {
        if let d = store.data, let c = store.meta(sideId) {
            Button(action: onOpen) {
                ZStack(alignment: .topTrailing) {
                    StackedAvatars(d: d, c: c, box: 48)
                        .frame(width: 58, height: 58)
                        .background(Circle().fill(Theme.surface))
                        .overlay(Circle().stroke(Theme.orange, lineWidth: 2))
                        .shadow(color: .black.opacity(0.18), radius: 8, y: 4)
                    if c.unread > 0 {
                        Text("\(c.unread)").font(.caption2.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Theme.badgeFallback))
                    }
                }
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button(action: onOpen) { Label(L("side.reopen"), systemImage: "arrow.up.left.and.arrow.down.right") }
                Button(role: .destructive, action: onDrop) { Label(L("side.drop"), systemImage: "xmark") }
            }
            .padding(.trailing, 16).padding(.bottom, 90)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel(L("side.reopen"))
            .accessibilityIdentifier("side.floating")
        }
    }
}

/// Curvita del chip-hilo: baja desde la burbuja ancla y entra al chip.
struct ThreadCurve: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX + 1, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.maxY), control: CGPoint(x: r.minX + 1, y: r.maxY))
        return p
    }
}
