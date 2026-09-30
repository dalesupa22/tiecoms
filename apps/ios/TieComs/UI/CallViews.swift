import SwiftUI
import UIKit

// Llamadas (docs/LLAMADAS.md): botones del encabezado, franja «Llamada en curso · Unirse», aviso de llamada entrante,
// pantalla de la llamada (con subtítulos y transcripción), detalle con resumen y transcripción, y pestaña «Llamadas».
// Paridad con apps/web/src/screens/Call.tsx. Todo aparece solo con `features.calls` del bootstrap.

/// Nombre corto; si la persona no está en mi lista (me agregaron a la llamada), sale de `call.names`.
private func firstName(_ d: BootstrapDTO, _ id: String?, _ names: [String: String] = [:]) -> String {
    guard let id, let n = Naming.person(d, id)?.name ?? names[id] else { return "" }
    return n.split(separator: " ").first.map(String.init) ?? n
}

private func elapsed(since iso: String, now: Date) -> Int {
    guard let start = ISODate.parse(iso) else { return 0 }
    return max(0, Int(now.timeIntervalSince(start)))
}

// MARK: - Encabezado del chat

/// 📞 y 🎥 del encabezado (solo con las llamadas prendidas en el servidor y si puedo escribir).
struct CallHeaderButtons: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    var body: some View {
        if store.data?.callsEnabled == true, conv.canPost {
            HStack(spacing: 14) {
                Button { start("audio") } label: { Image(systemName: "phone") }
                    .accessibilityLabel(L("call.audio"))
                    .accessibilityIdentifier("call.start.audio")
                Button { start("video") } label: { Image(systemName: "video") }
                    .accessibilityLabel(L("call.video"))
                    .accessibilityIdentifier("call.start.video")
            }
        }
    }
    private func start(_ kind: String) {
        Haptics.tap()
        let center = store.callCenter
        Task { do { try await center.start(conv.id, kind: kind) } catch { store.show(L10n.errorText(error)) } }
    }
}

/// Franja arriba del chat cuando hay una llamada en curso a la que no he entrado.
struct CallBanner: View {
    @Environment(AppStore.self) private var store
    let conversationId: String
    var body: some View {
        Group {
            if let d = store.data, d.callsEnabled, let call = store.liveCalls[conversationId], store.callCenter.view?.call.id != call.id {
                let names = (call.activeUserIds.map { firstName(d, $0) } + call.guests.map { "\($0.name) (\(L("call.guestBadge")))" })
                    .filter { !$0.isEmpty }.joined(separator: ", ")
                HStack(spacing: 10) {
                    Image(systemName: call.isVideo ? "video.fill" : "phone.fill").foregroundStyle(Theme.accentText)
                    Text([L("call.inProgress"), names.isEmpty ? nil : names, call.transcribing ? L("call.transcribingShort") : nil]
                            .compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    Spacer(minLength: 4)
                    Button(L("call.join")) {
                        let center = store.callCenter
                        Task { do { try await center.join(call.id, camera: false) } catch { store.show(L10n.errorText(error)) } }
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.primaryFill).controlSize(.small)
                    .accessibilityIdentifier("call.banner.join")
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Theme.orange.opacity(0.12))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("call.banner")
            }
        }
    }
}

// MARK: - Llamada entrante y píldora

/// Aviso en primer plano: Contestar, Contestar con cámara y Ahora no (deja de sonar a los 45 s o si la llamada termina).
struct IncomingCallBanner: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        if let r = store.callCenter.ringing {
            let center = store.callCenter
            HStack(spacing: 10) {
                Image(systemName: r.call.isVideo ? "video.fill" : "phone.fill")
                    .font(.title3).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(Circle().fill(Theme.primaryFill))
                    .symbolEffect(.pulse, options: .repeating)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.callerName.isEmpty ? L("call.incoming") : r.callerName).font(.subheadline.weight(.bold)).lineLimit(1)
                    Text(r.title.map { L("call.incomingIn", ["title": $0]) } ?? L("call.incoming"))
                        .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Button { center.decline() } label: {
                    Image(systemName: "phone.down.fill").foregroundStyle(.white).frame(width: 40, height: 40).background(Circle().fill(Color.red))
                }
                .accessibilityLabel(L("call.decline")).accessibilityIdentifier("call.ring.decline")
                if r.call.isVideo {
                    Button { center.answer(camera: true) } label: {
                        Image(systemName: "video.fill").foregroundStyle(.white).frame(width: 40, height: 40).background(Circle().fill(Color.green))
                    }
                    .accessibilityLabel(L("call.answerVideo")).accessibilityIdentifier("call.ring.video")
                }
                Button { center.answer(camera: false) } label: {
                    Image(systemName: "phone.fill").foregroundStyle(.white).frame(width: 40, height: 40).background(Circle().fill(Color.green))
                }
                .accessibilityLabel(r.call.isVideo ? L("call.answerAudio") : L("call.answer")).accessibilityIdentifier("call.ring.answer")
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 18).fill(Theme.surface).shadow(color: .black.opacity(0.18), radius: 10, y: 4))
            .padding(.horizontal, 12)
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("call.ring")
        }
    }
}

/// Llamada minimizada: píldora arriba («Llamada · 1:23»), tocarla vuelve a la pantalla completa.
struct ActiveCallPill: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        let center = store.callCenter
        if let v = center.view, !v.isGuest, !center.expanded, let d = store.data {
            HStack(spacing: 10) {
                Button { center.expanded = true } label: {
                    HStack(spacing: 8) {
                        Circle().fill(v.phase == .live ? Color.green : Color.orange).frame(width: 8, height: 8)
                        Image(systemName: v.call.isVideo ? "video.fill" : "phone.fill")
                        Text(CallTitle.text(d, v.call)).lineLimit(1)
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Text(v.phase == .connecting ? L("call.connecting") : CallRules.clock(elapsed(since: v.call.startedAt, now: ctx.date))).monospacedDigit()
                        }
                        if v.call.transcribing { Image(systemName: "record.circle").foregroundStyle(.red) }
                    }
                    .font(.footnote.weight(.semibold)).foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("call.pill")
                Button { Task { await center.hangUp() } } label: {
                    Image(systemName: "phone.down.fill").font(.footnote).foregroundStyle(.white)
                        .frame(width: 30, height: 30).background(Circle().fill(Color.red))
                }
                .accessibilityLabel(L("call.hangUp"))
            }
            .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 5)
            .background(Capsule().fill(Color(hex: 0x1F8F4E)))
            .shadow(color: .black.opacity(0.2), radius: 6, y: 2)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

