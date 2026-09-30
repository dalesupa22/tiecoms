import SwiftUI
import UIKit

private enum ChatItem: Identifiable {
    case day(String, Date)
    case message(MessageDTO, showAuthor: Bool)
    case system(MessageDTO)
    case pending(PendingMessage)
    /// Línea «N mensajes nuevos» antes del primer no leído (1.6.4).
    case newDivider(Int)

    var id: String {
        switch self {
        case .newDivider: return ChatNavIds.divider
        case .day(let k, _): return "day-\(k)"
        case .message(let m, _), .system(let m): return m.id
        case .pending(let p): return "p-\(p.clientMessageId)"
        }
    }
}

enum ChatNavIds {
    static let divider = "new-divider"
    static let bottom = "bottom"
}

/// Borde inferior del contenido del chat y posición de la línea de no leídos, en coordenadas de la vista del chat.
private struct ChatContentBottomKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
/// Secuencias de filas cuyo centro está dentro de la pantalla; estar por encima no cuenta como visto.
private struct ChatSeenSeqKey: PreferenceKey {
    static let defaultValue: Set<Int> = []
    static func reduce(value: inout Set<Int>, nextValue: () -> Set<Int>) { value.formUnion(nextValue()) }
}
private struct ChatDividerYKey: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

private struct PendingVoiceSend {
    let data: Data
    let durationMs: Int
    let waveform: [Double]
    let replyTo: String?
    /// Una sola vista (el ① estaba prendido al grabar).
    var viewOnce = false
    /// Permiso de IA elegido para esta nota (se conserva al reintentar la subida).
    var aiConsent = false
}

/// Hojas que se abren desde el menú de un mensaje o de la conversación.
enum ChatSheet: Identifiable {
    case derive(MessageDTO), returnResult, newIssue(MessageDTO?), newEvent(MessageDTO?), forward(MessageDTO)
    case reminder(MessageDTO?), pins, issuesHere, report(MessageDTO), threads, agenda, react(MessageDTO)
    /// «⑂ N sin leer en X conversaciones de este grupo · Ver» (2026-09-28).
    case treePending
    /// Reunión con Meet, Teams o Zoom: ahora o agendada (2026-09-28).
    case meeting(now: Bool)
    /// Temas (docs/TEMAS.md): nuevo (desde la fila o para etiquetar un mensaje), renombrar y archivados.
    case newTopic(MessageDTO?), renameTopic(TopicDTO), archivedTopics
    var id: String {
        switch self {
        case .derive(let m): return "derive-\(m.id)"
        case .returnResult: return "return"
        case .newIssue(let m): return "issue-\(m?.id ?? "")"
        case .newEvent(let m): return "event-\(m?.id ?? "")"
        case .forward(let m): return "fwd-\(m.id)"
        case .reminder(let m): return "rem-\(m?.id ?? "")"
        case .report(let m): return "report-\(m.id)"
        case .pins: return "pins"
        case .issuesHere: return "issues"
        case .threads: return "threads"
        case .agenda: return "agenda"
        case .react(let m): return "react-\(m.id)"
        case .treePending: return "tree"
        case .meeting(let now): return "meeting-\(now)"
        case .newTopic(let m): return "topic-new-\(m?.id ?? "")"
        case .renameTopic(let t): return "topic-edit-\(t.id)"
        case .archivedTopics: return "topics-archived"
        }
    }
}

func excerpt(_ s: String, _ n: Int = 120) -> String {
    let t = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    return t.count > n ? String(t.prefix(n)) + "…" : t
}

