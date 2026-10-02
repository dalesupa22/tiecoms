import SwiftUI

// WhatsApp en la bandeja, fijar deslizando y los accesos con logo (docs/CONTRATO-GG-CHAT-WA-INBOX.md, parte A).

/// Verde de WhatsApp para el contador de no leídos de sus filas.
enum WaColors {
    static let green = Color(hex: 0x25D366)
    static let badge = Color(hex: 0x1DA851)
}

/// Punto de color de una cuenta de WhatsApp: con más de una cuenta conectada distingue la fila sin texto. El color sale
/// del id de la cuenta (el mismo en la pantalla WhatsApp, en Grupos/DMs y en la hoja de cuentas).
struct WaAccountDot: View {
    let accountId: String
    var size: CGFloat = 8
    var body: some View {
        Circle().fill(Self.color(accountId)).frame(width: size, height: size)
            .overlay(Circle().stroke(Theme.background, lineWidth: 1))
            .accessibilityHidden(true)
    }

    /// Colores bien distintos entre sí (verde, azul, morado, ámbar, rosa), fijos por cuenta.
    static let palette: [UInt32] = [0x25D366, 0x2F6FDB, 0x7C4DDB, 0xF59E0B, 0xD6338A]
    static func color(_ accountId: String) -> Color {
        let h = accountId.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
        return Color(hex: palette[Int(h % UInt32(palette.count))])
    }
}