enum CallTitle {
    static func text(_ d: BootstrapDTO, _ call: CallDTO) -> String {
        if let c = d.conversations.first(where: { $0.id == call.conversationId }) { return Naming.title(d, c) }
        // Me agregaron a una llamada de un chat donde no estoy: los nombres de quienes están.
        let others = (call.activeUserIds + call.invitedUserIds).filter { $0 != d.me.id }.map { firstName(d, $0, call.names) }.filter { !$0.isEmpty }
        var seen = Set<String>()
        let uniq = others.filter { seen.insert($0).inserted }
        return uniq.isEmpty ? L("call.title") : uniq.joined(separator: ", ")
    }
}

/// 1.7.1: «📞 En llamada en tu iPhone · {chat}» cuando estoy en una llamada desde otro dispositivo mío:
/// Pasar aquí (entra y saca al otro), Unirme también y Agregar.
struct OtherDeviceCallBanner: View {
    @Environment(AppStore.self) private var store
    @State private var adding: CallDTO?
    var body: some View {
        let center = store.callCenter
        let here = center.view?.call.id
        if let d = store.data, d.callsEnabled,
           let call = store.liveCalls.values.sorted(by: { $0.startedAt > $1.startedAt }).first(where: { CallRules.onOtherDevice($0, inCallHere: here) != nil }),
           let dev = CallRules.onOtherDevice(call, inCallHere: here) {
            VStack(alignment: .leading, spacing: 8) {
                Text("📞 " + L("call.otherDevice", ["device": dev.label.isEmpty ? dev.platform : dev.label, "chat": CallTitle.text(d, call)]))
                    .font(.footnote.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
                HStack(spacing: 8) {
                    Button(L("call.moveHere")) { center.handOff(call, from: dev.deviceKey) }
                        .buttonStyle(.borderedProminent).tint(.white).foregroundStyle(Color(hex: 0x1F8F4E)).controlSize(.small)
                        .accessibilityIdentifier("call.moveHere")
                    Button(L("call.joinToo")) { Task { do { try await center.join(call.id, camera: false) } catch { store.show(L10n.errorText(error)) } } }
                        .buttonStyle(.bordered).tint(.white).controlSize(.small)
                        .accessibilityIdentifier("call.joinToo")
                    Button { adding = call } label: { Label(L("call.addShort"), systemImage: "person.badge.plus") }
                        .buttonStyle(.bordered).tint(.white).controlSize(.small)
                        .accessibilityIdentifier("call.otherDevice.add")
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color(hex: 0x1F8F4E)))
            .padding(.horizontal, 12)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("call.otherDeviceBanner")
            .sheet(item: $adding) { c in AddToCallSheet(call: c) }
        }
    }
}

/// «En curso ahora» (pestaña Llamadas): llamadas sin terminar de mis chats, con quién está, Unirse y Agregar.
struct ActiveCallsSection: View {
    @Environment(AppStore.self) private var store
    let items: [ActiveCallDTO]
    @State private var adding: CallDTO?
    var body: some View {
        if let d = store.data, !items.isEmpty {
            Section {
                ForEach(items) { a in
                    let c = store.liveCalls[a.call.conversationId].flatMap { $0.id == a.call.id ? $0 : nil } ?? a.call
                    let mineHere = store.callCenter.view?.call.id == c.id
                    HStack(spacing: 10) {
                        ZStack(alignment: .leading) {
                            ForEach(Array(c.activeUserIds.prefix(4).enumerated()), id: \.offset) { k, id in
                                Avatar(person: Naming.person(d, id), org: nil, size: 30).overlay(Circle().stroke(Theme.surface, lineWidth: 1.5))
                                    .offset(x: CGFloat(k) * 16).zIndex(Double(4 - k))
                            }
                        }
                        .frame(width: 30 + CGFloat(max(0, min(c.activeUserIds.count, 4) - 1)) * 16, height: 30, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.title ?? CallTitle.text(d, c)).font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text([c.isVideo ? "🎥" : "📞", c.activeUserIds.compactMap { Naming.person(d, $0)?.name.split(separator: " ").first.map(String.init) ?? c.names[$0] }.joined(separator: ", ")].joined(separator: " "))
                                .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        Button { adding = c } label: { Image(systemName: "person.badge.plus") }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(L("call.add")).accessibilityIdentifier("calls.active.add.\(c.id)")
                        if !mineHere {
                            Button(L("call.join")) {
                                let center = store.callCenter
                                Task { do { try await center.join(c.id, camera: false) } catch { store.show(L10n.errorText(error)) } }
                            }
                            .buttonStyle(.borderedProminent).tint(Theme.primaryFill).controlSize(.small)
                            .accessibilityIdentifier("calls.active.join.\(c.id)")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("calls.active.\(c.id)")
                }
            } header: { Text(L("calls.activeNow")) }
            .sheet(item: $adding) { c in AddToCallSheet(call: c) }
        }
    }
}

// MARK: - Pantalla de la llamada

struct CallVideoTile: UIViewRepresentable {
    let tileId: Int
    let center: CallCenter
    /// Sin recortar (pantallas compartidas).
    var fit = false
    final class Coordinator { var tileId = 0; weak var center: CallCenter? }
    func makeCoordinator() -> Coordinator { let c = Coordinator(); c.tileId = tileId; c.center = center; return c }
    func makeUIView(context: Context) -> UIView {
        let v = center.makeVideoView(fit: fit)
        center.bind(v, tileId: tileId)
        return v
    }
    func updateUIView(_ uiView: UIView, context: Context) {
        // Otro recuadro en la misma celda: se suelta el anterior y se pega el nuevo.
        guard context.coordinator.tileId != tileId else { return }
        center.unbind(uiView, tileId: context.coordinator.tileId)
        context.coordinator.tileId = tileId
        center.bind(uiView, tileId: tileId)
    }
    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        MainActor.assumeIsolated { coordinator.center?.unbind(uiView, tileId: coordinator.tileId) }
    }
}

/// Quién es quién en la pantalla de la llamada, con sesión (snapshot) o como invitado (solo `call.names`).
struct CallPeopleContext {
    var d: BootstrapDTO?
    /// Mi id dentro de la llamada (el de mi cuenta o «guest:{id}»).
    var me: String
    var call: CallDTO