struct ConversationView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var sizeClass
    let conversationId: String
    /// Dentro del panel de una conversación lateral.
    var embedded = false
    @State private var draft = ""
    @State private var sidePanel: String?
    /// Pide desplazar el chat a un mensaje (ancla de un sidechat) y resaltarlo.
    @State private var reveal: String?
    @State private var addingToSide = false
    /// Menciones del borrador (offsets UTF-16) y ficha de una persona mencionada.
    @State private var draftMentions: [Mention] = []
    /// Programar envío: «Elegir fecha y hora…» y la lista de programados del chat.
    @State private var pickingSchedule = false
    @State private var showScheduled = false
    @State private var personCard: String?
    @State private var sideForPerson: String?
    @State private var highlighted: String?
    @State private var staged: [LocalAttachment] = []
    @State private var uploadProgress: [UUID: Double] = [:]
    @State private var uploading = false
    @State private var askSide: MessageDTO?
    @State private var replyTo: MessageDTO?
    @State private var editing: MessageDTO?
    /// «Comenta esta tarea…» desde su tarjeta: lo que se escribe va como comentario de la tarea (no al chat).
    @State private var commentingIssue: IssueDTO?
    /// «Responder» de la franja de comentarios de un evento (tanda 1.7 §5): el compositor comenta el evento.
    @State private var commentingEvent: CalendarEventDTO?
    /// Para medir de tocar el chat a ver sus mensajes (Perf).
    @State private var openedAt = Date()
    /// Buscar dentro del chat (tanda 1.7 §6).
    @State private var search = ChatSearchState()
    @FocusState private var searchFocused: Bool
    /// ① «una vista» para el próximo mensaje (tanda 1.7 §7).
    @State private var viewOnceNext = false
    @State private var sheet: ChatSheet?
    @State private var confirmDelete: MessageDTO?
    /// Banderita elegida: filtra el chat y es el tema de lo que escribo (nil = «Todo»).
    @State private var topicFilter: String?
    @State private var confirmRemoveTopic: TopicDTO?
    /// Mensajes con tema a los que se saltó desde «Todo»: quedan a la vista aunque «Todo» esconda lo leído de los temas.
    @State private var revealed: Set<Int> = []
    /// El filtro lo puso la apertura (todo lo no leído en un tema): no se baja al final, se queda en el primer no leído.
    @State private var autoFiltered = false
    /// Borde inferior del contenido en la vista (para detectar el hueco en blanco al final, ver ChatContentBottomKey).
    /// Medidas del scroll que cambian en cada fotograma (fondo del contenido, filas visibles y vistas). Viven en una
    /// referencia: escribirlas no vuelve a pintar el chat entero (1.7.1; antes, una pintada por cada arrastre).
    @State private var track = ScrollTrack()
    final class ScrollTrack {
        var contentBottom: CGFloat = 0
        var visibleSeqs: Set<Int> = []
        var seenSeqs: Set<Int> = []
    }
    @State private var gapFix: Task<Void, Never>?
    @State private var blockUserId: String?
    @State private var recorder = VoiceRecorder()
    @State private var pendingVoice: PendingVoiceSend?
    /// Nota cuya subida falló (413, red…): se conserva para reintentar, no se pierde en silencio.
    @State private var failedVoice: PendingVoiceSend?
    @State private var showingVoiceAIConsent = false
    @State private var composerFocused = false
    /// Cursor del compositor (UTF-16).
    @State private var draftCursor = 0
    /// ✅ sobre un mensaje que abrió un asunto aún abierto: «¿Cerrar también el asunto?».
    @State private var closeIssuePrompt: String?
    // 1.6.4 · Navegar un chat largo (SPEC-bandeja D).
    /// Lo no leído al abrir (antes de marcar leído); la línea «N mensajes nuevos» queda hasta salir del chat.
    @State private var unreadSnap: ChatNav.Snapshot?
    @State private var readingSession: AppStore.SessionStamp?
    /// Primer mensaje no leído (la línea va justo antes).
    @State private var dividerId: String?
    /// Ya se colocó el chat al abrir (en el primer no leído o al final).
    @State private var positioned = false
    /// Hay una página vieja en camino (no se pide otra a la vez).
    @State private var loadingOlder = false
    /// A más de una pantalla del final: sale el botón ⌄ y los mensajes nuevos no arrastran la vista.
    @State private var farFromBottom = false
    /// Último seq visto estando al final: lo que llegue después cuenta en el globo del ⌄.
    @State private var bottomSeq = 0
    /// La línea de no leídos quedó por encima de la vista: píldora «↑ N nuevos».
    @State private var dividerAbove = false
    /// Menciones a mí sin leer al abrir, por visitar con el botón «@».
    @State private var mentionQueue: [String] = []
    @State private var viewportHeight: CGFloat = 0
    /// Al final del chat (a menos de 40 pt); esto no implica que se hayan visto las filas anteriores.
    @State private var atBottom = false
    /// Filas visibles y visitadas desde la colocación inicial, sin saltar huecos del cursor.
    @State private var readPauseID: UUID?
    @State private var positioning = false
    @State private var positioningFailed = false

    var body: some View {
        let _ = PerfCounters.bump("chat.body")
        Group {
            if let d = store.data, let c = store.meta(conversationId) {
                content(d, c).modifier(removeTopicDialog)
            } else {
                ContentUnavailableView(L("chat.notFound"), systemImage: "lock.slash")
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        // Cabecera opaca: los mensajes no se ven por detrás del título ni de las pestañas.
        .toolbarBackground(Theme.background, for: .navigationBar)
        // Solo en pantalla ancha (en iPhone el vidrio del sistema se ve bien y el color fijo se oscurecía con el teclado).
        .toolbarBackground(!embedded && sizeClass == .regular ? .visible : .automatic, for: .navigationBar)
        .onAppear {
            snapshotUnread()
            // Un hilo o sidechat abierto al lado recibe el cursor.
            if embedded { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { composerFocused = true } }
            store.openConversationId = conversationId
            // A los 15 min la grabación se detiene sola: se envía lo grabado (pasa por el permiso de IA).
            recorder.onAutoStop = { if let r = recorder.finish() { sendVoice(r.data, r.durationMs, r.waveform) } }
            let id = conversationId
            VoicePlayer.shared.nextProvider = { [weak store] finished in
                VoicePlayer.next(after: finished, in: store?.conversations[id]?.messages ?? [])
            }
        }
        .modifier(BurstLayer(conversationId: conversationId))
        .onDisappear {
            store.cancelConversationRecovery(conversationId)
            if store.openConversationId == conversationId { store.openConversationId = nil }
        }
        .task(id: conversationId) {
            // Temas en paralelo con los mensajes; la llamada en curso (franja «Unirse») llega después en vivo con call.updated.
            let id = conversationId
            Task { try? await store.loadTopics(id) }
            if store.data?.callsEnabled == true, !embedded { Task { await store.loadCall(id) } }
            // Un 502/503/504 (API reiniciándose en un despliegue) o un corte de red se reintentan solos ≈30 s;
            // el borrador del compositor es estado de esta vista y no se pierde.
            let stamp = store.sessionStamp
            guard await store.openConversationRecovering(conversationId), !Task.isCancelled, stamp == store.sessionStamp else { return }
            // Sugerencias de la hoja de compartir: abrir una conversación también cuenta (como mucho una vez por hora).
            Donations.donate(store, conversationId: conversationId, minInterval: 3600)
            _ = try? await store.loadPins(conversationId)
            guard !Task.isCancelled, stamp == store.sessionStamp else { return }
            _ = try? await store.loadIssues(conversationId: conversationId)
            guard !Task.isCancelled, stamp == store.sessionStamp else { return }
            _ = try? await store.loadEvents(from: Date().addingTimeInterval(-30 * 86400), to: Date().addingTimeInterval(90 * 86400), conversationId: conversationId)
        }
        .sheet(item: $sheet) { s in sheetView(s) }
        .sheet(item: Binding(get: { askSide }, set: { askSide = $0 })) { m in
            NewSideSheet(conversationId: conversationId, message: m, preselect: sideForPerson.map { [$0] } ?? []) { id in sidePanel = id; sideForPerson = nil }
        }
        // iPad / pantalla ancha: panel a la derecha; iPhone: hoja casi completa sobre el chat.
        .modifier(SidePanelPresenter(sideId: $sidePanel,
                                     anchorColor: activeAnchor.flatMap { id in store.conversations[conversationId]?.messages.first { $0.id == id } }
                                        .map { PersonColor.text($0.authorId) } ?? Theme.orange,
                                     onRevealAnchor: { reveal = $0 }))
        // Push de un sidechat: abre el origen con el sidechat desplegado.
        .onChange(of: store.sideToOpen[conversationId], initial: true) { _, v in
            if let v { sidePanel = v; store.sideToOpen[conversationId] = nil }
        }
        .sheet(isPresented: $addingToSide) { AddMembersSheet(conversationId: conversationId) }
        .sheet(item: Binding(get: { personCard.map(IdBox.init) }, set: { personCard = $0?.id })) { box in
            PersonCardSheet(personId: box.id).presentationDetents([.height(300)])
        }
        // Tocar una mención abre la ficha de la persona.
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == "chaggu-mention", let id = url.host { personCard = id; return .handled }
            if url.scheme == "chaggu-ref", let id = url.host { openRef(id); return .handled }
            return .systemAction
        })
        .onChange(of: sidePanel) { _, v in if v == nil { store.openConversationId = conversationId } }
        .confirmationDialog(L("safety.blockConfirm"), isPresented: Binding(get: { blockUserId != nil }, set: { if !$0 { blockUserId = nil } }), titleVisibility: .visible) {
            Button(L("safety.block"), role: .destructive) {
                if let id = blockUserId { act(toast: L("safety.blocked")) { try await store.setUserBlocked(id, blocked: true) } }
            }
            Button(L("common.cancel"), role: .cancel) {}
        } message: { Text(L("safety.blockHint")) }
        .confirmationDialog(L("menu.deleteConfirm"), isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button(L("menu.delete"), role: .destructive) {
                if let m = confirmDelete { act { try await store.deleteMessage(m.id) } }
            }
            Button(L("common.cancel"), role: .cancel) {}
        }
        .confirmationDialog(L("react.closeIssue", ["title": closeIssuePrompt.flatMap { store.issues[$0]?.title } ?? ""]),
                            isPresented: Binding(get: { closeIssuePrompt != nil }, set: { if !$0 { closeIssuePrompt = nil } }), titleVisibility: .visible) {
            Button(L("react.closeIssueBtn")) {
                if let id = closeIssuePrompt { act(toast: L("react.issueClosed")) { try await store.setIssueStatus(id, .done) } }
            }
            Button(L("common.cancel"), role: .cancel) {}
        }
        .alert(L("ai.voice.title"), isPresented: $showingVoiceAIConsent, presenting: pendingVoice) { voice in
            Button(L("ai.voice.allow")) { uploadVoice(voice, aiConsent: true) }
            Button(L("ai.voice.without")) { uploadVoice(voice, aiConsent: false) }
            Button(L("common.cancel"), role: .cancel) { pendingVoice = nil }
        } message: { _ in Text(L("ai.voice.message")) }
    }

    /// Quitar un tema: pide confirmación; sus mensajes quedan sin tema y no se borra ningún mensaje.
    private var removeTopicDialog: RemoveTopicDialog {
        RemoveTopicDialog(topic: $confirmRemoveTopic, count: confirmRemoveTopic.flatMap { topicCounts[$0.id] } ?? 0) { t in
            if topicFilter == t.id { topicFilter = nil }
            act(toast: L("topic.removed", ["name": t.name])) { try await store.deleteTopic(t) }
        }
    }

    @ViewBuilder private func sheetView(_ s: ChatSheet) -> some View {
        switch s {
        // El hilo nuevo se abre al lado, sin salir del chat (como en Slack).
        case .derive(let m): DeriveSheet(conversationId: conversationId, message: m) { id in openThread(id) }
        case .returnResult: ReturnResultSheet(conversationId: conversationId)
        case .newIssue(let m): NewIssueSheet(conversationId: conversationId, origin: m, topicId: activeTopic?.id)
        case .newEvent(let m): EventEditorSheet(conversationId: conversationId, origin: m, event: nil)
        case .forward(let m): ForwardSheet(source: m)
        case .reminder(let m): ReminderSheet(conversationId: conversationId, message: m)
        case .report(let m): ReportContentSheet(userId: m.authorId, messageId: m.id)
        case .pins: PinsSheet(conversationId: conversationId)
        case .issuesHere: ConversationIssuesSheet(conversationId: conversationId)
        case .threads: ChatThreadsSheet(conversationId: conversationId) { id in openThread(id) }
        case .meeting(let now): MeetingSheet(conversationId: conversationId, now: now)
        case .treePending:
            TreePendingSheet(conversationId: conversationId) { id in
                // Un hilo se abre al lado (como en Slack); una rama o interna, a pantalla completa.
                if let x = store.meta(id), Naming.isThread(x) { openThread(id) } else { store.push(.conversation(id)) }
            }
        case .react(let m): EmojiPickerSheet(actions: store.data.map(Reactions.actionsEnabled) ?? true) { e in react(m, e) }
        case .agenda:
            let c = store.meta(conversationId)
            ChatAgendaSheet(conversationId: conversationId,
                            onNewEvent: c?.canPost == true ? { sheet = .newEvent(nil) } : nil,
                            onNewIssue: canOpenIssues ? { sheet = .newIssue(nil) } : nil)
        case .newTopic(let m):
            // Desde la fila: el tema nuevo queda elegido. Desde un mensaje: se le pone al mensaje.
            TopicEditorSheet(conversationId: conversationId) { t in
                if let m { MessageTopicMenu.set(store, m, t.id, list: store.topics[conversationId] ?? []) } else { topicFilter = t.id }
            }
        case .renameTopic(let t): TopicEditorSheet(conversationId: conversationId, edit: t)
        case .archivedTopics: ArchivedTopicsSheet(conversationId: conversationId)
        }
    }

    /// «Todo» (con temas activos): todos los mensajes con su etiqueta; lo que se escribe va sin tema.
    private var showAll: Bool { !embedded && topicFilter == TopicRules.all && !activeTopicIds.isEmpty }

    /// Saltar a un mensaje (búsqueda, mención, enlace o notificación): el filtro pasa a su tema, o a General. En Todo no cambia.
    private func followTopic(_ m: MessageDTO?) {
        guard !embedded, let m else { return }
        let want = TopicRules.filterForJump(m, current: showAll ? TopicRules.all : activeTopic?.id, active: activeTopicIds)
        if want != (showAll ? TopicRules.all : activeTopic?.id) { autoFiltered = true; topicFilter = want }
    }

    /// Tema elegido si sigue activo (si lo archivan o quitan en otro dispositivo, el chat vuelve a «General»).
    private var activeTopic: TopicDTO? {
        guard !embedded, let id = TopicRules.effectiveFilter(topicFilter, in: store.topics[conversationId] ?? []) else { return nil }
        return store.topics[conversationId]?.first { $0.id == id }
    }

    private var topicCounts: [String: Int] { TopicRules.counts(store.conversations[conversationId]?.messages ?? []) }
    private var activeTopicIds: Set<String> { embedded ? [] : TopicRules.activeIds(store.topics[conversationId] ?? []) }
    /// Lo leído al abrir (la regla de «Todo» no cambia mientras se lee).
    private var baseRead: Int { max(unreadSnap?.lastReadSeq ?? store.meta(conversationId)?.lastReadSeq ?? 0, store.meta(conversationId)?.historyFromSeq ?? 0) }
    /// Sin leer por banderita, con lo leído en vivo.
    private var topicUnread: [String: Int] {
        guard let c = store.meta(conversationId), let me = store.me?.id else { return [:] }
        return TopicRules.unreadCounts(store.conversations[conversationId]?.messages ?? [], read: max(c.lastReadSeq, c.historyFromSeq), me: me, active: activeTopicIds)
    }

    /// Asuntos: solo quien puede escribir y no es tercero (el API responde 403 a los terceros).
    private var canOpenIssues: Bool {
        guard let d = store.data, let c = store.meta(conversationId) else { return false }
        return c.canPost && !Naming.isGuest(d, c)
    }

    /// Abre un hilo o sidechat al lado; espera a que se cierre la hoja que lo pidió.
    private func openThread(_ id: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { sidePanel = id }
    }

    /// Pone o quita mi reacción (optimista). 👀 avisa cuándo lo recuerda; ✅ cierra recordatorios y ofrece cerrar el asunto.
    private func react(_ m: MessageDTO, _ raw: String) {
        guard let d = store.data else { return }
        guard let emoji = Reactions.normalize(raw) else { store.show(L("react.invalid")); return }
        let current = store.conversations[conversationId]?.messages.first { $0.id == m.id } ?? m
        let on = !current.reactions.contains { $0.emoji == emoji && $0.userIds.contains(d.me.id) }
        Haptics.tap()
        Task {
            do {
                let r = try await store.react(current, emoji: emoji, on: on)
                if let rem = r.reminder, let at = ISODate.parse(rem.remindAt) {
                    store.show(L("react.lookDone", ["time": at.formatted(Date.FormatStyle().weekday(.abbreviated).hour().minute().locale(L10n.locale))]))
                } else if on && emoji == Reactions.done && !r.closedReminderIds.isEmpty {
                    store.show(L("react.doneReminders"))
                }
                if let issue = r.openIssueId { closeIssuePrompt = issue }
            } catch let e as ApiRequestError where e.status == 409 {
                store.show(L("react.limit"))
            } catch {
                store.show(L10n.errorText(error))
            }
        }
    }

    private func act(toast: String? = nil, _ f: @escaping () async throws -> Void) {
        Task {
            do { try await f(); if let toast { store.show(toast) } } catch { store.show(L10n.errorText(error)) }
        }
    }

    @ViewBuilder
    private func content(_ d: BootstrapDTO, _ c: ConversationDTO) -> some View {
        let state = store.conversations[conversationId]
        VStack(spacing: 0) {
            if store.connection != .online {
                ConnectionBanner(connection: store.connection).padding(.horizontal, 16).padding(.vertical, 6)
                    .background(Theme.surface)
            }
            if !embedded { LineageBar(conv: c, onReturn: { sheet = .returnResult }) }
            // Barra de accesos: reemplaza las franjas de fijados, asuntos y ramas. Dentro de un hilo al lado no va.
            if !embedded {
                ChatBar(conv: c, onPins: { sheet = .pins }, onIssues: { sheet = .issuesHere },
                        onThreads: { sheet = .threads }, onAgenda: { sheet = .agenda })
                // Lo que falta por leer en sus hilos y ramas (aunque este chat ya esté leído).
                // Temas: banderitas con scroll horizontal justo debajo de la barra de accesos.
                TopicDock(conv: c, filter: showAll ? TopicRules.all : activeTopic?.id, counts: topicCounts, unread: topicUnread,
                          onFilter: { topicFilter = $0; autoFiltered = false; Haptics.tap() }, onNew: { sheet = .newTopic(nil) },
                          onRename: { sheet = .renameTopic($0) }, onRemove: { confirmRemoveTopic = $0 },
                          onArchived: { sheet = .archivedTopics })
                TreeUnreadStrip(conversationId: conversationId) { sheet = .treePending }
                CallBanner(conversationId: conversationId)
                if search.active { searchBar }
            }
            if let state, state.loaded {
                messages(d, c, state)
            } else if let state, state.error != nil, state.transient {
                // Error pasajero: se sigue reintentando (y al reconectar el socket). Sin «bad gateway».
                ContentUnavailableView {
                    Label { Text(L(store.connection == .online ? "chat.updatingRetrying" : "chat.reconnecting")) } icon: { ProgressView() }
                        .accessibilityIdentifier("chat.reconnecting")
                } actions: {
                    // Un intento ya, sin cortar el ciclo de reintentos en curso.
                    Button(L("common.retry")) { Task { try? await store.openConversation(conversationId) } }
                        .accessibilityIdentifier("chat.retry")
                }
                .frame(maxHeight: .infinity)
            } else if let err = state?.error {
                ContentUnavailableView {
                    Label(err, systemImage: "exclamationmark.bubble").accessibilityIdentifier("chat.loadError")
                } actions: {
                    Button(L("common.retry")) { store.startConversationRecovery(conversationId) }
                        .accessibilityIdentifier("chat.retry")
                }
                .frame(maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityLabel(L("common.loading"))
            }
            typingLine
            if c.kind == .direct && c.memberIds.contains(where: { store.blockedUserIds.contains($0) }) {
                Text(L("safety.directBlocked")).font(.footnote).foregroundStyle(Theme.textSecondary).padding(14)
            } else if c.canPost { composer(d, c) } else {
                Text(L("chat.readOnly"))
                    .font(.footnote).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity).padding(14)
                    .background(Theme.surface)
                    .accessibilityIdentifier("chat.readOnly")
            }
        }
        .toolbar {
            // Dentro del panel del sidechat la cabecera es la del panel (no se mezcla con la del chat de origen).
            if !embedded {
            ToolbarItem(placement: .principal) {
                NavigationLink(value: Route.details(conversationId)) {
                    VStack(spacing: 1) {
                        HStack(spacing: 4) {
                            if c.avatarUrl != nil { ConvIcon(d: d, c: c, size: 20) }
                            if c.kind == .internal { Image(systemName: "lock.fill").font(.caption2) }
                            Text(Naming.title(d, c)).font(.headline).lineLimit(1)
                            if c.isMuted { Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(Theme.textSecondary) }
                        }
                        .foregroundStyle(Theme.textPrimary)
                        // 1.7.1: arriba solo el grupo o la persona; debajo, pequeño y en gris, la empresa (grupos) o
                        // «cargo · empresa» (directos); los chats de varias personas, sus empresas.
                        let sub = headerSubtitle(d, c)
                        if !sub.isEmpty { Text(sub).font(.caption2).foregroundStyle(Theme.textSecondary).lineLimit(1).truncationMode(.tail)
                            .accessibilityIdentifier("chat.header.company") }
                    }
                    // Sin tope, un subtítulo largo (chat grupal con varias empresas) se recorta por ambos lados.
                    .frame(maxWidth: 250)
                }
                .accessibilityLabel([Naming.title(d, c), headerSubtitle(d, c)].filter { !$0.isEmpty }.joined(separator: ", "))
                .accessibilityHint(L("chat.details"))
                .accessibilityIdentifier("chat.header")
            }
            ToolbarItem(placement: .topBarTrailing) { CallHeaderButtons(conv: c) }
            ToolbarItem(placement: .topBarTrailing) {
                Button { openSearch() } label: { Image(systemName: "magnifyingglass") }
                    .accessibilityLabel(L("search.inChat"))
                    .accessibilityIdentifier("chat.search")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ConversationMenuItems(conv: c, onRemindCustom: { sheet = .reminder(nil) },
                                          onMeeting: c.canPost ? { sheet = .newEvent(nil) } : nil)
                    Divider()
                    if c.canPost || c.openIssues > 0 {
                        Button { sheet = .issuesHere } label: { Label("\(L("issue.here")) · \(c.openIssues)", systemImage: "checklist") }
                    }
                    if (store.pins[conversationId]?.count ?? 0) > 0 { Button { sheet = .pins } label: { Label(L("pins.title"), systemImage: "pin") } }
                    Button { openSearch() } label: { Label(L("search.inChat"), systemImage: "magnifyingglass") }
                    NavigationLink(value: Route.details(conversationId)) { Label(L("chat.details"), systemImage: "info.circle") }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel(L("menu.open"))
                .accessibilityIdentifier("chat.menu")
            }
            }
        }
    }

    /// Línea bajo el título del chat: la empresa en un grupo (sin repetirla si el nombre ya la trae).
    private func headerSubtitle(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        switch c.kind {
        case .group, .internal: return Naming.isSide(c) ? Naming.subtitle(d, c) : (Naming.companyLine(d, c) ?? "")
        case .direct, .multi: return Naming.subtitle(d, c)
        }
    }

    private func buildItems(_ state: ConversationState, pending: [PendingMessage]) -> [ChatItem] {
        var items: [ChatItem] = []
        var lastDay: DateComponents?
        var prev: MessageDTO?
        var prevDate: Date?
        let cal = Calendar.current
        let filter = activeTopic?.id
        let active = activeTopicIds
        // Tres vistas (docs/TEMAS.md): un tema, solo lo suyo y las tarjetas de sus tareas; «General», solo lo sin tema
        // (y el mensaje al que se saltó); «Todo», todo con su etiqueta.
        let all = showAll
        for m in state.messages where !store.blockedUserIds.contains(m.authorId) && (filter == nil || TaskCard.matches(m, filter: filter, issues: store.issues))
            && !TopicRules.hiddenInGeneral(m, filter: filter, showAll: all, active: active, revealed: revealed,
                                           issueTopic: m.isSystem && filter == nil && !all ? ChatCards.kind(m)?.issueId.flatMap { store.issues[$0]?.topicId } : nil) {
            let date = ISODate.parse(m.createdAt) ?? Date()
            let day = cal.dateComponents([.year, .month, .day], from: date)
            if day != lastDay {
                items.append(.day("\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)", date))
                lastDay = day
                prev = nil
            }
            if m.id == dividerId, let n = unreadSnap?.unread, n > 0 { items.append(.newDivider(n)) }
            if m.isSystem {
                // Los hilos no ensucian el chat: el aviso «se abrió un hilo» lo reemplaza el chip bajo su mensaje.
                if (m.systemPayload?["k"] as? String) == "derived.from" { continue }
                items.append(.system(m))
                prev = nil
            } else {
                items.append(.message(m, showAuthor: ChatGrouping.startsRun(previous: prev, current: m)))
                prev = m
            }
            prevDate = date
        }
        items += pending.filter { filter == nil || $0.topicId == filter }.map(ChatItem.pending)
        return items
    }

    @ViewBuilder
    private func messages(_ d: BootstrapDTO, _ c: ConversationDTO, _ state: ConversationState) -> some View {
        let items = PerfCounters.measure("chat.buildItems") { buildItems(state, pending: store.pendingFor(conversationId)) }
        let lazyRows = items.count > ChatStackRule.lazyAbove
        let byId = Dictionary(state.messages.filter { !store.blockedUserIds.contains($0.authorId) }.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        ScrollViewReader { proxy in
            ScrollView {
                ChatStack(lazy: lazyRows) {
                    if state.hasMore {
                        ProgressView()
                            .padding(8)
                            .accessibilityLabel(L("chat.loadingOlder"))
                            .onAppear { loadOlder(proxy, state) }
                            // En la pila normal (VStack) la rueda existe desde que abre el chat y onAppear no vuelve a
                            // llegar: las páginas viejas se piden cuando la rueda entra en la pantalla al desplazar.
                            .background(GeometryReader { g in
                                Color.clear.onChange(of: positioned && !loadingOlder && g.frame(in: .named("chat.scroll")).minY > -40) { _, visible in
                                    if visible { loadOlder(proxy, state) }
                                }
                            })

                    } else if c.historyFromSeq > 0 {
                        Text(L("chat.lateJoin")).font(.footnote).foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.center).padding(12)
                    }
                    if embedded && Naming.isSide(c) && !state.messages.contains(where: { !$0.isSystem }) {
                        SideEmptyState()
                    } else if let t = activeTopic, !items.contains(where: { if case .day = $0 { return false }; return true }) {
                        Text(L("topic.empty", ["name": t.name])).font(.subheadline).foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.center).padding(.horizontal, 24).padding(.top, 40)
                            .accessibilityIdentifier("topic.empty")
                    } else if state.messages.isEmpty && items.isEmpty {
                        Text(L("conv.noMessages")).font(.subheadline).foregroundStyle(Theme.textSecondary).padding(.top, 40)
                    }
                    ForEach(items) { item in
                        row(d, c, item, byId: byId)
                            .modifier(LazyRowCap(cap: lazyRows ? ChatRowCapRule.cap(viewport: viewportHeight) : 0))
                            .environment(\.chatRowCap, lazyRows ? ChatRowCapRule.cap(viewport: viewportHeight) : 0)
                            .id(item.id)
                            .background {
                                if let seq = trackedSeq(item) {
                                    GeometryReader { g in
                                        Color.clear.preference(key: ChatSeenSeqKey.self,
                                                               value: ChatNav.isVisible(midY: g.frame(in: .named("chat.scroll")).midY, viewport: viewportHeight) ? [seq] : [])
                                    }
                                }
                            }
                    }
                    Color.clear.frame(height: 4).id(ChatNavIds.bottom)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(GeometryReader { g in
                    Color.clear.preference(key: ChatContentBottomKey.self, value: g.frame(in: .named("chat.scroll")).maxY)
                })
            }
            .coordinateSpace(name: "chat.scroll")
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { viewportHeight = g.size.height }
                    .onChange(of: g.size.height) { _, h in viewportHeight = h }
            })
            .onPreferenceChange(ChatSeenSeqKey.self) { seqs in
                track.visibleSeqs = seqs
                if positioned { markReadIfVisible() }
            }
            .onPreferenceChange(ChatContentBottomKey.self) { maxY in
                track.contentBottom = maxY
                // La LazyVStack re-estima el alto de filas que aún no ha dibujado (tarjetas de tarea): tras ubicar el chat
                // podía quedar pasada del final, con la pantalla en blanco. Si el hueco sigue un momento después, al final.
                if positioned, viewportHeight > 0, maxY < viewportHeight - 80, gapFix == nil {
                    gapFix = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 350_000_000)
                        if !Task.isCancelled, track.contentBottom < viewportHeight - 80 { proxy.scrollTo(ChatNavIds.bottom, anchor: .bottom) }
                        gapFix = nil
                    }
                }
                let far = ChatNav.showsJumpToLatest(distanceFromBottom: maxY - viewportHeight, viewport: viewportHeight)
                if far != farFromBottom { farFromBottom = far }
                let bottom = viewportHeight > 0 && maxY - viewportHeight < 40
                if bottom != atBottom { atBottom = bottom }
                // De vuelta al final: lo que llegó mientras estaba arriba ya se vio.
                if !far, let last = store.conversations[conversationId]?.messages.last?.seq, last > bottomSeq {
                    bottomSeq = last
                    if positioned { markReadIfVisible() }
                }
            }
            .onPreferenceChange(ChatDividerYKey.self) { y in
                guard let y else { return }
                let above = y < 0
                if above != dividerAbove { dividerAbove = above }
            }
            .overlay(alignment: .bottomTrailing) { jumpButtons(d, proxy) }
            .overlay(alignment: .top) {
                if positioningFailed {
                    Button { Task { await positionAtFirstUnread(proxy) } } label: {
                        Label(L("chat.ios.unreadRetry"), systemImage: "arrow.clockwise").font(.footnote).padding(10)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                    }.accessibilityIdentifier("chat.retryUnread")
                } else if store.readFailures.contains(conversationId) {
                    Button { markReadIfVisible() } label: {
                        Label(L("chat.ios.readRetry"), systemImage: "arrow.clockwise").font(.footnote).padding(10)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                    }.accessibilityIdentifier("chat.retryRead")
                } else if positioning { ProgressView().padding(10).background(Theme.surface) }
                else if let n = unreadSnap?.unread, n > 0, dividerId != nil, dividerAbove {
                    Button { jump(proxy, to: ChatNavIds.divider, anchor: .top) } label: {
                        Text(L("chat.newAbove", ["n": n])).font(.footnote.weight(.semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Capsule().fill(Theme.accentText))
                            .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityLabel(L("chat.jumpNew"))
                    .accessibilityIdentifier("chat.jumpNew")
                }
            }
            .animation(.easeInOut(duration: 0.2), value: farFromBottom)
            .animation(.easeInOut(duration: 0.2), value: dividerAbove)
            // Al abrir: si hay no leídos, al primero (cargando todas las páginas necesarias) con la línea «N mensajes nuevos».
            // Tras la recuperación (ios-avisos) la primera página llega con loaded y aún loading: se espera a que termine.
            .task(id: state.loaded && !state.loading) {
                guard state.loaded, !state.loading, !positioned else { return }
                Perf.mark("chat.loaded", "\(Int(Date().timeIntervalSince(openedAt) * 1000)) ms desde abrir")
                await positionAtFirstUnread(proxy)
            }
            .defaultScrollAnchor(.bottom)
            // Teléfono con el sidechat a medias: espacio abajo para que el ancla pueda subir sobre la hoja.
            .contentMargins(.bottom, sidePanel != nil && sizeClass == .compact ? 420 : 0, for: .scrollContent)
            // ?m=<seq>: cargar hacia atrás hasta el mensaje, centrarlo y resaltarlo.
            .task(id: store.jumpTo[conversationId]) {
                guard let seq = store.jumpTo[conversationId] else { return }
                let pause = UUID()
                readPauseID = pause
                defer { if readPauseID == pause { readPauseID = nil } }
                if let id = await store.ensureMessage(conversationId, seq: seq) {
                    followTopic(store.conversations[conversationId]?.messages.first { $0.seq == seq })
                    revealed.insert(seq)
                    do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
                    guard store.jumpTo[conversationId] == seq else { return }
                    withAnimation { proxy.scrollTo(id, anchor: .center) }
                    highlighted = id
                    do { try await Task.sleep(nanoseconds: 1_800_000_000) } catch {
                        if highlighted == id { highlighted = nil }
                        return
                    }
                    if highlighted == id { withAnimation { highlighted = nil } }
                }
                if !Task.isCancelled, store.jumpTo[conversationId] == seq { store.jumpTo[conversationId] = nil }
            }
            // Push de reacción: se conoce el id del mensaje, no su seq.
            .task(id: store.jumpToMessage[conversationId]) {
                guard let mid = store.jumpToMessage[conversationId] else { return }
                await store.resolveMessageJump(conversationId, messageId: mid)
            }
            .onChange(of: reveal) { _, id in
                guard let id else { return }
                reveal = nil
                // En teléfono queda arriba, visible sobre la hoja a medias.
                Task {
                    try? await Task.sleep(nanoseconds: 350_000_000)
                    withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(id, anchor: UnitPoint(x: 0.5, y: sizeClass == .compact ? 0.12 : 0.4)) }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            // Tocar el área de mensajes cierra el teclado (simultáneo: no quita el toque a mensajes, menciones ni menús).
            .simultaneousGesture(TapGesture().onEnded { if composerFocused { composerFocused = false } })
            .onChange(of: items.last?.id) { _, _ in
                // Lo mío siempre baja al final; lo de otros no arrastra a quien está leyendo más arriba (sale en el ⌄).
                let mine: Bool = {
                    if case .pending = items.last { return true }
                    return state.messages.last?.authorId == d.me.id
                }()
                if positioned && farFromBottom && !mine { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(ChatNavIds.bottom, anchor: .bottom) }
                if let last = state.messages.last?.seq { bottomSeq = max(bottomSeq, last) }
                markReadIfVisible()
            }
            // Cambiar de banderita lleva al final del chat filtrado.
            .onChange(of: topicFilter) { _, _ in
                if autoFiltered { return }
                DispatchQueue.main.async { proxy.scrollTo(ChatNavIds.bottom, anchor: .bottom) }
            }
            .onChange(of: composerFocused) { _, focused in
                if focused { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .onAppear { markReadIfVisible() }
            .onChange(of: atBottom) { _, v in if v { markReadIfVisible() } }
            .onChange(of: scenePhase) { _, p in if p == .active { markReadIfVisible() } }
        }
    }

    /// «@consulta» justo antes del cursor, en cualquier posición (no si ese "@" ya es un token).
    /// Comentando una tarea o un evento desde su tarjeta.
    private var commenting: Bool { commentingIssue != nil || commentingEvent != nil }

    /// «#consulta» justo antes del cursor (no si ese "#" ya es un token).
    private var refQuery: (start: Int, query: String)? {
        let u = Array(draft.utf16)
        let cur = min(max(0, draftCursor), u.count)
        let prefix = String(utf16CodeUnits: Array(u[..<cur]), count: cur)
        guard let q = RefText.activeQuery(in: prefix), !draftMentions.contains(where: { q.start >= $0.start && q.start < $0.end }) else { return nil }
        return q
    }

    private func pickRef(_ d: BootstrapDTO, _ target: ConversationDTO, at start: Int) {
        let cur = min(max(start, draftCursor), (draft as NSString).length)
        let r = MentionText.insert(name: Naming.title(d, target), userId: "#" + target.id, into: draft, replacing: start, cur, mentions: draftMentions, sigil: "#")
        draftMentions = r.mentions
        draftCursor = r.cursor
        draft = r.text
        Haptics.tap()
    }

    /// Tocar #grupo: lo abre si está en mi lista; si no, «No tienes acceso a #Nombre» (no navega).
    private func openRef(_ id: String) {
        if store.meta(id) != nil { store.push(.conversation(id)) }
        else { store.show(L("ref.noAccess", ["name": store.refName(id)])) }
    }

    // MARK: Buscar en el chat (tanda 1.7 §6)

    private func openSearch() {
        search.active = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { searchFocused = true }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.textSecondary)
            TextField(L("search.inChatPh"), text: $search.query)
                .focused($searchFocused)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { goSearch(0) }
                .accessibilityIdentifier("chat.searchField")
            if search.loading { ProgressView().controlSize(.small) }
            else if search.query.count >= ChatSearch.minChars {
                Text(search.counter).font(.caption.monospacedDigit()).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    .accessibilityIdentifier("chat.searchCounter")
            }
            Button { searchStep(older: true) } label: { Image(systemName: "chevron.up") }
                .disabled(!search.canOlder).accessibilityLabel(L("search.older")).accessibilityIdentifier("chat.searchOlder")
            Button { searchStep(older: false) } label: { Image(systemName: "chevron.down") }
                .disabled(!search.canNewer).accessibilityLabel(L("search.newer")).accessibilityIdentifier("chat.searchNewer")
            Button { search = ChatSearchState(); searchFocused = false } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textSecondary) }
                .accessibilityLabel(L("common.close")).accessibilityIdentifier("chat.searchClose")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.textSecondary.opacity(0.15)).frame(height: 0.5) }
        .task(id: search.query) {
            // Espera 250 ms mientras se escribe.
            let q = search.query.trimmingCharacters(in: .whitespaces)
            guard q.count >= ChatSearch.minChars else { search.results = []; search.hasMore = false; return }
            try? await Task.sleep(nanoseconds: ChatSearch.debounceMs * 1_000_000)
            guard !Task.isCancelled else { return }
            search.loading = true
            defer { search.loading = false }
            if let page = try? await store.searchConversation(conversationId, query: q), search.query.trimmingCharacters(in: .whitespaces) == q {
                search.results = page.results.map(\.message); search.hasMore = page.hasMore; search.index = 0
                goSearch(0)
            }
        }
    }

    /// ↑ más viejo (pide la página siguiente al llegar al final), ↓ más nuevo.
    private func searchStep(older: Bool) {
        if older && search.index >= search.results.count - 1 && search.hasMore, let last = search.results.last {
            let q = search.query
            Task {
                if let page = try? await store.searchConversation(conversationId, query: q, before: last.seq) {
                    search.results += page.results.map(\.message).filter { n in !search.results.contains { $0.id == n.id } }
                    search.hasMore = page.hasMore
                    search.older(); goSearch(search.index)
                }
            }
            return
        }
        if older { search.older() } else { search.newer() }
        goSearch(search.index)
    }

    /// Salta al resultado (con filtro de tema se quita para que se vea) y lo resalta.
    private func goSearch(_ i: Int) {
        guard let m = search.current else { return }
        followTopic(m)
        revealed.insert(m.seq)
        store.jumpTo[conversationId] = m.seq
    }

    private var mentionQuery: (start: Int, query: String)? {
        let u = Array(draft.utf16)
        let cur = min(max(0, draftCursor), u.count)
        let prefix = String(utf16CodeUnits: Array(u[..<cur]), count: cur)
        guard let q = MentionText.activeQuery(in: prefix), !draftMentions.contains(where: { q.start >= $0.start && q.start < $0.end }) else { return nil }
        return q
    }

    private func pickMention(name: String, userId: String, at start: Int) {
        let cur = min(max(start, draftCursor), (draft as NSString).length)
        let r = MentionText.insert(name: name, userId: userId, into: draft, replacing: start, cur, mentions: draftMentions)
        draftMentions = r.mentions
        draftCursor = r.cursor
        draft = r.text
        Haptics.tap()
    }

    /// Quien preguntó en este sidechat (autor del primer mensaje de una persona).
    private func sideAsker(_ c: ConversationDTO) -> MessageDTO? {
        guard Naming.isSide(c) else { return nil }
        return store.conversations[conversationId]?.messages.first { !$0.isSystem && $0.deletedAt == nil }
    }

    private func composerPlaceholder(_ d: BootstrapDTO, _ c: ConversationDTO) -> String {
        if let q = sideAsker(c), q.authorId != d.me.id, let name = Naming.person(d, q.authorId)?.name {
            return L("side.placeholder", ["name": name.split(separator: " ").first.map(String.init) ?? name])
        }
        if Naming.isSide(c) { return L("side.placeholderMany") }
        if commentingIssue != nil { return L("task.cardComment") }
        if commentingEvent != nil { return L("cal.commentPh") }
        if let t = activeTopic { return L("topic.placeholder", ["name": t.name]) }
        return L("chat.placeholder", ["name": Naming.title(d, c)])
    }

    /// Respuestas rápidas: en un sidechat donde me preguntaron y aún no he respondido.
    private func showQuickReplies(_ d: BootstrapDTO, _ c: ConversationDTO) -> Bool {
        guard editing == nil, draft.isEmpty, let q = sideAsker(c), q.authorId != d.me.id else { return false }
        let last = store.conversations[conversationId]?.messages.last { !$0.isSystem && $0.deletedAt == nil }
        return last?.authorId != d.me.id && store.pendingFor(conversationId).isEmpty
    }

    /// Mensaje ancla del sidechat abierto.
    private var activeAnchor: String? { sidePanel.flatMap { store.meta($0)?.parentMessageId } }

    /// Responder con cita: lo mismo que «Responder» del menú (mensajes vivos en chats donde puedo escribir).
    private func canReply(_ c: ConversationDTO, _ m: MessageDTO) -> Bool { c.canPost && m.deletedAt == nil && !m.isSystem }

    private func startReply(_ m: MessageDTO) {
        replyTo = m; editing = nil; commentingIssue = nil; commentingEvent = nil
        composerFocused = true
    }

    private func canAskSide(_ c: ConversationDTO, _ m: MessageDTO) -> Bool {
        m.kind == "text" && m.deletedAt == nil && !Naming.isSide(c) && !embedded
    }

    /// Avanza sólo por una secuencia continua de filas vistas. Los saltos y el final no borran pendientes intermedios.
    private func markReadIfVisible() {
        guard scenePhase == .active, store.openConversationId == conversationId else { return }
        snapshotUnread()
        guard positioned, readPauseID == nil, readingSession == store.sessionStamp else { return }
        track.seenSeqs.formUnion(track.visibleSeqs)
        guard let c = store.meta(conversationId), let state = store.conversations[conversationId] else { return }
        let cursor = ChatNav.visibleReadCursor(state.messages, after: max(c.lastReadSeq, c.historyFromSeq), seen: track.seenSeqs, me: store.me?.id ?? "")
        if cursor > c.lastReadSeq { store.markRead(conversationId, upTo: cursor) }
    }

    /// Seq de una fila que cuenta para el cursor (mensajes y avisos posteriores a lo leído al abrir).
    private func trackedSeq(_ item: ChatItem) -> Int? {
        switch item {
        case .message(let m, _), .system(let m): return m.seq > (unreadSnap?.lastReadSeq ?? 0) ? m.seq : nil
        default: return nil
        }
    }

    /// Guarda lo no leído al abrir, una vez y antes de marcar leído.
    private func snapshotUnread() {
        guard unreadSnap == nil, let c = store.meta(conversationId) else { return }
        readingSession = store.sessionStamp
        unreadSnap = .init(lastReadSeq: c.lastReadSeq, unread: c.unread)
    }

    /// Pide la página anterior (una a la vez) y deja a la vista el mensaje que estaba arriba.
    private func loadOlder(_ proxy: ScrollViewProxy, _ state: ConversationState) {
        guard positioned, !positioning, !loadingOlder, state.hasMore else { return }
        loadingOlder = true
        let anchor = state.messages.first?.id
        Task {
            await store.loadOlder(conversationId)
            if let anchor { proxy.scrollTo(anchor, anchor: .top) }
            try? await Task.sleep(nanoseconds: 300_000_000)
            loadingOlder = false
        }
    }

    private func positionAtFirstUnread(_ proxy: ScrollViewProxy) async {
        guard !positioning else { return }
        snapshotUnread()
        guard let snap = unreadSnap else { return }
        let retry = positioningFailed
        positioning = true; positioningFailed = false; positioned = false; track.seenSeqs = []
        defer { positioning = false }
        do {
            if retry { try await store.openConversation(conversationId, force: true) }
            let first = try await store.firstUnreadMessage(conversationId, snapshot: snap)
            if let first {
                // Todo lo no leído está en un solo tema: el chat abre filtrado en esa banderita, en el primer no leído.
                // Los temas se piden en paralelo: si aún no llegan, se esperan aquí (una petición corta).
                if !embedded, store.topics[conversationId] == nil { try? await store.loadTopics(conversationId) }
                if !embedded, topicFilter == nil, let me = store.me?.id,
                   let only = TopicRules.autoTopic(store.conversations[conversationId]?.messages ?? [], after: max(snap.lastReadSeq, store.meta(conversationId)?.historyFromSeq ?? 0),
                                                   me: me, active: activeTopicIds) {
                    autoFiltered = true
                    topicFilter = only
                }
                dividerId = first.id
                mentionQueue = ChatNav.mentionIds(store.conversations[conversationId]?.messages ?? [], after: first.seq - 1, me: store.me?.id ?? "")
                try await Task.sleep(nanoseconds: 200_000_000)
                proxy.scrollTo(ChatNavIds.divider, anchor: .top)
            }
            try await Task.sleep(nanoseconds: 350_000_000)
            positioned = true
            bottomSeq = store.conversations[conversationId]?.messages.last?.seq ?? 0
            markReadIfVisible()
        } catch {
            if !Task.isCancelled { positioningFailed = true }
        }
    }

    /// Botones flotantes sobre el compositor: «@» (siguiente mención sin leer) y ⌄ «Ir al final» con los nuevos.
    @ViewBuilder
    private func jumpButtons(_ d: BootstrapDTO, _ proxy: ScrollViewProxy) -> some View {
        let fresh = farFromBottom ? (store.conversations[conversationId]?.messages ?? [])
            .filter { $0.seq > bottomSeq && !$0.isSystem && $0.authorId != d.me.id }.count : 0
        VStack(spacing: 10) {
            if let next = mentionQueue.first {
                Button {
                    mentionQueue.removeFirst()
                    if let m = store.conversations[conversationId]?.messages.first(where: { $0.id == next }) { followTopic(m); revealed.insert(m.seq) }
                    jump(proxy, to: next, anchor: .center)
                    highlighted = next
                    Task {
                        try? await Task.sleep(nanoseconds: 1_600_000_000)
                        if highlighted == next { withAnimation { highlighted = nil } }
                    }
                } label: { floatingCircle(Text("@").font(.system(size: 17, weight: .heavy)), badge: 0) }
                .buttonStyle(.plain)
                .accessibilityLabel(L("chat.jumpMention"))
                .accessibilityIdentifier("chat.jumpMention")
                .transition(.scale.combined(with: .opacity))
            }
            if farFromBottom {
                Button {
                    jump(proxy, to: ChatNavIds.bottom, anchor: .bottom)
                    if let last = store.conversations[conversationId]?.messages.last?.seq { bottomSeq = max(bottomSeq, last) }
                    markReadIfVisible()
                } label: { floatingCircle(Image(systemName: "chevron.down").font(.system(size: 16, weight: .bold)), badge: fresh) }
                .buttonStyle(.plain)
                .accessibilityLabel(fresh > 0 ? "\(L("chat.jumpLatest")), \(L("a11y.unread", ["n": fresh]))" : L("chat.jumpLatest"))
                .accessibilityIdentifier("chat.jumpLatest")
                .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(.trailing, 14)
        .padding(.bottom, 12)
    }

    /// Salto animado; en una LazyVStack larga la animación se queda corta (alturas estimadas): se remata sin animar.
    private func jump(_ proxy: ScrollViewProxy, to id: String, anchor: UnitPoint) {
        let pause = UUID()
        readPauseID = pause
        withAnimation(.easeInOut(duration: 0.3)) { proxy.scrollTo(id, anchor: anchor) }
        Task {
            for _ in 0..<2 {
                try? await Task.sleep(nanoseconds: 350_000_000)
                proxy.scrollTo(id, anchor: anchor)
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
            if readPauseID == pause { readPauseID = nil; markReadIfVisible() }
        }
    }

    private func floatingCircle(_ content: some View, badge: Int) -> some View {
        content
            .foregroundStyle(Theme.accentText)
            .frame(width: 42, height: 42)
            .background(Circle().fill(Theme.surface))
            .overlay(Circle().strokeBorder(Theme.textSecondary.opacity(0.18), lineWidth: 1))
            .shadow(color: .black.opacity(0.14), radius: 5, y: 2)
            .overlay(alignment: .topTrailing) {
                if badge > 0 { UnreadPill(count: badge).offset(x: 6, y: -6) }
            }
            .contentShape(Circle())
    }

    @ViewBuilder
    private func row(_ d: BootstrapDTO, _ c: ConversationDTO, _ item: ChatItem, byId: [String: MessageDTO]) -> some View {
        switch item {
        case .newDivider(let n):
            HStack(spacing: 8) {
                Rectangle().fill(Theme.accentText.opacity(0.55)).frame(height: 1)
                Text(n == 1 ? L("chat.newMessagesOne") : L("chat.newMessages", ["n": n]))
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.accentText).lineLimit(1).fixedSize()
                Rectangle().fill(Theme.accentText.opacity(0.55)).frame(height: 1)
            }
            .padding(.vertical, 6)
            .background(GeometryReader { g in Color.clear.preference(key: ChatDividerYKey.self, value: g.frame(in: .named("chat.scroll")).minY) })
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("chat.newDivider")
        case .day(_, let date):
            Text(L10n.dayLabel(date))
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Capsule().fill(Theme.surface))
                .padding(.vertical, 8)
                .accessibilityAddTraits(.isHeader)
        case .system(let m):
            // Una tarea nueva se ve como tarjeta completa (docs/TEMAS.md), no como la línea «Creó la tarea…».
            // Tanda 1.7: «Es hoy», completada, vencida y comentarios también van como la tarjeta de su evento o tarea.
            if let gp = GG.actions(m) {
                // gg como chat (docs/GG-CHAT.md): lo que gg dejó listo; solo quien lo pidió confirma.
                GgActionsRow(message: m, payload: gp)
            } else if let mk = MailChatKind.parse(m.systemPayload) {
                // Correo y WhatsApp traídos al chat (docs/CORREO.md): mensaje de quien lo trajo + tarjeta, o la línea con «Abrir».
                MailChatRow(message: m, kind: mk, canPost: c.canPost)
            } else if let k = ChatCards.kind(m), k.isComments {
                // Comentarios agrupados: una línea que lleva a la tarea o al evento, sin repetir la tarjeta (como la web).
                switch k {
                case .issueComments(let id, let info):
                    CommentsNoticeLine(count: info.count, title: ChatCards.title(m), lastByName: info.lastByName, lastExcerpt: info.lastExcerpt,
                                       icon: AnyView(Text("☑").font(.footnote))) { store.push(.issue(id)) }
                case .eventComments(let id, let info):
                    CommentsNoticeLine(count: info.count, title: ChatCards.title(m), lastByName: info.lastByName, lastExcerpt: info.lastExcerpt,
                                       icon: AnyView(Text("📅").font(.footnote))) { store.push(.event(id)) }
                default: EmptyView()
                }
            } else if let k = ChatCards.kind(m), let eventId = k.eventId {
                EventChatCard(eventId: eventId, creatorId: m.authorId, kind: k, onComment: c.canPost ? { ev in
                    commentingEvent = ev; commentingIssue = nil; replyTo = nil; editing = nil; composerFocused = true
                } : nil)
            } else if let k = ChatCards.kind(m), let issueId = k.issueId {
                IssueChatCard(issueId: issueId, creatorId: m.authorId, canPost: c.canPost, kind: k) { i in
                    commentingIssue = i; commentingEvent = nil; replyTo = nil; editing = nil; composerFocused = true
                }
            } else {
                SystemRow(message: m)
            }
        case .message(let m, let showAuthor):
            let mine = m.authorId == d.me.id
            let quoted = m.replyTo.flatMap { byId[$0] }
            let author = Naming.person(d, m.authorId)
            let bubble = MessageBubble(
                text: m.deletedAt != nil ? L("chat.deleted") : m.body,
                leading: mine || !ChatGrouping.showsAvatars(c.kind) ? .none
                    : showAuthor ? .person(name: author?.name ?? "?", photo: author?.avatarUrl, id: m.authorId, agent: author?.kind == "agent") : .spacer,
                authorColor: PersonColor.text(m.authorId),
                time: L10n.clock(m.createdAt) + (m.editedAt != nil && m.deletedAt == nil ? " " + L("msg.edited") : ""),
                mine: mine,
                author: mine || !showAuthor ? nil : Naming.authorLine(d, m.authorId),
                status: nil, italic: m.deletedAt != nil,
                quote: m.replyTo == nil ? nil : (quoted.map { q in (Naming.person(d, q.authorId)?.name ?? "", q.deletedAt != nil ? L("chat.deleted") : excerpt(q.body)) } ?? ("", L("reply.quoteMissing"))),
                forwardedLabel: m.forwarded.map { forwardedLabel(d, $0, mine: mine, authorName: author?.name) },
                merged: m.mergedKind == "side" ? L("side.fromSidechat")
                    : m.mergedFrom.map { id in store.meta(id).map { L("lin.resultOf", ["name": Naming.title(d, $0)]) } ?? L("lin.resultHidden") },
                pinned: store.pins[conversationId]?.contains(m.id) == true,
                linkify: m.deletedAt == nil && m.kind == "text",
                linkPreview: m.deletedAt == nil ? m.linkPreview : nil,
                attachments: m.deletedAt == nil ? m.attachments : [],
                messageId: m.id, conversationId: conversationId,
                mentions: m.deletedAt == nil ? m.mentions + RefText.tokens(m.refs) : [],
                highlight: search.active && search.matchIds.contains(m.id) ? search.query : nil,
                mentionsMe: m.deletedAt == nil && MentionText.mentionsMe(m.mentions, me: d.me.id, authorId: m.authorId),
                sideAnchor: activeAnchor == m.id,
                topic: embedded || m.deletedAt != nil ? nil : m.topicId.flatMap { id in store.topics[conversationId]?.first { $0.id == id } },
                topicBy: TopicRules.byLine(m, me: d.me.id) { Naming.person(d, $0)?.name }
            )
            Group {
                if m.viewOnce && m.deletedAt == nil {
                    // Una sola vista: burbuja cerrada, sin menú (no se copia, reenvía, fija ni convierte en tarea).
                    ViewOnceBubble(message: m, mine: mine, time: L10n.clock(m.createdAt))
                        .padding(.leading, !mine && ChatGrouping.showsAvatars(c.kind) ? 40 : 0)
                } else if m.deletedAt == nil {
                    // Pulsación larga como en iPhone: vista previa de la burbuja + barra rápida de reacciones + menú.
                    bubble.contextMenu {
                        if c.canPost && !m.isSystem {
                            QuickReactionBar(mineEmojis: Set(m.reactions.filter { $0.userIds.contains(d.me.id) }.map(\.emoji)),
                                             actions: Reactions.actionsEnabled(d), onPick: { react(m, $0) }, onMore: { sheet = .react(m) })
                        }
                        messageMenu(d, c, m)
                    } preview: {
                        // La vista previa vive en otro contenedor y NO hereda el entorno: sin `.environment(store)` las
                        // burbujas con fotos, archivos o voz (AttachmentImage, VoiceNoteView leen AppStore) cerraban la app
                        // al mantenerlas presionadas (EXC_BREAKPOINT en EnvironmentValues.subscript.getter).
                        bubble.frame(width: 340).padding(.vertical, 10).padding(.horizontal, 6).background(Theme.background)
                            .environment(store)
                    }
                } else { bubble }
            }
            .padding(.top, showAuthor ? 6 : 0)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.orange.opacity(highlighted == m.id ? 0.18 : 0)))
            // Deslizar la burbuja a la derecha = responder con cita (1.7.1, como WhatsApp). El sidechat queda en el menú.
            .modifier(SwipeToReply(enabled: canReply(c, m)) { startReply(m) })
            .accessibilityIdentifier("msg.\(m.id)")
            if m.deletedAt == nil && !m.reactions.isEmpty {
                ReactionChips(d: d, message: m, mine: mine, canReact: c.canPost, onToggle: { react(m, $0) }, onMore: { sheet = .react(m) })
                    .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                    .padding(.leading, mine ? 48 : (ChatGrouping.showsAvatars(c.kind) ? 40 : 4))
                    .padding(.trailing, mine ? 4 : 48)
                    .padding(.top, -1)
            }
            if !embedded {
                let threads = store.data.map { ChatThreads.of($0, conversationId, messageId: m.id).filter { !Naming.isSide($0) } } ?? []
                if !threads.isEmpty {
                    ThreadChip(threads: threads) { sidePanel = $0 }
                        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                        .padding(.horizontal, mine ? 4 : 40)
                }
            }
            let sides = store.sides(of: m.id)
            if !sides.isEmpty {
                SideChip(sides: sides) { sidePanel = $0 }
                    .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                    .padding(.horizontal, mine ? 4 : 40)
            }
            if let f = m.forwarded, f.messageId != nil, let fromId = f.fromConversationId, store.meta(fromId) != nil {
                Button {
                    if let seq = f.messageSeq { store.jumpTo[fromId] = seq }
                    store.navigate(to: .conversation(fromId))
                } label: {
                    Label(L("preply.open"), systemImage: "arrow.up.forward").font(.caption2.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                .padding(.horizontal, mine ? 4 : 40)
                .accessibilityIdentifier("msg.privateOrigin.\(m.id)")
            }
        case .pending(let p):
            MessageBubble(text: p.body, time: "", mine: true, author: nil, status: p.status == .failed ? .failed : .sending, italic: false,
                          forwardedLabel: p.forwarded.map { forwardedLabel(d, $0) }, attachments: p.attachments ?? [], mentions: p.mentions ?? [])
                .padding(.top, 4)
                .onTapGesture { if p.status == .failed { store.retry(p.clientMessageId) } }
                .contextMenu {
                    if p.status == .failed {
                        Button(L("chat.retry")) { store.retry(p.clientMessageId) }
                        Button(L("chat.discard"), role: .destructive) { store.discard(p.clientMessageId) }
                    }
                }
                .accessibilityAction(named: Text(L("chat.retry"))) { store.retry(p.clientMessageId) }
                .accessibilityAction(named: Text(L("chat.discard"))) { store.discard(p.clientMessageId) }
                .accessibilityIdentifier("pending.\(p.clientMessageId)")
        }
    }

    private func forwardedLabel(_ d: BootstrapDTO, _ f: ForwardedInfo, mine: Bool = true, authorName: String? = nil) -> String {
        if let mid = f.messageId {
            // Respuesta en privado: el servidor manda el extracto del original.
            if let ex = f.excerpt, !ex.isEmpty {
                return mine ? L("preply.you", ["excerpt": excerpt(ex, 80)]) : L("preply.other", ["name": authorName ?? "", "excerpt": excerpt(ex, 80)])
            }
            if let fromId = f.fromConversationId, let orig = store.conversations[fromId]?.messages.first(where: { $0.id == mid }), orig.deletedAt == nil {
                return mine ? L("preply.you", ["excerpt": excerpt(orig.body, 80)]) : L("preply.other", ["name": authorName ?? "", "excerpt": excerpt(orig.body, 80)])
            }
            if let from = f.fromConversationId.flatMap({ store.meta($0) }) {
                return L("privateReply.labelConv", ["name": Naming.title(d, from)])
            }
            return L("privateReply.labelHidden")
        }
        var label: String
        if let from = f.fromConversationId.flatMap({ store.meta($0) }) {
            label = L("fwd.fromConv", ["name": Naming.title(d, from)])
        } else if let a = f.author, !a.isEmpty {
            label = L("fwd.fromBy", ["source": L("src.\(f.source.rawValue)"), "author": a])
        } else {
            label = L("fwd.from", ["source": L("src.\(f.source.rawValue)")])
        }
        if let s = f.sentAt, !s.isEmpty { label += " · " + (s.contains("T") ? L10n.dateTime(ISODate.parse(s) ?? Date()) : s) }
        return label
    }

    /// Menú de un mensaje (mismas acciones y orden que messageMenu de la web).
    @ViewBuilder
    private func messageMenu(_ d: BootstrapDTO, _ c: ConversationDTO, _ m: MessageDTO) -> some View {
        let mine = m.authorId == d.me.id
        let isPinned = store.pins[conversationId]?.contains(m.id) == true
        // Asuntos y reuniones también en directos y multi (SPEC-v4 E); derivar sigue siendo de espacios.
        let canWork = c.canPost
        let myWsRole = d.workspaces.first { $0.id == c.workspaceId }?.myRole
        // Bloque 1: responder aquí o por DM al autor. Bloque 2: responder aparte en un hilo o en un sidechat privado.
        // «Responder en privado» y el sidechat son opciones distintas (docs/GRUPOS.md).
        if c.canPost {
            Button { startReply(m) } label: { Label(L("menu.reply"), systemImage: "arrowshape.turn.up.left") }
        }
        if !mine && c.kind != .direct {
            Button {
                act { try await store.startPrivateReply(to: m) }
            } label: {
                Text(L("preply.action")); Text(L("menu.hintDm", ["name": Naming.person(d, m.authorId)?.name ?? ""])); Image(systemName: "envelope")
            }
            .accessibilityIdentifier("menu.privateReply")
        }
        // Hilos también en directos y chats grupales (solo «same»); un hilo o sidechat de un chat no se deriva otra vez.
        let canThread = canWork && !embedded && myWsRole != "guest" && (c.workspaceId != nil ? c.kind != .direct : c.parentId == nil)
        if canThread || canAskSide(c, m) {
            Divider()
            if canThread {
                Button { sheet = .derive(m) } label: {
                    Text(L("menu.derive")); Text(L("menu.hintThread")); Image(systemName: "bubble.left.and.bubble.right")
                }
                .accessibilityIdentifier("menu.thread")
            }
            if canAskSide(c, m) {
                Button { askSide = m } label: {
                    Text(L("side.ask")); Text(L("menu.hintSide")); Image(systemName: "lock")
                }
                .accessibilityIdentifier("menu.sidechat")
            }
        }
        Divider()
        Button { UIPasteboard.general.string = m.body; store.show(L("toast.copied")) } label: { Label(L("menu.copyText"), systemImage: "doc.on.doc") }
        Button { UIPasteboard.general.string = "\(conversationLink(conversationId))?m=\(m.seq)"; store.show(L("toast.linkCopied")) } label: {
            Label(L("menu.copyLink"), systemImage: "link")
        }
        Divider()
        if c.canPost {
            Button { act(toast: isPinned ? L("toast.unpinned") : L("toast.pinned")) { try await store.setMessagePinned(m, !isPinned) } } label: {
                Label(isPinned ? L("menu.unpin") : L("menu.pin"), systemImage: isPinned ? "pin.slash" : "pin")
            }
        }
        // «🏷 Tema»: cualquiera del chat puede etiquetar cualquier mensaje de texto (docs/TEMAS.md).
        if c.canPost && m.kind == "text" && !embedded {
            MessageTopicMenu(message: m) { sheet = .newTopic(m) }
        }
        RemindMenu(conversationId: conversationId, message: m, onCustom: { sheet = .reminder(m) })
        Button { act(toast: L("toast.markedUnread")) { try await store.markUnread(conversationId, seq: m.seq) } } label: {
            Label(L("menu.markUnread"), systemImage: "circle.fill")
        }
        if canWork {
            Divider()
            // Los terceros participan en los asuntos, pero no los crean (docs/GRUPOS.md).
            if !Naming.isGuest(d, c) { Button { sheet = .newIssue(m) } label: { Label(L("menu.issue"), systemImage: "checklist") } }
            Button { sheet = .newEvent(m) } label: { Label(L("menu.meeting"), systemImage: "calendar.badge.plus") }
        }
        Button { sheet = .forward(m) } label: { Label(L("menu.forwardChat"), systemImage: "arrowshape.turn.up.right") }
            .accessibilityIdentifier("menu.forwardChat")
        Menu {
            Button { sheet = .forward(m) } label: { Label(L("fwd.tiecoms"), systemImage: "bubble.left.and.bubble.right") }
            Divider()
            let author = Naming.person(d, m.authorId)?.name ?? ""
            let link = "\(conversationLink(conversationId))?m=\(m.seq)"
            let plain = "\(author): \(m.body)\n\n— \(Naming.title(d, c)) · chaggu\n\(link)"
            Button(L("fwd.whatsapp")) {
                if let u = URL(string: "https://wa.me/?text=\(plain.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")") { openURL(u) }
            }
            Button(L("fwd.slack")) {
                UIPasteboard.general.string = ">\(m.body.replacingOccurrences(of: "\n", with: "\n>"))\n— *\(author)* · \(Naming.title(d, c)) · <\(link)|chaggu>"
                store.show(L("toast.slackCopied"))
            }
            Button(L("fwd.teams")) { UIPasteboard.general.string = plain; store.show(L("toast.teamsCopied")) }
            Button(L("fwd.email")) {
                let subject = "\(Naming.title(d, c)) · chaggu".addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                if let u = URL(string: "mailto:?subject=\(subject)&body=\(plain.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")") { openURL(u) }
            }
        } label: { Label(L("menu.forward"), systemImage: "arrowshape.turn.up.right") }
        if !mine {
            Divider()
            Button { sheet = .report(m) } label: { Label(L("safety.reportMessage"), systemImage: "flag") }
                .accessibilityIdentifier("safety.reportMessage")
            Button(role: .destructive) { blockUserId = m.authorId } label: { Label(L("safety.block"), systemImage: "person.slash") }
                .accessibilityIdentifier("safety.block")
        }
        if mine {
            Divider()
            Button { editing = m; replyTo = nil; draftMentions = m.mentions; draftCursor = (m.body as NSString).length; draft = m.body; composerFocused = true } label: { Label(L("menu.edit"), systemImage: "pencil") }
            Button(role: .destructive) { confirmDelete = m } label: { Label(L("menu.delete"), systemImage: "trash") }
        }
    }

    @ViewBuilder private var typingLine: some View {
        let names = store.typingNames(conversationId)
        if !names.isEmpty {
            Text(names.count == 1 ? L("chat.typingOne", ["names": names[0]]) : L("chat.typingMany", ["names": names.joined(separator: ", ")]))
                .font(.caption).italic().foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 4)
                .accessibilityIdentifier("chat.typing")
                .transition(.opacity)
        }
    }

    @ViewBuilder
    private func composer(_ d: BootstrapDTO, _ c: ConversationDTO) -> some View {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(spacing: 0) {
            if let pr = store.privateReplies[conversationId] {
                ContextBar(icon: "lock.bubble", title: L("preply.bar", ["name": pr.author ?? ""]),
                           detail: "«\(excerpt(pr.excerpt, 100))»", cancelLabel: L("preply.cancel")) { store.privateReplies[conversationId] = nil }
                    .accessibilityIdentifier("composer.privateReplyBar")
            }
            if let r = replyTo {
                ContextBar(icon: "arrowshape.turn.up.left", title: L("reply.to", ["name": Naming.person(d, r.authorId)?.name ?? ""]),
                           detail: excerpt(r.body, 100), cancelLabel: L("reply.cancel")) { replyTo = nil }
                    .accessibilityIdentifier("composer.replyBar")
            }
            if let ce = commentingEvent {
                ContextBar(icon: "calendar", title: L("cal.commentingOn"), detail: ce.title, cancelLabel: L("common.cancel")) { commentingEvent = nil }
                    .accessibilityIdentifier("composer.eventCommentBar")
            }
            if let ci = commentingIssue {
                ContextBar(icon: "text.bubble", title: L("task.commentingOn"), detail: ci.title, cancelLabel: L("common.cancel")) { commentingIssue = nil }
                    .accessibilityIdentifier("composer.taskCommentBar")
            }
            if let e = editing {
                ContextBar(icon: "pencil", title: L("menu.edit"), detail: excerpt(e.body, 100), cancelLabel: L("common.cancel")) {
                    editing = nil; draft = ""; draftMentions = []
                }
                .accessibilityIdentifier("composer.editBar")
            }
            if mentionQuery == nil, let q = refQuery {
                RefPicker(d: d, query: q.query) { target in pickRef(d, target, at: q.start) }
            }
            if let q = mentionQuery {
                MentionPicker(d: d, c: c, query: q.query, messages: store.conversations[conversationId]?.messages ?? [],
                              onPick: { name, userId in pickMention(name: name, userId: userId, at: q.start) },
                              onAdd: { _ in sheet = nil; addingToSide = true },
                              onAskSide: { p in
                                  sideForPerson = p.id
                                  askSide = store.conversations[conversationId]?.messages.last { !$0.isSystem && $0.deletedAt == nil && $0.kind == "text" }
                              })
            }
            if showQuickReplies(d, c) {
                SideQuickReplies(onSend: { store.send(conversationId, body: $0) }, onAskOther: { addingToSide = true })
            }
            if let issueId = c.sideIssueId { SideIssueStrip(sideId: c.id, issueId: issueId) }
            ScheduledStrip(conversationId: conversationId) { showScheduled = true }
            SleepNoticeBar(conversation: c, typing: !trimmed.isEmpty && editing == nil, onSchedule: scheduleDraft)
            StagedAttachments(staged: $staged, progress: uploadProgress)
            if let v = failedVoice {
                // La nota no se subió: queda aquí para reintentar o descartar.
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
                    Text(L("voice.unsent", ["d": L10n.duration(v.durationMs)])).font(.footnote).foregroundStyle(Theme.textPrimary).lineLimit(2)
                    Spacer(minLength: 4)
                    Button(L("voice.retry")) { failedVoice = nil; uploadVoice(v, aiConsent: v.aiConsent) }
                        .font(.footnote.weight(.semibold)).disabled(uploading)
                        .accessibilityIdentifier("voice.retryUpload")
                    Button(role: .destructive) { failedVoice = nil; store.show(L("voice.cancelled")) } label: { Image(systemName: "trash") }
                        .accessibilityLabel(L("voice.discard"))
                        .accessibilityIdentifier("voice.discardUnsent")
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
                .accessibilityIdentifier("voice.unsentBar")
            }
            HStack(alignment: .bottom, spacing: 8) {
                if recorder.isActive {
                    VoiceRecordingBar(recorder: recorder, onSend: sendVoice, onDiscard: { store.show(L("voice.cancelled")) }, onError: { store.show($0) })
                } else {
                // «＋»: fotos, archivos y, aparte, evento o asunto del chat.
                if editing == nil && !commenting {
                    AttachButton(staged: $staged, onEvent: embedded ? nil : { sheet = .newEvent(nil) },
                                 onIssue: embedded || !canOpenIssues ? nil : { sheet = .newIssue(nil) },
                                 onMeeting: embedded ? nil : { now in sheet = .meeting(now: now) },
                                 // Correo en el chat (docs/CORREO.md): ＋ › Correo con este chat como destino; WhatsApp va a su pantalla.
                                 onMail: embedded || !store.mailEnabled || Naming.isGuest(d, c) ? nil : { store.push(.mailBox(conversationId: conversationId)) },
                                 onWhatsApp: embedded || !store.mailEnabled || Naming.isGuest(d, c) ? nil : { store.push(.whatsapp) }) { store.show($0) }
                }
                if editing == nil && !commenting && !embedded { ViewOnceToggle(on: $viewOnceNext) }
                // UITextView: tokens resaltados, cursor real y retroceso que borra el token entero.
                ComposerTextView(text: $draft, mentions: $draftMentions, cursor: $draftCursor, focused: $composerFocused,
                                 placeholder: composerPlaceholder(d, c), accessibilityLabel: L("chat.composerLabel"),
                                 onChange: { new in if !new.isEmpty && editing == nil { store.userIsTyping(conversationId) } },
                                 onPasteAttachments: editing == nil && !commenting && !recorder.isActive ? { stagePasted($0) } : nil)
                    .overlay(alignment: .topLeading) {
                        if draft.isEmpty {
                            Text(composerPlaceholder(d, c)).font(.body).foregroundStyle(Theme.textSecondary.opacity(0.8))
                                .lineLimit(1).padding(.horizontal, 14).padding(.vertical, 10).allowsHitTesting(false).accessibilityHidden(true)
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 20).fill(Theme.background))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.textSecondary.opacity(0.25)))
                }
                // Compositor vacío: micrófono (mantener pulsado para grabar). Con texto o adjuntos: enviar.
                if editing == nil && !commenting && trimmed.isEmpty && staged.isEmpty && !uploading && recorder.state != .locked {
                    VoiceRecordButton(recorder: recorder, onSend: sendVoice)
                } else if !recorder.isActive {
                // Con texto (sin adjuntos): 🕒 para programar el envío.
                if canSchedule(trimmed) {
                    ScheduleButton(onPick: scheduleDraft, onCustom: { pickingSchedule = true })
                }
                Button(action: submit) {
                    Image(systemName: editing != nil ? "checkmark" : "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(trimmed.isEmpty && staged.isEmpty ? Theme.textSecondary.opacity(0.35) : Theme.bubbleMine))
                }
                .disabled((trimmed.isEmpty && staged.isEmpty) || uploading)
                .accessibilityLabel(editing != nil ? L("edit.save") : L("chat.send"))
                .accessibilityIdentifier("composer.send")
                // Mantener presionado ➤: el mismo menú de programar.
                .contextMenu {
                    if canSchedule(trimmed) { ScheduleMenuItems(onPick: scheduleDraft, onCustom: { pickingSchedule = true }) }
                }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
        .sheet(isPresented: $pickingSchedule) { PickWhenSheet(onPick: scheduleDraft) }
        .sheet(isPresented: $showScheduled) { ScheduledSheet(conversationId: conversationId) }
    }

    /// Imágenes pegadas: a la misma bandeja de adjuntos que Fotos (con sus límites de cantidad y tamaño).
    private func stagePasted(_ list: [LocalAttachment]) {
        for a in list {
            guard staged.count < AttachmentRules.maxPerMessage else { store.show(L("att.max", ["n": AttachmentRules.maxPerMessage])); return }
            if a.tooBig { store.show(L("att.tooBig", ["name": a.name])); continue }
            staged.append(a)
        }
        Haptics.tap()
    }

    /// Solo se programa texto (con menciones y respuesta); adjuntos, notas de voz y respuestas privadas salen al momento.
    private func canSchedule(_ trimmed: String) -> Bool {
        editing == nil && !commenting && !viewOnceNext && !trimmed.isEmpty && staged.isEmpty && !uploading && store.privateReplies[conversationId] == nil
    }

    /// Programa el borrador: el compositor se vacía y el aviso trae «Deshacer» (devuelve el texto).
    private func scheduleDraft(_ at: Date) {
        // El texto tal cual (como al enviar): los offsets de las menciones se cuentan sobre él.
        let body = draft
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let ms = draftMentions, reply = replyTo?.id
        draft = ""; draftMentions = []; replyTo = nil
        Task {
            let ok = await store.scheduleFromComposer(conversationId, body: body, at: at, mentions: ms, replyTo: reply) { text, mentions in
                if draft.isEmpty { draft = text; draftMentions = mentions }
            }
            if !ok && draft.isEmpty { draft = body; draftMentions = ms }
        }
    }

    /// Keep the recording on-device until the person chooses whether to use third-party AI.
    private func sendVoice(_ data: Data, _ durationMs: Int, _ waveform: [Double]) {
        guard !uploading, pendingVoice == nil else { return }
        pendingVoice = PendingVoiceSend(data: data, durationMs: durationMs, waveform: waveform, replyTo: replyTo?.id, viewOnce: viewOnceNext)
        viewOnceNext = false
        showingVoiceAIConsent = true
    }

    private func uploadVoice(_ voice: PendingVoiceSend, aiConsent: Bool) {
        pendingVoice = nil
        uploading = true
        var voice = voice
        voice.aiConsent = aiConsent
        Task {
            defer { uploading = false }
            do {
                let a = try await store.api.uploadVoiceNote(conversationId, data: voice.data, durationMs: voice.durationMs, waveform: voice.waveform, aiConsent: aiConsent)
                store.send(conversationId, body: "", replyTo: voice.replyTo, attachments: [a], topicId: activeTopic?.id, viewOnce: voice.viewOnce)
                replyTo = nil
            } catch {
                failedVoice = voice
                store.show(VoiceRules.uploadErrorText(error))
            }
        }
    }

    private func submit() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty || !staged.isEmpty, !uploading else { return }
        if let ce = commentingEvent {
            guard !body.isEmpty else { return }
            commentingEvent = nil
            draft = ""; draftMentions = []
            act { try await store.commentEvent(ce.id, body: body) }
            return
        }
        if viewOnceNext && !ViewOnceRules.allowed(staged) {
            store.show(L("vo.onlyMedia"))
            return
        }
        if let ci = commentingIssue {
            // Comentario de la tarea (POST /issues/:id/comments); la tarjeta muestra los últimos al recargar.
            guard !body.isEmpty else { return }
            commentingIssue = nil
            draft = ""; draftMentions = []
            act { try await store.commentIssue(ci.id, body: body) }
            return
        }
        if let e = editing {
            editing = nil
            draft = ""
            let ms = draftMentions
            draftMentions = []
            if body != e.body || ms != e.mentions { act { try await store.editMessage(e.id, body: body, mentions: ms) } }
            return
        }
        if !staged.isEmpty {
            // Adjuntos: se suben (con progreso) y luego se envía el mensaje con sus ids.
            let files = staged, text = draft, reply = replyTo?.id, ms = draftMentions, topic = activeTopic?.id, vo = viewOnceNext
            viewOnceNext = false
            uploading = true
            Task {
                defer { uploading = false; uploadProgress = [:] }
                var done: [AttachmentDTO] = []
                for f in files {
                    uploadProgress[f.id] = 0
                    do {
                        let a = try await store.api.uploadAttachment(conversationId, f) { p in Task { @MainActor in uploadProgress[f.id] = p } }
                        done.append(a)
                    } catch {
                        // Los adjuntos siguen en el compositor para reintentar; el aviso dice por qué.
                        store.show(AttachmentRules.uploadErrorText(error, name: f.name))
                        return
                    }
                }
                store.send(conversationId, body: text, replyTo: reply, attachments: done, mentions: ms, topicId: topic, viewOnce: vo)
                staged = []
                draftMentions = []
                draft = ""
                replyTo = nil
            }
            return
        }
        if let pr = store.privateReplies[conversationId] {
            store.sendPrivateReply(pr, body: draft)
        } else {
            // Con una banderita elegida, lo que escribo sale con ese tema.
            store.send(conversationId, body: draft, replyTo: replyTo?.id, mentions: draftMentions, topicId: activeTopic?.id, viewOnce: viewOnceNext)
            viewOnceNext = false
        }
        replyTo = nil
        draftMentions = []
        draft = ""
    }

}

