import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Estilos de texto con menciones (UIKit): cada mención con el color de SU persona; los enlaces http con el acento.
enum RichText {
    static func baseFont() -> UIFont { UIFont.preferredFont(forTextStyle: .body) }
    static func boldFont() -> UIFont {
        let d = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body).withSymbolicTraits(.traitBold) ?? UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body)
        return UIFont(descriptor: d, size: 0)
    }

    static func mentionColor(_ m: Mention, mine: Bool) -> UIColor {
        if mine { return .white }
        if m.isRef { return UIColor(Theme.accentText) }
        return UIColor(m.isAll ? Theme.accentText : PersonColor.text(m.userId))
    }

    /// Texto de la burbuja: http subrayado con el color de enlace; menciones en negrita y color de su persona (link chaggu-mention://).
    static func bubble(_ text: String, mentions: [Mention], mine: Bool, linkify: Bool, highlight: String? = nil) -> NSAttributedString {
        let out = NSMutableAttributedString(string: text, attributes: [.font: baseFont(), .foregroundColor: mine ? UIColor.white : UIColor(Theme.textPrimary)])
        if linkify {
            for (r, url) in Linkify.links(in: text) {
                let nr = NSRange(r, in: text)
                out.addAttributes([.link: url, .foregroundColor: mine ? UIColor.white : UIColor(Theme.accentText), .underlineStyle: NSUnderlineStyle.single.rawValue], range: nr)
            }
        }
        for m in MentionText.valid(mentions, in: text) {
            let nr = NSRange(location: m.start, length: m.length)
            out.addAttributes([.font: boldFont(), .foregroundColor: mentionColor(m, mine: mine)], range: nr)
            out.removeAttribute(.underlineStyle, range: nr)
            if let conv = m.refConversationId {
                // #grupo: pastilla del acento que abre el chat (o avisa «No tienes acceso»).
                out.addAttribute(.backgroundColor, value: mine ? UIColor.white.withAlphaComponent(0.22) : UIColor(Theme.accentText).withAlphaComponent(0.12), range: nr)
                if let u = URL(string: "chaggu-ref://\(conv)") { out.addAttribute(.link, value: u, range: nr) }
                continue
            }
            if !m.isAll, let u = URL(string: "chaggu-mention://\(m.userId)") { out.addAttribute(.link, value: u, range: nr) } else { out.removeAttribute(.link, range: nr) }
        }
        // Búsqueda en el chat (tanda 1.7 §6): lo que coincide, resaltado (sin mayúsculas ni tildes).
        if let highlight, highlight.count >= 2 {
            for r in ChatSearch.ranges(of: highlight, in: text) {
                out.addAttribute(.backgroundColor, value: UIColor.systemYellow.withAlphaComponent(mine ? 0.55 : 0.45), range: r)
                if !mine { out.addAttribute(.foregroundColor, value: UIColor.label, range: r) }
            }
        }
        return out
    }

    /// Compositor: tokens resaltados con el color de la persona y un fondo suave.
    static func applyComposerStyle(_ storage: NSTextStorage, mentions: [Mention]) {
        let full = NSRange(location: 0, length: storage.length)
        storage.beginEditing()
        storage.setAttributes([.font: baseFont(), .foregroundColor: UIColor(Theme.textPrimary)], range: full)
        for m in MentionText.valid(mentions, in: storage.string) {
            let c = mentionColor(m, mine: false)
            storage.addAttributes([.font: boldFont(), .foregroundColor: c, .backgroundColor: c.withAlphaComponent(0.13)], range: NSRange(location: m.start, length: m.length))
        }
        storage.endEditing()
    }
}