    /// Quienes están (yo primero si no aparezco): personas de chaggu e invitados por enlace.
    var inside: [String] {
        let all = CallRules.people(call)
        return all.contains(me) ? all : [me] + all
    }
    func fullName(_ id: String) -> String {
        if let g = CallRules.guestName(call, id) { return g }
        return d.flatMap { Naming.person($0, id)?.name } ?? call.names[id] ?? ""
    }
    func name(_ id: String) -> String {
        if id == me { return L("call.you") }
        if CallRules.isGuest(id) { return fullName(id) }
        let n = fullName(id)
        return n.split(separator: " ").first.map(String.init) ?? n
    }
    /// «invitado» junto al nombre de quien entró con el enlace (no en mí).
    func isGuest(_ id: String) -> Bool { id != me && CallRules.isGuest(id) }

    @ViewBuilder func avatar(_ id: String, size: CGFloat) -> some View {
        if let p = d.flatMap({ Naming.person($0, id) }) { Avatar(person: p, org: nil, size: size) }
        else {
            let n = fullName(id)
            Avatar(name: n.isEmpty ? "?" : n, org: nil, size: size, fill: PersonColor.fill(id))
        }
    }
}

struct CallScreen: View {
    @Environment(AppStore.self) private var store
    @State private var consent = false
    @State private var adding = false
    /// Pantalla compartida ampliada (tileId).
    @State private var enlarged: Int?

    var body: some View {
        let center = store.callCenter
        ZStack {
            Color(hex: 0x17161F).ignoresSafeArea()
            if let v = center.view {
                let ctx = CallPeopleContext(d: store.data, me: v.isGuest ? (center.guest?.userId ?? "") : (store.data?.me.id ?? ""), call: v.call)
                VStack(spacing: 14) {
                    header(ctx, v)
                    if v.call.transcribing {
                        Label(L("call.transcribingAll"), systemImage: "record.circle")
                            .font(.footnote.weight(.semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Capsule().fill(Color.red.opacity(0.85)))
                            .accessibilityIdentifier("call.recording")
                    }
                    stage(ctx, v, center)
                    if v.call.transcribing && !v.captions.isEmpty { captions(ctx, v) }
                    if let e = v.error { Text(e).font(.footnote).foregroundStyle(.orange) }
                    secondary(v, center)
                    controls(v, center)
                }
                .padding(.horizontal, 16).padding(.bottom, 12)
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $consent) {
            TranscriptConsentSheet { ai in
                consent = false
                Task { do { try await center.setTranscription(true, aiSummary: ai) } catch { store.show(L10n.errorText(error)) } }
            }
            .presentationDetents([.medium])
        }
        .sheet(isPresented: $adding) { AddToCallSheet() }
        .fullScreenCover(isPresented: Binding(get: { enlarged != nil }, set: { if !$0 { enlarged = nil } })) {
            if let id = enlarged, let v = center.view {
                let ctx = CallPeopleContext(d: store.data, me: v.isGuest ? (center.guest?.userId ?? "") : (store.data?.me.id ?? ""), call: v.call)
                let owner = v.screens.first { $0.tileId == id }?.userId
                ScreenShareZoomView(tileId: id, label: screenLabel(ctx, owner), center: center) { enlarged = nil }
            }
        }
        .onChange(of: center.view?.screens.map(\.tileId) ?? []) { _, ids in
            // Dejó de compartir: se cierra la vista ampliada.
            if let e = enlarged, !ids.contains(e) { enlarged = nil }
        }
        .overlay(alignment: .bottom) { ToastView(inSheet: true) }
    }

    private func header(_ ctx: CallPeopleContext, _ v: CallView) -> some View {
        let center = store.callCenter
        return HStack(spacing: 10) {
            if v.isGuest {
                // Como invitado la llamada va siempre a pantalla completa (no hay lista de chats debajo).
                Color.clear.frame(width: 44, height: 44)
            } else {
                Button { center.expanded = false } label: {
                    Image(systemName: "chevron.down").font(.headline).foregroundStyle(.white).frame(width: 44, height: 44)
                }
                .accessibilityLabel(L("call.minimize")).accessibilityIdentifier("call.minimize")
            }
            VStack(spacing: 2) {
                Text(v.isGuest ? (center.guest?.title ?? L("call.title")) : (ctx.d.map { CallTitle.text($0, v.call) } ?? L("call.title")))
                    .font(.headline).foregroundStyle(.white).lineLimit(1)
                TimelineView(.periodic(from: .now, by: 1)) { t in
                    Text(v.phase == .connecting ? L("call.connecting") : CallRules.clock(elapsed(since: v.call.startedAt, now: t.date)))
                        .font(.subheadline).monospacedDigit().foregroundStyle(.white.opacity(0.7))
                }
                .accessibilityIdentifier("call.clock")
            }
            .frame(maxWidth: .infinity)
            if v.isGuest {
                Color.clear.frame(width: 44, height: 44)
            } else {
                Button { adding = true } label: {
                    Image(systemName: "person.badge.plus").font(.headline).foregroundStyle(.white).frame(width: 44, height: 44)
                }
                .accessibilityLabel(L("call.add")).accessibilityIdentifier("call.add")
            }
        }
    }

    private func screenLabel(_ ctx: CallPeopleContext, _ owner: String?) -> String {
        let n = owner.map(ctx.fullName) ?? ""
        return n.isEmpty ? L("call.screen") : L("call.screenOf", ["name": n])
    }

    @ViewBuilder
    private func stage(_ ctx: CallPeopleContext, _ v: CallView, _ center: CallCenter) -> some View {
        let video = v.tiles.filter { $0.active || $0.local }
        // Quienes están (yo siempre), los invitados por enlace y los agregados que aún no entran.
        let inside = ctx.inside
        let invited = v.invites.keys.filter { !inside.contains($0) }.sorted()
        if let screen = v.screens.first(where: \.active) ?? v.screens.first {
            // Alguien comparte pantalla: grande y sin recortar; las personas en una fila abajo.
            VStack(spacing: 10) {
                screenTile(ctx, v, center, screen)
                    .frame(maxHeight: .infinity)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(inside + invited, id: \.self) { id in
                            let tile = id == ctx.me ? video.first(where: \.local) : video.first { !$0.local && $0.userId == id }
                            ZStack {
                                if let tile { CallVideoTile(tileId: tile.tileId, center: center) }
                                else { Color.white.opacity(0.08); personAvatar(ctx, v, center, id, size: 40) }
                            }
                            .frame(width: 84, height: 84)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.green, lineWidth: v.speaking.contains(id) ? 3 : 0))
                            .overlay(alignment: .bottom) {
                                Text(ctx.name(id)).font(.caption2.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                                    .padding(.horizontal, 4).background(Capsule().fill(.black.opacity(0.5))).padding(3)
                            }
                            .overlay(alignment: .topLeading) { if ctx.isGuest(id) { guestBadge.padding(3) } }
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier(tile != nil ? "call.video.\(id)" : "call.person.\(id)")
                        }
                    }
                }
                .frame(height: 84)
            }
            .frame(maxHeight: .infinity)
        } else if !video.isEmpty {
            // Con al menos un video: cuadrícula; quien no tiene cámara va como avatar en su recuadro.
            let cells = inside + invited
            let cols = cells.count > 1 ? [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)] : [GridItem(.flexible())]
            ScrollView {
                LazyVGrid(columns: cols, spacing: 8) {
                    ForEach(cells, id: \.self) { id in
                        let tile = id == ctx.me ? video.first(where: \.local) : video.first { !$0.local && $0.userId == id }
                        ZStack {
                            if let tile {
                                CallVideoTile(tileId: tile.tileId, center: center)
                            } else {
                                Color.white.opacity(0.08)
                                personAvatar(ctx, v, center, id, size: 64)
                            }
                        }
                        .aspectRatio(3 / 4, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.green, lineWidth: v.speaking.contains(id) ? 3 : 0))
                        .overlay(alignment: .bottomLeading) { nameTag(ctx, v, id, hasVideo: tile != nil) }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier(tile != nil ? "call.video.\(id)" : "call.person.\(id)")
                    }
                }
            }
            .frame(maxHeight: .infinity)
        } else {
            VStack(spacing: 18) {
                Spacer()
                let cols = [GridItem(.adaptive(minimum: 96), spacing: 14)]
                LazyVGrid(columns: cols, spacing: 18) {
                    ForEach(inside + invited, id: \.self) { id in
                        VStack(spacing: 6) {
                            personAvatar(ctx, v, center, id, size: 76)
                            Text(ctx.name(id)).font(.footnote).foregroundStyle(.white).lineLimit(1)
                            if ctx.isGuest(id) { guestBadge }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("call.person.\(id)")
                    }
                }
                if inside.filter({ $0 != ctx.me }).isEmpty && invited.isEmpty {
                    Text(L("call.waiting")).font(.subheadline).foregroundStyle(.white.opacity(0.7))
                }
                Spacer()
            }
            .frame(maxHeight: .infinity)
        }
    }