/// Barra sobre el compositor (respondiendo a / editando).
struct ContextBar: View {
    var icon: String
    var title: String
    var detail: String
    var cancelLabel: String
    var onCancel: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(Theme.accentText)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                Text(detail).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer()
            Button(action: onCancel) { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textSecondary) }
                .accessibilityLabel(cancelLabel)
                .frame(minWidth: 44, minHeight: 44)
        }
        .padding(.horizontal, 14)
        .background(Theme.orange.opacity(0.08))
    }
}

/// Mensaje de sistema: algunos enlazan a un asunto, una reunión o la conversación derivada.
struct SystemRow: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    var body: some View {
        let p = message.systemPayload
        let child = (p?["k"] as? String) == "derived.from" ? (p?["childId"] as? String).flatMap { store.meta($0) } : nil
        let issueId = p?["issueId"] as? String
        let eventId = p?["eventId"] as? String
        VStack(spacing: 6) {
            Text(L10n.systemText(message.body))
                .font(.footnote).foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            if let child, let d = store.data {
                NavigationLink(value: Route.conversation(child.id)) { Text("💬 \(ChatThreads.title(d, child))").font(.footnote.weight(.semibold)) }
            }
            if let issueId {
                NavigationLink(value: Route.issue(issueId)) { Text(L("lin.open")).font(.footnote.weight(.semibold)) }
            }
            if let eventId { EventCard(eventId: eventId) }
            if (p?["k"] as? String) == "call.transcript", let callId = p?["callId"] as? String {
                NavigationLink(value: Route.callDetail(callId)) { Text(L("call.transcriptOpen")).font(.footnote.weight(.semibold)) }
                    .accessibilityIdentifier("call.transcriptOpen")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("msg.system")
    }
}

/// Tarjeta de reunión dentro del chat.
struct EventCard: View {
    @Environment(AppStore.self) private var store
    let eventId: String
    var body: some View {
        NavigationLink(value: Route.event(eventId)) {
            if let ev = store.events[eventId] {
                let mine = ev.invitees.first { $0.userId == store.me?.id }
                HStack(spacing: 10) {
                    Image(systemName: "calendar").font(.title3).foregroundStyle(Theme.accentText)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ev.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary).strikethrough(ev.isCancelled)
                        Text(ev.isCancelled ? L("cal.cancelled") : L10n.eventWhen(ev)).font(.caption).foregroundStyle(Theme.textSecondary)
                        if let mine, !ev.isCancelled { Text(L("cal.rsvp.\(mine.rsvp.rawValue)")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentText) }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.textSecondary)
                }
                .padding(12)
                .frame(maxWidth: 320)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.orange.opacity(0.35)))
            } else {
                Text(L("lin.open")).font(.footnote.weight(.semibold))
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("eventCard.\(eventId)")
    }
}