/// Texto de burbuja con menciones (UITextView de solo lectura): cada mención con su color y tocable.
struct RichMessageText: UIViewRepresentable {
    let text: String
    let mentions: [Mention]
    let mine: Bool
    let linkify: Bool
    var highlight: String? = nil
    /// 0 = sin tope (mensaje muy largo plegado: 30).
    var maxLines = 0
    var onMention: (String) -> Void
    @Environment(\.openURL) private var openURL

    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isEditable = false
        v.isSelectable = true
        v.isScrollEnabled = false
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.linkTextAttributes = [:]   // los colores van por tramo
        v.adjustsFontForContentSizeCategory = true
        v.delegate = context.coordinator
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return v
    }

    func updateUIView(_ v: UITextView, context: Context) {
        context.coordinator.parent = self
        let key = RichText.Key(text: text, mentions: mentions, mine: mine, linkify: linkify, highlight: highlight)
        if context.coordinator.key != key {
            context.coordinator.key = key
            v.attributedText = RichText.cachedBubble(key)
        }
        if v.textContainer.maximumNumberOfLines != maxLines {
            v.textContainer.maximumNumberOfLines = maxLines
            v.textContainer.lineBreakMode = maxLines > 0 ? .byTruncatingTail : .byWordWrapping
            v.invalidateIntrinsicContentSize()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let maxW = proposal.width ?? 280
        // Ancho real del texto (como Text): la burbuja se ciñe a él.
        let rect = uiView.attributedText.boundingRect(with: CGSize(width: maxW, height: .greatestFiniteMagnitude),
                                                      options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        let w = min(maxW, ceil(rect.width) + 1)
        let h = uiView.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)).height
        return CGSize(width: w, height: ceil(h))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: RichMessageText
        var key: RichText.Key?
        init(_ p: RichMessageText) { parent = p }
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { [parent] _ in
                if url.scheme == "chaggu-mention", let id = url.host { parent.onMention(id) } else { parent.openURL(url) }
            }
        }
        // Sin menú de edición/selección larga: el menú del mensaje lo da la burbuja.
        func textView(_ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? { nil }
    }
}