    /// Pantalla compartida: completa (aspect fit) sobre negro; tocarla o ⤢ la amplía.
    private func screenTile(_ ctx: CallPeopleContext, _ v: CallView, _ center: CallCenter, _ screen: CallTile) -> some View {
        ZStack {
            Color.black
            // Mientras está ampliada, la vista grande tiene el recuadro.
            if enlarged != screen.tileId { CallVideoTile(tileId: screen.tileId, center: center, fit: true) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .contentShape(Rectangle())
        .onTapGesture { enlarged = screen.tileId }
        .overlay(alignment: .bottomLeading) {
            Label(screenLabel(ctx, screen.userId), systemImage: "rectangle.on.rectangle")
                .font(.caption.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                .padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(.black.opacity(0.55))).padding(6)
        }
        .overlay(alignment: .topTrailing) {
            Button { enlarged = screen.tileId } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                    .frame(width: 36, height: 36).background(Circle().fill(.black.opacity(0.55)))
            }
            .padding(6)
            .accessibilityLabel(L("call.enlarge"))
            .accessibilityIdentifier("call.screen.enlarge")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("call.screen")
    }

    private var guestBadge: some View {
        Text(L("call.guestBadge")).font(.caption2.weight(.semibold)).foregroundStyle(.white)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(Theme.orange.opacity(0.85)))
    }

    /// Avatar con quién habla, micrófono silenciado y, si es un agregado que no entra, «Llamando…» / «No contestó».
    @ViewBuilder
    private func personAvatar(_ ctx: CallPeopleContext, _ v: CallView, _ center: CallCenter, _ id: String, size: CGFloat) -> some View {
        let speaking = v.speaking.contains(id)
        let muted = id == ctx.me ? v.muted : v.mutedUsers.contains(id)
        VStack(spacing: 6) {
            ctx.avatar(id, size: size)
                .overlay(Circle().stroke(Color.green, lineWidth: speaking ? 4 : 0).padding(-4))
                .overlay(alignment: .bottomTrailing) {
                    if muted {
                        Image(systemName: "mic.slash.fill").font(.caption2).foregroundStyle(.white)
                            .padding(5).background(Circle().fill(Color.red)).accessibilityLabel(L("call.mutedPerson"))
                    }
                }
                .opacity(center.inviteState(id) != nil ? 0.55 : 1)
                .animation(.easeOut(duration: 0.15), value: speaking)
            if let st = center.inviteState(id) {
                TimelineView(.periodic(from: .now, by: 5)) { t in
                    let state = center.inviteState(id, now: t.date) ?? st
                    if state == .ringing {
                        Text(L("call.inviteRinging")).font(.caption2).foregroundStyle(.white.opacity(0.8))
                            .accessibilityIdentifier("call.invite.ringing.\(id)")
                    } else {
                        VStack(spacing: 2) {
                            Text(L("call.inviteNoAnswer")).font(.caption2).foregroundStyle(.orange)
                            Button(L("calls.callBack")) {
                                Task { do { try await center.invite([id]) } catch { store.show(L10n.errorText(error)) } }
                            }
                            .font(.caption2.weight(.bold)).foregroundStyle(.white)
                            .accessibilityIdentifier("call.invite.again.\(id)")
                        }
                    }
                }
            }
        }
    }

    private func nameTag(_ ctx: CallPeopleContext, _ v: CallView, _ id: String, hasVideo: Bool) -> some View {
        let muted = id == ctx.me ? v.muted : v.mutedUsers.contains(id)
        return HStack(spacing: 4) {
            if muted { Image(systemName: "mic.slash.fill").foregroundStyle(.red) }
            if !hasVideo { Image(systemName: "video.slash.fill").accessibilityLabel(L("call.cameraOffPerson")) }
            Text(ctx.name(id))
            if ctx.isGuest(id) { Text("· " + L("call.guestBadge")).foregroundStyle(.white.opacity(0.75)) }
        }
        .font(.caption.weight(.semibold)).foregroundStyle(.white)
        .padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(.black.opacity(0.5))).padding(6)
    }

