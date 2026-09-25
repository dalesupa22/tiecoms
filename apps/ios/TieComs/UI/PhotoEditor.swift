import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Recorte circular (mover / zoom) como función pura: qué parte de la imagen queda dentro del círculo.
enum CropMath {
    static let minZoom: CGFloat = 1
    static let maxZoom: CGFloat = 4

    /// Escala base (aspect fill) para que el lado menor cubra el círculo de lado `side`.
    static func baseScale(image: CGSize, side: CGFloat) -> CGFloat { side / max(1, min(image.width, image.height)) }

    /// Desplazamiento máximo (en puntos) para que la imagen siga cubriendo el círculo.
    static func clamp(offset: CGSize, image: CGSize, side: CGFloat, zoom: CGFloat) -> CGSize {
        let s = baseScale(image: image, side: side) * zoom
        let mx = max(0, (image.width * s - side) / 2), my = max(0, (image.height * s - side) / 2)
        return CGSize(width: min(mx, max(-mx, offset.width)), height: min(my, max(-my, offset.height)))
    }

    /// Rectángulo recortado en coordenadas de la imagen (puntos de UIImage).
    static func cropRect(image: CGSize, side: CGFloat, zoom: CGFloat, offset: CGSize) -> CGRect {
        let s = baseScale(image: image, side: side) * zoom
        let o = clamp(offset: offset, image: image, side: side, zoom: zoom)
        let w = side / s
        return CGRect(x: (image.width - w) / 2 - o.width / s, y: (image.height - w) / 2 - o.height / s, width: w, height: w)
    }

    /// JPEG cuadrado ≤ 512 px del recorte; baja la calidad hasta quedar bajo `maxBytes`.
    static func render(_ image: UIImage, crop: CGRect, size: CGFloat = 512, maxBytes: Int = AppStore.maxAvatarBytes) -> Data? {
        let target = min(size, (crop.width * image.scale).rounded(.down))
        guard target > 0 else { return nil }
        let k = target / crop.width
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let out = UIGraphicsImageRenderer(size: CGSize(width: target, height: target), format: format).image { _ in
            image.draw(in: CGRect(x: -crop.minX * k, y: -crop.minY * k, width: image.size.width * k, height: image.size.height * k))
        }
        var q: CGFloat = 0.85
        var data = out.jpegData(compressionQuality: q)
        while let d = data, d.count > maxBytes, q > 0.3 { q -= 0.15; data = out.jpegData(compressionQuality: q) }
        return data
    }
}

/// Origen de la foto: galería, cámara o archivos → editor de recorte → Guardar.
struct PhotoChangeFlow: ViewModifier {
    @Binding var isPresented: Bool
    var title: String
    /// Sube el JPEG; lanza error si falla.
    var onSave: (Data) async throws -> Void
    var onSaved: () -> Void

    @State private var source: Source?
    @State private var libraryItem: PhotosPickerItem?
    @State private var picked: ImageBox?
    @State private var error: String?

    enum Source: Identifiable { case library, camera, files; var id: Int { hashValue } }

    func body(content: Content) -> some View {
        content
            .confirmationDialog(title, isPresented: $isPresented, titleVisibility: .visible) {
                Button(L("photo.fromGallery")) { source = .library }
                if UIImagePickerController.isSourceTypeAvailable(.camera) { Button(L("photo.fromCamera")) { source = .camera } }
                Button(L("photo.fromFiles")) { source = .files }
                #if DEBUG
                // Solo pruebas de interfaz (-TCDemoPhoto YES): una imagen generada, sin depender de la galería.
                if AppConfig.launchFlag("TCDemoPhoto") { Button("Demo") { picked = ImageBox(image: PhotoChangeFlow.demoImage()) } }
                #endif
                Button(L("common.cancel"), role: .cancel) {}
            }
            .photosPicker(isPresented: Binding(get: { source == .library }, set: { if !$0 && source == .library { source = nil } }),
                          selection: $libraryItem, matching: .images, photoLibrary: .shared())
            .onChange(of: libraryItem) { _, item in
                guard let item else { return }
                Task {
                    defer { libraryItem = nil }
                    if let raw = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: raw) { picked = ImageBox(image: img) } else { error = L("photo.invalid") }
                }
            }
            .fullScreenCover(isPresented: Binding(get: { source == .camera }, set: { if !$0 { source = nil } })) {
                CameraPicker { img in source = nil; if let img { picked = ImageBox(image: img) } }.ignoresSafeArea()
            }
            .fileImporter(isPresented: Binding(get: { source == .files }, set: { if !$0 && source == .files { source = nil } }),
                          allowedContentTypes: [.image]) { result in
                source = nil
                guard case .success(let url) = result else { return }
                let ok = url.startAccessingSecurityScopedResource()
                defer { if ok { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url), let img = UIImage(data: data) { picked = ImageBox(image: img) } else { error = L("photo.invalid") }
            }
            // El id del recuadro es estable: si cambiara en cada render, la hoja se cerraría y abriría sin parar.
            .sheet(item: $picked) { box in
                AvatarCropView(image: box.image, title: title, onSave: onSave) { picked = nil; onSaved() }
            }
            .alert(error ?? "", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button(L("common.ok")) {} }
    }
}

#if DEBUG
extension PhotoChangeFlow {
    static func demoImage() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 900)).image { ctx in
            let colors = [UIColor(red: 0.15, green: 0.39, blue: 0.92, alpha: 1).cgColor, UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1).cgColor]
            let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            ctx.cgContext.drawLinearGradient(g, start: .zero, end: CGPoint(x: 1200, y: 900), options: [])
            UIColor.white.withAlphaComponent(0.9).setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 450, y: 220, width: 300, height: 300))
            ctx.cgContext.fillEllipse(in: CGRect(x: 330, y: 560, width: 540, height: 420))
        }
    }
}
#endif