/// Compositor con UITextView: tokens de mención resaltados, cursor real (el buscador se abre con @ en cualquier posición),
/// un retroceso borra el token entero, altura automática hasta 5 líneas, placeholder, dictado, pegado y Dynamic Type.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var mentions: [Mention]
    /// Cursor (UTF-16).
    @Binding var cursor: Int
    @Binding var focused: Bool
    var placeholder: String
    var accessibilityLabel: String
    var onChange: (String) -> Void = { _ in }
    /// Pegar imágenes (menú Pegar o ⌘V, 1.7.1): se adjuntan como si se eligieran de Fotos. nil = solo texto.
    var onPasteAttachments: (([LocalAttachment]) -> Void)? = nil
    static let maxLines: CGFloat = 5

    func makeUIView(context: Context) -> UITextView {
        let v = PastingTextView()
        v.onPasteAttachments = onPasteAttachments
        v.font = RichText.baseFont()
        v.adjustsFontForContentSizeCategory = true
        v.backgroundColor = .clear
        v.isScrollEnabled = false
        v.textContainerInset = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        v.textContainer.lineFragmentPadding = 4
        v.allowsEditingTextAttributes = false   // pegar = texto plano
        // Sin predicción en línea (iOS 17+): en el iPhone la muestra como texto marcado, y al reemplazar el texto
        // desde fuera (elegir una mención) el teclado seguía con rangos del texto anterior.
        v.inlinePredictionType = .no
        v.typingAttributes = [.font: RichText.baseFont(), .foregroundColor: UIColor(Theme.textPrimary)]
        v.delegate = context.coordinator
        v.accessibilityIdentifier = "composer.field"
        v.accessibilityLabel = accessibilityLabel
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.setContentHuggingPriority(.defaultHigh, for: .vertical)
        return v
    }

    func updateUIView(_ v: UITextView, context: Context) {
        let c = context.coordinator
        c.parent = self
        (v as? PastingTextView)?.onPasteAttachments = onPasteAttachments
        if v.text != text {
            c.applying = true
            // Texto que llega de fuera (elegir una mención, enviar, editar): primero se cierra el texto marcado
            // (predicción, dictado) para que el teclado no siga con rangos del texto anterior.
            if v.markedTextRange != nil { v.unmarkText() }
            v.text = text
            RichText.applyComposerStyle(v.textStorage, mentions: mentions)
            let end = min(cursor, (text as NSString).length)
            v.selectedRange = NSRange(location: end, length: 0)
            c.applying = false
        } else if c.styledMentions != mentions, v.markedTextRange == nil {
            let sel = v.selectedRange
            RichText.applyComposerStyle(v.textStorage, mentions: mentions)
            v.selectedRange = sel
        }
        c.styledMentions = mentions
        v.typingAttributes = [.font: RichText.baseFont(), .foregroundColor: UIColor(Theme.textPrimary)]
        v.accessibilityValue = text.isEmpty ? placeholder : nil
        // Solo en el CAMBIO de `focused` (flanco): si el teclado se cerró por fuera (deslizar la lista, tocar fuera)
        // `focused` sigue en true un instante hasta que llega textViewDidEndEditing; reenfocar por nivel volvía a
        // abrir el teclado y no había forma de cerrarlo.
        if focused != c.lastFocused {
            c.lastFocused = focused
            if focused && !v.isFirstResponder { DispatchQueue.main.async { v.becomeFirstResponder() } }
            if !focused && v.isFirstResponder { DispatchQueue.main.async { v.resignFirstResponder() } }
        }
        let lineH = (v.font ?? RichText.baseFont()).lineHeight
        let maxH = lineH * Self.maxLines + v.textContainerInset.top + v.textContainerInset.bottom
        let wantsScroll = v.contentSize.height > maxH + 1
        if v.isScrollEnabled != wantsScroll { v.isScrollEnabled = wantsScroll }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let w = proposal.width ?? 240
        let lineH = (uiView.font ?? RichText.baseFont()).lineHeight
        let maxH = lineH * Self.maxLines + uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let fit = uiView.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)).height
        return CGSize(width: w, height: min(maxH, max(lineH + uiView.textContainerInset.top + uiView.textContainerInset.bottom, ceil(fit))))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        var applying = false
        var styledMentions: [Mention] = []
        /// Último valor de `focused` aplicado al UITextView (para reaccionar solo a cambios).
        var lastFocused = false
        init(_ p: ComposerTextView) { parent = p }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText t: String) -> Bool {
            // Retroceso (o borrar una selección) sobre un token: se borra el token entero.
            let old = textView.text ?? ""
            let length = (old as NSString).length
            guard t.isEmpty, textView.markedTextRange == nil,
                  let full = MentionText.expandDeletion(range, mentions: MentionText.clamped(parent.mentions, length: length), length: length),
                  full != range, full.location + full.length <= length else { return true }
            let new = (old as NSString).replacingCharacters(in: full, with: "")
            let r = MentionText.reconcile(old: old, new: new, mentions: parent.mentions)
            applying = true
            textView.text = r.text
            RichText.applyComposerStyle(textView.textStorage, mentions: r.mentions)
            textView.selectedRange = NSRange(location: full.location, length: 0)
            applying = false
            publish(textView, text: r.text, mentions: r.mentions)
            return false
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !applying else { return }
            let new = textView.text ?? ""
            // Dictado / teclados con texto marcado: el texto no se toca hasta que termine, pero las menciones se corren
            // (si no, quedan desfasadas y un retroceso posterior usaría rangos fuera del texto).
            if textView.markedTextRange != nil {
                publish(textView, text: new, mentions: MentionText.shift(old: parent.text, new: new, mentions: parent.mentions))
                return
            }
            let r = MentionText.reconcile(old: parent.text, new: new, mentions: parent.mentions)
            if r.text != new {
                let sel = textView.selectedRange
                applying = true
                textView.text = r.text
                textView.selectedRange = NSRange(location: min(sel.location, (r.text as NSString).length), length: 0)
                applying = false
            }
            let sel = textView.selectedRange
            RichText.applyComposerStyle(textView.textStorage, mentions: r.mentions)
            textView.selectedRange = sel
            publish(textView, text: r.text, mentions: r.mentions)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !applying else { return }
            let loc = textView.selectedRange.location
            if parent.cursor != loc { DispatchQueue.main.async { self.parent.cursor = loc } }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            lastFocused = true
            if !parent.focused { DispatchQueue.main.async { self.parent.focused = true } }
        }
        func textViewDidEndEditing(_ textView: UITextView) {
            lastFocused = false
            if parent.focused { DispatchQueue.main.async { self.parent.focused = false } }
        }

        private func publish(_ textView: UITextView, text: String, mentions: [Mention]) {
            styledMentions = mentions
            textView.typingAttributes = [.font: RichText.baseFont(), .foregroundColor: UIColor(Theme.textPrimary)]
            parent.mentions = mentions
            parent.cursor = textView.selectedRange.location
            parent.text = text
            parent.onChange(text)
            textView.invalidateIntrinsicContentSize()
        }
    }
}