struct MessageBubble: View {
    /// Emojis solos (1 a 3): 40 pt que escalan con Dynamic Type y con el tamaño del texto de la app.
    @ScaledMetric(relativeTo: .body) private var jumboSize: CGFloat = 40
    enum Status { case sending, failed }
    /// Columna del avatar a la izquierda de las burbujas ajenas (grupos, chats grupales, laterales).
    enum Leading { case none, spacer, person(name: String, photo: String?, id: String, agent: Bool) }
    var text: String
    var leading: Leading = .none
    var authorColor: Color? = nil
    var time: String
    var mine: Bool
    var author: (name: String, org: String?)?
    var status: Status?
    var italic: Bool
    var quote: (author: String, text: String)? = nil
    var forwardedLabel: String? = nil
    var merged: String? = nil
    var pinned = false
    /// Enlaces del texto tocables (solo mensajes de texto no eliminados).
    var linkify = false
    var linkPreview: LinkPreviewDTO? = nil
    var attachments: [AttachmentDTO] = []
    var messageId: String? = nil
    var conversationId: String? = nil
    var mentions: [Mention] = []
    /// Búsqueda en el chat: lo que coincide va resaltado.
    var highlight: String? = nil
    var mentionsMe = false
    /// Ancla del sidechat abierto: halo y posición exacta de la burbuja para el conector.
    var sideAnchor = false
    /// Tema del mensaje (etiqueta junto a la hora) y «tema puesto por X» si no fue el autor.
    var topic: TopicDTO? = nil
    var topicBy: String? = nil
    @Environment(\.openURL) private var openURL
    /// Mensaje muy largo (1.7.1): plegado a `LongText.collapsedLines` con «Ver más».
    @State private var expanded = false
    @State private var reading = false
    @Environment(\.chatLazyStack) private var inLazyStack
    @Environment(\.chatRowCap) private var rowCap

