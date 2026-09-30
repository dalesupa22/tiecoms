import SwiftUI

// Correo y WhatsApp en el chat (docs/CORREO.md). Paridad con apps/web/src/screens/Mail.tsx y los SystemRow
// de Conversation.tsx: tarjetas en el chat, pantalla del correo (leer, comentar, responder o programar),
// tarea desde el correo, lista en vivo de Gmail/Outlook con pestañas y filtros, y «Comentar en chaggu» de WhatsApp.

// MARK: - Iconos

/// Icono de Gmail u Outlook, dibujado como los SVG de la web (viewBox 48×48).
struct MailProviderIcon: View {
    let provider: MailProvider
    var size: CGFloat = 18
    var body: some View {
        if provider.isWhatsApp { WaIcon(size: size) } else { icon }
    }
    private var icon: some View {
        Canvas { g, sz in
            let k = sz.width / 48
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * k, y: y * k) }
            func poly(_ pts: [(CGFloat, CGFloat)], _ color: Color) {
                var path = Path()
                path.move(to: p(pts[0].0, pts[0].1))
                for q in pts.dropFirst() { path.addLine(to: p(q.0, q.1)) }
                path.closeSubpath()
                g.fill(path, with: .color(color))
            }
            if provider == .google {
                poly([(45, 16.2), (40, 18.95), (35, 23.7), (35, 40), (42, 40), (44.1, 39.1), (45, 37)], Color(hex: 0x4CAF50))
                poly([(3, 16.2), (6.61, 17.91), (13, 23.7), (13, 40), (6, 40), (3.9, 39.1), (3, 37)], Color(hex: 0x1E88E5))
                poly([(35, 11.2), (24, 19.45), (13, 11.2), (12, 17), (13, 23.7), (24, 31.95), (35, 23.7), (36, 17)], Color(hex: 0xE53935))
                poly([(3, 12.3), (3, 16.2), (13, 23.7), (13, 11.2), (9.88, 8.86), (6.5, 8.2), (4, 9.8)], Color(hex: 0xC62828))
                poly([(45, 12.3), (45, 16.2), (35, 23.7), (35, 11.2), (38.12, 8.86), (41.5, 8.2), (44, 9.8)], Color(hex: 0xFBC02D))
            } else {
                g.fill(Path(roundedRect: CGRect(x: 18 * k, y: 10 * k, width: 26 * k, height: 28 * k), cornerRadius: 2 * k), with: .color(Color(hex: 0x1A73C9)))
                poly([(44, 16), (30, 25), (18, 17), (18, 12), (42, 12), (44, 14)], Color(hex: 0x50B4F0).opacity(0.85))
                g.fill(Path(roundedRect: CGRect(x: 4 * k, y: 12 * k, width: 24 * k, height: 24 * k), cornerRadius: 3 * k), with: .color(Color(hex: 0x0A5AA8)))
                g.stroke(Path(ellipseIn: CGRect(x: (16 - 6.2) * k, y: (24 - 7.4) * k, width: 12.4 * k, height: 14.8 * k)), with: .color(.white), lineWidth: 3.2 * k)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(provider.label)
    }
}

/// Icono de WhatsApp (círculo verde con el teléfono).
struct WaIcon: View {
    var size: CGFloat = 18
    var body: some View {
        ZStack {
            Circle().fill(Color(hex: 0x25D366))
            Image(systemName: "phone.fill").font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel("WhatsApp")
    }
}

/// Recibido ↙ o enviado ↗.
struct MailDirBadge: View {
    let out: Bool
    var body: some View {
        Text(out ? "↗" : "↙")
            .font(.caption.weight(.bold))
            .foregroundStyle(out ? MailUI.outColor : MailUI.inColor)
            .accessibilityLabel(L(out ? "mail.dir.out" : "mail.dir.in"))
    }
}

enum MailUI {
    static let inColor = Color(hex: 0x4285F4)
    static let outColor = Color(hex: 0x2A9D8F)
    static let waColor = Color(hex: 0x25D366)

    /// Hoy: la hora; si no, «3 oct» (con año si no es este año).
    static func date(_ iso: String?) -> String {
        guard let iso, let d = ISODate.parse(iso) else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(d) { return d.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(L10n.locale)) }
        var f = Date.FormatStyle().day().month(.abbreviated).locale(L10n.locale)
        if cal.component(.year, from: d) != cal.component(.year, from: Date()) { f = f.year() }
        return d.formatted(f)
    }
    /// «mar, 30 sept, 9:00».
    static func when(_ d: Date) -> String {
        d.formatted(Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).hour().minute().locale(L10n.locale))
    }
    static func firstName(_ s: String?) -> String { s?.split(separator: " ").first.map(String.init) ?? "" }
}

// MARK: - Estado de la tarjeta

