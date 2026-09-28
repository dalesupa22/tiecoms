import SwiftUI
import UIKit

/// Sello circular de un documento firmado: ✓ con la referencia debajo (la misma que va impresa en el PDF).
struct SignSeal: View {
    let ref: String
    var size: CGFloat = 46
    var body: some View {
        ZStack {
            Circle().fill(SignColors.okBg)
            Circle().strokeBorder(SignColors.ok, lineWidth: max(1.5, size / 22))
            Circle().strokeBorder(SignColors.ok.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [2, 2])).padding(size * 0.1)
            VStack(spacing: size * 0.01) {
                Image(systemName: "checkmark").font(.system(size: size * 0.32, weight: .heavy))
                Text(ref).font(.system(size: max(6, size * 0.13), weight: .bold, design: .monospaced)).lineLimit(1).minimumScaleFactor(0.5)
                    .padding(.horizontal, size * 0.12)
            }
            .foregroundStyle(SignColors.ok)
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(L("signed.refLabel", ["ref": ref]))
    }
}

/// «Documentos que firmé»: historial con buscador, agrupado por día, y mis firmas guardadas.
struct SignedDocumentsView: View {
    @Environment(AppStore.self) private var store
    @State private var items: [SigningHistoryItemDTO] = []
    @State private var nextBefore: String?
    @State private var total = 0
    @State private var loading = false
    @State private var loaded = false
    @State private var error: String?
    @State private var query = ""
    @State private var createKind: SignatureDTO.Kind?
    @State private var searchTask: Task<Void, Never>?
    private var saved: SavedSignatures { .shared }