struct ImageBox: Identifiable { let image: UIImage; let id = UUID() }

extension View {
    func photoChangeFlow(isPresented: Binding<Bool>, title: String, onSave: @escaping (Data) async throws -> Void, onSaved: @escaping () -> Void) -> some View {
        modifier(PhotoChangeFlow(isPresented: isPresented, title: title, onSave: onSave, onSaved: onSaved))
    }
}

/// Editor: la foto dentro de un círculo, se mueve con el dedo y se amplía con pellizco; Cancelar / Guardar.
struct AvatarCropView: View {
    @Environment(\.dismiss) private var dismiss
    let image: UIImage
    var title: String
    var onSave: (Data) async throws -> Void
    var onDone: () -> Void

    @State private var zoom: CGFloat = 1
    @State private var lastZoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let side = min(geo.size.width - 48, 340)
                let s = CropMath.baseScale(image: image.size, side: side) * zoom
                VStack(spacing: 20) {
                    Spacer(minLength: 0)
                    ZStack {
                        Image(uiImage: image)
                            .resizable()
                            .frame(width: image.size.width * s, height: image.size.height * s)
                            .offset(CropMath.clamp(offset: offset, image: image.size, side: side, zoom: zoom))
                        // Fuera del círculo, velo oscuro.
                        CircleHole(side: side).fill(.black.opacity(0.55), style: FillStyle(eoFill: true))
                            .allowsHitTesting(false)
                        Circle().stroke(.white.opacity(0.9), lineWidth: 2).frame(width: side, height: side).allowsHitTesting(false)
                    }
                    .frame(width: geo.size.width, height: side + 40)
                    .clipped()
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture()
                            .onChanged { v in offset = CGSize(width: lastOffset.width + v.translation.width, height: lastOffset.height + v.translation.height) }
                            .onEnded { _ in
                                offset = CropMath.clamp(offset: offset, image: image.size, side: side, zoom: zoom); lastOffset = offset
                            }
                            .simultaneously(with: MagnificationGesture()
                                .onChanged { z in zoom = min(CropMath.maxZoom, max(CropMath.minZoom, lastZoom * z)) }
                                .onEnded { _ in
                                    lastZoom = zoom
                                    offset = CropMath.clamp(offset: offset, image: image.size, side: side, zoom: zoom); lastOffset = offset
                                })
                    )
                    .accessibilityElement()
                    .accessibilityLabel(L("photo.cropA11y"))
                    .accessibilityAdjustableAction { dir in
                        zoom = min(CropMath.maxZoom, max(CropMath.minZoom, zoom + (dir == .increment ? 0.25 : -0.25))); lastZoom = zoom
                    }
                    .accessibilityIdentifier("photo.crop")
                    HStack {
                        Image(systemName: "minus.magnifyingglass")
                        Slider(value: Binding(get: { zoom }, set: { zoom = $0; lastZoom = $0 }), in: CropMath.minZoom...CropMath.maxZoom)
                            .accessibilityLabel(L("photo.zoom"))
                            .tint(Theme.orange)
                        Image(systemName: "plus.magnifyingglass")
                    }
                    .foregroundStyle(.white.opacity(0.8))
                    .padding(.horizontal, 32)
                    Text(L("photo.cropHint")).font(.footnote).foregroundStyle(.white.opacity(0.75))
                    if saving {
                        VStack(spacing: 6) {
                            ProgressView().progressViewStyle(.linear).tint(Theme.orange).frame(maxWidth: 240)
                            Text(L("photo.saving")).font(.footnote).foregroundStyle(.white)
                        }
                        .accessibilityIdentifier("photo.progress")
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Color(hex: 0xFFB4AB)).multilineTextAlignment(.center).padding(.horizontal) }
                    Spacer(minLength: 0)
                }
                .onChange(of: saving) { _, _ in }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L("photo.cancel")) { dismiss() }.disabled(saving).accessibilityIdentifier("photo.cancel") }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(L("photo.save")) { save(side: side) }.bold().disabled(saving).accessibilityIdentifier("photo.save")
                    }
                }
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .interactiveDismissDisabled(saving)
    }

    private func save(side: CGFloat) {
        let rect = CropMath.cropRect(image: image.size, side: side, zoom: zoom, offset: offset)
        guard let jpeg = CropMath.render(image, crop: rect) else { error = L("photo.invalid"); return }
        guard jpeg.count <= AppStore.maxAvatarBytes else { error = L("profile.tooBig"); return }
        saving = true; error = nil
        Task {
            do {
                try await onSave(jpeg)
                dismiss()
                onDone()
            } catch { self.error = (error as? ApiRequestError)?.isNetwork == true ? L("photo.failed") : L10n.errorText(error) }
            saving = false
        }
    }
}

/// Velo con un agujero circular centrado.
private struct CircleHole: Shape {
    var side: CGFloat
    func path(in rect: CGRect) -> Path {
        var p = Path(rect)
        p.addEllipse(in: CGRect(x: rect.midX - side / 2, y: rect.midY - side / 2, width: side, height: side))
        return p
    }
}

/// Cámara (UIImagePickerController).
struct CameraPicker: UIViewControllerRepresentable {
    var onPick: (UIImage?) -> Void
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.cameraDevice = .front
        p.delegate = context.coordinator
        return p
    }
    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPick: (UIImage?) -> Void
        init(onPick: @escaping (UIImage?) -> Void) { self.onPick = onPick }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onPick(info[.originalImage] as? UIImage)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onPick(nil) }
    }
}