/// Fila de un chat de WhatsApp mezclada en Grupos o DMs: avatar con el logo verde en la esquina, nombre, vista previa,
/// contador verde y 📌 si está fijado en la pantalla principal. Con varias cuentas, un punto de color (sin texto).
/// Cuenta desconectada: atenuada y «WhatsApp desconectado».
struct WaInboxRow: View {
    let chat: WaChatDTO
    var multi = false
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        let off = chat.isDisconnected
        HStack(alignment: .top, spacing: 10) {
            Avatar(name: chat.name.isEmpty ? "WhatsApp" : chat.name, org: nil, size: 30, fill: PersonColor.fill(chat.inboxKey))
                .overlay(alignment: .bottomTrailing) {
                    WaIcon(size: 14).overlay(Circle().stroke(Theme.background, lineWidth: 1.5)).offset(x: 3, y: 3)
                }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(chat.name).font(.subheadline.weight(chat.unread > 0 ? .bold : .medium)).foregroundStyle(Theme.textPrimary)
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    if multi { WaAccountDot(accountId: chat.accountId, size: 7) }
                    Spacer(minLength: 4)
                    if chat.inboxPinnedAt != nil {
                        Text("📌").font(.caption2).accessibilityHidden(true).accessibilityIdentifier("row.pinned.\(chat.inboxKey)")
                    }
                    if chat.unread > 0 && !off { UnreadPill(count: chat.unread, color: WaColors.badge).accessibilityIdentifier("wa.row.unread") }
                }
                if off {
                    Text(L("wa.disconnected")).font(.caption2).foregroundStyle(Color.red.opacity(0.8)).lineLimit(1).padding(.top, -1)
                }
                HStack(spacing: 6) {
                    Text(chat.lastPreview ?? "").font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    Spacer(minLength: 4)
                    Text(L10n.timeLabel(chat.lastMessageAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .opacity(off ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([chat.name, "WhatsApp", multi ? chat.accountLabel : nil, off ? L("wa.disconnected") : nil,
                             chat.inboxPinnedAt != nil ? L("side.pinned") : nil,
                             chat.unread > 0 ? L("a11y.unread", ["n": chat.unread]) : nil, chat.lastPreview].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

/// Menú de un chat de WhatsApp (pulsación larga, ⋯ de la fila y ⋯ dentro de la conversación). Los dos pines con nombre
/// propio: «📌 Fijar en la pantalla principal» (`inboxPinned`, arriba en Grupos/DMs) y «📌 Fijar en WhatsApp» (`pinned`,
/// arriba en la pantalla WhatsApp). Aparte, «Llevar a mi lista principal» (`inboxPlace`), categoría y ocultar.
struct WaChatMenuItems: View {
    @Environment(AppStore.self) private var store
    let chat: WaChatDTO
    /// En la pantalla WhatsApp y en la conversación: también Categoría y Ocultar.
    var full = true
    var onChanged: (WaChatDTO) -> Void = { _ in }
    var body: some View {
        // La bandeja manda en lo suyo (inboxPlace/inboxPinnedAt); el resto, la copia que se tiene.
        let inbox = store.waInbox.first { $0.id == chat.id }
        let c = inbox.map { i -> WaChatDTO in var x = chat; x.inboxPlace = i.inboxPlace; x.inboxPinnedAt = i.inboxPinnedAt; return x } ?? chat
        let onMain = c.inboxPinnedAt != nil
        Button { run(toast: onMain ? L("toast.unpinned") : L("toast.pinned")) { try await store.waSetInboxPinned(c, !onMain) } } label: {
            if onMain { Label(L("wa.unpinMain"), systemImage: "pin.slash") } else { Text(L("wa.pinMain")) }
        }
        .accessibilityIdentifier("wa.menu.pinMain")
        Button { run(toast: c.pinned ? L("toast.unpinned") : L("toast.pinned")) { try await store.waSetPinned(c, !c.pinned) } } label: {
            if c.pinned { Label(L("wa.unpinWa"), systemImage: "pin.slash") } else { Text(L("wa.pinWa")) }
        }
        .accessibilityIdentifier("wa.menu.pinWa")
        Divider()
        if let place = c.inboxPlace {
            let other = place == WaInbox.groups ? WaInbox.dms : WaInbox.groups
            Button { run(toast: L(other == WaInbox.groups ? "wa.movedGroups" : "wa.movedDms")) { try await store.waSetInboxPlace(c, other) } } label: {
                Label(L(other == WaInbox.groups ? "wa.moveGroups" : "wa.moveDms"), systemImage: other == WaInbox.groups ? "number" : "bubble.left.and.bubble.right")
            }
            .accessibilityIdentifier(other == WaInbox.groups ? "wa.menu.moveGroups" : "wa.menu.moveDms")
            Button(role: .destructive) { run(toast: L("wa.removedInbox")) { try await store.waSetInboxPlace(c, nil) } } label: {
                Label(L("wa.removeFromInbox"), systemImage: "tray.and.arrow.up")
            }
            .accessibilityIdentifier("wa.menu.remove")
        } else {
            Menu {
                place(c, WaInbox.groups, L("wa.toGroups"))
                place(c, WaInbox.dms, L("wa.toDms"))
            } label: { Label(L("wa.moveToInbox"), systemImage: "tray.and.arrow.down") }
            .accessibilityIdentifier("wa.inbox.move")
        }
        if full {
            Menu {
                ForEach(WaCategory.allCases, id: \.self) { k in
                    Button { run { try await store.waPatchChat(c, ["category": k.rawValue]) } } label: {
                        if c.category == k { Label("\(k.icon) \(L("wa.cat.\(k.rawValue)"))", systemImage: "checkmark") } else { Text("\(k.icon) \(L("wa.cat.\(k.rawValue)"))") }
                    }
                }
                if c.categoryManual {
                    Divider()
                    Button(L("wa.resetCategory")) { run { try await store.waPatchChat(c, ["category": NSNull()]) } }
                }
            } label: { Label(L("wa.category") + " · " + L("wa.cat.\(c.category.rawValue)"), systemImage: "folder") }
            .accessibilityIdentifier("wa.menu.category")
            Button(role: c.hidden ? nil : .destructive) { hide(c) } label: {
                Label(c.hidden ? L("wa.unhide") : L("wa.hide"), systemImage: c.hidden ? "eye" : "eye.slash")
            }
            .accessibilityIdentifier("wa.menu.hide")
        }
    }

    @ViewBuilder private func place(_ c: WaChatDTO, _ p: String, _ title: String) -> some View {
        Button { run(toast: L(p == WaInbox.groups ? "wa.movedGroups" : "wa.movedDms")) { try await store.waSetInboxPlace(c, p) } } label: {
            if c.suggestedPlace == p { Label(title + " · " + L("wa.suggestedPlace"), systemImage: "checkmark") } else { Text(title) }
        }
        .accessibilityIdentifier("wa.inbox.to.\(p)")
    }

    private func hide(_ c: WaChatDTO) {
        let to = !c.hidden
        Task {
            do {
                let up = try await store.waSetHidden(c, to)
                onChanged(up)
                if to {
                    store.show(L("wa.hiddenToast")) {
                        Task { if let back = try? await store.waSetHidden(up, false) { onChanged(back); store.waRevision += 1 } }
                    }
                }
            } catch { store.show(L10n.errorText(error)) }
        }
    }

    private func run(toast: String? = nil, _ f: @escaping () async throws -> WaChatDTO) {
        Task {
            do { let up = try await f(); onChanged(up); if let toast { store.show(toast) } } catch { store.show(L10n.errorText(error)) }
        }
    }
}

extension View {
    /// Deslizar a la derecha: Fijar / Quitar (todas las filas de Grupos y DMs, chaggu y WhatsApp).
    func pinSwipe(pinned: Bool, id: String, _ toggle: @escaping () -> Void) -> some View {
        swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button(action: toggle) {
                Label(pinned ? L("wa.inboxUnpin") : L("wa.inboxPin"), systemImage: pinned ? "pin.slash.fill" : "pin.fill")
            }
            .tint(pinned ? .gray : Theme.orange)
            .accessibilityIdentifier("swipe.pin.\(id)")
        }
    }
}

extension AppStore {
    /// Fijar o quitar una conversación de chaggu desde el deslizar (con aviso si falla).
    func togglePin(_ c: ConversationDTO) {
        let pinned = c.pinnedAt != nil
        Haptics.tap()
        Task { do { try await setConversationPrefs(c.id, pinned: !pinned) } catch { show(L10n.errorText(error)) } }
    }
    func toggleWaPin(_ w: WaChatDTO) {
        Haptics.tap()
        Task { do { try await waSetInboxPinned(w, w.inboxPinnedAt == nil) } catch { show(L10n.errorText(error)) } }
    }
    /// ¿Hay chats de más de una cuenta en la bandeja? Entonces cada fila lleva el punto de color de su cuenta.
    var waInboxMultiAccount: Bool { Set(waInbox.map(\.accountId)).count > 1 }
}

// MARK: - Accesos con logo y chip de recordatorios

/// Al inicio de la fila de chips: `[logo WhatsApp N]` y `[logo Gmail|Outlook N]`, solo lo conectado. Un toque abre la
/// lista; con varias cuentas de correo abre la última usada y la pulsación larga elige la cuenta.
struct ChannelAccessChips: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        let ch = store.channels
        let mail = ch.activeMail
        HStack(spacing: 6) {
            if ch.waConnected {
                chip(icon: AnyView(WaIcon(size: 18)), n: ch.waUnread, color: WaColors.badge, label: "WhatsApp", id: "access.whatsapp") { store.push(.whatsapp) }
            }
            if let p = mail.first(where: { $0.provider == MailLastProvider.load() }) ?? mail.first {
                chip(icon: AnyView(MailProviderIcon(provider: p.provider, size: 18)), n: ch.mailUnread, color: Theme.badgeFallback, label: p.label, id: "access.mail") {
                    MailLastProvider.save(p.provider)
                    store.push(.mailBox(conversationId: nil))
                }
                .contextMenu {
                    if mail.count > 1 {
                        ForEach(mail) { m in
                            Button {
                                MailLastProvider.save(m.provider)
                                store.push(.mailBox(conversationId: nil))
                            } label: { Label(m.accountEmail ?? m.label, systemImage: m.provider == p.provider ? "checkmark" : "envelope") }
                        }
                    }
                }
            }
        }
    }

    private func chip(icon: AnyView, n: Int, color: Color, label: String, id: String, _ action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(spacing: 5) {
                icon
                if n > 0 {
                    Text(n > 99 ? "99+" : "\(n)").font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(color)
                }
            }
            .padding(.horizontal, 10).frame(minHeight: 40)
            .background(Capsule().fill(Theme.surface))
            .overlay(Capsule().stroke(Theme.textSecondary.opacity(0.2)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(n > 0 ? L("a11y.unread", ["n": n]) : "")
        .accessibilityIdentifier(id)
    }
}

/// «🔔 N» al final de la fila de filtros (antes, la fila «Recordatorios (N)»). No sale si es 0.
struct DueRemindersChip: View {
    @Environment(AppStore.self) private var store
    let due: Int
    var body: some View {
        Button { store.homePath.append(.reminders) } label: {
            HStack(spacing: 4) {
                Text("🔔").font(.subheadline)
                Text("\(due)").font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(Theme.textPrimary)
            }
            .padding(.horizontal, 12).frame(minHeight: 40)
            .background(Capsule().fill(Theme.surface))
            .overlay(Capsule().stroke(Theme.textSecondary.opacity(0.2)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("rem.title"))
        .accessibilityValue("\(due)")
        .accessibilityIdentifier("home.dueReminders")
    }
}


private struct WaPrivateSourceModifier: ViewModifier {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: String
    @State private var openedToken: Int?
    func body(content: Content) -> some View {
        let current = store.waPrivacy.token(source)
        let allowed = store.waPrivacy.allows(source) && (openedToken == nil || openedToken == current)
        Group { if allowed { content } else { Color.clear } }
            .onAppear { if openedToken == nil { openedToken = current }; if !allowed { dismiss() } }
            .onChange(of: current) { _, value in if let openedToken, openedToken != value { dismiss() } }
            .onChange(of: allowed) { _, value in if !value { dismiss() } }
    }
}
extension View {
    func waPrivateSource(_ source: String) -> some View { modifier(WaPrivateSourceModifier(source: source)) }
}