    var body: some View {
        let _ = PerfCounters.bump("chat.bubble.body")
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 48) }
            switch leading {
            case .none: EmptyView()
            case .spacer: Color.clear.frame(width: 28, height: 1)
            case .person(let name, let photo, let id, let agent):
                Avatar(name: name, org: nil, isAgent: agent, size: 28, photo: photo, fill: PersonColor.fill(id))
                    .padding(.top, author != nil ? 16 : 0)
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                if let author {
                    HStack(spacing: 4) {
                        Text(author.name).font(.caption.weight(.semibold)).foregroundStyle(authorColor ?? Theme.textPrimary)
                        if let org = author.org { Text("· \(org)").font(.caption).foregroundStyle(Theme.textSecondary) }
                    }
                    .lineLimit(1)
                    .padding(.horizontal, 4)
                }
                VStack(alignment: .leading, spacing: 6) {
                    if let forwardedLabel {
                        Label(forwardedLabel, systemImage: "arrowshape.turn.up.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(mine ? Color.white.opacity(0.9) : Theme.textSecondary)
                    }
                    if let quote {
                        VStack(alignment: .leading, spacing: 1) {
                            if !quote.author.isEmpty { Text(quote.author).font(.caption.weight(.semibold)) }
                            Text(quote.text).font(.caption).lineLimit(2)
                        }
                        .foregroundStyle(mine ? Color.white.opacity(0.92) : Theme.textSecondary)
                        .padding(.leading, 8)
                        .overlay(alignment: .leading) { Rectangle().fill(mine ? Color.white.opacity(0.7) : Theme.orange).frame(width: 3) }
                    }
                    if let merged {
                        Label(merged, systemImage: "arrow.uturn.backward").font(.caption.weight(.semibold))
                            .foregroundStyle(mine ? Color.white : Theme.accentText)
                    }
                    if !attachments.isEmpty { AttachmentsBlock(attachments: attachments, mine: mine, messageId: messageId, conversationId: conversationId) }
                    if !text.isEmpty || attachments.isEmpty {
                    Group {
                        if !mentions.isEmpty || highlight != nil || !GGMention.typedRanges(in: text).isEmpty {
                            // Cada mención con el color de SU persona (y tocable); los enlaces http con el color de enlace.
                            RichMessageText(text: text, mentions: mentions, mine: mine, linkify: linkify, highlight: highlight,
                                            maxLines: collapsed ? collapsedLines : 0) { id in
                                if let u = URL(string: "chaggu-mention://\(id)") { openURL(u) }
                            }
                        } else if linkify { Text(Linkify.cachedAttributed(text)) } else { Text(text) }
                    }
                    .lineLimit(collapsed ? collapsedLines : nil)
                    // Solo emojis (1 a 3): grandes, como en la web (isJumbo).
                    .font(jumbo ? .system(size: jumboSize) : .body)
                    .italic(italic)
                    .foregroundStyle(mine ? Color.white : Theme.textPrimary)
                    .tint(mine ? Color.white : Theme.accentText)
                    .textSelection(.enabled)
                    // Con fotos la burbuja se ciñe a ellas; el texto conserva su margen.
                    .padding(.horizontal, attachments.isEmpty ? 0 : 9).padding(.bottom, attachments.isEmpty ? 0 : 4)
                    if long {
                        Button { if inLazyStack { reading = true } else { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } } } label: {
                            Text(expanded ? L("chat.readLess") : L("chat.readMore")).font(.subheadline.weight(.semibold))
                                .foregroundStyle(mine ? Color.white : Theme.accentText)
                                .padding(.vertical, 2).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("msg.readMore.\(messageId ?? "")")
                        .sheet(isPresented: $reading) { LongTextSheet(text: text, author: author?.name) }
                    }
                    }
                    if let linkPreview { LinkPreviewCard(preview: linkPreview, mine: mine) }
                }
                .padding(.horizontal, attachments.isEmpty ? 13 : 4).padding(.vertical, attachments.isEmpty ? 8 : 4)
                .background(
                    RoundedRectangle(cornerRadius: 18)
                        .fill(mine ? Theme.bubbleMine : (mentionsMe ? Theme.orange.opacity(0.16) : Theme.bubbleOther))
                        .opacity(status == .sending ? 0.7 : 1)
                )
                // Me mencionaron: fondo naranja suave y barra lateral de acento.
                .overlay(alignment: .leading) {
                    if mentionsMe && !mine {
                        UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18).fill(Theme.orange).frame(width: 4)
                            .accessibilityHidden(true)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.red, lineWidth: status == .failed ? 1.5 : 0))
                .background {
                    if sideAnchor {
                        RoundedRectangle(cornerRadius: 22).fill(authorColor?.opacity(0.14) ?? Theme.orange.opacity(0.14))
                            .shadow(color: (authorColor ?? Theme.orange).opacity(0.5), radius: 10)
                            .padding(-5)
                    }
                }
                .anchorPreference(key: SideAnchorKey.self, value: .bounds) { sideAnchor ? ["anchor": $0] : [:] }
                HStack(spacing: 4) {
                    if pinned { Image(systemName: "pin.fill").foregroundStyle(Theme.accentText) }
                    switch status {
                    case .sending: Image(systemName: "clock"); Text(L("chat.sending"))
                    case .failed: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red); Text(L("chat.notSentTap")).foregroundStyle(.red)
                    case nil: Text(time)
                    }
                    if let topic { TopicTag(topic: topic, by: topicBy) }
                }
                .font(.caption2)
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 4)
            }
            if !mine { Spacer(minLength: 48) }
        }
        // Con adjuntos (fotos, archivos, voz) sus controles siguen accesibles.
        .accessibilityElement(children: attachments.isEmpty ? .ignore : .contain)
        .accessibilityLabel(a11yLabel)
        .accessibilityHint(status == .failed ? L("chat.retry") : "")
        .accessibilityActions {
            // Con VoiceOver la burbuja es un solo elemento: los enlaces se abren como acciones.
            if linkify {
                ForEach(Array(Linkify.links(in: text).prefix(3).enumerated()), id: \.offset) { _, l in
                    Button(L("link.open", ["host": l.url.host ?? l.url.absoluteString])) { openURL(l.url) }
                }
            }
        }
    }

    /// Muy largo y sin búsqueda activa (con búsqueda se ve entero para que se vea lo resaltado).
    private var long: Bool { highlight == nil && !italic && LongText.isLong(text) }
    private var collapsed: Bool { long && (!expanded || inLazyStack) }
    /// En la pila perezosa, plegado por alto: las líneas que caben en el tope de la fila (≈ 60 % de lo visible) con la
    /// letra actual; una fila más alta que la pantalla dejaba la LazyVStack re-estimando sin fin.
    private var collapsedLines: Int { inLazyStack ? ChatRowCapRule.lines(cap: rowCap > 0 ? rowCap : ChatRowCapRule.cap(viewport: 0)) : LongText.collapsedLines }

    private var jumbo: Bool { !italic && attachments.isEmpty && mentions.isEmpty && Reactions.isJumbo(text) }

    private var a11yLabel: String {
        var parts: [String] = []
        if mine { parts.append(L("a11y.you")) } else if let author { parts.append([author.name, author.org].compactMap { $0 }.joined(separator: ", ")) }
        if let forwardedLabel { parts.append(forwardedLabel) }
        if let quote { parts.append(L("reply.to", ["name": quote.author]) + ": " + quote.text) }
        if let merged { parts.append(merged) }
        if mentionsMe { parts.append(L("mention.youMentioned")) }
        parts.append(text)
        if let p = linkPreview { parts.append([p.host, p.title].compactMap { $0 }.joined(separator: ": ")) }
        if pinned { parts.append(L("toast.pinned")) }
        if let topic { parts.append([L("topic.set") + ": " + topic.name, topic.isArchived ? L("topic.archivedTag") : nil, topicBy].compactMap { $0 }.joined(separator: ", ")) }
        switch status {
        case .sending: parts.append(L("chat.sending"))
        case .failed: parts.append(L("chat.notSent"))
        case nil: if !time.isEmpty { parts.append(time) }
        }
        return parts.joined(separator: ". ")
    }
}

