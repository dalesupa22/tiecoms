import PencilKit
import PhotosUI
import SwiftUI
import UIKit

extension AttachmentDTO {
    var isPdf: Bool { contentType == "application/pdf" || name.lowercased().hasSuffix(".pdf") }
}

enum SignColors {
    static let ok = Color(light: 0x15803D, dark: 0x4ADE80)
    static let okBg = Color(light: 0xDCFCE7, dark: 0x14532D)
    static let warnBg = Color(light: 0xFEF3C7, dark: 0x422006)
    static let warn = Color(light: 0x92400E, dark: 0xFCD34D)
}

/// Firmas guardadas (caché de la sesión de la app, como la web).
@MainActor
@Observable
final class SavedSignatures {
    static let shared = SavedSignatures()
    private(set) var list: [SignatureDTO]?
    private(set) var loading = false

    func reload(_ api: APIClient) async throws {
        loading = true
        defer { loading = false }
        list = try await api.listSignatures()
    }

    func ensure(_ api: APIClient) async { if list == nil { try? await reload(api) } }
    func add(_ s: SignatureDTO) { list = [s] + (list ?? []).filter { $0.id != s.id } }
    func remove(_ id: String) { list = (list ?? []).filter { $0.id != id } }
    func of(_ kind: SignatureDTO.Kind) -> [SignatureDTO] { (list ?? []).filter { $0.kind == kind } }
    var total: Int { list?.count ?? 0 }
}

/// Imagen de una firma guardada (PNG con Bearer).
struct SignatureImage: View {
    @Environment(AppStore.self) private var store
    let sig: SignatureDTO
    @State private var image: UIImage?
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() } else { ProgressView() }
        }
        .task(id: sig.id) {
            if let d = try? await AttachmentCache.shared.data(sig.url, api: store.api) { image = UIImage(data: d) }
        }
    }
}

// MARK: - Visor y editor