    private func captions(_ ctx: CallPeopleContext, _ v: CallView) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(v.captions.suffix(4)) { c in
                let who = c.userId.map(ctx.name) ?? ""
                (Text("\(who.isEmpty ? "·" : who): ").bold() + Text(c.processing ? "⏳ \(L("call.processing"))" : c.text))
                    .font(.subheadline).foregroundStyle(.white.opacity(c.partial ? 0.65 : 1))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12).fill(.black.opacity(0.45)))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("call.captions")
    }

    /// 🔊 Altavoz (con lista si hay Bluetooth o audífonos) y «Agregar», con texto para que se encuentren.
    private func secondary(_ v: CallView, _ center: CallCenter) -> some View {
        let current = v.audioDevices.first { $0.id == v.audioOut }
        let onSpeaker = current?.kind == .speaker
        return HStack(spacing: 10) {
            if v.audioDevices.count > 2 {
                Menu {
                    ForEach(v.audioDevices) { dev in
                        Button { center.chooseAudio(dev.id) } label: {
                            Label(dev.label, systemImage: dev.id == v.audioOut ? "checkmark" : dev.kind.symbol)
                        }
                    }
                } label: { chip(current?.kind.symbol ?? "speaker.wave.2.fill", current?.label ?? L("call.out.speaker"), on: current?.kind != .receiver) }
                .accessibilityIdentifier("call.speaker")
            } else {
                Button { center.toggleSpeaker(); Haptics.tap() } label: { chip(onSpeaker ? "speaker.wave.3.fill" : "speaker.fill", L("call.out.speaker"), on: onSpeaker) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("call.out.speaker"))
                    .accessibilityValue(onSpeaker ? L("vo.on") : L("vo.off"))
                    .accessibilityAddTraits(onSpeaker ? .isSelected : [])
                    .accessibilityIdentifier("call.speaker")
            }
            if !v.isGuest {
                Button { adding = true } label: { chip("person.badge.plus", L("call.addShort"), on: false) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("call.add"))
                    .accessibilityIdentifier("call.addButton")
            }
        }
    }

    private func chip(_ icon: String, _ text: String, on: Bool) -> some View {
        Label(text, systemImage: icon).font(.subheadline.weight(.semibold)).lineLimit(1)
            .foregroundStyle(on ? Color.black : .white)
            .padding(.horizontal, 14).frame(height: 38)
            .background(Capsule().fill(on ? Color.white : Color.white.opacity(0.16)))
    }

    private func controls(_ v: CallView, _ center: CallCenter) -> some View {
        HStack(spacing: 18) {
            ctl(v.muted ? "mic.slash.fill" : "mic.fill", on: v.muted, label: v.muted ? L("call.unmute") : L("call.mute"), id: "call.mute") { center.toggleMute() }
            ctl(v.camera ? "video.fill" : "video.slash.fill", on: !v.camera, label: v.camera ? L("call.cameraOff") : L("call.cameraOn"), id: "call.camera") {
                Task { await center.toggleCamera() }
            }
            if v.camera {
                ctl("arrow.triangle.2.circlepath.camera", on: false, label: L("call.switchCamera"), id: "call.switchCamera") { center.switchCamera() }
            }
            // Los invitados no prenden ni apagan la transcripción (pide sesión).
            if !v.isGuest {
                ctl("text.quote", on: v.call.transcribing, label: v.call.transcribing ? L("call.transcriptOff") : L("call.transcriptOn"), id: "call.transcript", tint: .red) {
                    if v.call.transcribing {
                        Task { do { try await center.setTranscription(false) } catch { store.show(L10n.errorText(error)) } }
                    } else { consent = true }
                }
            }
            Button { Task { await center.hangUp() } } label: {
                Image(systemName: "phone.down.fill").font(.title2).foregroundStyle(.white).frame(width: 64, height: 64).background(Circle().fill(Color.red))
            }
            .accessibilityLabel(L("call.hangUp")).accessibilityIdentifier("call.hangUp")
        }
        .padding(.top, 6)
    }

    private func ctl(_ icon: String, on: Bool, label: String, id: String, tint: Color = .white, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.title3)
                .foregroundStyle(on ? (tint == .white ? Color.black : .white) : .white)
                .frame(width: 54, height: 54)
                .background(Circle().fill(on ? (tint == .white ? Color.white : tint) : Color.white.opacity(0.16)))
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}