/// Barra de linaje: de dónde viene, en qué derivó y devolver el resultado.
struct LineageBar: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    var onReturn: () -> Void
    var body: some View {
        if let d = store.data {
            let parent = conv.parentId.flatMap { store.meta($0) }
            // Los hilos que salen de aquí se ven en la barra del chat y como chip bajo su mensaje; aquí, solo de dónde viene.
            if conv.parentId != nil && !Naming.isSide(conv) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Text(L("lin.label")).font(.caption2.weight(.bold)).textCase(.uppercase).foregroundStyle(Theme.textSecondary)
                        if conv.parentId != nil {
                            if let parent {
                                NavigationLink(value: Route.conversation(parent.id)) { chip("↖ \(L("lin.from")) «\(Naming.title(d, parent))»") }
                            } else { chip("↖ \(L("lin.fromHidden"))").opacity(0.7) }
                        }
                        if let k = conv.deriveKind { chip(L("lin.kind.\(k)"), tint: true) }
                        if conv.returnedAt != nil { Text("✓ \(L("lin.returned"))").font(.caption.weight(.semibold)).foregroundStyle(.green) }
                        if parent != nil, conv.returnedAt == nil, conv.canPost {
                            Button(L("lin.return"), action: onReturn)
                                .font(.caption.weight(.semibold))
                                .primaryProminent()
                                .accessibilityIdentifier("lineage.return")
                        }
                        NavigationLink(value: Route.trazo) { Text(L("lin.trazo")).font(.caption) }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6)
                }
                .background(Theme.surface)
                .accessibilityIdentifier("lineage")
            }
        }
    }

    private func chip(_ text: String, tint: Bool = false) -> some View {
        Text(text).font(.caption.weight(.medium)).lineLimit(1)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Capsule().fill(tint ? Theme.orange.opacity(0.15) : Theme.bubbleOther))
            .foregroundStyle(Theme.textPrimary)
    }
}