/// Ver y firmar un PDF del chat. Ver: páginas a lo ancho, dibujadas al acercarse. Firmar: marcas (firma, iniciales,
/// fecha, texto) que se arrastran con el dedo a cualquier parte y se agrandan con el asa o el pellizco.
struct PdfSignScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let att: AttachmentDTO
    @State private var session: SignSession
    @State private var document: CGPDFDocument?
    @State private var loadError: String?
    @State private var info: SignInfoDTO?
    @State private var fileURL: URL?
    @State private var sheet: SignSheet?
    @State private var confirmDiscard = false
    private var saved: SavedSignatures { .shared }

    /// 1.7.14: gg, tarea y compartir abajo mientras se ve (no al firmar).
    var actions: FileViewerActions? = nil

    init(att: AttachmentDTO, startSigning: Bool, actions: FileViewerActions? = nil) {
        self.att = att
        self.actions = actions
        _session = State(initialValue: SignSession(signing: startSigning))
    }

    enum SignSheet: Identifiable {
        case pick(SignatureDTO.Kind), create(SignatureDTO.Kind), text(markId: String?), confirm
        var id: String {
            switch self {
            case .pick(let k): return "pick-\(k.rawValue)"
            case .create(let k): return "create-\(k.rawValue)"
            case .text(let m): return "text-\(m ?? "")"
            case .confirm: return "confirm"
            }
        }
    }

    private var signed: AttachmentSigningDTO? { att.signing ?? info?.signing }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            banners
            ZStack {
                Theme.bubbleOther
                if let loadError {
                    Text(loadError).multilineTextAlignment(.center).foregroundStyle(Theme.textSecondary).padding(24)
                } else if let document {
                    SignCanvas(document: document, session: session)
                } else {
                    ProgressView(L("common.loading"))
                }
            }
            if session.signing, document != nil { toolbar }
            if !session.signing, let actions { FileViewerActionBar(att: att, actions: actions) }
        }
        .background(Theme.background.ignoresSafeArea())
        .task { await load() }
        .onAppear { session.onEditText = { id in sheet = .text(markId: id) } }
        .sheet(item: $sheet) { s in sheetView(s) }
        .confirmationDialog(L("sign.discard"), isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button(L("common.close"), role: .destructive) { dismiss() }
            Button(L("common.cancel"), role: .cancel) {}
        }
        .interactiveDismissDisabled(session.dirty)
    }

    // MARK: Barras

    private var topBar: some View {
        HStack(spacing: 4) {
            Button { close() } label: {
                Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44)
            }
            .accessibilityLabel(L("common.close"))
            .accessibilityIdentifier("sign.close")
            VStack(alignment: .leading, spacing: 1) {
                Text(att.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(session.board.pages.isEmpty ? L("common.loading") : L("sign.pageOf", ["i": session.visiblePage, "n": session.board.pages.count]))
                    .font(.caption).foregroundStyle(Theme.textSecondary).monospacedDigit()
                    .accessibilityIdentifier("sign.pageLabel")
            }
            Spacer(minLength: 4)
            if let fileURL {
                ShareLink(item: fileURL) {
                    Image(systemName: "square.and.arrow.up").font(.system(size: 17)).frame(width: 44, height: 44)
                }
                .accessibilityLabel(L("att.download"))
            }
            if !session.signing {
                Button { session.signing = true } label: { Text("✍️ " + L("sign.sign")).font(.subheadline.weight(.semibold)) }
                    .primaryProminent()
                    .disabled(document == nil || info?.encrypted == true)
                    .accessibilityIdentifier("sign.start")
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Theme.surface)
    }

    @ViewBuilder private var banners: some View {
        if let signed, !session.signing {
            banner("✓ " + L("sign.signedBy", ["name": signed.signerName, "when": SignFormat.when(signed.signedAt)]) + " · " + String(signed.signedSha256.prefix(12)),
                   fg: SignColors.ok, bg: SignColors.okBg)
                .accessibilityIdentifier("sign.signedBanner")
        }
        if session.signing, info?.hasDigitalSignature == true {
            banner("⚠️ " + L("sign.hasDigital"), fg: SignColors.warn, bg: SignColors.warnBg)
        }
        if session.signing, session.board.marks.isEmpty, document != nil {
            banner(L("sign.hint"), fg: Theme.textPrimary, bg: Theme.surface)
        }
    }

    private func banner(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text).font(.footnote).foregroundStyle(fg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(bg)
    }

    private var toolbar: some View {
        HStack(spacing: 0) {
            if let sel = session.selectedMark {
                tool("trash", L("sign.remove"), id: "sign.tool.remove") { session.mutate { $0.remove(sel.id) }; session.selected = nil }
                if sel.kind.isImage {
                    tool("plus.square.on.square", L("sign.duplicate"), id: "sign.tool.duplicate") {
                        var nid: String?
                        session.mutate { nid = $0.duplicate(sel.id) }
                        session.selected = nid
                    }
                }
                if session.board.pages.count > 1 {
                    tool("square.stack", L("sign.allPages"), id: "sign.tool.allPages") {
                        var n = 0
                        session.mutate { n = $0.toAllPages(sel.id) }
                        store.show(L("sign.copied", ["n": n]))
                    }
                }
                if sel.kind.isText { tool("pencil", L("sign.editText"), id: "sign.tool.edit") { sheet = .text(markId: sel.id) } }
                tool("checkmark", L("common.done"), id: "sign.tool.done") { session.selected = nil }
            } else {
                tool("signature", L("sign.signature"), id: "sign.tool.signature") { startSig(.signature) }
                toolText("AB", L("sign.initials"), id: "sign.tool.initials") { startSig(.initials) }
                tool("calendar", L("sign.date"), id: "sign.tool.date") { placeText(.date, SignText.today()) }
                toolText("Aa", L("sign.text"), id: "sign.tool.text") { sheet = .text(markId: nil) }
                let n = session.board.signatureCount
                Button { sheet = .confirm } label: {
                    Text(L("sign.finish") + (n > 0 ? " (\(n))" : "")).font(.subheadline.weight(.bold)).lineLimit(1).minimumScaleFactor(0.8)
                        .frame(minWidth: 88, minHeight: 44)
                }
                .primaryProminent()
                .disabled(n == 0)
                .padding(.leading, 4)
                .accessibilityIdentifier("sign.finish")
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .background(Theme.surface.shadow(.drop(color: .black.opacity(0.08), radius: 4, y: -1)))
    }

    private func tool(_ icon: String, _ label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon).font(.system(size: 19))
                Text(label).font(.caption2).lineLimit(1).minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.textPrimary)
        .accessibilityIdentifier(id)
    }

    private func toolText(_ glyph: String, _ label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Text(glyph).font(.system(size: 16, weight: .bold, design: glyph == "AB" ? .serif : .default)).italic(glyph == "AB").frame(height: 22)
                Text(label).font(.caption2).lineLimit(1).minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.textPrimary)
        .accessibilityIdentifier(id)
    }

    // MARK: Acciones

    private func close() {
        if session.dirty { confirmDiscard = true } else { dismiss() }
    }

    private func load() async {
        async let infoTask: SignInfoDTO? = try? store.api.signInfo(att.id)
        do {
            let url = try await AttachmentCache.shared.fileURL(att, api: store.api)
            fileURL = url
            let data = try Data(contentsOf: url)
            guard let provider = CGDataProvider(data: data as CFData), let doc = CGPDFDocument(provider), doc.numberOfPages > 0 else {
                loadError = L("sign.cantOpen"); _ = await infoTask; return
            }
            if doc.isEncrypted, !doc.isUnlocked, !doc.unlockWithPassword("") { loadError = L("sign.encrypted"); _ = await infoTask; return }
            session.board.pages = (1...doc.numberOfPages).compactMap { doc.page(at: $0).map { PdfPageGeometry($0).size } }
            document = doc
        } catch {
            loadError = L10n.errorText(error)
        }
        info = await infoTask
        if info?.encrypted == true { session.signing = false }
        await saved.ensure(store.api)
    }

    private func startSig(_ kind: SignatureDTO.Kind) {
        sheet = saved.of(kind).isEmpty ? .create(kind) : .pick(kind)
    }

    private func place(_ s: SignatureDTO) {
        let page = session.visiblePage
        var id: String?
        session.mutate { id = $0.addSignature(s, page: page, center: session.viewCenter(page)) }
        session.selected = id
        loadImage(s)
    }

    private func loadImage(_ s: SignatureDTO) {
        guard session.images[s.id] == nil else { return }
        Task {
            if let d = try? await AttachmentCache.shared.data(s.url, api: store.api), let img = UIImage(data: d) { session.setImage(img, for: s.id) }
        }
    }

    private func placeText(_ kind: SignMarkKind, _ text: String, replace: String? = nil) {
        if let replace { session.mutate { $0.replaceText(replace, text, width1: SignText.width1) }; return }
        let page = session.visiblePage
        var id: String?
        session.mutate { id = $0.addText(kind, text, page: page, center: session.viewCenter(page), width1: SignText.width1) }
        session.selected = id
    }

    @ViewBuilder private func sheetView(_ s: SignSheet) -> some View {
        switch s {
        case .pick(let kind):
            PickSignatureSheet(kind: kind, onPick: { sig in sheet = nil; place(sig) }, onNew: { sheet = .create(kind) })
                .presentationDetents([.medium, .large])
        case .create(let kind):
            CreateSignatureSheet(kind: kind) { sig in
                if let img = sig.1 { session.setImage(img, for: sig.0.id) }
                sheet = nil
                place(sig.0)
            }
        case .text(let markId):
            TextMarkSheet(initial: markId.flatMap { session.board.mark($0)?.text } ?? "") { text in
                sheet = nil
                placeText(.text, text, replace: markId)
            }
            .presentationDetents([.medium])
        case .confirm:
            ConfirmSignSheet(att: att, info: info, board: session.board) {
                sheet = nil
                session.mutate { $0.marks = [] }
                store.show(L("sign.done"))
                dismiss()
            }
            .presentationDetents([.large])
        }
    }
}