struct MailStatusPill: View {
    @Environment(AppStore.self) private var store
    let email: SharedMailDTO
    var body: some View {
        let (text, color) = label
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.12)))
            .lineLimit(1)
            .accessibilityIdentifier("mail.status")
    }
    private var label: (String, Color) {
        let me = store.me?.id
        switch email.status {
        case "replied":
            let when = MailUI.date(email.repliedAt)
            if email.repliedBy == me { return (L("mail.repliedByYou", ["when": when]), Theme.doneGreen) }
            let name = store.data.flatMap { Naming.person($0, email.repliedBy)?.name }
            return (L("mail.repliedBy", ["name": MailUI.firstName(name), "when": when]), Theme.doneGreen)
        case "scheduled":
            if let s = email.scheduledReply, let d = ISODate.parse(s.sendAt) { return (L("mail.scheduledFor", ["when": MailUI.when(d)]), .purple) }
            return (L("mail.scheduled"), .purple)
        default:
            if email.isOut { return (email.sharedBy == me ? L("mail.sentByYou") : L("mail.sentMail"), MailUI.outColor) }
            return (L("mail.pending"), Theme.accentText)
        }
    }
}

// MARK: - La tarjeta en el chat

struct MailCard: View {
    @Environment(AppStore.self) private var store
    let emailId: String
    var canPost = true
    @State private var task = false
    @State private var fileURL: URL?
    @State private var opening: String?

    var body: some View {
        Group {
            if let e = store.mails[emailId], let d = store.data {
                if e.provider.isWhatsApp { waCard(d, e) } else { card(d, e) }
            } else if store.mailsMissing.contains(emailId) {
                Text(L("mail.unavailable")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
                    .accessibilityIdentifier("mailCard.missing")
            } else {
                RoundedRectangle(cornerRadius: 14).fill(Theme.surface).frame(height: 150).overlay(ProgressView())
            }
        }
        .frame(maxWidth: 520, alignment: .leading)
        .onAppear { store.wantMail(emailId) }
        .sheet(isPresented: $task) { if let e = store.mails[emailId] { MailTaskSheet(email: e) } }
        .quickLookPreview($fileURL)
    }

    @ViewBuilder private func card(_ d: BootstrapDTO, _ e: SharedMailDTO) -> some View {
        let mine = e.sharedBy == d.me.id
        let other = e.other
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                MailProviderIcon(provider: e.provider, size: 24)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        MailDirBadge(out: e.isOut)
                        Text(L(e.isOut ? "mail.kind.out" : "mail.kind.in", ["name": e.provider.label]))
                            .font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary)
                    }
                    Button { store.push(.mail(e.id, mode: "read")) } label: {
                        Text(e.subject.isEmpty ? L("mail.noSubject") : e.subject)
                            .font(.body.weight(.bold)).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("mailCard.subject")
                    Text((e.isOut ? L("mail.toShort") + " " : "") + (other?.display ?? "") + (other?.name?.isEmpty == false ? " · \(other!.email)" : "") + " · " + MailUI.date(e.sentAt))
                        .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
            }
            if !e.snippet.isEmpty {
                Text(e.snippet).font(.subheadline).foregroundStyle(Theme.textPrimary).lineLimit(2)
            }
            if !e.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(e.attachments.prefix(4)) { a in
                            Button { open(e, a) } label: {
                                Text("📎 \(a.name) · \(MailText.size(a.size))" + (opening == a.id ? " …" : ""))
                                    .font(.caption).lineLimit(1).foregroundStyle(Theme.textPrimary)
                                    .padding(.horizontal, 8).padding(.vertical, 5)
                                    .background(Capsule().fill(Theme.textSecondary.opacity(0.1)))
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint(L("mail.openAttachment"))
                        }
                        if e.attachments.count > 4 {
                            Button("+\(e.attachments.count - 4)") { store.push(.mail(e.id, mode: "read")) }.font(.caption)
                        }
                    }
                }
            }
            MailCardComments(email: e, canPost: canPost)
            // En pantallas angostas (tarjeta con avatar al lado) el estado va arriba y los botones abajo.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { MailStatusPill(email: e).fixedSize(); Spacer(minLength: 4); actions(e, mine: mine) }
                VStack(alignment: .leading, spacing: 6) { MailStatusPill(email: e); HStack(spacing: 6) { actions(e, mine: mine) } }
            }
        }
        .modifier(MailCardFrame(edge: e.isOut ? MailUI.outColor : MailUI.inColor))
        .accessibilityIdentifier("mailCard.\(e.id)")
    }

    /// WhatsApp compartido (desde la 040): el mensaje citado en verde, sus comentarios y ◆ Tarea. Sin Responder.
    @ViewBuilder private func waCard(_ d: BootstrapDTO, _ e: SharedMailDTO) -> some View {
        let mine = e.sharedBy == d.me.id
        let author: String = e.isOut ? (mine ? L("common.youShort") : MailUI.firstName(Naming.person(d, e.sharedBy)?.name)) : (e.from?.name ?? L("wa.someone"))
        let kind = "WhatsApp" + (e.wa?.accountKind == "business" ? " Business" : "") + " · " + (e.wa?.isGroup == true ? "👥 " + L("wa.groupShort") : "") + (e.wa?.chatName ?? e.subject)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                WaIcon(size: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(kind).font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary)
                    (Text(author).bold() + Text(" · " + MailUI.date(e.sentAt))).font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            Button { store.push(.mail(e.id, mode: "read")) } label: {
                HStack(spacing: 8) {
                    Rectangle().fill(MailUI.waColor).frame(width: 3)
                    Text(e.snippet).font(.subheadline).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("mailCard.subject")
            MailCardComments(email: e, canPost: canPost)
            HStack(spacing: 6) {
                Spacer()
                taskButton(e)
                if mine && e.wa != nil { Button { store.push(.whatsapp) } label: { pill(L("wa.seeIn")) }.buttonStyle(.plain) }
            }
        }
        .modifier(MailCardFrame(edge: MailUI.waColor))
        .accessibilityIdentifier("waCard.\(e.id)")
    }

    @ViewBuilder private func taskButton(_ e: SharedMailDTO) -> some View {
        if let issueId = e.issueId {
            Button { store.push(.issue(issueId)) } label: { pill("◆ " + L("mail.seeTask")) }.buttonStyle(.plain)
                .accessibilityIdentifier("mailCard.seeTask")
        } else if canPost {
            Button { task = true } label: { pill("◆ " + L("mail.task")) }.buttonStyle(.plain)
                .accessibilityIdentifier("mailCard.task")
        }
    }

    @ViewBuilder private func actions(_ e: SharedMailDTO, mine: Bool) -> some View {
        taskButton(e)
        if mine && e.status != "replied" && e.status != "scheduled" {
            Button { store.push(.mail(e.id, mode: "reply")) } label: {
                Text(L("mail.reply")).font(.caption.weight(.bold)).foregroundStyle(Theme.onPrimary).lineLimit(1).fixedSize()
                    .padding(.horizontal, 10).frame(minHeight: 30)
                    .background(Capsule().fill(Theme.primaryFill))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("mailCard.reply")
        }
    }

    private func pill(_ t: String) -> some View {
        Text(t).font(.caption.weight(.semibold)).lineLimit(1).fixedSize().foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, 10).frame(minHeight: 30)
            .background(Capsule().fill(Theme.textSecondary.opacity(0.1)))
    }

    private func open(_ e: SharedMailDTO, _ a: MailAttachmentInfoDTO) {
        guard opening == nil else { return }
        opening = a.id
        Task {
            defer { opening = nil }
            do { fileURL = try await store.mailAttachmentFile(e.id, a) } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// Marco de la tarjeta: fondo, borde de color a la izquierda (azul recibido, verde azulado enviado, verde WhatsApp).
struct MailCardFrame: ViewModifier {
    let edge: Color
    func body(content: Content) -> some View {
        content
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.surface))
            .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14).fill(edge).frame(width: 4) }
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.textSecondary.opacity(0.15)))
            .accessibilityElement(children: .contain)
    }
}