/// Pantalla compartida ampliada: negro, sin recortar, con pellizco para acercar (y girar el teléfono).
struct ScreenShareZoomView: View {
    let tileId: Int
    let label: String
    let center: CallCenter
    var close: () -> Void
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CallVideoTile(tileId: tileId, center: center, fit: true)
                .scaleEffect(scale)
                .offset(offset)
                .gesture(
                    MagnifyGesture()
                        .onChanged { scale = min(5, max(1, lastScale * $0.magnification)) }
                        .onEnded { _ in lastScale = scale; if scale == 1 { offset = .zero; lastOffset = .zero } }
                        .simultaneously(with: DragGesture()
                            .onChanged { g in
                                guard scale > 1 else { return }
                                offset = CGSize(width: lastOffset.width + g.translation.width, height: lastOffset.height + g.translation.height)
                            }
                            .onEnded { _ in lastOffset = offset })
                )
                .onTapGesture(count: 2) {
                    withAnimation(.easeOut(duration: 0.2)) {
                        if scale > 1 { scale = 1; offset = .zero } else { scale = 2.5 }
                        lastScale = scale; lastOffset = offset
                    }
                }
                .ignoresSafeArea()
                .accessibilityIdentifier("call.screen.zoomed")
        }
        .overlay(alignment: .topLeading) {
            Text(label).font(.footnote.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                .padding(.horizontal, 10).padding(.vertical, 5).background(Capsule().fill(.black.opacity(0.55))).padding(12)
        }
        .overlay(alignment: .topTrailing) {
            Button(action: close) {
                Image(systemName: "arrow.down.right.and.arrow.up.left").font(.headline).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(Circle().fill(.black.opacity(0.55)))
            }
            .padding(12)
            .accessibilityLabel(L("call.shrink"))
            .accessibilityIdentifier("call.screen.shrink")
        }
        .preferredColorScheme(.dark)
        .statusBarHidden()
    }
}

/// Antes de prender la transcripción: todos en la llamada lo verán, y opcionalmente el resumen con IA.
struct TranscriptConsentSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var ai = false
    var onConfirm: (Bool) -> Void
    var body: some View {
        NavigationStack {
            Form {
                Section { Text(L("call.consentBody")).font(.body) }
                Section { Toggle(L("call.consentAi"), isOn: $ai).accessibilityIdentifier("call.consent.ai") }
            }
            .navigationTitle(L("call.transcriptOn"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("call.transcriptStart")) { onConfirm(ai) }.accessibilityIdentifier("call.consent.start")
                }
            }
        }
        .preferredColorScheme(nil)
    }
}

/// Sumar personas a la llamada: solo gente de mi lista (empresa o espacio), sin quienes ya están o están invitados.
struct AddToCallSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// La llamada (si no, la de este dispositivo): así se agrega también desde «En llamada en tu …» y «En curso ahora».
    var call: CallDTO? = nil
    @State private var query = ""
    @State private var picked: Set<String> = []
    @State private var busy = false
    var body: some View {
        NavigationStack {
            if let d = store.data, let call = call ?? store.callCenter.view?.call {
                let inside = Set(call.activeUserIds + call.invitedUserIds + [d.me.id])
                let q = query.trimmingCharacters(in: .whitespaces)
                let list = d.people.filter { !inside.contains($0.id) && $0.kind != "agent" && (q.isEmpty || $0.name.localizedCaseInsensitiveContains(q)) }.prefix(80)
                List {
                    Section {
                        if list.isEmpty { Text(L("call.addNone")).foregroundStyle(Theme.textSecondary) }
                        ForEach(Array(list)) { p in
                            let on = picked.contains(p.id)
                            Button { if on { picked.remove(p.id) } else { picked.insert(p.id) } } label: {
                                HStack(spacing: 12) {
                                    Avatar(person: p, org: Naming.org(d, p.orgId), size: 34)
                                    Text(p.name).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                    Spacer()
                                    Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.title3)
                                        .foregroundStyle(on ? Theme.accentText : Theme.textSecondary.opacity(0.5))
                                }
                            }
                            .accessibilityAddTraits(on ? .isSelected : [])
                            .accessibilityIdentifier("call.add.\(p.id)")
                        }
                    } footer: { Text(L("call.addHint")) }
                }
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("calls.search"))
                .navigationTitle(L("call.add"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(L("call.addSend", ["n": picked.count])) { send() }
                            .disabled(picked.isEmpty || busy)
                            .accessibilityIdentifier("call.add.send")
                    }
                }
            }
        }
    }
    private func send() {
        busy = true
        let ids = Array(picked), n = picked.count
        Task {
            do { try await store.callCenter.invite(ids, callId: call?.id); store.show(L("call.added", ["n": n])); dismiss() }
            catch { busy = false; store.show(L10n.errorText(error)) }
        }
    }
}

// MARK: - Elegir persona, grupo o chat

/// Conversaciones donde puedo escribir (para llamar o para compartir), con buscador.
struct PickConversationSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let title: String
    var onPick: (ConversationDTO) -> Void
    @State private var query = ""
    var body: some View {
        NavigationStack {
            if let d = store.data {
                let q = query.trimmingCharacters(in: .whitespaces)
                let list = d.conversations
                    .filter { $0.canPost && (q.isEmpty || Naming.title(d, $0).localizedCaseInsensitiveContains(q)) }
                    .sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
                    .prefix(80)
                List(Array(list)) { c in
                    Button { onPick(c) } label: { PickConversationRow(d: d, c: c) }
                        .accessibilityIdentifier("call.pick.\(c.id)")
                }
                .listStyle(.plain)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("calls.search"))
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } } }
            }
        }
    }
}