enum SignFormat {
    static func when(_ iso: String) -> String {
        guard let d = ISODate.parse(iso) else { return iso }
        let f = DateFormatter()
        f.locale = L10n.locale
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: d)
    }
}

// MARK: - Elegir una firma guardada

struct PickSignatureSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let kind: SignatureDTO.Kind
    var onPick: (SignatureDTO) -> Void
    var onNew: () -> Void
    @State private var confirmDelete: SignatureDTO?
    private var saved: SavedSignatures { .shared }

    var body: some View {
        NavigationStack {
            ScrollView {
                SavedSignatureGrid(kind: kind, onPick: onPick, onNew: onNew)
                    .padding(16)
            }
            .navigationTitle(L(kind == .initials ? "sign.myInitials" : "sign.mySignatures"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
        }
    }
}

/// Mosaicos de firmas guardadas + «Nueva firma». Borrar pide confirmación.
struct SavedSignatureGrid: View {
    @Environment(AppStore.self) private var store
    let kind: SignatureDTO.Kind?
    var onPick: ((SignatureDTO) -> Void)?
    var onNew: () -> Void
    @State private var confirmDelete: SignatureDTO?
    private var saved: SavedSignatures { .shared }

    var body: some View {
        let list = kind.map { saved.of($0) } ?? (saved.list ?? [])
        VStack(alignment: .leading, spacing: 10) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
                ForEach(list) { s in
                    ZStack(alignment: .topTrailing) {
                        let tile = SignatureImage(sig: s).padding(10)
                            .frame(maxWidth: .infinity, minHeight: 84, maxHeight: 84)
                            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.textSecondary.opacity(0.3)))
                        if let onPick {
                            Button { onPick(s) } label: { tile }
                                .buttonStyle(.plain)
                                .accessibilityLabel(L("sign.use"))
                                .accessibilityIdentifier("sign.saved.\(s.id)")
                        } else {
                            tile.accessibilityElement().accessibilityLabel(L(s.kind == .initials ? "sign.initials" : "sign.signature"))
                        }
                        Button { confirmDelete = s } label: {
                            Image(systemName: "trash").font(.system(size: 14)).foregroundStyle(.red)
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel(L("sign.delete"))
                    }
                }
                Button(action: onNew) {
                    VStack(spacing: 4) {
                        Image(systemName: "plus").font(.title3)
                        Text(L(kind == .initials ? "sign.newInitials" : "sign.newSignature")).font(.footnote.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 84)
                    .foregroundStyle(Theme.accentText)
                    .background(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.accentText.opacity(0.6), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])))
                }
                .buttonStyle(.plain)
                .disabled(saved.total >= SignLimits.maxSaved)
                .accessibilityIdentifier("sign.new")
            }
            if saved.total >= SignLimits.maxSaved {
                Text(L("sign.tooMany", ["n": SignLimits.maxSaved])).font(.footnote).foregroundStyle(Theme.textSecondary)
            }
        }
        .confirmationDialog(L("sign.deleteConfirm"), isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                            titleVisibility: .visible, presenting: confirmDelete) { s in
            Button(L("sign.delete"), role: .destructive) {
                Task {
                    do { try await store.api.deleteSignature(s.id); saved.remove(s.id) } catch { store.show(L10n.errorText(error)) }
                }
            }
            Button(L("common.cancel"), role: .cancel) {}
        }
    }
}