/// Comentarios en la tarjeta, como en la tarjeta de tarea: los 2 últimos, «Ver los N comentarios» y comentar ahí mismo.
struct MailCardComments: View {
    @Environment(AppStore.self) private var store
    let email: SharedMailDTO
    var canPost = true
    @State private var text = ""
    @State private var busy = false

    var body: some View {
        let last = Array(email.lastComments.suffix(2))
        VStack(alignment: .leading, spacing: 6) {
            if !last.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(last) { c in
                        (Text(c.authorId == store.me?.id ? L("common.youShort") : MailUI.firstName(store.data.flatMap { Naming.person($0, c.authorId)?.name })).bold()
                         + Text(" " + c.body))
                            .font(.footnote).foregroundStyle(Theme.textPrimary).lineLimit(3)
                    }
                    if email.commentCount > last.count {
                        Button(L("task.cardAll", ["n": email.commentCount])) { store.push(.mail(email.id, mode: "comments")) }
                            .font(.footnote.weight(.semibold)).buttonStyle(.borderless)
                            .accessibilityIdentifier("mailCard.allComments")
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.textSecondary.opacity(0.06)))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("mailCard.lastComments")
            }
            if canPost {
                HStack(spacing: 6) {
                    TextField(email.provider.isWhatsApp ? L("mail.commentWaPh") : L("mail.commentCardPh"), text: $text)
                        .font(.footnote)
                        .padding(.horizontal, 10).frame(minHeight: 32)
                        .background(Capsule().fill(Theme.textSecondary.opacity(0.08)))
                        .submitLabel(.send)
                        .onSubmit { send() }
                        .accessibilityIdentifier("mailCard.commentField")
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button(L("comments.send")) { send() }
                            .font(.footnote.weight(.semibold)).buttonStyle(.borderless).disabled(busy)
                            .accessibilityIdentifier("mailCard.commentSend")
                    }
                }
            }
        }
    }

    private func send() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do { _ = try await store.commentMail(email.id, body: body); text = "" } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// Aviso agrupado de comentarios (mail.comments, issue.comments, event.comments): una línea corta que abre el hilo,