/// Pila de filas del chat. Hasta `lazyAbove` filas va una VStack normal: con la LazyVStack, abrir el teclado con una
/// tarjeta alta en pantalla (tarea, evento) dejaba la lista reubicando filas sin fin y la app congelada (medido en el
/// simulador: 4 de 4 sin congelarse con VStack; con LazyVStack se congelaba la mayoría de las veces). Con historiales muy
/// largos (se cargaron muchas páginas) vuelve a la perezosa para no dibujar cientos de filas en cada tecla.
/// Mensajes muy largos: más de 40 líneas o 3000 caracteres se muestran plegados a 30 líneas con «Ver más».
enum LongText {
    static let collapsedLines = 30
    static func isLong(_ s: String) -> Bool {
        if s.utf16.count > 3000 { return true }
        var lines = 1
        for c in s.utf16 where c == 10 { lines += 1; if lines > 40 { return true } }
        return false
    }
}

enum ChatStackRule {
    /// `-TCLazyAbove <n>` (pruebas) fuerza la pila perezosa con menos filas.
    static let lazyAbove: Int = UserDefaults.standard.object(forKey: "TCLazyAbove") != nil ? UserDefaults.standard.integer(forKey: "TCLazyAbove") : 200
}

struct ChatStack<Content: View>: View {
    let lazy: Bool
    @ViewBuilder var content: () -> Content
    var body: some View {
        if lazy { LazyVStack(spacing: 4, content: content).environment(\.chatLazyStack, true) } else { VStack(spacing: 4, content: content) }
    }
}