/// UITextView del compositor que también pega imágenes del portapapeles (capturas, fotos copiadas desde Fotos o Safari):
/// «Pegar» aparece en el menú aunque no haya texto y ⌘V con teclado pasa por aquí. Si además hay texto (no solo un enlace
/// de la imagen), el texto también se pega.
final class PastingTextView: UITextView {
    var onPasteAttachments: (([LocalAttachment]) -> Void)?
    /// Portapapeles a usar (las pruebas pasan uno propio).
    var pasteboard: UIPasteboard = .general

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onPasteAttachments != nil, PasteImages.hasImages(pasteboard) { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        guard let cb = onPasteAttachments, PasteImages.hasImages(pasteboard) else { super.paste(sender); return }
        let raw = PasteImages.raw(pasteboard)
        if PasteImages.hasPlainText(pasteboard) { super.paste(sender) }
        // Decodificar y reducir una foto de 12 MP toma ~100 ms: fuera del hilo principal.
        Task.detached(priority: .userInitiated) {
            let list = PasteImages.prepare(raw)
            await MainActor.run { if !list.isEmpty { cb(list) } }
        }
    }
}

/// Imágenes del portapapeles → adjuntos listos (mismas reglas que al elegir de Fotos: ImagePrep).
enum PasteImages {
    enum Raw: @unchecked Sendable { case data(Data, UTType), image(UIImage) }

    static func hasImages(_ pb: UIPasteboard) -> Bool { pb.hasImages || pb.contains(pasteboardTypes: [UTType.image.identifier]) }

    /// Texto que vale la pena pegar además de la imagen (no el enlace de la imagen que agrega Safari).
    static func hasPlainText(_ pb: UIPasteboard) -> Bool {
        guard pb.hasStrings, let s = pb.string?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return false }
        if let u = URL(string: s), u.scheme?.hasPrefix("http") == true, !s.contains(" ") { return false }
        return true
    }

    /// Lee cada elemento del portapapeles en el hilo principal (UIPasteboard no es seguro fuera de él).
    static func raw(_ pb: UIPasteboard) -> [Raw] {
        var out: [Raw] = []
        let preferred: [UTType] = [.png, .jpeg, .heic, .heif, .gif, .webP, .tiff, .image]
        for item in pb.items {
            var found: Raw?
            for t in preferred {
                guard let key = item.keys.first(where: { UTType($0)?.conforms(to: t) == true }) else { continue }
                if let d = item[key] as? Data { found = .data(d, UTType(key) ?? t) }
                else if let img = item[key] as? UIImage { found = .image(img) }
                if found != nil { break }
            }
            if let found { out.append(found) }
        }
        if out.isEmpty, let imgs = pb.images { out = imgs.map { .image($0) } }
        return Array(out.prefix(AttachmentRules.maxPerMessage))
    }

    static func prepare(_ raw: [Raw]) -> [LocalAttachment] {
        raw.enumerated().compactMap { i, r in
            switch r {
            case .data(let d, let t):
                let ext = t.preferredFilenameExtension ?? "png"
                return ImagePrep.prepare(d, name: "pegada-\(i + 1).\(ext)", contentType: t.preferredMIMEType ?? "image/png")
            case .image(let img):
                return ImagePrep.jpeg(img).map { LocalAttachment(name: "pegada-\(i + 1).jpg", contentType: "image/jpeg", data: $0) }
            }
        }
    }
}