/// sin repetir la tarjeta: «💬 N comentarios nuevos · «título» · Nombre: extracto».
struct CommentsNoticeLine: View {
    let count: Int
    let title: String
    let lastByName: String
    let lastExcerpt: String
    var icon: AnyView? = nil
    var onOpen: () -> Void
    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 6) {
                if let icon { icon }
                Text(count > 1 ? L("comments.many", ["n": count]) : L("comments.one")).font(.footnote.weight(.bold)).foregroundStyle(Theme.accentText).fixedSize()
                (Text("«\(title)» · ") + Text(MailUI.firstName(lastByName)).bold() + Text(" " + lastExcerpt))
                    .font(.footnote).foregroundStyle(Theme.textSecondary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Capsule().fill(Theme.orange.opacity(0.07)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("commentsLine")
    }
}

/// «mail.shared»: se ve como un mensaje de quien lo trajo (avatar, nombre, hora y su comentario) con la tarjeta.
struct MailSharedRow: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    let emailId: String
    let comment: String?
    var canPost = true
    var body: some View {
        SharedByRow(message: message, comment: comment) { MailCard(emailId: emailId, canPost: canPost) }
    }
}

/// Mensaje de quien trajo un correo o un WhatsApp: avatar, nombre, hora, comentario y la tarjeta.
struct SharedByRow<Card: View>: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    let comment: String?
    @ViewBuilder var card: () -> Card
    var body: some View {
        let d = store.data
        let author = d.flatMap { Naming.person($0, message.authorId) }
        HStack(alignment: .top, spacing: 8) {
            Avatar(person: author, org: d.flatMap { Naming.org($0, author?.orgId) }, size: 34)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(author?.name ?? L("common.participant")).font(.subheadline.weight(.semibold)).foregroundStyle(PersonColor.text(message.authorId))
                    Text(L10n.clock(message.createdAt)).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                if let comment, !comment.isEmpty {
                    Text(comment).font(.body).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                }
                card()
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}

/// «wa.shared»: con `emailId` (desde la 040) la tarjeta con hilo y tarea; los viejos, la tarjeta verde del mensaje citado.
struct WaSharedRow: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    let payload: WaSharedPayload
    var canPost = true
    var body: some View {
        SharedByRow(message: message, comment: payload.comment) {
            if let id = payload.emailId, store.mailEnabled { MailCard(emailId: id, canPost: canPost) } else { WaCard(message: message, payload: payload) }
        }
    }
}

struct WaCard: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    let payload: WaSharedPayload

    private var kindLine: String {
        var s = "WhatsApp"
        if payload.accountKind == "business" { s += " Business" }
        if let name = payload.chatName { s += " · " + (payload.isGroup ? "👥 " + L("wa.groupShort") : "") + name }
        return s
    }
    private var authorLine: String {
        let who: String = payload.fromMe ? L("common.youShort") : (payload.author ?? L("wa.someone"))
        guard let at = payload.sentAt else { return who }
        return who + " · " + MailUI.date(at)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                WaIcon(size: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(kindLine).font(.caption2.weight(.bold)).foregroundStyle(Theme.textSecondary)
                    Text(authorLine).font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            HStack(spacing: 8) {
                Rectangle().fill(MailUI.waColor).frame(width: 3)
                Text(payload.text).font(.subheadline).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            }
            if message.authorId == store.me?.id {
                HStack { Spacer(); Button(L("wa.seeIn")) { store.push(.whatsapp) }.font(.caption.weight(.semibold)) }
            }
        }
        .frame(maxWidth: 520, alignment: .leading)
        .modifier(MailCardFrame(edge: MailUI.waColor))
        .accessibilityIdentifier("waCard")
    }
}

/// Aviso de correo o WhatsApp en el chat: tarjeta, línea de comentarios o línea con «Abrir».
struct MailChatRow: View {
    @Environment(AppStore.self) private var store
    let message: MessageDTO
    let kind: MailChatKind
    var canPost = true
    var body: some View {
        switch kind {
        case .shared(let id, let comment):
            if store.mailEnabled { MailSharedRow(message: message, emailId: id, comment: comment, canPost: canPost) } else { MailSysLine(message: message, emailId: id) }
        case .comments(let id, let info, let provider):
            // Una línea, no otra tarjeta: la tarjeta original ya muestra los comentarios.
            CommentsNoticeLine(count: info.count, title: info.title, lastByName: info.lastByName, lastExcerpt: info.lastExcerpt,
                               icon: provider == "whatsapp" ? AnyView(WaIcon(size: 14)) : AnyView(Text("✉").font(.footnote))) {
                store.push(.mail(id, mode: "comments"))
            }
        case .replied(let id), .replyFailed(let id):
            MailSysLine(message: message, emailId: id)
        case .waShared(let p):
            WaSharedRow(message: message, payload: p, canPost: canPost)
        }
    }
}