    var body: some View {
        List {
            if query.isEmpty {
                Section(L("signed.saved")) {
                    if saved.list?.isEmpty == true {
                        Text(L("signed.savedEmpty")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                    SavedSignatureGrid(kind: nil, onPick: nil, onNew: { createKind = .signature })
                        .padding(.vertical, 4)
                    if saved.total < SignLimits.maxSaved {
                        Button { createKind = .initials } label: { Label(L("sign.newInitials"), systemImage: "plus") }
                    }
                }
            }
            if let error, items.isEmpty {
                Section { Text(error).foregroundStyle(.red); Button(L("common.retry")) { Task { await load(reset: true) } } }
            }
            if loaded, items.isEmpty, error == nil {
                Section { Text(L(query.isEmpty ? "signed.empty" : "signed.noResults")).foregroundStyle(Theme.textSecondary) }
            }
            ForEach(days, id: \.0) { day, rows in
                Section(day) {
                    ForEach(rows) { it in
                        NavigationLink { SignedDetailView(item: it) } label: { SignedRow(item: it) }
                            .accessibilityIdentifier("signed.row.\(it.ref)")
                            .onAppear { if it.id == items.last?.id { Task { await load(reset: false) } } }
                    }
                }
            }
            if loading { HStack { Spacer(); ProgressView(); Spacer() } }
        }
        .navigationTitle(L("signed.title"))
        .searchable(text: $query, prompt: L("signed.search"))
        .onChange(of: query) { _, _ in
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                await load(reset: true)
            }
        }
        .refreshable { await load(reset: true); try? await saved.reload(store.api) }
        .task {
            if !loaded { await load(reset: true) }
            await saved.ensure(store.api)
        }
        .sheet(item: Binding(get: { createKind.map(KindBox.init) }, set: { createKind = $0?.kind })) { box in
            CreateSignatureSheet(kind: box.kind) { _ in createKind = nil }
        }
    }

    private struct KindBox: Identifiable { let kind: SignatureDTO.Kind; var id: String { kind.rawValue } }

    /// Filas agrupadas por día (Hoy, Ayer, fecha).
    private var days: [(String, [SigningHistoryItemDTO])] {
        let cal = Calendar.current
        let f = DateFormatter()
        f.locale = L10n.locale
        f.dateStyle = .full
        f.timeStyle = .none
        f.doesRelativeDateFormatting = true
        var out: [(String, [SigningHistoryItemDTO])] = []
        var lastDay: Date?
        for it in items {
            let d = ISODate.parse(it.signing.signedAt) ?? .distantPast
            let day = cal.startOfDay(for: d)
            if day == lastDay, !out.isEmpty { out[out.count - 1].1.append(it) } else {
                out.append((f.string(from: d).capitalizedFirst, [it])); lastDay = day
            }
        }
        return out
    }

    private func load(reset: Bool) async {
        if loading || (!reset && nextBefore == nil) { return }
        loading = true
        defer { loading = false }
        do {
            let q = query
            let page = try await store.api.listSignings(before: reset ? nil : nextBefore, q: q)
            guard q == query else { return }
            items = reset ? page.signings : items + page.signings.filter { n in !items.contains { $0.id == n.id } }
            nextBefore = page.nextBefore
            total = page.total
            error = nil
        } catch {
            if reset { items = [] }
            self.error = L10n.errorText(error)
        }
        loaded = true
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

struct SignedRow: View {
    let item: SigningHistoryItemDTO
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            SignSeal(ref: item.ref)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.documentName).font(.subheadline.weight(.semibold)).lineLimit(2)
                if let line = SignedText.requestLine(item) { Text(line).font(.footnote).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                Text(SignedText.time(item.signing.signedAt) + " · " + SignedText.marks(item))
                    .font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

enum SignedText {
    static func requestLine(_ it: SigningHistoryItemDTO) -> String? {
        let parts = [it.requestedByName.map { L("signed.requestedBy", ["name": $0]) }, it.conversationName].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    static func marks(_ it: SigningHistoryItemDTO) -> String {
        L("signed.marks", ["n": it.signatureMarks, "p": it.pagesMarked, "total": it.pages])
    }
    static func time(_ iso: String) -> String {
        guard let d = ISODate.parse(iso) else { return "" }
        let f = DateFormatter(); f.locale = L10n.locale; f.dateStyle = .none; f.timeStyle = .short
        return f.string(from: d)
    }
    static func full(_ iso: String) -> String {
        guard let d = ISODate.parse(iso) else { return iso }
        let f = DateFormatter(); f.locale = L10n.locale; f.dateStyle = .full; f.timeStyle = .medium
        return f.string(from: d)
    }
}

/// Constancia de una firma: sello grande, referencia, fecha, quién lo pidió, dónde, marcas y huellas.
struct SignedDetailView: View {
    @Environment(AppStore.self) private var store
    let item: SigningHistoryItemDTO
    @State private var viewer: AttachmentDTO?

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    SignSeal(ref: item.ref, size: 104)
                    Text(item.documentName).font(.headline).multilineTextAlignment(.center)
                    Text(L("signed.refLabel", ["ref": item.ref])).font(.subheadline.monospaced()).foregroundStyle(SignColors.ok)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            Section {
                row(L("signed.when"), SignedText.full(item.signing.signedAt))
                row(L("signed.signer"), item.signing.signerName)
                if let who = item.requestedByName { row(L("signed.who"), who) }
                if let conv = item.conversationName {
                    Button { goToMessage() } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(L("signed.where")).font(.caption).foregroundStyle(Theme.textSecondary)
                                Text(conv).foregroundStyle(Theme.accentText)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
                row(L("signed.marksLabel"), SignedText.marks(item))
                if item.stamp { Label(L("sign.stamp"), systemImage: "checkmark.seal").font(.subheadline) }
                if item.certificate { Label(L("sign.certificate"), systemImage: "doc.badge.plus").font(.subheadline) }
            }
            Section(L("signed.fingerprints")) {
                hash(L("signed.hashOriginal"), item.signing.originalSha256)
                hash(L("signed.hashSigned"), item.signing.signedSha256)
            }
            Section {
                if let a = item.attachment {
                    Button { viewer = a } label: { Label(L("signed.viewPdf"), systemImage: "doc.richtext") }
                        .accessibilityIdentifier("signed.viewPdf")
                } else {
                    Text(L("signed.noAccess")).font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                if !item.conversationId.isEmpty {
                    Button { goToMessage() } label: { Label(L("signed.goMessage"), systemImage: "bubble.left.and.bubble.right") }
                }
            }
        }
        .navigationTitle(L("signed.detailTitle"))
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(item: $viewer) { a in PdfSignScreen(att: a, startSigning: false) }
    }

    private func row(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(Theme.textSecondary)
            Text(value)
        }
        .accessibilityElement(children: .combine)
    }

    private func hash(_ label: String, _ value: String) -> some View {
        Button {
            UIPasteboard.general.string = value
            store.show(L("common.copied"))
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(label).font(.caption).foregroundStyle(Theme.textSecondary)
                    Spacer()
                    Image(systemName: "doc.on.doc").font(.caption).foregroundStyle(Theme.textSecondary)
                }
                Text(value).font(.caption.monospaced()).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.leading)
            }
        }
        .accessibilityHint(L("common.copy"))
    }

    private func goToMessage() {
        if let m = item.messageId { store.openMessage(item.conversationId, messageId: m) } else { store.navigate(to: .conversation(item.conversationId)) }
    }
}