// MARK: - Crear una firma

struct CreateSignatureSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let kind: SignatureDTO.Kind
    /// Firma subida y su imagen (para verla sin esperar la descarga).
    var onSaved: ((SignatureDTO, UIImage?)) -> Void

    enum Tab: String, CaseIterable, Identifiable { case drawn, typed, uploaded; var id: String { rawValue } }
    @State private var tab: Tab = .drawn
    @State private var ink: SignImage.Ink = .blue
    @State private var busy = false
    @State private var error: String?
    // Dibujar
    @State private var drawing = PKDrawing()
    // Escribir
    @State private var typed = ""
    @State private var script: SignImage.Script = .dancing
    // Foto
    @State private var photo: UIImage?
    @State private var photoItem: PhotosPickerItem?
    @State private var showCamera = false
    @State private var threshold: Double = 160
    @State private var autoThreshold = 160
    @State private var keepColor = false
    @State private var processed: CGImage?
    @State private var processing = false

    private var isEmpty: Bool {
        switch tab {
        case .drawn: return drawing.strokes.isEmpty
        case .typed: return typed.trimmingCharacters(in: .whitespaces).isEmpty
        case .uploaded: return processed == nil
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Picker("", selection: $tab) {
                        ForEach(Tab.allCases) { t in Text(L("sign.tab.\(t.rawValue)")).tag(t) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("sign.create.tabs")
                    switch tab {
                    case .drawn: drawPad
                    case .typed: typePad
                    case .uploaded: photoPad
                    }
                    HStack(spacing: 10) {
                        Text(L("sign.ink")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        ForEach(SignImage.Ink.allCases) { c in
                            Button { ink = c } label: {
                                Circle().fill(Color(c.color)).frame(width: 28, height: 28)
                                    .overlay(Circle().stroke(Theme.accentText, lineWidth: ink == c ? 3 : 0).padding(-4))
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel(L("sign.ink.\(c.rawValue)"))
                            .accessibilityAddTraits(ink == c ? .isSelected : [])
                        }
                    }
                    Text(L("sign.privacy")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollDisabled(tab == .drawn)
            .navigationTitle(L(kind == .initials ? "sign.newInitials" : "sign.newSignature"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("common.wait") : L("sign.saveUse")) { Task { await save() } }
                        .disabled(busy || isEmpty)
                        .accessibilityIdentifier("sign.create.save")
                }
            }
        }
        // Trazar hacia abajo no debe cerrar la hoja.
        .interactiveDismissDisabled()
        .onAppear {
            let name = store.me?.name ?? ""
            typed = kind == .initials ? SignInitials.of(name) : name
        }
        .onChange(of: ink) { _, _ in recolor(); if tab == .uploaded { reprocess() } }
        .onChange(of: keepColor) { _, _ in reprocess() }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let d = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: d) { setPhoto(img) }
                else { store.show(L("sign.photoError")) }
                photoItem = nil
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(front: false) { img in
                showCamera = false
                if let img { setPhoto(img) }
            }
            .ignoresSafeArea()
        }
    }

    // Dibujar: lienzo 5:2 (iniciales 2:1) con línea guía.
    private var drawPad: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ZStack(alignment: .bottomLeading) {
                RoundedRectangle(cornerRadius: 12).fill(Color.white)
                Rectangle().fill(Color.gray.opacity(0.35)).frame(height: 1).padding(.horizontal, 18).padding(.bottom, 38)
                if drawing.strokes.isEmpty {
                    Text(L("sign.drawHere")).font(.footnote).foregroundStyle(Color.gray).padding(.leading, 20).padding(.bottom, 16)
                }
                SignaturePadView(drawing: $drawing, ink: ink)
                    .accessibilityIdentifier("sign.pad")
            }
            .aspectRatio(kind == .initials ? 2 : 2.5, contentMode: .fit)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.textSecondary.opacity(0.35)))
            Button(L("sign.clear")) { drawing = PKDrawing() }
                .frame(minHeight: 44)
                .disabled(drawing.strokes.isEmpty)
        }
    }

    private var typePad: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(L("sign.typePh"), text: $typed)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .accessibilityIdentifier("sign.type.field")
            ForEach(SignImage.Script.allCases) { s in
                Button { script = s } label: {
                    Text(typed.trimmingCharacters(in: .whitespaces).isEmpty ? L("sign.typePh") : typed)
                        .font(Font(s.font(size: 34)))
                        .foregroundStyle(Color(ink.color))
                        .lineLimit(1).minimumScaleFactor(0.4)
                        .frame(maxWidth: .infinity, minHeight: 64)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(script == s ? Theme.accentText : Theme.textSecondary.opacity(0.3), lineWidth: script == s ? 2.5 : 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(s.rawValue)
                .accessibilityAddTraits(script == s ? .isSelected : [])
            }
        }
    }

    private var photoPad: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(Color.white)
                if let processed {
                    Image(uiImage: UIImage(cgImage: processed)).resizable().scaledToFit().padding(8)
                } else if processing {
                    ProgressView()
                } else {
                    Text(L("sign.photoHint")).font(.footnote).foregroundStyle(Color.gray).multilineTextAlignment(.center).padding()
                }
            }
            .frame(height: 160)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.textSecondary.opacity(0.35)))
            HStack(spacing: 10) {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { showCamera = true } label: { Label(L("sign.takePhoto"), systemImage: "camera").frame(minHeight: 36) }
                        .buttonStyle(.bordered)
                }
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Label(L("sign.pickImage"), systemImage: "photo").frame(minHeight: 36)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("sign.photo.pick")
            }
            if photo != nil {
                Toggle(L("sign.keepColor"), isOn: $keepColor).font(.subheadline)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("sign.cleanBg")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    let lo = Double(max(40, autoThreshold - 70)), hi = Double(min(250, autoThreshold + 70))
                    Slider(value: $threshold, in: lo...max(lo + 1, hi), step: 1) { editing in if !editing { reprocess() } }
                        .accessibilityLabel(L("sign.cleanBg"))
                }
            }
        }
    }

    private func recolor() {
        drawing = PKDrawing(strokes: drawing.strokes.map { s in
            var s = s
            s.ink = PKInk(.pen, color: ink.color)
            return s
        })
    }

    private func setPhoto(_ img: UIImage) {
        photo = img
        processed = nil
        processing = true
        let ink = keepColor ? nil : ink
        Task.detached(priority: .userInitiated) {
            let r = SignImage.photo(img, ink: ink, threshold: nil)
            await MainActor.run {
                processing = false
                guard let r else { store.show(L("sign.photoError")); return }
                autoThreshold = r.auto
                threshold = Double(r.threshold)
                processed = r.image
            }
        }
    }

    private func reprocess() {
        guard let photo else { return }
        let ink = keepColor ? nil : ink
        let t = Int(threshold)
        processing = true
        Task.detached(priority: .userInitiated) {
            let r = SignImage.photo(photo, ink: ink, threshold: t)
            await MainActor.run { processing = false; if let r { processed = r.image } }
        }
    }

    private func currentImage() -> CGImage? {
        switch tab {
        case .drawn:
            guard !drawing.strokes.isEmpty else { return nil }
            var img: UIImage?
            // PencilKit adapta la tinta al modo oscuro: se exporta siempre en claro.
            UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
                let b = drawing.bounds.insetBy(dx: -12, dy: -12)
                img = drawing.image(from: b, scale: 3)
            }
            return img?.cgImage
        case .typed:
            let t = typed.trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? nil : SignImage.typed(t, script: script, ink: ink)
        case .uploaded:
            return processed
        }
    }

    private func save() async {
        busy = true; error = nil
        defer { busy = false }
        guard let cg = currentImage(), let png = SignImage.trimmedPNG(cg, maxW: kind == .initials ? 600 : 1200, maxH: 600) else {
            error = L("sign.empty"); return
        }
        do {
            let source: SignatureDTO.Source = tab == .drawn ? .drawn : (tab == .typed ? .typed : .uploaded)
            let s = try await store.api.createSignature(png: png.png, kind: kind, source: source)
            SavedSignatures.shared.add(s)
            onSaved((s, UIImage(data: png.png)))
        } catch {
            self.error = L10n.errorText(error)
        }
    }
}

