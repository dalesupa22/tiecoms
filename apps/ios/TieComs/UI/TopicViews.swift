import SwiftUI
import UniformTypeIdentifiers

// Temas del chat (docs/TEMAS.md): fila de banderitas bajo la barra de accesos, etiqueta en cada mensaje,
// hoja «Nuevo tema» / «Renombrar tema» y lista de archivados. Paridad con apps/web/src/screens/Topics.tsx.

/// Banderita: cinta con la punta en V a la derecha (como `clip-path` de .topic-flag en la web).
struct TopicFlagShape: Shape {
    var tail: CGFloat = 9
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - tail, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.midY))
        p.addLine(to: CGPoint(x: r.maxX - tail, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}

/// Aspecto de una banderita: fondo pastel, tinta y franja izquierda más oscura.
private struct TopicFlag: View {
    var text: String
    var count: Int? = nil
    /// Sin leer: pastilla de acento (como .topic-unread de la web). Sin pendientes, nada.
    var unread: Int? = nil
    var bg: Color
    var ink: Color
    var on = false
    var muted = false

    var body: some View {
        HStack(spacing: 6) {
            Text(text).font(.footnote.weight(muted ? .regular : .semibold)).lineLimit(1)
            if let count, count > 0 { Text("\(count)").font(.caption2.weight(.bold)).monospacedDigit().opacity(0.7) }
            if let unread, unread > 0 {
                Text("\(unread)").font(.caption2.weight(.bold)).monospacedDigit().foregroundStyle(Theme.onPrimary)
                    .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
                    .background(Capsule().fill(Theme.primaryFill))
                    .accessibilityIdentifier("topic.unread")
            }
        }
        .foregroundStyle(muted ? Theme.textSecondary : ink)
        .padding(.leading, 11).padding(.trailing, 18)
        // La activa es más alta (36 pt contra 26).
        .frame(height: on ? 36 : 26)
        .background(
            TopicFlagShape().fill(bg)
                .overlay(alignment: .leading) { Rectangle().fill(ink.opacity(0.22)).frame(width: 5) }
                .clipShape(TopicFlagShape())
        )
        .contentShape(TopicFlagShape())
        .fixedSize()
    }
}

/// Fila de banderitas: «💬 General», «☰ Todo» (solo con temas activos), los temas activos (con no leídos primero), «＋ Nuevo» y «🗄 Archivados N». Scroll horizontal.
struct TopicDock: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    /// Filtro efectivo: un tema activo, `TopicRules.all` («Todo») o nil («General»).
    let filter: String?
    let counts: [String: Int]
    /// Sin leer por tema ("" = sin tema, va en «General»): la pastilla de acento de cada banderita.
    var unread: [String: Int] = [:]
    var onFilter: (String?) -> Void
    var onNew: () -> Void
    var onRename: (TopicDTO) -> Void
    var onRemove: (TopicDTO) -> Void
    var onArchived: () -> Void
    /// Arrastrar para reordenar (solo si puedo escribir): la banderita que se mueve y sobre cuál va.
    @State private var dragging: String?
    @State private var over: String?

    var body: some View {
        let list = store.topics[conv.id] ?? []
        let active = TopicRules.active(list)
        let archived = TopicRules.archived(list)
        if !active.isEmpty || !archived.isEmpty || conv.canPost {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 4) {
                        // Sin temas activos, «General» y «Todo» son lo mismo: una sola banderita «Todo».
                        // Las fijas son compactas: solo el ícono, y el nombre únicamente cuando están seleccionadas.
                        let general = active.isEmpty ? L("topic.all") : L("topic.general")
                        let generalIcon = active.isEmpty ? "☰" : "💬"
                        Button { onFilter(nil) } label: {
                            TopicFlag(text: filter == nil ? "\(generalIcon) \(general)" : generalIcon, unread: active.isEmpty ? nil : unread[""], bg: Theme.background, ink: Theme.textSecondary, on: filter == nil)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel([general, !active.isEmpty && (unread[""] ?? 0) > 0 ? L("topic.unreadN", ["n": unread[""] ?? 0]) : nil].compactMap { $0 }.joined(separator: ", "))
                        .accessibilityHint(active.isEmpty ? "" : L("topic.generalHint"))
                        .accessibilityAddTraits(filter == nil ? .isSelected : [])
                        .accessibilityIdentifier("topic.general")
                        if !active.isEmpty {
                            Button { onFilter(filter == TopicRules.all ? nil : TopicRules.all) } label: {
                                TopicFlag(text: filter == TopicRules.all ? "☰ \(L("topic.all"))" : "☰", bg: Theme.background, ink: Theme.textSecondary, on: filter == TopicRules.all)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(L("topic.all"))
                            .accessibilityHint(L("topic.allHint"))
                            .accessibilityAddTraits(filter == TopicRules.all ? .isSelected : [])
                            .accessibilityIdentifier("topic.all")
                        }
                        // Primero los temas con no leídos para mí, luego el resto (TopicRules.dockOrder); cada uno una sola vez.
                        ForEach(TopicRules.dockOrder(active, unread: unread)) { t in
                            Button { onFilter(filter == t.id ? nil : t.id) } label: {
                                TopicFlag(text: "\(t.icon) \(t.name)", unread: unread[t.id], bg: TopicPalette.bg(t.color), ink: TopicPalette.ink(t.color), on: filter == t.id)
                            }
                            .buttonStyle(.plain)
                            .id(t.id)
                            .overlay {
                                if over == t.id && dragging != nil && dragging != t.id {
                                    TopicFlagShape().stroke(Theme.accentText, lineWidth: 2)
                                }
                            }
                            // Mantener presionada: Renombrar, Cambiar color, mover, Archivar y Quitar tema; y arrastrar para reordenar.
                            .contextMenu { if conv.canPost { flagMenu(t, ids: active.map(\.id)) } }
                            .modifier(TopicDragModifier(enabled: conv.canPost, id: t.id, name: t.name, dragging: $dragging, over: $over) { from, to in
                                move(TopicRules.reorder(active.map(\.id), moving: from, onto: to))
                            })
                            .accessibilityActions {
                                if conv.canPost {
                                    Button(L("topic.moveLeft")) { move(TopicRules.step(active.map(\.id), t.id, by: -1)) }
                                    Button(L("topic.moveRight")) { move(TopicRules.step(active.map(\.id), t.id, by: 1)) }
                                }
                            }
                            .accessibilityLabel([t.name, (unread[t.id] ?? 0) > 0 ? L("topic.unreadN", ["n": unread[t.id] ?? 0]) : nil].compactMap { $0 }.joined(separator: ", "))
                            .accessibilityHint(conv.canPost ? L("topic.a11yHint") : "")
                            .accessibilityAddTraits(filter == t.id ? .isSelected : [])
                            .accessibilityIdentifier("topic.flag.\(t.name)")
                        }
                        if conv.canPost {
                            Button(action: onNew) {
                                TopicFlag(text: "＋ \(L("topic.new"))", bg: Theme.background, ink: Theme.textSecondary, muted: true)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("topic.new")
                        }
                        if !archived.isEmpty {
                            Button(action: onArchived) {
                                TopicFlag(text: "🗄 \(L("topic.archivedN", ["n": archived.count]))", bg: TopicPalette.grayBg, ink: TopicPalette.grayInk)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("topic.archived")
                        }
                    }
                    .padding(.horizontal, 10)
                    .animation(.easeOut(duration: 0.15), value: filter)
                }
                .frame(height: 38)
                .onChange(of: filter) { _, f in if let f { withAnimation { proxy.scrollTo(f, anchor: .center) } } }
                // Al abrir ya filtrado (salto o no leídos) la banderita elegida queda a la vista.
                .onAppear { if let f = filter { DispatchQueue.main.async { proxy.scrollTo(f, anchor: .center) } } }
            }
            .background(Theme.surface)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.textSecondary.opacity(0.15)).frame(height: 0.5) }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L("topic.bar"))
            .accessibilityIdentifier("topic.dock")
        }
    }

    /// Guarda el orden nuevo (optimista; si falla vuelve el anterior y sale el aviso con el error).
    private func move(_ ids: [String]?) {
        guard let ids else { return }
        Haptics.tap()
        let cid = conv.id
        Task { do { try await store.reorderTopics(cid, ids: ids) } catch { store.show(L10n.errorText(error)) } }
    }

    @ViewBuilder private func flagMenu(_ t: TopicDTO, ids: [String]) -> some View {
        Button { onRename(t) } label: { Label(L("topic.rename"), systemImage: "pencil") }
        if ids.first != t.id {
            Button { move(TopicRules.step(ids, t.id, by: -1)) } label: { Label(L("topic.moveLeft"), systemImage: "arrow.left") }
        }
        if ids.last != t.id {
            Button { move(TopicRules.step(ids, t.id, by: 1)) } label: { Label(L("topic.moveRight"), systemImage: "arrow.right") }
        }
        Menu {
            ForEach(TopicRules.colors, id: \.self) { c in
                Button { update(t, ["color": c]) } label: {
                    if c == t.color { Label(L("topic.colors.\(c)"), systemImage: "checkmark") } else { Text(L("topic.colors.\(c)")) }
                }
            }
        } label: { Label(L("topic.color"), systemImage: "paintpalette") }
        Divider()
        Button { archive(t) } label: { Label(L("topic.archive"), systemImage: "archivebox") }
        Button(role: .destructive) { onRemove(t) } label: { Label(L("topic.remove"), systemImage: "delete.left") }
    }

    private func update(_ t: TopicDTO, _ patch: [String: Any]) {
        Task { do { try await store.updateTopic(t, patch) } catch { store.show(L10n.errorText(error)) } }
    }

    /// Archivar saca la banderita de la fila; el aviso trae «Deshacer» (restaurar).
    private func archive(_ t: TopicDTO) {
        if filter == t.id { onFilter(nil) }
        Task {
            do {
                try await store.updateTopic(t, ["archived": true])
                store.show(L("topic.archived", ["name": t.name])) { [store] in
                    Task { do { try await store.updateTopic(t, ["archived": false]) } catch { store.show(L10n.errorText(error)) } }
                }
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// Arrastrar una banderita sobre otra para reordenar (el orden es del chat: lo ven todos).
private struct TopicDragModifier: ViewModifier {
    var enabled: Bool
    var id: String
    var name: String
    @Binding var dragging: String?
    @Binding var over: String?
    var onDrop: (String, String) -> Void

    func body(content: Content) -> some View {
        if enabled {
            content
                .onDrag {
                    dragging = id
                    return NSItemProvider(object: id as NSString)
                } preview: {
                    Text(name).font(.footnote.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Capsule().fill(Theme.surface))
                }
                .onDrop(of: [UTType.plainText], delegate: Delegate(id: id, dragging: $dragging, over: $over, onDrop: onDrop))
        } else {
            content
        }
    }

    struct Delegate: DropDelegate {
        var id: String
        @Binding var dragging: String?
        @Binding var over: String?
        var onDrop: (String, String) -> Void
        func validateDrop(info: DropInfo) -> Bool { dragging != nil }
        func dropEntered(info: DropInfo) { over = id }
        func dropExited(info: DropInfo) { if over == id { over = nil } }
        func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
        func performDrop(info: DropInfo) -> Bool {
            let from = dragging
            dragging = nil; over = nil
            guard let from, from != id else { return false }
            onDrop(from, id)
            return true
        }
    }
}

/// Etiqueta pequeña del tema junto a la hora de un mensaje. Archivado: gris con 🗄.
struct TopicTag: View {
    let topic: TopicDTO
    var by: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            Text("\(topic.isArchived ? "🗄" : topic.icon) \(topic.name)")
                .font(.caption2.weight(.semibold)).lineLimit(1)
                .padding(.horizontal, 7).padding(.vertical, 1)
                .foregroundStyle(topic.isArchived ? TopicPalette.grayInk : TopicPalette.ink(topic.color))
                .background(RoundedRectangle(cornerRadius: 8).fill(topic.isArchived ? TopicPalette.grayBg : TopicPalette.bg(topic.color)))
            if let by { Text("· \(by)").font(.caption2).foregroundStyle(Theme.textSecondary).lineLimit(1) }
        }
        .accessibilityIdentifier("topic.tag")
    }
}

/// Submenú «🏷 Tema» de un mensaje: cualquiera del chat lo etiqueta con un tema activo, lo deja sin tema o crea uno.
struct MessageTopicMenu: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    var onNewTopic: () -> Void

    var body: some View {
        let list = store.topics[message.conversationId] ?? []
        Menu {
            ForEach(TopicRules.active(list)) { t in
                Button { MessageTopicMenu.set(store, message, t.id, list: list) } label: {
                    if message.topicId == t.id { Label("\(t.icon) \(t.name)", systemImage: "checkmark") } else { Text("\(t.icon) \(t.name)") }
                }
            }
            Divider()
            Button { MessageTopicMenu.set(store, message, nil, list: list) } label: {
                if message.topicId == nil { Label(L("topic.none"), systemImage: "checkmark") } else { Label(L("topic.none"), systemImage: "delete.left") }
            }
            .disabled(message.topicId == nil)
            Button(action: onNewTopic) { Label(L("topic.newTitle"), systemImage: "plus") }
        } label: { Label(L("topic.set"), systemImage: "tag") }
        .accessibilityIdentifier("menu.topic")
    }

    /// PUT /messages/:id/topic con aviso y «Deshacer» (vuelve al tema anterior).
    static func set(_ store: AppStore, _ m: MessageDTO, _ topicId: String?, list: [TopicDTO]) {
        let prev = m.topicId
        guard prev != topicId else { return }
        Task {
            do {
                try await store.setMessageTopic(m, topicId)
                let name = list.first { $0.id == topicId }?.name
                store.show(name.map { L("topic.tagged", ["name": $0]) } ?? L("topic.untagged")) { [store] in
                    Task { try? await store.setMessageTopic(m, prev) }
                }
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// «Nuevo tema» (nombre, ícono y color, con vista previa) o «Renombrar tema». Sin límite práctico: el 409 del servidor se muestra.
struct TopicEditorSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    var edit: TopicDTO? = nil
    var onCreated: ((TopicDTO) -> Void)? = nil
    @State private var name = ""
    @State private var icon = ""
    @State private var color = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        SheetForm(title: edit == nil ? L("topic.newTitle") : L("topic.renameTitle"), action: edit == nil ? L("topic.create") : L("common.save"),
                  busy: busy, disabled: clean.isEmpty, error: error, onSubmit: save) {
            Section(L("topic.name")) {
                TextField(L("topic.namePh"), text: $name)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(save)
                    .onChange(of: name) { _, v in if v.count > 40 { name = String(v.prefix(40)) } }
                    .accessibilityIdentifier("topic.nameField")
            }
            Section(L("topic.icon")) {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 6) {
                    ForEach(TopicRules.icons, id: \.self) { i in
                        Button { icon = i } label: {
                            Text(i).font(.title3).frame(width: 40, height: 40)
                                .background(RoundedRectangle(cornerRadius: 10).fill(i == icon ? Theme.surface : Theme.background))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(i == icon ? Theme.textPrimary : Theme.textSecondary.opacity(0.25), lineWidth: i == icon ? 2 : 1))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(i)
                        .accessibilityAddTraits(i == icon ? .isSelected : [])
                    }
                }
                .padding(.vertical, 4)
            }
            Section(L("topic.colorLabel")) {
                HStack(spacing: 10) {
                    ForEach(TopicRules.colors, id: \.self) { c in
                        Button { color = c } label: {
                            Circle().fill(TopicPalette.bg(c))
                                .overlay(Circle().inset(by: 7).fill(TopicPalette.ink(c)))
                                .frame(width: 30, height: 30)
                                .overlay(Circle().stroke(c == color ? Theme.textPrimary : .clear, lineWidth: 2).padding(-3))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L("topic.colors.\(c)"))
                        .accessibilityAddTraits(c == color ? .isSelected : [])
                        .accessibilityIdentifier("topic.color.\(c)")
                    }
                }
                .padding(.vertical, 4)
                HStack {
                    TopicFlag(text: "\(icon) \(clean.isEmpty ? L("topic.namePh") : clean)", bg: TopicPalette.bg(color), ink: TopicPalette.ink(color), on: true)
                    Spacer()
                }
                .accessibilityHidden(true)
            }
        }
        .presentationDetents([.large])
        .onAppear {
            let list = store.topics[conversationId] ?? []
            name = edit?.name ?? ""
            icon = edit?.icon ?? TopicRules.suggestedIcon(list)
            color = edit?.color ?? TopicRules.suggestedColor(list)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { focused = true }
        }
    }

    private func save() {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                if let edit {
                    try await store.updateTopic(edit, ["name": clean, "icon": icon, "color": color])
                    dismiss()
                } else {
                    let t = try await store.createTopic(conversationId, name: clean, icon: icon, color: color)
                    dismiss()
                    if let t { onCreated?(t) }
                }
            } catch {
                // 409: nombre repetido o tope técnico; el texto del servidor dice cuál.
                self.error = L10n.errorText(error)
            }
        }
    }
}

