import PhotosUI
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// Perfil propio (nombre, cargo, área y foto) y Archivos (árbol de carpetas «Mis archivos» y por espacio).
// Mismas reglas que apps/web/src/screens/Profile.tsx y Files.tsx.

// MARK: - Foto de perfil

enum AvatarCrop {
    /// Recorta al centro en cuadrado y reduce a `size` px (sin agrandar): la foto sube liviana (≈50–150 KB).
    static func squareJPEG(_ image: UIImage, size: CGFloat = 512, quality: CGFloat = 0.85) -> Data? {
        let w = image.size.width, h = image.size.height
        guard w > 0, h > 0 else { return nil }
        let side = min(w, h)
        let target = min(size, (side * image.scale).rounded(.down))
        let k = target / side
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let out = UIGraphicsImageRenderer(size: CGSize(width: target, height: target), format: format).image { _ in
            // draw(in:) respeta la orientación EXIF de la foto.
            image.draw(in: CGRect(x: -(w - side) / 2 * k, y: -(h - side) / 2 * k, width: w * k, height: h * k))
        }
        var q = quality
        var data = out.jpegData(compressionQuality: q)
        while let d = data, d.count > AppStore.maxAvatarBytes, q > 0.3 {
            q -= 0.15
            data = out.jpegData(compressionQuality: q)
        }
        return data
    }
}

struct EditProfileView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var title = ""
    @State private var area = ""
    @State private var loaded = false
    @State private var photoItem: PhotosPickerItem?
    @State private var preview: UIImage?
    @State private var busy: Busy?
    @State private var error: String?
    @State private var confirmRemove = false

    enum Busy { case save, photo }

    var body: some View {
        Form {
            if let d = store.data {
                let me = Naming.person(d, d.me.id)
                let org = Naming.org(d, d.me.primaryOrgId)
                let photo = me?.avatarUrl ?? d.me.avatarUrl
                Section {
                    HStack(spacing: 16) {
                        Group {
                            if let preview {
                                Image(uiImage: preview).resizable().scaledToFill().frame(width: 88, height: 88).clipShape(Circle())
                            } else {
                                Avatar(name: d.me.name, org: org, size: 88, photo: photo)
                            }
                        }
                        .overlay { if busy == .photo { ProgressView().frame(width: 88, height: 88).background(Circle().fill(.black.opacity(0.25))) } }
                        VStack(alignment: .leading, spacing: 8) {
                            PhotosPicker(selection: $photoItem, matching: .images, photoLibrary: .shared()) {
                                Label(photo != nil || preview != nil ? L("profile.changePhoto") : L("profile.addPhoto"), systemImage: "camera")
                            }
                            .disabled(busy != nil)
                            .accessibilityIdentifier("profile.pickPhoto")
                            if photo != nil {
                                Button(L("profile.removePhoto"), role: .destructive) { confirmRemove = true }
                                    .disabled(busy != nil)
                                    .accessibilityIdentifier("profile.removePhoto")
                            }
                            Text(L("profile.photoHintIOS")).font(.caption).foregroundStyle(Theme.textSecondary)
                        }
                        .buttonStyle(.borderless)
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    LabeledField(label: L("auth.name")) {
                        TextField(L("auth.name"), text: $name).textContentType(.name).accessibilityIdentifier("profile.name")
                    }
                    LabeledField(label: L("profile.jobTitle")) {
                        TextField(L("profile.jobTitlePh"), text: $title).textContentType(.jobTitle).accessibilityIdentifier("profile.jobTitle")
                    }
                    LabeledField(label: L("profile.area")) {
                        TextField(L("profile.areaPh"), text: $area).accessibilityIdentifier("profile.area")
                    }
                } footer: {
                    Text([d.me.email, org?.name].compactMap { $0 }.joined(separator: " · "))
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("profile.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if busy == .save { ProgressView() } else {
                    Button(L("profile.save"), action: save)
                        .disabled(busy != nil || !changed || name.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
                        .accessibilityIdentifier("profile.save")
                }
            }
        }
        .onAppear {
            guard !loaded, let me = store.data?.me else { return }
            loaded = true
            name = me.name; title = me.title ?? ""; area = me.area ?? ""
        }
        .onChange(of: photoItem) { _, item in if let item { Task { await pick(item) } } }
        .confirmationDialog(L("profile.removePhoto"), isPresented: $confirmRemove, titleVisibility: .visible) {
            Button(L("profile.removePhoto"), role: .destructive) { removePhoto() }
            Button(L("common.cancel"), role: .cancel) {}
        }
    }

    private var changed: Bool {
        guard let me = store.data?.me else { return false }
        func n(_ s: String) -> String? { let t = s.trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? nil : t }
        return name.trimmingCharacters(in: .whitespacesAndNewlines) != me.name || n(title) != (me.title ?? nil) || n(area) != (me.area ?? nil)
    }

    private func save() {
        busy = .save; error = nil
        Task {
            do {
                try await store.updateProfile(name: name, title: title, area: area)
                store.show(L("profile.saved"))
                dismiss()
            } catch { self.error = L10n.errorText(error) }
            busy = nil
        }
    }

    private func pick(_ item: PhotosPickerItem) async {
        busy = .photo; error = nil
        defer { busy = nil; photoItem = nil }
        guard let raw = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: raw),
              let jpeg = AvatarCrop.squareJPEG(img), let small = UIImage(data: jpeg) else {
            error = L("profile.notImage"); return
        }
        preview = small
        do {
            try await store.uploadAvatar(jpeg: jpeg)
            store.show(L("profile.photoSaved"))
        } catch {
            preview = nil
            self.error = L10n.errorText(error)
        }
    }

    private func removePhoto() {
        busy = .photo; error = nil
        Task {
            do { try await store.removeAvatar(); preview = nil } catch { self.error = L10n.errorText(error) }
            busy = nil
        }
    }
}

/// Campo con su etiqueta encima (formularios de perfil).
private struct LabeledField<Content: View>: View {
    var label: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(Theme.textSecondary)
            content()
        }
    }
}