enum SignInitials {
    /// Iniciales: primeras letras de hasta 3 palabras.
    static func of(_ name: String) -> String {
        name.split(whereSeparator: \.isWhitespace).prefix(3).compactMap { $0.first.map { String($0).uppercased() } }.joined()
    }
}

/// Lienzo PencilKit con pluma (grosor según velocidad) y cualquier dedo.
struct SignaturePadView: UIViewRepresentable {
    @Binding var drawing: PKDrawing
    var ink: SignImage.Ink

    func makeUIView(context: Context) -> PKCanvasView {
        let v = PKCanvasView()
        v.drawingPolicy = .anyInput
        v.backgroundColor = .clear
        v.isOpaque = false
        v.overrideUserInterfaceStyle = .light
        v.isScrollEnabled = false
        v.tool = PKInkingTool(.pen, color: ink.color, width: 5)
        v.delegate = context.coordinator
        v.drawing = drawing
        return v
    }

    func updateUIView(_ v: PKCanvasView, context: Context) {
        v.tool = PKInkingTool(.pen, color: ink.color, width: 5)
        if v.drawing != drawing { v.drawing = drawing }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, PKCanvasViewDelegate {
        let parent: SignaturePadView
        init(_ p: SignaturePadView) { parent = p }
        func canvasViewDrawingDidChange(_ v: PKCanvasView) {
            if parent.drawing != v.drawing { parent.drawing = v.drawing }
        }
    }
}

// MARK: - Texto libre

struct TextMarkSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var initial: String
    var onDone: (String) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                TextField(L("sign.textPh"), text: $text)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { if !trimmed.isEmpty { onDone(trimmed) } }
                    .accessibilityIdentifier("sign.text.field")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(quick, id: \.self) { q in
                            Button(q) { text = q }
                                .font(.subheadline)
                                .padding(.horizontal, 12).frame(minHeight: 36)
                                .background(Capsule().fill(Theme.bubbleOther))
                                .buttonStyle(.plain)
                        }
                    }
                }
                Spacer()
            }
            .padding(16)
            .navigationTitle(L("sign.textTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("common.done")) { onDone(trimmed) }.disabled(trimmed.isEmpty).accessibilityIdentifier("sign.text.done")
                }
            }
        }
        .onAppear { text = initial; focused = true }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var quick: [String] {
        [store.me?.name, store.me?.title, SignText.today()].compactMap { $0 }.filter { !$0.isEmpty }
    }
}