/// Línea de sistema (`sys.mail.*`) con «Abrir».
struct MailSysLine: View {
    let message: MessageDTO
    let emailId: String
    var body: some View {
        VStack(spacing: 4) {
            Text(L10n.systemText(message.body)).font(.footnote).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center)
            NavigationLink(value: Route.mail(emailId, mode: "read")) { Text(L("lin.open")).font(.footnote.weight(.semibold)) }
                .accessibilityIdentifier("mail.sysOpen")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("msg.system")
    }
}

// MARK: - Pantalla del correo

struct MailDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let emailId: String
    var mode: String = "read"
    @State private var tab: Tab = .comment
    @State private var original: String?
    @State private var origBusy = false
    @State private var comments: [SharedMailCommentDTO]?
    @State private var fileURL: URL?
    @State private var opening: String?
    @State private var shareURL: URL?
    enum Tab: Hashable { case comment, reply }

    var body: some View {
        Group {
            if let e = store.mails[emailId], let d = store.data {
                content(d, e)
            } else if store.mailsMissing.contains(emailId) {
                ContentUnavailableView(L("mail.unavailable"), systemImage: "envelope.badge.shield.half.filled")
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(store.mails[emailId].map { $0.subject.isEmpty ? L("mail.noSubject") : $0.subject } ?? L("mail.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let e = store.mails[emailId], e.sharedBy == store.me?.id, let link = e.webLink, let url = URL(string: link) {
                ToolbarItem(placement: .topBarTrailing) {
                    Link(destination: url) { Text(L("mail.openIn", ["name": e.provider.label]) + " ↗").font(.footnote) }
                }
            }
        }
        .task(id: emailId) {
            if mode == "reply" { tab = .reply }
            store.wantMail(emailId)
            _ = try? await store.loadSharedMailFull(emailId)
        }
        .task(id: store.mails[emailId]?.commentCount ?? -1) {
            guard store.mails[emailId] != nil else { return }
            if let c = try? await store.mailComments(emailId) { comments = c }
            else if comments == nil { comments = store.mails[emailId]?.lastComments ?? [] }
        }
        .quickLookPreview($fileURL)
        .sheet(item: Binding(get: { shareURL.map { IdentifiedURL(url: $0) } }, set: { shareURL = $0?.url })) { u in ActivityView(items: [u.url]) }
    }

    @ViewBuilder private func content(_ d: BootstrapDTO, _ e: SharedMailDTO) -> some View {
        let conv = store.meta(e.conversationId)
        let mine = e.sharedBy == d.me.id
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        if !e.provider.isWhatsApp { MailStatusPill(email: e) }
                        if e.issueId != nil {
                            Button { if let i = e.issueId { store.push(.issue(i)) } } label: { Text("◆ " + L("mail.hasTask")).font(.caption2.weight(.bold)) }
                        }
                        Spacer()
                        if e.scheduledReply != nil {
                            Button(L("mail.cancelSchedule")) {
                                Task {
                                    do { try await store.cancelMailReply(e.id); store.show(L("mail.scheduleCancelled")) } catch { store.show(L10n.errorText(error)) }
                                }
                            }
                            .font(.caption.weight(.semibold))
                            .accessibilityIdentifier("mail.cancelSchedule")
                        }
                    }
                    meta(e)
                    mailBody(e)
                    if !e.attachments.isEmpty { attachments(e) }
                    Text(L("mail.thread") + (e.commentCount > 0 ? " · \(e.commentCount)" : ""))
                        .font(.caption.weight(.bold)).foregroundStyle(Theme.textSecondary).textCase(.uppercase)
                        .id("thread")
                    thread(d, e)
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .onAppear { if mode == "comments" { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { proxy.scrollTo("thread", anchor: .top) } } }
        }
        .safeAreaInset(edge: .bottom) {
            if conv?.canPost == true {
                VStack(spacing: 8) {
                    if mine && !e.provider.isWhatsApp {
                        Picker("", selection: $tab) {
                            Text("💬 " + L("mail.toTeam")).tag(Tab.comment)
                            Text("✉ " + L("mail.replyTo", ["name": MailUI.firstName(e.other?.display).isEmpty ? "…" : MailUI.firstName(e.other?.display)])).tag(Tab.reply)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("mail.composerMode")
                    }
                    if tab == .reply && mine && !e.provider.isWhatsApp {
                        MailReplyBox(email: e) { dismiss() }
                    } else {
                        MailCommentBox(email: e) { c in comments = (comments ?? []) + [c] }
                    }
                }
                .padding(12)
                .background(.bar)
            }
        }
    }

    private func meta(_ e: SharedMailDTO) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            metaRow(L("mail.meta.from"), e.from?.full ?? "—")
            if !e.to.isEmpty { metaRow(L("mail.meta.to"), e.to.map(\.full).joined(separator: ", ")) }
            if !e.cc.isEmpty { metaRow("CC", e.cc.map(\.full).joined(separator: ", ")) }
            if let s = e.sentAt, let date = ISODate.parse(s) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(L("mail.meta.date")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary).frame(width: 52, alignment: .leading)
                    Text(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(L10n.locale))).font(.caption)
                    MailProviderIcon(provider: e.provider, size: 12)
                    Text(e.provider.label).font(.caption)
                }
            }
        }
        .accessibilityIdentifier("mail.meta")
    }
    private func metaRow(_ k: String, _ v: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(k).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary).frame(width: 52, alignment: .leading)
            Text(v).font(.caption).foregroundStyle(Theme.textPrimary).textSelection(.enabled)
        }
    }

    @ViewBuilder private func mailBody(_ e: SharedMailDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(original ?? (e.full ? (e.body.isEmpty ? L("mail.noBody") : e.body) : e.snippet + "…"))
                .font(.body).foregroundStyle(e.full || original != nil ? Theme.textPrimary : Theme.textSecondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                .accessibilityIdentifier("mail.body")
            if original != nil {
                Button(L("mail.hideHistory")) { original = nil }.font(.footnote.weight(.semibold))
            } else if e.full && e.trimmed {
                Button(origBusy ? L("common.loading") : L("mail.showHistory")) { loadOriginal(e) }
                    .font(.footnote.weight(.semibold)).disabled(origBusy)
                    .accessibilityIdentifier("mail.showHistory")
            }
        }
    }

    private func loadOriginal(_ e: SharedMailDTO) {
        origBusy = true
        Task {
            defer { origBusy = false }
            do { original = try await store.mailOriginal(e.id) } catch { store.show(L10n.errorText(error)) }
        }
    }

    private func attachments(_ e: SharedMailDTO) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("mail.attachmentsOnDemand", ["name": e.provider.label])).font(.caption.weight(.bold)).foregroundStyle(Theme.textSecondary)
            ForEach(e.attachments) { a in
                HStack(spacing: 10) {
                    Text(String((a.name.split(separator: ".").last.map(String.init) ?? "").prefix(4)).uppercased())
                        .font(.caption2.weight(.bold)).foregroundStyle(.white)
                        .frame(width: 38, height: 38).background(RoundedRectangle(cornerRadius: 8).fill(Theme.accentText.opacity(0.8)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text(MailText.size(a.size)).font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                    Spacer()
                    if opening == a.id { ProgressView() }
                    Menu {
                        Button { fetch(e, a, share: false) } label: { Label(L("mail.open"), systemImage: "eye") }
                        Button { fetch(e, a, share: true) } label: { Label(L("ishare.share"), systemImage: "square.and.arrow.up") }
                    } label: { Text(L("mail.open")).font(.footnote.weight(.semibold)) } primaryAction: { fetch(e, a, share: false) }
                    .accessibilityIdentifier("mail.attachment.\(a.name)")
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
            }
        }
    }

    private func fetch(_ e: SharedMailDTO, _ a: MailAttachmentInfoDTO, share: Bool) {
        guard opening == nil else { return }
        opening = a.id
        Task {
            defer { opening = nil }
            do {
                let url = try await store.mailAttachmentFile(e.id, a)
                if share { shareURL = url } else { fileURL = url }
            } catch { store.show(L10n.errorText(error)) }
        }
    }

    @ViewBuilder private func thread(_ d: BootstrapDTO, _ e: SharedMailDTO) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let c = e.comment, !c.isEmpty { commentRow(d, authorId: e.sharedBy, body: c, at: e.createdAt) }
            if comments == nil { ProgressView() }
            if comments?.isEmpty == true && (e.comment ?? "").isEmpty {
                Text(L("mail.noComments")).font(.footnote).foregroundStyle(Theme.textSecondary)
            }
            ForEach(comments ?? []) { c in commentRow(d, authorId: c.authorId, body: c.body, at: c.createdAt) }
        }
        .accessibilityIdentifier("mail.thread")
    }

    private func commentRow(_ d: BootstrapDTO, authorId: String, body: String, at: String) -> some View {
        let p = Naming.person(d, authorId)
        return HStack(alignment: .top, spacing: 8) {
            Avatar(person: p, org: nil, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(authorId == d.me.id ? L("common.youShort") : MailUI.firstName(p?.name)).font(.caption.weight(.bold))
                    Text(MailUI.date(at)).font(.caption2).foregroundStyle(Theme.textSecondary)
                }
                Text(body).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct IdentifiedURL: Identifiable { let url: URL; var id: String { url.absoluteString } }

/// «Comentar al equipo»: el remitente nunca lo ve.
struct MailCommentBox: View {
    @Environment(AppStore.self) private var store
    let email: SharedMailDTO
    var onSent: (SharedMailCommentDTO) -> Void
    @State private var text = ""
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(L("mail.commentTeamPh"), text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("mail.commentField")
                Button(L("comments.send")) { send() }
                    .buttonStyle(.borderedProminent).tint(Theme.primaryFill)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                    .accessibilityIdentifier("mail.commentSend")
            }
            Text(L("mail.teamOnly", ["name": MailUI.firstName(email.other?.display)])).font(.caption2).foregroundStyle(Theme.textSecondary)
        }
    }
    private func send() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do { let c = try await store.commentMail(email.id, body: body); text = ""; onSent(c) } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// «Responder a …»: solo quien trajo el correo (sale de su buzón). CC editable, gg, adjuntos del chat y programar.
struct MailReplyBox: View {
    @Environment(AppStore.self) private var store
    let email: SharedMailDTO
    var onSent: () -> Void
    @State private var body_ = ""
    @State private var cc = ""
    @State private var picked: [String] = []
    @State private var busy: String?
    @State private var scheduleMenu = false
    @State private var custom = false
    @State private var at = Date().addingTimeInterval(3600)
    @State private var attachPicker = false

    private var draftKey: String { "tc.mailDraft.\(email.id)" }
    private var ccList: [String] { MailText.parseCc(cc) }
    private var badCc: Bool { ccList.contains { !MailText.validEmail($0) } }
    private var canSend: Bool { !body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && busy == nil && !badCc }

    /// Adjuntos del chat (de los mensajes cargados), los 12 más recientes, sin notas de voz.
    private var files: [(AttachmentDTO, String)] {
        let msgs = store.conversations[email.conversationId]?.messages ?? []
        return Array(msgs.flatMap { m in m.attachments.filter { $0.kind != "voice" }.map { ($0, m.authorId) } }.suffix(12).reversed())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(L("mail.meta.to")): \(MailText.replyTo(email).map(\.display).joined(separator: ", ")) · \(L("mail.from")): \(email.accountEmail ?? "")")
                .font(.caption2).foregroundStyle(Theme.textSecondary).lineLimit(2)
            HStack {
                Text("CC").font(.caption.weight(.semibold))
                TextField(L("mail.ccPh"), text: $cc).font(.caption).textInputAutocapitalization(.never).keyboardType(.emailAddress).autocorrectionDisabled()
                    .accessibilityIdentifier("mail.cc")
            }
            if badCc { Text(L("mail.badCc")).font(.caption2).foregroundStyle(.red) }
            TextField(L("mail.replyPh"), text: $body_, axis: .vertical)
                .lineLimit(3...8)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("mail.replyField")
            HStack(spacing: 8) {
                Button(busy == "draft" ? L("mail.ggWorking") : "✨ " + L("mail.gg")) { draft() }
                    .font(.caption.weight(.semibold)).disabled(busy != nil)
                    .accessibilityIdentifier("mail.gg")
                if !files.isEmpty {
                    Button("📎 " + (picked.isEmpty ? L("mail.attachFromChat") : L("mail.attachN", ["n": picked.count]))) { attachPicker = true }
                        .font(.caption.weight(.semibold))
                        .accessibilityIdentifier("mail.attachFromChat")
                }
                Spacer()
            }
            Text(email.commentCount > 0 ? L("mail.ggHint", ["n": email.commentCount]) : L("mail.ggHintNone")).font(.caption2).foregroundStyle(Theme.textSecondary)
            HStack {
                Text(L("mail.sentVia", ["name": email.provider.label])).font(.caption2).foregroundStyle(Theme.textSecondary)
                Spacer()
                HStack(spacing: 1) {
                    Text(busy == "send" ? L("mail.sending") : L("mail.send"))
                        .font(.subheadline.weight(.bold)).foregroundStyle(Theme.onPrimary)
                        .padding(.horizontal, 14).frame(minHeight: 36)
                        .background(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18).fill(Theme.primaryFill))
                        .contentShape(Rectangle())
                        .onTapGesture { if canSend { send(nil) } }
                        .onLongPressGesture(minimumDuration: 0.45) { if canSend { scheduleMenu = true } }
                        .accessibilityAddTraits(.isButton)
                        .accessibilityIdentifier("mail.send")
                    Button { scheduleMenu = true } label: {
                        Image(systemName: "chevron.down").font(.caption.weight(.bold)).foregroundStyle(Theme.onPrimary)
                            .frame(width: 32, height: 36)
                            .background(UnevenRoundedRectangle(bottomTrailingRadius: 18, topTrailingRadius: 18).fill(Theme.primaryFill))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("mail.scheduleMenu"))
                    .accessibilityIdentifier("mail.scheduleMenu")
                }
                .opacity(canSend ? 1 : 0.45)
                .disabled(!canSend)
            }
        }
        .onAppear {
            cc = MailText.defaultCc(email).joined(separator: ", ")
            if body_.isEmpty, let saved = UserDefaults.standard.string(forKey: draftKey) { body_ = saved }
        }
        .onChange(of: body_) { _, v in
            if v.isEmpty { UserDefaults.standard.removeObject(forKey: draftKey) } else { UserDefaults.standard.set(v, forKey: draftKey) }
        }
        .confirmationDialog(L("mail.scheduleMenu"), isPresented: $scheduleMenu, titleVisibility: .visible) {
            Button(L("when.1h")) { send(MailText.quickDate(.in1h)) }
            Button(L("when.3h")) { send(MailText.quickDate(.in3h)) }
            Button(L("when.tomorrow")) { send(MailText.quickDate(.tomorrow9)) }
            Button(L("when.monday")) { send(MailText.quickDate(.monday9)) }
            Button(L("mail.pickTime")) { at = Date().addingTimeInterval(3600); custom = true }
            Button(L("common.cancel"), role: .cancel) {}
        }
        .sheet(isPresented: $custom) {
            NavigationStack {
                DatePicker(L("mail.pickTime"), selection: $at, in: Date().addingTimeInterval(60)...Date().addingTimeInterval(89 * 86_400))
                    .datePickerStyle(.graphical).padding()
                    .navigationTitle(L("mail.scheduleMenu"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { custom = false } }
                        ToolbarItem(placement: .confirmationAction) { Button(L("mail.schedule")) { custom = false; send(at) }.accessibilityIdentifier("mail.scheduleConfirm") }
                    }
            }
            .presentationDetents([.large])
        }
        .sheet(isPresented: $attachPicker) {
            NavigationStack {
                List(files, id: \.0.id) { pair in
                    let (a, by) = pair
                    Button {
                        if let i = picked.firstIndex(of: a.id) { picked.remove(at: i) } else if picked.count < 10 { picked.append(a.id) }
                    } label: {
                        HStack {
                            Image(systemName: picked.contains(a.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(Theme.accentText)
                            VStack(alignment: .leading) {
                                Text(a.name).lineLimit(1).foregroundStyle(Theme.textPrimary)
                                Text("\(MailText.size(a.sizeBytes)) · \(MailUI.firstName(store.data.flatMap { Naming.person($0, by)?.name }))").font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                        }
                    }
                }
                .navigationTitle(L("mail.attachFromChat"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.done")) { attachPicker = false } } }
            }
            .presentationDetents([.medium, .large])
        }
    }

    private func draft() {
        busy = "draft"
        Task {
            defer { busy = nil }
            do { body_ = try await store.draftMailReply(email.id) } catch { store.show(L10n.errorText(error)) }
        }
    }

    private func send(_ sendAt: Date?) {
        guard canSend else { return }
        busy = "send"
        let text = body_.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { busy = nil }
            do {
                try await store.replyMail(email.id, body: text, cc: ccList, attachmentIds: picked, sendAt: sendAt)
                UserDefaults.standard.removeObject(forKey: draftKey)
                body_ = ""
                store.show(sendAt.map { L("mail.scheduledToast", ["when": MailUI.when($0)]) } ?? L("mail.sentToast"))
                onSent()
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}

// MARK: - Tarea desde el correo

struct MailTaskSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let email: SharedMailDTO
    @State private var title = ""
    @State private var owner: String = ""
    @State private var hasDue = false
    @State private var due = Date()
    @State private var closeOnReply = true
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section(L("mail.taskName")) {
                    TextField(L("mail.taskName"), text: $title, axis: .vertical).accessibilityIdentifier("mailTask.title")
                }
                Section {
                    Picker(L("mail.taskOwner"), selection: $owner) {
                        Text(L("mail.taskNoOwner")).tag("")
                        ForEach(members, id: \.id) { p in Text(p.name).tag(p.id) }
                    }
                    .accessibilityIdentifier("mailTask.owner")
                    Toggle(L("mail.taskDue"), isOn: $hasDue)
                    if hasDue { DatePicker(L("mail.taskDue"), selection: $due, in: Calendar.current.startOfDay(for: Date())..., displayedComponents: .date) }
                    Toggle(L("mail.taskClose"), isOn: $closeOnReply).accessibilityIdentifier("mailTask.close")
                } footer: { Text(L("mail.taskHint")) }
            }
            .navigationTitle(L("mail.taskTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("mail.taskCreate")) { create() }
                        .disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
                        .accessibilityIdentifier("mailTask.create")
                }
            }
            .onAppear {
                if title.isEmpty { title = MailText.taskTitle(email, prefix: L("mail.taskPrefix")) }
                if owner.isEmpty { owner = store.me?.id ?? "" }
            }
        }
    }

    private var members: [PersonDTO] {
        guard let d = store.data else { return [] }
        let ids = store.meta(email.conversationId)?.memberIds ?? [d.me.id]
        return ids.compactMap { Naming.person(d, $0) }.filter { $0.kind != "agent" }
    }

    private func create() {
        busy = true
        Task {
            defer { busy = false }
            do {
                _ = try await store.mailTask(email.id, title: title.trimmingCharacters(in: .whitespacesAndNewlines), ownerId: owner.isEmpty ? nil : owner,
                                             dueDate: hasDue ? MailText.ymd(due) : nil, closeOnReply: closeOnReply)
                store.show(L("mail.taskCreated"))
                dismiss()
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}