/// Temas archivados con «Restaurar» (el servidor responde 409 si se llega al tope técnico).
struct ArchivedTopicsSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let conversationId: String

    var body: some View {
        NavigationStack {
            List {
                let archived = TopicRules.archived(store.topics[conversationId] ?? [])
                Section {
                    if archived.isEmpty { Text(L("topic.archivedEmpty")).font(.footnote).foregroundStyle(Theme.textSecondary) }
                    ForEach(archived) { t in
                        HStack(spacing: 10) {
                            Text(t.icon)
                            Text(t.name).font(.body.weight(.semibold)).lineLimit(1)
                            Spacer()
                            Button(L("topic.restore")) {
                                Task {
                                    do {
                                        try await store.updateTopic(t, ["archived": false])
                                        store.show(L("topic.restored", ["name": t.name]))
                                    } catch { store.show(L10n.errorText(error)) }
                                }
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("topic.restore.\(t.name)")
                        }
                    }
                } footer: { Text(L("topic.archiveHint")) }
            }
            .navigationTitle(L("topic.archivedTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Confirmación de «Quitar tema» («¿Quitar «X»? N mensajes quedan sin tema. No se borra ningún mensaje.»).
struct RemoveTopicDialog: ViewModifier {
    @Binding var topic: TopicDTO?
    var count: Int
    var onConfirm: (TopicDTO) -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(topic.map { L("topic.removeConfirm", ["name": $0.name, "n": count]) } ?? "",
                                   isPresented: Binding(get: { topic != nil }, set: { if !$0 { topic = nil } }), titleVisibility: .visible) {
            Button(L("topic.remove"), role: .destructive) { if let t = topic { onConfirm(t) } }
            Button(L("common.cancel"), role: .cancel) {}
        }
    }
}