// MARK: - Confirmar y enviar

struct ConfirmSignSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let att: AttachmentDTO
    let info: SignInfoDTO?
    let board: SignBoard
    var onSigned: () -> Void
    @State private var body_ = ""
    @State private var stamp = true
    @State private var certificate = false
    @State private var accept = false
    @State private var needsAccept = false
    @State private var busy = false
    @State private var error: String?
    /// Un doble toque en «Firmar» no debe firmar sin leer: el botón se activa un instante después.
    @State private var armed = false
    /// Fijo por intento: un reintento no firma dos veces.
    @State private var clientMessageId = UUID().uuidString.lowercased()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(L("sign.summary", ["name": att.name, "n": board.signatureCount, "p": board.pagesUsed, "total": board.pages.count]))
                    TextField(L("sign.bodyPh"), text: $body_, axis: .vertical).lineLimit(1...4)
                        .accessibilityIdentifier("sign.confirm.body")
                }
                Section {
                    Toggle(isOn: $stamp) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L("sign.stamp"))
                            Text(L("sign.stampHelp")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    Toggle(isOn: $certificate) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L("sign.certificate"))
                            Text(L("sign.certificateHelp")).font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    if needsAccept {
                        Toggle(isOn: $accept) { Text(L("sign.acceptBreak")).foregroundStyle(SignColors.warn) }
                            .listRowBackground(SignColors.warnBg)
                            .accessibilityIdentifier("sign.confirm.accept")
                    }
                }
                Section {
                    Text(L("sign.legal")).font(.footnote).foregroundStyle(Theme.textSecondary)
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button { Task { await go() } } label: {
                    Text(busy ? L("sign.signing") : "✍️ " + L("sign.signSend")).font(.headline).frame(maxWidth: .infinity, minHeight: 44)
                }
                .primaryProminent()
                .disabled(!armed || busy || (needsAccept && !accept))
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(.bar)
                .accessibilityIdentifier("sign.confirm.go")
            }
            .navigationTitle(L("sign.confirmTitle"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.back")) { dismiss() } } }
        }
        .interactiveDismissDisabled(busy)
        .onAppear { needsAccept = info?.hasDigitalSignature == true }
        .task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            armed = true
        }
    }

    private func go() async {
        busy = true; error = nil
        defer { busy = false }
        let payload: [String: Any] = [
            "clientMessageId": clientMessageId, "body": body_.trimmingCharacters(in: .whitespacesAndNewlines),
            "placements": board.placements(), "stamp": stamp, "certificate": certificate,
            "acceptBreakingSignatures": accept, "timeZone": TimeZone.current.identifier,
        ]
        do {
            let r = try await store.api.signPdf(att.id, body: payload)
            if let m = r.message { store.upsertLocal(m) }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onSigned()
        } catch let e as ApiRequestError where e.code == "has_digital_signature" {
            needsAccept = true
            error = L("sign.hasDigital")
        } catch {
            self.error = L10n.errorText(error)
        }
    }
}