struct PickConversationRow: View {
    var d: BootstrapDTO
    var c: ConversationDTO
    var body: some View {
        let other = c.kind == .direct ? Naming.otherInDirect(d, c) : nil
        HStack(spacing: 12) {
            Group {
                if let other { Avatar(person: other, org: Naming.org(d, other.orgId), size: 34) }
                else if c.kind == .multi { StackedAvatars(d: d, c: c, box: 34) }
                else { ConvIcon(d: d, c: c, size: 34) }
            }
            .frame(width: 34, height: 34)
            Text(Naming.title(d, c)).foregroundStyle(Theme.textPrimary).lineLimit(1)
            Spacer(minLength: 4)
            Text(c.kind == .direct ? L("calls.direct") : "\(L("calls.group")) · \(c.memberIds.count)")
                .font(.caption).foregroundStyle(Theme.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Detalle: resumen, transcripción y Compartir

struct CallDetailView: View {
    @Environment(AppStore.self) private var store
    let callId: String
    @State private var data: CallTranscriptDTO?
    @State private var error: String?
    @State private var tab = 1
    @State private var sharing: CallShareWhat?

    var body: some View {
        Group {
            if let data, let d = store.data { content(d, data) }
            else if let error { ContentUnavailableView(error, systemImage: "exclamationmark.bubble") }
            else { ProgressView().accessibilityLabel(L("common.loading")) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("call.transcriptTitle"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let data, let d = store.data {
                ToolbarItem(placement: .topBarTrailing) { shareMenu(d, data) }
            }
        }
        .task(id: callId) { await load() }
        .sheet(item: $sharing) { what in
            PickConversationSheet(title: L("calls.pickChat")) { c in
                sharing = nil
                Task {
                    do {
                        try await store.shareCall(callId, to: c.id, what: what)
                        if let d = store.data { store.show(L("calls.shared", ["name": Naming.title(d, c)])) }
                    } catch { store.show(L10n.errorText(error)) }
                }
            }
        }
    }

    private func load() async {
        do {
            let x = try await store.callTranscript(callId)
            data = x
            tab = (x.summary ?? "").isEmpty ? 1 : 0
        } catch { self.error = L10n.errorText(error) }
    }

    private func speaker(_ d: BootstrapDTO) -> (CallTranscriptSegmentDTO) -> String {
        { s in s.speakerUserId.flatMap { Naming.person(d, $0)?.name } ?? s.speakerName ?? "?" }
    }

    @ViewBuilder
    private func shareMenu(_ d: BootstrapDTO, _ t: CallTranscriptDTO) -> some View {
        let opts = CallRules.shareOptions(t)
        Menu {
            if opts.isEmpty {
                Text(L("calls.noContent"))
            } else if opts.count == 1 {
                shareItems(d, t, opts[0])
            } else {
                Section(L("calls.shareWhat")) {
                    ForEach(opts) { w in
                        Menu { shareItems(d, t, w) } label: { Label(w.label, systemImage: w.icon) }
                    }
                }
            }
        } label: { Label(L("calls.share"), systemImage: "square.and.arrow.up") }
        .accessibilityIdentifier("call.share")
    }

    @ViewBuilder
    private func shareItems(_ d: BootstrapDTO, _ t: CallTranscriptDTO, _ w: CallShareWhat) -> some View {
        let text = CallRules.shareText(t, w, speaker: speaker(d))
        Button { sharing = w } label: { Label(L("calls.shareChat"), systemImage: "bubble.left.and.bubble.right") }
            .accessibilityIdentifier("call.share.chat.\(w.rawValue)")
        ShareLink(item: text, subject: Text(L("call.transcriptTitle"))) { Label(L("calls.shareSystem"), systemImage: "square.and.arrow.up") }
        Button {
            UIPasteboard.general.string = text
            store.show(L("call.copied"))
        } label: { Label(L("call.copy"), systemImage: "doc.on.doc") }
            .accessibilityIdentifier("call.share.copy.\(w.rawValue)")
    }

    private func content(_ d: BootstrapDTO, _ t: CallTranscriptDTO) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: t.call.isVideo ? "video" : "phone")
                Text([CallTitle.text(d, t.call), ISODate.parse(t.call.startedAt).map { L10n.dateTime($0) }].compactMap { $0 }.joined(separator: " · "))
                    .lineLimit(2)
            }
            .font(.footnote).foregroundStyle(Theme.textSecondary)
            Picker("", selection: $tab) {
                Text("✦ \(L("call.summary"))").tag(0)
                Text("📝 \(L("calls.shareTranscript"))").tag(1)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("call.detail.tabs")
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if tab == 0 {
                        if let s = t.summary, !s.isEmpty {
                            Text(s).textSelection(.enabled).accessibilityIdentifier("call.summaryText")
                        } else {
                            Text(L("calls.noSummary")).foregroundStyle(Theme.textSecondary).accessibilityIdentifier("call.noSummary")
                        }
                    } else {
                        if t.segments.isEmpty { Text(L("call.transcriptEmpty")).foregroundStyle(Theme.textSecondary) }
                        ForEach(t.segments) { s in
                            (Text(CallRules.clock(s.startMs / 1000) + "  ").foregroundColor(Theme.textSecondary).font(.caption.monospacedDigit())
                             + Text(speaker(d)(s) + ": ").bold() + Text(s.text))
                                .textSelection(.enabled)
                                .accessibilityIdentifier("call.segment")
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
            }
        }
        .padding(16)
    }
}

// MARK: - Pestaña «Llamadas»

struct CallsScreen: View {
    @Environment(AppStore.self) private var store
    @State private var items: [CallHistoryItemDTO]?
    @State private var more = false
    @State private var error: String?
    @State private var picking: String?
    @State private var active: [ActiveCallDTO] = []

    var body: some View {
        List {
            // Solo las que siguen en curso (call.updated las va quitando).
            ActiveCallsSection(items: active.filter { store.liveCalls[$0.call.conversationId]?.id == $0.call.id })
            if let error { Text(error).foregroundStyle(Theme.textSecondary) }
            if let items, items.isEmpty {
                Text(L("calls.empty")).font(.subheadline).foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 30).listRowSeparator(.hidden)
                    .accessibilityIdentifier("calls.empty")
            }
            ForEach(items ?? []) { x in CallRow(item: x) }
            if more {
                Button(L("calls.more")) { Task { await loadMore() } }.frame(maxWidth: .infinity)
            }
        }
        .listStyle(.plain)
        .overlay { if items == nil && error == nil { ProgressView() } }
        .navigationTitle(L("calls.title"))
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { picking = "video" } label: { Image(systemName: "video") }
                    .accessibilityLabel(L("call.video")).accessibilityIdentifier("calls.newVideo")
                Button { picking = "audio" } label: { Label(L("calls.new"), systemImage: "phone") }
                    .accessibilityLabel(L("calls.new")).accessibilityIdentifier("calls.new")
            }
        }
        .refreshable { await load() }
        .task(id: store.callsRevision) { await load() }
        // Abrir la pestaña quita el número rojo (aquí y en mis otros dispositivos). La pantalla queda montada al cambiar de pestaña.
        .onChange(of: store.tab == .calls, initial: true) { _, on in if on { store.markCallsSeen() } }
        .sheet(item: Binding(get: { picking.map(IdBox.init) }, set: { picking = $0?.id })) { box in
            PickConversationSheet(title: L("calls.pick")) { c in
                picking = nil
                let center = store.callCenter
                Task { do { try await center.start(c.id, kind: box.id) } catch { store.show(L10n.errorText(error)) } }
            }
        }
        .background(Theme.background.ignoresSafeArea())
    }

    private func load() async {
        if let a = try? await store.activeCalls() { active = a }
        do {
            let r = try await store.callHistory()
            items = r.calls; more = r.hasMore; error = nil
        } catch is CancellationError {
        } catch let e as ApiRequestError where e.isNetwork && Task.isCancelled {
        } catch { if items == nil { self.error = L10n.errorText(error) } }
    }

    private func loadMore() async {
        guard let last = items?.last else { return }
        do {
            let r = try await store.callHistory(before: last.call.startedAt)
            items = (items ?? []) + r.calls.filter { n in !(items ?? []).contains { $0.id == n.id } }
            more = r.hasMore
        } catch { store.show(L10n.errorText(error)) }
    }
}

struct CallRow: View {
    @Environment(AppStore.self) private var store
    let item: CallHistoryItemDTO
    var body: some View {
        if let d = store.data {
            let c = item.call
            let conv = d.conversations.first { $0.id == c.conversationId }
            let others = item.participantIds.filter { $0 != d.me.id }
            let group = CallRules.isGroup(item, conv: conv, me: d.me.id)
            let name = conv.map { Naming.title(d, $0) } ?? others.compactMap { Naming.person(d, $0)?.name }.joined(separator: ", ")
            // Perdida para mí (me sonó y no entré): etiqueta roja «Perdida»; «Sin respuesta» si nadie más entró.
            let mine = item.missed
            let missed = mine || CallRules.isMissed(item)
            let live = c.endedAt == nil
            let who = group ? others.prefix(3).map { firstName(d, $0) }.filter { !$0.isEmpty }.joined(separator: ", ") : ""
            let meta = [ISODate.parse(c.startedAt).map { L10n.dateTime($0) },
                        !missed ? item.durationSec.map(CallRules.clock) : nil,
                        missed && !mine ? L("calls.missed") : nil, who.isEmpty ? nil : who].compactMap { $0 }.joined(separator: " · ")
            HStack(spacing: 12) {
                Group {
                    if !group, let o = others.first, let p = Naming.person(d, o) { Avatar(person: p, org: Naming.org(d, p.orgId), size: 40) }
                    else if let conv { ConvIcon(d: d, c: conv, size: 40) }
                    else { Image(systemName: "phone").frame(width: 40, height: 40) }
                }
                .frame(width: 40, height: 40)
                Button { open(c, conv: conv) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(name.isEmpty ? L("call.title") : name).font(.subheadline.weight(.semibold)).foregroundStyle(missed ? Color.red : Theme.textPrimary).lineLimit(1)
                            tag(group ? L("calls.group") : L("calls.direct"), live: false)
                            if live { tag(L("calls.live"), live: true) }
                            if mine { missedTag }
                        }
                        HStack(spacing: 4) {
                            Image(systemName: c.isVideo ? "video" : "phone").font(.caption2)
                            Text(meta).lineLimit(1)
                        }
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                        if item.hasSummary || c.hasTranscript {
                            HStack(spacing: 6) {
                                if item.hasSummary { chip("✦ \(L("call.summary"))") }
                                if c.hasTranscript { chip("📝 \(L("calls.shareTranscript"))") }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("calls.row.\(c.id)")
                if live {
                    Button(L("call.join")) {
                        let center = store.callCenter
                        Task { do { try await center.join(c.id, camera: false) } catch { store.show(L10n.errorText(error)) } }
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.primaryFill).controlSize(.small)
                } else {
                    Button {
                        let center = store.callCenter
                        Task { do { try await center.start(c.conversationId, kind: c.kind) } catch { store.show(L10n.errorText(error)) } }
                    } label: { Image(systemName: c.isVideo ? "video" : "phone").foregroundStyle(Theme.accentText).frame(width: 40, height: 40) }
                    .buttonStyle(.plain)
                    .disabled(!(conv?.canPost ?? false))
                    .accessibilityLabel(L("calls.callBack"))
                    .accessibilityIdentifier("calls.callBack.\(c.id)")
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func open(_ c: CallDTO, conv: ConversationDTO?) {
        if c.hasTranscript || item.hasSummary { store.push(.callDetail(c.id)) }
        else if conv != nil { store.push(.conversation(c.conversationId)) }
    }

    private func tag(_ text: String, live: Bool) -> some View {
        Text(text).font(.caption2.weight(.semibold))
            .foregroundStyle(live ? .white : Theme.textSecondary)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(live ? Color.green : Theme.textSecondary.opacity(0.12)))
    }

    /// «Perdida» en rojo (#D93025, el mismo de la pastilla de la pestaña).
    private var missedTag: some View {
        Text(L("calls.missedMine")).font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(Theme.missed))
            .accessibilityIdentifier("calls.missedTag.\(item.call.id)")
    }

    private func chip(_ text: String) -> some View {
        Text(text).font(.caption2).foregroundStyle(Theme.accentText)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(Theme.orange.opacity(0.12)))
    }
}