/// En la pila perezosa un mensaje muy largo no se despliega en el chat: la LazyVStack re-estimaba sin fin el alto de una
/// fila más alta que la pantalla (LazyStack.measureEstimates / placeSubviews en bucle, app congelada). Ahí «Ver más» abre
/// el texto completo en una hoja. Prueba: ChatScrollUITests.testLongMessageScrollsInLazyStack.
private struct ChatLazyStackKey: EnvironmentKey { static let defaultValue = false }
private struct ChatRowCapKey: EnvironmentKey { static let defaultValue: CGFloat = 0 }
extension EnvironmentValues {
    var chatLazyStack: Bool {
        get { self[ChatLazyStackKey.self] }
        set { self[ChatLazyStackKey.self] = newValue }
    }
    /// Alto máximo de una fila en la pila perezosa (≈ 60 % de lo visible); 0 = sin tope.
    var chatRowCap: CGFloat {
        get { self[ChatRowCapKey.self] }
        set { self[ChatRowCapKey.self] = newValue }
    }
}

/// Tope de alto de las filas en la pila perezosa: ninguna fila pasa de ≈ 60 % de lo visible (iPhone SE, horizontal y
/// letra grande incluidos). Si la fila entera no cabe, se ve su parte de arriba y «Ver completo», que la abre en una
/// hoja. Una fila más alta que la pantalla dejaba la LazyVStack re-estimando sin fin (app congelada).
enum ChatRowCapRule {
    static let fraction: CGFloat = 0.6
    static func cap(viewport: CGFloat, screen: CGFloat = UIScreen.main.bounds.height) -> CGFloat {
        max(140, (viewport > 0 ? viewport : screen * 0.7) * fraction)
    }
    /// Líneas de un mensaje muy largo plegado que caben en el tope (con la letra actual).
    static func lines(cap: CGFloat, lineHeight: CGFloat = UIFont.preferredFont(forTextStyle: .body).lineHeight) -> Int {
        max(3, min(LongText.collapsedLines, Int((cap * 0.7) / max(1, lineHeight))))
    }
}

struct LazyRowCap: ViewModifier {
    let cap: CGFloat
    @State private var open = false
    func body(content: Content) -> some View {
        if cap > 0 {
            ViewThatFits(in: .vertical) {
                content
                VStack(spacing: 4) {
                    content.frame(height: max(60, cap - 44), alignment: .top).clipped().allowsHitTesting(false)
                        .overlay(alignment: .bottom) {
                            LinearGradient(colors: [Theme.background.opacity(0), Theme.background], startPoint: .top, endPoint: .bottom).frame(height: 36)
                        }
                    Button(L("chat.readMore")) { open = true }
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accentText)
                        .accessibilityIdentifier("row.showAll")
                }
                .frame(maxWidth: .infinity)
            }
            .frame(maxHeight: cap)
            .sheet(isPresented: $open) {
                NavigationStack {
                    ScrollView { content.padding(.vertical, 12).environment(\.chatRowCap, 0).environment(\.chatLazyStack, false) }
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.close")) { open = false } } }
                }
            }
        } else {
            content
        }
    }
}

/// El texto completo de un mensaje muy largo (desde la pila perezosa).
struct LongTextSheet: View {
    @Environment(\.dismiss) private var dismiss
    let text: String
    let author: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text).font(.body).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .accessibilityIdentifier("longText.body")
            }
            .navigationTitle(author ?? L("chat.readMore"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.close")) { dismiss() }.accessibilityIdentifier("longText.close") } }
        }
    }
}