// MARK: - Archivos

enum DriveFormat {
    /// Igual que size() de la web.
    static func size(_ n: Int) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return "\(Int((Double(n) / 1024).rounded())) KB" }
        let mb = Double(n) / 1024 / 1024
        return n < 10 * 1024 * 1024 ? String(format: "%.1f MB", mb) : "\(Int(mb.rounded())) MB"
    }

    static func icon(_ type: String, _ name: String) -> String {
        let n = name.lowercased()
        if type.hasPrefix("image/") { return "photo" }
        if type.hasPrefix("video/") { return "film" }
        if type.hasPrefix("audio/") { return "music.note" }
        if type == "application/pdf" || n.hasSuffix(".pdf") { return "doc.richtext" }
        if type.range(of: "sheet|excel|csv", options: .regularExpression) != nil || n.range(of: #"\.(xlsx?|csv)$"#, options: .regularExpression) != nil { return "tablecells" }
        if type.range(of: "presentation|powerpoint", options: .regularExpression) != nil || n.range(of: #"\.pptx?$"#, options: .regularExpression) != nil { return "rectangle.on.rectangle" }
        if type.range(of: "zip|compressed|tar|rar", options: .regularExpression) != nil { return "doc.zipper" }
        if type.range(of: "word|document|rtf|text/", options: .regularExpression) != nil || n.range(of: #"\.(docx?|txt|md)$"#, options: .regularExpression) != nil { return "doc.text" }
        return "paperclip"
    }

    static func mimeType(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}

/// Raíz: «Mis archivos» y las carpetas compartidas de cada espacio.
struct FilesRootView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        List {
            Section {
                Text(L("files.intro")).font(.footnote).foregroundStyle(Theme.textSecondary)
                NavigationLink(value: Route.drive(workspaceId: nil, folderId: nil)) {
                    Label(L("files.mine"), systemImage: "person.crop.square")
                }
                .accessibilityIdentifier("files.mine")
            }
            if let d = store.data, !d.workspaces.isEmpty {
                Section(L("nav.spaces")) {
                    ForEach(d.workspaces.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) { ws in
                        NavigationLink(value: Route.drive(workspaceId: ws.id, folderId: nil)) {
                            HStack(spacing: 10) {
                                HStack(spacing: -6) { ForEach(ws.organizationIds.prefix(3).compactMap { Naming.org(d, $0) }) { OrgMark(org: $0, size: 22) } }
                                Text(ws.name)
                            }
                        }
                        .accessibilityIdentifier("files.ws.\(ws.id)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(L("files.title"))
    }
}

/// Una carpeta (o la raíz) de un ámbito: subcarpetas, archivos, subir y crear carpeta.
struct DriveFolderView: View {
    @Environment(AppStore.self) private var store
    let workspaceId: String?
    let folderId: String?
    @State private var tree: DriveTreeDTO?
    @State private var error: String?
    @State private var query = ""
    @State private var askFolder = false
    @State private var folderName = ""
    @State private var importing = false
    @State private var uploading: (done: Int, total: Int)?
    @State private var downloading: String?
    @State private var previewURL: URL?

    var body: some View {
        let folders = searchResults.folders
        let files = searchResults.files
        List {
            if let error, tree == nil {
                Section { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            if let u = uploading {
                Section { HStack { ProgressView(); Text(L("files.uploading", ["done": u.done, "total": u.total])).font(.footnote) } }
            }
            if !folders.isEmpty {
                Section {
                    ForEach(folders) { f in
                        NavigationLink(value: Route.drive(workspaceId: workspaceId, folderId: f.id)) {
                            HStack(spacing: 12) {
                                Image(systemName: "folder.fill").font(.title3).foregroundStyle(Theme.accentText).frame(width: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(f.name).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                    Text(itemsLabel(f.id)).font(.caption).foregroundStyle(Theme.textSecondary)
                                }
                            }
                        }
                        .accessibilityIdentifier("drive.folder.\(f.id)")
                    }
                }
            }
            if !files.isEmpty {
                Section {
                    ForEach(files) { f in
                        Button { open(f) } label: { fileRow(f) }
                            .disabled(downloading != nil)
                            .contextMenu {
                                Button { open(f) } label: { Label(L("files.open"), systemImage: "eye") }
                            }
                            .accessibilityIdentifier("drive.file.\(f.id)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .overlay {
            if tree == nil && error == nil { ProgressView() }
            else if tree != nil && folders.isEmpty && files.isEmpty && uploading == nil {
                if query.isEmpty {
                    ContentUnavailableView(L("files.empty"), systemImage: "folder", description: Text(L("files.emptyHintIOS")))
                } else {
                    ContentUnavailableView(L("files.noResults"), systemImage: "magnifyingglass")
                }
            }
        }
        .searchable(text: $query, prompt: L("files.search"))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { importing = true } label: { Label(L("files.upload"), systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("drive.upload")
                    Button { folderName = ""; askFolder = true } label: { Label(L("files.newFolder"), systemImage: "folder.badge.plus") }
                        .accessibilityIdentifier("drive.newFolder")
                } label: { Image(systemName: "plus") }
                .disabled(tree == nil || uploading != nil)
                .accessibilityLabel(L("files.upload"))
                .accessibilityIdentifier("drive.add")
            }
        }
        .alert(L("files.newFolder"), isPresented: $askFolder) {
            TextField(L("files.folderName"), text: $folderName)
            Button(L("common.cancel"), role: .cancel) {}
            Button(L("common.ok")) { createFolder() }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await upload(urls) } }
        }
        .quickLookPreview($previewURL)
        .refreshable { await load() }
        .task(id: store.driveRevision) { await load() }
    }

    private var scopeName: String {
        guard let workspaceId else { return L("files.mine") }
        return store.data?.workspaces.first { $0.id == workspaceId }?.name ?? L("files.title")
    }

    private var title: String {
        guard let folderId else { return scopeName }
        return tree?.folders.first { $0.id == folderId }?.name ?? scopeName
    }

    /// Con búsqueda, en todo el ámbito; sin ella, solo lo que cuelga de esta carpeta.
    private var searchResults: (folders: [DriveFolderDTO], files: [DriveFileDTO]) {
        guard let tree else { return ([], []) }
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return (tree.folders(in: folderId), tree.files(in: folderId)) }
        return (tree.folders.filter { $0.name.localizedCaseInsensitiveContains(q) }, tree.files.filter { $0.name.localizedCaseInsensitiveContains(q) })
    }

    private func itemsLabel(_ id: String) -> String {
        let n = (tree?.folders(in: id).count ?? 0) + (tree?.files(in: id).count ?? 0)
        return n == 0 ? L("files.item0") : n == 1 ? L("files.item1") : L("files.items", ["n": n])
    }

    @ViewBuilder private func fileRow(_ f: DriveFileDTO) -> some View {
        HStack(spacing: 12) {
            Image(systemName: DriveFormat.icon(f.contentType, f.name)).font(.title3).foregroundStyle(Theme.textSecondary).frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(f.name).foregroundStyle(Theme.textPrimary).lineLimit(2)
                let who = store.data.flatMap { Naming.person($0, f.createdBy)?.name }
                Text([DriveFormat.size(f.size), L10n.shortDate(f.createdAt), who].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.textSecondary)
            }
            Spacer(minLength: 0)
            if downloading == f.id { ProgressView() }
        }
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        do { tree = try await store.driveTree(workspaceId: workspaceId); error = nil } catch {
            self.error = L10n.errorText(error)
            if tree != nil { store.show(self.error ?? "") }
        }
    }

    private func createFolder() {
        let name = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            do {
                let f = try await store.createDriveFolder(workspaceId: workspaceId, parentId: folderId, name: name)
                await load()
                store.push(.drive(workspaceId: workspaceId, folderId: f.id))
            } catch { store.show(L10n.errorText(error)) }
        }
    }

    private func upload(_ urls: [URL]) async {
        var items: [(name: String, type: String, data: Data)] = []
        var tooBig = false
        for u in urls {
            let scoped = u.startAccessingSecurityScopedResource()
            defer { if scoped { u.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: u), !data.isEmpty else { continue }
            if data.count > AppStore.maxDriveFileBytes { tooBig = true; continue }
            items.append((u.lastPathComponent, DriveFormat.mimeType(for: u), data))
        }
        if tooBig { store.show(L("files.tooBig")) }
        guard !items.isEmpty else { return }
        uploading = (0, items.count)
        var failed = 0
        for (i, it) in items.enumerated() {
            do {
                try await store.uploadDriveFile(workspaceId: workspaceId, folderId: folderId, name: it.name, contentType: it.type, data: it.data)
            } catch {
                failed += 1
                store.show("\(it.name): \(L10n.errorText(error))")
            }
            uploading = (i + 1, items.count)
        }
        uploading = nil
        if failed < items.count { store.show(L("files.uploaded", ["n": items.count - failed])) }
        await load()
    }

    /// Descarga con el enlace firmado y abre la vista rápida del sistema (con Compartir).
    private func open(_ f: DriveFileDTO) {
        downloading = f.id
        Task {
            defer { downloading = nil }
            do {
                let link = try await store.driveFileLink(f.id)
                let (tmp, resp) = try await URLSession.shared.download(from: link)
                if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    throw ApiRequestError(status: http.statusCode, code: "http_\(http.statusCode)", message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
                }
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent("drive/\(f.id)", isDirectory: true)
                try? FileManager.default.removeItem(at: dir)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let safe = f.name.replacingOccurrences(of: "/", with: "-")
                let dest = dir.appendingPathComponent(safe.isEmpty ? "archivo" : safe)
                try FileManager.default.moveItem(at: tmp, to: dest)
                previewURL = dest
            } catch let e as ApiRequestError {
                store.show(L10n.errorText(e))
            } catch {
                store.show(L10n.errorText(ApiRequestError.network(error)))
            }
        }
    }
}
